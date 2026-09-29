import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../../db/pool.ts';
import { HttpError, requireRole, requireUser } from '../auth.ts';
import { resolveReview } from '../../domain/associations.ts';
import { productCards } from '../../search/catalog.ts';
import { invalidateFacets } from '../../search/catalog.ts';
import { displayGtin } from '../../lib/gtin.ts';

const KIND_LABELS: Record<string, string> = {
  gtin_conflict: 'Stesso EAN, dati in conflitto',
  suggested_duplicate: 'Possibile doppione (senza EAN valido)',
  gtin_changed: 'EAN cambiato dopo un’associazione manuale',
};

async function productSide(id: string) {
  const p = (await pool.query(`SELECT id, title, brand, attributes, status, primary_image_id FROM products WHERE id = $1`, [id])).rows[0];
  const offers = (
    await pool.query(
      `SELECT o.id, o.supplier_sku, o.title, o.brand, o.attributes, o.barcode_raw, o.barcode_status, o.gtin, o.price::text, o.currency,
              o.units_per_pack, o.link_source, s.name AS supplier_name
         FROM supplier_offers o JOIN suppliers s ON s.id = o.supplier_id WHERE o.product_id = $1 ORDER BY s.priority, s.name`,
      [id],
    )
  ).rows.map((o) => ({ ...o, gtin: o.gtin ? displayGtin(o.gtin) : null }));
  const identifiers = (await pool.query(`SELECT value FROM product_identifiers WHERE product_id = $1`, [id])).rows.map((r) => displayGtin(r.value));
  return { ...p, offers, identifiers };
}

const PAGE_SIZE = 50;

export async function reviewRoutes(app: FastifyInstance) {
  app.get('/reviews', async (request) => {
    requireUser(request);
    const q = z
      .object({ status: z.enum(['open', 'resolved', 'dismissed']).default('open'), kind: z.string().max(40).optional(), offset: z.coerce.number().int().min(0).default(0) })
      .parse(request.query);
    const params: unknown[] = [q.status];
    let where = 'r.status = $1';
    if (q.kind) {
      params.push(q.kind);
      where += ` AND r.kind = $${params.length}`;
    }
    const rows = (
      await pool.query(
        `SELECT r.id, r.kind, r.status, r.score, r.reasons, r.gtin, r.created_at, r.resolved_at, r.resolution, r.resolution_note, r.audit_event_id,
                r.product_id, r.candidate_product_id, u.display_name AS resolved_by
           FROM match_reviews r LEFT JOIN users u ON u.id = r.resolved_by
          WHERE ${where} ORDER BY r.created_at DESC, r.id LIMIT ${PAGE_SIZE + 1} OFFSET ${q.offset}`,
        params,
      )
    ).rows;
    const hasMore = rows.length > PAGE_SIZE;
    rows.length = Math.min(rows.length, PAGE_SIZE);
    const cards = await productCards(rows.flatMap((r) => [r.product_id, r.candidate_product_id]));
    const counts = (await pool.query(`SELECT kind, count(*)::int AS n FROM match_reviews WHERE status = 'open' GROUP BY kind`)).rows;
    return {
      items: rows.map((r) => ({ ...r, kindLabel: KIND_LABELS[r.kind], gtin: r.gtin ? displayGtin(r.gtin) : null, product: cards.get(r.product_id), candidate: cards.get(r.candidate_product_id) })),
      openCounts: Object.fromEntries(counts.map((c) => [c.kind, c.n])),
      offset: q.offset,
      limit: PAGE_SIZE,
      hasMore,
    };
  });

  app.get('/reviews/:id', async (request) => {
    requireUser(request);
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const r = (await pool.query(`SELECT * FROM match_reviews WHERE id = $1`, [id])).rows[0];
    if (!r) throw new HttpError(404, 'Revisione non trovata');
    const [product, candidate] = await Promise.all([productSide(r.product_id), productSide(r.candidate_product_id)]);
    return { review: { ...r, kindLabel: KIND_LABELS[r.kind], gtin: r.gtin ? displayGtin(r.gtin) : null }, product, candidate };
  });

  app.post('/reviews/:id/resolve', async (request) => {
    const user = requireRole(request, 'admin');
    const { id } = z.object({ id: z.guid() }).parse(request.params);
    const b = z.object({ action: z.enum(['merge', 'keep_separate', 'dismiss']), note: z.string().max(2000).optional() }).parse(request.body);
    const result = await withTx((tx) => resolveReview(tx, id, b.action, { kind: 'user', userId: user.id }, b.note ?? null));
    invalidateFacets();
    return result;
  });
}
