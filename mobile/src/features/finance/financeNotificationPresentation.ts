import type { FinanceNotificationState } from './financeNotificationController';
import type { FinanceObligation } from '@/types/finance';
export function financeReminderLabel(row: FinanceObligation, revision: number, state: FinanceNotificationState): string {
  if (row.completed || !row.reminderEnabled) return 'Напоминание выключено';
  if (state.running || state.revision !== revision) return 'Напоминание настроено · проверяем';
  const status = state.rows[row.id]?.status;
  switch (status) {
    case 'scheduled': return state.permission?.provisional ? 'Запланировано · тихая доставка' : 'Напоминание запланировано';
    case 'past': return 'Время напоминания прошло';
    case 'unschedulable': return 'Это время недоступно в текущем часовом поясе';
    case 'capacity': return 'Не запланировано — нет свободного места';
    case 'permission': return state.permission?.status === 'denied' ? 'Уведомления выключены в настройках' : 'Разрешите уведомления';
    case 'error': return 'Не удалось обновить напоминание — повторите проверку';
    default: return state.status === 'error' ? 'Не удалось проверить напоминание' : 'Напоминание настроено · проверяем';
  }
}
