// Load benchmark on a SEPARATE database filled with SYNTHETIC data (valid for latency/throughput only,
// never for visual accuracy): N products with 1-3 supplier offers each, one image per product and one
// random 768-d vector per image (same HNSW parameters as production).
//
//   pnpm bench:load -- [--products 60000] [--users 5] [--requests 200] [--photos 25]
//
// Uses BENCH_DATABASE_URL (default: DATABASE_URL with database "comparator_bench") and S3 bucket
// "comparator-bench". Runs the real Fastify app over HTTP and the real vision model for photo searches.
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { products: { type: 'string', default: '60000' }, users: { type: 'string', default: '5' }, requests: { type: 'string', default: '200' }, photos: { type: 'string', default: '25' }, out: { type: 'string', default: 'bench-results' } },
});
const N = Number(values.products);
const USERS = Number(values.users);
const benchUrl = process.env.BENCH_DATABASE_URL ?? process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/comparator_bench$1');
process.env.DATABASE_URL = benchUrl;
process.env.S3_BUCKET = process.env.BENCH_S3_BUCKET ?? 'comparator-bench';
process.env.VISION_WARMUP = 'false';
process.env.LOG_LEVEL = 'warn';

const { config } = await import('../config.ts');
const { pool, withTx } = await import('../db/pool.ts');
const { migrate } = await import('../db/migrate.ts');
const { ensureWorkerSchema } = await import('../jobs/setup.ts');
const { ensureModel, indexName, vectorExpr, modelPredicate } = await import('../vision/index-admin.ts');
const { getModelSpec } = await import('../vision/models.ts');
const { refreshProducts } = await import('../domain/canonical.ts');
const { hashPassword } = await import('../server/auth.ts');
const { buildApp } = await import('../server/app.ts');
const { storage } = await import('../storage/index.ts');
const { nearestImages } = await import('../search/photo.ts');
const { getEmbedder } = await import('../vision/embedder.ts');

const spec = getModelSpec(config.VISION_MODEL);
const t0 = Date.now();
await migrate(config.DATABASE_URL, () => {});
await ensureWorkerSchema(config.DATABASE_URL);
const key = await ensureModel(pool, spec, { activateIfNoneActive: true });
await storage().check(true);
const setup: Record<string, number> = {};

