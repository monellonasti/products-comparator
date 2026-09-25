// Seeds a DEMO database from fixtures/demo (synthetic data). Never run against production data.
// Users: passwords from DEMO_ADMIN_PASSWORD / DEMO_OPERATOR_PASSWORD, otherwise generated and printed once.
// Imports run inline; images and embeddings are processed by the worker (pnpm worker) while the demo
// image server (pnpm demo:images) is running.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.ts';
import { migrate } from '../db/migrate.ts';
import { pool } from '../db/pool.ts';
import { ensureWorkerSchema } from '../jobs/setup.ts';
import { ensureModel } from '../vision/index-admin.ts';
import { getModelSpec } from '../vision/models.ts';
import { storage } from '../storage/index.ts';
import { hashPassword } from '../server/auth.ts';
import { createUploadRun, startRun } from '../imports/service.ts';
import { runImport } from '../imports/pipeline.ts';
import type { ColumnMapping, ImportDefaults } from '../imports/fields.ts';
import { foldText } from '../lib/text.ts';

if (config.NODE_ENV === 'production') {
  console.error('demo:seed non è consentito con NODE_ENV=production');
  process.exit(1);
}
const FIX = path.resolve('fixtures/demo');

await migrate(config.DATABASE_URL, () => {});
await ensureWorkerSchema(config.DATABASE_URL);
await ensureModel(pool, getModelSpec(config.VISION_MODEL), { activateIfNoneActive: true });
await storage().check(true);

const existing = (await pool.query(`SELECT count(*)::int AS n FROM suppliers`)).rows[0].n;
if (existing > 0 && !process.argv.includes('--force')) {
  console.error('Il database contiene già fornitori: usare un database vuoto oppure --force per aggiungere i dati demo.');
  process.exit(1);
}

async function ensureUser(email: string, name: string, role: 'admin' | 'operator', envVar: string) {
  const provided = process.env[envVar];
  const password = provided ?? randomBytes(12).toString('base64url');
  await pool.query(
    `INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true`,
    [email, name, role, await hashPassword(password)],
  );
  return provided ? `${email} (password da ${envVar})` : `${email} / ${password}`;
}

const admin = await ensureUser('admin@demo.local', 'Amministratore demo', 'admin', 'DEMO_ADMIN_PASSWORD');
const operator = await ensureUser('operatore@demo.local', 'Operatore demo', 'operator', 'DEMO_OPERATOR_PASSWORD');

async function supplier(code: string, name: string, priority: number, vat: 'net' | 'gross', rate: string | null) {
  return (
    await pool.query(
      `INSERT INTO suppliers (code, name, priority, default_currency, default_vat_treatment, default_vat_rate, image_host_allowlist, stale_after_hours, website, notes)
       VALUES ($1, $2, $3, 'EUR', $4, $5, $6, 168, $7, 'Fornitore DEMO con dati sintetici')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
      [code, name, priority, vat, rate, ['127.0.0.1'], `https://${code}.example.com`],
    )
  ).rows[0];
}
const alfa = await supplier('alfa', 'Alfa Distribuzione (demo)', 10, 'net', null);
const beta = await supplier('beta', 'Beta Wholesale (demo)', 20, 'net', null);
const gamma = await supplier('gamma', 'Gamma Import (demo)', 30, 'gross', '22');

