import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_PENDING,
  pendingMatchesRequest,
  reconcileCalendarNotifications,
  notificationId,
} from '../src/services/notifications/calendarNotificationReconciler.ts';
import {
  NOTIFICATION_NAMESPACE,
  decodeTriggerEpochMs,
  notificationId as contractNotificationId,
} from '../src/services/notifications/calendarNotificationContract.ts';
import {
  makeFingerprint,
  makeNotificationBody,
  planCalendarRequests,
  planCalendarUnscheduleable,
} from '../src/services/notifications/calendarNotificationPlanner.ts';

const TZ = 'Europe/Kyiv';
const NOW = new Date('2026-09-10T00:00:00.000Z');

const GRANTED = { granted: true, provisional: false, canAskAgain: true, status: 'granted' };

function event(id, title, date, time, reminder) {
  const e = { id, title, date };
  if (time !== undefined) e.time = time;
  if (reminder !== undefined) e.reminder = reminder;
  return e;
}

function scheduledPending(
  id,
  triggerAt,
  eventId,
  kind,
  fingerprint,
  title = 'Workazy',
  body = 'x',
  targetTriggerAt,
  triggerShape = 'absolute',
) {
  const data = { owner: 'workazy-calendar-v1', eventId, kind, fingerprint };
  // Production persists the exact target instant inside the request; omitting it
  // exercises the legacy/foreign fallback path.
  if (targetTriggerAt !== undefined) data.targetTriggerAt = targetTriggerAt;
  return {
    identifier: id,
    triggerAt,
    triggerShape,
    data,
    contentTitle: title,
    contentBody: body,
  };
}

class FakeOS {
  constructor({
    permission = GRANTED,
    pending = [],
    fail = {},
    breakListAfterSchedule = false,
    nativeHandoffMs = 0,
    corruptContent = false,
    wrongDecodedTriggerMs = 0,
    wrongTargetMs = 0,
    nativeTriggerShape = 'absolute',
    undecodableTrigger = false,
  } = {}) {
    this.permission = permission;
    this.fail = fail;
    this.breakListAfterSchedule = breakListAfterSchedule;
    // Simulated JS->native scheduling handoff: the native (decoded) trigger
    // instant lands EARLIER than the instant the JS side asked for. It only
    // applies to the iOS `interval` family, where the native interval is
    // computed AFTER the JS call.
    this.nativeHandoffMs = nativeHandoffMs;
    this.corruptContent = corruptContent;
    this.wrongDecodedTriggerMs = wrongDecodedTriggerMs;
    this.wrongTargetMs = wrongTargetMs;
    this.nativeTriggerShape = nativeTriggerShape;
    this.undecodableTrigger = undecodableTrigger;
    this.cancelCalls = [];
    this.scheduleCalls = [];
    this.listCalls = 0;
    this.pending = pending.map((p) => ({ ...p, data: p.data ? { ...p.data } : null }));
  }
  async getPermissions() {
    if (this.fail.permissions) throw new Error('permissions fail');
    return this.permission;
  }
  async requestPermissions() {
    return this.permission;
  }
  async listPending() {
    this.listCalls += 1;
    if (this.fail.list) throw new Error('list fail');
    return this.pending.map((p) => ({ ...p, data: p.data ? { ...p.data } : null }));
  }
  async schedule(request) {
    this.scheduleCalls.push(request.id);
    if (this.fail.schedule && this.fail.schedule.includes(request.id)) {
      throw new Error('schedule fail');
    }
    this.pending = this.pending.filter((p) => p.identifier !== request.id);
    // Mirror production: the request carries the EXACT target instant in its
    // content data while the native decoded trigger may drift by the handoff
    // latency; the test can inject content/trigger corruption as well.
    const body = this.corruptContent ? `${request.body}!` : request.body;
    const shape = this.undecodableTrigger ? 'unknown' : this.nativeTriggerShape;
    const handoff = this.nativeTriggerShape === 'interval' ? this.nativeHandoffMs : 0;
    const decoded = this.undecodableTrigger
      ? null
      : request.triggerAt + this.wrongDecodedTriggerMs - handoff;
    this.pending.push(
      scheduledPending(
        request.id,
        decoded,
        request.eventId,
        request.kind,
        request.fingerprint,
        request.title,
        body,
        request.triggerAt + this.wrongTargetMs,
        shape,
      ),
    );
    if (this.breakListAfterSchedule) this.fail = { ...this.fail, list: true };
    return request.id;
  }
  async cancel(id) {
    this.cancelCalls.push(id);
    if (this.fail.cancel && this.fail.cancel.includes(id)) {
      throw new Error('cancel fail');
    }
    this.pending = this.pending.filter((p) => p.identifier !== id);
  }
}

function persistRecorder() {
  const writes = [];
  return {
    writes,
    async persist(records) {
      writes.push(records.map((r) => ({ ...r })));
    },
  };
}

async function reconcile(os, events, { registry = [], now = NOW, maxPending } = {}) {
  const rec = persistRecorder();
  const result = await reconcileCalendarNotifications({
    events,
    registry,
    now,
    // Deterministic clock: the per-schedule staleness check must not fall back
    // to the machine's real wall clock in tests.
    clock: () => now,
    timeZone: TZ,
    os,
    persistRegistry: rec.persist,
    ...(maxPending !== undefined ? { maxPending } : {}),
  });
  return { result, writes: rec.writes };
}

