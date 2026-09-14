import { isValidIsoTimestamp } from '@/features/plans/planDates';
import { financeNotificationId } from '@/services/notifications/financeNotificationContract';
export const FINANCE_NOTIFICATION_STORAGE_KEY = 'workazy-native-finance-notifications-v1';
export type FinanceNotificationRecord = {
  id: string; obligationId: string; kind: 'due'; fingerprint: string; targetTriggerAt: number | null; // null only for owned orphan tombstones with unknown target
  status: 'pending' | 'scheduled' | 'tombstone'; scheduledAt?: number; verifiedAt?: string;
  createdAt: string; updatedAt: string;
};
export type FinanceNotificationEnvelope = { version: 1; records: readonly FinanceNotificationRecord[]; savedAt: string };
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const stamp = (x: unknown): x is string => typeof x === 'string' && isValidIsoTimestamp(x);
const epoch = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && Number.isFinite(new Date(x).getTime());
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every((k) => allowed.includes(k));
export function parseFinanceNotificationRegistry(raw: string): FinanceNotificationEnvelope | null {
  try {
    const x: unknown = JSON.parse(raw);
    if (!object(x) || !keys(x, ['version', 'records', 'savedAt']) || x.version !== 1 || !stamp(x.savedAt) || !Array.isArray(x.records)) return null;
    const ids = new Set<string>();
    for (const r of x.records) {
      if (!object(r) || !keys(r, ['id','obligationId','kind','fingerprint','targetTriggerAt','status','scheduledAt','verifiedAt','createdAt','updatedAt']) ||
        typeof r.obligationId !== 'string' || !r.obligationId || r.id !== financeNotificationId(r.obligationId) ||
        ids.has(r.id) || r.kind !== 'due' || typeof r.fingerprint !== 'string' || !(epoch(r.targetTriggerAt) || (r.status === 'tombstone' && r.targetTriggerAt === null)) ||
        (typeof r.status !== 'string' || !['pending','scheduled','tombstone'].includes(r.status)) || !stamp(r.createdAt) || !stamp(r.updatedAt) ||
        (r.scheduledAt !== undefined && !epoch(r.scheduledAt)) || (r.verifiedAt !== undefined && !stamp(r.verifiedAt)) ||
        (r.status === 'scheduled' && (!epoch(r.scheduledAt) || !stamp(r.verifiedAt)))) return null;
      ids.add(r.id);
    }
    return x as FinanceNotificationEnvelope;
  } catch { return null; }
}
export function createFinanceNotificationRegistry(storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }, now: () => Date) {
  let phase: 'loading' | 'ready' | 'load-error' = 'loading';
  let records: readonly FinanceNotificationRecord[] = Object.freeze([]);
  let flight: Promise<void> | null = null;
  let writing = false;
  function freeze(next: readonly FinanceNotificationRecord[]) { return Object.freeze(next.map((r) => Object.freeze({ ...r }))); }
  function load(retry = false): Promise<void> {
    if (flight) return flight;
    if (phase === 'ready' || (phase === 'load-error' && !retry)) return Promise.resolve();
    phase = 'loading';
    flight = (async () => {
      try {
        const raw = await storage.getItem(FINANCE_NOTIFICATION_STORAGE_KEY);
        const parsed = raw === null ? { records: [] } : parseFinanceNotificationRegistry(raw);
        if (!parsed) throw Error('registry-corrupt');
        records = freeze(parsed.records); phase = 'ready';
      } catch { phase = 'load-error'; }
    })().finally(() => { flight = null; });
    return flight;
  }
  return {
    load,
    getState: () => ({ phase, records }),
    async persist(next: readonly FinanceNotificationRecord[]) {
      if (phase !== 'ready' || writing) throw Error('registry-unavailable');
      const raw = JSON.stringify({ version: 1, records: next, savedAt: now().toISOString() });
      const parsed = parseFinanceNotificationRegistry(raw);
      if (!parsed) throw Error('registry-invalid');
      writing = true;
      try { await storage.setItem(FINANCE_NOTIFICATION_STORAGE_KEY, raw); records = freeze(parsed.records); }
      finally { writing = false; }
    },
  };
}
export type FinanceNotificationRegistry = ReturnType<typeof createFinanceNotificationRegistry>;
