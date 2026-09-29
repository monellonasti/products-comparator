// Catalogue grid, text/EAN/SKU search, facets and the unified product sheet.
import { pool } from '../db/pool.ts';
import { parseBarcode, displayGtin } from '../lib/gtin.ts';
import { foldText } from '../lib/text.ts';
import { evaluatePrice, REASON_LABELS, type PriceSummary } from '../domain/pricing.ts';
import { getActiveModel } from '../vision/index-admin.ts';
import { listChanges } from './changes.ts';

export interface CatalogQuery {
  q?: string;
  supplierIds?: string[];
  brand?: string;
  categoryId?: string;
  priceMin?: number;
  priceMax?: number;
  availability?: 'available' | 'unavailable';
  gtin?: 'present' | 'absent';
  hasImage?: boolean;
  includeWithoutOffers?: boolean;
  sort?: 'relevance' | 'title' | 'updated' | 'price';
  offset?: number;
  limit?: number;
}

export const MAX_OFFSET = 10_000;

export interface ProductCard {
  id: string;
  title: string;
  brand: string | null;
  imageId: string | null;
  gtin: string | null;
  offerCount: number;
  supplierCount: number;
  availableSupplierCount: number;
  bestPrice: PriceSummary | null;
  imageCount: number;
  dataAsOf: string | null;
  stale: boolean;
  matchedBy?: 'gtin' | 'barcode_raw' | 'sku' | 'text';
}

function tsQuery(q: string): string | null {
  const tokens = foldText(q).split(' ').filter((t) => t.length >= 1).slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `${t}:*`).join(' & ');
}

