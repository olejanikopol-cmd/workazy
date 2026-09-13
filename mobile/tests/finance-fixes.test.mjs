/**
 * Slice 6A review fixes: regressions for the nine findings, using the production
 * model, store, storage parser, adapter and sheet/day helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINANCE_STORAGE_KEY,
  createEmptyFinanceSnapshot,
  parseFinanceSnapshot,
} from '../src/storage/financeStorage.ts';
import { createFinanceStore } from '../src/features/finance/financeStore.ts';
import * as model from '../src/features/finance/financeModel.ts';
import { validateFinanceAggregates } from '../src/features/finance/financeAggregates.ts';
import {
  createFinanceDayController,
  createSheetRegistry,
  resolveFormDate,
} from '../src/features/finance/financeDay.ts';
import { transferLegacyFinance } from '../src/features/finance/financeLegacyAdapter.ts';

const NOW = '2026-09-12T09:00:00.000Z';
const TODAY = '2026-09-12';
/** 10^15 minor units: individually accepted, ten of them overflow the sum. */
const HUGE = 1_000_000_000_000_000;

const clock = (today = TODAY, nowIso = NOW) => ({ today, nowIso });

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  let failCount = 0;
  return {
    writes,
    current: () => map.get(FINANCE_STORAGE_KEY) ?? null,
    failWrites(times = 1) {
      failCount = times;
    },
    getItem: async (key) => (map.has(key) ? map.get(key) : null),
    async setItem(key, value) {
      if (failCount > 0) {
        failCount -= 1;
        throw new Error('disk full');
      }
      writes.push(value);
      map.set(key, value);
    },
  };
}

function buildStore(storage, now = () => new Date(NOW)) {
  let counter = 0;
  return createFinanceStore({
    storage,
    now,
    createId: (prefix) => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  });
}

const setupInput = (overrides = {}) => ({
  currency: 'UAH',
  balanceMinor: 1_000_000,
  limitMode: 'auto',
  manualLimitMinor: null,
  fallbackEndDate: null,
  clock: clock(),
  ...overrides,
});

/** Initialized snapshot with an active monthly expectation (AUTO horizon). */
function initialized({ balanceMinor = 0, salaryDay = 22, limitMode = 'auto', manual = null } = {}) {
  const empty = createEmptyFinanceSnapshot(NOW);
  const withSchedule =
    salaryDay === null
      ? empty
      : {
          ...empty,
          salarySchedules: [
            {
              id: 'schedule-1',
              dayOfMonth: salaryDay,
              expectedAmountMinor: 2_000_000,
              title: 'Зарплата',
              active: true,
              createdAt: NOW,
            },
          ],
        };
  const setup = model.initializeFinance(withSchedule, {
    currency: 'UAH',
    balanceMinor,
    limitMode,
    manualLimitMinor: manual,
    fallbackEndDate: null,
    clock: clock(),
  });
  assert.equal(setup.ok, true);
  return setup.snapshot;
}

const expectOk = (result) => {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result.snapshot;
};

// --------------------------------------------------------------------------- //
// 1. Aggregate overflow is rejected BEFORE persistence
// --------------------------------------------------------------------------- //

