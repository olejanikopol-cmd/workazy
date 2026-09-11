/**
 * Pure notification planner: derives desired future Calendar notification
 * requests from committed events and the current local timezone.
 *
 * Every timed event gets an event-time alert; the optional advance is an
 * additional alert 10/30/60 minutes before (or any parsed minute/hour/day value
 * capped at 10080). Untimed events and past triggers produce no requests.
 */
import type { CalendarEvent, CalendarNotificationKind } from '@/types/calendar';
import { zonedDateTimeToUtcEarlier } from '@/features/calendar/calendarDates';
import { parseReminderMinutes } from '@/features/calendar/calendarModel';
import {
  notificationId,
  type CalendarNotificationRequest,
} from './calendarNotificationContract';

export const NOTIFICATION_TITLE = 'Workazy';

/** Content fingerprint so title-only edits update the notification body. */
export function makeFingerprint(
  triggerAt: number,
  event: Pick<CalendarEvent, 'title' | 'time'>,
  kind: CalendarNotificationKind,
): string {
  return `${triggerAt}|${event.title}|${event.time ?? ''}|${kind}`;
}

/** Notification body: event title + time; never includes the note. */
export function makeNotificationBody(
  event: Pick<CalendarEvent, 'title' | 'time'>,
): string {
  return event.time ? `${event.title} · ${event.time}` : event.title;
}

/** A timed event whose local wall-clock time does not exist in `timeZone`. */
export type UnscheduleableEvent = {
  eventId: string;
  /** Local YYYY-MM-DD kept in the store. */
  date: string;
  /** Local HH:mm kept in the store. */
  time: string;
  title: string;
};

function wallClockOf(instant: Date, timeZone: string): string {
  let year = '0';
  let month = '0';
  let day = '0';
  let hour = '0';
  let minute = '0';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    for (const part of parts) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
      else if (part.type === 'hour') hour = part.value;
      else if (part.type === 'minute') minute = part.value;
    }
  } catch {
    return '9999-99-99 99:99'; // unknown timezone => treat as past, no warning
  }
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * Timed events whose wall-clock time does not exist in the current timezone
 * (DST spring-forward gap). Such events can never be scheduled as reminders, so
 * the reconciler reports them so the UI can show an honest warning instead of
 * silently dropping their previous notifications. Only FUTURE events are
 * warned about (a past gap is simply past). The condition clears automatically
 * once the device timezone changes to one where the local time exists.
 */
export function planCalendarUnscheduleable(
  events: readonly CalendarEvent[],
  now: Date,
  timeZone: string,
): UnscheduleableEvent[] {
  const nowWall = wallClockOf(now, timeZone);
  const result: UnscheduleableEvent[] = [];
  for (const event of events) {
    if (!event.time) continue;
    if (zonedDateTimeToUtcEarlier(event.date, event.time, timeZone) !== null) continue;
    const eventWall = `${event.date} ${event.time}`;
    if (eventWall <= nowWall) continue; // past or invalid — not a warning
    result.push({ eventId: event.id, date: event.date, time: event.time, title: event.title });
  }
  return result;
}

function makeRequest(
  event: CalendarEvent,
  kind: CalendarNotificationKind,
  triggerAt: number,
): CalendarNotificationRequest {
  return {
    id: notificationId(event.id, kind),
    eventId: event.id,
    kind,
    triggerAt,
    title: NOTIFICATION_TITLE,
    body: makeNotificationBody(event),
    fingerprint: makeFingerprint(triggerAt, event, kind),
  };
}

/**
 * Desired future requests for all events, ordered by trigger instant then
 * eventId then kind. Past triggers are never included (no immediate alerts).
 *
 * Derivation uses `zonedDateTimeToUtcEarlier`: a DST fall-back fold (e.g.
 * Europe/Kyiv 2026-10-25 03:30, which repeats) resolves to the earlier
 * occurrence (2026-10-25T00:30:00.000Z); a spring-forward gap (e.g.
 * 2026-03-29 03:30, which does not exist) resolves to null and produces NO
 * request — the selected local time cannot be scheduled there.
 */
export function planCalendarRequests(
  events: readonly CalendarEvent[],
  now: Date,
  timeZone: string,
): CalendarNotificationRequest[] {
  const requests: CalendarNotificationRequest[] = [];
  const nowMs = now.getTime();
  for (const event of events) {
    if (!event.time) continue; // untimed → no notification
    const startsAt = zonedDateTimeToUtcEarlier(event.date, event.time, timeZone);
    if (!startsAt) continue; // invalid/nonexistent wall-clock time
    const startsAtMs = startsAt.getTime();
    if (startsAtMs > nowMs) {
      requests.push(makeRequest(event, 'start', startsAtMs));
    }
    const minutes = parseReminderMinutes(event.reminder);
    if (minutes !== null && minutes > 0) {
      const advanceAtMs = startsAtMs - minutes * 60_000;
      if (advanceAtMs > nowMs) {
        requests.push(makeRequest(event, 'advance', advanceAtMs));
      }
    }
  }
  return requests.sort(
    (a, b) => a.triggerAt - b.triggerAt || a.eventId.localeCompare(b.eventId) || a.kind.localeCompare(b.kind),
  );
}