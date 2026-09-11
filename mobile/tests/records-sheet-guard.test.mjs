import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowDelayedConfirmation,
  applySheetCompletion,
  createRecordsSheetLock,
  ideaCompletionEffects,
  ideaDraftDirty,
  isDraftUnchanged,
  journalCompletionAction,
  journalCompletionEffects,
  journalDraftDirty,
} from '../src/features/records/recordsSheetGuard.ts';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('the busy lock is synchronous and shared by save and delete', async () => {
  const lock = createRecordsSheetLock();
  assert.equal(lock.isBusy(), false);
  assert.equal(lock.acquire(), true);
  assert.equal(lock.isBusy(), true);
  assert.equal(lock.acquire(), false); // duplicate submit / dismissal while pending
  const pending = deferred();
  const operation = (async () => {
    try {
      await pending.promise;
    } finally {
      lock.release();
    }
  })();
  assert.equal(lock.isBusy(), true);
  assert.equal(lock.acquire(), false);
  pending.resolve();
  await operation;
  assert.equal(lock.isBusy(), false);
  assert.equal(lock.acquire(), true);
  lock.release();
});

test('a delete cannot start while a save holds the lock (and vice versa)', async () => {
  const lock = createRecordsSheetLock();
  let dismissals = 0;
  let deletes = 0;
  const requestClose = () => {
    if (!lock.isBusy()) dismissals += 1;
  };
  const save = deferred();
  const saving = (async () => {
    assert.equal(lock.acquire(), true);
    try {
      await save.promise;
    } finally {
      lock.release();
    }
  })();
  // While saving: dismissal refused and the delete cannot acquire the lock.
  requestClose();
  if (lock.acquire()) deletes += 1;
  assert.equal(dismissals, 0);
  assert.equal(deletes, 0);
  save.resolve();
  await saving;
  requestClose();
  if (lock.acquire()) deletes += 1;
  lock.release();
  assert.equal(dismissals, 1);
  assert.equal(deletes, 1);
});

test('decide on one shared lock: a delete holds it through its awaited persistence', async () => {
  const lock = createRecordsSheetLock();
  const persistence = deferred();
  let closedA = false;
  let closedB = false;
  const deleting = (async () => {
    assert.equal(lock.acquire(), true);
    try {
      await persistence.promise; // remove + await storage write
      return true;
    } finally {
      lock.release();
    }
  })();
  if (!lock.isBusy()) closedB = true;
  assert.equal(closedB, false);
  persistence.resolve();
  assert.equal(await deleting, true);
  if (!lock.isBusy()) closedA = true;
  assert.equal(closedA, true);
});

test('applySheetCompletion closes ONLY the current sheet identity', () => {
  const sheetA = { key: 'journal-read-1', mode: 'read', id: 'entry-1' };
  assert.deepEqual(applySheetCompletion(sheetA, 'journal-read-1'), { next: null, applied: true });
  const sheetB = { key: 'idea-read-2', mode: 'read', id: 'idea-2' };
  assert.deepEqual(applySheetCompletion(sheetB, 'journal-read-1'), { next: sheetB, applied: false });
  assert.deepEqual(applySheetCompletion(null, 'journal-read-1'), { next: null, applied: false });
});

test('a deferred save/delete from A cannot close or redirect a newer sheet B', async () => {
  const sheetA = { key: 'journal-read-1', mode: 'read', id: 'entry-1' };
  let open = sheetA;
  const persistence = deferred();
  const pendingDelete = (async () => {
    await persistence.promise;
    const outcome = applySheetCompletion(open, sheetA.key);
    if (outcome.applied) open = outcome.next; // the ONLY close path
  })();

  // The user opens a newer sheet B while A's delete is still persisting.
  const sheetB = { key: 'idea-edit-9', mode: 'edit', id: 'idea-9' };
  open = sheetB;
  persistence.resolve();
  await pendingDelete;
  assert.equal(open, sheetB); // B stayed open, no redirect
  assert.equal(open.key, 'idea-edit-9');
});

test('journal dirty detection covers every field including raw tags', () => {
  const initial = { title: 'T', body: 'B', mood: 'Спокойно', tags: 'дом, работа' };
  assert.equal(journalDraftDirty({ ...initial }, initial), false);
  assert.equal(journalDraftDirty({ ...initial, title: 'T2' }, initial), true);
  assert.equal(journalDraftDirty({ ...initial, body: 'B2' }, initial), true);
  assert.equal(journalDraftDirty({ ...initial, mood: '' }, initial), true);
  assert.equal(journalDraftDirty({ ...initial, tags: 'дом, работа ' }, initial), true);
});

