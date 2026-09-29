// Canonical product data and grid summary, recomputed from offers with a deterministic precedence:
//   manual override  >  supplier.priority ASC  >  active offer first  >  newest source_as_of  >  oldest offer  >  offer id
// Overrides are never touched by imports. Called in the same transaction that changes offers.
import type { Db } from '../db/pool.ts';
import { summarizePrices, countAvailableSuppliers, type PriceInput } from './pricing.ts';
import { displayGtin } from '../lib/gtin.ts';
import type { StockStatus } from './stock.ts';

interface OfferRow {
  id: string;
  product_id: string;
  supplier_id: string;
  supplier_priority: number;
  supplier_sku: string;
  active: boolean;
  title: string | null;
  brand: string | null;
  category_id: string | null;
  category_raw: string | null;
  attributes: Record<string, string>;
  barcode_raw: string | null;
  gtin: string | null;
  price: string | null;
  currency: string | null;
  vat_treatment: 'net' | 'gross' | 'unknown';
  vat_rate: string | null;
  units_per_pack: number | null;
  moq: number | null;
  stock_status: StockStatus;
  stock_quantity: number | null;
  source_as_of: Date;
  created_at: Date;
}

export function precedenceSort<T extends { supplier_priority: number; active: boolean; source_as_of: Date; created_at: Date; id: string }>(offers: T[]): T[] {
  return [...offers].sort(
    (a, b) =>
      a.supplier_priority - b.supplier_priority ||
      Number(b.active) - Number(a.active) ||
      b.source_as_of.getTime() - a.source_as_of.getTime() ||
      a.created_at.getTime() - b.created_at.getTime() ||
      a.id.localeCompare(b.id),
  );
}

