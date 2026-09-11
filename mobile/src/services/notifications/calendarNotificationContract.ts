/**
 * Pure notification contract for the Calendar feature.
 *
 * The Expo binding (`expoCalendarNotifications.ts`) implements this interface;
 * tests inject a fake OS. No general multi-domain notification framework.
 */
import type { CalendarNotificationKind } from '@/types/calendar';

export const NOTIFICATION_NAMESPACE = 'workazy.calendar.v1';
export const NOTIFICATION_OWNER = 'workazy-calendar-v1';

export type CalendarNotificationRequest = {
  /** Deterministic `workazy.calendar.v1:<eventId>:<kind>`. */
  id: string;
  eventId: string;
  kind: CalendarNotificationKind;
  /** UTC epoch ms trigger instant. */
  triggerAt: number;
  title: string;
  body: string;
  /** Content fingerprint: trigger instant + event title/time + kind. */
  fingerprint: string;
};

export type PendingNotification = {
  identifier: string;
  /** UTC epoch ms trigger instant, or null when not derivable. */
  triggerAt: number | null;
  /**
   * Decoded native trigger family. Verification uses it to choose the correct
   * comparison: `interval` (iOS stores a one-shot DATE alert as a
   * UNTimeIntervalNotificationTrigger whose native interval is computed from the
   * native clock AFTER the JS call, so it legitimately drifts) vs `absolute`
   * (date/calendar/epoch shapes, which must match strictly).
   */
  triggerShape: PendingTriggerShape;
  data: Record<string, unknown> | null;
  contentTitle: string;
  contentBody: string;
};

/** Decoded native trigger family used to pick the verification tolerance. */
export type PendingTriggerShape = 'absolute' | 'interval' | 'unknown';

export type NotificationPermissionStatus = {
  /** Alerts/sound usable (authorized or provisional). */
  granted: boolean;
  /** iOS provisional authorization — usable but quiet delivery. */
  provisional: boolean;
  /** User can still be asked (not denied with cannotAskAgain). */
  canAskAgain: boolean;
  status: 'granted' | 'denied' | 'undetermined' | 'provisional' | 'ephemeral';
};

export type CalendarNotificationContract = {
  getPermissions(): Promise<NotificationPermissionStatus>;
  requestPermissions(): Promise<NotificationPermissionStatus>;
  listPending(): Promise<PendingNotification[]>;
  schedule(request: CalendarNotificationRequest): Promise<string>;
  cancel(id: string): Promise<void>;
};

/** Deterministic notification ID for an event/kind. */
export function notificationId(eventId: string, kind: CalendarNotificationKind): string {
  return `${NOTIFICATION_NAMESPACE}:${eventId}:${kind}`;
}

/** Tolerance for trigger verification of records WITHOUT a persisted target instant (±2 s). */
export const TRIGGER_VERIFY_TOLERANCE_MS = 2_000;

/**
 * Conservative upper bound for the JS→native scheduling handoff on iOS.
 *
 * The native clock used when iOS computes `date.timeIntervalSinceNow` is NOT our
 * JS clock, so the native interval can legitimately be shorter than the intended
 * one by the bridge/native scheduling latency (plus <1 s whole-second truncation
 * in the native `DateTriggerRecord`). This budget is a CONSERVATIVE app policy
 * for that handoff — it is exercised by simulated latency in tests, not by
 * measured device evidence (native/device verification is still pending).
 *
 * It applies ONLY to the iOS `interval` trigger family; absolute/date/calendar
 * shapes must match strictly (see `TRIGGER_VERIFY_TOLERANCE_MS`).
 */
export const SCHEDULE_HANDOFF_BUDGET_MS = 30_000;

/** Content-data key holding the exact UTC epoch-ms instant we asked the OS to fire at. */
export const NOTIFICATION_TARGET_KEY = 'targetTriggerAt';

/**
 * Absolute trigger instant persisted INSIDE the scheduled request. Unlike a
 * value re-derived from the native trigger shape, this is exact: it travels
 * with the notification and is the authoritative verification target.
 */