export async function listProducts(query: CatalogQuery): Promise<{ items: ProductCard[]; total: number; offset: number; limit: number; mode: string }> {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [`p.status = 'active'`];
  if (!query.includeWithoutOffers) where.push('p.offer_count > 0');
  let rank = '0';
  let mode = 'browse';
  const q = query.q?.trim().slice(0, 200) ?? '';
  let matchedBy = `NULL`;

  if (q) {
    // Exact code lookups first (all indexed), then the product filter is a simple id list: no correlated
    // OR-subqueries that would force a sequential scan of products.
    const digits = q.replace(/[\s-]/g, '');
    const barcode = /^\d{6,14}$/.test(digits) ? parseBarcode(digits) : null;
    const ids = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows.map((r) => r.product_id as string);
    const skuIds = await ids(`SELECT DISTINCT product_id FROM supplier_offers WHERE lower(supplier_sku) = lower($1) LIMIT 1000`, [q]);
    const gtinIds = barcode?.gtin14
      ? await ids(`SELECT product_id FROM product_identifiers WHERE kind = 'gtin' AND value = $1 UNION SELECT product_id FROM supplier_offers WHERE gtin = $1`, [barcode.gtin14])
      : [];
    const rawIds = barcode ? await ids(`SELECT DISTINCT product_id FROM supplier_offers WHERE barcode_raw = $1 LIMIT 1000`, [digits]) : [];
    // Digits that match no code (a model number, a partial EAN) are searched as text instead of returning nothing.
    if (barcode && (gtinIds.length || rawIds.length || skuIds.length)) {
      mode = 'code';
      const g = p(gtinIds);
      const r = p(rawIds);
      const k = p(skuIds);
      where.push(`(p.id = ANY(${g}::uuid[]) OR p.id = ANY(${r}::uuid[]) OR p.id = ANY(${k}::uuid[]))`);
      matchedBy = `CASE WHEN p.id = ANY(${g}::uuid[]) THEN 'gtin' WHEN p.id = ANY(${r}::uuid[]) THEN 'barcode_raw' ELSE 'sku' END`;
      rank = `CASE WHEN p.id = ANY(${g}::uuid[]) THEN 3 WHEN p.id = ANY(${r}::uuid[]) THEN 2 ELSE 1 END`;
    } else {
      mode = 'text';
      const tsq = tsQuery(q);
      const k = p(skuIds);
      const folded = p(foldText(q));
      const tsParam = tsq ? p(tsq) : null;
      const tsCond = tsParam ? `p.search_tsv @@ to_tsquery('simple', ${tsParam})` : 'false';
      // "%>" (word similarity, indexed expression on the left) tolerates typos: "asciugacapeli" -> "asciugacapelli".
      where.push(`(p.id = ANY(${k}::uuid[]) OR ${tsCond} OR f_unaccent(lower(p.search_text)) %> ${folded})`);
      matchedBy = `CASE WHEN p.id = ANY(${k}::uuid[]) THEN 'sku' ELSE 'text' END`;
      rank = `(CASE WHEN p.id = ANY(${k}::uuid[]) THEN 10 ELSE 0 END) + ${tsParam ? `ts_rank(p.search_tsv, to_tsquery('simple', ${tsParam}))` : '0'}
              + word_similarity(${folded}, f_unaccent(lower(p.search_text)))`;
    }
  }
  if (query.supplierIds?.length) {
    where.push(`EXISTS (SELECT 1 FROM supplier_offers so WHERE so.product_id = p.id AND so.active AND so.supplier_id = ANY(${p(query.supplierIds)}::uuid[]))`);
  }
  if (query.brand) where.push(`lower(p.brand) = lower(${p(query.brand)})`);
  if (query.categoryId) where.push(`p.category_id = ${p(query.categoryId)}`);
  // The price filter is in euro (as the interface says): amounts in other currencies are not comparable.
  if (query.priceMin !== undefined) where.push(`p.best_unit_price >= ${p(query.priceMin)} AND p.best_price_currency = 'EUR'`);
  if (query.priceMax !== undefined) where.push(`p.best_unit_price <= ${p(query.priceMax)} AND p.best_price_currency = 'EUR'`);
  if (query.availability === 'available') where.push('p.available_supplier_count > 0');
  if (query.availability === 'unavailable') where.push('p.available_supplier_count = 0');
  if (query.gtin === 'present') where.push('p.has_gtin');
  if (query.gtin === 'absent') where.push('NOT p.has_gtin');
  if (query.hasImage === true) where.push('p.image_count > 0');
  if (query.hasImage === false) where.push('p.image_count = 0');

  const sort = query.sort ?? (q ? 'relevance' : 'title');
  const order =
    sort === 'relevance' && q
      ? `rank DESC, lower(p.title), p.id`
      : sort === 'updated'
        ? `p.updated_at DESC, p.id`
        : sort === 'price'
          ? `p.best_unit_price ASC NULLS LAST, lower(p.title), p.id`
          : `lower(p.title), p.id`;
  const limit = Math.min(Math.max(query.limit ?? 48, 1), 96);
  const offset = Math.min(Math.max(query.offset ?? 0, 0), MAX_OFFSET);
  const whereSql = where.join(' AND ');

  const [rows, total] = await Promise.all([
    pool.query(
      `SELECT p.id, p.title, p.brand, p.primary_image_id, p.primary_gtin, p.offer_count, p.supplier_count, p.available_supplier_count,
              p.best_price, p.image_count, p.data_as_of, ${rank} AS rank, ${matchedBy} AS matched_by,
              EXISTS (SELECT 1 FROM supplier_offers so JOIN suppliers s ON s.id = so.supplier_id
                       WHERE so.product_id = p.id AND so.active
                         AND (so.source_as_of < now() - make_interval(hours => s.stale_after_hours)
                              OR (s.last_import_status = 'failed' AND s.last_import_finished_at > so.source_as_of))) AS stale
         FROM products p WHERE ${whereSql}
        ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    pool.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM products p WHERE ${whereSql} LIMIT 10001) x`, params),
  ]);
  return {
    items: rows.rows.map(toCard),
    total: total.rows[0].n,
    offset,
    limit,
    mode,
  };
}

function toCard(r: any): ProductCard {
  return {
    id: r.id,
    title: r.title || '(senza titolo)',
    brand: r.brand,
    imageId: r.primary_image_id,
    gtin: r.primary_gtin ? displayGtin(r.primary_gtin) : null,
    offerCount: r.offer_count,
    supplierCount: r.supplier_count,
    availableSupplierCount: r.available_supplier_count,
    bestPrice: r.best_price,
    imageCount: r.image_count,
    dataAsOf: r.data_as_of?.toISOString() ?? null,
    stale: !!r.stale,
    matchedBy: r.matched_by ?? undefined,
  };
}

