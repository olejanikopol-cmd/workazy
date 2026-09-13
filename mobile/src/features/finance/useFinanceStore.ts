/**
 * Singleton native binding for the Finance store.
 *
 * The ONLY Finance module that imports AsyncStorage and Expo Crypto. It builds the
 * store factory once with real services, exposes the store for commands and a
 * `useFinanceStore()` hook for `useSyncExternalStore` subscriptions over stable,
 * deeply frozen snapshots.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import type { FinanceStorage } from '@/storage/financeStorage';
import { createFinanceStore, type FinanceState } from './financeStore';

const storage: FinanceStorage = {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
};

export const financeStore = createFinanceStore({
  storage,
  now: () => new Date(),
  createId: (prefix: string) => `${prefix}-${Crypto.randomUUID()}`,
});

/** Snapshot subscription; the store publishes immutable, deeply frozen state. */
export function useFinanceStore(): FinanceState {
  return useSyncExternalStore(financeStore.subscribe, financeStore.getSnapshot);
}
