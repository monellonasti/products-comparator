// Scheduled supplier feed + change report against the real database and a local HTTP feed server.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { pool } from '../../src/db/pool.ts';
import { runImport } from '../../src/imports/pipeline.ts';
import { feedsTick, runFeed, saveFeedConfig, FeedError, testFeed } from '../../src/imports/feed.ts';
import { createSupplier, csv, defaultsNet, importCsv, resetDatabase, row, standardMapping } from '../helpers.ts';

const PORT = 47124;
let feedBody: Buffer | null = null;
let feedStatus = 200;
const requests: Array<{ url: string; auth: string | undefined }> = [];
let server: http.Server;

const admin = { kind: 'user' as const, userId: null };
const schedule = { kind: 'daily' as const, time: '06:00', timezone: 'Europe/Rome' };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', auth: req.headers.authorization });
    if (feedStatus !== 200 || !feedBody) return void res.writeHead(feedStatus === 200 ? 404 : feedStatus).end();
    res.writeHead(200, { 'content-type': 'text/csv' }).end(feedBody);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
});
afterAll(async () => {
  server.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDatabase();
  feedBody = null;
  feedStatus = 200;
  requests.length = 0;
});

async function supplierWithProfile(code: string) {
  const s = await createSupplier(code);
  await pool.query(
    `INSERT INTO import_profiles (supplier_id, name, file_kind, parse_options, mapping, defaults) VALUES ($1, 'default', 'csv', $2, $3, $4)`,
    [s.id, JSON.stringify({ delimiter: ';', decimalSeparator: '.' }), JSON.stringify(standardMapping), JSON.stringify(defaultsNet)],
  );
  return s;
}

async function runFeedAndImport(supplierId: string) {
  const outcome = await runFeed(supplierId, 'manual');
  if (outcome !== 'queued') return { outcome, run: null };
  const runId = (await pool.query(`SELECT feed_last_run_id FROM suppliers WHERE id = $1`, [supplierId])).rows[0].feed_last_run_id;
  await runImport(runId);
  return { outcome, run: (await pool.query(`SELECT * FROM import_runs WHERE id = $1`, [runId])).rows[0] };
}

const img = (n: string) => `https://img.example.com/${n}.jpg`;
const day1 = [
  row({ SKU: 'A', EAN: '4006381333931', Prezzo: '10', Giacenza: '5', Immagine: img('a1') }),
  row({ SKU: 'B', EAN: '5901234123457', Prezzo: '20', Giacenza: '5' }),
  row({ SKU: 'C', EAN: '8710103917250', Prezzo: '30', Giacenza: '5' }),
  row({ SKU: 'D', EAN: '0036000291452', Prezzo: '40', Giacenza: '5' }),
];

