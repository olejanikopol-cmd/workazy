/**
 * Pure daily-plan mutations, selectors and input validation.
 *
 * One ordered tasks array contains all dates; rows are filtered per day without
 * re-sorting. IDs (never indexes/titles) are mutation targets; duplicate titles
 * are allowed. Mutations return a discarded `tasks` array; they never mutate
 * input. `updatedAt` is stamped only when content/order actually changes.
 */
import type { PlanTask } from '@/types/plan';
import { isValidIsoDate } from './planDates';

export const TITLE_MAX_LENGTH = 300;

export type ValidationFailure = { ok: false; reason: 'validation' | 'missing' };

export type AddTaskResult =
  | { ok: true; tasks: readonly PlanTask[]; task: PlanTask }
  | ValidationFailure;

export type TasksResult = { ok: true; tasks: readonly PlanTask[] } | ValidationFailure;

export type TitleValidation =
  | { ok: true; title: string }
  | { ok: false; reason: 'blank' | 'too-long' };

export type AddTaskInput = {
  id: string;
  title: string;
  date: string;
  now: Date;
};

/**
 * Trim outer whitespace and require 1–300 characters. Internal newlines are
 * preserved and Unicode is untouched. The trimmed string is returned.
 */
export function validateTitle(raw: string): TitleValidation {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, reason: 'blank' };
  if (title.length > TITLE_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  return { ok: true, title };
}

/** Append a new incomplete item for `date`; used by the store's `add`. */
export function addTask(tasks: readonly PlanTask[], input: AddTaskInput): AddTaskResult {
  const title = validateTitle(input.title);
  if (!title.ok) return { ok: false, reason: 'validation' };
  if (!input.date || !isValidIsoDate(input.date)) return { ok: false, reason: 'validation' };
  const nowIso = input.now.toISOString();
  const task: PlanTask = {
    id: input.id,
    title: title.title,
    completed: false,
    date: input.date,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return { ok: true, tasks: [...tasks, task], task };
}

/**
 * Change only `completed` and `updatedAt`. Explicit uncheck is preserved —
 * no sort-away, no ID/timestamp regeneration, no side effects on other rows.
 */
export function toggleTask(tasks: readonly PlanTask[], id: string, now: Date): TasksResult {
  if (!tasks.some((task) => task.id === id)) return { ok: false, reason: 'missing' };
  const updatedAt = now.toISOString();
  return {
    ok: true,
    tasks: tasks.map((task) =>
      task.id === id ? { ...task, completed: !task.completed, updatedAt } : task,
    ),
  };
}

/** Change only `title` and `updatedAt`; retain id/date/createdAt/completion/order. */
export function editTask(
  tasks: readonly PlanTask[],
  id: string,
  rawTitle: string,
  now: Date,
): TasksResult {
  if (!tasks.some((task) => task.id === id)) return { ok: false, reason: 'missing' };
  const title = validateTitle(rawTitle);
  if (!title.ok) return { ok: false, reason: 'validation' };
  const updatedAt = now.toISOString();
  return {
    ok: true,
    tasks: tasks.map((task) =>
      task.id === id ? { ...task, title: title.title, updatedAt } : task,
    ),
  };
}

/** Remove exactly one row by ID. */
export function removeTask(tasks: readonly PlanTask[], id: string): TasksResult {
  if (!tasks.some((task) => task.id === id)) return { ok: false, reason: 'missing' };
  return { ok: true, tasks: tasks.filter((task) => task.id !== id) };
}

/**
 * Swap the item with its adjacent same-day neighbor in the full array,
 * matching the web implementation. Other dates' order/content are untouched.
 * Boundary moves return the input array unchanged (no-op); a missing ID fails.
 */
export function moveTask(
  tasks: readonly PlanTask[],
  id: string,
  direction: -1 | 1,
  now: Date,
): TasksResult {
  const target = tasks.find((task) => task.id === id);
  if (!target) return { ok: false, reason: 'missing' };
  const sameDay = tasks.filter((task) => task.date === target.date);
  const index = sameDay.findIndex((task) => task.id === id);
  const neighbor = sameDay[index + direction];
  if (!neighbor) return { ok: true, tasks };
  const from = tasks.findIndex((task) => task.id === id);
  const to = tasks.findIndex((task) => task.id === neighbor.id);
  if (from < 0 || to < 0 || from === to) return { ok: true, tasks };
  const updatedAt = now.toISOString();
  const copy = [...tasks];
  [copy[from], copy[to]] = [copy[to], copy[from]];
  copy[from] = { ...copy[from], updatedAt };
  copy[to] = { ...copy[to], updatedAt };
  return { ok: true, tasks: copy };
}

/** All tasks for a date, preserving the global array order. */
export function tasksForDate(tasks: readonly PlanTask[], date: string): PlanTask[] {
  return tasks.filter((task) => task.date === date);
}

/** Derived progress for a selected day; never persisted. */
export function dayProgress(
  tasks: readonly PlanTask[],
  date: string,
): { done: number; total: number; percent: number } {
  const day = tasksForDate(tasks, date);
  const done = day.filter((task) => task.completed).length;
  return {
    done,
    total: day.length,
    percent: day.length ? Math.round((done / day.length) * 100) : 0,
  };
}

/** Row number for a selected day, e.g. `03`. */
export function rowNumber(index: number): string {
  return String(index + 1).padStart(2, '0');
}