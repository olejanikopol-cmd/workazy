import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarStore } from '../src/features/calendar/calendarStore.ts';
import {
  CALENDAR_STORAGE_KEY,
  parseSnapshot,
  serializeSnapshot,
} from '../src/storage/calendarStorage.ts';

const SAVED_AT = '2026-09-10T00:00:00.000Z';

function createAdapter({ raw = null, getItemGate = null } = {}) {
  let rawValue = raw;
  let failNextWrite = false;
  let failNextRead = false;
  const state = {
    getCalls: 0,
    setCalls: 0,
    raw: () => rawValue,
    setRaw(v) {
      rawValue = v;
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
    },
  };
}

function makeStore(adapter, { nowIso = '2026-09-10T12:00:00.000Z' } = {}) {
  let idCounter = 0;
  const now = () => new Date(nowIso);
  const createId = () => `event-${++idCounter}`;
  const store = createCalendarStore({ storage: adapter, now, createId });
  return { store };
}

function event(id, title, date, time, note, reminder, createdAt) {
  const e = { id, title, date };
  if (time !== undefined) e.time = time;
  if (note !== undefined) e.note = note;
  if (reminder !== undefined) e.reminder = reminder;
  if (createdAt !== undefined) e.createdAt = createdAt;
  return e;
}

function record(id, eventId, kind, fingerprint, status, nowIso = SAVED_AT) {
  return { id, eventId, kind, fingerprint, status, createdAt: nowIso, updatedAt: nowIso };
}

test('empty key loads empty ready state; add persists and round-trips through a fresh store', async () => {
  const adapterA = createAdapter();
  const { store: storeA } = makeStore(adapterA);
  await storeA.load();
  assert.equal(storeA.getSnapshot().phase, 'ready');
  assert.deepEqual(storeA.getSnapshot().events, []);

  const added = await storeA.add({
    title: 'Тренировка',
    date: '2026-09-20',
    time: '19:00',
    note: 'Спортзал',
    reminder: 'За 10 минут',
  });
  assert.deepEqual(added, { ok: true });
  const rawA = adapterA.state.raw();
  const parsed = parseSnapshot(rawA);
  assert.equal(parsed.ok, true);

  const adapterB = createAdapter({ raw: rawA });
  const { store: storeB } = makeStore(adapterB);
  await storeB.load();
  assert.equal(storeB.getSnapshot().phase, 'ready');
  assert.equal(adapterB.state.setCalls, 0);
  assert.deepEqual(storeB.getSnapshot().events, storeA.getSnapshot().events);
  assert.equal(storeB.getSnapshot().events[0].title, 'Тренировка');
  assert.equal(storeB.getSnapshot().events[0].time, '19:00');
  assert.equal(storeB.getSnapshot().events[0].reminder, 'За 10 минут');
  assert.equal(storeB.getSnapshot().events[0].createdAt, '2026-09-10T12:00:00.000Z');
});

test('fresh store B restores events and registry with a DST-gap savedAt under any TZ', async () => {
  const gapInstant = '2026-03-29T03:30:00.000Z';
  const raw = serializeSnapshot(
    [event('event-1', 'Событие в разрыв', '2026-03-29', '04:30', undefined, undefined, gapInstant)],
    [record('workazy.calendar.v1:event-1:start', 'event-1', 'start', 'fp1', 'scheduled', gapInstant)],
    gapInstant,
  );
  const adapterB = createAdapter({ raw });
  const { store: storeB } = makeStore(adapterB);
  await storeB.load();
  assert.equal(storeB.getSnapshot().phase, 'ready');
  assert.equal(storeB.getSnapshot().events[0].createdAt, gapInstant);
  assert.equal(storeB.getSnapshot().registry[0].id, 'workazy.calendar.v1:event-1:start');
  assert.equal(storeB.getSnapshot().registry[0].status, 'scheduled');
  assert.equal(adapterB.state.setCalls, 0);
});

