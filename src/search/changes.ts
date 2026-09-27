// Change report queries: price / availability / quantity / image / listing changes recorded by imports and feeds.
import { z } from 'zod';
import { pool } from '../db/pool.ts';
import { CHANGE_LABELS, type ChangeType } from '../domain/changes.ts';
import { displayGtin } from '../lib/gtin.ts';
import { STOCK_TEXT } from '../domain/stock.ts';

const TYPES = Object.keys(CHANGE_LABELS) as ChangeType[];

export const changeQuerySchema = z.object({
  supplier: z.guid().optional(),
  types: z.string().max(200).optional(),
  sinceHours: z.coerce.number().int().min(1).max(24 * 400).default(24 * 7),
  run: z.guid().optional(),
  product: z.guid().optional(),
  minPct: z.coerce.number().min(0).max(1000).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ChangeQuery = z.infer<typeof changeQuerySchema>;

export function buildChangeWhere(q: ChangeQuery, opts: { withTypes: boolean }) {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (q.run) where.push(`c.import_run_id = ${p(q.run)}`);
  else where.push(`c.created_at > now() - make_interval(hours => ${p(q.sinceHours)})`);
  if (q.supplier) where.push(`c.supplier_id = ${p(q.supplier)}`);
  if (q.product) where.push(`o.product_id = ${p(q.product)}`);
  const types = (q.types ?? '').split(',').filter((t): t is ChangeType => (TYPES as string[]).includes(t));
  if (opts.withTypes && types.length) where.push(`c.change_type = ANY(${p(types)}::text[])`);
  if (q.minPct !== undefined) where.push(`(c.change_type <> 'price' OR abs(c.pct) >= ${p(q.minPct)})`);
  return { sql: where.join(' AND '), params };
}

export async function listChanges(q: ChangeQuery, limit: number, offset: number) {
  const w = buildChangeWhere(q, { withTypes: true });
  return (
    await pool.query(
      `SELECT c.id, c.created_at, c.change_type, c.old_value, c.new_value, c.pct::text AS pct, c.import_run_id,
              s.id AS supplier_id, s.name AS supplier_name, o.supplier_sku, o.title AS offer_title,
              p.id AS product_id, p.title AS product_title, p.primary_image_id, p.primary_gtin, r.source_kind
         FROM offer_changes c
         JOIN suppliers s ON s.id = c.supplier_id
         JOIN supplier_offers o ON o.id = c.offer_id
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN import_runs r ON r.id = c.import_run_id
        WHERE ${w.sql}
        ORDER BY c.created_at DESC, c.id DESC LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`,
      w.params,
    )
  ).rows.map((r) => ({
    id: Number(r.id),
    at: r.created_at,
    type: r.change_type as ChangeType,
    typeLabel: CHANGE_LABELS[r.change_type as ChangeType],
    oldValue: r.old_value,
    newValue: r.new_value,
    pct: r.pct as string | null,
    importRunId: r.import_run_id,
    source: r.source_kind as 'upload' | 'feed' | null,
    supplier: { id: r.supplier_id, name: r.supplier_name },
    sku: r.supplier_sku,
    offerTitle: r.offer_title,
    product: r.product_id
      ? { id: r.product_id, title: r.product_title, imageId: r.primary_image_id, gtin: r.primary_gtin ? displayGtin(r.primary_gtin) : null }
      : null,
  }));
}

/** Plain-language "before" / "after" used by the CSV export (the UI formats its own). */
export function describeChange(type: ChangeType, oldV: any, newV: any): [string, string] {
  const price = (v: any) =>
    v?.price ? `${v.price} ${v.currency ?? ''}${v.unitsPerPack && v.unitsPerPack > 1 ? ` per ${v.unitsPerPack} pz` : ''}${v.vat ? ` (IVA ${v.vat})` : ''}` : 'nessun prezzo';
  const stock = (v: any) =>
    `${STOCK_TEXT[v?.status as keyof typeof STOCK_TEXT] ?? v?.status ?? ''}${v?.quantity !== null && v?.quantity !== undefined ? ` (${v.quantity})` : ''}`;
  switch (type) {
    case 'price':
      return [price(oldV), price(newV)];
    case 'availability':
      return [stock(oldV), stock(newV)];
    case 'stock':
      return [String(oldV?.quantity ?? 'n/d'), String(newV?.quantity ?? 'n/d')];
    case 'images':
      return [
        `${oldV?.count ?? 0} immagini${oldV?.removed?.length ? `; rimosse: ${oldV.removed.join(' ')}` : ''}`,
        `${newV?.count ?? 0} immagini${newV?.added?.length ? `; aggiunte: ${newV.added.join(' ')}` : ''}`,
      ];
    case 'image_replaced': {
      const urls = (v: any) => (v?.images ?? []).map((i: any) => i.url).join(' ');
      return [`contenuto precedente: ${urls(oldV)}`, `nuovo contenuto allo stesso indirizzo: ${urls(newV)}`];
    }
    case 'new_offer':
      return ['', price(newV)];
    case 'removed':
      return [price(oldV), 'non più a listino'];
    case 'reactivated':
      return ['non a listino', price(newV)];
    case 'barcode':
      return [oldV?.gtin ? displayGtin(oldV.gtin) : 'assente', newV?.gtin ? displayGtin(newV.gtin) : 'assente'];
  }
}

