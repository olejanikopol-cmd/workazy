/**
 * Pure reconciliation coordinator: runs the reconciler against the LATEST
 * committed store state, aborts an in-flight pass as soon as newer event
 * mutations commit, and re-runs with the newest snapshot until stable.
 *
 * This prevents an older in-flight reconciliation from keeping or adding
 * notifications for deleted/edited events, and guarantees that every pass
 * merged into durable state was computed from a committed (not stale) event
 * list. Clock/timezone changes are picked up because the next pass re-reads
 * the current timezone and the fresh `clock` per schedule decision.
 */
import { reconcileCalendarNotifications, type ReconcileResult } from './calendarNotificationReconciler';
import type { CalendarEvent, CalendarNotificationRecord } from '@/types/calendar';
import type { CalendarNotificationContract } from './calendarNotificationContract';

export const MAX_COORDINATED_PASSES = 16;

export type CoordinatedReconcileInput = {
  getState(): {
    phase: 'loading' | 'ready' | 'load-error';
    events: readonly CalendarEvent[];
    registry: readonly CalendarNotificationRecord[];
  };
  /** Monotonic revision of committed event state. */
  getRevision(): number;
  /** Fallback initial instant; per-pass clock also taken from `clock`. */
  now: Date;
  clock?: () => Date;
  timeZone(): string;
  os: CalendarNotificationContract;
  persistRegistry: (records: readonly CalendarNotificationRecord[]) => Promise<void>;
  maxPending?: number;
  onResult?: (result: ReconcileResult | null) => void;
};

/**
 * Runs passes until the committed event revision stops changing or the pass
 * completed without abort. Returns the last completed result (null if never
 * ready). `onResult` is invoked after every pass so the UI can observe
 * running/ok/error/capacity state.
 */
export async function runCoordinatedReconcile(
  input: CoordinatedReconcileInput,
): Promise<ReconcileResult | null> {
  let last: ReconcileResult | null = null;
  for (let pass = 0; pass < MAX_COORDINATED_PASSES; pass += 1) {
    const state = input.getState();
    if (state.phase !== 'ready') return last;
    const revisionAtStart = input.getRevision();
    last = await reconcileCalendarNotifications({
      events: state.events,
      registry: state.registry,
      now: input.clock ? input.clock() : input.now,
      clock: input.clock,
      timeZone: input.timeZone(),
      os: input.os,
      persistRegistry: input.persistRegistry,
      maxPending: input.maxPending,
      shouldAbort: () => input.getRevision() !== revisionAtStart,
    });
    if (input.onResult) input.onResult(last);
    if (input.getRevision() === revisionAtStart) break;
  }
  return last;
}