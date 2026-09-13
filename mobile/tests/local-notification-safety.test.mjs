import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoordinatedReconcile } from '../src/services/notifications/calendarReconcileCoordinator.ts';
import { createLocalNotificationReconcileQueue, localNotificationReconcileQueue } from '../src/services/notifications/localNotificationReconcileQueue.ts';

const NOW = new Date('2026-09-13T00:00:00.000Z');
const events = ['a', 'b'].map((id, i) => ({ id, title: id, date: '2026-09-20', time: `${10 + i}:00` }));
const idOf = (id) => `workazy.calendar.v1:${id}:start`;
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function nativeRequest(r) {
  return { identifier: r.id, triggerAt: r.triggerAt, triggerShape: 'absolute',
    contentTitle: r.title, contentBody: r.body,
    data: { owner: 'workazy-calendar-v1', eventId: r.eventId, kind: r.kind,
      fingerprint: r.fingerprint, targetTriggerAt: r.triggerAt, scheduledAt: NOW.getTime() } };
}
function fakeOS({ count = 47, failure, gateAt, keepCancelled = false } = {}) {
  const foreign = Array.from({ length: count }, (_, i) => ({ identifier: `foreign-${i}`,
    triggerAt: NOW.getTime() + 86400000, triggerShape: 'absolute', data: { owner: 'other' },
    contentTitle: 'Foreign', contentBody: 'untouched' }));
  const reached = deferred();
  const release = deferred();
  const os = {
    pending: structuredClone(foreign), foreign, trace: [], calls: [], cancelled: [], max: count,
    reached, release, gateUsed: false, listBroken: false,
    async gate(operation) {
      if (operation === gateAt && !this.gateUsed) {
        this.gateUsed = true;
        reached.resolve();
        await release.promise;
      }
    },
    async getPermissions() { return { granted: true, provisional: false, canAskAgain: true, status: 'granted' }; },
    async listPending() {
      this.trace.push(`list:${this.pending.length}`);
      await this.gate('list');
      if (this.listBroken) throw Error('inventory unavailable');
      return structuredClone(this.pending);
    },
    async schedule(r) {
      this.calls.push(r.id);
      this.trace.push(`schedule:${r.id}`);
      await this.gate('schedule');
      const first = this.calls.length === 1;
      if (first && failure === 'before') throw Error('before native insertion');
      const p = nativeRequest(r);
      if (first && failure === 'verification') p.contentBody += '!';
      this.pending.push(p);
      this.max = Math.max(this.max, this.pending.length);
      if (first && ['readback', 'ambiguous-list'].includes(failure)) this.listBroken = true;
      if (first && ['after', 'ambiguous-list'].includes(failure)) throw Error('after native insertion');
      return r.id;
    },
    async cancel(id) {
      this.cancelled.push(id);
      this.trace.push(`cancel:${id}`);
      await this.gate('cancel');
      if (keepCancelled === 'throw') throw Error('cancel rejected');
      if (!keepCancelled) this.pending = this.pending.filter((p) => p.identifier !== id);
    },
  };
  return os;
}
function job(os, initialEvents = events) {
  let currentEvents = initialEvents;
  let registry = [];
  let revision = 1;
  return {
    edit(next) { currentEvents = next; revision++; },
    registry: () => registry,
    run: () => runCoordinatedReconcile({
      getState: () => ({ phase: 'ready', events: currentEvents, registry }),
      getRevision: () => revision, now: NOW, clock: () => NOW, timeZone: () => 'UTC', os,
      persistRegistry: async (next) => { registry = next; },
    }),
  };
}
function foreignIntact(os) {
  assert.deepEqual(os.pending.filter((p) => p.identifier.startsWith('foreign-')), os.foreign);
  assert.ok(os.cancelled.every((id) => !id.startsWith('foreign-')));
  assert.ok(os.max <= 48, `peak occupancy ${os.max}`);
}

test('6B.1: native inserts A then rejects: re-list sees 48, never schedule B', async () => {
  const os = fakeOS({ failure: 'after' });
  const result = await job(os).run();
  assert.equal(result.status, 'error');
  assert.equal(result.capacityLimited, true);
  assert.deepEqual(os.calls, [idOf('a')]);
  assert.equal(os.trace[os.trace.indexOf(`schedule:${idOf('a')}`) + 1], 'list:48');
  assert.equal(os.pending.length, 48);
  assert.deepEqual(os.cancelled, []);
  foreignIntact(os);
});

test('6B.1: throw before insertion still re-lists; B safely uses the proven vacancy', async () => {
  const os = fakeOS({ failure: 'before' });
  const result = await job(os).run();
  assert.equal(result.status, 'error');
  assert.deepEqual(os.calls, [idOf('a'), idOf('b')]);
  const a = os.trace.indexOf(`schedule:${idOf('a')}`);
  assert.equal(os.trace[a + 1], 'list:47');
  assert.equal(os.trace[a + 2], `schedule:${idOf('b')}`);
  assert.equal(os.pending.length, 48);
  foreignIntact(os);
});

