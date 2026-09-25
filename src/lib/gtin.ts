// GTIN/EAN parsing and canonical normalisation. Rules are documented in docs/IDENTITY.md.
//
// - The original string is always kept by callers; this module never "repairs" a code.
// - Supported: GTIN-8 (EAN-8), GTIN-12 (UPC-A), GTIN-13 (EAN-13), GTIN-14. Check digit is verified.
// - Canonical form = GTIN-14 (left zero-padded). Per GS1 this is an equivalent representation of the
//   same GTIN, so UPC-A 036000291452 and EAN-13 0036000291452 are the same trade item.
//   A GTIN-14 with indicator digit 1-8 identifies a different trade item (e.g. a case) and therefore
//   never equals the single-unit GTIN-13.
// - Restricted-circulation numbers (in-store/internal/coupons) are syntactically valid but not globally
//   unique: they are marked 'restricted' and never used for automatic cross-supplier aggregation.

export type BarcodeStatus = 'valid' | 'restricted' | 'invalid' | 'missing';
export type GtinFormat = 'EAN-8' | 'UPC-A' | 'EAN-13' | 'GTIN-14';

export type GtinIssue =
  | 'not_digits'
  | 'scientific_notation'
  | 'unsupported_length'
  | 'bad_check_digit'
  | 'all_zeros';

export interface ParsedBarcode {
  status: BarcodeStatus;
  raw: string | null;
  /** Canonical GTIN-14, set for 'valid' and 'restricted'. */
  gtin14: string | null;
  format: GtinFormat | null;
  issue: GtinIssue | null;
  /** True when spaces/hyphens between digit groups were ignored (reported as a warning). */
  formattingRemoved: boolean;
}

const FORMAT_BY_LENGTH: Record<number, GtinFormat> = { 8: 'EAN-8', 12: 'UPC-A', 13: 'EAN-13', 14: 'GTIN-14' };

export function gs1CheckDigit(body: string): number {
  // Weights 3,1,3,1,... starting from the rightmost digit of the body (the digit left of the check digit).
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += (body.charCodeAt(i) - 48) * w;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidCheckDigit(digits: string): boolean {
  return gs1CheckDigit(digits.slice(0, -1)) === digits.charCodeAt(digits.length - 1) - 48;
}

export function isRestrictedCirculation(digits: string): boolean {
  if (digits.length === 8) return digits[0] === '0' || digits[0] === '2';
  const g14 = digits.padStart(14, '0');
  if (g14.startsWith('000000')) return isRestrictedCirculation(g14.slice(6)); // GTIN-8 in 14-digit form
  const p3 = Number(g14.slice(1, 4)); // first three digits of the embedded GTIN-13
  return (
    (p3 >= 20 && p3 <= 29) || // 020-029 restricted distribution (in-store, regional)
    (p3 >= 40 && p3 <= 49) || // 040-049 company-internal
    (p3 >= 50 && p3 <= 59) || // 050-059 coupons
    (p3 >= 200 && p3 <= 299) || // 200-299 in-store / variable measure
    (p3 >= 980 && p3 <= 984) || // refund receipts, coupons
    (p3 >= 990 && p3 <= 999) // coupons
  );
}

export function parseBarcode(input: unknown): ParsedBarcode {
  const raw = input === null || input === undefined ? null : String(input);
  const result = (partial: Partial<ParsedBarcode>): ParsedBarcode => ({
    status: 'invalid', raw, gtin14: null, format: null, issue: null, formattingRemoved: false, ...partial,
  });
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return result({ status: 'missing' });

  if (/^[0-9]+([.,][0-9]+)?[eE][+-]?[0-9]+$/.test(trimmed)) {
    // Excel displayed/exported the code as a number in scientific notation: digits are lost.
    return result({ issue: 'scientific_notation' });
  }
  let digits = trimmed;
  let formattingRemoved = false;
  if (/^[0-9]+([ -][0-9]+)+$/.test(trimmed)) {
    digits = trimmed.replace(/[ -]/g, '');
    formattingRemoved = true;
  }
  if (!/^[0-9]+$/.test(digits)) return result({ issue: 'not_digits' });
  const format = FORMAT_BY_LENGTH[digits.length];
  if (!format) return result({ issue: 'unsupported_length', formattingRemoved });
  if (/^0+$/.test(digits)) return result({ issue: 'all_zeros', format, formattingRemoved });
  if (!isValidCheckDigit(digits)) return result({ issue: 'bad_check_digit', format, formattingRemoved });

  const gtin14 = digits.padStart(14, '0');
  return result({
    status: isRestrictedCirculation(digits) ? 'restricted' : 'valid',
    gtin14,
    format,
    formattingRemoved,
  });
}

/** Human-readable (Italian) explanation for UI and import reports. */
export function barcodeIssueMessage(issue: GtinIssue): string {
  switch (issue) {
    case 'not_digits':
      return 'Il codice contiene caratteri non numerici';
    case 'scientific_notation':
      return 'Codice in notazione scientifica: Excel ha perso cifre, correggere il file sorgente';
    case 'unsupported_length':
      return 'Lunghezza non valida per EAN-8, UPC-A, EAN-13 o GTIN-14 (possibili zeri iniziali persi)';
    case 'bad_check_digit':
      return 'Cifra di controllo errata';
    case 'all_zeros':
      return 'Codice composto solo da zeri';
  }
}

/** Display form: GTIN-13 when the canonical GTIN-14 starts with 0, otherwise the full GTIN-14. */
export function displayGtin(gtin14: string): string {
  return gtin14.startsWith('0') ? gtin14.slice(1) : gtin14;
}

/**
 * Standard UPC-E (zero-suppressed, 8 digits incl. number system and check digit) to UPC-A expansion.
 * Used only for codes read from a photo whose symbology was decoded as UPC-E.
 */
export function expandUpcE(upce: string): string | null {
  if (!/^[01]\d{7}$/.test(upce)) return null;
  const d = upce.split('');
  const ns = d[0];
  const [d1, d2, d3, d4, d5, d6] = d.slice(1, 7);
  const check = d[7];
  let body: string;
  if (d6 === '0' || d6 === '1' || d6 === '2') body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  const upca = `${ns}${body}${check}`;
  return isValidCheckDigit(upca) ? upca : null;
}
