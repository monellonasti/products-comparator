// Re-check of downloaded images: a supplier replaces the picture keeping the same URL. Real database,
// filesystem storage and a local HTTP image server with ETag / If-None-Match support.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { pool } from '../../src/db/pool.ts';
import { fetchImageSource, recheckImageSource, scheduleImageRechecks } from '../../src/images/tasks.ts';
import { sha256 } from '../../src/lib/hash.ts';
import { createSupplier, importCsv, resetDatabase, row } from '../helpers.ts';

const PORT = 47127;
const base = `http://127.0.0.1:${PORT}/img`;
const images = new Map<string, Buffer>();
const noEtag = new Set<string>();
let failWith: number | null = null;
const requests: Array<{ path: string; ifNoneMatch: string | undefined; status: number }> = [];
let server: http.Server;

const etagOf = (b: Buffer) => `"${createHash('sha1').update(b).digest('hex')}"`;
const png = (r: number, g: number, b: number) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).png().toBuffer();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '';
    const body = images.get(path);
    const log = (status: number) => requests.push({ path, ifNoneMatch: req.headers['if-none-match'] as string | undefined, status });
    if (failWith) return void (log(failWith), res.writeHead(failWith).end());
    if (!body) return void (log(404), res.writeHead(404).end());
    const etag = noEtag.has(path) ? null : etagOf(body);
    if (etag && req.headers['if-none-match'] === etag) return void (log(304), res.writeHead(304, { etag }).end());
    log(200);
    res.writeHead(200, { 'content-type': 'image/png', ...(etag ? { etag } : {}) }).end(body);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
});
afterAll(async () => {
  server.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDatabase();
  images.clear();
  noEtag.clear();
  failWith = null;
  requests.length = 0;
});

// Offers A and C share p1 (one image source), B has p2 (server without ETag), D has two images.
const rows = [
  row({ SKU: 'A', EAN: '4006381333931', Immagine: `${base}/p1.png` }),
  row({ SKU: 'B', EAN: '5901234123457', Immagine: `${base}/p2.png` }),
  row({ SKU: 'C', EAN: '8710103917250', Immagine: `${base}/p1.png` }),
  row({ SKU: 'D', EAN: '0036000291452', Immagine: `${base}/p3.png|${base}/p4.png` }),
];

async function importAndDownload(supplierId: string) {
  const run = await importCsv({ supplierId, rows, mode: 'snapshot' });
  for (const s of (await pool.query(`SELECT id FROM image_sources WHERE status = 'pending'`)).rows) await fetchImageSource(s.id);
  return run;
}
const source = async (file: string) => (await pool.query(`SELECT * FROM image_sources WHERE url = $1`, [`${base}/${file}`])).rows[0];
const ageChecks = () => pool.query(`UPDATE image_sources SET checked_at = now() - interval '2 days', fetched_at = now() - interval '2 days'`);
const recheckJobs = async () =>
  (await pool.query(`SELECT count(*)::int n FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = $1`, ['image_recheck'])).rows[0].n;

