/**
 * Pure journal date helpers (Records-owned; no cross-feature import).
 *
 * Device-local calendar dates with FULL-YEAR-SAFE construction: the JS Date
 * constructor remaps years 0-99 to 1900-1999, so every helper here builds dates
 * with `setFullYear`/`setHours` and never `new Date(year, ...)`.
 *
 * YEAR CONTRACT (identical to `planDates.isValidIsoDate` and the storage parsers):
 * supported years are `MIN_PLANNER_YEAR .. MAX_PLANNER_YEAR` (0001-9999). Year
 * 0000 is NOT supported, so every helper that converts, derives, serializes or
 * formats a Records date enforces the same range:
 * - `isSupportedRecordsDate(iso)` -> boolean (validates a written/stored string);
 * - `localIsoDate(date)` / `todayIso(now)` -> `string | null` (null = the
 *   instant's local year is outside the contract, so no supported string exists);
 * - `formatJournalDate(iso)` / `formatJournalFullDate(iso)` -> `string | null`
 *   (null = unsupported/invalid input; a year-0000 date is never rendered).
 * Callers must handle null explicitly instead of inventing a date.
 */

/**
 * Lowest supported calendar year for Records. Year 0000 is rejected consistently
 * by validation, conversion, derivation and formatting; years 0001-0099 are
 * fully supported and are never remapped to the 1900s.
 */
export const MIN_PLANNER_YEAR = 1;

/** Highest supported calendar year for Records (4-digit dates only). */
export const MAX_PLANNER_YEAR = 9999;

/**
 * True when `iso` is a real YYYY-MM-DD calendar date the app may WRITE, read or
 * display. Full-year-safe (no 0-99 remap) and years outside
 * `MIN_PLANNER_YEAR..MAX_PLANNER_YEAR` (0000 in particular) are rejected, so a
 * mutation can never persist a snapshot the parser would later refuse to load
 * and no helper can render an unsupported year.
 */
export function isSupportedRecordsDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_PLANNER_YEAR || year > MAX_PLANNER_YEAR) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * Local YYYY-MM-DD with a 4-digit year, or null when the instant's local year is
 * outside the supported contract (e.g. a device clock at year 0000).
 */
export function localIsoDate(date: Date): string | null {
  const year = date.getFullYear();
  if (year < MIN_PLANNER_YEAR || year > MAX_PLANNER_YEAR) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${month}-${day}`;
}

/**
 * Today as a device-local YYYY-MM-DD string, or null when the device clock is
 * outside the supported year range. Callers must not substitute a fabricated
 * date for a null result.
 */
export function todayIso(now: Date): string | null {
  return localIsoDate(now);
}

/** Full-year-safe local noon, or null when the string is not a supported date. */
function localNoon(iso: string): Date | null {
  if (!isSupportedRecordsDate(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date;
}

/** Short RU date, e.g. «10 сентября»; null for an unsupported/invalid date. */
export function formatJournalDate(iso: string): string | null {
  const date = localNoon(iso);
  if (date === null) return null;
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
}

/**
 * Full RU date, e.g. «Понедельник, 10 сентября»; null for an
 * unsupported/invalid date (a year-0000 value is never rendered).
 */
export function formatJournalFullDate(iso: string): string | null {
  const date = localNoon(iso);
  if (date === null) return null;
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

