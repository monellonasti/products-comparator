import type { StockStatus } from './types';

export function money(amount: string | number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: currency || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

/**
 * Number typed in a filter field: "12,5", "1.234,50" (Italian) or "12.5". Returns the value with a dot as
 * decimal separator, '' for an empty field, null when it is not a non-negative number.
 */
export function parseDecimalInput(text: string): string | null {
  const t = text.replace(/\s/g, '');
  if (!t) return '';
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return /^\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

export function dateTime(v: string | null | undefined): string {
  if (!v) return '—';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(v));
}

export function date(v: string | null | undefined): string {
  if (!v) return '—';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium' }).format(new Date(v));
}

export function ago(v: string | null | undefined): string {
  if (!v) return '—';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('it', { numeric: 'auto' });
  if (diff < 60) return 'adesso';
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}

export const STOCK_LABELS: Record<StockStatus, string> = {
  in_stock: 'Disponibile',
  low_stock: 'Scarsa disponibilità',
  out_of_stock: 'Esaurito',
  on_order: 'In arrivo / su ordinazione',
  unknown: 'Disponibilità non dichiarata',
};

export function stockText(status: StockStatus, quantity: number | null): string {
  if (quantity !== null && quantity !== undefined) return quantity === 0 ? 'Esaurito (0)' : `${STOCK_LABELS[status]} (${quantity.toLocaleString('it-IT')})`;
  return STOCK_LABELS[status];
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const VAT_LABELS = { net: 'IVA esclusa (netto)', gross: 'IVA inclusa', unknown: 'IVA non dichiarata' } as const;

export const LINK_LABELS = {
  gtin: 'Stesso EAN (automatico)',
  standalone: 'Senza EAN valido',
  manual: 'Associazione manuale',
  conflict_hold: 'In revisione (dati in conflitto)',
} as const;

export const BARCODE_STATUS_LABELS: Record<string, string> = {
  valid: 'valido',
  restricted: 'a circolazione limitata',
  invalid: 'non valido',
  missing: 'assente',
};