/** Recomputes canonical fields and summaries for the given products. Returns ids that changed status. */
export async function refreshProducts(db: Db, productIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(productIds)].sort();
  if (!ids.length) return;
  // Lock in a stable order (no-key lock: compatible with FK checks from concurrent offer writes).
  const products = (
    await db.query(
      `SELECT id, status, title_override, brand_override, category_override_id, primary_image_override_id
         FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
      [ids],
    )
  ).rows;
  if (!products.length) return;

  const offers: OfferRow[] = (
    await db.query(
      `SELECT o.id, o.product_id, o.supplier_id, s.priority AS supplier_priority, o.supplier_sku, o.active, o.title, o.brand,
              o.category_id, o.category_raw, o.attributes, o.barcode_raw, o.gtin, o.price::text, o.currency, o.vat_treatment,
              o.vat_rate::text, o.units_per_pack, o.moq, o.stock_status, o.stock_quantity, o.source_as_of, o.created_at
         FROM supplier_offers o JOIN suppliers s ON s.id = o.supplier_id
        WHERE o.product_id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  const images = (
    await db.query(
      `SELECT oi.offer_id, oi.position, src.image_asset_id AS asset_id
         FROM offer_images oi JOIN image_sources src ON src.id = oi.image_source_id
        WHERE oi.offer_id = ANY($1::uuid[]) AND src.status = 'fetched'
        ORDER BY oi.position`,
      [offers.map((o) => o.id)],
    )
  ).rows as Array<{ offer_id: string; position: number; asset_id: string }>;
  const identifiers = (
    await db.query(`SELECT product_id, value FROM product_identifiers WHERE kind = 'gtin' AND product_id = ANY($1::uuid[]) ORDER BY value`, [ids])
  ).rows as Array<{ product_id: string; value: string }>;

  const offersByProduct = groupBy(offers, (o) => o.product_id);
  const imagesByOffer = groupBy(images, (i) => i.offer_id);
  const gtinsByProduct = groupBy(identifiers, (i) => i.product_id);

  const rows: unknown[][] = [];
  for (const p of products) {
    if (p.status === 'merged') continue;
    const list = precedenceSort(offersByProduct.get(p.id) ?? []);
    const first = <K extends keyof OfferRow>(key: K) => list.find((o) => o[key] !== null && o[key] !== '' && o[key] !== undefined);
    const titleSrc = first('title');
    const brandSrc = first('brand');
    const categorySrc = first('category_id');

    const attributes: Record<string, string> = {};
    const attributeSources: Record<string, string> = {};
    for (const o of list) {
      for (const [k, v] of Object.entries(o.attributes ?? {})) {
        if (v && !(k in attributes)) {
          attributes[k] = v;
          attributeSources[k] = o.id;
        }
      }
    }

    const orderedAssets: string[] = [];
    for (const o of list) for (const img of imagesByOffer.get(o.id) ?? []) if (!orderedAssets.includes(img.asset_id)) orderedAssets.push(img.asset_id);
    const primaryImage = p.primary_image_override_id ?? orderedAssets[0] ?? null;

    const priceInputs: PriceInput[] = list.map((o) => ({
      offerId: o.id, supplierId: o.supplier_id, supplierPriority: o.supplier_priority, active: o.active, price: o.price,
      currency: o.currency, vatTreatment: o.vat_treatment, vatRate: o.vat_rate, unitsPerPack: o.units_per_pack, moq: o.moq,
      stockStatus: o.stock_status, stockQuantity: o.stock_quantity,
    }));
    const prices = summarizePrices(priceInputs);
    const active = list.filter((o) => o.active);
    const gtins = (gtinsByProduct.get(p.id) ?? []).map((g) => g.value);
    const offerGtins = list.map((o) => o.gtin).filter((g): g is string => !!g);
    const title = p.title_override ?? titleSrc?.title ?? '';
    const brand = p.brand_override ?? brandSrc?.brand ?? null;

    const searchParts = new Set<string>([title, brand ?? '']);
    for (const o of list) {
      if (o.title) searchParts.add(o.title);
      if (o.brand) searchParts.add(o.brand);
      searchParts.add(o.supplier_sku);
      if (o.barcode_raw) searchParts.add(o.barcode_raw);
      if (o.category_raw) searchParts.add(o.category_raw);
    }
    for (const g of [...gtins, ...offerGtins]) {
      searchParts.add(g);
      searchParts.add(displayGtin(g));
    }
    const searchText = [...searchParts].filter(Boolean).join(' ').slice(0, 8000);

    const status = list.length === 0 ? 'archived' : 'active';
    rows.push([
      p.id, status, title, brand, p.category_override_id ?? categorySrc?.category_id ?? null, primaryImage, JSON.stringify(attributes),
      JSON.stringify({
        title: p.title_override ? { manual: true } : titleSrc ? { offerId: titleSrc.id, supplierId: titleSrc.supplier_id } : null,
        brand: p.brand_override ? { manual: true } : brandSrc ? { offerId: brandSrc.id, supplierId: brandSrc.supplier_id } : null,
        category: p.category_override_id ? { manual: true } : categorySrc ? { offerId: categorySrc.id, supplierId: categorySrc.supplier_id } : null,
        image: p.primary_image_override_id ? { manual: true } : primaryImage ? { auto: true } : null,
        attributes: attributeSources,
      }),
      active.length,
      new Set(active.map((o) => o.supplier_id)).size,
      countAvailableSuppliers(list.map((o) => ({ active: o.active, supplierId: o.supplier_id, stockStatus: o.stock_status }))),
      JSON.stringify(prices),
      prices.best?.unitPrice ?? null,
      prices.best?.currency ?? null,
      gtins.length > 0,
      gtins[0] ?? offerGtins[0] ?? null,
      orderedAssets.length,
      list.length ? new Date(Math.max(...list.map((o) => o.source_as_of.getTime()))) : null,
      searchText,
    ]);
  }
  if (!rows.length) return;
  // One statement for the whole batch (column arrays via unnest) instead of one UPDATE per product.
  // Rows whose values are identical are not rewritten (a daily feed confirms most products unchanged:
  // rewriting them would regenerate the full-text and trigram index entries every time), and updated_at
  // moves only when the product content changes, not when a listino merely confirms freshness.
  const col = (i: number) => rows.map((r) => r[i]);
  const content = (t: string) =>
    `(${t}.status, ${t}.title, ${t}.brand, ${t}.category_id, ${t}.primary_image_id, ${t}.attributes, ${t}.canonical_sources, ${t}.offer_count,
      ${t}.supplier_count, ${t}.available_supplier_count, ${t}.best_price, ${t}.best_unit_price, ${t}.best_price_currency, ${t}.has_gtin,
      ${t}.primary_gtin, ${t}.image_count, ${t}.search_text)`;
  await db.query(
    `UPDATE products p SET
       status = x.status, title = x.title, brand = x.brand, category_id = x.category_id, primary_image_id = x.primary_image_id,
       attributes = x.attributes, canonical_sources = x.canonical_sources, offer_count = x.offer_count, supplier_count = x.supplier_count,
       available_supplier_count = x.available_supplier_count, best_price = x.best_price, best_unit_price = x.best_unit_price,
       best_price_currency = x.best_price_currency, has_gtin = x.has_gtin, primary_gtin = x.primary_gtin, image_count = x.image_count,
       data_as_of = x.data_as_of, search_text = x.search_text,
       updated_at = CASE WHEN ${content('p')} IS DISTINCT FROM ${content('x')} THEN now() ELSE p.updated_at END
     FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::uuid[], $6::uuid[], $7::jsonb[], $8::jsonb[], $9::int[], $10::int[], $11::int[],
                 $12::jsonb[], $13::numeric[], $14::text[], $15::bool[], $16::text[], $17::int[], $18::timestamptz[], $19::text[])
       AS x(id, status, title, brand, category_id, primary_image_id, attributes, canonical_sources, offer_count, supplier_count,
            available_supplier_count, best_price, best_unit_price, best_price_currency, has_gtin, primary_gtin, image_count, data_as_of, search_text)
     WHERE p.id = x.id AND (${content('p')} IS DISTINCT FROM ${content('x')} OR p.data_as_of IS DISTINCT FROM x.data_as_of)`,
    Array.from({ length: 19 }, (_, i) => col(i)),
  );
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}
