import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarStore } from '../src/features/calendar/calendarStore.ts';
import { createCalendarController } from '../src/features/calendar/calendarNotificationController.ts';

const TZ = 'Europe/Kyiv';
const NOW = new Date('2026-09-10T00:00:00.000Z');
const GRANTED = { granted: true, provisional: false, canAskAgain: true, status: 'granted' };

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

class FakeOS {
  constructor({ permission = GRANTED, permissionsGate = null } = {}) {
    this.permission = permission;
    this.permissionsGate = permissionsGate;
    this.permissionCalls = 0;
    this.scheduleCalls = [];
    this.cancelCalls = [];
    this.pending = [];
  }
  async getPermissions() {
    this.permissionCalls += 1;
    if (this.permissionsGate) await this.permissionsGate.promise;
    return this.permission;
  }
  async requestPermissions() {
    this.permissionCalls += 1;
    if (this.permissionsGate) await this.permissionsGate.promise;
    return this.permission;
  }
  async listPending() {
    return this.pending.map((p) => ({ ...p, data: p.data ? { ...p.data } : null }));
  }
  async schedule(request) {
    this.scheduleCalls.push(request.id);
    this.pending = this.pending.filter((p) => p.identifier !== request.id);
    this.pending.push({
      identifier: request.id,
      triggerAt: request.triggerAt,
      triggerShape: 'absolute',
      data: {
        owner: 'workazy-calendar-v1',
        eventId: request.eventId,
        kind: request.kind,
        fingerprint: request.fingerprint,
        targetTriggerAt: request.triggerAt,
      },
      contentTitle: request.title,
      contentBody: request.body,
    });
    return request.id;
  }
  async cancel(id) {
    this.cancelCalls.push(id);
    this.pending = this.pending.filter((p) => p.identifier !== id);
  }
}

function createStorage() {
  let rawValue = null;
  return {
    raw: () => rawValue,
    async getItem() {
      return rawValue;
    },
    async setItem(key, value) {
      rawValue = value;
    },
  };
}

/** Production wiring: real store + real controller + fake OS. */
function setup({
  os = new FakeOS(),
  clockNow = { value: new Date('2026-09-10T12:00:00.000Z') },
  initialAppState = 'active',
} = {}) {
  const storage = createStorage();
  let idCounter = 0;
  const store = createCalendarStore({
    storage,
    now: () => NOW,
    createId: () => `event-${++idCounter}`,
  });
  const controller = createCalendarController({
    getState: () => store.getSnapshot(),
    getRevision: () => store.getRevision(),
    timeZone: () => TZ,
    now: () => NOW,
    clock: () => clockNow.value,
    initialAppState,
    os,
    persistRegistry: async (records) => {
      const result = await store.setRegistry(records);
      if (!result.ok) throw new Error('registry-write-failed');
    },
  });
  return { store, controller, os, clockNow };
}

test('calendar focus refreshes the today marker and reconciles the committed state', async () => {
  // 12:00Z keeps the LOCAL date identical in every tested timezone.
  const clockNow = { value: new Date('2026-09-10T12:00:00.000Z') };
  const { store, controller, os, clockNow: clock } = setup({ clockNow });
  await store.load();
  await store.add({ title: 'Тренировка', date: '2026-09-20', time: '19:00' });
  assert.equal(controller.getToday(), '2026-09-10');
  assert.equal(os.scheduleCalls.length, 0); // nothing reconciled yet

  // The day rolls over while the app was elsewhere; focus must notice both.
  clock.value = new Date('2026-09-11T12:00:00.000Z');
  const result = await controller.handleFocus();

  assert.equal(controller.getToday(), '2026-09-11'); // today marker refreshed
  assert.equal(result?.status, 'ok');
  assert.deepEqual(os.scheduleCalls, ['workazy.calendar.v1:event-1:start']);
});