export function persistedTriggerTarget(data: Record<string, unknown> | null): number | null {
  if (data === null) return null;
  const value = data[NOTIFICATION_TARGET_KEY];
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

/**
 * Decode a scheduled-notification trigger into a UTC epoch-ms instant.
 *
 * The installed expo-notifications SDK uses different shapes depending on the
 * code path and platform:
 * - the JS schedule API accepts `{ type: 'date', date: Date }`;
 * - the native scheduler returns `{ type: 'date', timestamp: number }` and —
 *   for a one-shot DATE trigger on iOS — `{ type: 'timeInterval', seconds,
 *   repeats: true|false }`, because iOS stores a non-repeating date alert as a
 *   UNTimeIntervalNotificationTrigger whose `seconds` is the interval measured
 *   at schedule time (see ExpoNotifications DateTriggerRecord/NotificationRecords).
 * - a bare epoch `number` is also tolerated.
 *
 * A timeInterval trigger has no absolute instant by itself: it must be paired
 * with the schedule context recorded by the adapter in the notification
 * content data (`scheduledAt` = JS epoch ms at schedule call). The first
 * occurrence is `scheduledAt + seconds * 1000`, which is also correct for
 * repeating intervals. Without that context a timeInterval is undecodable and
 * yields null; foreign/unknown triggers are excluded earlier by the ownership
 * check, so nothing owned is ever dropped on this alone.
 */
export function decodeTriggerEpochMs(trigger: unknown, scheduledAt?: number): number | null {
  if (typeof trigger === 'number') {
    return Number.isNaN(trigger) ? null : trigger;
  }
  if (trigger === null || typeof trigger !== 'object') return null;
  const value = trigger as Record<string, unknown>;
  if (typeof value.timestamp === 'number') {
    return Number.isNaN(value.timestamp) ? null : value.timestamp;
  }
  if (typeof value.date === 'number') {
    return Number.isNaN(value.date) ? null : value.date;
  }
  if (typeof value.date === 'object' && value.date instanceof Date) {
    return value.date.getTime();
  }
  if (value.type === 'timeInterval') {
    const seconds = value.seconds;
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) return null;
    if (typeof scheduledAt === 'number' && !Number.isNaN(scheduledAt)) {
      return scheduledAt + seconds * 1000;
    }
    return null;
  }
  return null;
}

/**
 * Classify a native trigger shape. Only `absolute` and `interval` are
 * verifiable; anything else is `unknown` and must fail verification rather than
 * be accepted on metadata alone.
 */
export function decodeTriggerShape(trigger: unknown): PendingTriggerShape {
  if (typeof trigger === 'number') return Number.isNaN(trigger) ? 'unknown' : 'absolute';
  if (trigger === null || typeof trigger !== 'object') return 'unknown';
  const value = trigger as Record<string, unknown>;
  if (typeof value.timestamp === 'number' || typeof value.date === 'number') return 'absolute';
  if (typeof value.date === 'object' && value.date instanceof Date) return 'absolute';
  if (value.type === 'timeInterval' && typeof value.seconds === 'number') return 'interval';
  return 'unknown';
}

/** True when a pending notification is owned by this feature. */
export function isOwnedNotification(pending: PendingNotification): boolean {
  if (pending.identifier.startsWith(`${NOTIFICATION_NAMESPACE}:`)) return true;
  return pending.data?.owner === NOTIFICATION_OWNER;
}

/** Extract the ownership metadata from a pending notification. */
export function ownershipOf(
  pending: PendingNotification,
): { eventId: string; kind: CalendarNotificationKind; fingerprint: string } | null {
  const data = pending.data ?? {};
  if (data.owner !== NOTIFICATION_OWNER) return null;
  if (typeof data.eventId !== 'string' || typeof data.fingerprint !== 'string') return null;
  if (data.kind !== 'start' && data.kind !== 'advance') return null;
  return { eventId: data.eventId, kind: data.kind, fingerprint: data.fingerprint };
}