test('corrupt/unknown-version/invalid registry/duplicate IDs yield load-error with zero writes', async () => {
  const registry = [record('workazy.calendar.v1:e1:start', 'e1', 'start', 'fp', 'scheduled')];
  const bad = [
    'not-json',
    JSON.stringify({ version: 2, events: [], registry: [], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, events: [], registry: [], savedAt: 'nope' }),
    JSON.stringify({ version: 1, events: [event('a', '', '2026-09-10')], registry: [], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, events: [event('a', 'x', '2026-02-30')], registry: [], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, events: [event('a', 't', '2026-09-10', '25:00')], registry: [], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, events: [event('a', 'x', '2026-09-10'), event('a', 'y', '2026-09-11')], registry: [], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, events: [], registry: [record('r', 'e', 'weird', 'fp', 'scheduled')], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, events: [], registry: [
      record('w:e:start', 'e', 'start', 'fp'),
      record('w:e:start', 'e', 'start', 'fp'),
    ], savedAt: SAVED_AT }),
    JSON.stringify({ version: 1, events: [event('a', 'x', '2026-09-10', undefined, undefined, undefined, '2026-02-30T12:00:00.000Z')], registry: [], savedAt: SAVED_AT }),
  ];
  for (const raw of bad) {
    const adapter = createAdapter({ raw });
    const { store } = makeStore(adapter);
    await store.load();
    assert.equal(store.getSnapshot().phase, 'load-error');
    assert.equal(adapter.state.setCalls, 0);
    assert.equal(adapter.state.raw(), raw);
    const mutate = await store.add({ title: 'x', date: '2026-09-10' });
    assert.ok(mutate.ok === false);
  }

  const readAdapter = createAdapter();
  readAdapter.state.failNextRead();
  const { store } = makeStore(readAdapter);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'load-error');
  assert.equal(readAdapter.state.setCalls, 0);
});

test('retryLoad recovers; hydration coalesces; mutation before ready is rejected', async () => {
  const adapter = createAdapter({ raw: 'garbage' });
  const { store } = makeStore(adapter);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'load-error');
  adapter.state.setRaw(serializeSnapshot([event('a', 'Восстановлено', '2026-09-10')], [], SAVED_AT));
  await store.retryLoad();
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().events[0].title, 'Восстановлено');
  assert.equal(adapter.state.setCalls, 0);

  // Delayed hydration coalesces reads and rejects mutations meanwhile.
  let resolve;
  const gate = new Promise((res) => {
    resolve = res;
  });
  const gated = createAdapter({ raw: null, getItemGate: { promise: gate } });
  const { store: gatedStore } = makeStore(gated);
  const p1 = gatedStore.load();
  const p2 = gatedStore.load();
  assert.equal(gated.state.getCalls, 1);
  assert.deepEqual(await gatedStore.add({ title: 'early', date: '2026-09-10' }), {
    ok: false,
    reason: 'not-ready',
  });
  resolve();
  await p1;
  await p2;
  await gatedStore.load();
  assert.equal(gated.state.getCalls, 1);
});

test('overlapping writes lock synchronously and a failed write preserves committed state', async () => {
  const adapter = createAdapter();
  let release;
  const gate = new Promise((res) => {
    release = res;
  });
  let gatedSetCalls = 0;
  const gated = {
    state: adapter.state,
    async getItem() {
      return adapter.getItem();
    },
    async setItem(key, value) {
      gatedSetCalls += 1;
      await gate;
      return adapter.setItem(key, value);
    },
  };
  const { store } = makeStore(gated);
  await store.load();
  const add1 = store.add({ title: 'Один', date: '2026-09-10' });
  assert.equal(store.getSnapshot().saving, true);
  const add2 = await store.add({ title: 'Два', date: '2026-09-10' });
  assert.deepEqual(add2, { ok: false, reason: 'busy' });
  release();
  assert.deepEqual(await add1, { ok: true });
  assert.equal(gatedSetCalls, 1);
  assert.equal(store.getSnapshot().events.length, 1);

  adapter.state.failNextWrite();
  const beforeRaw = adapter.state.raw();
  const failed = await store.add({ title: 'Х', date: '2026-09-11' });
  assert.deepEqual(failed, { ok: false, reason: 'storage' });
  assert.equal(store.getSnapshot().saving, false);
  assert.equal(store.getSnapshot().events.length, 1);
  assert.equal(adapter.state.raw(), beforeRaw);
  const retried = await store.add({ title: 'Х', date: '2026-09-11' });
  assert.deepEqual(retried, { ok: true });
  assert.equal(store.getSnapshot().events.length, 2);
});

test('setRegistry merges into current committed events (never a stale copy)', async () => {
  const adapter = createAdapter();
  const { store } = makeStore(adapter);
  await store.load();
  await store.add({ title: 'Событие', date: '2026-09-10', time: '10:00' });
  const record1 = record('workazy.calendar.v1:event-1:start', 'event-1', 'start', 'fp', 'scheduled');
  await store.setRegistry([record1]);
  // Events stay intact after a registry write.
  assert.equal(store.getSnapshot().events.length, 1);
  assert.equal(store.getSnapshot().registry[0].id, 'workazy.calendar.v1:event-1:start');
  const parsed = parseSnapshot(adapter.state.raw());
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.snapshot.events.length, 1);
});

test('calendar key is distinct from the plan key', async () => {
  assert.equal(CALENDAR_STORAGE_KEY, 'workazy-native-calendar-v1');
});