test('periodic reconciliation only runs while AppState is active', async () => {
  const { store, controller, os } = setup();
  await store.load();

  // Backgrounded: the periodic recheck performs no work at all.
  controller.setAppState('background');
  assert.equal(controller.handlePeriodicTick(), false);
  assert.equal(controller.isActive(), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(os.scheduleCalls.length, 0);
  assert.equal(os.permissionCalls, 0);

  // Inactive (iOS transition state) behaves the same.
  controller.setAppState('inactive');
  assert.equal(controller.handlePeriodicTick(), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(os.scheduleCalls.length, 0);

  // Returning to active triggers an immediate refresh + reconciliation.
  await store.add({ title: 'Созвон', date: '2026-09-20', time: '10:00' });
  controller.setAppState('active');
  assert.equal(controller.isActive(), true);
  await waitFor(() => os.scheduleCalls.length === 1);
  assert.deepEqual(os.scheduleCalls, ['workazy.calendar.v1:event-1:start']);

  // While active the periodic tick does run.
  await store.add({ title: 'Второе', date: '2026-09-21', time: '10:00' });
  assert.equal(controller.handlePeriodicTick(), true);
  await waitFor(() => os.scheduleCalls.length === 2);
});


// Result fixtures for the permission-race regressions.
const OK_RESULT = {
  status: 'ok',
  error: null,
  capacityLimited: false,
  scheduled: [],
  cancelled: [],
  skippedStale: 0,
  unschedulable: [],
  registry: [],
};
const GAP = { eventId: 'e1', date: '2026-03-29', time: '03:30', title: 'Ночной звонок' };
const ERROR_RESULT = {
  status: 'error',
  error: 'Не удалось синхронизировать напоминания. Повторите попытку.',
  capacityLimited: false,
  scheduled: [],
  cancelled: [],
  skippedStale: 0,
  unschedulable: [GAP],
  registry: [],
};

test('a delayed permission read merges into the LATEST state (newer error + DST warning survive)', async () => {
  const gate = deferred();
  const os = new FakeOS({ permissionsGate: gate });
  const { store, controller } = setup({ os });
  await store.load();

  const pendingPermission = controller.refreshPermission(); // production path (tick/start)
  await waitFor(() => os.permissionCalls === 1);
  assert.equal(controller.getSnapshot().reconcileStatus, 'idle'); // stale snapshot is empty

  // A newer reconciliation (error + DST warning) lands while the read is in flight.
  controller.applyResult(ERROR_RESULT);
  gate.resolve();
  await pendingPermission;

  const state = controller.getSnapshot();
  assert.equal(state.permission?.granted, true); // permission itself landed
  assert.equal(state.reconcileStatus, 'error'); // newer error NOT erased
  assert.equal(state.reconcileError, ERROR_RESULT.error);
  assert.deepEqual(state.unschedulable.map((entry) => entry.eventId), ['e1']); // warning NOT erased
});

test('a delayed permission read never resurrects a cleared DST warning (reproduces the old bug)', async () => {
  const gate = deferred();
  const os = new FakeOS({ permissionsGate: gate });
  const { store, controller } = setup({ os });
  await store.load();

  // A DST-gap warning is PRESENT when the permission read starts, so any
  // pre-await snapshot of the state contains it (that was the old bug).
  controller.applyResult(ERROR_RESULT);
  assert.equal(controller.getSnapshot().unschedulable.length, 1);
  const pendingPermission = controller.refreshPermission();
  await waitFor(() => os.permissionCalls === 1);

  // While the read is in flight a newer reconciliation clears the warning.
  controller.applyResult(OK_RESULT);
  assert.equal(controller.getSnapshot().unschedulable.length, 0);
  gate.resolve();
  await pendingPermission;

  const state = controller.getSnapshot();
  assert.equal(state.unschedulable.length, 0); // cleared state NOT resurrected
  assert.equal(state.reconcileStatus, 'ok');
  assert.equal(state.reconcileError, null);
  assert.equal(state.permission?.granted, true); // permission itself still merged
});

test('requestPermission merges into the latest state, then reconciles the committed state', async () => {
  const gate = deferred();
  const os = new FakeOS({ permissionsGate: gate });
  const { store, controller } = setup({ os });
  await store.load();
  // A future event whose Kyiv wall-clock time is a DST spring-forward gap: the
  // real reconciliation after the prompt reports it, and that warning must not
  // be lost by the delayed permission merge.
  await store.add({ title: 'Ночной звонок', date: '2027-03-28', time: '03:30' });

  const pendingRequest = controller.requestPermission();
  await waitFor(() => os.permissionCalls === 1);
  controller.applyResult(ERROR_RESULT); // state observed while the prompt is open
  gate.resolve();
  await pendingRequest;

  const state = controller.getSnapshot();
  assert.equal(state.permission?.granted, true);
  // The post-prompt reconciliation result is the latest truth and survives.
  assert.deepEqual(state.unschedulable.map((entry) => entry.eventId), ['event-1']);
  assert.equal(state.reconcileStatus, 'ok');
  // A DST-gap event is unschedulable, so nothing was scheduled for it.
  assert.deepEqual(os.scheduleCalls, []);
});


test('mounted while backgrounded/inactive: periodic work stays gated until an active transition', async () => {
  const os = new FakeOS();
  const { store, controller } = setup({ os, initialAppState: 'background' });
  await store.load();
  await store.add({ title: 'Тренировка', date: '2026-09-20', time: '19:00' });

  // The controller must not assume "active" at mount.
  assert.equal(controller.isActive(), false);

  // Hydration-time start() does NO work while backgrounded.
  controller.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(os.scheduleCalls.length, 0);
  assert.equal(os.permissionCalls, 0);

  // The periodic recheck stays gated too.
  assert.equal(controller.handlePeriodicTick(), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(os.scheduleCalls.length, 0);

  // iOS inactive transition: still gated.
  controller.setAppState('inactive');
  assert.equal(controller.handlePeriodicTick(), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(os.scheduleCalls.length, 0);

  // Becoming active releases the gate: the deferred work happens now.
  controller.setAppState('active');
  assert.equal(controller.isActive(), true);
  await waitFor(() => os.scheduleCalls.length === 1);
  assert.deepEqual(os.scheduleCalls, ['workazy.calendar.v1:event-1:start']);
  assert.ok(os.permissionCalls >= 1);
});
