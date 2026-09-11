import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanStore } from '../src/features/plans/planStore.ts';
import { parseSnapshot, serializeSnapshot } from '../src/storage/planStorage.ts';

const SAVED_AT = '2026-09-10T00:00:00.000Z';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** In-memory async storage with failure/gate controls. */
function createAdapter({ raw = null, getItemGate = null } = {}) {
  let rawValue = raw;
  let failNextWrite = false;
  let failNextRead = false;
  const state = {
    getCalls: 0,
    setCalls: 0,
    written: [],
    raw: () => rawValue,
    setRaw(value) {
      rawValue = value;
    },
    failNextWrite() {
      failNextWrite = true;
    },
    failNextRead() {
      failNextRead = true;
    },
  };
  return {
    state,
    async getItem() {
      state.getCalls += 1;
      if (failNextRead) {
        failNextRead = false;
        throw new Error('read failed');
      }
      if (getItemGate) await getItemGate.promise;
      return rawValue;
    },
    async setItem(key, value) {
      state.setCalls += 1;
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('write failed');
      }
      rawValue = value;
      state.written.push(value);
    },
  };
}

function makeStore(adapter) {
  let idCounter = 0;
  const now = () => new Date('2026-09-10T12:00:00.000Z');
  const createId = () => `task-${++idCounter}`;
  const store = createPlanStore({ storage: adapter, now, createId });
  return { store };
}

function task(tid, title, date, completed = false, createdAt, updatedAt) {
  return {
    id: tid,
    title,
    completed,
    date,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

test('fresh-store round-trip preserves dates/order/completion/text/optional timestamps', async () => {
  const tasks = [
    task('task-a', 'Дело A', '2026-09-10', true, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'),
    task('task-b', 'Дело B\nмногострочное', '2026-09-11', false),
    task('task-c', 'Старое', '2026-06-01', false),
  ];
  const adapter = createAdapter({ raw: serializeSnapshot(tasks, SAVED_AT) });
  const { store } = makeStore(adapter);
  await store.load();
  const state = store.getSnapshot();
  assert.equal(state.phase, 'ready');
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks[0].title, 'Дело A');
  assert.equal(state.tasks[0].completed, true);
  assert.equal(state.tasks[0].createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(state.tasks[0].updatedAt, '2026-09-02T00:00:00.000Z');
  assert.equal(state.tasks[1].title, 'Дело B\nмногострочное');
  assert.equal(state.tasks[1].date, '2026-09-11');
  assert.equal(state.tasks[2].date, '2026-06-01');
  assert.equal('createdAt' in state.tasks[1], false);
  assert.equal('updatedAt' in state.tasks[1], false);
  assert.equal(adapter.state.setCalls, 0); // hydration never writes
});

test('missing key loads empty ready state and the first add persists', async () => {
  const adapter = createAdapter();
  const { store } = makeStore(adapter);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.deepEqual(store.getSnapshot().tasks, []);
  const result = await store.add('Первое дело', '2026-09-10');
  assert.deepEqual(result, { ok: true });
  assert.equal(store.getSnapshot().tasks.length, 1);
  assert.equal(adapter.state.setCalls, 1);
  const parsed = parseSnapshot(adapter.state.raw());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.snapshot.tasks[0].title, 'Первое дело');
    assert.equal(parsed.snapshot.tasks[0].completed, false);
    assert.equal(parsed.snapshot.tasks[0].date, '2026-09-10');
  }
});

test('store persists explicit uncheck and preserves identity/date when editing a completed row', async () => {
  const seed = serializeSnapshot([task('task-a', 'Дело A', '2026-09-10', false)], SAVED_AT);
  const adapter = createAdapter({ raw: seed });
  const { store } = makeStore(adapter);
  await store.load();
  await store.toggle('task-a');
  assert.equal(store.getSnapshot().tasks[0].completed, true);
  await store.edit('task-a', 'Дело A всё ещё');
  assert.equal(store.getSnapshot().tasks[0].completed, true); // edit preserves completion
  await store.toggle('task-a');
  assert.equal(store.getSnapshot().tasks[0].completed, false);
  assert.equal(store.getSnapshot().tasks[0].id, 'task-a');
  assert.equal(store.getSnapshot().tasks[0].date, '2026-09-10');
  const parsed = parseSnapshot(adapter.state.raw());
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.snapshot.tasks[0].completed, false);
});