test('planner: advance events yield start+advance; start-only yields one; untimed/past yield none', () => {
  const events = [
    event('e1', 'Тренировка', '2026-09-20', '19:00', 'За 10 минут'),
    event('e2', 'Созвон', '2026-09-21', '10:00', 'Только в момент события'),
    event('e3', 'Без времени', '2026-09-22'),
    event('e4', 'Вчерашнее', '2026-09-09', '10:00', 'За 30 минут'),
  ];
  const requests = planCalendarRequests(events, NOW, TZ);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].id, notificationId('e1', 'advance'));
  assert.deepEqual(requests[1].id, notificationId('e1', 'start'));
  assert.deepEqual(requests[2].id, notificationId('e2', 'start'));
  assert.equal(requests[0].triggerAt, new Date('2026-09-20T15:50:00.000Z').getTime());
  assert.equal(requests[1].triggerAt, new Date('2026-09-20T16:00:00.000Z').getTime());
  assert.equal(requests[2].triggerAt, new Date('2026-09-21T07:00:00.000Z').getTime());
  // Fingerprint includes kind/title/time/trigger so title-only edits change it.
  const e1 = events[0];
  const fp = makeFingerprint(requests[0].triggerAt, e1, 'advance');
  assert.equal(fingerprintContains(fp, 'Тренировка'), true);
  assert.equal(makeNotificationBody(e1), 'Тренировка · 19:00');
});

function fingerprintContains(fp, needle) {
  return fp.includes(needle);
}

test('reconcile: add schedules the correct IDs; same-time duplicate-titled events are independent', async () => {
  const events = [
    event('e1', 'Дубль', '2026-09-20', '19:00', 'За 10 минут'),
    event('e2', 'Дубль', '2026-09-20', '19:00', 'За 10 минут'),
  ];
  const os = new FakeOS();
  const { result } = await reconcile(os, events);
  assert.equal(result.status, 'ok');
  assert.equal(os.scheduleCalls.length, 4);
  assert.equal(result.scheduled.length, 4);
  const ids = new Set(os.scheduleCalls);
  assert.ok(ids.has('workazy.calendar.v1:e1:start'));
  assert.ok(ids.has('workazy.calendar.v1:e1:advance'));
  assert.ok(ids.has('workazy.calendar.v1:e2:start'));
  assert.ok(ids.has('workazy.calendar.v1:e2:advance'));
  assert.equal(ids.size, 4);
});

test('reconcile: start-only event schedules exactly one request; unrelated notifications survive', async () => {
  const os = new FakeOS({
    pending: [
      {
        identifier: 'other.app:abc',
        triggerAt: 5,
        triggerShape: 'absolute',
        data: { owner: 'other' },
        contentTitle: 'x',
        contentBody: 'y',
      },
    ],
  });
  const { result } = await reconcile(os, [event('e1', 'Точно в срок', '2026-09-20', '19:00', 'Только в момент события')]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(os.scheduleCalls, ['workazy.calendar.v1:e1:start']);
  assert.equal(os.pending.some((p) => p.identifier === 'other.app:abc'), true);
});

test('reconcile is idempotent: unchanged future requests produce no churn', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'За 10 минут')];
  const os = new FakeOS();
  const { result: first } = await reconcile(os, events);
  assert.equal(first.status, 'ok');
  const scheduleCount1 = os.scheduleCalls.length;
  const { result: second } = await reconcile(os, events);
  assert.equal(second.status, 'ok');
  assert.equal(os.scheduleCalls.length, scheduleCount1); // no duplicate scheduling
  assert.equal(os.cancelCalls.length, 0);
  assert.equal(os.pending.length, 2);
});

test('restart convergence: fresh OS + durable registry converge without duplicates', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'За 10 минут')];
  const osA = new FakeOS();
  const { result: first } = await reconcile(osA, events);
  const osB = new FakeOS({ pending: osA.pending });
  const { result: second } = await reconcile(osB, events, { registry: first.registry });
  assert.equal(second.status, 'ok');
  assert.equal(osB.scheduleCalls.length, 0); // already scheduled in OS
  assert.equal(osB.pending.length, 2);
  assert.equal(new Set(osB.pending.map((p) => p.identifier)).size, 2);
});

test('edit replaces changed requests; deletion cancels all owned ids', async () => {
  const base = [event('e1', 'Старое название', '2026-09-20', '19:00', 'За 10 минут')];
  const os = new FakeOS();
  await reconcile(os, base);

  // Title-only edit changes fingerprint → replacement for both IDs.
  const renamed = [event('e1', 'Новое название', '2026-09-20', '19:00', 'За 10 минут')];
  const { result: r2 } = await reconcile(os, renamed);
  assert.equal(r2.status, 'ok');
  assert.ok(os.cancelCalls.includes('workazy.calendar.v1:e1:start'));
  assert.ok(os.cancelCalls.includes('workazy.calendar.v1:e1:advance'));
  assert.ok(os.scheduleCalls.filter((id) => id === 'workazy.calendar.v1:e1:start').length >= 2);

  // Delete event → both owned pending cancelled.
  const { result: r3 } = await reconcile(os, []);
  assert.equal(r3.status, 'ok');
  assert.equal(os.pending.filter((p) => p.identifier.startsWith('workazy.calendar.v1:e1:')).length, 0);
  assert.equal(os.cancelCalls.length >= 4, true);
});

test('timed-to-untimed cancels all owned ids; untimed events never schedule', async () => {
  const os = new FakeOS();
  await reconcile(os, [event('e1', 'Таймер', '2026-09-20', '19:00', 'За 10 минут')]);
  assert.equal(os.pending.length, 2);
  const { result } = await reconcile(os, [event('e1', 'Таймер', '2026-09-20')]);
  assert.equal(result.status, 'ok');
  assert.equal(os.pending.length, 0);
  assert.equal(os.scheduleCalls.length, 2); // no new schedules
});

