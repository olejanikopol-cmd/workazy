/**
 * Singleton native binding for the calendar store.
 *
 * This is the ONLY module that imports AsyncStorage and Expo Crypto for the
 * calendar feature. It builds the store factory once with real services and
 * exposes a `useCalendarStore()` hook for `useSyncExternalStore` subscriptions.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import type { CalendarStorage } from '@/storage/calendarStorage';
import { createCalendarStore, type CalendarState } from './calendarStore';

const storage: CalendarStorage = {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
};

export const calendarStore = createCalendarStore({
  storage,
  now: () => new Date(),
  createId: () => `event-${Crypto.randomUUID()}`,
});

/** Snapshot subscription; the store publishes immutable state objects. */
export function useCalendarStore(): CalendarState {
  return useSyncExternalStore(calendarStore.subscribe, calendarStore.getSnapshot);
}