// login -> import two suppliers -> EAN aggregation -> real image indexing -> photo search -> product
// sheet -> offer comparison. Uses synthetic images: it proves the pipeline, not real-world accuracy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import { runOnce } from 'graphile-worker';
import type { FastifyInstance } from 'fastify';
import { pool } from '../../src/db/pool.ts';
import { config } from '../../src/config.ts';
import { buildApp } from '../../src/server/app.ts';
import { hashPassword } from '../../src/server/auth.ts';
import { ensureModel } from '../../src/vision/index-admin.ts';
import { getModelSpec } from '../../src/vision/models.ts';
import { storage } from '../../src/storage/index.ts';
import { taskList } from '../../src/worker/tasks.ts';
import { resetDatabase } from '../helpers.ts';

const PW = 'password-e2e-molto-lunga';
const PRODUCTS = [
  { ean: '4006381333931', name: 'Gel Idratante Rosso', svg: bottle('#c62828', 'ROSSO') },
  { ean: '5901234123457', name: 'Scatola Blu Classic', svg: box('#1565c0', 'BLU') },
  { ean: '8710103917250', name: 'Massaggiatore Verde', svg: egg('#2e7d32', 'VERDE') },
  { ean: '0036000291452', name: 'Anello Viola', svg: ring('#6a1b9a', 'VIOLA') },
];

