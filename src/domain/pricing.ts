// Price comparability. A price enters the "lowest price" only when it is semantically comparable:
// known amount, currency, VAT treatment (net, or gross with a known rate) and units per priced pack.
// Currencies are never converted (no dated FX source in V1). Shipping/other costs are unknown, so the
// value is a unit price, never a "total cost".
import { toScaled, fromScaled, divInt, mulDiv, ONE_HUNDRED, compareScaled, type Scaled } from '../lib/decimal.ts';
import { isAvailable, type StockStatus } from './stock.ts';

export type VatTreatment = 'net' | 'gross' | 'unknown';

export interface PriceInput {
  offerId: string;
  supplierId: string;
  supplierPriority: number;
  active: boolean;
  price: string | null;
  currency: string | null;
  vatTreatment: VatTreatment;
  vatRate: string | null;
  unitsPerPack: number | null;
  moq: number | null;
  stockStatus: StockStatus;
  stockQuantity: number | null;
}

export type NotComparableReason = 'inactive' | 'missing_price' | 'zero_price' | 'missing_currency' | 'unknown_vat' | 'gross_without_rate' | 'unknown_pack';

export interface PriceEvaluation {
  offerId: string;
  comparable: boolean;
  reasons: NotComparableReason[];
  currency: string | null;
  /** Net price of the priced unit (e.g. a pack of 5), 4 decimals. */
  netPackPrice: string | null;
  /** Net price per single product unit, only when units per pack is known. */
  netUnitPrice: string | null;
  netDerivedFromGross: boolean;
}

export const REASON_LABELS: Record<NotComparableReason, string> = {
  inactive: 'offerta non più presente nel listino',
  missing_price: 'prezzo mancante',
  zero_price: 'prezzo pari a zero (su richiesta o segnaposto)',
  missing_currency: 'valuta mancante',
  unknown_vat: 'trattamento IVA non dichiarato',
  gross_without_rate: 'prezzo IVA inclusa senza aliquota',
  unknown_pack: 'quantità per confezione non dichiarata',
};

export function evaluatePrice(o: PriceInput): PriceEvaluation {
  return evaluate(o).evaluation;
}

/** Evaluation plus the unit price at full internal precision (ranking must not depend on 4-decimal rounding). */
function evaluate(o: PriceInput): { evaluation: PriceEvaluation; unit: Scaled | null } {
  const reasons: NotComparableReason[] = [];
  if (!o.active) reasons.push('inactive');
  const price = toScaled(o.price);
  if (price === null) reasons.push('missing_price');
  // A 0 price is a placeholder ("su richiesta"), never the cheapest offer.
  else if (price === 0n) reasons.push('zero_price');
  if (!o.currency) reasons.push('missing_currency');

  let net: Scaled | null = null;
  let derived = false;
  if (price !== null) {
    if (o.vatTreatment === 'net') net = price;
    else if (o.vatTreatment === 'gross') {
      const rate = toScaled(o.vatRate);
      if (rate === null) reasons.push('gross_without_rate');
      else {
        net = mulDiv(price, ONE_HUNDRED, ONE_HUNDRED + rate); // price / (1 + rate/100)
        derived = true;
      }
    } else reasons.push('unknown_vat');
  }
  if (!o.unitsPerPack) reasons.push('unknown_pack');
  const unit = net !== null && o.unitsPerPack ? divInt(net, o.unitsPerPack) : null;
  return {
    evaluation: {
      offerId: o.offerId,
      comparable: reasons.length === 0,
      reasons,
      currency: o.currency,
      netPackPrice: net === null ? null : fromScaled(net),
      netUnitPrice: unit === null ? null : fromScaled(unit),
      netDerivedFromGross: derived,
    },
    unit,
  };
}

export interface BestPrice {
  offerId: string;
  supplierId: string;
  unitPrice: string;
  currency: string;
  stockStatus: StockStatus;
  moq: number | null;
  unitsPerPack: number;
}

export interface PriceSummary {
  best: BestPrice | null;
  /** Cheaper comparable price that is currently sold out (shown separately, never as "best"). */
  cheaperSoldOut: BestPrice | null;
  currency: string | null;
  comparableCount: number;
  notComparableCount: number;
  /** Currencies of comparable offers that differ from the summary currency (not converted). */
  otherCurrencies: string[];
}

export function summarizePrices(offers: PriceInput[]): PriceSummary {
  const active = offers.filter((o) => o.active);
  const evaluated = active.map((o) => {
    const { evaluation, unit } = evaluate(o);
    return { o, e: evaluation, unit };
  });
  const comparable = evaluated.filter((x) => x.e.comparable);
  const byCurrency = new Map<string, number>();
  for (const { e } of comparable) byCurrency.set(e.currency!, (byCurrency.get(e.currency!) ?? 0) + 1);
  const currency =
    [...byCurrency.entries()].sort((a, b) => b[1] - a[1] || (a[0] === 'EUR' ? -1 : b[0] === 'EUR' ? 1 : a[0].localeCompare(b[0])))[0]?.[0] ??
    null;

  const inCurrency = comparable.filter((x) => x.e.currency === currency);
  const order = (a: (typeof inCurrency)[number], b: (typeof inCurrency)[number]) =>
    compareScaled(a.unit!, b.unit!) ||
    (a.o.moq ?? 1) - (b.o.moq ?? 1) ||
    a.o.supplierPriority - b.o.supplierPriority ||
    a.o.offerId.localeCompare(b.o.offerId);
  const toBest = (x: (typeof inCurrency)[number]): BestPrice => ({
    offerId: x.o.offerId,
    supplierId: x.o.supplierId,
    unitPrice: x.e.netUnitPrice!,
    currency: x.e.currency!,
    stockStatus: x.o.stockStatus,
    moq: x.o.moq,
    unitsPerPack: x.o.unitsPerPack!,
  });

  const purchasable = inCurrency.filter((x) => x.o.stockStatus !== 'out_of_stock').sort(order);
  const soldOut = inCurrency.filter((x) => x.o.stockStatus === 'out_of_stock').sort(order);
  const best = purchasable[0] ? toBest(purchasable[0]) : null;
  const cheapestSoldOut = soldOut[0] ? toBest(soldOut[0]) : null;
  const cheaperSoldOut =
    soldOut[0] && (!purchasable[0] || compareScaled(soldOut[0].unit!, purchasable[0].unit!) < 0)
      ? cheapestSoldOut
      : null;

  return {
    best,
    cheaperSoldOut,
    currency,
    comparableCount: comparable.length,
    notComparableCount: evaluated.length - comparable.length,
    otherCurrencies: [...byCurrency.keys()].filter((c) => c !== currency).sort(),
  };
}

export function countAvailableSuppliers(offers: Array<{ active: boolean; supplierId: string; stockStatus: StockStatus }>): number {
  return new Set(offers.filter((o) => o.active && isAvailable(o.stockStatus)).map((o) => o.supplierId)).size;
}