describe('image re-check', () => {
  beforeEach(async () => {
    images.set('/img/p1.png', await png(200, 30, 30));
    images.set('/img/p2.png', await png(30, 200, 30));
    images.set('/img/p3.png', await png(30, 30, 200));
    images.set('/img/p4.png', await png(200, 200, 30));
    noEtag.add('/img/p2.png');
  });

  it('stores validators on download and re-checks only images older than IMAGE_RECHECK_HOURS', async () => {
    const s = await createSupplier('alfa');
    const run = await importAndDownload(s.id);
    const p1 = await source('p1.png');
    expect(p1).toMatchObject({ status: 'fetched', etag: etagOf(images.get('/img/p1.png')!) });
    expect(p1.checked_at).not.toBeNull();
    expect((await source('p2.png')).etag).toBeNull();

    expect(await scheduleImageRechecks(s.id, run.id)).toBe(0); // just downloaded
    await ageChecks();
    expect(await scheduleImageRechecks(s.id, run.id)).toBe(4);
    expect(await recheckJobs()).toBe(4);
  });

  it('keeps the image when the server answers 304 or returns identical bytes', async () => {
    const s = await createSupplier('alfa');
    const run = await importAndDownload(s.id);
    await ageChecks();
    const before = await source('p1.png');
    requests.length = 0;

    expect(await recheckImageSource(before.id, run.id)).toBe('unchanged');
    expect(requests).toEqual([{ path: '/img/p1.png', ifNoneMatch: before.etag, status: 304 }]);
    expect(await recheckImageSource((await source('p2.png')).id, run.id)).toBe('unchanged'); // no ETag: bytes compared

    const after = await source('p1.png');
    expect(after.image_asset_id).toBe(before.image_asset_id);
    expect(new Date(after.checked_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await pool.query(`SELECT count(*)::int n FROM offer_changes`)).rows[0].n).toBe(0);
  });

  it('reports a picture replaced at the same URL on every offer using it, with before/after assets', async () => {
    const s = await createSupplier('alfa');
    await importAndDownload(s.id);
    await ageChecks();
    const oldP1 = await source('p1.png');
    const oldP3 = await source('p3.png');

    // Next day: same price list, but the supplier replaced p1, p2 (no ETag), p3 and p4 at the same URLs.
    images.set('/img/p1.png', await png(10, 10, 10));
    images.set('/img/p2.png', await png(20, 20, 20));
    images.set('/img/p3.png', await png(40, 40, 40));
    images.set('/img/p4.png', await png(60, 60, 60));
    const run2 = await importCsv({ supplierId: s.id, rows, mode: 'snapshot' });
    const queued = (
      await pool.query(`SELECT j.payload FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'images_recheck'`)
    ).rows;
    expect(queued.map((j) => j.payload)).toEqual([{ supplierId: s.id, runId: run2.id }]);
    expect(await scheduleImageRechecks(s.id, run2.id)).toBe(4);
    for (const f of ['p1.png', 'p2.png', 'p3.png', 'p4.png']) expect(await recheckImageSource((await source(f)).id, run2.id)).toBe('replaced');

    const newP1 = await source('p1.png');
    const newAsset = (await pool.query(`SELECT sha256 FROM image_assets WHERE id = $1`, [newP1.image_asset_id])).rows[0];
    expect(newAsset.sha256).toBe(sha256(images.get('/img/p1.png')!));
    expect(newP1.etag).toBe(etagOf(images.get('/img/p1.png')!));

    const changes = (
      await pool.query(
        `SELECT o.supplier_sku AS sku, c.old_value, c.new_value, c.import_run_id FROM offer_changes c JOIN supplier_offers o ON o.id = c.offer_id
          WHERE c.change_type = 'image_replaced' ORDER BY o.supplier_sku`,
      )
    ).rows;
    expect(changes.map((c) => c.sku)).toEqual(['A', 'B', 'C', 'D']);
    expect(changes.every((c) => c.import_run_id === run2.id)).toBe(true);
    const a = changes[0];
    expect(a.old_value).toEqual({ images: [{ url: `${base}/p1.png`, assetId: oldP1.image_asset_id }] });
    expect(a.new_value).toEqual({ images: [{ url: `${base}/p1.png`, assetId: newP1.image_asset_id }] });
    // Two replaced pictures of the same offer: one change row with both.
    const d = changes[3];
    expect(d.old_value.images.map((i: any) => i.url).sort()).toEqual([`${base}/p3.png`, `${base}/p4.png`]);
    expect(d.old_value.images.find((i: any) => i.url.endsWith('p3.png')).assetId).toBe(oldP3.image_asset_id);

    const counters = (await pool.query(`SELECT counters FROM import_runs WHERE id = $1`, [run2.id])).rows[0].counters;
    expect(counters.changes_image_replaced).toBe(4);
    // The product sheet now shows the new picture; the old asset is kept for the report.
    const product = (await pool.query(`SELECT p.primary_image_id FROM products p JOIN supplier_offers o ON o.product_id = p.id WHERE o.supplier_sku = 'A'`)).rows[0];
    expect(product.primary_image_id).toBe(newP1.image_asset_id);
    expect((await pool.query(`SELECT 1 FROM image_assets WHERE id = $1`, [oldP1.image_asset_id])).rowCount).toBe(1);

    // Re-running the same job does not duplicate anything.
    expect(await recheckImageSource(newP1.id, run2.id)).toBe('unchanged');
    expect((await pool.query(`SELECT count(*)::int n FROM offer_changes`)).rows[0].n).toBe(4);
  });

  it('keeps the current image when the re-check fails', async () => {
    const s = await createSupplier('alfa');
    const run = await importAndDownload(s.id);
    await ageChecks();
    const before = await source('p1.png');
    failWith = 500;
    expect(await recheckImageSource(before.id, run.id)).toBe('error');
    const after = await source('p1.png');
    expect(after).toMatchObject({ status: 'fetched', image_asset_id: before.image_asset_id });
    expect(new Date(after.checked_at).getTime()).toBeGreaterThan(new Date(before.checked_at).getTime());
    expect((await pool.query(`SELECT count(*)::int n FROM offer_changes`)).rows[0].n).toBe(0);
  });
});
