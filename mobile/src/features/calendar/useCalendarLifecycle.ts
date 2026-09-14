/** Calendar controller binding and compatible UI hooks/commands.
 * Root notification lifecycle/foreground handler now live in the shared fanout;
 * Calendar's controller, store, today marker and permission UX remain unchanged.
 */
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { calendarStore } from './useCalendarStore';
import {
  expoCalendarNotifications,
} from '@/services/notifications/expoCalendarNotifications';
import {
  createCalendarController,
  type CalendarController,
  type CalendarNotificationState,
} from './calendarNotificationController';

export const calendarNotificationController: CalendarController = createCalendarController({
  getState: () => calendarStore.getSnapshot(),
  getRevision: () => calendarStore.getRevision(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  now: () => new Date(),
  clock: () => new Date(),
  // Never assume the app starts active; sync from the real AppState at mount.
  initialAppState: AppState.currentState,
  os: expoCalendarNotifications,
  persistRegistry: async (records) => {
    const result = await calendarStore.setRegistry(records);
    if (!result.ok) throw new Error('registry-write-failed');
  },
});

/**
 * Request an immediate coordinated reconciliation of the LATEST committed
 * state. Resolves after a pass guaranteed to reflect the current events (queues
 * while another pass is in-flight). Used right after CRUD so notification state
 * is consistent as soon as the operation completed.
 */
export function calendarRequestReconcile(): Promise<
  Awaited<ReturnType<CalendarController['requestReconcile']>>
> {
  return calendarNotificationController.requestReconcile();
}

/** Explicit user action: request alerts/sound, then reconcile. */
export function requestCalendarPermission(): Promise<void> {
  return calendarNotificationController.requestPermission();
}

/** Retry reconciliation after a failure. */
export function retryCalendarReconcile(): void {
  calendarNotificationController.retryReconcile();
}

/** Calendar screen focus: refresh the today marker + reconcile latest state. */
export function focusCalendar(): Promise<Awaited<ReturnType<CalendarController['handleFocus']>>> {
  return calendarNotificationController.handleFocus();
}

/** Refresh the today marker (also called after saving/moving an event). */
export function refreshCalendarToday(): void {
  calendarNotificationController.refreshToday();
}

/** Hook for the Calendar screen to observe notification state. */
export function useCalendarNotifications(): CalendarNotificationState {
  return useSyncExternalStore(calendarNotificationController.subscribe, calendarNotificationController.getSnapshot);
}

/** Current local date (YYYY-MM-DD), updated on focus/foreground/periodic. */
export function useCalendarToday(): string {
  return useSyncExternalStore(calendarNotificationController.subscribeToday, calendarNotificationController.getToday);
}
