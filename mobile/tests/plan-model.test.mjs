import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTask,
  dayProgress,
  editTask,
  moveTask,
  removeTask,
  rowNumber,
  tasksForDate,
  toggleTask,
  validateTitle,
  TITLE_MAX_LENGTH,
} from '../src/features/plans/planModel.ts';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const T0 = '2026-09-10';
const T1 = '2026-09-11';

/** Build a task in a stable shape for the assertions below. */
function mk(taskId, title, date, completed = false, createdAt = undefined) {
  return { id: taskId, title, completed, date, createdAt, updatedAt: undefined };
}

test('add trims outer whitespace, preserves Unicode/internal newlines and appends', () => {
  const base = [mk('task-a', 'Дело A', T0)];
  const raw = '  Задача\nс переносом\t \nи эмодзи 🎯  ';
  const result = addTask(base, { id: 'task-new', title: raw, date: T0, now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.task.title, 'Задача\nс переносом\t \nи эмодзи 🎯');
  assert.equal(result.task.completed, false);
  assert.equal(result.task.date, T0);
  assert.equal(result.task.createdAt, NOW.toISOString());
  assert.equal(result.task.updatedAt, NOW.toISOString());
  assert.equal(result.tasks.length, 2);
  const ids = result.tasks.map((task) => task.id);
  assert.deepEqual(ids, ['task-a', 'task-new']);
});

test('add rejects blank and over-300 titles without changing the array', () => {
  const base = [mk('task-a', 'Дело A', T0)];
  const blank = addTask(base, { id: 'x1', title: '   \n  ', date: T0, now: NOW });
  assert.deepEqual(blank, { ok: false, reason: 'validation' });
  const long = addTask(base, {
    id: 'x2',
    title: 'а'.repeat(TITLE_MAX_LENGTH + 1),
    date: T0,
    now: NOW,
  });
  assert.deepEqual(long, { ok: false, reason: 'validation' });
  assert.equal(base.length, 1);
});

test('add permits duplicate titles with distinct IDs', () => {
  const base = [mk('task-a', 'Повтор', T0)];
  const first = addTask(base, { id: 'p1', title: 'Повтор', date: T0, now: NOW });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = addTask(first.tasks, { id: 'p2', title: 'Повтор  ', date: T0, now: NOW });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.tasks[1].id, 'p1');
  assert.equal(second.tasks[2].id, 'p2');
  assert.equal(second.tasks[0].title, 'Повтор');
  assert.equal(second.tasks[1].title, 'Повтор');
});

