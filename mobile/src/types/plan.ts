/**
 * Daily plan domain types for the native app.
 *
 * Compatible with repository `lib/types.ts`; no runtime import from the web app.
 * Mirrors only the daily Plan-item shape. Standalone Assignment semantics stay
 * outside the native product; Goals use their own native domain and store.
 */
export type PlanTask = {
  id: string;
  title: string;
  completed: boolean;
  /** Local calendar date YYYY-MM-DD. */
  date: string;
  createdAt?: string;
  updatedAt?: string;
};

/** Persisted envelope under the single native key `workazy-native-plan-v1`. */
export type PlanSnapshotV1 = {
  version: 1;
  tasks: PlanTask[];
  /** ISO timestamp captured for the snapshot write. */
  savedAt: string;
};
