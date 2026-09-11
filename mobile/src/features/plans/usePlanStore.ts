/**
 * Singleton native binding for the daily-plan store.
 *
 * This is the ONLY module that imports AsyncStorage and Expo Crypto. It builds
 * the store factory once with real services and exposes a `usePlanStore()`
 * hook for `useSyncExternalStore` subscriptions over stable snapshots.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import type { PlanStorage } from '@/storage/planStorage';
import { createPlanStore, type PlanState } from './planStore';

const storage: PlanStorage = {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
};

export const planStore = createPlanStore({
  storage,
  now: () => new Date(),
  createId: () => `task-${Crypto.randomUUID()}`,
});

/** Snapshot subscription; the store publishes immutable state objects. */
export function usePlanStore(): PlanState {
  return useSyncExternalStore(planStore.subscribe, planStore.getSnapshot);
}