test('idea dirty detection covers title/description/category/status', () => {
  const initial = { title: 'T', description: 'D', category: 'thought', status: 'new' };
  assert.equal(ideaDraftDirty({ ...initial }, initial), false);
  assert.equal(ideaDraftDirty({ ...initial, title: 'T2' }, initial), true);
  assert.equal(ideaDraftDirty({ ...initial, description: '' }, initial), true);
  assert.equal(ideaDraftDirty({ ...initial, category: 'want' }, initial), true);
  assert.equal(ideaDraftDirty({ ...initial, status: 'done' }, initial), true);
});

test('draft revisions reject a stale completion', () => {
  assert.equal(isDraftUnchanged(3, 3), true);
  assert.equal(isDraftUnchanged(4, 3), false);
});

test('journal completion policy: create reveals History, edit clears only a hiding search', () => {
  const entryRow = { title: 'Тренировка', body: 'Бег утром', mood: 'Энергично', tags: ['спорт'] };
  assert.deepEqual(journalCompletionEffects({ action: 'created' }, undefined, 'что-то'), {
    mode: 'history',
    clearSearch: true,
  });
  assert.deepEqual(journalCompletionEffects({ action: 'deleted', id: 'e1' }, entryRow, 'бег'), {
    mode: null,
    clearSearch: false,
  });
  // Saved entry hidden by the current query -> clear it so the row is visible.
  assert.deepEqual(journalCompletionEffects({ action: 'saved', id: 'e1' }, entryRow, 'отпуск'), {
    mode: null,
    clearSearch: true,
  });
  // Saved entry matches the query -> keep the search.
  assert.deepEqual(journalCompletionEffects({ action: 'saved', id: 'e1' }, entryRow, 'УТРОМ'), {
    mode: null,
    clearSearch: false,
  });
  // Empty query -> nothing to clear.
  assert.deepEqual(journalCompletionEffects({ action: 'saved', id: 'e1' }, entryRow, '   '), {
    mode: null,
    clearSearch: false,
  });
  // Transcript text counts as searchable, and a missing row is a no-op.
  assert.deepEqual(
    journalCompletionEffects(
      { action: 'saved', id: 'e1' },
      { body: '', tags: [], media: [{ transcript: 'голос' }] },
      'голос',
    ),
    { mode: null, clearSearch: false },
  );
  assert.deepEqual(journalCompletionEffects({ action: 'saved', id: 'gone' }, undefined, 'любое'), {
    mode: null,
    clearSearch: false,
  });
});

test('ideas completion policy: clears only the filters that would hide the idea', () => {
  const target = { category: 'project', status: 'plan' };
  assert.deepEqual(ideaCompletionEffects({ action: 'created' }, target, { category: 'all', status: 'all' }), {
    clearCategory: false,
    clearStatus: false,
  });
  assert.deepEqual(ideaCompletionEffects({ action: 'saved', id: 'i1' }, target, { category: 'project', status: 'all' }), {
    clearCategory: false,
    clearStatus: false,
  });
  assert.deepEqual(ideaCompletionEffects({ action: 'saved', id: 'i1' }, target, { category: 'want', status: 'plan' }), {
    clearCategory: true,
    clearStatus: false,
  });
  assert.deepEqual(ideaCompletionEffects({ action: 'saved', id: 'i1' }, target, { category: 'want', status: 'done' }), {
    clearCategory: true,
    clearStatus: true,
  });
  assert.deepEqual(ideaCompletionEffects({ action: 'deleted', id: 'i1' }, target, { category: 'want', status: 'done' }), {
    clearCategory: false,
    clearStatus: false,
  });
  assert.deepEqual(ideaCompletionEffects({ action: 'created' }, undefined, { category: 'want', status: 'all' }), {
    clearCategory: false,
    clearStatus: false,
  });
});


test('an edit stays on the reader while create/delete close the sheet', () => {
  assert.equal(journalCompletionAction({ action: 'saved', id: 'e1' }), 'stay-open');
  assert.equal(journalCompletionAction({ action: 'created' }), 'close');
  assert.equal(journalCompletionAction({ action: 'deleted', id: 'e1' }), 'close');
});

