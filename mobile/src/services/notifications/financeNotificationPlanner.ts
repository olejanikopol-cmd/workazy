import type { FinanceObligation } from '@/types/finance';
import { zonedDateTimeToUtcEarlier, isValidTime } from '@/features/calendar/calendarDates';
import { isValidIsoDate } from '@/features/plans/planDates';
import { FINANCE_NOTIFICATION_OWNER, financeNotificationId, type FinanceNotificationRequest } from './financeNotificationContract';
export type FinanceReminderStatus = 'off' | 'past' | 'unschedulable' | 'pending' | 'scheduled' | 'capacity' | 'permission' | 'error';
export type FinanceReminderRow = { status: FinanceReminderStatus; fingerprint?: string };
export function planFinanceNotifications(obligations: readonly FinanceObligation[], now: Date, timeZone: string) {
  const requests: FinanceNotificationRequest[] = [];
  const rows: Record<string, FinanceReminderRow> = Object.create(null);
  for (const row of obligations) {
    if (row.completed || !row.reminderEnabled) { rows[row.id] = { status: 'off' }; continue; }
    if (!row.dueDate || !isValidIsoDate(row.dueDate) || !row.reminderTime || !isValidTime(row.reminderTime)) {
      rows[row.id] = { status: 'unschedulable' }; continue;
    }
    const instant = zonedDateTimeToUtcEarlier(row.dueDate, row.reminderTime, timeZone);
    if (!instant) { rows[row.id] = { status: 'unschedulable' }; continue; }
    const triggerAt = instant.getTime();
    if (triggerAt <= now.getTime()) { rows[row.id] = { status: 'past' }; continue; }
    const title = 'Workazy';
    const body = `Финансовое напоминание · ${row.title}`;
    const fingerprint = JSON.stringify(['due', row.dueDate, row.reminderTime, triggerAt, title, body]);
    const id = financeNotificationId(row.id);
    requests.push({ id, obligationId: row.id, triggerAt, title, body, fingerprint,
      data: { owner: FINANCE_NOTIFICATION_OWNER, obligationId: row.id, kind: 'due', fingerprint, targetTriggerAt: triggerAt } });
    rows[row.id] = { status: 'pending', fingerprint };
  }
  requests.sort((a, b) => a.triggerAt - b.triggerAt || a.id.localeCompare(b.id));
  return { requests, rows };
}
