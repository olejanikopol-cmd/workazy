/**
 * Native daily-plan persistence: single storage key, versioned envelope,
 * strict parser/serializer, and the injected key/value storage interface.
 *
 * The parser validates the whole snapshot and never defaults invalid/missing
 * completion to false. Optional timestamps stay omitted when absent. Rows with
 * titles longer than 300 are accepted on load (the 300 limit is an input rule,
 * so a previously valid long title stays readable); the full snapshot is
 * rejected — not silently repaired — on any structural violation.
 */
import type { PlanSnapshotV1, PlanTask } from '@/types/plan';
import { isValidIsoDate, isValidIsoTimestamp } from '@/features/plans/planDates';

/** Distinct key from the web planner's browser-storage key. */
export const PLAN_STORAGE_KEY = 'workazy-native-plan-v1';

export type PlanStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type SnapshotParseResult =
  | { ok: true; snapshot: PlanSnapshotV1 }
  | { ok: false; error: string };

export function serializeSnapshot(
  tasks: readonly PlanTask[],
  savedAt: string,
): string {
  const snapshot: PlanSnapshotV1 = {
    version: 1,
    tasks: tasks.map((task) => ({ ...task })),
    savedAt,
  };
  return JSON.stringify(snapshot);
}

export function parseSnapshot(raw: string): SnapshotParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'not-object' };
  }
  const object = parsed as Record<string, unknown>;
  if (object.version !== 1) return { ok: false, error: 'unknown-version' };
  if (!Array.isArray(object.tasks)) return { ok: false, error: 'tasks-not-array' };
  if (typeof object.savedAt !== 'string' || !isValidIsoTimestamp(object.savedAt)) {
    return { ok: false, error: 'bad-saved-at' };
  }

  const tasks: PlanTask[] = [];
  const seenIds = new Set<string>();
  for (const rawItem of object.tasks) {
    if (rawItem === null || typeof rawItem !== 'object') {
      return { ok: false, error: 'task-not-object' };
    }
    const item = rawItem as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return { ok: false, error: 'bad-task-id' };
    }
    if (seenIds.has(item.id)) return { ok: false, error: 'duplicate-task-id' };
    seenIds.add(item.id);
    if (typeof item.title !== 'string' || item.title.trim().length === 0) {
      return { ok: false, error: 'bad-task-title' };
    }
    if (typeof item.completed !== 'boolean') {
      return { ok: false, error: 'bad-task-completed' };
    }
    if (typeof item.date !== 'string' || !isValidIsoDate(item.date)) {
      return { ok: false, error: 'bad-task-date' };
    }
    if (
      item.createdAt !== undefined &&
      (typeof item.createdAt !== 'string' || !isValidIsoTimestamp(item.createdAt))
    ) {
      return { ok: false, error: 'bad-task-created-at' };
    }
    if (
      item.updatedAt !== undefined &&
      (typeof item.updatedAt !== 'string' || !isValidIsoTimestamp(item.updatedAt))
    ) {
      return { ok: false, error: 'bad-task-updated-at' };
    }
    const task: PlanTask = {
      id: item.id,
      title: item.title,
      completed: item.completed,
      date: item.date,
    };
    if (item.createdAt !== undefined) task.createdAt = item.createdAt;
    if (item.updatedAt !== undefined) task.updatedAt = item.updatedAt;
    tasks.push(task);
  }

  return {
    ok: true,
    snapshot: { version: 1, tasks, savedAt: object.savedAt },
  };
}