// Stock and availability semantics.
// NULL quantity = unknown, 0 = sold out. Qualitative availability is kept as declared; quantities are
// never invented from words, and stock is never summed across suppliers (they may share a warehouse).
import { isEmptyCell } from '../lib/parse.ts';

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'on_order' | 'unknown';

const WORDS: Array<[RegExp, StockStatus]> = [
  [/^(non disponibile|esaurit[oa]|out of stock|sold ?out|non disp\.?|no|0 disponibili|terminat[oa]|unavailable)$/i, 'out_of_stock'],
  [/^(in arrivo|su ordinazione|in riordino|backorder|on order|preorder|pre-?ordine|in produzione|da ordinare)$/i, 'on_order'],
  [/^(scarsa disponibilit[aà]|ultimi pezzi|pochi pezzi|limited|low|low stock|disponibilit[aà] limitata)$/i, 'low_stock'],
  [/^(disponibile|in stock|available|s[iì]|yes|y|ok|in magazzino|pronta consegna|disp\.?)$/i, 'in_stock'],
];

export function availabilityFromText(text: string | null): StockStatus {
  if (!text) return 'unknown';
  const t = text.trim().replace(/\s+/g, ' ');
  if (/^[<>]=?\s*\d+$/.test(t) || /^\d+\+$/.test(t)) {
    // "> 10", "10+" : at least some stock declared, exact quantity unknown.
    return /^<=?\s*0$/.test(t) ? 'out_of_stock' : 'in_stock';
  }
  for (const [re, status] of WORDS) if (re.test(t)) return status;
  return 'unknown';
}

export interface StockInput {
  quantity: number | null; // already parsed; null = not provided/unknown
  availabilityText: string | null;
}

export function resolveStock(input: StockInput): { quantity: number | null; status: StockStatus } {
  const textStatus = availabilityFromText(input.availabilityText);
  if (input.quantity === null) return { quantity: null, status: textStatus };
  if (input.quantity === 0) return { quantity: 0, status: textStatus === 'on_order' ? 'on_order' : 'out_of_stock' };
  return { quantity: input.quantity, status: textStatus === 'low_stock' ? 'low_stock' : 'in_stock' };
}

/** Largest quantity stored (int column); larger values are almost always a code in the wrong column. */
export const MAX_STOCK_QUANTITY = 2_000_000_000;

/** Parses a quantity cell that might contain qualitative text ("disponibile", ">10"). */
export function splitQuantityCell(value: unknown): { quantity: number | null; text: string | null; negative: boolean; outOfRange?: boolean } {
  const q = splitQuantityCellRaw(value);
  if (q.quantity !== null && q.quantity > MAX_STOCK_QUANTITY) return { quantity: null, text: null, negative: false, outOfRange: true };
  return q;
}

function splitQuantityCellRaw(value: unknown): { quantity: number | null; text: string | null; negative: boolean } {
  if (isEmptyCell(value)) return { quantity: null, text: null, negative: false };
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0) return { quantity: value, text: null, negative: false };
    if (Number.isInteger(value) && value < 0) return { quantity: null, text: null, negative: true };
    return { quantity: null, text: String(value), negative: false };
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return { quantity: Number(s), text: null, negative: false };
  if (/^\d+[.,]0+$/.test(s)) return { quantity: Number(s.split(/[.,]/)[0]), text: null, negative: false };
  if (/^-\d+([.,]0+)?$/.test(s)) return { quantity: null, text: null, negative: true };
  return { quantity: null, text: s, negative: false };
}

export const STOCK_TEXT: Record<StockStatus, string> = {
  in_stock: 'disponibile', low_stock: 'scarsa disponibilità', out_of_stock: 'esaurito', on_order: 'in arrivo', unknown: 'non dichiarata',
};

export function isAvailable(status: StockStatus): boolean {
  return status === 'in_stock' || status === 'low_stock';
}

const MAX_LEAD_TIME_DAYS = 3650;

/** Lead time in days (upper bound of a declared range). The raw text is always kept alongside. */
export function parseLeadTimeDays(value: unknown): number | null {
  const days = parseLeadTimeDaysRaw(value);
  return days !== null && days <= MAX_LEAD_TIME_DAYS ? days : null;
}

function parseLeadTimeDaysRaw(value: unknown): number | null {
  if (isEmptyCell(value)) return null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  const s = String(value).toLowerCase().trim();
  const m = /^(\d+)(?:\s*[-–a/]\s*(\d+))?\s*(gg|g|giorni|giorno|days?|d|settimane|settimana|sett|weeks?|w)?\.?\s*(lavorativi)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  const unit = m[3] ?? 'gg';
  return /^(settimane|settimana|sett|weeks?|w)$/.test(unit) ? n * 7 : n;
}
