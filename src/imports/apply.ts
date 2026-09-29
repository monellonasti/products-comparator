// Applies a batch of staged rows to offers/products inside ONE transaction (the caller commits the
// checkpoint in the same transaction). Upsert key: (supplier_id, supplier_sku). See docs/IMPORTS.md.
import type { Tx } from '../db/pool.ts';
import { sha256 } from '../lib/hash.ts';
import { normalizeRow, offerFingerprint, type NormalizedOffer, type NormalizedRow, type RowIssue } from './normalize.ts';
import type { ColumnMapping, ImportDefaults } from './fields.ts';
import type { ParsedRow } from './parsers.ts';
import { detectIdentityConflicts, type IdentityConflict, type IdentityData } from '../domain/identity.ts';
import { refreshProducts } from '../domain/canonical.ts';
import { recordAudit } from '../domain/audit.ts';
import { enqueueImageFetch } from '../jobs/queue.ts';
import { countByType, diffOffer, insertChanges, type ChangeRecord, type OfferCommercialState } from '../domain/changes.ts';

export interface ApplyContext {
  runId: string;
  supplierId: string;
  asOf: Date;
  mapping: ColumnMapping;
  defaults: ImportDefaults;
  decimalSeparator: '.' | ',';
  /** Record "new offer" changes: false on a supplier's first import (everything would be new). */
  recordNewOffers?: boolean;
}

export type Counters = Record<string, number>;

export interface BatchResult {
  counters: Counters;
  issues: Array<RowIssue & { rowNumber: number }>;
  touchedProducts: Set<string>;
}

interface ExistingOffer {
  id: string;
  product_id: string;
  link_source: 'gtin' | 'standalone' | 'manual' | 'conflict_hold';
  gtin: string | null;
  active: boolean;
  row_hash: string;
  source_as_of: Date;
  last_import_id: string | null;
  last_row_number: number | null;
  price: string | null;
  currency: string | null;
  vat_treatment: string;
  vat_rate: string | null;
  units_per_pack: number | null;
  stock_quantity: number | null;
  stock_status: OfferCommercialState['stockStatus'];
  image_urls: string[];
}

const commercial = (o: ExistingOffer): OfferCommercialState => ({
  price: o.price, currency: o.currency, vatTreatment: o.vat_treatment, vatRate: o.vat_rate, unitsPerPack: o.units_per_pack,
  stockQuantity: o.stock_quantity, stockStatus: o.stock_status, imageUrls: o.image_urls ?? [], gtin: o.gtin,
});
const commercialOf = (o: NormalizedOffer): OfferCommercialState => ({
  price: o.price, currency: o.currency, vatTreatment: o.vatTreatment, vatRate: o.vatRate, unitsPerPack: o.unitsPerPack,
  stockQuantity: o.stockQuantity, stockStatus: o.stockStatus, imageUrls: o.imageUrls, gtin: o.barcode.gtin14,
});

const inc = (c: Counters, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};

