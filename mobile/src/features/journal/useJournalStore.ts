/**
 * Singleton native binding for the journal store.
 *
 * This is the ONLY journal module that imports AsyncStorage and Expo Crypto. It
 * builds the store factory once with real services and exposes a
 * `useJournalStore()` hook over stable immutable snapshots.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import type { JournalStorage } from '@/storage/journalStorage';
import { createJournalStore, type JournalState } from './journalStore';

const storage: JournalStorage = {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
};

export const journalStore = createJournalStore({
  storage,
  now: () => new Date(),
  createId: () => `entry-${Crypto.randomUUID()}`,
});

/** Snapshot subscription; the store publishes immutable state objects. */
export function useJournalStore(): JournalState {
  return useSyncExternalStore(journalStore.subscribe, journalStore.getSnapshot);
}
