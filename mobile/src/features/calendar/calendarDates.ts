/**
 * Pure local-calendar helpers for the Calendar workspace.
 *
 * Device-local floating dates/times, consistent with the planner UI. A device
 * timezone change keeps the stored date and clock time and changes the derived
 * notification instant on the next reconciliation. `zonedDateTimeToUtc` mirrors
 * the web scheduler's offset-iteration approach (no hard-coded UTC offset).
 */
import { isValidIsoDate } from '@/features/plans/planDates';

export { isValidIsoDate };

export type CalendarMonthGrid = {
  /** Monday-first weekday labels: Пн..Вс. */
  weekdays: readonly string[];
  /** Leading nulls for blank cells, then day numbers 1..N. */
  cells: readonly (number | null)[];
  daysInMonth: number;
  /** Monday-based index of the first day of the month (0..6). */
  leadingBlanks: number;
};

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

/**
 * Full-year-safe local noon. The JS Date constructor remaps years 0-99 to
 * 1900-1999 (`new Date(1, 0, 1)` is 1901, not year 1); `setFullYear` does not
 * remap and keeps exact calendar semantics. Noon avoids DST day-boundary drift.
 */
function localNoon(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(12, 0, 0, 0);
  return date;
}

/**
 * Local YYYY-MM-DD serialization: the year is ALWAYS 4-digit padded, so years
 * 1-99 round-trip as 0001-0099 instead of being truncated or remapped.
 */
export function localDateToIso(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Monday-first month grid for a local year/month (month is 0-based). */
export function monthGrid(year: number, month: number): CalendarMonthGrid {
  const daysInMonth = localNoon(year, month + 1, 0).getDate();
  const firstWeekday = localNoon(year, month, 1).getDay();
  const leadingBlanks = (firstWeekday + 6) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  return { weekdays: WEEKDAYS, cells, daysInMonth, leadingBlanks };
}

/** RU month + year label, e.g. «сентябрь 2026». */
export function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(
    localNoon(year, month, 1),
  );
}

/** Local YYYY-MM-DD for a year/month/day. */
export function dateIso(year: number, month: number, day: number): string {
  return localDateToIso(localNoon(year, month, day));
}

/**
 * Parse YYYY-MM-DD into a full-year-safe local noon Date (the value handed to the
 * native date picker). Years 1-99 are NOT remapped to the 1900s; noon avoids DST
 * day-boundary drift. Pair with `localDateToIso` for the exact round-trip.
 */
export function isoToLocalDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return localNoon(year, month - 1, day);
}

/** Strict HH:mm (00:00–23:59). */
export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

/** RU short date label, e.g. «10 сентября». */
export function formatEventDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(
    localNoon(year, month - 1, day),
  );
}

/** RU full date label, e.g. «Понедельник, 10 сентября». */
export function formatEventFullDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(localNoon(year, month - 1, day));
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/** Display label for an event time; untimed shows «—». */
export function formatEventTime(time: string | undefined): string {
  return time ?? '—';
}

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function formatterParts(date: Date, timeZone: string): DateParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
    };
  } catch {
    return null;
  }
}

function parseLocalDateTime(date: string, time: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match || !timeMatch) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };
  if (!isValidIsoDate(date)) return null;
  return parts;
}

/**
 * Full-year-safe UTC epoch ms for explicit calendar parts. `Date.UTC` remaps
 * years 0-99 to 1900-1999; `setUTCFullYear` does not, so year 1 resolves exactly.
 */
function utcMsFromParts(parts: DateParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, 0, 0);
  return date.getTime();
}

function sameParts(left: DateParts, right: DateParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

/**
 * Converts a wall-clock date/time in an IANA zone to a UTC instant.
 * Offset iteration works across DST without hard-coding any UTC offset.
 * Returns null for invalid dates/times or a nonexistent wall-clock time
 * (e.g. 2026-03-29 03:30 in Europe/Kyiv spring-forward gap).
 */
export function zonedDateTimeToUtc(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  const target = parseLocalDateTime(date, time);
  if (!target) return null;
  const targetAsUtc = utcMsFromParts(target);
  let guess = targetAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const displayed = formatterParts(new Date(guess), timeZone);
    if (!displayed) return null;
    const displayedAsUtc = utcMsFromParts(displayed);
    const correction = targetAsUtc - displayedAsUtc;
    if (correction === 0) break;
    guess += correction;
  }

  const result = new Date(guess);
  const displayed = formatterParts(result, timeZone);
  return displayed && sameParts(displayed, target) ? result : null;
}

/**
 * Resolve a wall-clock date/time in a zone to a UTC instant, choosing the
 * earlier occurrence for a DST fall-back fold (e.g. 2026-10-25 03:30 in
 * Europe/Kyiv repeats). Returns null for invalid/nonexistent times.
 */
export function zonedDateTimeToUtcEarlier(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  const target = parseLocalDateTime(date, time);
  if (!target) return null;
  const targetAsUtc = utcMsFromParts(target);
  let guess = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const displayed = formatterParts(new Date(guess), timeZone);
    if (!displayed) return null;
    const displayedAsUtc = utcMsFromParts(displayed);
    const correction = targetAsUtc - displayedAsUtc;
    if (correction === 0) break;
    guess += correction;
  }
  const result = new Date(guess);
  const displayed = formatterParts(result, timeZone);
  if (!displayed || !sameParts(displayed, target)) return null;
  // For a fold, the iteration above lands on one occurrence; step back one
  // hour and re-check to prefer the earlier occurrence when both exist.
  const earlier = new Date(result.getTime() - 60 * 60 * 1000);
  const earlierDisplayed = formatterParts(earlier, timeZone);
  if (earlierDisplayed && sameParts(earlierDisplayed, target)) return earlier;
  return result;
}