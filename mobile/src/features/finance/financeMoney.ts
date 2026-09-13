/**
 * Integer money for Finance: parse user input into minor units and format minor
 * units back for display. NO floating-point arithmetic is used anywhere — the
 * minor-unit integer is built and split as decimal STRINGS, so 10.00 UAH over
 * 3 days floors to 3.33 and never drifts to 3.34.
 */
import { FINANCE_CURRENCIES, type FinanceCurrency, type FinanceMinor } from '@/types/finance';

/** ~10 trillion major units: far beyond personal planning, still safely integer. */
export const MAX_MONEY_MINOR = 1_000_000_000_000_000;

export type MoneyParseError = 'empty' | 'format' | 'precision' | 'too-large';

export type MoneyParseResult =
  | { ok: true; amountMinor: FinanceMinor }
  | { ok: false; error: MoneyParseError };

/**
 * Parses user money input: optional sign, digit groups with spaces, `.` or `,` as
 * the decimal separator, at most 2 decimals. Exactly-representable decimal input
 * only — `1.005` is rejected as a precision error rather than silently rounded.
 */
export function parseMoneyToMinor(input: string): MoneyParseResult {
  const cleaned = input.replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
  if (cleaned.length === 0) return { ok: false, error: 'empty' };
  if (cleaned.split('.').length > 2) return { ok: false, error: 'format' };
  if (!/^-?\d*(\.\d*)?$/.test(cleaned) || /^-?\.?$/.test(cleaned) || cleaned === '-') {
    return { ok: false, error: 'format' };
  }
  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholePart = '', fractionPart = ''] = unsigned.split('.');
  if (wholePart.length === 0 && fractionPart.length === 0) return { ok: false, error: 'empty' };
  if (fractionPart.length > 2) return { ok: false, error: 'precision' };
  const digits = `${wholePart.length === 0 ? '0' : wholePart}${fractionPart.padEnd(2, '0')}`;
  const normalized = digits.replace(/^0+(?=\d)/, '');
  if (normalized.length > 16) return { ok: false, error: 'too-large' };
  const magnitude = Number(normalized);
  if (!Number.isSafeInteger(magnitude) || magnitude > MAX_MONEY_MINOR) {
    return { ok: false, error: 'too-large' };
  }
  return { ok: true, amountMinor: negative ? -magnitude : magnitude };
}

const CURRENCY_SYMBOL: Record<FinanceCurrency, string> = {
  UAH: '₴',
  USD: '$',
  EUR: '€',
  PLN: 'zł',
};

function isSupportedCurrency(value: string): value is FinanceCurrency {
  return (FINANCE_CURRENCIES as readonly string[]).includes(value);
}

/** Groups whole units with a thin space, e.g. `12 800,00`. */
function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Unsigned major/minor digit split of a minor-unit integer (string-based). */
export function splitMinor(minor: FinanceMinor): { whole: string; cents: string } {
  const padded = String(Math.abs(minor)).padStart(3, '0');
  return { whole: padded.slice(0, -2), cents: padded.slice(-2) };
}

/** Display string with the currency symbol; negative values keep an explicit minus. */
export function formatMoneyMinor(minor: FinanceMinor, currency: FinanceCurrency): string {
  const { whole, cents } = splitMinor(minor);
  const sign = minor < 0 ? '−' : '';
  const symbol = isSupportedCurrency(currency) ? CURRENCY_SYMBOL[currency] : currency;
  return `${sign}${groupDigits(whole)},${cents} ${symbol}`;
}

/** Signed delta display, e.g. `+350,00 ₴` / `−120,00 ₴`. */
export function formatMoneyDelta(minor: FinanceMinor, currency: FinanceCurrency): string {
  const sign = minor < 0 ? '−' : '+';
  const { whole, cents } = splitMinor(minor);
  return `${sign}${groupDigits(whole)},${cents} ${CURRENCY_SYMBOL[currency] ?? currency}`;
}

/** Exact integer sum, or null when the result would leave the safe range. */
export function addMinor(a: FinanceMinor, b: FinanceMinor): FinanceMinor | null {
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * Exact integer sum of a list of minor amounts, or `null` when the aggregate would
 * leave the safe range. Callers MUST treat `null` as an error: an unsafe aggregate is
 * never clamped and never converted to zero.
 */
export function aggregateMinor(values: readonly FinanceMinor[]): FinanceMinor | null {
  let total = 0;
  for (const value of values) {
    if (!isSafeMinor(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Alias kept for readability at call sites that sum a list of amounts. */
export function sumMinor(values: readonly FinanceMinor[]): FinanceMinor | null {
  return aggregateMinor(values);
}

/** True when the value is a usable minor-unit integer. */
export function isSafeMinor(value: unknown): value is FinanceMinor {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_MONEY_MINOR;
}

/** Exact integer subtraction, or `null` when the result leaves the safe range. */
export function subtractMinor(a: FinanceMinor, b: FinanceMinor): FinanceMinor | null {
  if (!isSafeMinor(a) || !isSafeMinor(b)) return null;
  const difference = a - b;
  return Number.isSafeInteger(difference) ? difference : null;
}

/**
 * AUTO allowance split: `floor(max(0, balanceMinor) / days)` in pure integer
 * arithmetic (guaranteed non-negative, never rounded up).
 */
export function divideMinorFloor(balanceMinor: FinanceMinor, days: number): FinanceMinor {
  if (!Number.isSafeInteger(days) || days <= 0) return 0;
  const positive = balanceMinor > 0 ? balanceMinor : 0;
  return Math.floor(positive / days);
}

/** Parses a `HH:MM` reminder time into minutes-since-midnight, or null. */
export function wallClockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