test('past advance / future start / fully past event: only future triggers are scheduled', async () => {
  const now = new Date('2026-09-20T16:30:00.000Z'); // 19:30 Kyiv local; start already passed
  const events = [
    event('e1', 'Пропущенное', '2026-09-20', '19:00', 'За 10 минут'), // start in the past, advance past
    event('e2', 'Будущее', '2026-09-21', '19:00', 'За 10 минут'), // both future
  ];
  const os = new FakeOS();
  const { result } = await reconcile(os, events, { now });
  assert.equal(result.status, 'ok');
  // Only e2 start+advance are scheduled.
  assert.deepEqual(os.scheduleCalls.sort(), ['workazy.calendar.v1:e2:advance', 'workazy.calendar.v1:e2:start']);
  assert.equal(os.pending.length, 2);
});

test('schedule failure is visible, no duplicate retry storm, and retry works next pass', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'За 10 минут')];
  const os = new FakeOS({ fail: { schedule: ['workazy.calendar.v1:e1:start'] } });
  const { result: first } = await reconcile(os, events);
  assert.equal(first.status, 'error');
  assert.ok(first.error);
  // advance still scheduled, start failed.
  assert.equal(
    os.pending.some((p) => p.identifier === 'workazy.calendar.v1:e1:advance'),
    true,
  );
  // Retry: clear the failure and reconcile again.
  os.fail.schedule = [];
  const { result: second } = await reconcile(os, events);
  assert.equal(second.status, 'ok');
  assert.equal(os.pending.filter((p) => p.identifier === 'workazy.calendar.v1:e1:start').length, 1);
});

test('cancel failure stops replacement; later retry succeeds', async () => {
  const start = 'workazy.calendar.v1:e1:start';
  const advance = 'workazy.calendar.v1:e1:advance';
  const base = [event('e1', 'Старое', '2026-09-20', '19:00', 'За 10 минут')];
  const os = new FakeOS();
  await reconcile(os, base);
  // Change time → both ids need replacement; make cancel fail for start.
  os.fail = { cancel: [start] };
  const changed = [event('e1', 'Старое', '2026-09-20', '20:00', 'За 10 минут')];
  const { result } = await reconcile(os, changed);
  assert.equal(result.status, 'error');
  assert.ok(result.error.includes('sync') || result.error);
  // start was NOT rescheduled (old one still in OS with old time).
  assert.equal(os.scheduleCalls.filter((id) => id === start).length, 1);
  // Retry after cancels work.
  os.fail = {};
  const { result: retried } = await reconcile(os, changed);
  assert.equal(retried.status, 'ok');
  assert.ok(os.scheduleCalls.filter((id) => id === start).length >= 2);
  const pendingStart = os.pending.find((p) => p.identifier === start);
  assert.equal(pendingStart.triggerAt, new Date('2026-09-20T17:00:00.000Z').getTime());
});

test('OS list failure surfaces an error with zero mutations', async () => {
  const os = new FakeOS({ fail: { list: true } });
  const { result } = await reconcile(os, [event('e1', 'Тренировка', '2026-09-20', '19:00')]);
  assert.equal(result.status, 'error');
  assert.equal(os.scheduleCalls.length, 0);
  assert.equal(os.cancelCalls.length, 0);
});

test('permission read failure surfaces an error', async () => {
  const os = new FakeOS({ fail: { permissions: true } });
  const { result } = await reconcile(os, [event('e1', 'Тренировка', '2026-09-20', '19:00')]);
  assert.equal(result.status, 'error');
  assert.equal(os.scheduleCalls.length, 0);
});

test('permission denied/revoked cancels owned pending and never schedules', async () => {
  const pending = [
    scheduledPending(notificationId('e1', 'start'), 1, 'e1', 'start', 'fp'),
    scheduledPending(notificationId('e1', 'advance'), 1, 'e1', 'advance', 'fp'),
  ];
  const os = new FakeOS({
    permission: { granted: false, provisional: false, canAskAgain: false, status: 'denied' },
    pending,
  });
  const { result } = await reconcile(os, [event('e1', 'Тренировка', '2026-09-20', '19:00', 'За 10 минут')]);
  assert.equal(result.status, 'ok');
  assert.equal(os.scheduleCalls.length, 0);
  assert.equal(os.pending.length, 0);
  assert.ok(os.cancelCalls.includes(notificationId('e1', 'start')));
  assert.ok(os.cancelCalls.includes(notificationId('e1', 'advance')));
});

test('provisional permission is usable (granted) and schedules normally', async () => {
  const os = new FakeOS({
    permission: { granted: true, provisional: true, canAskAgain: true, status: 'provisional' },
  });
  const { result } = await reconcile(os, [event('e1', 'Тренировка', '2026-09-20', '19:00')]);
  assert.equal(result.status, 'ok');
  assert.equal(os.scheduleCalls.length, 1);
});

test('owned orphan in OS without registry is adopted when matching, cancelled otherwise', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const desiredStart = planCalendarRequests(events, NOW, TZ)[0];
  const matching = scheduledPending(
    desiredStart.id,
    desiredStart.triggerAt,
    'e1',
    'start',
    desiredStart.fingerprint,
    desiredStart.title,
    desiredStart.body,
  );
  const os = new FakeOS({ pending: [matching] });
  const { result } = await reconcile(os, events);
  assert.equal(result.status, 'ok');
  assert.equal(os.scheduleCalls.length, 0); // matching orphan adopted, not rescheduled
  assert.ok(result.registry.some((r) => r.id === desiredStart.id && r.status === 'scheduled'));

  const stale = scheduledPending('workazy.calendar.v1:e9:start', 1, 'e9', 'start', 'old-fp');
  const os2 = new FakeOS({ pending: [stale] });
  const { result: r2 } = await reconcile(os2, events);
  assert.equal(r2.status, 'ok');
  assert.ok(os2.cancelCalls.includes('workazy.calendar.v1:e9:start'));
});

