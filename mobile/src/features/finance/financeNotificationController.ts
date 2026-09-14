import type { FinanceState } from './financeStore';
import type { FinanceNotificationRegistry } from '@/storage/financeNotificationStorage';
import { localNotificationReconcileQueue } from '@/services/notifications/localNotificationReconcileQueue';
import { reconcileFinanceNotifications, type FinanceReconcileResult } from '@/services/notifications/financeNotificationReconciler';
import type { LocalNotificationOS } from '@/services/notifications/localNotificationContract';
export type FinanceNotificationState = FinanceReconcileResult & { running: boolean; revision: number };
export function createFinanceNotificationController(deps: {
  getState(): FinanceState; subscribe(listener: () => void): () => void; load(): Promise<void>;
  registry: FinanceNotificationRegistry; os: LocalNotificationOS; clock(): Date; timeZone(): string;
}) {
  let state: FinanceNotificationState = { status: 'ok', error: null, permission: null, rows: {}, running: false, revision: -1 };
  const listeners = new Set<() => void>();
  let flight: Promise<void> | null = null;
  let epoch = 0;
  let stopped = true;
  const publish = (next: FinanceNotificationState) => { state = next; for (const listener of listeners) listener(); };
  function request(): Promise<void> {
    epoch++;
    // Invalidate confirmed badges as soon as reconciliation is requested.
    publish({ ...state, running: true, rows: {} });
    if (flight) return flight;
    let finishedEpoch = epoch;
    flight = Promise.resolve().then(async () => {
      for (let pass = 0; pass < 16; pass++) {
        const result = await localNotificationReconcileQueue.run(async () => {
          const current = deps.getState();
          const registry = deps.registry.getState();
          const captured = epoch;
          const revision = current.snapshot.revision;
          if (current.phase !== 'ready' || registry.phase !== 'ready') {
            return { captured, revision, result: { status: 'error' as const, error: current.phase !== 'ready' ? 'finance-load' : 'registry-read', rows: {}, permission: state.permission } };
          }
          const zone = deps.timeZone();
          const shouldAbort = () => epoch !== captured || deps.getState().phase !== 'ready' || deps.getState().snapshot.revision !== revision || deps.timeZone() !== zone;
          const result = await reconcileFinanceNotifications({ obligations: current.snapshot.obligations,
            records: registry.records, os: deps.os, clock: deps.clock, timeZone: zone, shouldAbort,
            persist: deps.registry.persist });
          return { captured, revision, result };
        });
        if (result.captured !== epoch || result.revision !== deps.getState().snapshot.revision || result.result.status === 'aborted') continue;
        finishedEpoch = result.captured;
        publish({ ...result.result, revision: result.revision, running: false });
        return;
      }
      finishedEpoch = epoch;
      publish({ ...state, rows: {}, status: 'error', error: 'retry-latest', running: false });
    }).catch(() => {
      finishedEpoch = epoch;
      publish({ ...state, rows: {}, status: 'error', error: 'notification-error', running: false });
    }).finally(() => { flight = null; if (epoch !== finishedEpoch && !stopped) void request(); });
    return flight;
  }
  async function hydrate(retry = false) {
    await Promise.all([deps.load(), deps.registry.load(retry)]);
    if (!stopped) await request();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    request,
    async retry() { await hydrate(true); },
    async requestPermission() {
      try { await deps.os.requestPermissions(); } catch {
        publish({ ...state, rows: {}, status: 'error', error: 'permission-request', running: false }); return;
      }
      await request();
    },
    start() {
      stopped = false;
      let lastProjection = '';
      const unsubscribe = deps.subscribe(() => {
        const current = deps.getState();
        if (current.phase !== 'ready') return;
        const projection = JSON.stringify(current.snapshot.obligations.map((r) => [r.id,r.title,r.dueDate,r.reminderTime,r.reminderEnabled,r.completed]));
        if (projection !== lastProjection) { lastProjection = projection; void request(); }
      });
      void hydrate();
      return () => { stopped = true; epoch++; unsubscribe(); };
    },
  };
}
