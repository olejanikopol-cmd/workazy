import type { FinanceObligation } from '@/types/finance';
import type { FinanceNotificationRecord } from '@/storage/financeNotificationStorage';
import type { LocalNotificationOS, NotificationPermissionStatus, PendingNotification } from './localNotificationContract';
import { financeOwnership, financePendingMatches, type FinanceNotificationRequest } from './financeNotificationContract';
import { planFinanceNotifications, type FinanceReminderRow } from './financeNotificationPlanner';
import { createLocalNotificationScheduleSafety, DEFAULT_MAX_PENDING } from './localNotificationScheduleSafety';
export type FinanceReconcileResult = {
  status: 'ok' | 'error' | 'aborted'; error: string | null;
  permission: NotificationPermissionStatus | null; rows: Record<string, FinanceReminderRow>;
};
/** Must be called inside the shared full-pass queue. Never mutates Finance data. */
export async function reconcileFinanceNotifications(input: {
  obligations: readonly FinanceObligation[]; records: readonly FinanceNotificationRecord[];
  os: LocalNotificationOS; clock(): Date; timeZone: string; shouldAbort(): boolean;
  persist(records: readonly FinanceNotificationRecord[]): Promise<void>;
}): Promise<FinanceReconcileResult> {
  const { os, clock, shouldAbort } = input;
  const { requests, rows } = planFinanceNotifications(input.obligations, clock(), input.timeZone);
  let permission: NotificationPermissionStatus | null = null;
  const records = new Map(input.records.map((r) => [r.id, r]));
  let stage = 'permission-read';
  const abort = () => { if (shouldAbort()) throw Error('aborted'); };
  async function persist() { abort(); stage = 'registry-write'; await input.persist([...records.values()]); abort(); }
  async function list() { stage = 'native-list'; const result = await os.listPending(); abort(); return result; }
  function record(r: FinanceNotificationRequest, status: FinanceNotificationRecord['status']): FinanceNotificationRecord {
    const now = clock().toISOString();
    return { id: r.id, obligationId: r.obligationId, kind: 'due', fingerprint: r.fingerprint,
      targetTriggerAt: r.triggerAt, status, createdAt: records.get(r.id)?.createdAt ?? now, updatedAt: now };
  }
  async function markScheduled(r: FinanceNotificationRequest, p: PendingNotification) {
    abort();
    const existing = records.get(r.id);
    if (existing?.status === 'scheduled' && existing.fingerprint === r.fingerprint && existing.scheduledAt === p.data?.scheduledAt) return;
    records.set(r.id, { ...record(r, 'scheduled'), scheduledAt: p.data?.scheduledAt as number, verifiedAt: clock().toISOString() });
    await persist();
  }
  async function cancel(p: PendingNotification) {
    abort();
    const obligationId = financeOwnership(p);
    if (obligationId === null) return;
    const existing = records.get(p.identifier);
    const target = p.data?.targetTriggerAt;
    records.set(p.identifier, { ...(existing ?? { id: p.identifier, obligationId, kind: 'due',
      fingerprint: typeof p.data?.fingerprint === 'string' ? p.data.fingerprint : '',
      targetTriggerAt: typeof target === 'number' && Number.isSafeInteger(target) && Number.isFinite(new Date(target).getTime()) ? target : null, createdAt: clock().toISOString() }),
      status: 'tombstone', updatedAt: clock().toISOString() });
    await persist();
    stage = 'cancel'; await os.cancel(p.identifier); abort();
    if ((await list()).some((item) => item.identifier === p.identifier)) { stage = 'cancel'; throw Error('still-pending'); }
    records.delete(p.identifier); await persist();
  }
  try {
    abort(); permission = await os.getPermissions(); abort();
    let pending = await list();
    const foreign = pending.filter((p) => financeOwnership(p) === null).length;
    const window = new Map((permission.granted ? requests.slice(0, Math.max(0, DEFAULT_MAX_PENDING - foreign)) : []).map((r) => [r.id, r]));
    for (const p of pending) {
      if (financeOwnership(p) === null) continue;
      const desired = window.get(p.identifier);
      if (!desired || !financePendingMatches(p, desired)) await cancel(p);
    }
    pending = await list();
    const safety = createLocalNotificationScheduleSafety({ pending, listPending: () => os.listPending(),
      schedule: (r: FinanceNotificationRequest) => os.schedule(r), matches: financePendingMatches, shouldAbort });
    for (const r of requests) {
      abort();
      if (!permission.granted) { rows[r.obligationId] = { status: 'permission', fingerprint: r.fingerprint }; continue; }
      if (r.triggerAt <= clock().getTime()) { rows[r.obligationId] = { status: 'past' }; continue; }
      const actual = safety.find(r.id);
      if (actual) {
        if (!financePendingMatches(actual, r)) { stage = 'verification'; throw Error('conflicting-request'); }
        await markScheduled(r, actual);
        rows[r.obligationId] = { status: 'scheduled', fingerprint: r.fingerprint }; continue;
      }
      if (!safety.hasCapacity()) { rows[r.obligationId] = { status: 'capacity', fingerprint: r.fingerprint }; continue; }
      records.set(r.id, record(r, 'pending')); await persist();
      if (r.triggerAt <= clock().getTime()) { records.delete(r.id); await persist(); rows[r.obligationId] = { status: 'past' }; continue; }
      const outcome = await safety.schedule(r); abort();
      if (outcome !== 'verified') { stage = outcome; throw Error(outcome); }
      const verified = safety.find(r.id);
      if (!verified) { stage = 'verification'; throw Error('missing'); }
      await markScheduled(r, verified);
      rows[r.obligationId] = { status: 'scheduled', fingerprint: r.fingerprint };
    }
    const final = await list();
    let changed = false;
    for (const [id] of records) {
      if (!final.some((p) => p.identifier === id)) { records.delete(id); changed = true; }
    }
    if (changed) await persist();
    for (const r of requests) {
      if (rows[r.obligationId]?.status !== 'scheduled') continue;
      const actual = final.find((p) => p.identifier === r.id);
      if (!actual || !financePendingMatches(actual, r)) { stage = 'verification'; throw Error('final-mismatch'); }
    }
    abort(); return { status: 'ok', error: null, permission, rows };
  } catch {
    if (shouldAbort()) return { status: 'aborted', error: null, permission, rows: {} };
    // Never expose a partial or stale scheduled badge after a failed pass.
    for (const r of requests) rows[r.obligationId] = { status: 'error', fingerprint: r.fingerprint };
    return { status: 'error', error: stage, permission, rows };
  }
}
