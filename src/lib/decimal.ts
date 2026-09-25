// Exact decimal arithmetic for money, using BigInt scaled by 10^6. No floating point on prices.
export const SCALE_DIGITS = 6;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

export type Scaled = bigint;

/** Parses a canonical decimal string ("1234.5", "-0.25"). Returns null when not a plain decimal. */
export function toScaled(value: string | number | null | undefined): Scaled | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(SCALE_DIGITS + 1, '0');
  let scaled = BigInt(m[2]) * SCALE + BigInt(frac.slice(0, SCALE_DIGITS));
  if (Number(frac[SCALE_DIGITS]) >= 5) scaled += 1n; // half-up on the 7th decimal
  return m[1] ? -scaled : scaled;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) return 'NaN';
  // toFixed avoids exponent notation for the magnitudes we handle (< 1e21).
  return n.toFixed(SCALE_DIGITS + 1).replace(/\.?0+$/, '') || '0';
}

export function fromScaled(v: Scaled, decimals = 4): string {
  const neg = v < 0n;
  let abs = neg ? -v : v;
  const drop = 10n ** BigInt(SCALE_DIGITS - decimals);
  const rem = abs % drop;
  abs = abs / drop + (rem * 2n >= drop ? 1n : 0n);
  const div = 10n ** BigInt(decimals);
  const int = abs / div;
  const frac = (abs % div).toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${int}${decimals > 0 ? `.${frac}` : ''}`;
}

/** a / b with half-up rounding at SCALE precision (b is a scaled value). */
export function divScaled(a: Scaled, b: Scaled): Scaled {
  return mulDiv(a, SCALE, b);
}

/** round_half_up(a * b / c) for scaled values where b/c is a dimensionless ratio. */
export function mulDiv(a: Scaled, b: Scaled, c: Scaled): Scaled {
  if (c === 0n) throw new Error('division by zero');
  const num = a * b;
  const q = num / c;
  const r = num % c;
  const absR = r < 0n ? -r : r;
  const absC = c < 0n ? -c : c;
  return absR * 2n >= absC ? q + (num < 0n !== c < 0n ? -1n : 1n) : q;
}

export function divInt(a: Scaled, n: number): Scaled {
  return divScaled(a, BigInt(n) * SCALE);
}

export function compareScaled(a: Scaled, b: Scaled): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const ONE_HUNDRED: Scaled = 100n * SCALE;
