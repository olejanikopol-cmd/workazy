/**
 * Native calendar persistence: single storage key, versioned envelope
 * (events + notification registry), strict parser/serializer, and the injected
 * key/value storage interface.
 *
 * The parser validates the whole snapshot and never silently repairs rows.
 * Optional timestamps stay omitted when absent. Long titles/notes are accepted
 * on load (input limits are edit rules); the full snapshot is rejected on any
 * structural violation.
 */
import type {
  CalendarEvent,
  CalendarNotificationRecord,
  CalendarSnapshotV1,
} from '@/types/calendar';
import { isValidIsoDate, isValidIsoTimestamp } from '@/features/plans/planDates';
import { isValidTime } from '@/features/calendar/calendarDates';

/** Distinct key from the web planner's browser-storage key. */
export const CALENDAR_STORAGE_KEY = 'workazy-native-calendar-v1';

export type CalendarStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type CalendarSnapshotParseResult =
  | { ok: true; snapshot: CalendarSnapshotV1 }
  | { ok: false; error: string };

export function serializeSnapshot(
  events: readonly CalendarEvent[],
  registry: readonly CalendarNotificationRecord[],
  savedAt: string,
): string {
  const snapshot: CalendarSnapshotV1 = {
    version: 1,
    events: events.map((event) => ({ ...event })),
    registry: registry.map((record) => ({ ...record })),
    savedAt,
  };
  return JSON.stringify(snapshot);
}

function parseEvent(rawItem: unknown): CalendarEvent | null {
  if (rawItem === null || typeof rawItem !== 'object') return null;
  const item = rawItem as Record<string, unknown>;
  if (typeof item.id !== 'string' || item.id.length === 0) return null;
  if (typeof item.title !== 'string' || item.title.trim().length === 0) return null;
  if (typeof item.date !== 'string' || !isValidIsoDate(item.date)) return null;
  if (
    item.time !== undefined &&
    (typeof item.time !== 'string' || (item.time !== '' && !isValidTime(item.time)))
  ) {
    return null;
  }
  if (item.note !== undefined && typeof item.note !== 'string') return null;
  if (item.reminder !== undefined && typeof item.reminder !== 'string') return null;
  if (
    item.createdAt !== undefined &&
    (typeof item.createdAt !== 'string' || !isValidIsoTimestamp(item.createdAt))
  ) {
    return null;
  }
  if (
    item.updatedAt !== undefined &&
    (typeof item.updatedAt !== 'string' || !isValidIsoTimestamp(item.updatedAt))
  ) {
    return null;
  }
  const event: CalendarEvent = {
    id: item.id,
    title: item.title,
    date: item.date,
  };
  if (item.time !== undefined && item.time !== '') event.time = item.time;
  if (item.note !== undefined && item.note !== '') event.note = item.note;
  if (item.reminder !== undefined) event.reminder = item.reminder;
  if (item.createdAt !== undefined) event.createdAt = item.createdAt;
  if (item.updatedAt !== undefined) event.updatedAt = item.updatedAt;
  return event;
}

function parseRegistryRecord(rawItem: unknown): CalendarNotificationRecord | null {
  if (rawItem === null || typeof rawItem !== 'object') return null;
  const item = rawItem as Record<string, unknown>;
  if (typeof item.id !== 'string' || item.id.length === 0) return null;
  if (typeof item.eventId !== 'string' || item.eventId.length === 0) return null;
  if (item.kind !== 'start' && item.kind !== 'advance') return null;
  if (typeof item.fingerprint !== 'string') return null;
  if (item.status !== 'scheduled' && item.status !== 'tombstone') return null;
  if (
    typeof item.createdAt !== 'string' ||
    !isValidIsoTimestamp(item.createdAt) ||
    typeof item.updatedAt !== 'string' ||
    !isValidIsoTimestamp(item.updatedAt)
  ) {
    return null;
  }
  return {
    id: item.id,
    eventId: item.eventId,
    kind: item.kind,
    fingerprint: item.fingerprint,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function parseSnapshot(raw: string): CalendarSnapshotParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'not-object' };
  }
  const object = parsed as Record<string, unknown>;
  if (object.version !== 1) return { ok: false, error: 'unknown-version' };
  if (!Array.isArray(object.events)) return { ok: false, error: 'events-not-array' };
  if (!Array.isArray(object.registry)) return { ok: false, error: 'registry-not-array' };
  if (typeof object.savedAt !== 'string' || !isValidIsoTimestamp(object.savedAt)) {
    return { ok: false, error: 'bad-saved-at' };
  }

  const events: CalendarEvent[] = [];
  const seenEventIds = new Set<string>();
  for (const rawItem of object.events) {
    const event = parseEvent(rawItem);
    if (!event) return { ok: false, error: 'bad-event' };
    if (seenEventIds.has(event.id)) return { ok: false, error: 'duplicate-event-id' };
    seenEventIds.add(event.id);
    events.push(event);
  }

  const registry: CalendarNotificationRecord[] = [];
  const seenRecordIds = new Set<string>();
  for (const rawItem of object.registry) {
    const record = parseRegistryRecord(rawItem);
    if (!record) return { ok: false, error: 'bad-registry-record' };
    if (seenRecordIds.has(record.id)) return { ok: false, error: 'duplicate-registry-id' };
    seenRecordIds.add(record.id);
    registry.push(record);
  }

  return {
    ok: true,
    snapshot: { version: 1, events, registry, savedAt: object.savedAt },
  };
}