test('capacity: only the earliest maxPending are scheduled; later ones refill', async () => {
  const many = [];
  for (let i = 0; i < 20; i += 1) {
    const day = i < 10 ? 21 : 22;
    many.push(event(`e${i}`, `Событие ${i}`, `2026-09-${day}`, '12:00', 'Только в момент события'));
  }
  const os = new FakeOS();
  const { result } = await reconcile(os, many, { maxPending: 5 });
  assert.equal(result.status, 'ok');
  assert.equal(result.capacityLimited, true);
  assert.equal(result.scheduled.length, 5);
  assert.equal(os.pending.length, 5);
  const scheduledIds = new Set(os.scheduleCalls);
  assert.ok(scheduledIds.has(notificationId('e0', 'start')));
  assert.ok(!scheduledIds.has(notificationId('e19', 'start')));

  // Refill: fewer events now fit inside the window.
  const fewer = many.slice(0, 3);
  const { result: r2 } = await reconcile(os, fewer, { maxPending: 5 });
  assert.equal(r2.status, 'ok');
  assert.equal(r2.capacityLimited, false);
  assert.equal(os.scheduleCalls.length, 5); // the two beyond 3 cancelled twice? no: e0-e2 kept, e3-e4 cancelled
  // e3/e4 owned pending were cancelled because they're no longer desired.
  assert.ok(os.cancelCalls.includes(notificationId('e3', 'start')));
  assert.equal(os.pending.length, 3);
});

test('default max pending is 48 and the constant is exported', () => {
  assert.equal(DEFAULT_MAX_PENDING, 48);
  assert.equal(notificationId('abc', 'start'), contractNotificationId('abc', 'start'));
  assert.equal(notificationId('abc', 'start'), `${NOTIFICATION_NAMESPACE}:abc:start`);
});

test('metadata write failure surfaces an error and does not schedule without durable record', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'За 10 минут')];
  const os = new FakeOS();
  let failWrites = true;
  const writes = [];
  let scheduledCount = 0;
  const result = await reconcileCalendarNotifications({
    events,
    registry: [],
    now: NOW,
    timeZone: TZ,
    os,
    persistRegistry: async (records) => {
      if (failWrites) throw new Error('storage failed');
      writes.push(records);
      scheduledCount += records.length;
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(os.scheduleCalls.length, 0); // nothing scheduled without durable records

  failWrites = false;
  const result2 = await reconcileCalendarNotifications({
    events,
    registry: [],
    now: NOW,
    timeZone: TZ,
    os,
    persistRegistry: async (records) => {
      writes.push(records.map((r) => ({ ...r })));
    },
  });
  assert.equal(result2.status, 'ok');
  assert.equal(os.scheduleCalls.length, 2);
});

test('reconcile never creates immediate (null-trigger) alerts', async () => {
  const events = [
    event('e1', 'В прошлом', '2026-09-05', '10:00', 'За 10 минут'),
  ];
  const os = new FakeOS();
  await reconcile(os, events);
  assert.equal(os.scheduleCalls.length, 0);
});


test('decodeTriggerEpochMs decodes the real installed SDK trigger shapes', () => {
  const ms = 1234567890;
  assert.equal(decodeTriggerEpochMs(ms), ms); // bare epoch
  assert.equal(decodeTriggerEpochMs({ type: 'date', timestamp: ms }), ms); // native
  assert.equal(decodeTriggerEpochMs({ type: 'date', date: ms }), ms); // JS number
  assert.equal(decodeTriggerEpochMs({ type: 'date', date: new Date(ms) }), ms); // JS Date
  assert.equal(decodeTriggerEpochMs({ timestamp: ms }), ms);
  assert.equal(decodeTriggerEpochMs(null), null);
  assert.equal(decodeTriggerEpochMs(undefined), null);
  assert.equal(decodeTriggerEpochMs({}), null);
});

test('decodeTriggerEpochMs decodes the iOS timeInterval read-back with schedule context', () => {
  // iOS stores a one-shot DATE alert as UNTimeIntervalNotificationTrigger, so
  // getAllScheduledNotificationsAsync returns { type: 'timeInterval', seconds,
  // repeats } — NOT a null-decodable shape. The adapter pairs it with the
  // schedule context recorded in content.data.scheduledAt.
  const scheduledAt = 1_784_657_000_000;
  assert.equal(
    decodeTriggerEpochMs({ type: 'timeInterval', seconds: 900, repeats: false }, scheduledAt),
    scheduledAt + 900 * 1000,
  );
  assert.equal(
    decodeTriggerEpochMs({ type: 'timeInterval', seconds: 60, repeats: true }, scheduledAt),
    scheduledAt + 60 * 1000,
  );
  // Null only when the interval itself is unusable — never for a valid shape.
  assert.equal(decodeTriggerEpochMs({ type: 'timeInterval', repeats: false }, scheduledAt), null);
  assert.equal(decodeTriggerEpochMs({ type: 'timeInterval', seconds: Number.NaN }, scheduledAt), null);
});

test('pendingMatchesRequest verifies ownership/kind/content/trigger, not just fingerprint metadata', () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'За 10 минут')];
  const start = planCalendarRequests(events, NOW, TZ).find((r) => r.kind === 'start');
  const good = scheduledPending(start.id, start.triggerAt, 'e1', 'start', start.fingerprint, start.title, start.body);
  assert.equal(pendingMatchesRequest(good, start), true);

  const wrongTrigger = scheduledPending(start.id, start.triggerAt + 60_000, 'e1', 'start', start.fingerprint, start.title, start.body);
  assert.equal(pendingMatchesRequest(wrongTrigger, start), false);

  const wrongBody = scheduledPending(start.id, start.triggerAt, 'e1', 'start', start.fingerprint, start.title, start.body + '!!');
  assert.equal(pendingMatchesRequest(wrongBody, start), false);

  const wrongKind = scheduledPending(start.id, start.triggerAt, 'e1', 'advance', start.fingerprint, start.title, start.body);
  assert.equal(pendingMatchesRequest(wrongKind, start), false);

  const wrongOwner = scheduledPending(start.id, start.triggerAt, 'e9', 'start', start.fingerprint, start.title, start.body);
  assert.equal(pendingMatchesRequest(wrongOwner, start), false);

  const staleFingerprint = scheduledPending(start.id, start.triggerAt, 'e1', 'start', 'old-fp', start.title, start.body);
  assert.equal(pendingMatchesRequest(staleFingerprint, start), false);
});

