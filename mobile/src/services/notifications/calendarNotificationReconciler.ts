/**
 * Pure notification reconciler: converges the OS pending inventory to the
 * desired future Calendar requests, with durable registry bookkeeping.
 *
 * Protocol guarantees:
 * - Topology: clear obsolete/changed/out-of-window owned pending BEFORE
 *   scheduling; recompute capacity from the CURRENT OS inventory after
 *   cancellation; then schedule missing in-window requests (fresh clock before
 *   each decision, never a trigger that became past while reconciling).
 * - Verification: an existing owned request is only treated as up-to-date when
 *   ownership metadata AND kind AND content (title/body) AND trigger time all
 *   match the desired request — metadata fingerprints alone are not trusted.
 *   Trigger time is verified against the instant the OS ACTUALLY holds: an
 *   undecodable/unknown trigger fails verification (persisted target metadata
 *   only proves intent). Absolute/date/calendar shapes must match strictly; the
 *   conservative JS→native handoff budget applies only to the iOS `interval`
 *   family, where the native interval is computed after the JS call.
 * - Capacity is consumed the moment `os.schedule` succeeds — a subsequent
 *   inventory readback failure does not free the slot, so a verification
 *   failure can never make the pass exceed `maxPending`.
 * - A fresh clock is consulted immediately AFTER the registry persist and
 *   BEFORE the OS schedule call; a trigger that became past during the persist
 *   is skipped (durable registry corrected) and never fires as an immediate
 *   alert. `shouldAbort` (event revision) is re-checked at that same point.
 * - Registry record persisted BEFORE first scheduling an ID; tombstones kept
 *   until cancellation is confirmed. A registry write failure means the pass
 *   reports error and nothing for that ID is scheduled.
 * - Future events whose local time does not exist in the current timezone
 *   (DST spring-forward gap) are reported in `unschedulable` so the UI can
 *   warn honestly instead of silently dropping their previous reminders; the
 *   list clears automatically once the timezone changes and they become
 *   schedulable again.
 * - `shouldAbort` (coordinator) stops OS mutation as soon as newer committed
 *   events appear, so an older in-flight pass can never keep or add state for
 *   a deleted/edited event; the coordinator re-runs with the latest snapshot.
 * - Bounded queue: at most `maxPending` total pending requests. Desired
 *   requests beyond the window are not scheduled (visible capacityLimited) and
 *   previously-scheduled overflow is cancelled; refill happens on later passes
 *   when earlier reminders fire or eligibility changes.
 * - Past triggers are never scheduled as immediate alerts. Repeated
 *   reconciliation converges without cancel/reschedule churn of unchanged
 *   future requests.
 */
import type { CalendarEvent, CalendarNotificationRecord } from '@/types/calendar';
import {
  planCalendarRequests,
  planCalendarUnscheduleable,
  type UnscheduleableEvent,
} from './calendarNotificationPlanner';
import {
  SCHEDULE_HANDOFF_BUDGET_MS,
  TRIGGER_VERIFY_TOLERANCE_MS,
  isOwnedNotification,
  persistedTriggerTarget,
  notificationId,
  ownershipOf,
  type CalendarNotificationContract,
  type CalendarNotificationRequest,
  type PendingNotification,
} from './calendarNotificationContract';

export const DEFAULT_MAX_PENDING = 48;

export type ReconcileResult = {
  status: 'ok' | 'error' | 'aborted';
  /** Human-readable error for the UI; null when ok/aborted. */
  error: string | null;
  /** True when some desired reminders were not scheduled due to capacity. */
  capacityLimited: boolean;
  /** IDs scheduled during this pass. */
  scheduled: string[];
  /** IDs cancelled during this pass. */
  cancelled: string[];
  /** Triggers that became past between planning and scheduling (skipped). */
  skippedStale: number;
  /**
   * Future timed events whose wall-clock time does not exist in the current
   * timezone (DST gap). Their reminders cannot be scheduled and their prior
   * notifications are cleared — the UI must surface this instead of dropping
   * it silently. Clears automatically when a later pass makes them schedulable.
   */
  unschedulable: readonly UnscheduleableEvent[];
  /** Final registry (already persisted when ok). */
  registry: readonly CalendarNotificationRecord[];
};

export type ReconcileInput = {
  events: readonly CalendarEvent[];
  registry: readonly CalendarNotificationRecord[];
  now: Date;
  timeZone: string;
  os: CalendarNotificationContract;
  /** Persists the registry into the current committed envelope. */
  persistRegistry: (records: readonly CalendarNotificationRecord[]) => Promise<void>;
  /** Fresh-clock source for per-schedule staleness checks. Defaults to new Date(). */
  clock?: () => Date;
  /** Scheduler stops OS mutation as soon as this returns true (coordinator). */
  shouldAbort?: () => boolean;
  maxPending?: number;
};

