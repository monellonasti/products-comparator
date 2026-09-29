import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.ts';
import { runImport } from '../../src/imports/pipeline.ts';
import { createUploadRun, ImportRequestError, startRun } from '../../src/imports/service.ts';
import { storage } from '../../src/storage/index.ts';
import { createSupplier, csv, defaultsNet, importCsv, resetDatabase, row, standardMapping } from '../helpers.ts';
import { buildZip, xlsxParts } from '../zip-builder.ts';

const EAN_A = '4006381333931';
const EAN_B = '8710103917250';
const EAN_C = '5901234123457';

async function count(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows[0].n as number;
}

beforeEach(resetDatabase);
afterAll(() => pool.end());

describe('EAN aggregation', () => {
  it('case A: same valid EAN from two suppliers -> one product, two independent offers', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A-1', EAN: EAN_A, Titolo: 'Vibratore Rosa Deluxe', Prezzo: '20' })] });
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B-77', EAN: EAN_A, Titolo: 'Deluxe vibe pink', Prezzo: '18.5' })] });
    expect(await count(`SELECT count(*)::int n FROM products WHERE status = 'active'`)).toBe(1);
    const offers = (await pool.query(`SELECT supplier_sku, price::text, product_id, link_source FROM supplier_offers ORDER BY supplier_sku`)).rows;
    expect(offers).toHaveLength(2);
    expect(offers[0].product_id).toBe(offers[1].product_id);
    expect(offers.map((o) => o.price)).toEqual(['20.0000', '18.5000']);
    const p = (await pool.query(`SELECT offer_count, supplier_count, best_unit_price::text, primary_gtin FROM products`)).rows[0];
    expect(p).toMatchObject({ offer_count: 2, supplier_count: 2, best_unit_price: '18.5000', primary_gtin: `0${EAN_A}` });
  });

  it('case B: same SKU at two suppliers with different EANs -> no merge', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'SAME', EAN: EAN_A })] });
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'SAME', EAN: EAN_B })] });
    expect(await count(`SELECT count(*)::int n FROM products WHERE status = 'active'`)).toBe(2);
  });

  it('case C: two rows without EAN stay distinct', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'N1', EAN: '' }), row({ SKU: 'N2', EAN: '' })] });
    expect(await count(`SELECT count(*)::int n FROM products WHERE status = 'active'`)).toBe(2);
    expect(await count(`SELECT count(*)::int n FROM supplier_offers WHERE link_source = 'standalone' AND barcode_status = 'missing'`)).toBe(2);
  });

  it('keeps invalid EAN as original string and never aggregates on it', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'I1', EAN: '4006381333932' })] });
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'I2', EAN: '4006381333932' })] });
    expect(await count(`SELECT count(*)::int n FROM products WHERE status = 'active'`)).toBe(2);
    const o = (await pool.query(`SELECT barcode_raw, barcode_status, barcode_issue, gtin FROM supplier_offers LIMIT 1`)).rows[0];
    expect(o).toEqual({ barcode_raw: '4006381333932', barcode_status: 'invalid', barcode_issue: 'bad_check_digit', gtin: null });
  });

  it('holds a same-EAN offer with conflicting brand/variant in review instead of merging', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A', EAN: EAN_A, Marca: 'LELO', Colore: 'Rosa' })] });
    const run = await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B', EAN: EAN_A, Marca: 'Lelo Inc.', Colore: 'Nero' })] });
    expect(run.counters.conflicts_opened).toBe(1);
    const held = (await pool.query(`SELECT link_source, product_id FROM supplier_offers WHERE supplier_sku = 'B'`)).rows[0];
    expect(held.link_source).toBe('conflict_hold');
    const review = (await pool.query(`SELECT kind, status, product_id, reasons FROM match_reviews`)).rows[0];
    expect(review).toMatchObject({ kind: 'gtin_conflict', status: 'open', product_id: held.product_id });
    expect(review.reasons[0].field).toBe('color');
    // The original product keeps its data untouched.
    const original = (await pool.query(`SELECT p.attributes FROM products p JOIN product_identifiers i ON i.product_id = p.id`)).rows[0];
    expect(original.attributes.color).toBe('Rosa');
  });
});