test('pendingMatchesRequest is shape-scoped: interval handoff tolerated, absolute strict', () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const start = planCalendarRequests(events, NOW, TZ).find((r) => r.kind === 'start');
  const pending = (triggerAt, target, shape) =>
    scheduledPending(start.id, triggerAt, 'e1', 'start', start.fingerprint, start.title, start.body, target, shape);
  const matches = (triggerAt, target, shape) => pendingMatchesRequest(pending(triggerAt, target, shape), start);

  // iOS interval family: the native interval is computed AFTER the JS call, so a
  // realistic simulated handoff is accepted.
  assert.equal(matches(start.triggerAt - 3_000, start.triggerAt, 'interval'), true);
  assert.equal(matches(start.triggerAt - 999, start.triggerAt, 'interval'), true);
  // ... but a genuinely wrong interval trigger (an hour) is still rejected.
  assert.equal(matches(start.triggerAt - 3_600_000, start.triggerAt, 'interval'), false);

  // Absolute/date/calendar shapes must match strictly — no handoff budget.
  assert.equal(matches(start.triggerAt, start.triggerAt, 'absolute'), true); // exact
  assert.equal(matches(start.triggerAt - 900, start.triggerAt, 'absolute'), true); // near-exact
  assert.equal(matches(start.triggerAt - 20_000, start.triggerAt, 'absolute'), false); // 20 s late
  assert.equal(matches(start.triggerAt + 3_000, start.triggerAt, 'absolute'), false);

  // An UNDECODABLE OS trigger fails verification, even with correct metadata.
  assert.equal(matches(null, start.triggerAt, 'unknown'), false);
  assert.equal(matches(start.triggerAt, start.triggerAt, 'unknown'), false);

  // Metadata still constrains: a wrong persisted target is rejected.
  assert.equal(matches(start.triggerAt, start.triggerAt + 1_000, 'interval'), false);

  // No persisted target (legacy/foreign record): same shape-scoped comparison.
  const legacyStrict = scheduledPending(start.id, start.triggerAt - 3_000, 'e1', 'start', start.fingerprint, start.title, start.body, undefined, 'absolute');
  assert.equal(pendingMatchesRequest(legacyStrict, start), false);
  const legacyInterval = scheduledPending(start.id, start.triggerAt - 3_000, 'e1', 'start', start.fingerprint, start.title, start.body, undefined, 'interval');
  assert.equal(pendingMatchesRequest(legacyInterval, start), true);
});

test('reconcile replaces an existing notification whose actual trigger time differs', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const desired = planCalendarRequests(events, NOW, TZ)[0];
  // Existing owned notification that matches metadata but has the WRONG trigger.
  const stale = scheduledPending(desired.id, desired.triggerAt + 3_600_000, 'e1', 'start', desired.fingerprint, desired.title, desired.body);
  const os = new FakeOS({ pending: [stale] });
  const { result } = await reconcile(os, events);
  assert.equal(result.status, 'ok');
  assert.ok(result.cancelled.includes(desired.id));
  assert.ok(result.scheduled.includes(desired.id));
  const finalPending = os.pending.find((p) => p.identifier === desired.id);
  assert.equal(finalPending.triggerAt, desired.triggerAt);
});

test('planner resolves Kyiv fall-back fold to the earlier occurrence', () => {
  const events = [event('e1', 'Повтор 03:30', '2026-10-25', '03:30', 'Только в момент события')];
  const requests = planCalendarRequests(events, new Date('2026-09-01T00:00:00.000Z'), 'Europe/Kyiv');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].triggerAt, new Date('2026-10-25T00:30:00.000Z').getTime());
});

test('planner derives advance using the earlier fold occurrence too', () => {
  const events = [event('e1', 'Повтор', '2026-10-25', '03:30', 'За 30 минут')];
  const requests = planCalendarRequests(events, new Date('2026-09-01T00:00:00.000Z'), 'Europe/Kyiv');
  const start = requests.find((r) => r.kind === 'start');
  const advance = requests.find((r) => r.kind === 'advance');
  assert.equal(start.triggerAt, new Date('2026-10-25T00:30:00.000Z').getTime());
  assert.equal(advance.triggerAt, new Date('2026-10-25T00:00:00.000Z').getTime());
});

