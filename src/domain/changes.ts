// Change report: what a new price list changed for an existing offer. Pure diff + bulk insert.
// Only facts from the files are recorded (old -> new); the relative price change is computed only when
// both prices are comparable (same currency, VAT treatment and units per priced pack).
import type { Tx } from '../db/pool.ts';
import { toScaled, fromScaled, mulDiv, type Scaled } from '../lib/decimal.ts';
import type { StockStatus } from './stock.ts';

export type ChangeType = 'price' | 'availability' | 'stock' | 'images' | 'new_offer' | 'removed' | 'reactivated' | 'barcode';

export const CHANGE_LABELS: Record<ChangeType, string> = {
  price: 'Prezzo',
  availability: 'Disponibilità',
  stock: 'Quantità',
  images: 'Immagini',
  new_offer: 'Nuova offerta',
  removed: 'Uscita dal listino',
  reactivated: 'Tornata a listino',
  barcode: 'EAN cambiato',
};

export interface OfferCommercialState {
  price: string | null;
  currency: string | null;
  vatTreatment: string;
  unitsPerPack: number | null;
  stockQuantity: number | null;
  stockStatus: StockStatus;
  imageUrls: string[];
  gtin: string | null;
}

export interface ChangeRecord {
  offerId: string;
  productId: string | null;
  type: ChangeType;
  oldValue: unknown;
  newValue: unknown;
  pct: string | null;
}

const samePrice = (a: string | null, b: string | null) => toScaled(a) === toScaled(b);

export function priceChangePct(oldPrice: string, newPrice: string): string | null {
  const o = toScaled(oldPrice) as Scaled;
  const n = toScaled(newPrice) as Scaled;
  if (!o) return null; // from 0: no meaningful percentage
  return fromScaled(mulDiv(n - o, 100n * 1_000_000n, o), 2);
}

export function diffOffer(
  offerId: string,
  productId: string | null,
  before: OfferCommercialState,
  after: OfferCommercialState,
  opts: { compareImages: boolean },
): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  const priceState = (s: OfferCommercialState) => ({ price: s.price, currency: s.currency, vat: s.vatTreatment, unitsPerPack: s.unitsPerPack });
  const conditionsSame = before.currency === after.currency && before.vatTreatment === after.vatTreatment && before.unitsPerPack === after.unitsPerPack;
  if (!samePrice(before.price, after.price) || !conditionsSame) {
    const pct = conditionsSame && before.price !== null && after.price !== null ? priceChangePct(before.price, after.price) : null;
    out.push({ offerId, productId, type: 'price', oldValue: priceState(before), newValue: priceState(after), pct });
  }
  if (before.stockStatus !== after.stockStatus) {
    out.push({
      offerId, productId, type: 'availability',
      oldValue: { status: before.stockStatus, quantity: before.stockQuantity },
      newValue: { status: after.stockStatus, quantity: after.stockQuantity },
      pct: null,
    });
  } else if (before.stockQuantity !== after.stockQuantity) {
    out.push({ offerId, productId, type: 'stock', oldValue: { quantity: before.stockQuantity }, newValue: { quantity: after.stockQuantity }, pct: null });
  }
  if (opts.compareImages) {
    const added = after.imageUrls.filter((u) => !before.imageUrls.includes(u));
    const removed = before.imageUrls.filter((u) => !after.imageUrls.includes(u));
    if (added.length || removed.length) {
      out.push({ offerId, productId, type: 'images', oldValue: { count: before.imageUrls.length, removed }, newValue: { count: after.imageUrls.length, added }, pct: null });
    }
  }
  if ((before.gtin ?? null) !== (after.gtin ?? null)) {
    out.push({ offerId, productId, type: 'barcode', oldValue: { gtin: before.gtin }, newValue: { gtin: after.gtin }, pct: null });
  }
  return out;
}

export async function insertChanges(tx: Tx, runId: string | null, supplierId: string, changes: ChangeRecord[]): Promise<void> {
  for (let i = 0; i < changes.length; i += 1000) {
    const c = changes.slice(i, i + 1000);
    await tx.query(
      `INSERT INTO offer_changes (import_run_id, supplier_id, offer_id, product_id, change_type, old_value, new_value, pct)
       SELECT $1::uuid, $2::uuid, x.offer_id, x.product_id, x.change_type, x.old_value, x.new_value, x.pct
         FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::jsonb[], $7::jsonb[], $8::numeric[])
           AS x(offer_id, product_id, change_type, old_value, new_value, pct)
       ON CONFLICT (import_run_id, offer_id, change_type) DO NOTHING`,
      [
        runId, supplierId, c.map((x) => x.offerId), c.map((x) => x.productId), c.map((x) => x.type),
        c.map((x) => (x.oldValue === undefined ? null : JSON.stringify(x.oldValue))),
        c.map((x) => (x.newValue === undefined ? null : JSON.stringify(x.newValue))),
        c.map((x) => x.pct),
      ],
    );
  }
}

export function countByType(changes: ChangeRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) out[`changes_${c.type}`] = (out[`changes_${c.type}`] ?? 0) + 1;
  return out;
}