describe('scheduled feed', () => {
  it('stores the feed URL encrypted and never exposes the token', async () => {
    const s = await supplierWithProfile('alfa');
    await saveFeedConfig(s.id, { enabled: true, url: `http://127.0.0.1:${PORT}/feed.csv?key=S3CR3T-TOKEN`, auth: { type: 'none' }, schedule, mode: 'snapshot' }, admin);
    const sup = (await pool.query(`SELECT connector_kind, connector_config, feed_enabled, feed_next_run_at FROM suppliers WHERE id = $1`, [s.id])).rows[0];
    expect(sup).toMatchObject({ connector_kind: 'http_feed', feed_enabled: true });
    expect(sup.connector_config.urlDisplay).toBe(`http://127.0.0.1:${PORT}/feed.csv?…`);
    expect(JSON.stringify(sup)).not.toContain('S3CR3T');
    const secret = (await pool.query(`SELECT ciphertext FROM supplier_secrets WHERE supplier_id = $1 AND name = 'url'`, [s.id])).rows[0].ciphertext;
    expect(secret).not.toContain('S3CR3T');
    expect(new Date(sup.feed_next_run_at).getTime()).toBeGreaterThan(Date.now());
    const audit = (await pool.query(`SELECT data FROM audit_events WHERE action = 'supplier.feed_configured'`)).rows[0].data;
    expect(JSON.stringify(audit)).not.toContain('S3CR3T');
  });

  it('refuses to send credentials over plain HTTP', async () => {
    const s = await supplierWithProfile('alfa');
    await expect(
      saveFeedConfig(s.id, { enabled: true, url: `http://127.0.0.1:${PORT}/feed.csv`, auth: { type: 'bearer', token: 'x' }, schedule, mode: 'snapshot' }, admin),
    ).rejects.toThrow(FeedError);
  });

  it('downloads daily files, imports them and reports price, availability, quantity, image and listing changes', async () => {
    const s = await supplierWithProfile('alfa');
    await saveFeedConfig(s.id, { enabled: true, url: `http://127.0.0.1:${PORT}/feed.csv?key=abc`, auth: { type: 'none' }, schedule, mode: 'snapshot' }, admin);

    feedBody = csv(day1);
    const first = await runFeedAndImport(s.id);
    expect(first.outcome).toBe('queued');
    expect(first.run).toMatchObject({ status: 'succeeded', source_kind: 'feed' });
    expect(requests[0].url).toBe('/feed.csv?key=abc');
    // First import of the supplier: no change noise.
    expect((await pool.query(`SELECT count(*)::int n FROM offer_changes`)).rows[0].n).toBe(0);

    // Day 2: A price 10 -> 12 and a new image, B sold out, C quantity 5 -> 7, D gone, E new.
    feedBody = csv([
      row({ SKU: 'A', EAN: '4006381333931', Prezzo: '12', Giacenza: '5', Immagine: `${img('a1')}|${img('a2')}` }),
      row({ SKU: 'B', EAN: '5901234123457', Prezzo: '20', Giacenza: '0' }),
      row({ SKU: 'C', EAN: '8710103917250', Prezzo: '30', Giacenza: '7' }),
      row({ SKU: 'E', EAN: '', Prezzo: '9', Giacenza: '3' }),
    ]);
    const second = await runFeedAndImport(s.id);
    expect(second.run.status).toBe('succeeded');
    const changes = (
      await pool.query(
        `SELECT o.supplier_sku, c.change_type, c.old_value, c.new_value, c.pct::text AS pct FROM offer_changes c JOIN supplier_offers o ON o.id = c.offer_id
          WHERE c.import_run_id = $1 ORDER BY o.supplier_sku, c.change_type`,
        [second.run.id],
      )
    ).rows.map((r) => `${r.supplier_sku}:${r.change_type}${r.pct ? `:${r.pct}` : ''}`);
    expect(changes).toEqual(['A:images', 'A:price:20.00', 'B:availability', 'C:stock', 'D:removed', 'E:new_offer']);
    expect(second.run.counters).toMatchObject({ changes_price: 1, changes_availability: 1, changes_stock: 1, changes_images: 1, changes_new_offer: 1, changes_removed: 1 });
    const imgChange = (await pool.query(`SELECT new_value FROM offer_changes WHERE change_type = 'images'`)).rows[0].new_value;
    expect(imgChange.added).toEqual([img('a2')]);

    // Day 3: same file -> no changes, freshness confirmed.
    const third = await runFeedAndImport(s.id);
    expect((await pool.query(`SELECT count(*)::int n FROM offer_changes WHERE import_run_id = $1`, [third.run.id])).rows[0].n).toBe(0);
    expect(third.run.counters.offers_unchanged).toBe(4);
  });

  it('a failed download keeps the data, marks it not up to date and schedules a retry', async () => {
    const s = await supplierWithProfile('alfa');
    await saveFeedConfig(s.id, { enabled: true, url: `http://127.0.0.1:${PORT}/feed.csv`, auth: { type: 'none' }, schedule, mode: 'snapshot' }, admin);
    feedBody = csv(day1);
    await runFeedAndImport(s.id);
    feedStatus = 503;
    const t0 = Date.now();
    expect(await runFeed(s.id, 'schedule')).toBe('failed');
    const sup = (await pool.query(`SELECT * FROM suppliers WHERE id = $1`, [s.id])).rows[0];
    expect(sup).toMatchObject({ feed_last_status: 'failed', feed_consecutive_failures: 1, last_import_status: 'failed' });
    expect(sup.feed_last_error).toMatch(/HTTP 503/);
    expect(sup.feed_last_error).not.toContain('?'); // no query string (tokens) in messages
    const retryInMin = (new Date(sup.feed_next_run_at).getTime() - t0) / 60_000;
    expect(retryInMin).toBeGreaterThan(29);
    expect(retryInMin).toBeLessThan(31);
    expect((await pool.query(`SELECT count(*)::int n FROM supplier_offers WHERE active AND price = 10`)).rows[0].n).toBe(1);
    // Recovery resets the failure counter.
    feedStatus = 200;
    await runFeedAndImport(s.id);
    expect((await pool.query(`SELECT feed_consecutive_failures, last_import_status FROM suppliers WHERE id = $1`, [s.id])).rows[0]).toEqual({
      feed_consecutive_failures: 0, last_import_status: 'succeeded',
    });
  });

  it('waits for a column mapping and postpones when another import is running', async () => {
    const s = await createSupplier('beta');
    await saveFeedConfig(s.id, { enabled: true, url: `http://127.0.0.1:${PORT}/feed.csv`, auth: { type: 'none' }, schedule, mode: 'delta' }, admin);
    feedBody = csv(day1);
    expect(await runFeed(s.id, 'schedule')).toBe('no_mapping');
    expect(requests).toHaveLength(0);

    const t = await testFeed(s.id);
    expect(t).toMatchObject({ ok: true, fileKind: 'csv', hasMapping: false });
    expect(t.headers).toContain('SKU');

    const s2 = await supplierWithProfile('gamma');
    await saveFeedConfig(s2.id, { enabled: true, url: `http://127.0.0.1:${PORT}/feed.csv`, auth: { type: 'none' }, schedule, mode: 'delta' }, admin);
    await importCsv({ supplierId: s2.id, rows: day1, run: false }); // leaves an import queued
    expect(await runFeed(s2.id, 'schedule')).toBe('postponed');
  });

  it('the scheduler enqueues each due feed once', async () => {
    const s = await supplierWithProfile('alfa');
    await saveFeedConfig(s.id, { enabled: true, url: `http://127.0.0.1:${PORT}/feed.csv`, auth: { type: 'none' }, schedule, mode: 'snapshot' }, admin);
    await pool.query(`UPDATE suppliers SET feed_next_run_at = now() - interval '1 minute' WHERE id = $1`, [s.id]);
    expect(await feedsTick()).toBe(1);
    expect(await feedsTick()).toBe(0);
    const jobs = (
      await pool.query(`SELECT count(*)::int n FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'feed_fetch'`)
    ).rows[0].n;
    expect(jobs).toBe(1);
  });
});

describe('change report on manual imports', () => {
  it('records changes for manual uploads too, and never on a supplier first import', async () => {
    const s = await createSupplier('alfa');
    await importCsv({ supplierId: s.id, rows: [row({ SKU: 'X', Prezzo: '10' })] });
    const run = await importCsv({ supplierId: s.id, rows: [row({ SKU: 'X', Prezzo: '9.5' }), row({ SKU: 'Y', Prezzo: '1' })] });
    const rows = (await pool.query(`SELECT change_type, pct::text AS pct FROM offer_changes WHERE import_run_id = $1 ORDER BY change_type`, [run.id])).rows;
    expect(rows).toEqual([{ change_type: 'new_offer', pct: null }, { change_type: 'price', pct: '-5.00' }]);
  });
});
