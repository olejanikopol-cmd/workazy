/**
 * Calendar lifecycle (React Native binding).
 *
 * Thin binding over the pure `calendarNotificationController`: registers the
 * foreground notification handler once, hydrates the store, wires AppState and
 * the periodic recheck, and exposes the shared notification/today state to the
 * Calendar screen. All policy (permission merging, single-flight reconciliation,
 * focus/foreground/periodic refresh, active-only ticking) lives in the
 * controller so the code production runs is the code the tests drive.
 *
 * Mounted once at the root layout. Root initialization never blocks navigation:
 * failures surface as visible retryable states, not thrown errors.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { calendarStore } from './useCalendarStore';
import {
  expoCalendarNotifications,
  registerForegroundNotificationHandler,
} from '@/services/notifications/expoCalendarNotifications';
import {
  createCalendarController,
  type CalendarController,
  type CalendarNotificationState,
} from './calendarNotificationController';

const CALENDAR_RECONCILE_RECHECK_MS = 60_000;

const controller: CalendarController = createCalendarController({
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
  return controller.requestReconcile();
}

/** Explicit user action: request alerts/sound, then reconcile. */
export function requestCalendarPermission(): Promise<void> {
  return controller.requestPermission();
}

/** Retry reconciliation after a failure. */
export function retryCalendarReconcile(): void {
  controller.retryReconcile();
}

/** Calendar screen focus: refresh the today marker + reconcile latest state. */
export function focusCalendar(): Promise<Awaited<ReturnType<CalendarController['handleFocus']>>> {
  return controller.handleFocus();
}

/** Refresh the today marker (also called after saving/moving an event). */
export function refreshCalendarToday(): void {
  controller.refreshToday();
}

/** Hook for the Calendar screen to observe notification state. */
export function useCalendarNotifications(): CalendarNotificationState {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

/** Current local date (YYYY-MM-DD), updated on focus/foreground/periodic. */
export function useCalendarToday(): string {
  return useSyncExternalStore(controller.subscribeToday, controller.getToday);
}

/**
 * Root lifecycle hook: register the foreground handler once, hydrate the
 * calendar store, then refresh today + permission + reconcile on foreground and
 * on a periodic recheck that runs only while the app is active.
 */
export function useCalendarLifecycle(): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    registerForegroundNotificationHandler();
    // Synchronize with the REAL current AppState at mount (the module-level
    // controller was created before this hook ran): mounted background/inactive,
    // periodic reconciliation stays gated until an active transition.
    controller.setAppState(AppState.currentState);
    void calendarStore.load().then(() => {
      controller.start();
    });
  }, []);

  useEffect(() => {
    // Periodic recheck runs ONLY while the app is active: no background timer
    // work, no reconciliation/prompting while backgrounded. Returning to the
    // foreground triggers the same refresh immediately.
    const subscription = AppState.addEventListener('change', (nextState) => {
      controller.setAppState(nextState);
    });
    const interval = setInterval(() => {
      controller.handlePeriodicTick();
    }, CALENDAR_RECONCILE_RECHECK_MS);
    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, []);
}
