/**
 * Pure calendar-notification controller (no React Native imports).
 *
 * Owns everything production uses outside JSX:
 * - the shared notification state + the "today" marker with subscribers;
 * - the single-flight reconciliation queue (coordinated passes against the
 *   latest committed store state);
 * - race-safe permission merging: a permission result is merged into the LATEST
 *   state AFTER the await, so a delayed response can never erase a newer
 *   scheduling error, a newer DST-gap warning, or a newer cleared warning;
 * - the focus/foreground/periodic refresh policy (periodic only while active).
 *
 * `useCalendarLifecycle.ts` is the thin React Native binding for this
 * controller, so the logic exercised by production is exactly the logic the
 * unit tests drive.
 */
import { runCoordinatedReconcile } from '@/services/notifications/calendarReconcileCoordinator';
import type { ReconcileResult } from '@/services/notifications/calendarNotificationReconciler';
import type { UnscheduleableEvent } from '@/services/notifications/calendarNotificationPlanner';
import type {
  CalendarNotificationContract,
  NotificationPermissionStatus,
} from '@/services/notifications/calendarNotificationContract';
import type { CalendarEvent, CalendarNotificationRecord } from '@/types/calendar';

export type CalendarReconcileStatus = 'idle' | 'running' | 'ok' | 'error';

export type CalendarNotificationState = {
  permission: NotificationPermissionStatus | null;
  reconcileStatus: CalendarReconcileStatus;
  reconcileError: string | null;
  capacityLimited: boolean;
  /**
   * Future events whose local wall-clock time does not exist in the current
   * timezone (DST gap): their reminders cannot be scheduled. Surfaced so the UI
   * can warn honestly; cleared automatically once a later pass makes them
   * schedulable again.
   */
  unschedulable: readonly UnscheduleableEvent[];
};

export type CalendarStoreState = {
  phase: 'loading' | 'ready' | 'load-error';
  events: readonly CalendarEvent[];
  registry: readonly CalendarNotificationRecord[];
};

export type CalendarControllerDeps = {
  getState(): CalendarStoreState;
  getRevision(): number;
  timeZone(): string;
  now(): Date;
  clock(): Date;
  os: CalendarNotificationContract;
  persistRegistry(records: readonly CalendarNotificationRecord[]): Promise<void>;
  /**
   * AppState at mount time (production passes `AppState.currentState`). The
   * controller NEVER assumes it starts active: mounted in background/inactive,
   * `start()` and the periodic recheck do no work until an active transition.
   */
  initialAppState: string;
};

export type CalendarController = {
  getSnapshot(): CalendarNotificationState;
  subscribe(listener: () => void): () => void;
  getToday(): string;
  subscribeToday(listener: () => void): () => void;
  refreshToday(): void;
  /** Merge a reconciliation result into the latest state (coordinator onResult). */
  applyResult(result: ReconcileResult | null): void;
  refreshPermission(): Promise<void>;
  requestPermission(): Promise<void>;
  requestReconcile(): Promise<ReconcileResult | null>;
  retryReconcile(): void;
  /**
   * After hydration: refresh today/permission and reconcile — but only while
   * the app is active (mounted in background/inactive, the deferred work runs on
   * the next active transition instead).
   */
  start(): void;
  /** Calendar screen focus: refresh today + reconcile the latest state. */
  handleFocus(): Promise<ReconcileResult | null>;
  /** AppState change; returning to `active` triggers an immediate refresh. */
  setAppState(next: string): void;
  /** Periodic recheck; returns false (no work) unless the app is active. */
  handlePeriodicTick(): boolean;
  isActive(): boolean;
};

const PERMISSION_REQUEST_ERROR = 'Не удалось запросить разрешение.';

function isoLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createCalendarController(deps: CalendarControllerDeps): CalendarController {
  let state: CalendarNotificationState = {
    permission: null,
    reconcileStatus: 'idle',
    reconcileError: null,
    capacityLimited: false,
    unschedulable: [],
  };
  const listeners = new Set<() => void>();
  let today = isoLocalDate(deps.clock());
  const todayListeners = new Set<() => void>();
  let flight: Promise<void> | null = null;
  const pendingRequests: ((result: ReconcileResult | null) => void)[] = [];
  let appState = deps.initialAppState;

  function publish(): void {
    for (const listener of listeners) listener();
  }

  function applyResult(result: ReconcileResult | null): void {
    if (result === null) return;
    state = {
      ...state,
      reconcileStatus: result.status === 'error' ? 'error' : result.status === 'ok' ? 'ok' : 'idle',
      reconcileError: result.error,
      capacityLimited: result.capacityLimited,
      unschedulable: result.unschedulable,
    };
    publish();
  }

  function pump(): void {
    if (flight) return;
    const requests = pendingRequests.splice(0);
    if (!requests.length) return;
    flight = (async () => {
      const result = await runCoordinatedReconcile({
        getState: () => deps.getState(),
        getRevision: () => deps.getRevision(),
        now: deps.now(),
        clock: deps.clock,
        timeZone: deps.timeZone,
        os: deps.os,
        persistRegistry: deps.persistRegistry,
        onResult: applyResult,
      });
      for (const resolve of requests) resolve(result);
    })().finally(() => {
      flight = null;
      if (pendingRequests.length) pump();
    });
  }

  /** Request a pass over the LATEST committed state (queues while in-flight). */
  function requestReconcile(): Promise<ReconcileResult | null> {
    return new Promise<ReconcileResult | null>((resolve) => {
      pendingRequests.push(resolve);
      pump();
    });
  }

  /**
   * Read permission without prompting. The result is merged into the state
   * observed AFTER the await, so a delayed response cannot erase a scheduling
   * error, a DST-gap warning, or a cleared warning published meanwhile.
   */
  async function refreshPermission(): Promise<void> {
    let permission: NotificationPermissionStatus;
    try {
      permission = await deps.os.getPermissions();
    } catch {
      return; // keep previous permission; reconciliation surfaces visible errors
    }
    state = { ...state, permission };
    publish();
  }

  /** Explicit user action: request alerts/sound (race-safe), then reconcile. */
  async function requestPermission(): Promise<void> {
    try {
      const permission = await deps.os.requestPermissions();
      state = { ...state, permission };
    } catch {
      state = { ...state, reconcileError: PERMISSION_REQUEST_ERROR };
    }
    publish();
    await requestReconcile();
  }

  function refreshToday(): void {
    const next = isoLocalDate(deps.clock());
    if (next !== today) {
      today = next;
      for (const listener of todayListeners) listener();
    }
  }

  function tick(): void {
    refreshToday();
    void refreshPermission();
    void requestReconcile();
  }

  function setAppState(next: string): void {
    appState = next;
    if (next === 'active') tick();
  }

  function handlePeriodicTick(): boolean {
    if (appState !== 'active') return false; // no background timer work
    tick();
    return true;
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getToday: () => today,
    subscribeToday(listener) {
      todayListeners.add(listener);
      return () => {
        todayListeners.delete(listener);
      };
    },
    refreshToday,
    applyResult,
    refreshPermission,
    requestPermission,
    requestReconcile,
    retryReconcile: () => {
      void requestReconcile();
    },
    start: () => {
      if (appState !== 'active') return; // no work while backgrounded/inactive
      tick();
    },
    handleFocus: () => {
      refreshToday();
      return requestReconcile();
    },
    setAppState,
    handlePeriodicTick,
    isActive: () => appState === 'active',
  };
}

