// Money helpers. Calculations use whole cents (integers) so there are never 0.1 + 0.2 surprises.
// The database stores amounts with 2 decimals; quantities with 3 decimals ("milli" units here).

/** Divide two integers and round half up (the same rule PostgreSQL's round() uses for positives). */
export function divRound(numerator, denominator) {
  const n = BigInt(Math.trunc(numerator));
  const d = BigInt(Math.trunc(denominator));
  if (d === 0n) throw new Error('Division by zero');
  // floor((2n + d) / 2d) for non-negative n, d > 0
  return Number((2n * n + d) / (2n * d));
}

/** 12.34 (number or numeric string from the database) -> 1234 cents. */
export function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 1234 cents -> 12.34 (a plain number, for sending to the database). */
export function fromCents(cents) {
  return Math.round(cents) / 100;
}

/** 1.5 -> 1500 (milli-units). */
export function toMilli(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

export function fromMilli(milli) {
  return Math.round(milli) / 1000;
}

/**
 * Read an amount typed by a person: "1,234.50", " 12 ", "0.5". Returns cents, or null if it is not a valid
 * non-negative amount with at most 2 decimals.
 */
export function parseAmount(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/[\s,]/g, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 2) return null;
  return Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
}

/** Read a quantity typed by a person (up to 3 decimals). Returns milli-units or null. */
export function parseQuantity(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/[\s,]/g, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 3) return null;
  return Number(whole || '0') * 1000 + Number((frac + '000').slice(0, 3));
}

/** Show cents as money, e.g. 123456 -> "₱1,234.56". Negative numbers get a minus sign in front. */
export function formatMoney(cents, { currency = 'PHP', locale = 'en-PH' } = {}) {
  const value = (Number.isFinite(cents) ? cents : 0) / 100;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** Show milli-units as a tidy quantity: 2000 -> "2", 1500 -> "1.5", 250 -> "0.25". */
export function formatQuantity(milli) {
  const v = fromMilli(milli);
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
}

export function formatPercent(ratio, digits = 1) {
  if (ratio == null || !Number.isFinite(ratio)) return '–';
  return `${(ratio * 100).toFixed(digits)}%`;
}