const categories = ['Vibratori', 'Lubrificanti', 'Preservativi', 'Cosmetici', 'Accessori', 'Kit regalo'];
const catIds = new Map<string, string>();
for (const name of categories) {
  const row = (
    await pool.query(`INSERT INTO categories (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [
      name, foldText(name).replace(/\s+/g, '-'),
    ])
  ).rows[0];
  catIds.set(name, row.id);
}

const net: ImportDefaults = { currency: 'EUR', vatTreatment: 'net', vatRate: null, unitsPerPack: 1, salesUnit: 'pz' };
const plan: Array<{ s: any; file: string; mapping: ColumnMapping; defaults: ImportDefaults; decimal: '.' | ','; mode: 'snapshot' | 'delta' }> = [
  {
    s: alfa, file: 'alfa-distribuzione.csv', decimal: ',', mode: 'snapshot', defaults: net,
    mapping: { fields: {
      sku: 'Codice Articolo', barcode: 'EAN', title: 'Descrizione', brand: 'Marca', category: 'Categoria', color: 'Colore', net_content: 'Contenuto',
      price: 'Prezzo netto', units_per_pack: 'Pz/conf', stock_quantity: 'Giacenza', image_urls: ['Immagine 1', 'Immagine 2'], product_url: 'Link prodotto',
    } },
  },
  {
    s: beta, file: 'beta-wholesale.xlsx', decimal: '.', mode: 'snapshot', defaults: net,
    mapping: { fields: {
      sku: 'Item No', barcode: 'EAN Code', title: 'Product Name', brand: 'Brand', category: 'Category', color: 'Colour', price: 'Unit Price',
      units_per_pack: 'Pack', moq: 'MOQ', availability: 'Availability', lead_time: 'Delivery', image_urls: ['Image URL'], product_url: 'Product URL',
    } },
  },
  {
    s: gamma, file: 'gamma-import.csv', decimal: '.', mode: 'delta', defaults: { currency: 'EUR', vatTreatment: 'gross', vatRate: '22', unitsPerPack: 1, salesUnit: 'pz' },
    mapping: { fields: { sku: 'sku', barcode: 'ean', title: 'title', brand: 'brand', price: 'price_gross', vat_rate: 'vat', stock_quantity: 'stock', image_urls: ['image'] } },
  },
];

for (const step of plan) {
  const bytes = await readFile(path.join(FIX, step.file));
  const up = await createUploadRun({ supplierId: step.s.id, fileName: step.file, bytes, userId: null });
  await startRun(up.run.id, { mapping: step.mapping, defaults: step.defaults, parseOptions: { decimalSeparator: step.decimal }, mode: step.mode, asOf: null, saveProfile: true });
  await runImport(up.run.id);
  const run = (await pool.query(`SELECT status, counters, error FROM import_runs WHERE id = $1`, [up.run.id])).rows[0];
  console.log(`${step.file}: ${run.status} ${JSON.stringify(run.counters)}${run.error ? ` errore: ${run.error}` : ''}`);
}

// Map raw supplier categories to the normalised ones.
const rules: Array<[RegExp, string]> = [
  [/vibrat|toys/i, 'Vibratori'], [/lubrif|lubes/i, 'Lubrificanti'], [/preserv|condom/i, 'Preservativi'], [/cosmet|wellness/i, 'Cosmetici'],
  [/accessor/i, 'Accessori'], [/^kit/i, 'Kit regalo'],
];
const raws = (await pool.query(`SELECT supplier_id, raw_category FROM category_mappings WHERE category_id IS NULL`)).rows;
for (const r of raws) {
  const hit = rules.find(([re]) => re.test(r.raw_category));
  if (!hit) continue;
  const cid = catIds.get(hit[1])!;
  await pool.query(`UPDATE category_mappings SET category_id = $3 WHERE supplier_id = $1 AND raw_category = $2`, [r.supplier_id, r.raw_category, cid]);
  await pool.query(`UPDATE supplier_offers SET category_id = $3 WHERE supplier_id = $1 AND category_raw = $2`, [r.supplier_id, r.raw_category, cid]);
}
const { refreshProducts } = await import('../domain/canonical.ts');
const ids = (await pool.query(`SELECT id FROM products WHERE status <> 'merged'`)).rows.map((r) => r.id);
await refreshProducts(pool, ids);

const summary = (
  await pool.query(
    `SELECT (SELECT count(*) FROM products WHERE status = 'active')::int AS products, (SELECT count(*) FROM supplier_offers)::int AS offers,
            (SELECT count(*) FROM image_sources)::int AS image_urls, (SELECT count(*) FROM match_reviews WHERE status = 'open')::int AS reviews`,
  )
).rows[0];
console.log(`\nDEMO pronta (dati sintetici): ${JSON.stringify(summary)}`);
console.log(`Utenti:\n  admin     ${admin}\n  operatore ${operator}`);
console.log('Prossimi passi: avviare "pnpm demo:images" e "pnpm worker" per scaricare e indicizzare le immagini.');
await pool.end();
