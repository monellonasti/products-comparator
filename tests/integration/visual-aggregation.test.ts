// Visual result aggregation with a real pgvector HNSW index (tiny synthetic vectors: this tests the
// retrieval mechanics, not model quality).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, vectorLiteral } from '../../src/db/pool.ts';
import { ensureModel } from '../../src/vision/index-admin.ts';
import type { ModelSpec } from '../../src/vision/models.ts';
import { aggregateByProduct, nearestImages } from '../../src/search/photo.ts';
import { createSupplier, importCsv, resetDatabase, row } from '../helpers.ts';

const spec: ModelSpec = {
  id: 'test-4d', label: 'test', repo: 'test/test', revision: '0000000000', dim: 4, license: 'n/a', licenseUrl: '', modelClass: 'clip',
  outputName: 'image_embeds', preprocess: 'pp1', thresholds: { possible: 0.9, similar: 0.5, calibrated: false },
};
let key: string;

async function asset(sha: string) {
  return (
    await pool.query(
      `INSERT INTO image_assets (sha256, width, height, format, bytes, thumb_key, display_key, infer_key) VALUES ($1, 10, 10, 'jpeg', 1, 't', 'd', 'i') RETURNING id`,
      [sha],
    )
  ).rows[0].id as string;
}
async function link(assetId: string, sku: string, n: number) {
  const offer = (await pool.query(`SELECT id, supplier_id FROM supplier_offers WHERE supplier_sku = $1`, [sku])).rows[0];
  const src = (
    await pool.query(`INSERT INTO image_sources (supplier_id, url, status, image_asset_id) VALUES ($1, $2, 'fetched', $3) RETURNING id`, [offer.supplier_id, `https://x/${sku}/${n}`, assetId])
  ).rows[0].id;
  await pool.query(`INSERT INTO offer_images (offer_id, image_source_id, position) VALUES ($1, $2, $3)`, [offer.id, src, n]);
}
async function embed(assetId: string, v: number[]) {
  await pool.query(`INSERT INTO image_embeddings (image_asset_id, model_key, status, embedding) VALUES ($1, $2, 'done', $3::vector)`, [assetId, key, vectorLiteral(v)]);
}

beforeAll(async () => {
  await resetDatabase();
  key = await ensureModel(pool, spec, { activateIfNoneActive: false });
  const s = await createSupplier('alfa');
  await importCsv({ supplierId: s.id, rows: [row({ SKU: 'MANY', EAN: '4006381333931' }), row({ SKU: 'V50', EAN: '5901234123457' }), row({ SKU: 'V100', EAN: '8710103917250' }), row({ SKU: 'OTHER' })] });
  // Product MANY has 5 near-identical photos; V50 and V100 share ONE generic photo (case D).
  for (let i = 0; i < 5; i++) {
    const a = await asset(`many${i}`);
    await link(a, 'MANY', i);
    await embed(a, [1, 0.01 * i, 0, 0]);
  }
  const shared = await asset('shared');
  await link(shared, 'V50', 0);
  await link(shared, 'V100', 0);
  await embed(shared, [0.9, 0.3, 0, 0]);
  const other = await asset('other');
  await link(other, 'OTHER', 0);
  await embed(other, [0, 0, 1, 0]);
});
afterAll(() => pool.end());

describe('photo result aggregation', () => {
  it('returns one entry per product: many photos of one product do not fill the shortlist', async () => {
    const hits = await nearestImages(key, 4, Float32Array.from([1, 0, 0, 0]));
    expect(hits.length).toBe(7);
    const byProduct = await aggregateByProduct(hits);
    expect(byProduct.size).toBe(4);
    const many = (await pool.query(`SELECT product_id FROM supplier_offers WHERE supplier_sku = 'MANY'`)).rows[0].product_id;
    expect(byProduct.get(many)!.count).toBe(5);
    const ranked = [...byProduct.entries()].sort((a, b) => b[1].score - a[1].score).map(([pid]) => pid);
    expect(ranked[0]).toBe(many);
  });

  it('case D: a photo shared by two variants proposes both and flags the shared image', async () => {
    const hits = await nearestImages(key, 4, Float32Array.from([0.9, 0.3, 0, 0]));
    const byProduct = await aggregateByProduct(hits);
    const v50 = (await pool.query(`SELECT product_id FROM supplier_offers WHERE supplier_sku = 'V50'`)).rows[0].product_id;
    const v100 = (await pool.query(`SELECT product_id FROM supplier_offers WHERE supplier_sku = 'V100'`)).rows[0].product_id;
    expect(v50).not.toBe(v100);
    expect(byProduct.get(v50)?.shared).toBe(true);
    expect(byProduct.get(v100)?.shared).toBe(true);
    expect(byProduct.get(v50)?.score).toBeCloseTo(byProduct.get(v100)!.score, 6);
  });

  it('images of inactive offers are not returned as results', async () => {
    await pool.query(`UPDATE supplier_offers SET active = false WHERE supplier_sku = 'OTHER'`);
    const hits = await nearestImages(key, 4, Float32Array.from([0, 0, 1, 0]));
    const byProduct = await aggregateByProduct(hits);
    const other = (await pool.query(`SELECT product_id FROM supplier_offers WHERE supplier_sku = 'OTHER'`)).rows[0].product_id;
    expect(byProduct.has(other)).toBe(false);
  });
});
