import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarStore } from '../src/features/calendar/calendarStore.ts';
import { parseSnapshot } from '../src/storage/calendarStorage.ts';
import { runCoordinatedReconcile } from '../src/services/notifications/calendarReconcileCoordinator.ts';

const TZ = 'Europe/Kyiv';
const NOW = new Date('2026-09-10T00:00:00.000Z');
const GRANTED = { granted: true, provisional: false, canAskAgain: true, status: 'granted' };

function createAdapter({ raw = null } = {}) {
  let rawValue = raw;
  let failNextWrite = false;
  const state = { setCalls: 0, raw: () => rawValue, failNextWrite() { failNextWrite = true; } };
  return {
    state,
    async getItem() {
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

function makeStore(adapter) {
  let idCounter = 0;
  return createCalendarStore({
    storage: adapter,
    now: () => NOW,
    createId: () => `event-${++idCounter}`,
  });
}

function scheduledPending(id, triggerAt, eventId, kind, fingerprint, title = 'Workazy', body = 'x') {
  return {
    identifier: id,
    triggerAt,
    triggerShape: 'absolute',
    data: { owner: 'workazy-calendar-v1', eventId, kind, fingerprint },
    contentTitle: title,
    contentBody: body,
  };
}

class FakeOS {
  constructor({ pending = [], scheduleGate = null } = {}) {
    this.scheduleGate = scheduleGate;
    this.scheduleCalls = [];
    this.cancelCalls = [];
    this.pending = pending.map((p) => ({ ...p, data: p.data ? { ...p.data } : null }));
  }
  async getPermissions() {
    return GRANTED;
  }
  async listPending() {
    return this.pending.map((p) => ({ ...p, data: p.data ? { ...p.data } : null }));
  }
  async schedule(request) {
    this.scheduleCalls.push(request.id);
    if (this.scheduleGate) await this.scheduleGate.promise;
    this.pending = this.pending.filter((p) => p.identifier !== request.id);
    this.pending.push(
      scheduledPending(request.id, request.triggerAt, request.eventId, request.kind, request.fingerprint, request.title, request.body),
    );
    // Mirror production: the exact target instant travels inside the request.
    this.pending[this.pending.length - 1].data = {
      ...this.pending[this.pending.length - 1].data,
      targetTriggerAt: request.triggerAt,
    };
    return request.id;
  }
  async cancel(id) {
    this.cancelCalls.push(id);
    this.pending = this.pending.filter((p) => p.identifier !== id);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}


async function waitFor(cond, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function coordinate(store, os, { maxPending, clock } = {}) {
  return runCoordinatedReconcile({
    getState: () => store.getSnapshot(),
    getRevision: () => store.getRevision(),
    now: NOW,
    clock: clock ?? (() => NOW),
    timeZone: () => TZ,
    os,
    persistRegistry: async (records) => {
      const result = await store.setRegistry(records);
      if (!result.ok) throw new Error('registry-write-failed');
    },
    ...(maxPending !== undefined ? { maxPending } : {}),
  });
}

test('CRUD -> immediate coordinated reconciliation schedules the committed event', async () => {
  const adapter = createAdapter();
  const store = makeStore(adapter);
  const os = new FakeOS();
  await store.load();
  const added = await store.add({ title: 'Тренировка', date: '2026-09-20', time: '19:00', reminder: 'За 10 минут' });
  assert.deepEqual(added, { ok: true });
  // Immediate reconcile of the LATEST state.
  const result = await coordinate(store, os);
  assert.equal(result.status, 'ok');
  assert.equal(store.getSnapshot().events.length, 1);
  assert.ok(os.pending.some((p) => p.identifier === 'workazy.calendar.v1:event-1:start'));
  assert.ok(os.pending.some((p) => p.identifier === 'workazy.calendar.v1:event-1:advance'));
  assert.equal(store.getSnapshot().registry.length, 2);
  const parsed = parseSnapshot(adapter.state.raw());
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.snapshot.registry.length, 2);
});

test('mutation during in-flight reconciliation is not lost and converges without duplicates', async () => {
  const adapter = createAdapter();
  const store = makeStore(adapter);
  const gate = deferred();
  const os = new FakeOS({ scheduleGate: gate });
  await store.load();
  await store.add({ title: 'Один', date: '2026-09-20', time: '19:00' });

  const firstPass = coordinate(store, os);
  // Wait until the schedule call for event-1 is actually in flight (gated).
  await waitFor(() => os.scheduleCalls.length >= 1);
  // Commit a NEW event while that pass is blocked (the store is not locked).
  const added2 = await store.add({ title: 'Два', date: '2026-09-21', time: '10:00' });
  assert.deepEqual(added2, { ok: true });
  gate.resolve();
  const result = await firstPass;
  assert.equal(result.status, 'ok');
  // Final OS state is consistent: BOTH events scheduled, event-1 NOT duplicated.
  const ids = os.pending.map((p) => p.identifier);
  assert.equal(ids.filter((id) => id === 'workazy.calendar.v1:event-1:start').length, 1);
  assert.ok(ids.includes('workazy.calendar.v1:event-2:start'));
  assert.equal(store.getSnapshot().events.length, 2);
});

test('deleted event cannot regain a notification from an older in-flight pass', async () => {
  const adapter = createAdapter();
  const store = makeStore(adapter);
  const gate = deferred();
  const os = new FakeOS({ scheduleGate: gate });
  await store.load();
  await store.add({ title: 'Удалим', date: '2026-09-20', time: '19:00' });

  const firstPass = coordinate(store, os);
  await waitFor(() => os.scheduleCalls.length >= 1); // schedule in flight
  const removed = await store.remove('event-1');
  assert.deepEqual(removed, { ok: true });
  gate.resolve();
  const result = await firstPass;
  assert.equal(result.status, 'ok');
  // The older pass may have landed the request, but the coordinator re-ran with
  // the latest state and cancelled it — the deleted event NEVER keeps a
  // notification in the converged state.
  assert.equal(os.pending.filter((p) => p.identifier.startsWith('workazy.calendar.v1:event-1')).length, 0);
  assert.ok(os.pending.length === 0);
  assert.equal(store.getSnapshot().events.length, 0);
});

test('crash/restart recovery: durable bytes + fresh store + fresh OS converge', async () => {
  const adapterA = createAdapter();
  const storeA = makeStore(adapterA);
  await storeA.load();
  await storeA.add({ title: 'Тренировка', date: '2026-09-20', time: '19:00', reminder: 'За 10 минут' });
  // Simulate a crash right after the event commit, BEFORE any reconcile.
  const bytesAfterCrash = adapterA.state.raw();
  assert.ok(bytesAfterCrash !== null);

  const adapterB = createAdapter({ raw: bytesAfterCrash });
  const storeB = makeStore(adapterB);
  const osB = new FakeOS();
  await storeB.load();
  const result = await coordinate(storeB, osB);
  assert.equal(result.status, 'ok');
  assert.equal(storeB.getSnapshot().events.length, 1);
  assert.equal(storeB.getSnapshot().registry.length, 2);
  assert.equal(osB.pending.length, 2);

  // Now delete the event and converge again: OS is cleaned, registry keeps
  // tombstones only until confirmed absent.
  await storeB.remove('event-1');
  await coordinate(storeB, osB);
  assert.equal(osB.pending.length, 0);
  assert.equal(storeB.getSnapshot().registry.length, 0);
});

test('registry persistence failure is surfaced and does not schedule; retry recovers', async () => {
  const adapter = createAdapter();
  const store = makeStore(adapter);
  const os = new FakeOS();
  await store.load();
  await store.add({ title: 'Событие', date: '2026-09-20', time: '19:00' });

  adapter.state.failNextWrite();
  const failed = await coordinate(store, os);
  assert.equal(failed.status, 'error');
  assert.ok(failed.error);
  assert.equal(os.scheduleCalls.length, 0); // nothing scheduled without durable registry

  // Retry after the storage recovers: schedules and reports ok.
  const recovered = await coordinate(store, os);
  assert.equal(recovered.status, 'ok');
  assert.equal(os.scheduleCalls.length, 1);
  assert.equal(os.pending.length, 1);
  assert.equal(store.getSnapshot().registry.length, 1);
});
