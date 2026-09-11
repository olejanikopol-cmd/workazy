/**
 * Pure local-calendar helpers for the daily plan.
 *
 * Semantics follow the web planner's device-local calendar rules (`todayIso()`
 * in `lib/planner-data.ts`), not server/reminder timezones. For tomorrow and
 * across DST/leap/month/year boundaries we use calendar arithmetic on `Date`
 * (`setDate`), never `toISOString().slice(0, 10)` and never `+ 86_400_000`.
 */
export type PlanDay = 'today' | 'tomorrow';

/**
 * Lowest supported calendar year. Year 0000 is rejected everywhere (see
 * `isValidIsoDate`); years 1-99 are supported exactly. 
 */
export const MIN_PLANNER_YEAR = 1;

/** Alias used by consumers that name the relative-mode type explicitly. */
export type PlanDayMode = PlanDay;

export function localDateIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Today/tomorrow as local calendar dates for the given instant. */
export function getPlanDates(now: Date): { today: string; tomorrow: string } {
  const tomorrowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  return { today: localDateIso(now), tomorrow: localDateIso(tomorrowDate) };
}

/** `Сегодня` / `Завтра` for relative labels; otherwise a short RU date. */
export function formatPlanDay(iso: string, today: string, tomorrow: string): string {
  if (iso === today) return 'Сегодня';
  if (iso === tomorrow) return 'Завтра';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(
    isoToLocalNoon(iso),
  );
}

/** RU full date, capitalized first letter, e.g. «Понедельник, 10 сентября». */
export function formatFullDate(iso: string): string {
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(isoToLocalNoon(iso));
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/**
 * Real YYYY-MM-DD local calendar date (rejects impossible days like 02-30).
 *
 * Year contract: the planner domain is 0001-9999. Astronomical year 0000 is
 * REJECTED consistently by validation and by the zoned conversion helpers (the
 * calendar is a personal planner; 1 BC is not a meaningful event date, and the
 * ISO/HTML pattern `^\d{4}` would otherwise admit it). Years 0001-0099 are
 * fully supported and are never remapped to the 1900s.
 */
export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_PLANNER_YEAR) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  // Full-year-safe: the Date constructor remaps years 0-99 to 1900-1999, which
  // would reject valid dates like 0001-01-01; setFullYear does not remap.
  const date = localDateFromParts(year, month, day);
  return (
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  );
}

/**
 * Full-year-safe local date at noon (years 0-99 are NOT remapped to 1900s).
 * Noon avoids DST day-boundary drift in formatters and validity checks.
 */
function localDateFromParts(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date;
}

/**
 * ISO-8601 timestamp as produced by `Date.toISOString()`.
 *
 * A `Z` suffix means strictly UTC. Validate with a pure-UTC parse + exact
 * `toISOString()` round-trip — NEVER local-time `Date` construction, which
 * would reject valid instants that fall inside a local DST gap (e.g. the
 * Europe/Kyiv spring-forward hour on 2026-03-29: 03:30 local does not exist,
 * but `2026-03-29T03:30:00.000Z` is a real UTC instant). The exact round-trip
 * still rejects impossible calendar dates (`2026-02-30T…` normalizes to
 * `2026-03-02T…`) while genuine leap days (`2024-02-29`) round-trip unchanged.
 */
export function isValidIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

/** Concrete local date for a relative Today/Tomorrow mode. */
export function dateForMode(
  mode: PlanDay,
  today: string,
  tomorrow: string,
): string {
  return mode === 'today' ? today : tomorrow;
}

/** Parse YYYY-MM-DD as full-year-safe local noon (no 0-99 remap). */
function isoToLocalNoon(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return localDateFromParts(year, month, day);
}