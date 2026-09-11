/**
 * Calendar domain types for the native app.
 *
 * Compatible with repository `lib/types.ts`; no runtime import from the web app.
 * No completion, Assignment dueDate, duration, timezone, persisted row number or
 * notification ID fields on CalendarEvent — notification bookkeeping lives in
 * the storage envelope (`CalendarNotificationRecord`), not on the event.
 */
export type CalendarEvent = {
  id: string;
  title: string;
  /** Local calendar date YYYY-MM-DD. */
  date: string;
  /** Local wall-clock HH:mm; absent means untimed. */
  time?: string;
  note?: string;
  /** Existing human-readable domain value, e.g. «За 30 минут». */
  reminder?: string;
  createdAt?: string;
  updatedAt?: string;
};

/** Notification kinds for a timed event. */
export type CalendarNotificationKind = 'start' | 'advance';

/**
 * Durable notification bookkeeping record. Persisted in the calendar envelope
 * BEFORE first scheduling an ID and kept as a tombstone until cancellation is
 * confirmed against the OS inventory.
 */
export type CalendarNotificationRecord = {
  /** Deterministic `workazy.calendar.v1:<eventId>:<kind>`. */
  id: string;
  eventId: string;
  kind: CalendarNotificationKind;
  /** Content fingerprint so title-only edits update the notification body. */
  fingerprint: string;
  /** `scheduled` = verified in OS inventory; `tombstone` = awaiting confirmed cancel. */
  status: 'scheduled' | 'tombstone';
  createdAt: string;
  updatedAt: string;
};

/** Persisted envelope under the single native key `workazy-native-calendar-v1`. */
export type CalendarSnapshotV1 = {
  version: 1;
  events: CalendarEvent[];
  registry: CalendarNotificationRecord[];
  /** ISO timestamp captured for the snapshot write. */
  savedAt: string;
};