export async function applyBatch(tx: Tx, ctx: ApplyContext, rows: ParsedRow[]): Promise<BatchResult> {
  const counters: Counters = {};
  const issues: BatchResult['issues'] = [];
  const touched = new Set<string>();
  const normalized: NormalizedRow[] = rows.map((r) => normalizeRow(r, ctx.mapping, ctx.defaults, ctx.decimalSeparator));

  // 1) Serialise concurrent imports on the same GTINs (sorted to avoid lock-order deadlocks).
  const gtins = [...new Set(normalized.flatMap((n) => (n.offer?.barcode.status === 'valid' ? [n.offer.barcode.gtin14!] : [])))].sort();
  for (const g of gtins) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gtin:${g}`]);

  // 2) Preload existing offers (locked) and GTIN owners.
  const skus = [...new Set(normalized.map((n) => n.sku).filter((s): s is string => !!s))];
  const existing = new Map<string, ExistingOffer>(
    (
      await tx.query(
        `SELECT id, supplier_sku, product_id, link_source, gtin, active, row_hash, source_as_of, last_import_id, last_row_number,
                price::text AS price, currency, vat_treatment, vat_rate::text AS vat_rate, units_per_pack, stock_quantity, stock_status, image_urls
           FROM supplier_offers WHERE supplier_id = $1 AND supplier_sku = ANY($2::text[]) ORDER BY id FOR UPDATE`,
        [ctx.supplierId, skus],
      )
    ).rows.map((r) => [r.supplier_sku, r]),
  );
  const gtinOwner = new Map<string, string>(
    (await tx.query(`SELECT value, product_id FROM product_identifiers WHERE kind = 'gtin' AND value = ANY($1::text[])`, [gtins])).rows.map((r) => [
      r.value,
      r.product_id,
    ]),
  );
  const identityCache = new Map<string, IdentityData>();
  const categoryMap = await loadCategoryMap(tx, ctx.supplierId);
  const seenOnly: Array<{ id: string; rowNumber: number; confirm: boolean }> = [];
  const changes: ChangeRecord[] = [];
  const compareImages = !!ctx.mapping.fields.image_urls?.length;
  const markSeen = (ex: ExistingOffer, rowNumber: number, confirm: boolean) => {
    seenOnly.push({ id: ex.id, rowNumber, confirm });
    ex.last_import_id = ctx.runId; // later duplicates of this SKU in the same run are detected
    ex.last_row_number = rowNumber;
  };

  for (const n of normalized) {
    inc(counters, 'rows_processed');
    for (const issue of n.issues) issues.push({ ...issue, rowNumber: n.rowNumber });
    if (n.issues.some((i) => i.severity === 'warning')) inc(counters, 'rows_with_warnings');
    if (!n.sku) {
      inc(counters, 'rows_error');
      continue;
    }
    inc(counters, 'rows_with_sku');
    const ex = existing.get(n.sku);

    if (ex && ex.last_import_id === ctx.runId && ex.last_row_number !== null && ex.last_row_number !== n.rowNumber) {
      issues.push({
        rowNumber: n.rowNumber, severity: 'error', field: 'sku', code: 'duplicate_sku',
        message: `SKU ripetuto nel file (già applicato alla riga ${ex.last_row_number}): riga ignorata`, value: n.sku,
      });
      inc(counters, 'rows_error');
      continue;
    }
    if (!n.offer) {
      // Row with errors: previous data is kept; the SKU still counts as present for snapshots.
      inc(counters, 'rows_error');
      if (ex) markSeen(ex, n.rowNumber, false);
      continue;
    }
    if (ex && ex.source_as_of.getTime() > ctx.asOf.getTime()) {
      issues.push({
        rowNumber: n.rowNumber, severity: 'warning', field: null, code: 'outdated_row',
        message: 'Dati più vecchi di quelli già presenti (import fuori ordine): riga non applicata', value: n.sku,
      });
      inc(counters, 'offers_skipped_outdated');
      markSeen(ex, n.rowNumber, false);
      continue;
    }
    const offer = n.offer;
    const rowHash = sha256(offerFingerprint(offer));
    if (ex && ex.active && ex.row_hash === rowHash) {
      inc(counters, 'offers_unchanged');
      markSeen(ex, n.rowNumber, true);
      continue;
    }

    // 3) Resolve the product this offer belongs to.
    let productId: string | null = null;
    let linkSource: ExistingOffer['link_source'] = 'standalone';
    let conflicts: IdentityConflict[] = [];
    let conflictCandidate: string | null = null;
    const newGtin = offer.barcode.gtin14;
    const gtinChanged = !!ex && (ex.gtin ?? null) !== (newGtin ?? null);
    if (ex && !gtinChanged) {
      productId = ex.product_id;
      linkSource = ex.link_source;
    } else if (offer.barcode.status === 'valid') {
      const owner = gtinOwner.get(newGtin!);
      if (!owner) {
        productId = await createProductForGtin(tx, newGtin!, gtinOwner);
        inc(counters, 'products_created');
        identityCache.set(productId, { brand: offer.brand, attributes: offer.attributes });
        linkSource = 'gtin';
      } else {
        const identity = identityCache.get(owner) ?? (await loadIdentity(tx, owner));
        identityCache.set(owner, identity);
        conflicts = detectIdentityConflicts({ brand: offer.brand, attributes: offer.attributes }, identity);
        if (conflicts.length) {
          productId = await createStandaloneProduct(tx);
          inc(counters, 'products_created');
          linkSource = 'conflict_hold';
          conflictCandidate = owner;
        } else {
          productId = owner;
          linkSource = 'gtin';
        }
      }
    } else {
      // No usable GTIN (missing/invalid/restricted): distinct product, suggestions only. Two NULLs never match.
      productId = await createStandaloneProduct(tx);
      inc(counters, 'products_created');
      linkSource = 'standalone';
    }

    const categoryId = await resolveCategory(tx, ctx.supplierId, offer.categoryRaw, categoryMap);
    const sourceRow = rows.find((r) => r.rowNumber === n.rowNumber)!.values;
    let offerId: string;
    if (ex) {
      await tx.query(
        `UPDATE supplier_offers SET ${OFFER_SET_SQL}, product_id = $32, link_source = $33, active = true,
                deactivated_at = NULL, deactivated_reason = NULL, updated_at = now()
          WHERE id = $34`,
        [...offerValues(ctx, offer, rowHash, sourceRow, n.rowNumber, categoryId), productId, linkSource, ex.id],
      );
      offerId = ex.id;
      inc(counters, 'offers_updated');
      touched.add(ex.product_id);
      changes.push(...diffOffer(ex.id, productId, commercial(ex), commercialOf(offer), { compareImages }));
      if (!ex.active) {
        changes.push({ offerId: ex.id, productId, type: 'reactivated', oldValue: null, newValue: { price: offer.price, currency: offer.currency, stockStatus: offer.stockStatus }, pct: null });
        inc(counters, 'offers_reactivated');
        await recordAudit(tx, {
          actor: { kind: 'import' }, action: 'offer.reactivated', entityType: 'offer', entityId: ex.id,
          relatedIds: [productId], data: { importRunId: ctx.runId },
        });
      }
      if (productId !== ex.product_id) {
        inc(counters, 'offers_relinked');
        await recordAudit(tx, {
          actor: { kind: 'import' }, action: 'offer.relinked', entityType: 'offer', entityId: ex.id,
          relatedIds: [ex.product_id, productId],
          reason: 'GTIN cambiato nel listino del fornitore',
          data: { importRunId: ctx.runId, fromProductId: ex.product_id, toProductId: productId, oldGtin: ex.gtin, newGtin, previousLinkSource: ex.link_source },
        });
        if (ex.link_source === 'manual') {
          await openReview(tx, {
            kind: 'gtin_changed', productId, candidateProductId: ex.product_id, offerId: ex.id, gtin: newGtin, importRunId: ctx.runId,
            reasons: [{ code: 'gtin_changed', message: `Il fornitore ha cambiato l'EAN da ${ex.gtin ?? 'assente'} a ${newGtin ?? 'assente'}: associazione manuale precedente superata` }],
          });
        }
      }
    } else {
      const res = await tx.query(
        `INSERT INTO supplier_offers (supplier_id, supplier_sku, product_id, link_source, barcode_raw, barcode_status, barcode_format,
            barcode_issue, gtin, title, brand, description, category_raw, category_id, attributes, price, currency, vat_treatment, vat_rate,
            sales_unit, units_per_pack, moq, price_tiers, stock_quantity, stock_status, availability_raw, lead_time_days, lead_time_raw,
            product_url, image_urls, row_hash, source_row, source_as_of, first_import_id, last_import_id, last_row_number, last_seen_at)
         VALUES ($34, $35, $32, $33, ${OFFER_VALUES_SELECT})
         RETURNING id`,
        [...offerValues(ctx, offer, rowHash, sourceRow, n.rowNumber, categoryId), productId, linkSource, ctx.supplierId, offer.sku],
      );
      offerId = res.rows[0].id;
      inc(counters, 'offers_created');
      if (ctx.recordNewOffers) {
        changes.push({
          offerId, productId, type: 'new_offer', oldValue: null,
          newValue: { price: offer.price, currency: offer.currency, unitsPerPack: offer.unitsPerPack, stockStatus: offer.stockStatus, stockQuantity: offer.stockQuantity },
          pct: null,
        });
      }
    }
    touched.add(productId);
    existing.set(offer.sku, {
      id: offerId, product_id: productId, link_source: linkSource, gtin: newGtin, active: true, row_hash: rowHash,
      source_as_of: ctx.asOf, last_import_id: ctx.runId, last_row_number: n.rowNumber,
      price: offer.price, currency: offer.currency, vat_treatment: offer.vatTreatment, vat_rate: offer.vatRate, units_per_pack: offer.unitsPerPack,
      stock_quantity: offer.stockQuantity, stock_status: offer.stockStatus, image_urls: offer.imageUrls,
    });

    if (conflicts.length && conflictCandidate) {
      const opened = await openReview(tx, {
        kind: 'gtin_conflict', productId, candidateProductId: conflictCandidate, offerId, gtin: newGtin, importRunId: ctx.runId,
        reasons: conflicts.map((c) => ({ code: c.code, field: c.field, message: c.message, offerValue: c.offerValue, productValue: c.productValue })),
      });
      if (opened) inc(counters, 'conflicts_opened');
      issues.push({
        rowNumber: n.rowNumber, severity: 'warning', field: 'barcode', code: 'gtin_conflict',
        message: `EAN già presente con dati incompatibili (${conflicts.map((c) => c.message).join('; ')}): associazione in revisione`,
        value: offer.barcode.raw,
      });
    }

    if (ctx.mapping.fields.image_urls?.length) {
      inc(counters, 'images_new', await syncOfferImages(tx, ctx.supplierId, offerId, offer.imageUrls));
    }
  }

  // Bulk "seen" updates: unchanged rows confirm freshness; error/outdated rows only mark presence.
  const confirm = seenOnly.filter((s) => s.confirm);
  const presence = seenOnly.filter((s) => !s.confirm);
  if (confirm.length) {
    await tx.query(
      `UPDATE supplier_offers o SET last_import_id = $1, last_row_number = x.rn, last_seen_at = now(),
              source_as_of = GREATEST(o.source_as_of, $2::timestamptz)
         FROM unnest($3::uuid[], $4::int[]) AS x(id, rn) WHERE o.id = x.id`,
      [ctx.runId, ctx.asOf, confirm.map((s) => s.id), confirm.map((s) => s.rowNumber)],
    );
    const res = await tx.query(`SELECT DISTINCT product_id FROM supplier_offers WHERE id = ANY($1::uuid[])`, [confirm.map((s) => s.id)]);
    res.rows.forEach((r) => touched.add(r.product_id));
  }
  if (presence.length) {
    await tx.query(
      `UPDATE supplier_offers o SET last_import_id = $1, last_row_number = x.rn, last_seen_at = now()
         FROM unnest($2::uuid[], $3::int[]) AS x(id, rn) WHERE o.id = x.id`,
      [ctx.runId, presence.map((s) => s.id), presence.map((s) => s.rowNumber)],
    );
  }

  if (changes.length) {
    await insertChanges(tx, ctx.runId, ctx.supplierId, changes);
    for (const [k, v] of Object.entries(countByType(changes))) inc(counters, k, v);
  }
  await refreshProducts(tx, touched);
  return { counters, issues, touchedProducts: touched };
}