describe('idempotency and updates', () => {
  it('case E: re-importing the same data creates nothing new', async () => {
    const s1 = await createSupplier('alfa');
    const rows = [
      row({ SKU: 'A', EAN: EAN_A, Immagine: 'https://img.example.com/a.jpg' }),
      row({ SKU: 'B', EAN: '', Immagine: 'https://img.example.com/b.jpg|https://img.example.com/a.jpg' }),
    ];
    await importCsv({ supplierId: s1.id, rows });
    const snapshot = async () => ({
      products: await count(`SELECT count(*)::int n FROM products`),
      offers: await count(`SELECT count(*)::int n FROM supplier_offers`),
      sources: await count(`SELECT count(*)::int n FROM image_sources`),
      jobs: await count(`SELECT count(*)::int n FROM graphile_worker._private_jobs WHERE task_id = (SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'image_fetch')`),
    });
    const before = await snapshot();
    expect(before).toMatchObject({ products: 2, offers: 2, sources: 2, jobs: 2 });
    const second = await importCsv({ supplierId: s1.id, rows });
    expect(await snapshot()).toEqual(before);
    expect(second.counters).toMatchObject({ offers_unchanged: 2 });
    expect(second.counters.offers_created ?? 0).toBe(0);
    expect(second.counters.products_created ?? 0).toBe(0);
  });

  it('a corrected EAN moves the offer to the right product (no stale association)', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'REF', EAN: EAN_B })] });
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'X1', EAN: EAN_A })] });
    const run = await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'X1', EAN: EAN_B })] });
    expect(run.counters.offers_relinked).toBe(1);
    const products = (await pool.query(`SELECT p.id, p.status, p.offer_count FROM products p ORDER BY created_at`)).rows;
    const target = (await pool.query(`SELECT product_id FROM product_identifiers WHERE value = $1`, [`0${EAN_B}`])).rows[0].product_id;
    const offer = (await pool.query(`SELECT product_id FROM supplier_offers WHERE supplier_sku = 'X1'`)).rows[0];
    expect(offer.product_id).toBe(target);
    expect(products.find((p) => p.id !== target)?.offer_count).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM audit_events WHERE action = 'offer.relinked'`)).toBe(1);
  });

  it('null stock stays unknown, zero means sold out (and qualitative text is kept)', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({
      supplierId: s1.id,
      rows: [row({ SKU: 'U', Giacenza: '' }), row({ SKU: 'Z', Giacenza: '0' }), row({ SKU: 'Q', Disponibilita: 'Disponibile' })],
    });
    const r = Object.fromEntries((await pool.query(`SELECT supplier_sku, stock_quantity, stock_status FROM supplier_offers`)).rows.map((x) => [x.supplier_sku, x]));
    expect(r.U).toMatchObject({ stock_quantity: null, stock_status: 'unknown' });
    expect(r.Z).toMatchObject({ stock_quantity: 0, stock_status: 'out_of_stock' });
    expect(r.Q).toMatchObject({ stock_quantity: null, stock_status: 'in_stock' });
  });

  it('a row with an unparsable price keeps the previous data and is reported', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'P', Prezzo: '10' })] });
    const run = await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'P', Prezzo: 'dieci' })] });
    expect(run.counters.rows_error).toBe(1);
    expect((await pool.query(`SELECT price::text FROM supplier_offers WHERE supplier_sku = 'P'`)).rows[0].price).toBe('10.0000');
    expect(await count(`SELECT count(*)::int n FROM import_row_issues WHERE import_run_id = $1 AND severity = 'error'`, [run.id])).toBe(1);
  });

  it('reports duplicate SKUs in the same file', async () => {
    const s1 = await createSupplier('alfa');
    const run = await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'D', Prezzo: '1' }), row({ SKU: 'D', Prezzo: '2' })] });
    expect((await pool.query(`SELECT price::text FROM supplier_offers`)).rows[0].price).toBe('1.0000');
    expect(await count(`SELECT count(*)::int n FROM import_row_issues WHERE import_run_id = $1 AND code = 'duplicate_sku'`, [run.id])).toBe(1);
  });

  it('ignores rows older than the stored data (out-of-order import)', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'O', Prezzo: '12' })], asOf: new Date('2026-09-20T10:00:00Z') });
    const old = await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'O', Prezzo: '9' })], asOf: new Date('2026-09-10T10:00:00Z') });
    expect(old.counters.offers_skipped_outdated).toBe(1);
    expect((await pool.query(`SELECT price::text FROM supplier_offers`)).rows[0].price).toBe('12.0000');
  });
});

describe('snapshots', () => {
  const three = [row({ SKU: 'S1' }), row({ SKU: 'S2' }), row({ SKU: 'S3' })];

  it('a complete snapshot deactivates offers no longer listed; a delta never does', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({ supplierId: s1.id, rows: three, mode: 'snapshot' });
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'S1' }), row({ SKU: 'S2' })], mode: 'delta' });
    expect(await count(`SELECT count(*)::int n FROM supplier_offers WHERE active`)).toBe(3);
    const snap = await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'S1' }), row({ SKU: 'S2' })], mode: 'snapshot' });
    expect(snap.counters.offers_deactivated).toBe(1);
    expect((await pool.query(`SELECT supplier_sku FROM supplier_offers WHERE NOT active`)).rows).toEqual([{ supplier_sku: 'S3' }]);
    // Offer comes back in a later file -> reactivated, not duplicated.
    await importCsv({ supplierId: s1.id, rows: [...three.slice(0, 2), row({ SKU: 'S3', Prezzo: '11' })], mode: 'delta' });
    expect(await count(`SELECT count(*)::int n FROM supplier_offers WHERE active`)).toBe(3);
    expect(await count(`SELECT count(*)::int n FROM supplier_offers`)).toBe(3);
  });

  it('a suspiciously small snapshot does not deactivate anything', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({ supplierId: s1.id, rows: three, mode: 'snapshot' });
    const snap = await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'S1' })], mode: 'snapshot' });
    expect(snap.counters.offers_deactivated ?? 0).toBe(0);
    expect(snap.snapshot_result).toMatch(/possibile file parziale/);
    expect(await count(`SELECT count(*)::int n FROM supplier_offers WHERE active`)).toBe(3);
  });

  it('a failed import keeps previous data and marks the supplier as failed (case I)', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({ supplierId: s1.id, rows: three, mode: 'snapshot' });
    const queued = await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'S1', Prezzo: '99' })], mode: 'snapshot', run: false });
    // Simulate an infrastructure failure while staging (file no longer readable from storage).
    await pool.query(`UPDATE import_runs SET file_key = 'imports/missing' WHERE id = $1`, [queued.id]);
    await expect(runImport(queued.id)).rejects.toThrow();
    expect((await pool.query(`SELECT status, error FROM import_runs WHERE id = $1`, [queued.id])).rows[0].status).toBe('failed');
    expect((await pool.query(`SELECT last_import_status FROM suppliers WHERE id = $1`, [s1.id])).rows[0].last_import_status).toBe('failed');
    expect(await count(`SELECT count(*)::int n FROM supplier_offers WHERE active`)).toBe(3);
    expect((await pool.query(`SELECT price::text FROM supplier_offers WHERE supplier_sku = 'S1'`)).rows[0].price).toBe('10.0000');
  });
});

describe('refused files', () => {
  it('an XLSX "zip bomb" is refused at upload: cancelled run with the reason, file removed from storage', async () => {
    const s = await createSupplier('alfa');
    const parts = xlsxParts();
    parts[4] = { ...parts[4], data: `<worksheet>${' '.repeat(20_000_000)}</worksheet>`, declaredSize: 500 }; // forged size
    await expect(createUploadRun({ supplierId: s.id, fileName: 'bomba.xlsx', bytes: buildZip(parts), userId: null })).rejects.toThrow(/XLSX rifiutato/);
    const run = (await pool.query(`SELECT status, error, file_key FROM import_runs WHERE supplier_id = $1`, [s.id])).rows[0];
    expect(run.status).toBe('cancelled');
    expect(run.error).toMatch(/zip bomb/);
    expect(await storage().exists(run.file_key)).toBe(false);
  });
});

describe('concurrency', () => {
  it('two suppliers importing the same new GTIN concurrently create exactly one product', async () => {
    const suppliers = await Promise.all(['c1', 'c2', 'c3', 'c4'].map((c) => createSupplier(c)));
    const runs = await Promise.all(
      suppliers.map((s, i) => importCsv({ supplierId: s.id, rows: [row({ SKU: `K${i}`, EAN: EAN_C }), row({ SKU: `L${i}`, EAN: EAN_A })], run: false })),
    );
    await Promise.all(runs.map((r) => runImport(r.id)));
    expect(await count(`SELECT count(*)::int n FROM product_identifiers`)).toBe(2);
    expect(await count(`SELECT count(DISTINCT product_id)::int n FROM supplier_offers`)).toBe(2);
    expect(await count(`SELECT count(*)::int n FROM products WHERE status = 'active'`)).toBe(2);
  });

  it('prevents two active imports for the same supplier', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A' })], run: false });
    await expect(importCsv({ supplierId: s1.id, rows: [row({ SKU: 'B' })], run: false })).rejects.toThrow(/già un import in corso/);
  });
});

// Audit 2026-09-29: one bad row must not fail (and endlessly retry) a whole listino; snapshot dates are
// compared per offer; two starts racing for one supplier end in a clean 409.
describe('robustness', () => {
  it('a value the database cannot hold fails only its row: the import succeeds and the other rows apply', async () => {
    const s = await createSupplier('alfa');
    const run = await importCsv({
      supplierId: s.id,
      rows: [row({ SKU: 'EAN-IN-PRICE', Prezzo: '8001234567890' }), row({ SKU: 'HUGE-STOCK', Giacenza: '3000000000' }), row({ SKU: 'OK', Prezzo: '12.5' })],
    });
    expect(run.status).toBe('succeeded');
    const offers = (await pool.query(`SELECT supplier_sku, stock_quantity FROM supplier_offers ORDER BY supplier_sku`)).rows;
    expect(offers).toEqual([{ supplier_sku: 'HUGE-STOCK', stock_quantity: null }, { supplier_sku: 'OK', stock_quantity: null }]);
    expect(await count(`SELECT count(*)::int n FROM import_row_issues WHERE code = 'price_out_of_range'`)).toBe(1);
  });

  it('a price jump from a 0,01 placeholder is recorded without an unstorable percentage', async () => {
    const s = await createSupplier('alfa');
    await importCsv({ supplierId: s.id, rows: [row({ SKU: 'P', Prezzo: '0.01' })] });
    const run = await importCsv({ supplierId: s.id, rows: [row({ SKU: 'P', Prezzo: '1500' })] });
    expect(run.status).toBe('succeeded');
    const change = (await pool.query(`SELECT change_type, pct FROM offer_changes WHERE import_run_id = $1`, [run.id])).rows[0];
    expect(change).toEqual({ change_type: 'price', pct: null });
    expect((await pool.query(`SELECT price::text FROM supplier_offers WHERE supplier_sku = 'P'`)).rows[0].price).toBe('1500.0000');
  });

  it('a snapshot does not remove an offer that a later-dated delta added, and an older delta cannot revive a removed one', async () => {
    const s = await createSupplier('alfa');
    const day = (d: number) => new Date(Date.UTC(2026, 0, d, 8));
    await importCsv({ supplierId: s.id, mode: 'snapshot', asOf: day(1), rows: [row({ SKU: 'A' }), row({ SKU: 'B' })] });
    await importCsv({ supplierId: s.id, mode: 'delta', asOf: day(3), rows: [row({ SKU: 'X' })] });
    await importCsv({ supplierId: s.id, mode: 'snapshot', asOf: day(2), rows: [row({ SKU: 'A' }), row({ SKU: 'B' })] });
    const active = async (sku: string) => (await pool.query(`SELECT active FROM supplier_offers WHERE supplier_sku = $1`, [sku])).rows[0].active;
    expect(await active('X')).toBe(true);
    await importCsv({ supplierId: s.id, mode: 'snapshot', asOf: day(5), rows: [row({ SKU: 'A' }), row({ SKU: 'B' })] });
    expect(await active('X')).toBe(false);
    await importCsv({ supplierId: s.id, mode: 'delta', asOf: day(4), rows: [row({ SKU: 'X' })] });
    expect(await active('X')).toBe(false);
  });

  it('two imports started together for one supplier: one is queued, the other gets a 409', async () => {
    const s = await createSupplier('alfa');
    const a = await createUploadRun({ supplierId: s.id, fileName: 'a.csv', bytes: csv([row({ SKU: 'A' })]), userId: null });
    const b = await createUploadRun({ supplierId: s.id, fileName: 'b.csv', bytes: csv([row({ SKU: 'B' })]), userId: null });
    const input = { mapping: standardMapping, defaults: defaultsNet, parseOptions: { decimalSeparator: '.' as const }, mode: 'delta' as const, asOf: null, saveProfile: false };
    const results = await Promise.allSettled([startRun(a.run.id, input), startRun(b.run.id, input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ImportRequestError);
    expect(rejected.reason.status).toBe(409);
  });

  it('an import job is not tied to a per-supplier queue (a crashed worker would block it for hours)', async () => {
    const s = await createSupplier('alfa');
    const run = await importCsv({ supplierId: s.id, rows: [row({ SKU: 'A' })], run: false });
    const job = (await pool.query(`SELECT queue_name FROM graphile_worker.jobs WHERE key = $1`, [`import_run:${run.id}`])).rows[0];
    expect(job.queue_name).toBeNull();
  });
});