function frame(inner: string, bg = '#ffffff') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="${bg}"/>${inner}</svg>`;
}
function bottle(c: string, t: string) {
  return frame(`<rect x="230" y="160" width="140" height="330" rx="40" fill="${c}"/><rect x="270" y="100" width="60" height="70" fill="#333"/><text x="300" y="340" font-size="34" font-family="Arial" text-anchor="middle" fill="#fff">${t}</text>`);
}
function box(c: string, t: string) {
  return frame(`<rect x="150" y="170" width="300" height="300" fill="${c}"/><path d="M150 170 L210 120 L510 120 L450 170 Z" fill="#90caf9"/><text x="300" y="340" font-size="40" font-family="Arial" text-anchor="middle" fill="#fff">${t}</text>`);
}
function egg(c: string, t: string) {
  return frame(`<ellipse cx="300" cy="320" rx="110" ry="200" fill="${c}"/><text x="300" y="560" font-size="32" font-family="Arial" text-anchor="middle" fill="${c}">${t}</text>`);
}
function ring(c: string, t: string) {
  return frame(`<path fill-rule="evenodd" fill="${c}" d="M140 300 a160 160 0 1 0 320 0 a160 160 0 1 0 -320 0 Z M210 300 a90 90 0 1 0 180 0 a90 90 0 1 0 -180 0 Z"/><text x="300" y="540" font-size="32" font-family="Arial" text-anchor="middle" fill="${c}">${t}</text>`);
}

let app: FastifyInstance;
let base: string;
let images: http.Server;
const imageBytes = new Map<string, Buffer>();

async function login(email: string) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ email, password: PW }) });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}
function client(cookie: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie, 'x-requested-with': 'fetch' };
    let payload: RequestInit['body'] | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b ?? {}) };
}
/** Runs the real worker tasks until no runnable job is left. runOnce() alone may stop early when the only
 *  remaining jobs sit in a serialised named queue (e.g. embed:0) that another job just released. */
async function drainQueue() {
  for (let i = 0; i < 50; i++) {
    await runOnce({ connectionString: config.DATABASE_URL, taskList, concurrency: 2 });
    const left = (await pool.query(`SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE run_at <= now() AND attempts < max_attempts`)).rows[0].n;
    if (left === 0) return;
  }
  throw new Error('queue did not drain');
}

beforeAll(async () => {
  await resetDatabase();
  await ensureModel(pool, getModelSpec(config.VISION_MODEL), { activateIfNoneActive: true });
  await storage().check(true);
  for (const [email, role] of [['admin@e2e.local', 'admin'], ['op@e2e.local', 'operator']]) {
    await pool.query(`INSERT INTO users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4)`, [email, email, role, await hashPassword(PW)]);
  }
  for (const p of PRODUCTS) {
    imageBytes.set(`a-${p.ean}.jpg`, await sharp(Buffer.from(p.svg)).jpeg({ quality: 90 }).toBuffer());
    imageBytes.set(`b-${p.ean}.jpg`, await sharp(Buffer.from(p.svg)).rotate(5, { background: '#f2f2f2' }).resize(600, 600).jpeg({ quality: 85 }).toBuffer());
  }
  images = http.createServer((req, res) => {
    const b = imageBytes.get((req.url ?? '').slice(1));
    if (!b) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(b);
  });
  await new Promise<void>((r) => images.listen(4011, '127.0.0.1', r));
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}, 300_000);

afterAll(async () => {
  await app?.close();
  images?.close();
  await pool.end();
});

describe('end-to-end: import -> aggregation -> real indexing -> photo search -> offers', () => {
  let admin: ReturnType<typeof client>;
  let supplierA: string;
  let supplierB: string;

  it('admin logs in and creates two suppliers', async () => {
    admin = client(await login('admin@e2e.local'));
    const a = await admin.post('/api/suppliers', { code: 'alfa', name: 'Alfa', priority: 10, defaultVatTreatment: 'net', imageHostAllowlist: ['127.0.0.1'] });
    const b = await admin.post('/api/suppliers', { code: 'beta', name: 'Beta', priority: 20, defaultVatTreatment: 'gross', defaultVatRate: '22', imageHostAllowlist: ['127.0.0.1'] });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    supplierA = a.json.supplier.id;
    supplierB = b.json.supplier.id;
  });

  it('imports supplier A (CSV ; with decimal comma) through upload -> preview -> start', async () => {
    const csv = ['Codice;EAN;Descrizione;Marca;Prezzo;Giacenza;Immagine']
      .concat(PRODUCTS.map((p, i) => `A-${i};${p.ean};${p.name};Demo;${(10 + i).toFixed(2).replace('.', ',')};${i === 0 ? 0 : 10};http://127.0.0.1:4011/a-${p.ean}.jpg`))
      .join('\n');
    const form = new FormData();
    form.append('supplierId', supplierA);
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'alfa.csv');
    const up = await admin.post('/api/imports', form);
    expect(up.status).toBe(200);
    expect(up.json.suggestedMapping.fields).toMatchObject({ sku: 'Codice', barcode: 'EAN', price: 'Prezzo', stock_quantity: 'Giacenza', image_urls: ['Immagine'] });
    expect(up.json.run.parseOptions).toMatchObject({ delimiter: ';', decimalSeparator: ',' });
    const mapping = { fields: { ...up.json.suggestedMapping.fields, title: 'Descrizione', brand: 'Marca' } };
    const defaults = { currency: 'EUR', vatTreatment: 'net', vatRate: null, unitsPerPack: 1, salesUnit: 'pz' };
    const preview = await admin.post(`/api/imports/${up.json.run.id}/preview`, { mapping, defaults });
    expect(preview.status).toBe(200);
    expect(preview.json.summary).toMatchObject({ errors: 0, newOffers: 4 });
    const start = await admin.post(`/api/imports/${up.json.run.id}/start`, { mapping, defaults, mode: 'snapshot', saveProfile: true });
    expect(start.status).toBe(200);
    await drainQueue();
    const detail = await admin.get(`/api/imports/${up.json.run.id}`);
    expect(detail.json.run.status).toBe('succeeded');
    expect(detail.json.run.counters).toMatchObject({ offers_created: 4, products_created: 4, images_new: 4 });
  });

  it('imports supplier B (XLSX, gross prices, packs) and aggregates by EAN', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Listino');
    ws.addRow(['Item', 'EAN Code', 'Name', 'Unit Price', 'Pack', 'Availability', 'Image URL']);
    PRODUCTS.slice(0, 3).forEach((p, i) => {
      const r = ws.addRow([`B-${i}`, p.ean, `${p.name} (B)`, 12.2 * (i === 1 ? 5 : 1), i === 1 ? 5 : 1, 'In stock', `http://127.0.0.1:4011/b-${p.ean}.jpg`]);
      r.getCell(2).numFmt = '@';
    });
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const form = new FormData();
    form.append('supplierId', supplierB);
    form.append('file', new Blob([bytes]), 'beta.xlsx');
    const up = await admin.post('/api/imports', form);
    expect(up.status).toBe(200);
    const mapping = { fields: { sku: 'Item', barcode: 'EAN Code', title: 'Name', price: 'Unit Price', units_per_pack: 'Pack', availability: 'Availability', image_urls: ['Image URL'] } };
    const defaults = { currency: 'EUR', vatTreatment: 'gross', vatRate: '22', unitsPerPack: 1, salesUnit: null };
    expect((await admin.post(`/api/imports/${up.json.run.id}/start`, { mapping, defaults, mode: 'delta', saveProfile: true })).status).toBe(200);
    await drainQueue();
    const products = await admin.get(`/api/products?q=${PRODUCTS[1].ean}`);
    expect(products.json.items).toHaveLength(1);
    expect(products.json.items[0]).toMatchObject({ supplierCount: 2, offerCount: 2 });
    const all = await admin.get('/api/products');
    expect(all.json.total).toBe(4);
  });

  it('indexes every downloaded image with the real model', async () => {
    const cov = (await pool.query(`SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*)::int AS total FROM image_embeddings`)).rows[0];
    const assets = (await pool.query(`SELECT count(*)::int AS n FROM image_assets`)).rows[0].n;
    expect(assets).toBe(7);
    expect(cov).toEqual({ done: 7, total: 7 });
  });

  it('finds the photographed product with a phone-like photo and shows comparable offers', async () => {
    const operator = client(await login('op@e2e.local'));
    const target = PRODUCTS[1];
    const product = await sharp(Buffer.from(target.svg)).rotate(-12, { background: '#ffffff' }).resize(420, 420).modulate({ brightness: 0.85 }).png().toBuffer();
    const photo = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#8d7b68' } })
      .composite([{ input: product, left: 220, top: 380 }]).blur(1).jpeg({ quality: 70 }).toBuffer();
    const form = new FormData();
    form.append('crop', JSON.stringify({ x: 200 / 900, y: 360 / 1200, width: 460 / 900, height: 460 / 1200 }));
    form.append('image', new Blob([photo], { type: 'image/jpeg' }), 'foto.jpg');
    const res = await operator.post('/api/search/photo', form);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('ok');
    const top5 = res.json.candidates.slice(0, 5).map((c: any) => c.product.gtin);
    expect(top5).toContain('5901234123457');
    const hit = res.json.candidates.find((c: any) => c.product.gtin === '5901234123457');
    expect(hit.evidence.map((e: any) => e.kind)).toContain('visual');
    expect(res.json.timings.total).toBeGreaterThan(0);

    const sheet = await operator.get(`/api/products/${hit.product.id}`);
    expect(sheet.status).toBe(200);
    const offers = sheet.json.offers.map((o: any) => ({ s: o.supplier.name, unit: o.netUnitPrice, pack: o.unitsPerPack }));
    expect(offers).toEqual(expect.arrayContaining([{ s: 'Alfa', unit: '11.0000', pack: 1 }, { s: 'Beta', unit: '10.0000', pack: 5 }]));
    expect(sheet.json.product.bestPrice.best.unitPrice).toBe('10.0000');

    // Operators cannot import.
    const forbidden = await operator.post('/api/imports', new FormData());
    expect(forbidden.status).toBe(403);
  });

  it('re-importing identical data changes nothing (case E: no duplicates, no new downloads or embeddings)', async () => {
    const before = (await pool.query(`SELECT (SELECT count(*) FROM products)::int p, (SELECT count(*) FROM supplier_offers)::int o, (SELECT count(*) FROM image_sources)::int s, (SELECT count(*) FROM image_embeddings)::int e`)).rows[0];
    const csv = ['Codice;EAN;Descrizione;Marca;Prezzo;Giacenza;Immagine']
      .concat(PRODUCTS.map((p, i) => `A-${i};${p.ean};${p.name};Demo;${(10 + i).toFixed(2).replace('.', ',')};${i === 0 ? 0 : 10};http://127.0.0.1:4011/a-${p.ean}.jpg`))
      .join('\n');
    const form = new FormData();
    form.append('supplierId', supplierA);
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'alfa.csv');
    const up = await admin.post('/api/imports', form);
    expect(up.json.duplicateOf).not.toBeNull();
    const mapping = up.json.suggestedMapping;
    expect(mapping.fields.title).toBe('Descrizione'); // saved profile reused
    await admin.post(`/api/imports/${up.json.run.id}/start`, { mapping, defaults: up.json.suggestedDefaults, mode: 'snapshot', saveProfile: false });
    await drainQueue();
    const after = (await pool.query(`SELECT (SELECT count(*) FROM products)::int p, (SELECT count(*) FROM supplier_offers)::int o, (SELECT count(*) FROM image_sources)::int s, (SELECT count(*) FROM image_embeddings)::int e`)).rows[0];
    expect(after).toEqual(before);
    const run = (await admin.get(`/api/imports/${up.json.run.id}`)).json.run;
    expect(run.counters).toMatchObject({ offers_unchanged: 4 });
  });
});