test('planner skips Europe/Kyiv spring-gap wall-clock times (unschedulable)', () => {
  const events = [event('e1', 'В разрыв', '2026-03-29', '03:30', 'За 10 минут')];
  const requests = planCalendarRequests(events, new Date('2026-02-01T00:00:00.000Z'), 'Europe/Kyiv');
  assert.equal(requests.length, 0);
});

test('never schedules a trigger that became past while reconciliation ran (fresh clock)', async () => {
  const events = [event('e1', 'Скоро', '2026-09-20', '19:00', 'Только в момент события')];
  const now = new Date('2026-09-20T15:00:00.000Z');
  // Start is 2026-09-20 19:00 Kyiv = 16:00Z, so plan with a clock BEFORE it.
  const os = new FakeOS();
  // Simulate time passing between planning and scheduling: the schedule is gated
  // until the clock has already passed the trigger.
  let release;
  const gatePromise = new Promise((res) => { release = res; });
  const originalSchedule = os.schedule.bind(os);
  os.schedule = async (request) => {
    await gatePromise;
    return originalSchedule(request);
  };
  const clockNow = new Date('2026-09-20T15:59:00.000Z');
  const clock = () => clockNow;
  const reconcilePromise = reconcileCalendarNotifications({
    events,
    registry: [],
    now,
    timeZone: TZ,
    os,
    persistRegistry: async () => undefined,
    clock,
    maxPending: 2,
  });
  // Advance the clock past the trigger while the schedule is in flight.
  clockNow.setTime(new Date('2026-09-20T16:05:00.000Z').getTime());
  release();
  const result = await reconcilePromise;
  assert.equal(result.status, 'ok');
  assert.equal(result.skippedStale, 1);
  assert.equal(os.scheduleCalls.length, 0); // nothing scheduled for a past trigger
  assert.equal(os.pending.length, 0);
});

test('capacity refill: advancing time frees slots and later reminders get scheduled', async () => {
  const many = [];
  for (let i = 0; i < 5; i += 1) {
    // Events on 2026-09-20 .. 2026-09-24 at 12:00 Kyiv (09:00Z each day).
    many.push(event(`e${i}`, `Событие ${i}`, `2026-09-2${i}`, '12:00', 'Только в момент события'));
  }
  const os = new FakeOS();
  // Cap of 3: only the earliest 3 are scheduled; the rest are capacity-limited.
  const { result: initial } = await reconcile(os, many, { maxPending: 3 });
  assert.equal(initial.status, 'ok');
  assert.equal(initial.capacityLimited, true);
  assert.deepEqual(initial.scheduled, [
    'workazy.calendar.v1:e0:start',
    'workazy.calendar.v1:e1:start',
    'workazy.calendar.v1:e2:start',
  ]);
  assert.equal(os.pending.length, 3);

  // Advance time so e0/e1 are in the past; e2/e3/e4 are still future.
  const later = new Date('2026-09-21T13:00:00.000Z');
  const { result: second } = await reconcile(os, many, { now: later, maxPending: 3 });
  assert.equal(second.status, 'ok');
  // Obsolete (past) owned notifications were cleared first, freeing the window.
  assert.ok(second.cancelled.includes('workazy.calendar.v1:e0:start'));
  assert.ok(second.cancelled.includes('workazy.calendar.v1:e1:start'));
  // The still-future e3/e4 are scheduled (refill) — nothing valid is starved.
  assert.ok(second.scheduled.includes('workazy.calendar.v1:e3:start'));
  assert.ok(second.scheduled.includes('workazy.calendar.v1:e4:start'));
  assert.equal(second.capacityLimited, false);
  assert.equal(os.pending.length, 3); // e2 kept + e3 + e4 scheduled
  assert.ok(os.pending.some((p) => p.identifier === 'workazy.calendar.v1:e2:start'));
  assert.ok(os.pending.some((p) => p.identifier === 'workazy.calendar.v1:e3:start'));
  assert.ok(os.pending.some((p) => p.identifier === 'workazy.calendar.v1:e4:start'));
});

test('shouldAbort stops OS mutation and reports aborted', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const os = new FakeOS();
  let aborted = false;
  const result = await reconcileCalendarNotifications({
    events,
    registry: [],
    now: NOW,
    timeZone: TZ,
    os,
    persistRegistry: async () => undefined,
    shouldAbort: () => aborted,
  });
  assert.equal(result.status, 'ok');
  assert.equal(os.scheduleCalls.length, 1);

  // Second pass aborts before any schedule.
  aborted = true;
  const second = await reconcileCalendarNotifications({
    events,
    registry: result.registry,
    now: NOW,
    timeZone: TZ,
    os,
    persistRegistry: async () => undefined,
    shouldAbort: () => aborted,
  });
  assert.equal(second.status, 'aborted');
  assert.equal(second.scheduled.length, 0);
});


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

// Native scheduling handoff: the native clock used by iOS for
// `date.timeIntervalSinceNow` is NOT the JS clock, so the native interval can be
// shorter than intended. There is NO device measurement yet; the tests use a
// SIMULATED handoff inside the conservative budget, which verification must
// tolerate without churning.
const NATIVE_HANDOFF_MS = 3_000;

