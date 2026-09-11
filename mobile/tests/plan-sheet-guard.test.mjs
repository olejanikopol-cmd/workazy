import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSheetIfSame,
  isDraftUnchanged,
  isSameSheet,
} from '../src/features/plans/planSheetGuard.ts';

test('closeSheetIfSame closes only the sheet whose async operation completed', () => {
  const current = { key: 'add-2026-09-10-1', mode: 'add', targetDate: '2026-09-10' };
  // Completion from the currently open sheet closes it.
  assert.equal(closeSheetIfSame(current, 'add-2026-09-10-1'), null);
  // A stale completion from a previous sheet must NOT close the new sheet.
  const stale = closeSheetIfSame(current, 'add-2026-09-10-0');
  assert.ok(stale !== null);
  assert.equal(stale.key, 'add-2026-09-10-1');
  // No sheet open is always a no-op.
  assert.equal(closeSheetIfSame(null, 'add-2026-09-10-1'), null);
});

test('isSameSheet resolves the intended identity', () => {
  assert.equal(isSameSheet({ key: 'read-task-1-7' }, 'read-task-1-7'), true);
  assert.equal(isSameSheet({ key: 'read-task-1-7' }, 'read-task-1-9'), false);
  assert.equal(isSameSheet(null, 'read-task-1-7'), false);
});

test('isDraftUnchanged rejects completions when the draft changed mid-write', () => {
  assert.equal(isDraftUnchanged(2, 2), true);
  assert.equal(isDraftUnchanged(3, 2), false); // draft edited after save began
  assert.equal(isDraftUnchanged(0, 0), true);
});