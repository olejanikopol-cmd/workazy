import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySheetCompletion,
  closeSheetIfSame,
  createSheetLock,
  isDraftUnchanged,
  isSameSheet,
  isSheetDirty,
} from '../src/features/calendar/calendarSheetGuard.ts';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('closeSheetIfSame closes only the sheet whose async operation completed', () => {
  const current = { key: 'add-2026-09-10-1', mode: 'add', targetDate: '2026-09-10' };
  assert.equal(closeSheetIfSame(current, 'add-2026-09-10-1'), null);
  const stale = closeSheetIfSame(current, 'add-2026-09-10-0');
  assert.ok(stale !== null);
  assert.equal(stale.key, 'add-2026-09-10-1');
  assert.equal(closeSheetIfSame(null, 'add-2026-09-10-1'), null);
});

test('isSameSheet resolves the intended identity', () => {
  assert.equal(isSameSheet({ key: 'read-event-1-7' }, 'read-event-1-7'), true);
  assert.equal(isSameSheet({ key: 'read-event-1-7' }, 'read-event-1-9'), false);
  assert.equal(isSameSheet(null, 'read-event-1-7'), false);
});

test('isDraftUnchanged rejects completions when the draft changed mid-write', () => {
  assert.equal(isDraftUnchanged(2, 2), true);
  assert.equal(isDraftUnchanged(3, 2), false);
  assert.equal(isDraftUnchanged(0, 0), true);
});


test('isSheetDirty covers title, note, date, time/no-time and reminder', () => {
  const initial = {
    title: 'Тренировка',
    note: 'Зал',
    date: '2026-09-20',
    hasTime: true,
    time: '19:00',
    reminder: '',
  };
  // Untouched form is not dirty.
  assert.equal(isSheetDirty({ ...initial }, initial), false);

  assert.equal(isSheetDirty({ ...initial, title: 'Йога' }, initial), true);
  assert.equal(isSheetDirty({ ...initial, note: 'Другое' }, initial), true);
  assert.equal(isSheetDirty({ ...initial, date: '2026-09-21' }, initial), true);
  assert.equal(isSheetDirty({ ...initial, hasTime: false }, initial), true);
  assert.equal(isSheetDirty({ ...initial, time: '20:00' }, initial), true);
  assert.equal(isSheetDirty({ ...initial, reminder: 'За 30 минут' }, initial), true);

  // Time comparison only matters when BOTH have an exact time enabled.
  const untimed = { ...initial, hasTime: false, time: '19:00' };
  assert.equal(isSheetDirty({ ...untimed, time: '99:99' }, untimed), false);
});



test('applySheetCompletion closes the matching sheet and reveals its destination date', () => {
  const sheet = { key: 'add-2026-09-10-1', mode: 'add', targetDate: '2026-09-10' };
  const applied = applySheetCompletion(sheet, 'add-2026-09-10-1', '2026-09-12');
  assert.equal(applied.next, null);
  assert.equal(applied.reveal, '2026-09-12');
  // Nothing open: a stale completion neither closes nor reveals.
  const empty = applySheetCompletion(null, 'add-2026-09-10-1', '2026-09-12');
  assert.equal(empty.next, null);
  assert.equal(empty.reveal, null);
});

test('delete completion racing a newer editor leaves the newer sheet open (delete async race)', async () => {
  // Editor A edits/deletes event e1.
  const sheetA = { key: 'read-e1-1000', mode: 'read', itemId: 'e1' };
  let open = sheetA;
  const revealed = [];

  // The delete waits for reconciliation of the committed state.
  const gate = deferred();
  const deleting = (async () => {
    await gate.promise;
    const applied = applySheetCompletion(open, sheetA.key, undefined);
    if (applied.reveal) revealed.push(applied.reveal);
    open = applied.next;
  })();

  // While that is pending the user opens a NEWER editor B.
  const sheetB = { key: 'read-e2-2000', mode: 'read', itemId: 'e2' };
  open = sheetB;
  gate.resolve();
  await deleting;

  assert.equal(open, sheetB); // the newer editor stays open
  assert.deepEqual(revealed, []); // no stale view jump to the deleted event
});


test('the editor busy lock is synchronous and shared by save and delete', async () => {
  const lock = createSheetLock();
  assert.equal(lock.isBusy(), false);

  // Save acquires BEFORE any await: a second operation is rejected synchronously.
  assert.equal(lock.acquire(), true);
  assert.equal(lock.isBusy(), true);
  assert.equal(lock.acquire(), false); // delete/save/close while pending -> rejected

  // The pending operation stays locked across awaits (that is the whole point).
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lock.isBusy(), true);
  assert.equal(lock.acquire(), false);

  // Release happens in the operation's finally; afterwards the lock is reusable.
  lock.release();
  assert.equal(lock.isBusy(), false);
  assert.equal(lock.acquire(), true);
  lock.release();
});

test('delete holds the lock for its whole awaited reconciliation (dismissal blocked)', async () => {
  const lock = createSheetLock();
  let dismissed = false;
  const delay = deferred();
  const deletion = (async () => {
    assert.equal(lock.acquire(), true);
    try {
      await delay.promise; // remove + awaited reconciliation
    } finally {
      lock.release();
    }
  })();

  // While the delete (and its reconciliation) is pending, dismissal is refused.
  const requestClose = () => {
    if (lock.isBusy()) return;
    dismissed = true;
  };
  requestClose();
  assert.equal(dismissed, false);
  assert.equal(lock.acquire(), false);

  delay.resolve();
  await deletion;
  requestClose();
  assert.equal(dismissed, true); // only after the operation released the lock
});