test('iOS timeInterval read-back of an unchanged request verifies and is NOT cancelled/rescheduled', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const desired = planCalendarRequests(events, NOW, TZ)[0];
  // Reproduce exactly what the installed SDK returns for our one-shot schedule:
  // a timeInterval trigger measured from the native schedule moment (drifted by
  // the handoff), plus the exact target instant the adapter persisted.
  const scheduledAt = NOW.getTime() + 5_000;
  const nativeScheduledAt = scheduledAt + NATIVE_HANDOFF_MS;
  const seconds = (desired.triggerAt - nativeScheduledAt) / 1000;
  const pending = {
    identifier: desired.id,
    triggerAt: decodeTriggerEpochMs({ type: 'timeInterval', seconds, repeats: false }, scheduledAt),
    triggerShape: 'interval',
    data: {
      owner: 'workazy-calendar-v1',
      eventId: 'e1',
      kind: 'start',
      fingerprint: desired.fingerprint,
      targetTriggerAt: desired.triggerAt,
      scheduledAt,
    },
    contentTitle: desired.title,
    contentBody: desired.body,
  };
  const os = new FakeOS({ pending: [pending] });
  const { result } = await reconcile(os, events);
  assert.equal(result.status, 'ok');
  assert.equal(os.cancelCalls.length, 0); // no cancel/reschedule churn
  assert.equal(os.scheduleCalls.length, 0);
  assert.equal(result.scheduled.length, 0);
  assert.equal(os.pending.length, 1);
  assert.equal(os.pending[0].identifier, desired.id);

  // The decoded instant really is off by the simulated handoff (no device
  // evidence exists); the persisted target + budget is what saved it.
  assert.equal(pending.triggerAt, desired.triggerAt - NATIVE_HANDOFF_MS);
});

test('scheduling handoff delay does not churn an unchanged reminder (end-to-end via the fake OS)', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const os = new FakeOS({ nativeHandoffMs: NATIVE_HANDOFF_MS, nativeTriggerShape: 'interval' });
  const { result: first } = await reconcile(os, events);
  assert.equal(first.status, 'ok');
  assert.equal(first.scheduled.length, 1);
  // The stored native trigger drifted 3 s from the persisted target.
  const stored = os.pending[0];
  assert.equal(stored.triggerAt, stored.data.targetTriggerAt - NATIVE_HANDOFF_MS);

  const { result: second } = await reconcile(os, events);
  assert.equal(second.status, 'ok');
  assert.equal(os.cancelCalls.length, 0); // not cancelled
  assert.equal(os.scheduleCalls.length, 1); // not rescheduled
  assert.equal(os.pending.length, 1);
});

test('post-schedule read-back applies the full matcher (content + trigger), not just the identifier', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];

  // Correct request verifies.
  const good = new FakeOS();
  const { result: ok } = await reconcile(good, events);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.scheduled.length, 1);

  // Correct ID but WRONG content must fail verification.
  const badContent = new FakeOS({ corruptContent: true });
  const { result: contentFailed } = await reconcile(badContent, events);
  assert.equal(contentFailed.status, 'error');
  assert.equal(contentFailed.scheduled.length, 0);
  assert.equal(badContent.pending.length, 1); // the OS request exists, just unverified

  // Correct ID but trigger ONE HOUR late must fail verification.
  const lateDecoded = new FakeOS({ wrongDecodedTriggerMs: 3_600_000 });
  const { result: triggerFailed } = await reconcile(lateDecoded, events);
  assert.equal(triggerFailed.status, 'error');
  assert.equal(triggerFailed.scheduled.length, 0);

  // Correct ID but a wrong PERSISTED target must fail verification too.
  const lateTarget = new FakeOS({ wrongTargetMs: 3_600_000 });
  const { result: targetFailed } = await reconcile(lateTarget, events);
  assert.equal(targetFailed.status, 'error');
  assert.equal(targetFailed.scheduled.length, 0);
});

test('failed read-back still consumes the capacity slot (cap=1 never schedules a second)', async () => {
  const events = [
    event('e1', 'Первое', '2026-09-20', '19:00', 'Только в момент события'),
    event('e2', 'Второе', '2026-09-20', '20:00', 'Только в момент события'),
  ];
  const os = new FakeOS({ corruptContent: true });
  const { result } = await reconcile(os, events, { maxPending: 1 });
  assert.equal(result.status, 'error');
  assert.deepEqual(os.scheduleCalls, ['workazy.calendar.v1:e1:start']);
  assert.equal(os.pending.length, 1);
});

test('clock advancing during the registry persist prevents scheduling an expired trigger', async () => {
  const events = [
    event('e1', 'Первое', '2026-09-20', '16:00', 'Только в момент события'), // 13:00Z
    event('e2', 'Второе', '2026-09-20', '19:00', 'Только в момент события'), // 16:00Z
  ];
  const os = new FakeOS();
  const clockNow = new Date('2026-09-20T12:59:00.000Z');
  const gate = deferred();
  let persistStarted = false;
  let firstPersist = true;
  const run = reconcileCalendarNotifications({
    events,
    registry: [],
    now: NOW,
    timeZone: TZ,
    os,
    clock: () => clockNow,
    persistRegistry: async () => {
      if (firstPersist) {
        firstPersist = false;
        persistStarted = true;
        await gate.promise;
      }
    },
  });
  await waitFor(() => persistStarted);
  // e1's trigger expires WHILE the registry write is in flight.
  clockNow.setTime(new Date('2026-09-20T13:01:00.000Z').getTime());
  gate.resolve();
  const result = await run;
  assert.equal(result.status, 'ok');
  assert.equal(result.skippedStale, 1);
  assert.equal(os.scheduleCalls.includes('workazy.calendar.v1:e1:start'), false);
  assert.ok(os.scheduleCalls.includes('workazy.calendar.v1:e2:start'));
  assert.ok(result.scheduled.includes('workazy.calendar.v1:e2:start'));
  // The durable registry does not claim the never-scheduled request.
  assert.equal(result.registry.some((r) => r.id === 'workazy.calendar.v1:e1:start'), false);
});