// Parameters: $1..$29 offer columns, $30 import run id, $31 row number (offerValues), then $32 product id,
// $33 link source, and $34 offer id (UPDATE) or $34 supplier id + $35 sku (INSERT).
const OFFER_COLUMNS = [
  'barcode_raw', 'barcode_status', 'barcode_format', 'barcode_issue', 'gtin', 'title', 'brand', 'description', 'category_raw', 'category_id',
  'attributes', 'price', 'currency', 'vat_treatment', 'vat_rate', 'sales_unit', 'units_per_pack', 'moq', 'price_tiers', 'stock_quantity',
  'stock_status', 'availability_raw', 'lead_time_days', 'lead_time_raw', 'product_url', 'image_urls', 'row_hash', 'source_row', 'source_as_of',
];
const CASTS: Record<string, string> = {
  category_id: 'uuid', attributes: 'jsonb', price: 'numeric', vat_rate: 'numeric', units_per_pack: 'int', moq: 'int', price_tiers: 'jsonb',
  stock_quantity: 'int', lead_time_days: 'int', image_urls: 'text[]', source_row: 'jsonb', source_as_of: 'timestamptz',
};
const OFFER_SET_SQL =
  OFFER_COLUMNS.map((c, i) => `${c} = $${i + 1}${CASTS[c] ? `::${CASTS[c]}` : ''}`).join(', ') +
  `, last_import_id = $${OFFER_COLUMNS.length + 1}::uuid, last_row_number = $${OFFER_COLUMNS.length + 2}::int, last_seen_at = now()`;
