/**
 * Pure notification contract for the Calendar feature.
 *
 * The Expo binding (`expoCalendarNotifications.ts`) implements this interface;
 * tests inject a fake OS. No general multi-domain notification framework.
 */
import type { CalendarNotificationKind } from '@/types/calendar';
import type { PendingNotification, NotificationPermissionStatus } from './localNotificationContract';


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

export { decodeTriggerEpochMs, decodeTriggerShape, persistedTriggerTarget, NOTIFICATION_TARGET_KEY, TRIGGER_VERIFY_TOLERANCE_MS, SCHEDULE_HANDOFF_BUDGET_MS } from './localNotificationContract';
export type { PendingNotification, PendingTriggerShape, NotificationPermissionStatus } from './localNotificationContract';

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