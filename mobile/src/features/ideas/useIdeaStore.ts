/**
 * Singleton native binding for the ideas store.
 *
 * This is the ONLY ideas module that imports AsyncStorage and Expo Crypto. It
 * builds the store factory once with real services and exposes a
 * `useIdeaStore()` hook over stable immutable snapshots.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import type { IdeaStorage } from '@/storage/ideaStorage';
import { createIdeaStore, type IdeasState } from './ideaStore';

const storage: IdeaStorage = {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
};

export const ideaStore = createIdeaStore({
  storage,
  now: () => new Date(),
  createId: () => `idea-${Crypto.randomUUID()}`,
});

/** Snapshot subscription; the store publishes immutable state objects. */
export function useIdeaStore(): IdeasState {
  return useSyncExternalStore(ideaStore.subscribe, ideaStore.getSnapshot);
}
