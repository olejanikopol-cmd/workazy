import { isGoalPeriod, isGoalPeriodKey } from '@/features/goals/goalDates';
import { isValidIsoDate, isValidIsoTimestamp } from '@/features/plans/planDates';
import type { Goal, GoalSnapshotV1 } from '@/types/goal';

export const GOALS_STORAGE_KEY = 'workazy-native-goals-v1';

export type GoalStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

type GoalParseResult =
  | { ok: true; snapshot: GoalSnapshotV1 }
  | { ok: false; error: string };

const envelopeKeys = ['version', 'revision', 'goals', 'savedAt'] as const;
const requiredGoalKeys = [
  'id',
  'title',
  'period',
  'periodKey',
  'deadline',
  'progress',
  'completed',
  'createdAt',
  'updatedAt',
] as const;
const optionalGoalKeys = ['description'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = [...required, ...optional];
  return (
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

/** Rows and their array are copied and frozen before publication. */
export function deepFreezeGoals(goals: readonly Goal[]): readonly Goal[] {
  return Object.freeze(goals.map((goal) => Object.freeze({ ...goal })));
}

export function serializeGoalSnapshot(
  goals: readonly Goal[],
  revision: number,
  savedAt: string,
): string {
  return JSON.stringify({
    version: 1,
    revision,
    goals: goals.map((goal) => ({ ...goal })),
    savedAt,
  });
}

/** Unknown versions, keys, invalid rows, or duplicate IDs reject the whole snapshot. */
export function parseGoalSnapshot(raw: string): GoalParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }

  if (!isObject(value) || !hasExactKeys(value, envelopeKeys)) {
    return { ok: false, error: 'bad-envelope' };
  }
  if (value.version !== 1) return { ok: false, error: 'unknown-version' };
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    return { ok: false, error: 'bad-revision' };
  }
  if (
    typeof value.savedAt !== 'string' ||
    !isValidIsoTimestamp(value.savedAt) ||
    !Array.isArray(value.goals)
  ) {
    return { ok: false, error: 'bad-envelope' };
  }

  const ids = new Set<string>();
  const goals: Goal[] = [];
  for (const rawGoal of value.goals) {
    if (
      !isObject(rawGoal) ||
      !hasExactKeys(rawGoal, requiredGoalKeys, optionalGoalKeys)
    ) {
      return { ok: false, error: 'bad-goal' };
    }
    if (
      typeof rawGoal.id !== 'string' ||
      !rawGoal.id.trim() ||
      ids.has(rawGoal.id) ||
      typeof rawGoal.title !== 'string' ||
      !rawGoal.title.trim() ||
      (rawGoal.description !== undefined && typeof rawGoal.description !== 'string') ||
      !isGoalPeriod(rawGoal.period) ||
      !isGoalPeriodKey(rawGoal.period, rawGoal.periodKey) ||
      typeof rawGoal.deadline !== 'string' ||
      !isValidIsoDate(rawGoal.deadline) ||
      !Number.isSafeInteger(rawGoal.progress) ||
      Number(rawGoal.progress) < 0 ||
      Number(rawGoal.progress) > 100 ||
      typeof rawGoal.completed !== 'boolean' ||
      rawGoal.completed !== (rawGoal.progress === 100) ||
      typeof rawGoal.createdAt !== 'string' ||
      !isValidIsoTimestamp(rawGoal.createdAt) ||
      typeof rawGoal.updatedAt !== 'string' ||
      !isValidIsoTimestamp(rawGoal.updatedAt)
    ) {
      return { ok: false, error: 'bad-goal' };
    }

    ids.add(rawGoal.id);
    goals.push(rawGoal as unknown as Goal);
  }

  return {
    ok: true,
    snapshot: {
      version: 1,
      revision: Number(value.revision),
      goals,
      savedAt: value.savedAt,
    },
  };
}
