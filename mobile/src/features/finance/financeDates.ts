/**
 * Finance date helpers.
 *
 * Reuses the PROVEN native planner date primitives (full-year-safe local dates,
 * no 0–99 remap, no fixed timezone offset) and adds pure Gregorian calendar
 * arithmetic for the allowance horizon. Day counts are computed in UTC epoch days
 * over validated civil dates, so they are unaffected by DST and never derived by
 * dividing elapsed milliseconds.
 */
import { isValidIsoDate } from '@/features/plans/planDates';

export { isValidIsoDate, isValidIsoTimestamp, localDateIso } from '@/features/plans/planDates';

const MS_PER_DAY = 86_400_000;

/** Full-year-safe UTC timestamp for a validated civil date (years 1–99 included). */
function utcFromParts(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function partsOf(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

/** Days in a Gregorian month (pure leap-year rule; no Date construction). */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Month-end clamp for a recurring day-of-month (29/30/31 → real month end). */
export function clampDayOfMonth(year: number, month: number, dayOfMonth: number): number {
  return Math.min(dayOfMonth, daysInMonth(year, month));
}

/** Real civil date for a (possibly clamped) day inside a month, or null if invalid. */
export function dateInMonth(year: number, month: number, dayOfMonth: number): string | null {
  if (month < 1 || month > 12) return null;
  if (dayOfMonth < 1) return null;
  const day = clampDayOfMonth(year, month, dayOfMonth);
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** Gregorian calendar-day difference `to − from` (NOT elapsed milliseconds / 24h). */
export function calendarDayDiff(fromIso: string, toIso: string): number | null {
  if (!isValidIsoDate(fromIso) || !isValidIsoDate(toIso)) return null;
  const from = partsOf(fromIso);
  const to = partsOf(toIso);
  const diff =
    (utcFromParts(to.year, to.month, to.day) - utcFromParts(from.year, from.month, from.day)) /
    MS_PER_DAY;
  return Number.isSafeInteger(diff) ? diff : null;
}

/** Adds whole calendar days to a validated date (UTC arithmetic, no DST drift). */
export function addCalendarDays(iso: string, days: number): string | null {
  if (!isValidIsoDate(iso) || !Number.isSafeInteger(days)) return null;
  const { year, month, day } = partsOf(iso);
  const shifted = new Date(utcFromParts(year, month, day) + days * MS_PER_DAY);
  const nextYear = shifted.getUTCFullYear();
  if (nextYear < 1 || nextYear > 9999) return null;
  const candidate = `${String(nextYear).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  return isValidIsoDate(candidate) ? candidate : null;
}

/** `YYYY-MM` key of a validated date. */
export function monthKeyOf(iso: string): string | null {
  return isValidIsoDate(iso) ? iso.slice(0, 7) : null;
}

/** Moves a `YYYY-MM` key by whole months (clamped to the supported year range). */
export function shiftMonthKey(key: string, delta: number): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match || !Number.isSafeInteger(delta)) return null;
  const total = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  if (year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** First and last date of a `YYYY-MM` key. */
export function monthRange(key: string): { first: string; last: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || year < 1) return null;
  const first = `${match[1]}-${match[2]}-01`;
  const last = `${match[1]}-${match[2]}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
  if (!isValidIsoDate(first) || !isValidIsoDate(last)) return null;
  return { first, last };
}

/** RU short day label, e.g. «10 сентября». */
export function formatFinanceDate(iso: string): string {
  if (!isValidIsoDate(iso)) return iso;
  const { year, month, day } = partsOf(iso);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
}

/** `HH:MM` local wall-clock time validation (24h). */
export function isValidWallClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
