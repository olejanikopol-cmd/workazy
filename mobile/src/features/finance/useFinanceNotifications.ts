import { useSyncExternalStore } from 'react';
import { financeNotificationController } from '@/services/notifications/financeNotificationRuntime';
export { financeNotificationController };
export function useFinanceNotifications() {
  return useSyncExternalStore(financeNotificationController.subscribe, financeNotificationController.getSnapshot);
}
