// Duplicate suggestions for products WITHOUT a usable GTIN. They only open a review; nothing is merged.
// Evidence: title trigram similarity (+ same brand when both known) and byte-identical images.
// An identical image is reported as a hint only: generic photos are reused across variants.
import type { Tx } from '../db/pool.ts';
import { openReview } from '../imports/apply.ts';
import { brandsConflict } from './identity.ts';

export const TITLE_SIMILARITY_MIN = 0.6;

export async function suggestForProducts(tx: Tx, productIds: string[], importRunId: string | null): Promise<number> {
  let opened = 0;
  for (const pid of productIds) {
    const p = (await tx.query(`SELECT id, title, brand, has_gtin, status FROM products WHERE id = $1`, [pid])).rows[0];
    if (!p || p.status !== 'active' || p.has_gtin || !p.title || p.title.length < 4) continue;
    const candidates = (
      await tx.query(
        `SELECT c.id, c.title, c.brand, similarity(f_unaccent(lower(c.title)), f_unaccent(lower($1))) AS sim
           FROM products c
          WHERE c.status = 'active' AND c.id <> $2
            AND f_unaccent(lower(c.search_text)) % f_unaccent(lower($1))
            AND NOT EXISTS (SELECT 1 FROM product_distinct_pairs d WHERE d.product_a = least(c.id, $2::uuid) AND d.product_b = greatest(c.id, $2::uuid))
          ORDER BY sim DESC LIMIT 5`,
        [p.title, pid],
      )
    ).rows;
    const sameImage = (
      await tx.query(
        `SELECT DISTINCT o2.product_id AS id
           FROM supplier_offers o1 JOIN offer_images i1 ON i1.offer_id = o1.id JOIN image_sources s1 ON s1.id = i1.image_source_id
           JOIN image_sources s2 ON s2.image_asset_id = s1.image_asset_id JOIN offer_images i2 ON i2.image_source_id = s2.id
           JOIN supplier_offers o2 ON o2.id = i2.offer_id
          WHERE o1.product_id = $1 AND o2.product_id <> $1 AND s1.image_asset_id IS NOT NULL LIMIT 5`,
        [pid],
      )
    ).rows.map((r) => r.id as string);
    for (const c of candidates) {
      if (Number(c.sim) < TITLE_SIMILARITY_MIN || brandsConflict(p.brand, c.brand)) continue;
      const reasons = [{ code: 'title_similarity', message: `Titoli simili (${Math.round(Number(c.sim) * 100)}% di trigrammi in comune)` }];
      if (p.brand && c.brand) reasons.push({ code: 'same_brand', message: `Stessa marca: ${c.brand}` });
      if (sameImage.includes(c.id)) reasons.push({ code: 'same_image', message: 'Stessa immagine (indizio debole: foto generiche possono coprire varianti diverse)' });
      if (await openReview(tx, { kind: 'suggested_duplicate', productId: pid, candidateProductId: c.id, score: Number(c.sim), reasons, importRunId })) opened++;
    }
  }
  return opened;
}