function makeRecord(
  id: string,
  eventId: string,
  kind: CalendarNotificationRecord['kind'],
  fingerprint: string,
  status: CalendarNotificationRecord['status'],
  nowIso: string,
): CalendarNotificationRecord {
  return { id, eventId, kind, fingerprint, status, createdAt: nowIso, updatedAt: nowIso };
}

/**
 * Real content/trigger verification — never trust only the fingerprint metadata.
 * Checks ownership metadata (eventId/kind/fingerprint) AND actual title/body AND
 * the trigger instant actually held by the OS.
 *
 * An UNDECODABLE trigger (`triggerAt === null`, unknown shape) fails
 * verification: persisted target metadata only proves what we intended, never
 * what the OS scheduled. The scheduling-handoff budget applies ONLY to the iOS
 * `interval` family (native interval computed after the JS call); absolute/
 * date/calendar shapes must match strictly.
 */
export function pendingMatchesRequest(
  pending: PendingNotification,
  request: CalendarNotificationRequest,
): boolean {
  const ownership = ownershipOf(pending);
  if (!ownership) return false;
  if (ownership.eventId !== request.eventId) return false;
  if (ownership.kind !== request.kind) return false;
  if (ownership.fingerprint !== request.fingerprint) return false;
  if (pending.contentTitle !== request.title) return false;
  if (pending.contentBody !== request.body) return false;

  // The OS must expose a decodable trigger instant for this to be verifiable.
  if (pending.triggerAt === null || pending.triggerShape === 'unknown') return false;

  // Metadata can only ADD a constraint (the exact instant we intended).
  const target = persistedTriggerTarget(pending.data);
  if (target !== null && target !== request.triggerAt) return false;

  // Shape-scoped comparison against what the OS actually holds.
  const tolerance =
    pending.triggerShape === 'interval'
      ? SCHEDULE_HANDOFF_BUDGET_MS
      : TRIGGER_VERIFY_TOLERANCE_MS;
  return Math.abs(pending.triggerAt - request.triggerAt) <= tolerance;
}

function abortedResult(
  registry: readonly CalendarNotificationRecord[],
  scheduled: string[],
  cancelled: string[],
  unschedulable: readonly UnscheduleableEvent[],
): ReconcileResult {
  return {
    status: 'aborted',
    error: null,
    capacityLimited: false,
    scheduled,
    cancelled,
    skippedStale: 0,
    unschedulable,
    registry,
  };
}

function errorResult(
  message: string,
  registry: readonly CalendarNotificationRecord[],
  scheduled: string[],
  cancelled: string[],
  unschedulable: readonly UnscheduleableEvent[],
): ReconcileResult {
  return {
    status: 'error',
    error: message,
    capacityLimited: false,
    scheduled,
    cancelled,
    skippedStale: 0,
    unschedulable,
    registry,
  };
}

