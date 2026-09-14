import { SCHEDULE_HANDOFF_BUDGET_MS, TRIGGER_VERIFY_TOLERANCE_MS,
  type LocalNotificationRequest, type PendingNotification } from './localNotificationContract';
export const FINANCE_NOTIFICATION_OWNER = 'workazy-finance-v1';
export const financeNotificationId = (id: string) => `workazy.finance.v1:${id}:due`;
export type FinanceNotificationRequest = LocalNotificationRequest & { obligationId: string; fingerprint: string };
export function financeOwnership(pending: Pick<PendingNotification, 'identifier' | 'data'>): string | null {
  const data = pending.data;
  if (!data || data.owner !== FINANCE_NOTIFICATION_OWNER || data.kind !== 'due' ||
    typeof data.obligationId !== 'string' || !data.obligationId ||
    pending.identifier !== financeNotificationId(data.obligationId)) return null;
  return data.obligationId;
}
export function financePendingMatches(p: PendingNotification, r: FinanceNotificationRequest): boolean {
  if (financeOwnership(p) !== r.obligationId || p.identifier !== r.id || p.repeats === true ||
      p.data?.fingerprint !== r.fingerprint || p.data?.targetTriggerAt !== r.triggerAt ||
      typeof p.data?.scheduledAt !== 'number' || !Number.isFinite(p.data.scheduledAt) ||
      p.contentTitle !== r.title || p.contentBody !== r.body || p.triggerAt === null ||
      !Number.isFinite(p.triggerAt) || p.triggerShape === 'unknown') return false;
  return Math.abs(p.triggerAt - r.triggerAt) <=
    (p.triggerShape === 'interval' ? SCHEDULE_HANDOFF_BUDGET_MS : TRIGGER_VERIFY_TOLERANCE_MS);
}
