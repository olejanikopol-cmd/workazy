import { isValidIsoDate } from '@/features/plans/planDates';
import type { Goal, GoalPeriod } from '@/types/goal';
import { goalPeriodKey, isGoalPeriod, isGoalPeriodKey } from './goalDates';

export const GOAL_TITLE_MAX = 300;
export const GOAL_DESCRIPTION_MAX = 5000;

export type GoalDraft = {
  title: string;
  description?: string;
  period: GoalPeriod;
  deadline: string;
  progress: number;
};

export type GoalFailure =
  | 'title'
  | 'description'
  | 'period'
  | 'period-key'
  | 'deadline'
  | 'progress'
  | 'missing';

type GoalResult =
  | { ok: true; goals: readonly Goal[]; goal: Goal }
  | { ok: false; reason: GoalFailure };

function isIntegerProgress(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

export function createGoal(
  goals: readonly Goal[],
  input: GoalDraft & { id: string; now: Date },
): GoalResult {
  const title = input.title.trim();
  const description = input.description?.trim();
  if (!title || title.length > GOAL_TITLE_MAX) return { ok: false, reason: 'title' };
  if (description && description.length > GOAL_DESCRIPTION_MAX) {
    return { ok: false, reason: 'description' };
  }
  if (!isGoalPeriod(input.period)) return { ok: false, reason: 'period' };

  const periodKey = goalPeriodKey(input.period, input.now);
  if (!periodKey) return { ok: false, reason: 'period-key' };
  if (!isValidIsoDate(input.deadline)) return { ok: false, reason: 'deadline' };
  if (!isIntegerProgress(input.progress)) return { ok: false, reason: 'progress' };

  const stamp = input.now.toISOString();
  const goal: Goal = {
    id: input.id,
    title,
    period: input.period,
    periodKey,
    deadline: input.deadline,
    progress: input.progress,
    completed: input.progress === 100,
    createdAt: stamp,
    updatedAt: stamp,
    ...(description ? { description } : {}),
  };
  return { ok: true, goals: [...goals, goal], goal };
}

export function editGoal(
  goals: readonly Goal[],
  id: string,
  input: GoalDraft & { now: Date },
): GoalResult {
  const current = goals.find((goal) => goal.id === id);
  if (!current) return { ok: false, reason: 'missing' };

  const created = createGoal([], { ...input, id, now: input.now });
  if (!created.ok) return created;
  const goal: Goal = {
    ...created.goal,
    createdAt: current.createdAt,
    periodKey:
      input.period === current.period ? current.periodKey : created.goal.periodKey,
  };
  return {
    ok: true,
    goals: goals.map((item) => (item.id === id ? goal : item)),
    goal,
  };
}

export function setGoalProgress(
  goals: readonly Goal[],
  id: string,
  progress: number,
  now: Date,
): GoalResult {
  const current = goals.find((goal) => goal.id === id);
  if (!current) return { ok: false, reason: 'missing' };
  if (!isIntegerProgress(progress)) return { ok: false, reason: 'progress' };
  const goal: Goal = {
    ...current,
    progress,
    completed: progress === 100,
    updatedAt: now.toISOString(),
  };
  return {
    ok: true,
    goals: goals.map((item) => (item.id === id ? goal : item)),
    goal,
  };
}

export function setGoalCompleted(
  goals: readonly Goal[],
  id: string,
  completed: boolean,
  now: Date,
): GoalResult {
  const current = goals.find((goal) => goal.id === id);
  if (!current) return { ok: false, reason: 'missing' };
  const goal: Goal = {
    ...current,
    completed,
    progress: completed ? 100 : current.progress === 100 ? 0 : current.progress,
    updatedAt: now.toISOString(),
  };
  return {
    ok: true,
    goals: goals.map((item) => (item.id === id ? goal : item)),
    goal,
  };
}

export function removeGoal(
  goals: readonly Goal[],
  id: string,
): { ok: true; goals: readonly Goal[] } | { ok: false; reason: 'missing' } {
  if (!goals.some((goal) => goal.id === id)) return { ok: false, reason: 'missing' };
  return { ok: true, goals: goals.filter((goal) => goal.id !== id) };
}

export function goalsForPeriod(
  goals: readonly Goal[],
  period: GoalPeriod,
  periodKey: string,
  showCompleted: boolean,
): Goal[] {
  return goals
    .filter(
      (goal) =>
        goal.period === period &&
        goal.periodKey === periodKey &&
        (showCompleted || !goal.completed),
    )
    .sort(
      (left, right) =>
        left.deadline.localeCompare(right.deadline) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

export { isGoalPeriodKey };
