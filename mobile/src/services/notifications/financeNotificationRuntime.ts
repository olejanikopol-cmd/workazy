import AsyncStorage from '@react-native-async-storage/async-storage';
import { financeStore } from '@/features/finance/useFinanceStore';
import { createFinanceNotificationController } from '@/features/finance/financeNotificationController';
import { createFinanceNotificationRegistry } from '@/storage/financeNotificationStorage';
import { expoLocalNotifications } from './expoLocalNotifications';
export const financeNotificationRegistry = createFinanceNotificationRegistry(AsyncStorage, () => new Date());
export const financeNotificationController = createFinanceNotificationController({
  getState: financeStore.getSnapshot, subscribe: financeStore.subscribe, load: financeStore.load,
  registry: financeNotificationRegistry, os: expoLocalNotifications, clock: () => new Date(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
});
