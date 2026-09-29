import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTx } from '../../src/db/pool.ts';
import { mergeProducts, revertEvent, detachOffer, resolveReview, setOverrides } from '../../src/domain/associations.ts';
import { createSupplier, importCsv, resetDatabase, row } from '../helpers.ts';

const EAN_A = '4006381333931';
const EAN_B = '8710103917250';
const admin = { kind: 'user' as const, userId: null };

beforeEach(resetDatabase);
afterAll(() => pool.end());

async function productOf(sku: string) {
  return (await pool.query(`SELECT product_id FROM supplier_offers WHERE supplier_sku = $1`, [sku])).rows[0].product_id as string;
}

describe('reversible associations', () => {
  it('case J: a wrong manual merge is fully reverted by a split (offers, identifiers, provenance)', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A1', EAN: EAN_A, Titolo: 'Gel 50 ml' })] });
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B1', EAN: EAN_B, Titolo: 'Gel 100 ml' })] });
    const pa = await productOf('A1');
    const pb = await productOf('B1');

    await expect(withTx((tx) => mergeProducts(tx, { targetId: pa, sourceId: pb, actor: admin, reason: '' }))).rejects.toThrow(/motivazione/);
    const eventId = await withTx((tx) => mergeProducts(tx, { targetId: pa, sourceId: pb, actor: admin, reason: 'Confermato dal fornitore: stesso articolo' }));
    expect(await productOf('B1')).toBe(pa);
    expect((await pool.query(`SELECT status, merged_into_id FROM products WHERE id = $1`, [pb])).rows[0]).toEqual({ status: 'merged', merged_into_id: pa });
    expect((await pool.query(`SELECT count(*)::int n FROM product_identifiers WHERE product_id = $1`, [pa])).rows[0].n).toBe(2);

    // A later import of supplier B still lands on the merged product (GTIN B now belongs to A)...
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B1', EAN: EAN_B, Titolo: 'Gel 100 ml', Prezzo: '11' }), row({ SKU: 'B2', EAN: EAN_B, Titolo: 'Gel 100 ml bis' })] });
    expect(await productOf('B2')).toBe(pa);

    // ...and the split restores everything, including the offer that arrived after the merge.
    await withTx((tx) => revertEvent(tx, eventId, admin, 'Erano varianti diverse'));
    expect(await productOf('A1')).toBe(pa);
    expect(await productOf('B1')).toBe(pb);
    expect(await productOf('B2')).toBe(pb);
    expect((await pool.query(`SELECT status FROM products WHERE id = $1`, [pb])).rows[0].status).toBe('active');
    expect((await pool.query(`SELECT product_id FROM product_identifiers WHERE value = $1`, [`0${EAN_B}`])).rows[0].product_id).toBe(pb);
    const offers = (await pool.query(`SELECT count(*)::int n FROM supplier_offers`)).rows[0].n;
    expect(offers).toBe(3);
    const ev = (await pool.query(`SELECT reverted_by_event_id FROM audit_events WHERE id = $1`, [eventId])).rows[0];
    expect(ev.reverted_by_event_id).not.toBeNull();
    await expect(withTx((tx) => revertEvent(tx, eventId, admin, null))).rejects.toThrow(/già annullata/);
  });

  it('detaching an offer creates a separate product and can be undone', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A1', EAN: EAN_A })] });
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B1', EAN: EAN_A })] });
    const shared = await productOf('A1');
    const offerB = (await pool.query(`SELECT id FROM supplier_offers WHERE supplier_sku = 'B1'`)).rows[0].id;
    const { eventId, productId } = await withTx((tx) => detachOffer(tx, offerB, admin, 'confezione diversa'));
    expect(await productOf('B1')).toBe(productId);
    // The detached offer keeps its manual link on re-import (same GTIN) instead of snapping back.
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B1', EAN: EAN_A, Prezzo: '12' })] });
    expect(await productOf('B1')).toBe(productId);
    await withTx((tx) => revertEvent(tx, eventId, admin, null));
    expect(await productOf('B1')).toBe(shared);
  });

  it('manual overrides survive imports and can be reverted', async () => {
    const s1 = await createSupplier('alfa');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A1', EAN: EAN_A, Titolo: 'Titolo fornitore' })] });
    const pid = await productOf('A1');
    const ev = await withTx((tx) => setOverrides(tx, pid, { title: 'Titolo corretto' }, admin, null));
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A1', EAN: EAN_A, Titolo: 'Titolo fornitore v2' })] });
    expect((await pool.query(`SELECT title FROM products WHERE id = $1`, [pid])).rows[0].title).toBe('Titolo corretto');
    await withTx((tx) => revertEvent(tx, ev, admin, null));
    expect((await pool.query(`SELECT title FROM products WHERE id = $1`, [pid])).rows[0].title).toBe('Titolo fornitore v2');
  });

  it('resolving a GTIN conflict as "different products" is remembered', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A1', EAN: EAN_A, Marca: 'Lelo' })] });
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B1', EAN: EAN_A, Marca: 'Satisfyer' })] });
    const review = (await pool.query(`SELECT id, product_id, candidate_product_id FROM match_reviews WHERE status = 'open'`)).rows[0];
    await withTx((tx) => resolveReview(tx, review.id, 'keep_separate', admin, 'marche diverse, EAN riusato dal fornitore'));
    const pair = (await pool.query(`SELECT count(*)::int n FROM product_distinct_pairs`)).rows[0].n;
    expect(pair).toBe(1);
    expect((await pool.query(`SELECT link_source FROM supplier_offers WHERE supplier_sku = 'B1'`)).rows[0].link_source).toBe('manual');
    // Re-import does not reopen the same review.
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B1', EAN: EAN_A, Marca: 'Satisfyer', Prezzo: '9' })] });
    expect((await pool.query(`SELECT count(*)::int n FROM match_reviews WHERE status = 'open'`)).rows[0].n).toBe(0);
  });
});

describe('merge and concurrent imports', () => {
  it('a merge waits for an import holding the lock on one of the GTINs involved', async () => {
    const s1 = await createSupplier('alfa');
    const s2 = await createSupplier('beta');
    await importCsv({ supplierId: s1.id, rows: [row({ SKU: 'A1', EAN: EAN_A })] });
    await importCsv({ supplierId: s2.id, rows: [row({ SKU: 'B1', EAN: EAN_B })] });
    const pa = await productOf('A1');
    const pb = await productOf('B1');
    // An import of supplier B is between "who owns this GTIN?" and "attach the offer" (it holds the GTIN lock).
    const importTx = await pool.connect();
    try {
      await importTx.query('BEGIN');
      await importTx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gtin:0${EAN_B}`]);
      await expect(
        withTx(async (tx) => {
          await tx.query(`SET LOCAL lock_timeout = '300ms'`);
          return mergeProducts(tx, { targetId: pa, sourceId: pb, actor: admin, reason: 'Stesso articolo, confermato dal fornitore' });
        }),
      ).rejects.toThrow(/lock timeout|timeout/i);
      expect((await pool.query(`SELECT status FROM products WHERE id = $1`, [pb])).rows[0].status).toBe('active');
    } finally {
      await importTx.query('ROLLBACK');
      importTx.release();
    }
    // Once the import is done the merge goes through.
    await withTx((tx) => mergeProducts(tx, { targetId: pa, sourceId: pb, actor: admin, reason: 'Stesso articolo, confermato dal fornitore' }));
    expect(await productOf('B1')).toBe(pa);
  });
});