const existing = (await pool.query(`SELECT count(*)::int AS n FROM products`)).rows[0].n;
if (existing < N) {
  console.log(`generazione dati sintetici: ${N} prodotti…`);
  await pool.query(`TRUNCATE products, product_identifiers, supplier_offers, image_assets, image_sources, offer_images, image_embeddings, match_reviews, audit_events, photo_searches CASCADE`);
  await pool.query(
    `INSERT INTO suppliers (code, name, priority, default_vat_treatment) VALUES ('bench-a', 'Bench A', 10, 'net'), ('bench-b', 'Bench B', 20, 'net'), ('bench-c', 'Bench C', 30, 'net')
     ON CONFLICT (code) DO NOTHING`,
  );
  let t = Date.now();
  await pool.query(
    `WITH w AS (SELECT ARRAY['Gel','Crema','Olio','Vibratore','Anello','Kit','Scrub','Balsamo','Wave','Orbit','Petal','Silk','Classic','Ultra','Deluxe','Bullet','Wand','Candela','Spray','Lozione'] AS n,
                       ARRAY['Rosa','Nero','Blu','Viola','Oro','Verde','Rosso','Bianco'] AS c,
                       ARRAY['Velvora','Nuvia','Lumen Care','Aurum','Sensa','Moira','Kappa','Orbix','Silva','Tessa','Noma','Riva'] AS b)
     INSERT INTO products (id, title, brand, status)
     SELECT md5('bench-product-' || i)::uuid, w.n[1 + i % 20] || ' ' || w.n[1 + (i / 20) % 20] || ' ' || w.c[1 + i % 8] || ' ' || (50 + (i % 7) * 25) || ' ml',
            w.b[1 + i % 12], 'active'
       FROM generate_series(1, $1::int) i, w`,
    [N],
  );
  await pool.query(
    `INSERT INTO product_identifiers (product_id, kind, value, source)
     SELECT md5('bench-product-' || i)::uuid, 'gtin', lpad((8000000000000 + i)::text, 14, '0'), 'import' FROM generate_series(1, $1::int) i`,
    [N],
  );
  await pool.query(
    `INSERT INTO supplier_offers (supplier_id, supplier_sku, product_id, link_source, barcode_raw, barcode_status, gtin, title, brand, price, currency, vat_treatment,
                                  units_per_pack, stock_quantity, stock_status, row_hash, source_row, source_as_of, image_urls)
     SELECT s.id, s.code || '-' || i, md5('bench-product-' || i)::uuid, 'gtin', (8000000000000 + i)::text, 'valid', lpad((8000000000000 + i)::text, 14, '0'),
            p.title, p.brand, round((3 + random() * 40)::numeric, 2), 'EUR', 'net', CASE WHEN i % 9 = 0 THEN 5 ELSE 1 END,
            CASE WHEN i % 7 = 0 THEN 0 WHEN i % 11 = 0 THEN NULL ELSE (random() * 100)::int END,
            CASE WHEN i % 7 = 0 THEN 'out_of_stock' WHEN i % 11 = 0 THEN 'unknown' ELSE 'in_stock' END,
            md5(i::text || s.code), '{}'::jsonb, now() - (random() * interval '10 days'), '{}'
       FROM generate_series(1, $1::int) i
       JOIN products p ON p.id = md5('bench-product-' || i)::uuid
       JOIN suppliers s ON s.code = 'bench-a' OR (s.code = 'bench-b' AND i % 2 = 0) OR (s.code = 'bench-c' AND i % 3 = 0)`,
    [N],
  );
  setup.insertProductsOffersMs = Date.now() - t;
  t = Date.now();
  await pool.query(
    `INSERT INTO image_assets (id, sha256, width, height, format, bytes, thumb_key, display_key, infer_key)
     SELECT md5('bench-asset-' || i)::uuid, md5('bench-sha-' || i) || md5('x' || i), 800, 800, 'jpeg', 200000, 'bench/missing', 'bench/missing', 'bench/missing'
       FROM generate_series(1, $1::int) i`,
    [N],
  );
  await pool.query(
    `INSERT INTO image_sources (id, supplier_id, url, status, image_asset_id, fetched_at)
     SELECT md5('bench-src-' || i)::uuid, (SELECT id FROM suppliers WHERE code = 'bench-a'), 'https://bench.invalid/' || i || '.jpg', 'fetched', md5('bench-asset-' || i)::uuid, now()
       FROM generate_series(1, $1::int) i`,
    [N],
  );
  await pool.query(
    `INSERT INTO offer_images (offer_id, image_source_id, position)
     SELECT o.id, md5('bench-src-' || i)::uuid, 0 FROM generate_series(1, $1::int) i JOIN supplier_offers o ON o.supplier_sku = 'bench-a-' || i`,
    [N],
  );
  // Random unit vectors, inserted without the index, then HNSW built in bulk (timed).
  await pool.query(`DROP INDEX IF EXISTS ${indexName(key)}`);
  for (let start = 1; start <= N; start += 5000) {
    await pool.query(
      `INSERT INTO image_embeddings (image_asset_id, model_key, status, embedding)
       SELECT md5('bench-asset-' || i)::uuid, $3, 'done', l2_normalize(ARRAY(SELECT random() - 0.5 FROM generate_series(1, $4::int) WHERE i > 0)::vector)
         FROM generate_series($1::int, $2::int) i`,
      [start, Math.min(N, start + 4999), key, spec.dim],
    );
  }
  setup.insertImagesVectorsMs = Date.now() - t;
  t = Date.now();
  const c = await pool.connect();
  await c.query(`SET maintenance_work_mem = '512MB'`);
  await c.query(`CREATE INDEX ${indexName(key)} ON image_embeddings USING hnsw (${vectorExpr(spec.dim)} vector_cosine_ops) WITH (m = 16, ef_construction = 64) WHERE ${modelPredicate(key)}`);
  c.release();
  setup.hnswBuildMs = Date.now() - t;
  t = Date.now();
  const ids = (await pool.query(`SELECT id FROM products ORDER BY id`)).rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 1000) await withTx((tx) => refreshProducts(tx, ids.slice(i, i + 1000)));
  setup.refreshCanonicalMs = Date.now() - t;
  await pool.query('ANALYZE');
  console.log('setup', setup);
}

// ---------------------------------------------------------------- run the real app over HTTP
const password = randomBytes(18).toString('base64url');
const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
// One account per simulated user: rate limits and sessions are per user, as in real use.
const cookies: string[] = [];
for (let u = 0; u < USERS; u++) {
  const email = `bench${u}@bench.local`;
  await pool.query(
    `INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, $2, 'operator', $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true`,
    [email, email, await hashPassword(password)],
  );
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ email, password }) });
  cookies.push((res.headers.get('set-cookie') ?? '').split(';')[0]);
}
const cookie = cookies[0];
const sample = (await pool.query(`SELECT id, primary_gtin FROM products ORDER BY random() LIMIT 200`)).rows;
const supplierId = (await pool.query(`SELECT id FROM suppliers WHERE code = 'bench-b'`)).rows[0].id;

type Scenario = { name: string; path: () => string };
const scenarios: Scenario[] = [
  { name: 'catalogo pagina 1', path: () => '/api/products?limit=48' },
  { name: 'catalogo pagina profonda (offset 5000)', path: () => '/api/products?limit=48&offset=5000' },
  { name: 'testo "gel rosa"', path: () => `/api/products?q=${encodeURIComponent('gel rosa')}` },
  { name: 'testo con refuso "vibratre"', path: () => '/api/products?q=vibratre' },
  { name: 'EAN esatto', path: () => `/api/products?q=${sample[Math.floor(Math.random() * sample.length)].primary_gtin.slice(1)}` },
  { name: 'filtri fornitore+disponibilità+prezzo', path: () => `/api/products?suppliers=${supplierId}&availability=available&priceMin=5&priceMax=20&sort=price` },
  { name: 'scheda prodotto', path: () => `/api/products/${sample[Math.floor(Math.random() * sample.length)].id}` },
  { name: 'facet filtri', path: () => '/api/catalog/facets' },
];

