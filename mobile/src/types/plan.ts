/**
 * Daily plan domain types for the native app.
 *
 * Compatible with repository `lib/types.ts`; no runtime import from the web app.
 * Mirrors only the Plan-task shape; Assignment/Goal semantics stay outside this
 * feature (Tasks/Goals CRUD is a later slice).
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