test('toggle true then false persists the latest explicit choice; edits keep identity/date/createdAt', () => {
  const base = [mk('task-a', 'Дело A', T0, false, '2026-09-01T00:00:00.000Z')];
  const on = toggleTask(base, 'task-a', new Date('2026-09-10T13:00:00.000Z'));
  assert.equal(on.ok, true);
  if (!on.ok) return;
  assert.equal(on.tasks[0].completed, true);
  assert.equal(on.tasks[0].updatedAt, '2026-09-10T13:00:00.000Z');
  const off = toggleTask(on.tasks, 'task-a', new Date('2026-09-10T14:00:00.000Z'));
  assert.equal(off.ok, true);
  if (!off.ok) return;
test('day filtering, numbering and progress; completed rows retain position', () => {
  const all = [
    mk('t1', 'День A #1', T0, true),
    mk('t2', 'День B #1', T1),
    mk('t3', 'День A #2', T0),
    mk('t4', 'День B #2', T1, true),
    mk('t5', 'День A #3', T0),
  ];
  const dayA = tasksForDate(all, T0);
  assert.deepEqual(dayA.map((t) => t.id), ['t1', 't3', 't5']);
  assert.deepEqual(dayA.map((_, i) => rowNumber(i)), ['01', '02', '03']);
  const progress = dayProgress(all, T0);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  assert.equal(progress.percent, 33);
  const empty = dayProgress(all, '2026-09-12');
  assert.deepEqual(empty, { done: 0, total: 0, percent: 0 });
});

test('move swaps only adjacent same-day items even with interleaved other dates', () => {
  const all = [
    mk('a', 'A1', T0),
    mk('b', 'B1', T1),
    mk('c', 'A2', T0),
    mk('d', 'B2', T1),
    mk('e', 'A3', T0),
  ];
  const moved = moveTask(all, 'a', 1, NOW);
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.deepEqual(moved.tasks.map((t) => t.id), ['c', 'b', 'a', 'd', 'e']);
  // Updated timestamps on the two swapped rows only.
  assert.equal(moved.tasks[0].updatedAt, NOW.toISOString());
  assert.equal(moved.tasks[2].updatedAt, NOW.toISOString());
  assert.equal(moved.tasks[1].updatedAt, undefined);
  assert.equal(moved.tasks[3].updatedAt, undefined);
  assert.equal(moved.tasks[4].updatedAt, undefined);
});

test('move boundary is a no-op and does not regenerate rows', () => {
  const all = [mk('a', 'A1', T0), mk('c', 'A2', T0), mk('b', 'B1', T1)];
  const up = moveTask(all, 'a', -1, NOW);
  assert.equal(up.ok, true);
  assert.equal(up.tasks, all); // same reference → no persist
  const down = moveTask(all, 'c', 1, NOW);
  assert.equal(down.ok, true);
  assert.equal(down.tasks, all);
  assert.deepEqual(down.tasks.map((t) => t.id), ['a', 'c', 'b']);
});

test('delete removes one ID and derived rows renumber', () => {
  const all = [mk('a', 'A1', T0), mk('c', 'A2', T0), mk('b', 'B1', T1)];
  const removed = removeTask(all, 'c');
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.deepEqual(removed.tasks.map((t) => t.id), ['a', 'b']);
  const day = tasksForDate(removed.tasks, T0);
  assert.deepEqual(day.map((_, i) => rowNumber(i)), ['01']);
});

test('validateTitle trims and enforces the 1-300 rule', () => {
  assert.deepEqual(validateTitle('   '), { ok: false, reason: 'blank' });
  assert.deepEqual(validateTitle(''), { ok: false, reason: 'blank' });
  assert.deepEqual(validateTitle('  valid  '), { ok: true, title: 'valid' });
  assert.deepEqual(
    validateTitle('а'.repeat(TITLE_MAX_LENGTH + 1)),
    { ok: false, reason: 'too-long' },
  );
  assert.deepEqual(
    validateTitle('а'.repeat(TITLE_MAX_LENGTH)),
    { ok: true, title: 'а'.repeat(TITLE_MAX_LENGTH) },
  );
});
  assert.equal(off.tasks[0].completed, false);
  assert.equal(off.tasks[0].updatedAt, '2026-09-10T14:00:00.000Z');

  const edited = editTask(off.tasks, 'task-a', 'Дело A обновлено', new Date('2026-09-10T15:00:00.000Z'));
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  const after = edited.tasks[0];
  assert.equal(after.title, 'Дело A обновлено');
  assert.equal(after.completed, false);
  assert.equal(after.date, T0);
  assert.equal(after.id, 'task-a');
  assert.equal(after.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(after.updatedAt, '2026-09-10T15:00:00.000Z');
});

test('missing IDs cannot edit/toggle/delete/remove a different row', () => {
  const base = [mk('task-a', 'Дело A', T0)];
  assert.deepEqual(toggleTask(base, 'nope', NOW), { ok: false, reason: 'missing' });
  assert.deepEqual(editTask(base, 'nope', 'x', NOW), { ok: false, reason: 'missing' });
  assert.deepEqual(removeTask(base, 'nope'), { ok: false, reason: 'missing' });
  assert.deepEqual(moveTask(base, 'nope', 1, NOW), { ok: false, reason: 'missing' });
});