test('cap is enforced even when read-back verification fails after a successful schedule', async () => {
  const events = [
    event('e1', 'Первое', '2026-09-20', '19:00', 'Только в момент события'),
    event('e2', 'Второе', '2026-09-20', '20:00', 'Только в момент события'),
  ];
  const os = new FakeOS({ breakListAfterSchedule: true });
  const { result } = await reconcile(os, events, { maxPending: 1 });
  assert.equal(result.status, 'error'); // the read-back failure is surfaced
  // The successful schedule consumed the only slot; the failed read-back did NOT
  // free it, so the second candidate was never scheduled.
  assert.equal(os.scheduleCalls.length, 1);
  assert.deepEqual(os.scheduleCalls, ['workazy.calendar.v1:e1:start']);
  assert.equal(os.pending.length, 1); // cap=1 never yields 2 pending notifications
});

test('planner reports only future DST spring-gap events as unschedulable', () => {
  const events = [
    event('e1', 'Ночной звонок', '2026-03-29', '03:30', 'Только в момент события'),
    event('e2', 'Обычное', '2026-03-30', '10:00'),
    event('e3', 'Прошлый провал', '2025-03-30', '03:30'),
  ];
  const before = new Date('2026-03-01T00:00:00.000Z');
  const list = planCalendarUnscheduleable(events, before, 'Europe/Kyiv');
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    eventId: 'e1',
    date: '2026-03-29',
    time: '03:30',
    title: 'Ночной звонок',
  });
});

test('timezone change to a DST gap warns instead of silently dropping, and recovery reschedules', async () => {
  const events = [event('e1', 'Ночной звонок', '2026-03-29', '03:30', 'Только в момент события')];
  const before = new Date('2026-03-01T00:00:00.000Z');
  const run = (os, timeZone, registry) =>
    reconcileCalendarNotifications({
      events,
      registry,
      now: before,
      clock: () => before,
      timeZone,
      os,
      persistRegistry: async () => undefined,
    });

  // 1) Schedulable zone: the reminder is scheduled.
  const tokyo = new FakeOS();
  const scheduled = await run(tokyo, 'Asia/Tokyo', []);
  assert.equal(scheduled.status, 'ok');
  assert.equal(scheduled.unschedulable.length, 0);
  assert.ok(tokyo.pending.some((p) => p.identifier === 'workazy.calendar.v1:e1:start'));

  // 2) Timezone changes so 03:30 no longer exists (Kyiv spring gap): the old
  //    reminder is cleared AND reported unschedulable — never silently dropped.
  const kyiv = new FakeOS({ pending: tokyo.pending });
  const gapped = await run(kyiv, 'Europe/Kyiv', scheduled.registry);
  assert.equal(gapped.status, 'ok');
  assert.equal(gapped.unschedulable.length, 1);
  assert.equal(gapped.unschedulable[0].eventId, 'e1');
  assert.ok(gapped.cancelled.includes('workazy.calendar.v1:e1:start'));
  assert.equal(kyiv.pending.length, 0);

  // 3) Timezone changes to a schedulable one: the warning clears and the
  //    reminder is scheduled again.
  const back = new FakeOS();
  const recovered = await run(back, 'Asia/Tokyo', gapped.registry);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.unschedulable.length, 0);
  assert.ok(recovered.scheduled.includes('workazy.calendar.v1:e1:start'));
  assert.equal(back.pending.length, 1);
});


test('undecodable post-schedule inventory fails verification (never reports ok)', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const os = new FakeOS({ undecodableTrigger: true });
  const { result } = await reconcile(os, events);
  assert.equal(result.status, 'error');
  assert.equal(result.scheduled.length, 0);
  assert.equal(os.pending.length, 1); // the OS request exists but is unverifiable
  assert.equal(os.pending[0].triggerAt, null);
  assert.equal(os.pending[0].triggerShape, 'unknown');
});

test('an unverifiable owned entry is repaired by cancel + reschedule on the next pass', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const desired = planCalendarRequests(events, NOW, TZ)[0];
  const os = new FakeOS({ undecodableTrigger: true });
  const { result: broken } = await reconcile(os, events);
  assert.equal(broken.status, 'error');
  assert.equal(broken.scheduled.length, 0);

  // The OS read-back is healthy again: the unverifiable entry must NOT be accepted
  // as up-to-date — it is cancelled and rescheduled.
  os.undecodableTrigger = false;
  const { result: repaired } = await reconcile(os, events, { registry: broken.registry });
  assert.equal(repaired.status, 'ok');
  assert.ok(repaired.cancelled.includes(desired.id));
  assert.ok(repaired.scheduled.includes(desired.id));
  const stored = os.pending.find((p) => p.identifier === desired.id);
  assert.equal(stored.triggerAt, desired.triggerAt);
  assert.equal(stored.triggerShape, 'absolute');
});

test('a date (absolute) trigger 20 s late fails post-schedule verification', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const os = new FakeOS({ wrongDecodedTriggerMs: -20_000 }); // absolute shape by default
  const { result } = await reconcile(os, events);
  assert.equal(result.status, 'error');
  assert.equal(result.scheduled.length, 0);
});

test('a near-exact absolute trigger verifies and does not churn', async () => {
  const events = [event('e1', 'Тренировка', '2026-09-20', '19:00', 'Только в момент события')];
  const os = new FakeOS({ wrongDecodedTriggerMs: -900 });
  const { result: first } = await reconcile(os, events);
  assert.equal(first.status, 'ok');
  assert.equal(first.scheduled.length, 1);

  const { result: second } = await reconcile(os, events);
  assert.equal(second.status, 'ok');
  assert.equal(os.cancelCalls.length, 0);
  assert.equal(os.scheduleCalls.length, 1);
});