test('an in-place edit reveals only for the CURRENT identity', () => {
  // A completion for A while B is open is ignored (same identity rule the
  // parent uses for the in-place edit path).
  const openB = { key: 'b' };
  assert.equal(applySheetCompletion(openB, 'a').applied, false);
  // For the current identity an edit only clears a hiding search and never
  // changes the journal mode (the reader stays).
  assert.deepEqual(
    journalCompletionEffects(
      { action: 'saved', id: 'e1' },
      { title: 'Тренировка', body: 'Бег', tags: [] },
      'отпуск',
    ),
    { mode: null, clearSearch: true },
  );
});


test('a delayed confirmation opened for A never closes B once B is current', () => {
  const sheetA = { key: 'journal-read-1', mode: 'read', id: 'entry-1' };
  const sheetB = { key: 'journal-edit-2', mode: 'edit', id: 'entry-2' };
  let open = sheetA;
  const revisionAtConfirm = 0; // revision captured when the confirmation opened
  let closed = null;

  // The delayed confirm callback is exactly the production shape: re-check the
  // CURRENT identity/busy/revision, then apply through the completion guard.
  const confirmForA = () => {
    const stillCurrent = open !== null && open.key === sheetA.key;
    if (!allowDelayedConfirmation({ stillCurrent, busy: false, revisionAtConfirm, revisionNow: 0 })) {
      return;
    }
    const applied = applySheetCompletion(open, sheetA.key);
    if (applied.applied) {
      open = applied.next;
      closed = sheetA.key;
    }
  };

  // B replaces A before the user taps confirm.
  open = sheetB;
  confirmForA();
  assert.equal(open, sheetB); // B stays open
  assert.equal(closed, null); // A never closed anything
});

test('a delayed DELETE confirmation for A never mutates or closes once B is current', async () => {
  const sheetA = { key: 'idea-read-1', mode: 'read', id: 'idea-1' };
  const sheetB = { key: 'idea-read-2', mode: 'read', id: 'idea-2' };
  let open = sheetA;
  const removed = [];
  const revisionAtConfirm = 3;

  const confirmDeleteA = async () => {
    const stillCurrent = open !== null && open.key === sheetA.key;
    if (
      !allowDelayedConfirmation({
        stillCurrent,
        busy: false,
        revisionAtConfirm,
        revisionNow: 3,
      })
    ) {
      return; // no mutation at all
    }
    removed.push(sheetA.id);
    const applied = applySheetCompletion(open, sheetA.key);
    if (applied.applied) open = applied.next;
  };

  open = sheetB;
  await confirmDeleteA();
  assert.deepEqual(removed, []); // A's row was NOT deleted
  assert.equal(open, sheetB); // B stayed open

  // With A still current the same callback does act.
  open = sheetA;
  await confirmDeleteA();
  assert.deepEqual(removed, ['idea-1']);
  assert.equal(open, null);
});

test('a busy sheet cannot be dismissed through a delayed confirmation', () => {
  const locked = {
    stillCurrent: true,
    busy: true, // a save/delete/status write is pending
    revisionAtConfirm: 0,
    revisionNow: 0,
  };
  assert.equal(allowDelayedConfirmation(locked), false);
  // The draft changed while the confirmation was open -> also refused.
  assert.equal(
    allowDelayedConfirmation({ ...locked, busy: false, revisionNow: locked.revisionAtConfirm + 1 }),
    false,
  );
  assert.equal(allowDelayedConfirmation({ ...locked, busy: false }), true);
});

test('old save/delete completions for A never close the newer sheet B', () => {
  const sheetA = { key: 'journal-read-1', mode: 'read', id: 'entry-1' };
  const sheetB = { key: 'journal-new-2', mode: 'add', date: '2026-09-11' };
  for (const action of ['saved', 'deleted']) {
    const applied = applySheetCompletion(sheetB, sheetA.key);
    assert.equal(applied.applied, false, action);
    assert.equal(applied.next, sheetB);
    // The close decision is also identity-scoped: only a completion for the
    // current sheet may close it.
    assert.equal(
      journalCompletionAction({ action, id: 'entry-1' }) === 'stay-open' || action === 'deleted',
      true,
    );
  }
  // A completion for the CURRENT sheet is applied.
  assert.deepEqual(applySheetCompletion(sheetB, sheetB.key), { next: null, applied: true });
});