const q = (arr: number[], p: number) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0);
async function runConcurrent<T>(total: number, users: number, fn: (i: number, user: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: users }, async (_, user) => {
    while (next < total) {
      const i = next++;
      out.push(await fn(i, user));
    }
  }));
  return out;
}

// warm-up (not measured)
for (const s of scenarios) await fetch(`${base}${s.path()}`, { headers: { cookie } });

const apiResults = await runConcurrent(Number(values.requests), USERS, async (i, user) => {
  const s = scenarios[i % scenarios.length];
  const t = performance.now();
  const r = await fetch(`${base}${s.path()}`, { headers: { cookie: cookies[user] } });
  await r.arrayBuffer();
  return { name: s.name, ms: performance.now() - t, status: r.status };
});
const apiByScenario = Object.fromEntries(
  scenarios.map((s) => {
    const ms = apiResults.filter((r) => r.name === s.name).map((r) => r.ms);
    return [s.name, { n: ms.length, p50: Math.round(q(ms, 0.5)), p95: Math.round(q(ms, 0.95)), max: Math.round(Math.max(...ms)) }];
  }),
);
const apiAll = apiResults.map((r) => r.ms);

// ANN only (random query vectors, 5 concurrent)
const annMs = await runConcurrent(200, USERS, async () => {
  const v = Float32Array.from({ length: spec.dim }, () => Math.random() - 0.5);
  const t = performance.now();
  await nearestImages(key, spec.dim, v);
  return performance.now() - t;
});

// Photo search over HTTP with the real model (fixture photos), 1 user then USERS concurrent users.
const qdir = path.resolve('fixtures/demo/queries');
const photos = existsSync(qdir) ? await Promise.all((await readdir(qdir)).filter((f) => f.endsWith('.jpg')).map((f) => readFile(path.join(qdir, f)))) : [];
const photoRun = async (users: number, total: number) => {
  const res = await runConcurrent(total, users, async (i, user) => {
    const form = new FormData();
    form.append('image', new Blob([photos[i % photos.length]], { type: 'image/jpeg' }), 'q.jpg');
    const t = performance.now();
    const r = await fetch(`${base}/api/search/photo`, { method: 'POST', headers: { cookie: cookies[user], 'x-requested-with': 'fetch' }, body: form });
    const body: any = await r.json();
    return { client: performance.now() - t, server: body.timings?.total ?? NaN, embed: body.timings?.embed ?? NaN, ann: body.timings?.ann ?? NaN, status: r.status };
  });
  const ok = res.filter((r) => r.status === 200);
  const pick = (k: 'client' | 'server' | 'embed' | 'ann') => ({ p50: Math.round(q(ok.map((r) => r[k]), 0.5)), p95: Math.round(q(ok.map((r) => r[k]), 0.95)) });
  return { n: res.length, errors: res.filter((r) => r.status !== 200).length, errorStatuses: [...new Set(res.filter((r) => r.status !== 200).map((r) => r.status))], client: pick('client'), server: pick('server'), embed: pick('embed'), ann: pick('ann') };
};
let photo: Record<string, unknown> = { skipped: 'fixtures/demo/queries assenti: eseguire pnpm demo:fixtures' };
if (photos.length) {
  const cold = performance.now();
  await getEmbedder(spec.id).load();
  const coldMs = Math.round(performance.now() - cold);
  photo = { modelLoadMs: coldMs, oneUser: await photoRun(1, Math.min(10, Number(values.photos))), concurrent: await photoRun(USERS, Number(values.photos)) };
}

const counts = (await pool.query(`SELECT (SELECT count(*) FROM products)::int AS products, (SELECT count(*) FROM supplier_offers)::int AS offers, (SELECT count(*) FROM image_embeddings WHERE status = 'done')::int AS vectors`)).rows[0];
const pgVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
const report = {
  generatedAt: new Date().toISOString(),
  synthetic: true,
  dataset: counts,
  setupMs: setup,
  environment: {
    cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGb: Math.round(os.totalmem() / 1e9), platform: `${process.platform}/${process.arch}`, node: process.version,
    postgres: pgVersion, visionThreads: config.VISION_THREADS, visionConcurrency: config.VISION_CONCURRENCY, model: key, users: USERS,
  },
  api: { requests: apiAll.length, errors: apiResults.filter((r) => r.status !== 200).length, p50: Math.round(q(apiAll, 0.5)), p95: Math.round(q(apiAll, 0.95)), byScenario: apiByScenario },
  annOnly: { queries: annMs.length, p50: Math.round(q(annMs, 0.5)), p95: Math.round(q(annMs, 0.95)) },
  photoSearch: photo,
  totalMs: Date.now() - t0,
};
await mkdir(values.out!, { recursive: true });
const file = path.join(values.out!, `load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`report: ${file}`);
await app.close();
await pool.end();