export async function reconcileCalendarNotifications(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const {
    events,
    registry,
    now,
    timeZone,
    os,
    persistRegistry,
    maxPending = DEFAULT_MAX_PENDING,
  } = input;
  const clock = input.clock ?? (() => new Date());
  const shouldAbort = input.shouldAbort ?? (() => false);
  const nowIso = now.toISOString();
  const errors: string[] = [];
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  let skippedStale = 0;

  // Future timed events whose wall-clock time does not exist in this timezone
  // (DST spring-forward gap) — reported so the UI can warn instead of dropping
  // reminders silently; clears when a later pass makes them schedulable.
  const unschedulable = planCalendarUnscheduleable(events, now, timeZone);

  // 1. Permission (read without prompting).
  let granted;
  try {
    granted = (await os.getPermissions()).granted;
  } catch {
    return errorResult('Не удалось проверить разрешение на уведомления.', registry, scheduled, cancelled, unschedulable);
  }
  if (shouldAbort()) return abortedResult(registry, scheduled, cancelled, unschedulable);

  // 2. Initial OS pending inventory.
  let pending: PendingNotification[];
  try {
    pending = await os.listPending();
  } catch {
    return errorResult(
      'Не удалось получить список запланированных уведомлений.',
      registry,
      scheduled,
      cancelled,
      unschedulable,
    );
  }
  if (shouldAbort()) return abortedResult(registry, scheduled, cancelled, unschedulable);

  const ownedPending = pending.filter(isOwnedNotification);
  const unrelatedCount = pending.length - ownedPending.length;

  // 3. Desired future requests, sorted by trigger instant.
  const desired = planCalendarRequests(events, now, timeZone);
  const desiredById = new Map(desired.map((r) => [r.id, r]));
  const cap0 = Math.max(0, maxPending - unrelatedCount);
  const inWindowIds = new Set(desired.slice(0, cap0).map((r) => r.id));

  // 4. Registry map (mutable working copy).
  const records = new Map(registry.map((r) => [r.id, r]));

  async function persist(): Promise<boolean> {
    try {
      await persistRegistry([...records.values()]);
      return true;
    } catch {
      errors.push('registry-write-failed');
      return false;
    }
  }

  async function cancelAndConfirm(id: string): Promise<boolean> {
    if (shouldAbort()) return false;
    try {
      await os.cancel(id);
      const after = await os.listPending();
      if (shouldAbort()) return false;
      if (after.some((p) => p.identifier === id)) return false;
      cancelled.push(id);
      return true;
    } catch {
      return false;
    }
  }

  // 4b. Permission denied/revoked: never schedule; cancel owned pending
  // best-effort (keeping tombstones until confirmed) and do not attempt any
  // new reminders. Events are never touched.
  if (!granted) {
    for (const p of ownedPending) {
      if (await cancelAndConfirm(p.identifier)) {
        const ownership = ownershipOf(p);
        records.set(
          p.identifier,
          makeRecord(
            p.identifier,
            ownership?.eventId ?? 'unknown',
            ownership?.kind ?? 'start',
            ownership?.fingerprint ?? '',
            'tombstone',
            nowIso,
          ),
        );
        await persist();
      } else if (!shouldAbort()) {
        errors.push(`cancel-failed:${p.identifier}`);
      }
    }
    let finalPending: PendingNotification[] = [];
    try {
      finalPending = await os.listPending();
    } catch {
      finalPending = ownedPending;
    }
    const stillPending = new Set(finalPending.map((p) => p.identifier));
    let removed = false;
    for (const [id, record] of records) {
      if (record.status === 'tombstone' && !stillPending.has(id)) {
        records.delete(id);
        removed = true;
      }
    }
    if (removed) await persist();
    return {
      status: errors.length ? 'error' : 'ok',
      error: errors.length ? 'Не удалось синхронизировать напоминания. Повторите попытку.' : null,
      capacityLimited: false,
      scheduled,
      cancelled,
      skippedStale,
      unschedulable,
      registry: [...records.values()],
    };
  }

  // 5. PHASE A — clear obsolete/changed/out-of-window owned pending BEFORE
  // scheduling any replacements or new requests. A request matching an
  // in-window desired request (verified content/trigger) is kept (no-op);
  // everything else owned is cancelled with confirmation.
  for (const p of ownedPending) {
    if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);
    const req = desiredById.get(p.identifier);
    if (req !== undefined && inWindowIds.has(req.id) && pendingMatchesRequest(p, req)) {
      if (!records.has(p.identifier)) {
        records.set(
          p.identifier,
          makeRecord(p.identifier, req.eventId, req.kind, req.fingerprint, 'scheduled', nowIso),
        );
        await persist();
      }
      continue;
    }
    if (await cancelAndConfirm(p.identifier)) {
      const ownership = ownershipOf(p);
      records.set(
        p.identifier,
        makeRecord(
          p.identifier,
          ownership?.eventId ?? 'unknown',
          ownership?.kind ?? 'start',
          ownership?.fingerprint ?? '',
          'tombstone',
          nowIso,
        ),
      );
      await persist();
    } else if (!shouldAbort()) {
      errors.push(`cancel-failed:${p.identifier}`);
    }
  }
  if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);

  // 6. Re-list: capacity must reflect the CURRENT OS inventory after
  // cancellation (review requirement), not the pre-cleanup snapshot.
  let postPending: PendingNotification[];
  try {
    postPending = await os.listPending();
  } catch {
    return errorResult(
      'Не удалось получить список запланированных уведомлений.',
      [...records.values()],
      scheduled,
      cancelled,
      unschedulable,
    );
  }
  if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);
  const postById = new Map(postPending.map((p) => [p.identifier, p]));
  const capacityAvailable = Math.max(0, maxPending - postPending.length);

  // 7. PHASE C — schedule missing in-window desired requests. A fresh clock is
  // consulted immediately before each schedule decision: never schedule a
  // trigger that has become past while reconciliation was running.
  let slotsUsed = 0;
  for (const req of desired) {
    if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);
    // A slot is consumed the moment a schedule SUCCEEDS — regardless of the
    // later readback outcome — so a verification failure right after a
    // successful schedule can never let this pass exceed the configured cap.
    if (slotsUsed >= capacityAvailable) break;
    const existing = postById.get(req.id);
    if (existing) {
      if (!pendingMatchesRequest(existing, req)) {
        // Should have been cancelled in Phase A; if it still exists, surface.
        errors.push(`conflict:${req.id}`);
      }
      continue;
    }
    if (req.triggerAt <= clock().getTime()) {
      skippedStale += 1; // became past mid-reconcile: do not schedule
      continue;
    }
    records.set(
      req.id,
      makeRecord(req.id, req.eventId, req.kind, req.fingerprint, 'scheduled', nowIso),
    );
    if (!(await persist())) continue;
    // Fresh revalidation IMMEDIATELY before the OS call: the registry write
    // above may have taken time — the trigger could be past by now, or a newer
    // event mutation could have committed (shouldAbort => the coordinator
    // re-runs with the latest state). Schedule only a still-future, still-current
    // request; otherwise correct the durable registry entry.
    if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);
    if (req.triggerAt <= clock().getTime()) {
      records.delete(req.id);
      await persist();
      skippedStale += 1;
      continue;
    }
    try {
      const returned = await os.schedule(req);
      slotsUsed += 1; // capacity consumed by the successful schedule
      if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);
      if (returned !== req.id) throw new Error('id-mismatch');
      // Read-back verification uses the SAME full matcher as existing pending
      // notifications: identifier alone is NOT enough — ownership, content and
      // the trigger instant must match the request we just scheduled.
      const after = await os.listPending();
      if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);
      const verified = after.find((p) => p.identifier === req.id);
      if (verified === undefined || !pendingMatchesRequest(verified, req)) {
        throw new Error('schedule-not-verified');
      }
      scheduled.push(req.id);
    } catch {
      errors.push(`schedule-failed:${req.id}`);
    }
  }
  if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);

  // 8. PHASE D — final inventory; adopt owned orphans absent from the registry
  // (crash recovery) when they match desired requests, otherwise cancel them.
  let finalPending: PendingNotification[];
  try {
    finalPending = await os.listPending();
  } catch {
    errors.push('inventory-failed');
    finalPending = postPending;
  }
  if (shouldAbort()) return abortedResult([...records.values()], scheduled, cancelled, unschedulable);
  for (const p of finalPending.filter(isOwnedNotification)) {
    if (shouldAbort()) break;
    if (records.has(p.identifier)) continue;
    const req = desiredById.get(p.identifier);
    if (req !== undefined && pendingMatchesRequest(p, req)) {
      records.set(
        p.identifier,
        makeRecord(p.identifier, req.eventId, req.kind, req.fingerprint, 'scheduled', nowIso),
      );
      await persist();
    } else if (await cancelAndConfirm(p.identifier)) {
      const ownership = ownershipOf(p);
      records.set(
        p.identifier,
        makeRecord(
          p.identifier,
          ownership?.eventId ?? 'unknown',
          ownership?.kind ?? 'start',
          ownership?.fingerprint ?? '',
          'tombstone',
          nowIso,
        ),
      );
      await persist();
    } else if (!shouldAbort()) {
      errors.push(`cancel-failed:${p.identifier}`);
    }
  }

  // 9. Drop tombstones whose cancellation is confirmed (absent from OS).
  let confirmList: PendingNotification[];
  try {
    confirmList = await os.listPending();
  } catch {
    confirmList = finalPending;
  }
  const finalIds = new Set(confirmList.map((p) => p.identifier));
  let changed = false;
  for (const [id, record] of records) {
    if (record.status === 'tombstone' && !finalIds.has(id)) {
      records.delete(id);
      changed = true;
    }
  }
  if (changed) await persist();

  // 10. Capacity-limited = some desired request is not present in the OS.
  const missing = desired.filter((req) => !finalIds.has(req.id) && req.triggerAt > clock().getTime());
  const capacityLimited = missing.length > 0;

  return {
    status: errors.length ? 'error' : 'ok',
    error: errors.length ? 'Не удалось синхронизировать напоминания. Повторите попытку.' : null,
    capacityLimited,
    scheduled,
    cancelled,
    skippedStale,
    unschedulable,
    registry: [...records.values()],
  };
}

/** Deterministic ID helper re-exported for tests/UI. */
export { notificationId };