test('delayed hydration rejects mutations; duplicate load coalesces; later commits survive', async () => {
  const gate = deferred();
  const adapter = createAdapter({ raw: null, getItemGate: gate });
  const { store } = makeStore(adapter);
  const p1 = store.load();
  const p2 = store.load();
  assert.equal(adapter.state.getCalls, 1); // coalesced, single read
  const early = await store.add('too early', '2026-09-10');
  assert.deepEqual(early, { ok: false, reason: 'not-ready' });
  gate.resolve();
  await p1;
  await p2;
  assert.equal(store.getSnapshot().phase, 'ready');
  const added = await store.add('Первое', '2026-09-10');
  assert.deepEqual(added, { ok: true });
  await store.load(); // idempotent after ready
  assert.equal(adapter.state.getCalls, 1);
  assert.equal(store.getSnapshot().tasks.length, 1);
  assert.equal(store.getSnapshot().tasks[0].title, 'Первое');
test('delayed writes lock synchronously; duplicate add/toggle returns busy without a second write', async () => {
  const adapter = createAdapter();
  let release;
  const gate = new Promise((res) => {
    release = res;
  });
  let gatedSetCalls = 0;
  const gatedAdapter = {
    ...adapter,
    async setItem(key, value) {
      gatedSetCalls += 1;
      await gate;
      return adapter.setItem(key, value);
    },
  };
  const { store } = makeStore(gatedAdapter);
  await store.load();
  const add1 = store.add('Первый', '2026-09-10');
  assert.equal(store.getSnapshot().saving, true); // synchronous lock
  const add2 = await store.add('Второй', '2026-09-10');
  assert.deepEqual(add2, { ok: false, reason: 'busy' });
  const lockedToggle = await store.toggle('task-1');
  assert.deepEqual(lockedToggle, { ok: false, reason: 'busy' });
  release();
  const res1 = await add1;
  assert.deepEqual(res1, { ok: true });
  assert.equal(gatedSetCalls, 1); // no duplicate write
  assert.equal(store.getSnapshot().tasks.length, 1);
  assert.equal(store.getSnapshot().tasks[0].title, 'Первый');
  assert.equal(store.getSnapshot().saving, false);
});

test('write rejection keeps state/storage unchanged, unlocks, and retry succeeds (add/edit/toggle/delete)', async () => {
  const seed = serializeSnapshot(
    [task('task-a', 'Дело A', '2026-09-10', false, '2026-09-01T00:00:00.000Z')],
    '2026-09-10T10:00:00.000Z',
  );
  const adapter = createAdapter({ raw: seed });
  const { store } = makeStore(adapter);
  await store.load();
  const beforeRaw = adapter.state.raw();

  adapter.state.failNextWrite();
  const addFail = await store.add('Новый', '2026-09-10');
  assert.deepEqual(addFail, { ok: false, reason: 'storage' });
  assert.equal(store.getSnapshot().saving, false);
  assert.ok(store.getSnapshot().error);
  assert.equal(store.getSnapshot().tasks.length, 1);
  assert.equal(adapter.state.raw(), beforeRaw);
  const addOk = await store.add('Новый', '2026-09-10');
  assert.deepEqual(addOk, { ok: true });
  assert.equal(store.getSnapshot().tasks.length, 2);
  assert.equal(store.getSnapshot().error, null);

  adapter.state.failNextWrite();
  const editFail = await store.edit('task-a', 'Изменён');
  assert.deepEqual(editFail, { ok: false, reason: 'storage' });
  assert.equal(store.getSnapshot().tasks.find((t) => t.id === 'task-a').title, 'Дело A');
  const editOk = await store.edit('task-a', 'Изменён');
  assert.deepEqual(editOk, { ok: true });
  assert.equal(store.getSnapshot().tasks.find((t) => t.id === 'task-a').title, 'Изменён');

  adapter.state.failNextWrite();
  const toggleFail = await store.toggle('task-a');
  assert.deepEqual(toggleFail, { ok: false, reason: 'storage' });
  assert.equal(store.getSnapshot().tasks.find((t) => t.id === 'task-a').completed, false);
  const toggleOk = await store.toggle('task-a');
  assert.deepEqual(toggleOk, { ok: true });
  assert.equal(store.getSnapshot().tasks.find((t) => t.id === 'task-a').completed, true);

  adapter.state.failNextWrite();
  const deleteFail = await store.remove('task-a');
  assert.deepEqual(deleteFail, { ok: false, reason: 'storage' });
  assert.equal(store.getSnapshot().tasks.length, 2);
  const deleteOk = await store.remove('task-a');
  assert.deepEqual(deleteOk, { ok: true });
  assert.equal(store.getSnapshot().tasks.length, 1);
  assert.equal(store.getSnapshot().tasks[0].title, 'Новый');
});
test('malformed data and read failure yield load-error with zero writes and unchanged raw bytes', async () => {
  const badSnapshots = [
    'not-json',
    JSON.stringify({ version: 2, tasks: [], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'x', completed: false, date: '2026-09-10' }], savedAt: 'nope' }),
    JSON.stringify({ version: 1, tasks: [{ id: 'a', title: '', completed: false, date: '2026-09-10' }], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'x', completed: 'yes', date: '2026-09-10' }], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'x', completed: false, date: '2026-02-30' }], savedAt: SAVED_AT }),
    // Impossible calendar timestamps (2026-02-30 normalizes in Date.parse):
    JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'x', completed: false, date: '2026-09-10', createdAt: '2026-02-30T12:00:00.000Z' }], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'x', completed: false, date: '2026-09-10' }], savedAt: '2026-02-30T12:00:00.000Z' }),
    JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'x', completed: false, date: '2026-09-10' }, { id: 'a', title: 'y', completed: false, date: '2026-09-11' }], savedAt: SAVED_AT }),
  ];
  for (const raw of badSnapshots) {
    const adapter = createAdapter({ raw });
    const { store } = makeStore(adapter);
    await store.load();
    assert.equal(store.getSnapshot().phase, 'load-error');
    assert.equal(adapter.state.setCalls, 0);
    assert.equal(adapter.state.raw(), raw); // raw bytes untouched
    const mutate = await store.add('x', '2026-09-10');
    assert.ok(mutate.ok === false);
  }

  const readAdapter = createAdapter();
  readAdapter.state.failNextRead();
  const { store } = makeStore(readAdapter);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'load-error');
  assert.equal(readAdapter.state.setCalls, 0);
});