// INSERT order after (supplier_id, supplier_sku, product_id, link_source): the 29 columns, first/last import, row number, last_seen.
const OFFER_VALUES_SELECT =
  OFFER_COLUMNS.map((c, i) => `$${i + 1}${CASTS[c] ? `::${CASTS[c]}` : ''}`).join(', ') +
  `, $${OFFER_COLUMNS.length + 1}::uuid, $${OFFER_COLUMNS.length + 1}::uuid, $${OFFER_COLUMNS.length + 2}::int, now()`;

function offerValues(ctx: ApplyContext, o: NormalizedOffer, rowHash: string, sourceRow: unknown, rowNumber: number, categoryId: string | null): unknown[] {
  return [
    o.barcode.raw?.trim() || null, o.barcode.status, o.barcode.format, o.barcode.issue, o.barcode.gtin14, o.title, o.brand, o.description,
    o.categoryRaw, categoryId, JSON.stringify(o.attributes), o.price, o.currency, o.vatTreatment, o.vatRate, o.salesUnit, o.unitsPerPack,
    o.moq, o.priceTiers ? JSON.stringify(o.priceTiers) : null, o.stockQuantity, o.stockStatus, o.availabilityRaw, o.leadTimeDays,
    o.leadTimeRaw, o.productUrl, o.imageUrls, rowHash, JSON.stringify(sourceRow), ctx.asOf,
    ctx.runId, rowNumber,
  ];
}