test('overflow: an unsafe aggregate is rejected and never converted to zero', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput({ balanceMinor: HUGE }));

  // Each expense is individually valid; the second leaves the balance at the
  // negative cap and the third leaves the checked money range entirely.
  const first = await store.addExpense({
    date: TODAY,
    amountMinor: HUGE,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(first.ok, true);
  const second = await store.addExpense({
    date: TODAY,
    amountMinor: HUGE,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(second.ok, true);
  const committed = store.getSnapshot().snapshot;
  assert.equal(committed.balanceMinor, -HUGE);
  assert.equal(model.spentOn(committed, TODAY), HUGE * 2); // exact, never 0

  const writesBefore = storage.writes.length;
  const overflow = await store.addExpense({
    date: TODAY,
    amountMinor: HUGE,
    expectedRevision: committed.revision,
  });
  assert.deepEqual(overflow, { ok: false, reason: 'overflow' });
  assert.equal(storage.writes.length, writesBefore); // setItem was never called
  assert.equal(store.getSnapshot().snapshot, committed); // committed state unchanged
  assert.equal(model.spentOn(store.getSnapshot().snapshot, TODAY), HUGE * 2);
});

test('overflow: the model rejects a balance delta that leaves the checked range', () => {
  let snapshot = initialized({ balanceMinor: HUGE });
  const add = (id) =>
    model.addExpense(snapshot, { id, date: TODAY, amountMinor: HUGE, clock: clock() });
  snapshot = expectOk(add('e1'));
  snapshot = expectOk(add('e2'));
  assert.equal(snapshot.balanceMinor, -HUGE); // the negative cap, still valid
  assert.equal(model.spentOn(snapshot, TODAY), HUGE * 2); // exact, never 0
  assert.equal(validateFinanceAggregates(snapshot), null);
  // The next individual amount is fine on its own, the resulting state is not.
  assert.deepEqual(add('e3'), { ok: false, error: 'overflow' });
  assert.equal(model.spentOn(snapshot, TODAY), HUGE * 2);
});

test('overflow: persisted state whose aggregates are unsafe is a load error', () => {
  const envelope = createEmptyFinanceSnapshot(NOW);
  const rows = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push({
      id: `e${index}`,
      date: TODAY,
      amountMinor: HUGE,
      balancePolicy: 'applied',
      createdAt: NOW,
    });
  }
  const unsafe = JSON.stringify({ ...envelope, initialized: true, expenses: rows });
  assert.deepEqual(parseFinanceSnapshot(unsafe), { ok: false, error: 'aggregate-overflow' });
  // Spreading rows across dates so no single date overflows still fails globally.
  const splitRows = rows.map((row, index) => ({ ...row, date: `2026-0${(index % 9) + 1}-12` }));
  assert.deepEqual(
    parseFinanceSnapshot(JSON.stringify({ ...envelope, initialized: true, expenses: splitRows })),
    { ok: false, error: 'aggregate-overflow' },
  );
});

test('overflow: obligation and expectation totals are guarded too', () => {
  const base = initialized({ balanceMinor: 0 });
  const one = expectOk(
    model.addObligation(base, {
      id: 'o1',
      kind: 'debt',
      title: 'Долг',
      amountMinor: HUGE,
      reminderEnabled: false,
      clock: clock(),
    }),
  );
  const two = expectOk(
    model.addObligation(one, {
      id: 'o2',
      kind: 'debt',
      title: 'Долг 2',
      amountMinor: HUGE,
      reminderEnabled: false,
      clock: clock(),
    }),
  );
  assert.equal(validateFinanceAggregates(two), null);
  // A snapshot already carrying an unsafe obligation total can neither be validated
  // nor extended (production state can never reach this, so it is a typed error).
  const copies = [];
  for (let index = 0; index < 5; index += 1) copies.push(...two.obligations);
  const bulk = { ...two, obligations: copies }; // 10 rows x 10^15 => unsafe total
  assert.equal(validateFinanceAggregates(bulk), 'overflow');
  assert.deepEqual(
    model.addObligation(bulk, {
      id: 'o3',
      kind: 'debt',
      title: 'Долг 3',
      amountMinor: HUGE,
      reminderEnabled: false,
      clock: clock(),
    }),
    { ok: false, error: 'overflow' },
  );
});

// --------------------------------------------------------------------------- //
// 2. Today's allowance is established BEFORE balance/settings/schedule mutations
// --------------------------------------------------------------------------- //

/** Setup with an AUTO horizon of 10 calendar days (today 2026-09-12 -> day 22). */
async function storeWithHorizon() {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput({ balanceMinor: 1_000_000 }));
  await store.addSchedule({
    dayOfMonth: 22,
    expectedAmountMinor: 2_000_000,
    title: 'Зарплата',
    active: true,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  return { storage, store };
}

function assertFirstMutationEstablished(store, storage, writesBefore) {
  const snapshot = store.getSnapshot().snapshot;
  const allowance = model.allowanceFor(snapshot, TODAY);
  assert.notEqual(allowance, null, 'the first mutation must establish today');
  assert.equal(allowance.amountMinor, 100_000); // 10 000 UAH / 10 days
  assert.equal(allowance.baseBalanceMinor, 1_000_000); // PRE-mutation base
  assert.equal(allowance.revision, 1);
  assert.equal(storage.writes.length, writesBefore + 1); // ONE durable write
  return snapshot;
}

test('A: the first mutation of the day is a balance correction', async () => {
  const { storage, store } = await storeWithHorizon();
  const writesBefore = storage.writes.length;
  const result = await store.correctBalance({
    balanceMinor: 900_000,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(result.ok, true);
  const snapshot = assertFirstMutationEstablished(store, storage, writesBefore);
  assert.equal(snapshot.balanceMinor, 900_000); // the correction applied afterwards
});

test('B: the first mutation of the day is a monthly schedule edit', async () => {
  const { storage, store } = await storeWithHorizon();
  const writesBefore = storage.writes.length;
  const result = await store.editSchedule({
    id: 'schedule-1',
    dayOfMonth: 25,
    expectedAmountMinor: 2_000_000,
    title: 'Зарплата',
    active: true,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(result.ok, true);
  assertFirstMutationEstablished(store, storage, writesBefore);
});

test('C: the first mutation of the day is a one-time expected income add', async () => {
  const { storage, store } = await storeWithHorizon();
  const writesBefore = storage.writes.length;
  const result = await store.addExpectation({
    date: '2026-10-01',
    amountMinor: 50_000,
    title: 'Возврат',
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(result.ok, true);
  assertFirstMutationEstablished(store, storage, writesBefore);
});

test('C2: later mutations never rewrite the established row', async () => {
  const { storage, store } = await storeWithHorizon();
  const writesBefore = storage.writes.length;
  assert.equal(
    (await store.updateSettings({
      limitMode: 'auto',
      fallbackEndDate: '2026-10-01',
      expectedRevision: store.getSnapshot().snapshot.revision,
    })).ok,
    true,
  );
  assertFirstMutationEstablished(store, storage, writesBefore);

  const saved = model.allowanceFor(store.getSnapshot().snapshot, TODAY);
  const writesAfterFirst = storage.writes.length;
  await store.addIncome({
    date: TODAY,
    amountMinor: 500_000,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.deepEqual(model.allowanceFor(store.getSnapshot().snapshot, TODAY), saved);
  assert.equal(storage.writes.length, writesAfterFirst + 1);
});

test('D: a failed write preserves the established allowance and balance', async () => {
  const { storage, store } = await storeWithHorizon();
  const before = store.getSnapshot().snapshot;
  const writesBefore = storage.writes.length;
  storage.failWrites(1);
  const failed = await store.correctBalance({
    balanceMinor: 900_000,
    expectedRevision: before.revision,
  });
  assert.deepEqual(failed, { ok: false, reason: 'storage' });
  assert.equal(store.getSnapshot().snapshot, before);
  assert.equal(store.getSnapshot().snapshot.balanceMinor, 1_000_000);
  assert.deepEqual(store.getSnapshot().snapshot.allowances, before.allowances);
  assert.equal(storage.writes.length, writesBefore);
});

test('E: concurrent first mutations cannot create two allowance snapshots', async () => {
  const { store } = await storeWithHorizon();
  const revision = store.getSnapshot().snapshot.revision;
  const [first, second] = await Promise.all([
    store.correctBalance({ balanceMinor: 900_000, expectedRevision: revision }),
    store.addExpense({ date: TODAY, amountMinor: 10_000, expectedRevision: revision }),
  ]);
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: 'busy' });
  const snapshot = store.getSnapshot().snapshot;
  assert.equal(snapshot.allowances.length, 1);
  assert.equal(snapshot.allowances[0].amountMinor, 100_000);
  assert.equal(snapshot.balanceMinor, 900_000);
});
// --------------------------------------------------------------------------- //
// 10/11. Fixed-allowance invariant and single-write atomicity re-audit
// --------------------------------------------------------------------------- //

test('no operation rewrites an established allowance except an explicit change', async () => {
  const { storage, store } = await storeWithHorizon();
  await store.ensureDay(TODAY);
  const saved = model.allowanceFor(store.getSnapshot().snapshot, TODAY);
  assert.notEqual(saved, null);

  const revision = () => store.getSnapshot().snapshot.revision;
  const steps = [
    () => store.addExpense({ date: TODAY, amountMinor: 10_000, expectedRevision: revision() }),
    () => store.addIncome({ date: TODAY, amountMinor: 20_000, expectedRevision: revision() }),
    () => store.correctBalance({ balanceMinor: 500_000, expectedRevision: revision() }),
    () =>
      store.addExpectation({
        date: '2026-10-05',
        amountMinor: 30_000,
        title: 'Ожидание',
        expectedRevision: revision(),
      }),
    () =>
      store.updateSettings({
        limitMode: 'auto',
        fallbackEndDate: '2026-11-01',
        expectedRevision: revision(),
      }),
    () =>
      store.addObligation({
        kind: 'debt',
        title: 'Долг',
        amountMinor: 5_000,
        reminderEnabled: false,
        expectedRevision: revision(),
      }),
    () =>
      store.skipMonthlyOccurrence({
        scheduleId: 'schedule-1',
        date: '2026-09-22',
        expectedRevision: revision(),
      }),
    () =>
      store.reopenMonthlyOccurrence({
        scheduleId: 'schedule-1',
        date: '2026-09-22',
        expectedRevision: revision(),
      }),
  ];
  const writesBefore = storage.writes.length;
  for (const step of steps) {
    const result = await step();
    assert.equal(result.ok, true, JSON.stringify(result));
    // Byte-identical stored allowance through every operation, one write each.
    assert.deepEqual(model.allowanceFor(store.getSnapshot().snapshot, TODAY), saved);
    assert.equal(store.getSnapshot().snapshot.allowances.length, 1);
  }
  assert.equal(storage.writes.length, writesBefore + steps.length);

  // Only the explicit today's action replaces it (revision + 1, reason recorded).
  const changed = await store.applyLimitToday({
    date: TODAY,
    mode: 'manual',
    manualLimitMinor: 50_000,
    expectedRevision: revision(),
  });
  assert.equal(changed.ok, true);
  const after = model.allowanceFor(store.getSnapshot().snapshot, TODAY);
  assert.equal(after.amountMinor, 50_000);
  assert.equal(after.reason, 'explicit-change');
  assert.equal(after.revision, saved.revision + 1);
  assert.equal(store.getSnapshot().snapshot.allowances.length, 1);
});
// --------------------------------------------------------------------------- //
// 3. Monthly income occurrence resolution (scheduleId + date)
// --------------------------------------------------------------------------- //

test('monthly occurrence: received posts actual income and balance ONCE', async () => {
  const { store } = await storeWithHorizon();
  const revision = () => store.getSnapshot().snapshot.revision;
  const received = await store.receiveMonthlyOccurrence({
    scheduleId: 'schedule-1',
    date: '2026-09-22',
    amountMinor: 2_000_000,
    incomeDate: TODAY,
    source: 'Зарплата',
    expectedRevision: revision(),
  });
  assert.equal(received.ok, true);
  const snapshot = store.getSnapshot().snapshot;
  assert.equal(snapshot.balanceMinor, 3_000_000); // 10 000 + 20 000
  assert.equal(snapshot.incomes.length, 1);
  const resolution = model.occurrenceResolved(snapshot, 'schedule-1', '2026-09-22');
  assert.equal(resolution.resolution, 'received');
  assert.equal(resolution.receivedIncomeId, snapshot.incomes[0].id);

  // Rapid duplicate receipt / retry: typed failure, one credit only.
  const duplicate = await store.receiveMonthlyOccurrence({
    scheduleId: 'schedule-1',
    date: '2026-09-22',
    amountMinor: 2_000_000,
    incomeDate: TODAY,
    expectedRevision: revision(),
  });
  assert.deepEqual(duplicate, { ok: false, reason: 'already-received' });
  assert.equal(store.getSnapshot().snapshot.incomes.length, 1);
  assert.equal(store.getSnapshot().snapshot.balanceMinor, 3_000_000);
});

test('monthly occurrence: skip excludes the horizon, reopen restores it', () => {
  let snapshot = initialized({ balanceMinor: 1_000_000, salaryDay: 22 });
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-09-22');
  snapshot = expectOk(
    model.skipMonthlyOccurrence(snapshot, {
      scheduleId: 'schedule-1',
      date: '2026-09-22',
      clock: clock(),
    }),
  );
  // The skipped occurrence is no horizon anymore: the next month applies.
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-10-22');
  assert.equal(snapshot.balanceMinor, 1_000_000); // no balance effect
  snapshot = expectOk(
    model.reopenMonthlyOccurrence(snapshot, {
      scheduleId: 'schedule-1',
      date: '2026-09-22',
      clock: clock(),
    }),
  );
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-09-22');
  assert.equal(snapshot.occurrenceResolutions.length, 0);
});

test('monthly occurrence: deleting the linked income reopens it', async () => {
  const { store } = await storeWithHorizon();
  const revision = () => store.getSnapshot().snapshot.revision;
  await store.receiveMonthlyOccurrence({
    scheduleId: 'schedule-1',
    date: '2026-09-22',
    amountMinor: 2_000_000,
    incomeDate: TODAY,
    expectedRevision: revision(),
  });
  const incomeId = store.getSnapshot().snapshot.incomes[0].id;
  assert.equal(model.nextExpectedIncomeDate(store.getSnapshot().snapshot, TODAY), '2026-10-22');
  const deleted = await store.deleteIncome({ id: incomeId, expectedRevision: revision() });
  assert.equal(deleted.ok, true);
  const snapshot = store.getSnapshot().snapshot;
  assert.equal(snapshot.balanceMinor, 1_000_000); // reversed
  assert.equal(snapshot.occurrenceResolutions.length, 0);
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-09-22'); // unresolved again
});

test('monthly occurrence: editing the receipt keeps the occurrence identity', async () => {
  const { store } = await storeWithHorizon();
  const revision = () => store.getSnapshot().snapshot.revision;
  await store.receiveMonthlyOccurrence({
    scheduleId: 'schedule-1',
    date: '2026-09-22',
    amountMinor: 2_000_000,
    incomeDate: TODAY,
    expectedRevision: revision(),
  });
  const incomeId = store.getSnapshot().snapshot.incomes[0].id;
  const edited = await store.editIncome({
    id: incomeId,
    date: TODAY,
    amountMinor: 1_500_000,
    expectedRevision: revision(),
  });
  assert.equal(edited.ok, true);
  const resolution = model.occurrenceResolved(
    store.getSnapshot().snapshot,
    'schedule-1',
    '2026-09-22',
  );
  assert.equal(resolution.receivedIncomeId, incomeId); // identity unchanged
  assert.equal(store.getSnapshot().snapshot.balanceMinor, 2_500_000);
});

test('monthly occurrences: the calendar projects them and keeps the identity', () => {
  const base = initialized({ balanceMinor: 1_000_000, salaryDay: 22 });
  assert.deepEqual(
    model.unresolvedMonthlyOccurrencesOn(base, '2026-09-22').map((row) => [row.scheduleId, row.date]),
    [['schedule-1', '2026-09-22']],
  );
  assert.deepEqual(model.unresolvedMonthlyOccurrencesOn(base, '2026-09-21'), []);
  const skipped = expectOk(
    model.skipMonthlyOccurrence(base, {
      scheduleId: 'schedule-1',
      date: '2026-09-22',
      clock: clock(),
    }),
  );
  assert.deepEqual(model.unresolvedMonthlyOccurrencesOn(skipped, '2026-09-22'), []);
});

test('monthly occurrences: two schedules on the same date resolve separately', () => {
  let snapshot = initialized({ balanceMinor: 0, salaryDay: 22 });
  snapshot = expectOk(
    model.addSalarySchedule(snapshot, {
      id: 'schedule-2',
      dayOfMonth: 22,
      expectedAmountMinor: 500_000,
      title: 'Аванс',
      active: true,
      clock: clock(),
    }),
  );
  snapshot = expectOk(
    model.skipMonthlyOccurrence(snapshot, {
      scheduleId: 'schedule-1',
      date: '2026-09-22',
      clock: clock(),
    }),
  );
  // Only schedule-1 is resolved: the horizon still exists through schedule-2.
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-09-22');
  assert.equal(model.occurrenceResolved(snapshot, 'schedule-2', '2026-09-22'), null);
  assert.deepEqual(
    model.unresolvedMonthlyOccurrencesOn(snapshot, '2026-09-22').map((row) => row.scheduleId),
    ['schedule-2'],
  );
});

test('monthly occurrences: deleting a schedule keeps receipts and resolution refs', () => {
  let snapshot = initialized({ balanceMinor: 0, salaryDay: 22 });
  snapshot = expectOk(
    model.receiveMonthlyOccurrence(snapshot, {
      scheduleId: 'schedule-1',
      date: '2026-09-22',
      incomeId: 'income-1',
      amountMinor: 100_000,
      incomeDate: TODAY,
      clock: clock(),
    }),
  );
  snapshot = expectOk(model.deleteSalarySchedule(snapshot, { id: 'schedule-1', clock: clock() }));
  assert.equal(snapshot.salarySchedules.length, 0);
  assert.equal(snapshot.incomes.length, 1); // the receipt is preserved
  assert.equal(snapshot.balanceMinor, 100_000);
  assert.equal(
    model.occurrenceResolved(snapshot, 'schedule-1', '2026-09-22').receivedIncomeId,
    'income-1',
  );
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), null); // no schedule anymore
});

test('monthly occurrences survive a restart and re-parse', async () => {
  const { storage, store } = await storeWithHorizon();
  await store.receiveMonthlyOccurrence({
    scheduleId: 'schedule-1',
    date: '2026-09-22',
    amountMinor: 2_000_000,
    incomeDate: TODAY,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  const restarted = buildStore(storage);
  await restarted.load();
  assert.equal(restarted.getSnapshot().phase, 'ready');
  const snapshot = restarted.getSnapshot().snapshot;
  assert.equal(snapshot.occurrenceResolutions.length, 1);
  assert.equal(snapshot.incomes.length, 1);
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-10-22');
});

// --------------------------------------------------------------------------- //
// 4. No-horizon recovery + permanent limit settings
// --------------------------------------------------------------------------- //

test('no horizon -> explicit MANUAL 500 creates today and survives a restart', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  // AUTO with no expectation and no fallback: the limit cannot be derived.
  await store.setup(setupInput({ balanceMinor: 1_000_000, limitMode: 'auto' }));
  const opened = await store.ensureDay(TODAY);
  assert.equal(opened.ok, true);
  assert.equal(opened.horizonMissing, true);
  assert.equal(store.getSnapshot().snapshot.allowances.length, 0);

  // AUTO explicitly on a day without a horizon is a typed unavailable failure.
  assert.deepEqual(
    await store.applyLimitToday({
      date: TODAY,
      mode: 'auto',
      manualLimitMinor: null,
      expectedRevision: store.getSnapshot().snapshot.revision,
    }),
    { ok: false, reason: 'no-horizon' },
  );

  // The MANUAL recovery path works without any existing row.
  const applied = await store.applyLimitToday({
    date: TODAY,
    mode: 'manual',
    manualLimitMinor: 50_000,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(applied.ok, true);
  const allowance = model.allowanceFor(store.getSnapshot().snapshot, TODAY);
  assert.equal(allowance.amountMinor, 50_000);
  assert.equal(allowance.reason, 'explicit-change');
  assert.equal(allowance.revision, 1);

  const restarted = buildStore(storage);
  await restarted.load();
  assert.equal(model.allowanceFor(restarted.getSnapshot().snapshot, TODAY).amountMinor, 50_000);
  assert.equal(model.dayLimitView(restarted.getSnapshot().snapshot, TODAY).unavailable, false);
});

test('permanent settings change future days only unless today is explicitly applied', async () => {
  const { store } = await storeWithHorizon();
  await store.ensureDay(TODAY);
  const saved = model.allowanceFor(store.getSnapshot().snapshot, TODAY).amountMinor;
  const revision = () => store.getSnapshot().snapshot.revision;

  const settingsOnly = await store.saveLimitSettings({
    limitMode: 'manual',
    manualLimitMinor: 50_000,
    fallbackEndDate: null,
    applyToday: false,
    date: TODAY,
    expectedRevision: revision(),
  });
  assert.equal(settingsOnly.ok, true);
  assert.equal(store.getSnapshot().snapshot.settings.limitMode, 'manual');
  assert.equal(model.allowanceFor(store.getSnapshot().snapshot, TODAY).amountMinor, saved);

  // Tomorrow (a new local date) establishes from the NEW settings.
  const tomorrow = '2026-09-13';
  const nextDay = await store.ensureDay(tomorrow);
  assert.equal(nextDay.ok, true);
  const tomorrowRow = model.allowanceFor(store.getSnapshot().snapshot, tomorrow);
  assert.equal(tomorrowRow.amountMinor, 50_000);
  assert.equal(tomorrowRow.reason, 'manual');

  // The explicit option applies it to today as well (one action, one write).
  const applied = await store.saveLimitSettings({
    limitMode: 'manual',
    manualLimitMinor: 70_000,
    fallbackEndDate: null,
    applyToday: true,
    date: TODAY,
    expectedRevision: revision(),
  });
  assert.equal(applied.ok, true);
  const todayRow = model.allowanceFor(store.getSnapshot().snapshot, TODAY);
  assert.equal(todayRow.amountMinor, 70_000);
  assert.equal(todayRow.reason, 'explicit-change');
});

test('a configured fallback horizon enables later AUTO establishment', async () => {
  const { store } = await storeWithHorizon();
  await store.deleteSchedule({
    id: 'schedule-1',
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  const configured = await store.updateSettings({
    limitMode: 'auto',
    fallbackEndDate: '2026-09-18',
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(configured.ok, true);
  // Today's row already exists (established with the schedule); the NEXT day is a
  // new local date and therefore derives its horizon from the fallback.
  assert.equal(model.allowanceFor(store.getSnapshot().snapshot, TODAY).horizonDate, '2026-09-22');
  const opened = await store.ensureDay('2026-09-13');
  assert.equal(opened.ok, true);
  const allowance = model.allowanceFor(store.getSnapshot().snapshot, '2026-09-13');
  assert.equal(allowance.horizonDate, '2026-09-18');
  assert.equal(allowance.days, 5);
  assert.equal(allowance.amountMinor, Math.floor(1_000_000 / 5));
});

// --------------------------------------------------------------------------- //
// 5. Midnight / foreground / default-date safety
// --------------------------------------------------------------------------- //

test('an untouched form default follows the live local day; an explicit date does not', () => {
  const tomorrow = '2026-09-13';
  const yesterday = '2026-09-11';
  // Form opened before midnight (default = 2026-09-12) and saved after it.
  assert.equal(resolveFormDate({ touched: false, value: TODAY, today: tomorrow }), tomorrow);
  // An explicitly chosen date is preserved exactly, even across midnight.
  assert.equal(resolveFormDate({ touched: true, value: yesterday, today: tomorrow }), yesterday);
  // An untouched default is never posted to stale yesterday either.
  assert.equal(resolveFormDate({ touched: false, value: yesterday, today: tomorrow }), tomorrow);
});

test('the day controller reports a midnight change once and refreshes the date', () => {
  let current = new Date('2026-09-12T12:00:00.000Z');
  const changes = [];
  const controller = createFinanceDayController({
    now: () => current,
    onDayChange: (today) => changes.push(today),
  });
  assert.equal(controller.current(), '2026-09-12');
  assert.deepEqual(controller.sample(), { today: '2026-09-12', changed: false });
  current = new Date('2026-09-13T12:00:00.000Z'); // foreground on the next local day
  assert.deepEqual(controller.sample(), { today: '2026-09-13', changed: true });
  assert.deepEqual(controller.sample(), { today: '2026-09-13', changed: false });
  assert.deepEqual(changes, ['2026-09-13']);
  assert.equal(controller.current(), '2026-09-13');
});

test('a midnight crossing establishes the NEW day when a form is saved', async () => {
  let instant = new Date('2026-09-12T12:00:00.000Z');
  const storage = memoryStorage();
  const store = buildStore(storage, () => instant);
  await store.load();
  await store.setup(setupInput({ balanceMinor: 1_000_000 }));
  await store.addSchedule({
    dayOfMonth: 22,
    expectedAmountMinor: 2_000_000,
    title: 'Зарплата',
    active: true,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  const previousAllowance = model.allowanceFor(store.getSnapshot().snapshot, '2026-09-12');
  // The form was opened before midnight; saving happens on the new local day.
  instant = new Date('2026-09-13T12:00:00.000Z');
  const formDate = resolveFormDate({ touched: false, value: '2026-09-12', today: '2026-09-13' });
  const saved = await store.addExpense({
    date: formDate,
    amountMinor: 10_000,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(saved.ok, true);
  const snapshot = store.getSnapshot().snapshot;
  assert.notEqual(model.allowanceFor(snapshot, '2026-09-13'), null); // new day established
  assert.deepEqual(model.allowanceFor(snapshot, '2026-09-12'), previousAllowance); // saved at schedule creation, never rewritten
  assert.equal(model.spentOn(snapshot, '2026-09-13'), 10_000);
  assert.equal(model.spentOn(snapshot, '2026-09-12'), 0);
});

// --------------------------------------------------------------------------- //
// 6. Sheet stale data + async completion identity
// --------------------------------------------------------------------------- //

test('sheet identity: a late completion cannot close a newer sheet', () => {
  const registry = createSheetRegistry();
  const first = registry.open('expense-1', 4);
  assert.equal(first.entityId, 'expense-1');
  assert.equal(first.revision, 4);

  // The user cancels A and opens B while A's save is still in flight.
  registry.closeCurrent();
  const second = registry.open('expense-2', 5);
  assert.notEqual(second.instanceId, first.instanceId);

  // A's async completion arrives: only ITS instance may close, so B stays open.
  assert.equal(registry.isCurrent(first.instanceId), false);
  assert.equal(registry.close(first.instanceId), false);
  assert.equal(registry.isCurrent(second.instanceId), true);
  assert.equal(registry.current().instanceId, second.instanceId);

  // B's own completion closes it.
  assert.equal(registry.close(second.instanceId), true);
  assert.equal(registry.current(), null);
});

test('sheet identity: a submit uses the revision captured when the sheet opened', async () => {
  const { store } = await storeWithHorizon();
  const registry = createSheetRegistry();
  const revisionAtOpen = store.getSnapshot().snapshot.revision;
  const instance = registry.open(null, revisionAtOpen);

  // Another command commits while the sheet is open (revision moves on).
  await store.addIncome({
    date: TODAY,
    amountMinor: 10_000,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.notEqual(store.getSnapshot().snapshot.revision, instance.revision);

  // The sheet still submits against ITS captured revision: typed stale, no write.
  const writesBefore = store.getSnapshot().snapshot.revision;
  const stale = await store.addExpense({
    date: TODAY,
    amountMinor: 5_000,
    expectedRevision: instance.revision,
  });
  assert.deepEqual(stale, { ok: false, reason: 'stale' });
  assert.equal(store.getSnapshot().snapshot.expenses.length, 0);
  assert.equal(store.getSnapshot().snapshot.revision, writesBefore);
  // The draft is preserved because the sheet stays open (identity not closed).
  assert.equal(registry.isCurrent(instance.instanceId), true);
});

// --------------------------------------------------------------------------- //
// 7. Long legacy text + changed-field semantics
// --------------------------------------------------------------------------- //

const LONG_NOTE = `${'я'.repeat(4_001)}  `; // > form limit AND trailing whitespace

test('a >limit legacy note survives hydration, restart and an amount-only edit', async () => {
  const legacy = {
    balance: 12800,
    updatedAt: '2026-03-01T10:00:00.000Z',
    salarySchedules: [
      {
        id: 'salary-1',
        dayOfMonth: 25,
        amount: 20000,
        title: 'Зарплата',
        createdAt: '2026-01-05T08:00:00.000Z',
      },
    ],
    expenses: [
      {
        id: 'expense-1',
        date: '2026-02-14',
        amount: 350.5,
        note: LONG_NOTE,
        createdAt: '2026-02-14T18:00:00.000Z',
      },
    ],
    obligations: [],
  };
  const transfer = transferLegacyFinance(legacy, {
    source: 'finance-state',
    transferId: 'transfer-long',
    nowIso: NOW,
    target: createEmptyFinanceSnapshot(NOW),
  });
  assert.equal(transfer.ok, true);
  assert.equal(transfer.snapshot.expenses[0].note, LONG_NOTE); // preserved EXACTLY

  // The V1 parser accepts what the migration accepted, and a restart keeps it.
  const envelope = JSON.stringify({ ...transfer.snapshot, savedAt: NOW });
  const parsed = parseFinanceSnapshot(envelope);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.expenses[0].note, LONG_NOTE);

  const storage = memoryStorage({ [FINANCE_STORAGE_KEY]: envelope });
  const store = buildStore(storage);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().snapshot.expenses[0].note, LONG_NOTE);

  // Editing only the amount must not trim/rewrite the untouched note.
  const edited = await store.editExpense({
    id: 'expense-1',
    date: '2026-02-14',
    amountMinor: 40_000,
    note: LONG_NOTE,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  assert.equal(edited.ok, true);
  assert.equal(store.getSnapshot().snapshot.expenses[0].note, LONG_NOTE);
  assert.equal(store.getSnapshot().snapshot.expenses[0].amountMinor, 40_000);
});

test('changing a text field enforces the form limit; absence stays absent', () => {
  let snapshot = initialized({ balanceMinor: 0 });
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 1_000, clock: clock() }),
  );
  // An optional note that was ABSENT stays absent when another field changes.
  const edited = expectOk(
    model.editExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 2_000, clock: clock() }),
  );
  assert.equal('note' in edited.expenses[0], false);

  // An UNCHANGED long note (imported) is accepted exactly.
  const withLongNote = {
    ...snapshot,
    expenses: [{ ...snapshot.expenses[0], note: LONG_NOTE }],
  };
  const kept = expectOk(
    model.editExpense(withLongNote, {
      id: 'e1',
      date: TODAY,
      amountMinor: 3_000,
      note: LONG_NOTE,
      clock: clock(),
    }),
  );
  assert.equal(kept.expenses[0].note, LONG_NOTE);
  assert.equal(kept.expenses[0].amountMinor, 3_000);

  // A CHANGED note beyond the form limit is refused.
  assert.deepEqual(
    model.editExpense(withLongNote, {
      id: 'e1',
      date: TODAY,
      amountMinor: 3_000,
      note: `${LONG_NOTE}изменено`,
      clock: clock(),
    }),
    { ok: false, error: 'validation' },
  );
  // A changed title beyond the form limit is refused as well.
  assert.deepEqual(
    model.editOneTimeExpectation(
      expectOk(
        model.addOneTimeExpectation(snapshot, {
          id: 'x1',
          date: '2026-09-20',
          amountMinor: 1_000,
          title: 'Возврат',
          clock: clock(),
        }),
      ),
      { id: 'x1', date: '2026-09-20', amountMinor: 1_000, title: 'т'.repeat(301), clock: clock() },
    ),
    { ok: false, error: 'validation' },
  );
});

// --------------------------------------------------------------------------- //
// 8. The persisted parser never coerces wrong types
// --------------------------------------------------------------------------- //

function validEnvelope() {
  return JSON.parse(
    JSON.stringify({ ...createEmptyFinanceSnapshot(NOW), initialized: true, savedAt: NOW }),
  );
}

function expenseRow(overrides = {}) {
  return {
    id: 'e1',
    date: TODAY,
    amountMinor: 1_000,
    balancePolicy: 'applied',
    createdAt: NOW,
    ...overrides,
  };
}

function obligationRow(overrides = {}) {
  return {
    id: 'o1',
    kind: 'debt',
    title: 'Долг',
    amountMinor: 1_000,
    completed: false,
    reminderEnabled: false,
    createdAt: NOW,
    ...overrides,
  };
}

function scheduleRow(overrides = {}) {
  return {
    id: 's1',
    dayOfMonth: 25,
    expectedAmountMinor: 1_000,
    title: 'Зарплата',
    active: true,
    createdAt: NOW,
    ...overrides,
  };
}

function expectationRow(overrides = {}) {
  return {
    id: 'x1',
    date: '2026-09-20',
    amountMinor: 1_000,
    title: 'Ожидание',
    createdAt: NOW,
    ...overrides,
  };
}

function allowanceRow(overrides = {}) {
  return {
    date: TODAY,
    mode: 'manual',
    amountMinor: 1_000,
    baseBalanceMinor: 1_000,
    horizonDate: null,
    days: null,
    reason: 'manual',
    revision: 1,
    capturedAt: NOW,
    ...overrides,
  };
}

test('wrong runtime types in persisted state are load errors, never coerced', () => {
  const cases = [
    ['date as array', (env) => { env.expenses = [expenseRow({ date: [TODAY] })]; }, 'expense-date'],
    ['amount as string', (env) => { env.expenses = [expenseRow({ amountMinor: '1000' })]; }, 'expense-amount'],
    ['boolean as string', (env) => { env.obligations = [obligationRow({ completed: 'true' })]; }, 'obligation-completed'],
    ['title as object', (env) => { env.salarySchedules = [scheduleRow({ title: { text: 'x' } })]; }, 'schedule-title'],
    ['settings as array', (env) => { env.settings = []; }, 'settings-not-object'],
    ['collections as objects', (env) => { env.expenses = {}; }, 'not-array'],
    ['null where absence is required', (env) => { env.expenses = [expenseRow({ note: null })]; }, 'expense-note'],
    ['malformed enum', (env) => { env.expenses = [expenseRow({ balancePolicy: 'APPLIED' })]; }, 'expense-balance-policy'],
    ['timestamp as number', (env) => { env.expenses = [expenseRow({ createdAt: 1_700_000_000 })]; }, 'expense-created-at'],
    ['allowance mode array', (env) => { env.allowances = [allowanceRow({ mode: ['auto'] })]; }, 'allowance-mode'],
    ['resolution flag as number', (env) => { env.oneTimeExpectations = [expectationRow({ resolution: 1 })]; }, 'expectation-resolution'],
    ['unknown top-level key', (env) => { env.extra = 1; }, 'unknown-key'],
    ['unknown row key', (env) => { env.expenses = [expenseRow({ extra: 1 })]; }, 'expense-unknown-key'],
  ];
  for (const [label, mutate, expected] of cases) {
    const envelope = validEnvelope();
    mutate(envelope);
    const parsed = parseFinanceSnapshot(JSON.stringify(envelope));
    assert.equal(parsed.ok, false, `${label} must fail to load`);
    assert.equal(parsed.error, expected, `${label} error code`);
  }
  // A structurally VALID envelope still parses (guards against over-strictness).
  assert.equal(parseFinanceSnapshot(JSON.stringify(validEnvelope())).ok, true);
});

// --------------------------------------------------------------------------- //
// 9. The published store wrapper is frozen too
// --------------------------------------------------------------------------- //

test('every published store wrapper is deeply frozen and identity-stable', async () => {
  const { store } = await storeWithHorizon();
  const wrapper = store.getSnapshot();
  assert.equal(Object.isFrozen(wrapper), true);
  assert.equal(Object.isFrozen(wrapper.snapshot), true);
  assert.equal(Object.isFrozen(wrapper.snapshot.settings), true);
  assert.equal(Object.isFrozen(wrapper.snapshot.expenses), true);
  assert.equal(Object.isFrozen(wrapper.snapshot.salarySchedules), true);
  assert.equal(Object.isFrozen(wrapper.snapshot.salarySchedules[0]), true);
  assert.equal(Object.isFrozen(wrapper.snapshot.occurrenceResolutions), true);

  // Mutation attempts cannot change the published state.
  assert.throws(() => {
    'use strict';
    wrapper.phase = 'ready';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    wrapper.snapshot.balanceMinor = 0;
  }, TypeError);
  assert.throws(() => {
    'use strict';
    wrapper.snapshot.salarySchedules.push({});
  }, TypeError);

  // Subscribers see a NEW wrapper identity on a real publication, and the same
  // identity when nothing changed.
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()));
  assert.equal(store.getSnapshot(), wrapper); // stable until a commit
  await store.addExpense({
    date: TODAY,
    amountMinor: 1_000,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  unsubscribe();
  assert.equal(seen.length >= 1, true);
  assert.notEqual(seen.at(-1), wrapper);
  assert.equal(Object.isFrozen(seen.at(-1)), true);
  assert.equal(store.getSnapshot(), seen.at(-1));
});
// __APPEND__

test('titles must stay non-empty for new and changed values', () => {
  const snapshot = initialized({ balanceMinor: 0 });
  assert.deepEqual(
    model.addObligation(snapshot, {
      id: 'o1',
      kind: 'debt',
      title: '   ',
      amountMinor: 1_000,
      reminderEnabled: false,
      clock: clock(),
    }),
    { ok: false, error: 'validation' },
  );
  assert.deepEqual(
    model.addOneTimeExpectation(snapshot, {
      id: 'x1',
      date: '2026-09-20',
      amountMinor: 1_000,
      title: ' ',
      clock: clock(),
    }),
    { ok: false, error: 'validation' },
  );
  assert.deepEqual(
    model.addSalarySchedule(snapshot, {
      id: 's2',
      dayOfMonth: 25,
      expectedAmountMinor: 1_000,
      title: '',
      active: true,
      clock: clock(),
    }),
    { ok: false, error: 'validation' },
  );
  // A long legacy title stays accepted while it is unchanged, but not when changed.
  const withLongTitle = {
    ...snapshot,
    obligations: [
      {
        id: 'o9',
        kind: 'debt',
        title: 'т'.repeat(900),
        amountMinor: 1_000,
        reminderEnabled: false,
        completed: false,
        createdAt: NOW,
      },
    ],
  };
  const kept = expectOk(
    model.editObligation(withLongTitle, {
      id: 'o9',
      kind: 'debt',
      title: 'т'.repeat(900),
      amountMinor: 2_000,
      reminderEnabled: false,
      clock: clock(),
    }),
  );
  assert.equal(kept.obligations[0].title, 'т'.repeat(900));
  assert.deepEqual(
    model.editObligation(withLongTitle, {
      id: 'o9',
      kind: 'debt',
      title: 'т'.repeat(901),
      amountMinor: 2_000,
      reminderEnabled: false,
      clock: clock(),
    }),
    { ok: false, error: 'validation' },
  );
});