export async function productCards(ids: string[]): Promise<Map<string, ProductCard>> {
  if (!ids.length) return new Map();
  const rows = (
    await pool.query(
      `SELECT p.id, p.title, p.brand, p.primary_image_id, p.primary_gtin, p.offer_count, p.supplier_count, p.available_supplier_count,
              p.best_price, p.image_count, p.data_as_of, false AS stale
         FROM products p WHERE p.id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  return new Map(rows.map((r) => [r.id, toCard(r)]));
}

let facetCache: { at: number; value: unknown } | null = null;

export async function facets() {
  if (facetCache && Date.now() - facetCache.at < 60_000) return facetCache.value;
  const [suppliers, brands, categories] = await Promise.all([
    pool.query(
      `SELECT s.id, s.name, count(DISTINCT o.product_id)::int AS products
         FROM suppliers s LEFT JOIN supplier_offers o ON o.supplier_id = s.id AND o.active
        GROUP BY s.id ORDER BY s.name`,
    ),
    pool.query(
      `SELECT brand, count(*)::int AS products FROM products
        WHERE status = 'active' AND offer_count > 0 AND brand IS NOT NULL AND brand <> ''
        GROUP BY brand ORDER BY count(*) DESC, brand LIMIT 300`,
    ),
    pool.query(
      `SELECT c.id, c.name, count(p.id)::int AS products FROM categories c
         LEFT JOIN products p ON p.category_id = c.id AND p.status = 'active' AND p.offer_count > 0
        GROUP BY c.id ORDER BY c.name`,
    ),
  ]);
  const value = { suppliers: suppliers.rows, brands: brands.rows, categories: categories.rows };
  facetCache = { at: Date.now(), value };
  return value;
}

export function invalidateFacets() {
  facetCache = null;
}

export async function productDetail(id: string, opts: { isAdmin: boolean }) {
  const product = (
    await pool.query(
      `SELECT p.*, c.name AS category_name, co.name AS category_override_name
         FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories co ON co.id = p.category_override_id
        WHERE p.id = $1`,
      [id],
    )
  ).rows[0];
  if (!product) return null;
  if (product.status === 'merged') return { mergedInto: product.merged_into_id as string };

  const [identifiers, offers, images, reviews, history, activeModel] = await Promise.all([
    pool.query(
      `SELECT i.value, i.source, i.evidence, i.created_at, u.display_name AS created_by
         FROM product_identifiers i LEFT JOIN users u ON u.id = i.created_by WHERE i.product_id = $1 ORDER BY i.value`,
      [id],
    ),
    pool.query(
      `SELECT o.*, o.price::text AS price, o.vat_rate::text AS vat_rate, s.name AS supplier_name, s.code AS supplier_code, s.priority AS supplier_priority,
              s.stale_after_hours, s.last_import_status, s.last_import_finished_at, s.website AS supplier_website,
              (o.source_as_of < now() - make_interval(hours => s.stale_after_hours)) AS stale_by_age,
              (s.last_import_status = 'failed' AND s.last_import_finished_at > o.source_as_of) AS stale_by_failure,
              c.name AS category_name
         FROM supplier_offers o JOIN suppliers s ON s.id = o.supplier_id LEFT JOIN categories c ON c.id = o.category_id
        WHERE o.product_id = $1
        ORDER BY o.active DESC, s.priority, s.name, o.supplier_sku`,
      [id],
    ),
    pool.query(
      `SELECT DISTINCT ON (a.id) a.id, a.width, a.height, src.url, src.supplier_id, sp.name AS supplier_name, oi.position, s2.priority,
              (SELECT e.status FROM image_embeddings e JOIN embedding_models m ON m.key = e.model_key AND m.status = 'active' WHERE e.image_asset_id = a.id) AS index_status
         FROM supplier_offers o JOIN offer_images oi ON oi.offer_id = o.id JOIN image_sources src ON src.id = oi.image_source_id
         JOIN image_assets a ON a.id = src.image_asset_id JOIN suppliers sp ON sp.id = src.supplier_id JOIN suppliers s2 ON s2.id = o.supplier_id
        WHERE o.product_id = $1 AND src.status = 'fetched'
        ORDER BY a.id, s2.priority, oi.position`,
      [id],
    ),
    pool.query(
      `SELECT r.id, r.kind, r.status, r.reasons, r.product_id, r.candidate_product_id, r.created_at,
              CASE WHEN r.product_id = $1 THEN cp.title ELSE pp.title END AS other_title,
              CASE WHEN r.product_id = $1 THEN r.candidate_product_id ELSE r.product_id END AS other_id
         FROM match_reviews r JOIN products pp ON pp.id = r.product_id JOIN products cp ON cp.id = r.candidate_product_id
        WHERE r.status = 'open' AND (r.product_id = $1 OR r.candidate_product_id = $1)`,
      [id],
    ),
    pool.query(
      `SELECT e.id, e.at, e.action, e.reason, e.data, e.actor_kind, e.reverted_by_event_id, e.reverts_event_id, u.display_name AS actor_name
         FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE $1 = ANY(e.related_ids) ORDER BY e.at DESC LIMIT 50`,
      [id],
    ),
    getActiveModel(pool),
  ]);
  const recentChanges = await listChanges({ product: id, sinceHours: 24 * 90, offset: 0, limit: 30 }, 30, 0);
  const pendingSources = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE src.status = 'pending')::int AS pending, count(*) FILTER (WHERE src.status IN ('failed', 'blocked'))::int AS failed
         FROM supplier_offers o JOIN offer_images oi ON oi.offer_id = o.id JOIN image_sources src ON src.id = oi.image_source_id WHERE o.product_id = $1`,
      [id],
    )
  ).rows[0];

  const gallery = images.rows
    .sort((a, b) => (a.id === product.primary_image_id ? -1 : b.id === product.primary_image_id ? 1 : a.priority - b.priority || a.position - b.position))
    .map((img) => ({
      id: img.id, width: img.width, height: img.height, supplierId: img.supplier_id, supplierName: img.supplier_name,
      sourceUrl: opts.isAdmin ? img.url : undefined, searchable: img.index_status === 'done',
    }));

  return {
    product: {
      id: product.id,
      status: product.status,
      title: product.title || '(senza titolo)',
      brand: product.brand,
      categoryId: product.category_id,
      categoryName: product.category_name,
      attributes: product.attributes,
      canonicalSources: product.canonical_sources,
      overrides: {
        title: product.title_override, brand: product.brand_override, categoryId: product.category_override_id,
        categoryName: product.category_override_name, primaryImageId: product.primary_image_override_id,
      },
      bestPrice: product.best_price,
      dataAsOf: product.data_as_of,
      offerCount: product.offer_count,
      supplierCount: product.supplier_count,
      availableSupplierCount: product.available_supplier_count,
    },
    identifiers: identifiers.rows.map((i) => ({ ...i, display: displayGtin(i.value) })),
    offers: offers.rows.map((o) => {
      const ev = evaluatePrice({
        offerId: o.id, supplierId: o.supplier_id, supplierPriority: o.supplier_priority, active: o.active, price: o.price, currency: o.currency,
        vatTreatment: o.vat_treatment, vatRate: o.vat_rate, unitsPerPack: o.units_per_pack, moq: o.moq, stockStatus: o.stock_status, stockQuantity: o.stock_quantity,
      });
      return {
        id: o.id,
        supplier: { id: o.supplier_id, name: o.supplier_name, code: o.supplier_code },
        sku: o.supplier_sku,
        active: o.active,
        deactivatedAt: o.deactivated_at,
        linkSource: o.link_source,
        barcode: { raw: o.barcode_raw, status: o.barcode_status, format: o.barcode_format, issue: o.barcode_issue, gtin: o.gtin ? displayGtin(o.gtin) : null },
        title: o.title,
        brand: o.brand,
        description: o.description,
        categoryRaw: o.category_raw,
        categoryName: o.category_name,
        attributes: o.attributes,
        price: o.price,
        currency: o.currency,
        vatTreatment: o.vat_treatment,
        vatRate: o.vat_rate,
        salesUnit: o.sales_unit,
        unitsPerPack: o.units_per_pack,
        moq: o.moq,
        priceTiers: o.price_tiers,
        netPackPrice: ev.netPackPrice,
        netUnitPrice: ev.netUnitPrice,
        netDerivedFromGross: ev.netDerivedFromGross,
        comparable: ev.comparable,
        notComparableReasons: ev.reasons.map((r) => REASON_LABELS[r]),
        stockQuantity: o.stock_quantity,
        stockStatus: o.stock_status,
        availabilityRaw: o.availability_raw,
        leadTimeDays: o.lead_time_days,
        leadTimeRaw: o.lead_time_raw,
        productUrl: o.product_url,
        dataAsOf: o.source_as_of,
        lastSeenAt: o.last_seen_at,
        stale: !!(o.stale_by_age || o.stale_by_failure),
        staleReason: o.stale_by_failure ? 'Ultimo aggiornamento del listino fallito' : o.stale_by_age ? `Dato più vecchio di ${o.stale_after_hours} ore` : null,
        lastImportId: o.last_import_id,
        sourceRow: opts.isAdmin ? o.source_row : undefined,
      };
    }),
    gallery,
    images: { pending: pendingSources.pending, failed: pendingSources.failed, activeModel: activeModel?.key ?? null },
    reviews: reviews.rows,
    history: history.rows,
    recentChanges,
  };
}