async function createProductForGtin(tx: Tx, gtin: string, cache: Map<string, string>): Promise<string> {
  const pid = (await tx.query(`INSERT INTO products DEFAULT VALUES RETURNING id`)).rows[0].id as string;
  const ins = await tx.query(
    `INSERT INTO product_identifiers (product_id, kind, value, source) VALUES ($1, 'gtin', $2, 'import')
     ON CONFLICT (kind, value) DO NOTHING RETURNING product_id`,
    [pid, gtin],
  );
  if (ins.rowCount === 0) {
    // Another transaction won the race despite the advisory lock (e.g. manual association): use its product.
    await tx.query('DELETE FROM products WHERE id = $1', [pid]);
    const owner = (await tx.query(`SELECT product_id FROM product_identifiers WHERE kind = 'gtin' AND value = $1`, [gtin])).rows[0].product_id;
    cache.set(gtin, owner);
    return owner;
  }
  cache.set(gtin, pid);
  return pid;
}

async function createStandaloneProduct(tx: Tx): Promise<string> {
  return (await tx.query(`INSERT INTO products DEFAULT VALUES RETURNING id`)).rows[0].id;
}

async function loadIdentity(tx: Tx, productId: string): Promise<IdentityData> {
  const r = (await tx.query(`SELECT brand, attributes FROM products WHERE id = $1`, [productId])).rows[0];
  return { brand: r?.brand ?? null, attributes: r?.attributes ?? {} };
}

async function loadCategoryMap(tx: Tx, supplierId: string): Promise<Map<string, string | null>> {
  const rows = (await tx.query(`SELECT raw_category, category_id FROM category_mappings WHERE supplier_id = $1`, [supplierId])).rows;
  return new Map(rows.map((r) => [r.raw_category, r.category_id]));
}

async function resolveCategory(tx: Tx, supplierId: string, raw: string | null, map: Map<string, string | null>): Promise<string | null> {
  if (!raw) return null;
  if (!map.has(raw)) {
    await tx.query(`INSERT INTO category_mappings (supplier_id, raw_category) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [supplierId, raw]);
    map.set(raw, null);
  }
  return map.get(raw) ?? null;
}

async function syncOfferImages(tx: Tx, supplierId: string, offerId: string, urls: string[]): Promise<number> {
  let created = 0;
  const sourceIds: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const res = await tx.query(
      `INSERT INTO image_sources (supplier_id, url) VALUES ($1, $2)
       ON CONFLICT (supplier_id, url) DO UPDATE SET updated_at = image_sources.updated_at
       RETURNING id, status, (xmax = 0) AS inserted`,
      [supplierId, urls[i]],
    );
    const src = res.rows[0];
    sourceIds.push(src.id);
    if (src.inserted) {
      created++;
      await enqueueImageFetch(tx, src.id, urls[i]);
    }
    await tx.query(
      `INSERT INTO offer_images (offer_id, image_source_id, position) VALUES ($1, $2, $3)
       ON CONFLICT (offer_id, image_source_id) DO UPDATE SET position = EXCLUDED.position`,
      [offerId, src.id, i],
    );
  }
  await tx.query(`DELETE FROM offer_images WHERE offer_id = $1 AND NOT (image_source_id = ANY($2::uuid[]))`, [offerId, sourceIds]);
  return created;
}

export interface ReviewInput {
  kind: 'gtin_conflict' | 'suggested_duplicate' | 'gtin_changed';
  productId: string;
  candidateProductId: string;
  offerId?: string | null;
  gtin?: string | null;
  score?: number | null;
  reasons: unknown[];
  importRunId?: string | null;
}

/** Opens a review unless an open one exists for the same pair; returns true when created. */
export async function openReview(tx: Tx, r: ReviewInput): Promise<boolean> {
  if (r.productId === r.candidateProductId) return false;
  const res = await tx.query(
    `INSERT INTO match_reviews (kind, product_id, candidate_product_id, offer_id, gtin, score, reasons, created_by_import_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT DO NOTHING`,
    [r.kind, r.productId, r.candidateProductId, r.offerId ?? null, r.gtin ?? null, r.score ?? null, JSON.stringify(r.reasons), r.importRunId ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}
