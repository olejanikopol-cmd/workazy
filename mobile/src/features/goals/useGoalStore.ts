import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { createGoalStore } from './goalStore';

export const goalStore = createGoalStore({
  storage: AsyncStorage,
  now: () => new Date(),
  createId: () => `goal-${Crypto.randomUUID()}`,
});

export function useGoalStore() {
  return useSyncExternalStore(goalStore.subscribe, goalStore.getSnapshot);
}
