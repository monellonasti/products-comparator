// Parsing of untrusted cell values from supplier files. Every function returns either a value or a
// structured problem; nothing is guessed silently.
import { toScaled, fromScaled } from './decimal.ts';

export type DecimalSeparator = '.' | ',';

export type ParseResult<T> = { ok: true; value: T | null } | { ok: false; code: string; message: string };

const ok = <T>(value: T | null): ParseResult<T> => ({ ok: true, value });
const fail = <T>(code: string, message: string): ParseResult<T> => ({ ok: false, code, message });

const EMPTY_MARKERS = new Set(['', '-', '--', 'n/a', 'n.a.', 'na', 'n/d', 'nd', 'null', 'none', '#n/d', '#n/a']);

export function isEmptyCell(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return EMPTY_MARKERS.has(String(value).trim().toLowerCase());
}

/**
 * Parses a decimal amount written with the declared decimal separator. Thousands separators are
 * accepted only in well-formed groups of three ("1.234,56" with ',' decimal). Currency symbols/codes
 * around the number are ignored. Returns a canonical string with up to 4 decimals.
 */
export function parseDecimal(value: unknown, sep: DecimalSeparator): ParseResult<string> {
  if (isEmptyCell(value)) return ok(null);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('invalid_number', 'Valore numerico non valido');
    const scaled = toScaled(value);
    return scaled === null ? fail('invalid_number', 'Valore numerico non valido') : ok(fromScaled(scaled));
  }
  let s = String(value).trim().replace(/ /g, ' ');
  s = s.replace(/^(€|eur|euro|\$|usd|£|gbp|chf)\s*/i, '').replace(/\s*(€|eur|euro|\$|usd|£|gbp|chf)$/i, '').trim();
  const thousands = sep === ',' ? '.' : ',';
  const esc = (c: string) => (c === '.' ? '\\.' : c);
  // A thousands group never starts with 0: "0.125" with ',' as decimal separator is a decimal written
  // with the other separator, not 125.
  const re = new RegExp(`^(-)?([1-9]\\d{0,2}(?:[${esc(thousands)} ]\\d{3})+|\\d+)(?:${esc(sep)}(\\d+))?$`);
  const m = re.exec(s);
  if (!m) {
    const other = sep === ',' ? '.' : ',';
    if (new RegExp(`^-?\\d+${esc(other)}\\d{1,2}$|^-?0${esc(other)}\\d+$`).test(s)) {
      return fail('decimal_separator_mismatch', `Separatore decimale "${other}" diverso da quello configurato "${sep}"`);
    }
    return fail('invalid_number', `Numero non interpretabile: "${truncate(s)}"`);
  }
  const intPart = m[2].replace(/[., ]/g, '');
  const canonical = `${m[1] ?? ''}${intPart}${m[3] ? `.${m[3]}` : ''}`;
  const scaled = toScaled(canonical);
  if (scaled === null) return fail('invalid_number', `Numero non interpretabile: "${truncate(s)}"`);
  if (m[3] && m[3].length > 4) return fail('too_many_decimals', 'Più di 4 decimali: verificare il valore');
  return ok(fromScaled(scaled));
}

export function parseNonNegativeInt(value: unknown, sep: DecimalSeparator): ParseResult<number> {
  const d = parseDecimal(value, sep);
  if (!d.ok || d.value === null) return d as ParseResult<number>;
  const n = Number(d.value);
  if (!Number.isInteger(n)) return fail('not_integer', `Atteso un numero intero, trovato "${d.value}"`);
  if (n < 0) return fail('negative', 'Valore negativo non ammesso');
  if (n > 2_000_000_000) return fail('out_of_range', 'Valore fuori intervallo');
  return ok(n);
}

export function parseCurrency(value: unknown): ParseResult<string> {
  if (isEmptyCell(value)) return ok(null);
  const s = String(value).trim().toUpperCase();
  const symbols: Record<string, string> = { '€': 'EUR', EURO: 'EUR', $: 'USD', '£': 'GBP' };
  const code = symbols[s] ?? s;
  if (!/^[A-Z]{3}$/.test(code)) return fail('invalid_currency', `Valuta non riconosciuta: "${truncate(s)}"`);
  return ok(code);
}

export function parseVatRate(value: unknown, sep: DecimalSeparator): ParseResult<string> {
  if (isEmptyCell(value)) return ok(null);
  // An Excel cell formatted as a percentage holds the fraction (22% is stored as 0.22).
  if (typeof value === 'number' && value > 0 && value < 1) return parseDecimal(Math.round(value * 1_000_000) / 10_000, sep);
  const cleaned = String(value).trim().replace(/%$/, '').trim();
  const d = parseDecimal(cleaned, sep);
  if (!d.ok || d.value === null) return d;
  const n = Number(d.value);
  if (n < 0 || n >= 100) return fail('invalid_vat_rate', 'Aliquota IVA fuori intervallo');
  // No VAT rate is below 1%: a typed "0,22" is a fraction, and silently multiplying could be wrong.
  if (n > 0 && n < 1) return fail('vat_rate_fraction', `Aliquota IVA scritta come frazione ("${truncate(cleaned)}"): indicare la percentuale, es. 22`);
  return d;
}

/** Accepts only absolute http(s) URLs; anything else is reported, never rewritten. */
const MAX_URL_LENGTH = 2048;

export function parseHttpUrl(value: unknown): ParseResult<string> {
  if (isEmptyCell(value)) return ok(null);
  const s = String(value).trim();
  // Longer values do not fit the unique index on image sources and are never real listino links.
  if (s.length > MAX_URL_LENGTH) return fail('url_too_long', `URL più lungo di ${MAX_URL_LENGTH} caratteri`);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return fail('invalid_url', `URL non valido: "${truncate(s)}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('invalid_url', 'Sono ammessi solo URL http/https');
  if (url.username || url.password) return fail('invalid_url', 'URL con credenziali non ammesso');
  return ok(url.toString());
}

/** Splits a cell holding several image URLs (separated by | ; , newline or whitespace). */
export function splitUrls(value: unknown): string[] {
  if (isEmptyCell(value)) return [];
  return String(value)
    .split(/[|;\n\r\t ]+|,(?=\s*https?:)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Plain text from possibly-HTML supplier descriptions: tags removed, entities decoded, whitespace collapsed. */
export function toPlainText(value: unknown, maxLength = 5000): string | null {
  if (isEmptyCell(value)) return null;
  const text = String(value)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