for (const failure of ['readback', 'verification', 'ambiguous-list']) {
  test(`6B.1: ${failure} cannot reuse the attempted slot or create pending #49`, async () => {
    const os = fakeOS({ failure });
    const result = await job(os).run();
    assert.equal(result.status, 'error');
    assert.ok(result.error);
    assert.deepEqual(os.calls, [idOf('a')]);
    assert.equal(os.pending.length, 48);
    const a = os.trace.indexOf(`schedule:${idOf('a')}`);
    assert.equal(os.trace[a + 1], 'list:48');
    foreignIntact(os);
  });
}

test('6B.1: 48 foreign requests leave zero slots', async () => {
  const os = fakeOS({ count: 48 });
  const result = await job(os).run();
  assert.equal(result.capacityLimited, true);
  assert.deepEqual(os.calls, []);
  foreignIntact(os);
});

for (const keepCancelled of [false, true, 'throw']) {
  test(`6B.1: capacity after cancellation uses native absence, cancellation mode=${keepCancelled}`, async () => {
    const os = fakeOS({ keepCancelled });
    os.pending.push({ ...os.foreign[0], identifier: idOf('obsolete'), data: {
      owner: 'workazy-calendar-v1', eventId: 'obsolete', kind: 'start', fingerprint: 'old',
    } });
    os.max = 48;
    await job(os).run();
    assert.equal(os.calls.length, keepCancelled ? 0 : 1);
    assert.ok(os.trace.indexOf('list:47') > os.trace.indexOf(`cancel:${idOf('obsolete')}`) || keepCancelled);
    foreignIntact(os);
  });
}

for (const gateAt of ['list', 'schedule', 'cancel']) {
  test(`6B.1: two production coordinator jobs serialize the whole pass while ${gateAt} is paused`, async () => {
    const os = fakeOS({ gateAt });
    if (gateAt === 'cancel') {
      os.pending.push({ ...os.foreign[0], identifier: idOf('obsolete'), data: {
        owner: 'workazy-calendar-v1', eventId: 'obsolete', kind: 'start', fingerprint: 'old',
      } });
      os.max = 48;
    }
    const first = job(os);
    const second = job(os);
    const a = first.run();
    await os.reached.promise;
    const paused = [...os.trace];
    const b = second.run();
    // Give an unprotected coordinator enough microtasks to enter getPermissions/list.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(os.trace, paused, 'B entered the native critical section while A was paused');
    os.release.resolve();
    await Promise.all([a, b]);
    assert.deepEqual(os.calls, [idOf('a')]);
    foreignIntact(os);
  });
}

test('6B.1: queued pass reads the latest state only after acquiring the queue', async () => {
  const entered = deferred();
  const release = deferred();
  const blocker = localNotificationReconcileQueue.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const os = fakeOS();
  const queued = job(os);
  const run = queued.run();
  queued.edit([{ ...events[0], title: 'Edited while queued' }]);
  release.resolve();
  await blocker;
  await run;
  assert.equal(os.pending.find((p) => p.identifier === idOf('a')).contentBody, 'Edited while queued · 10:00');
});

test('6B.1: deletion during native scheduling reruns after release and removes stale request', async () => {
  const os = fakeOS({ gateAt: 'schedule' });
  const current = job(os, [events[0]]);
  const run = current.run();
  await os.reached.promise;
  current.edit([]);
  os.release.resolve();
  const result = await run;
  assert.equal(result.status, 'ok');
  assert.equal(os.pending.length, 47);
  assert.deepEqual(os.cancelled, [idOf('a')]);
  foreignIntact(os);
});

test('6B.1: restart after ambiguous insertion/list failure adopts native reality without duplicates', async () => {
  const os = fakeOS({ failure: 'ambiguous-list' });
  const failed = await job(os, [events[0]]).run();
  assert.equal(failed.status, 'error');
  os.listBroken = false;
  const restarted = job(os, [events[0]]); // fresh registry simulates registry loss
  const result = await restarted.run();
  assert.equal(result.status, 'ok');
  assert.deepEqual(os.calls, [idOf('a')]);
  assert.equal(restarted.registry().length, 1);
  foreignIntact(os);
});

test('6B.1: generic queue is FIFO and rejected work cannot poison subsequent jobs', async () => {
  const queue = createLocalNotificationReconcileQueue();
  const entered = deferred();
  const release = deferred();
  const trace = [];
  const a = queue.run(async () => { trace.push('A'); entered.resolve(); await release.promise; throw Error('failure'); });
  const rejected = assert.rejects(a, /failure/);
  await entered.promise;
  const b = queue.run(async () => { trace.push('B'); return 2; });
  const c = queue.run(async () => { trace.push('C'); return 3; });
  assert.deepEqual(trace, ['A']);
  release.resolve();
  await rejected;
  assert.deepEqual(await Promise.all([b, c]), [2, 3]);
  assert.deepEqual(trace, ['A', 'B', 'C']);
});
