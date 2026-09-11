/**
 * Pure calendar-event mutations, selectors and input validation.
 *
 * One ordered events array contains all dates; the agenda is derived per day
 * (timed ascending HH:mm, untimed last, equal times in stored order) and never
 * rewrites stored order. IDs are mutation targets; duplicate titles allowed.
 * Mutations return a discarded `events` array; they never mutate input.
 */
import type { CalendarEvent } from '@/types/calendar';
import { isValidIsoDate, isValidTime } from './calendarDates';

export const EVENT_TITLE_MAX_LENGTH = 300;
export const EVENT_NOTE_MAX_LENGTH = 1000;

export type CalendarValidationFailure = { ok: false; reason: 'validation' | 'missing' };

export type CalendarAddResult =
  | { ok: true; events: readonly CalendarEvent[]; event: CalendarEvent }
  | CalendarValidationFailure;

export type CalendarEventsResult =
  | { ok: true; events: readonly CalendarEvent[] }
  | CalendarValidationFailure;

export type CalendarEventInput = {
  title: string;
  date: string;
  time?: string;
  note?: string;
  reminder?: string;
};

export type CalendarAddInput = CalendarEventInput & {
  id: string;
  now: Date;
};

export type TitleValidation =
  | { ok: true; title: string }
  | { ok: false; reason: 'blank' | 'too-long' };

export type NoteValidation =
  | { ok: true; note: string }
  | { ok: false; reason: 'too-long' };

/** Trim outer whitespace and require 1–300 characters; internal newlines kept. */
export function validateEventTitle(raw: string): TitleValidation {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, reason: 'blank' };
  if (title.length > EVENT_TITLE_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  return { ok: true, title };
}

/** Trim outer whitespace; optional note up to 1000 characters. */
export function validateEventNote(raw: string | undefined): NoteValidation {
  const note = (raw ?? '').trim();
  if (note.length > EVENT_NOTE_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  return { ok: true, note };
}

/** Validate the full event input; returns normalized fields or a failure. */
export function validateEventInput(
  input: CalendarEventInput,
): { ok: true; input: CalendarEventInput } | { ok: false; reason: 'validation' } {
  const title = validateEventTitle(input.title);
  if (!title.ok) return { ok: false, reason: 'validation' };
  if (!isValidIsoDate(input.date)) return { ok: false, reason: 'validation' };
  if (input.time !== undefined && input.time !== '' && !isValidTime(input.time)) {
    return { ok: false, reason: 'validation' };
  }
  const note = validateEventNote(input.note);
  if (!note.ok) return { ok: false, reason: 'validation' };
  return {
    ok: true,
    input: {
      title: title.title,
      date: input.date,
      time: input.time === '' ? undefined : input.time,
      note: note.note === '' ? undefined : note.note,
      reminder: input.reminder,
    },
  };
}

/** Append a new event; used by the store's `add`. */
export function addEvent(
  events: readonly CalendarEvent[],
  input: CalendarAddInput,
): CalendarAddResult {
  const validated = validateEventInput(input);
  if (!validated.ok) return { ok: false, reason: 'validation' };
  const nowIso = input.now.toISOString();
  const event: CalendarEvent = {
    id: input.id,
    title: validated.input.title,
    date: validated.input.date,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (validated.input.time !== undefined) event.time = validated.input.time;
  if (validated.input.note !== undefined) event.note = validated.input.note;
  if (validated.input.reminder !== undefined) event.reminder = validated.input.reminder;
  return { ok: true, events: [...events, event], event };
}

/**
 * Edit preserves id/createdAt/array position; only content fields and
 * `updatedAt` change. Date changes move the event to that day's agenda.
 */
export function editEvent(
  events: readonly CalendarEvent[],
  id: string,
  input: CalendarEventInput,
  now: Date,
): CalendarEventsResult {
  const target = events.find((event) => event.id === id);
  if (!target) return { ok: false, reason: 'missing' };
  const validated = validateEventInput(input);
  if (!validated.ok) return { ok: false, reason: 'validation' };
  const updatedAt = now.toISOString();
  return {
    ok: true,
    events: events.map((event) => {
      if (event.id !== id) return event;
      const next: CalendarEvent = {
        ...event,
        title: validated.input.title,
        date: validated.input.date,
        updatedAt,
      };
      if (validated.input.time !== undefined) next.time = validated.input.time;
      else delete next.time;
      if (validated.input.note !== undefined) next.note = validated.input.note;
      else delete next.note;
      if (validated.input.reminder !== undefined) next.reminder = validated.input.reminder;
      else delete next.reminder;
      return next;
    }),
  };
}

/** Remove exactly one event by ID. */
export function removeEvent(events: readonly CalendarEvent[], id: string): CalendarEventsResult {
  if (!events.some((event) => event.id === id)) return { ok: false, reason: 'missing' };
  return { ok: true, events: events.filter((event) => event.id !== id) };
}

/** All events for a date, preserving the global array order. */
export function eventsForDate(events: readonly CalendarEvent[], date: string): CalendarEvent[] {
  return events.filter((event) => event.date === date);
}

/**
 * Derived agenda for a day: timed events ascending HH:mm, untimed last, equal
 * times in stored array order. Never rewrites stored order.
 */
export function agendaForDate(events: readonly CalendarEvent[], date: string): CalendarEvent[] {
  return eventsForDate(events, date).sort((a, b) => {
    if (a.time === undefined && b.time === undefined) return 0;
    if (a.time === undefined) return 1;
    if (b.time === undefined) return -1;
    if (a.time === b.time) return 0;
    return a.time < b.time ? -1 : 1;
  });
}

/** True when a date has at least one event (month-grid dot). */
export function hasEventsOnDate(events: readonly CalendarEvent[], date: string): boolean {
  return events.some((event) => event.date === date);
}

/**
 * Existing human-readable reminder parser, mirroring the web scheduler.
 * Missing/empty/«Не напоминать»/unrecognized → null (no *additional* alert).
 * «В момент события» → 0. Minute/hour/day strings capped at 10080 minutes.
 */
export function parseReminderMinutes(reminder?: string | null): number | null {
  const normalized = reminder?.trim().toLocaleLowerCase('ru-RU') ?? '';
  if (!normalized || normalized === 'не напоминать') return null;
  if (normalized === 'в момент события') return 0;
  const minuteMatch = /^за\s+(\d+)\s+мин/.exec(normalized);
  if (minuteMatch) return Math.min(Number(minuteMatch[1]), 7 * 24 * 60);
  const hourMatch = /^за\s+(\d+)\s+час/.exec(normalized);
  if (hourMatch) return Math.min(Number(hourMatch[1]) * 60, 7 * 24 * 60);
  const dayMatch = /^за\s+(\d+)\s+д/.exec(normalized);
  if (dayMatch) return Math.min(Number(dayMatch[1]) * 24 * 60, 7 * 24 * 60);
  return null;
}

/** Human-readable reminder label for an event (agenda row). */
export function reminderLabel(reminder: string | undefined): string {
  const minutes = parseReminderMinutes(reminder);
  if (minutes === null || minutes === 0) return 'В момент события';
  if (minutes === 10) return 'За 10 минут';
  if (minutes === 30) return 'За 30 минут';
  if (minutes === 60) return 'За 1 час';
  return `За ${minutes} минут`;
}