test('retryLoad recovers once the adapter returns valid data; over-300 title loads intact', async () => {
  const adapter = createAdapter({ raw: 'garbage' });
  const { store } = makeStore(adapter);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'load-error');
  const longTitle = 'а'.repeat(350);
  adapter.state.setRaw(
    serializeSnapshot([task('task-a', longTitle, '2026-09-10', false)], SAVED_AT),
  );
  await store.retryLoad();
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().tasks[0].title, longTitle);
  assert.equal(adapter.state.setCalls, 0);
});

test('move via the store writes a same-day swap and keeps other dates/order', async () => {
  const tasks = [
    task('t1', 'День A #1', '2026-09-10'),
    task('t2', 'День B #1', '2026-09-11'),
    task('t3', 'День A #2', '2026-09-10'),
  ];
  const adapter = createAdapter({ raw: serializeSnapshot(tasks, SAVED_AT) });
  const { store } = makeStore(adapter);
  await store.load();
  const moved = await store.move('t1', 1);
  assert.deepEqual(moved, { ok: true });
  assert.deepEqual(
    store.getSnapshot().tasks.map((t) => t.id),
    ['t3', 't2', 't1'],
  );
  // Boundary move is a no-op and does not write.
  const writesBefore = adapter.state.setCalls;
  const bounds = await store.move('t3', -1);
  assert.deepEqual(bounds, { ok: true });
  assert.equal(adapter.state.setCalls, writesBefore);
});
});
test('fresh-store round-trip: store A persists bytes; a brand-new store B restores them exactly', async () => {
  // Store A writes to its adapter.
  const adapterA = createAdapter();
  const { store: storeA } = makeStore(adapterA);
  await storeA.load();
  const addA = await storeA.add('Первый пункт', '2026-09-10');
  assert.deepEqual(addA, { ok: true });
  const addB = await storeA.add('Второй пункт\nс переносом', '2026-09-11');
  assert.deepEqual(addB, { ok: true });
  await storeA.toggle('task-1');
  await storeA.edit('task-2', 'Второй пункт (изменён)');

  const persistedA = adapterA.state.raw();
  assert.ok(persistedA !== null && persistedA.length > 0);
  const parsedA = parseSnapshot(persistedA);
  assert.equal(parsedA.ok, true);

  // Fresh store B hydrates from those exact bytes.
  const adapterB = createAdapter({ raw: persistedA });
  const { store: storeB } = makeStore(adapterB);
  await storeB.load();
  assert.equal(storeB.getSnapshot().phase, 'ready');
  assert.equal(adapterB.state.setCalls, 0); // hydration reads only

  const snapshotA = storeA.getSnapshot();
  const snapshotB = storeB.getSnapshot();
  assert.deepEqual(snapshotB.tasks, snapshotA.tasks);
  assert.equal(snapshotB.tasks.length, 2);
  assert.equal(snapshotB.tasks[0].id, 'task-1');
  assert.equal(snapshotB.tasks[0].title, 'Первый пункт');
  assert.equal(snapshotB.tasks[0].completed, true);
  assert.equal(snapshotB.tasks[0].date, '2026-09-10');
  assert.equal(snapshotB.tasks[1].id, 'task-2');
  assert.equal(snapshotB.tasks[1].title, 'Второй пункт (изменён)');
  assert.equal(snapshotB.tasks[1].date, '2026-09-11');
  assert.equal(snapshotB.tasks[1].completed, false);
  assert.ok(snapshotB.tasks[0].createdAt);
  assert.ok(snapshotB.tasks[0].updatedAt);

  // Mutating store B must not touch store A's committed snapshot.
  const toggleB = await storeB.toggle('task-2');
  assert.deepEqual(toggleB, { ok: true });
  assert.equal(storeB.getSnapshot().tasks[1].completed, true);
  assert.equal(storeA.getSnapshot().tasks[1].completed, false);
  assert.notEqual(adapterB.state.raw(), persistedA);
test('store A persists a DST-gap UTC timestamp; fresh store B loads the exact bytes', async () => {
  // 2026-03-29T03:30:00.000Z is inside the Europe/Kyiv spring-forward gap
  // (03:00 -> 04:00 local). It is a valid UTC instant: store A must be able to
  // persist it, and a fresh store B hydrating those exact bytes must load
  // successfully (not enter load-error) in any timezone.
  const gapInstant = new Date('2026-03-29T03:30:00.000Z');
  const adapterA = createAdapter();
  let idCounter = 0;
  const storeA = createPlanStore({
    storage: adapterA,
    now: () => gapInstant,
    createId: () => `task-${++idCounter}`,
  });
  await storeA.load();
  const addResult = await storeA.add('Пункт через DST-разрыв', '2026-03-29');
  assert.deepEqual(addResult, { ok: true });
  assert.equal(storeA.getSnapshot().tasks[0].createdAt, '2026-03-29T03:30:00.000Z');
  assert.equal(storeA.getSnapshot().tasks[0].updatedAt, '2026-03-29T03:30:00.000Z');

  const persistedA = adapterA.state.raw();
  assert.ok(persistedA !== null);
  const parsedA = parseSnapshot(persistedA);
  assert.equal(parsedA.ok, true);
  if (parsedA.ok) {
    assert.equal(parsedA.snapshot.savedAt, '2026-03-29T03:30:00.000Z');
    assert.equal(parsedA.snapshot.tasks[0].createdAt, '2026-03-29T03:30:00.000Z');
  }

  // Fresh store B from the exact persisted bytes.
  const adapterB = createAdapter({ raw: persistedA });
  const { store: storeB } = makeStore(adapterB);
  await storeB.load();
  assert.equal(storeB.getSnapshot().phase, 'ready');
  assert.equal(adapterB.state.setCalls, 0);
  assert.deepEqual(storeB.getSnapshot().tasks, storeA.getSnapshot().tasks);
  assert.equal(storeB.getSnapshot().tasks[0].createdAt, '2026-03-29T03:30:00.000Z');
});
});