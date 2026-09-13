/**
 * Finance store tests: the real production store over an injected in-memory storage,
 * clock and ID generator. Covers hydration, currency lock, persist-before-commit,
 * frozen snapshots, corrupt-state blocking and restart continuity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINANCE_STORAGE_KEY,
  createEmptyFinanceSnapshot,
  parseFinanceSnapshot,
  serializeFinanceSnapshot,
} from '../src/storage/financeStorage.ts';
import { createFinanceStore } from '../src/features/finance/financeStore.ts';
import * as model from '../src/features/finance/financeModel.ts';

const NOW = '2026-09-12T09:00:00.000Z';
const TODAY = '2026-09-12';

/** In-memory storage port that records every write (and can fail on demand). */
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
  balanceMinor: 1_245_000,
  limitMode: 'manual',
  manualLimitMinor: 50_000,
  fallbackEndDate: null,
  clock: { nowIso: NOW, today: TODAY },
  ...overrides,
});

test('first setup persists, hydrates and survives a restart', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'ready');
  assert.equal(store.getSnapshot().snapshot.initialized, false);

  const setup = await store.setup(setupInput());
  assert.equal(setup.ok, true);
  assert.equal(store.getSnapshot().snapshot.initialized, true);
  assert.equal(store.getSnapshot().snapshot.settings.currency, 'UAH');
  assert.equal(storage.writes.length, 1);

  // Restart: a NEW store hydrates exactly the committed state.
  const restarted = buildStore(storage);
  await restarted.load();
  const restored = restarted.getSnapshot().snapshot;
  assert.equal(restored.initialized, true);
  assert.equal(restored.balanceMinor, 1_245_000);
  assert.equal(restored.settings.manualLimitMinor, 50_000);
  assert.equal(restored.revision, store.getSnapshot().snapshot.revision);
});

test('a second setup is rejected and the currency stays locked to the first choice', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  assert.equal((await store.setup(setupInput({ currency: 'USD' }))).ok, true);
  assert.deepEqual(await store.setup(setupInput({ currency: 'EUR' })), {
    ok: false,
    reason: 'validation',
  });
  assert.deepEqual(await store.correctBalance({ balanceMinor: 1, expectedRevision: 999 }), {
    ok: false,
    reason: 'stale',
  });
  const restarted = buildStore(storage);
  await restarted.load();
  assert.equal(restarted.getSnapshot().snapshot.settings.currency, 'USD');
});

test("the first expense and today's allowance are written in ONE envelope", async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput());
  const before = store.getSnapshot().snapshot.revision;

  const added = await store.addExpense({
    date: TODAY,
    amountMinor: 35_000,
    expectedRevision: before,
  });
  assert.equal(added.ok, true);
  assert.equal(added.allowanceCreated, true);
  const committed = store.getSnapshot().snapshot;
  assert.equal(committed.allowances.length, 1);
  assert.equal(committed.allowances[0].amountMinor, 50_000); // MANUAL limit
  assert.equal(committed.allowances[0].baseBalanceMinor, 1_245_000); // pre-mutation base
  assert.equal(committed.balanceMinor, 1_210_000);
  assert.equal(committed.revision, before + 1);
  assert.equal(storage.writes.length, 2); // setup + one operation/snapshot write
});

test('every persisted envelope is a valid, strictly parseable V1 snapshot', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput());
  await store.addExpense({ date: TODAY, amountMinor: 10_000, expectedRevision: 1 });
  await store.addIncome({ date: TODAY, amountMinor: 20_000, expectedRevision: 2 });
  for (const write of storage.writes) {
    assert.equal(parseFinanceSnapshot(write).ok, true, `write must parse: ${write}`);
  }
  const last = parseFinanceSnapshot(storage.writes.at(-1));
  assert.equal(last.snapshot.revision, store.getSnapshot().snapshot.revision);
});

test('published snapshots are deeply frozen (rows, refs and settings)', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput());
  await store.addExpense({ date: TODAY, amountMinor: 10_000, expectedRevision: 1 });
  const snapshot = store.getSnapshot().snapshot;
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.settings), true);
  assert.equal(Object.isFrozen(snapshot.expenses), true);
  assert.equal(Object.isFrozen(snapshot.expenses[0]), true);
  assert.equal(Object.isFrozen(snapshot.allowances), true);
  assert.equal(Object.isFrozen(snapshot.allowances[0]), true);
  assert.throws(() => {
    'use strict';
    snapshot.balanceMinor = 0;
  }, TypeError);
});

test('a failed write leaves the previous committed snapshot and reports storage', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput());
  const before = store.getSnapshot().snapshot;
  storage.failWrites(1);
  const failed = await store.addExpense({
    date: TODAY,
    amountMinor: 30_000,
    expectedRevision: before.revision,
  });
  assert.deepEqual(failed, { ok: false, reason: 'storage' });
  assert.equal(store.getSnapshot().snapshot, before); // untouched
  assert.equal(store.getSnapshot().snapshot.balanceMinor, 1_245_000);
  assert.equal(store.getSnapshot().snapshot.expenses.length, 0);
  assert.equal(typeof store.getSnapshot().error, 'string'); // honest retryable state
  // Retry with a stable intent succeeds on the same revision.
  const retried = await store.addExpense({
    date: TODAY,
    amountMinor: 30_000,
    expectedRevision: before.revision,
  });
  assert.equal(retried.ok, true);
  assert.equal(store.getSnapshot().snapshot.balanceMinor, 1_215_000);
  assert.equal(store.getSnapshot().error, null);
});

test('corrupt bytes block writes, keep the original bytes and offer retry', async () => {
  const corrupt = '{"version":1,"initialized":true,"balanceMinor":1.5}';
  const storage = memoryStorage({ [FINANCE_STORAGE_KEY]: corrupt });
  const store = buildStore(storage);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'load-error');
  assert.equal(typeof store.getSnapshot().error, 'string');
  assert.deepEqual(await store.addExpense({ date: TODAY, amountMinor: 1, expectedRevision: 0 }), {
    ok: false,
    reason: 'load-error',
  });
  assert.deepEqual(await store.setup(setupInput()), { ok: false, reason: 'load-error' });
  // The original bytes are preserved verbatim (never replaced with an empty state).
  assert.equal(storage.current(), corrupt);
  assert.equal(storage.writes.length, 0);
});

test('an unknown envelope version and a dangling receipt link are load errors', async () => {
  const future = JSON.stringify({ ...JSON.parse(await emptyEnvelope()), version: 2 });
  const storage = memoryStorage({ [FINANCE_STORAGE_KEY]: future });
  const store = buildStore(storage);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'load-error');

  // A structurally valid envelope with a dangling receipt reference must also fail.
  const envelope = JSON.parse(await emptyEnvelope());
  envelope.initialized = true;
  envelope.oneTimeExpectations = [
    {
      id: 'x1',
      date: '2026-09-20',
      amountMinor: 1_000,
      title: 'Ожидание',
      resolution: 'received',
      receivedIncomeId: 'missing-income',
      createdAt: NOW,
    },
  ];
  const storage2 = memoryStorage({ [FINANCE_STORAGE_KEY]: JSON.stringify(envelope) });
  const store2 = buildStore(storage2);
  await store2.load();
  assert.equal(store2.getSnapshot().phase, 'load-error');
});

test('a read-only day-open writes its own snapshot before showing the limit', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(
    setupInput({ limitMode: 'auto', manualLimitMinor: null, fallbackEndDate: '2026-09-22' }),
  );
  const opened = await store.ensureDay(TODAY);
  assert.equal(opened.ok, true);
  assert.equal(opened.allowanceCreated, true);
  assert.equal(store.getSnapshot().snapshot.allowances.length, 1);
  // 1,245,000 over 10 calendar days
  assert.equal(store.getSnapshot().snapshot.allowances[0].amountMinor, 124_500);
  // Re-opening the same date is idempotent: no duplicate row and no extra write.
  const writesBefore = storage.writes.length;
  const reopened = await store.ensureDay(TODAY);
  assert.equal(reopened.allowanceCreated, false);
  assert.equal(storage.writes.length, writesBefore);
  assert.equal(store.getSnapshot().snapshot.allowances.length, 1);
});

test('no usable horizon keeps the limit unrecorded but expenses still work', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput({ limitMode: 'auto', manualLimitMinor: null }));
  const added = await store.addExpense({ date: TODAY, amountMinor: 10_000, expectedRevision: 1 });
  assert.equal(added.ok, true);
  assert.equal(added.horizonMissing, true); // the UI must ask for a horizon / manual limit
  assert.equal(store.getSnapshot().snapshot.allowances.length, 0);
  assert.equal(store.getSnapshot().snapshot.balanceMinor, 1_235_000);
});

test('money commands require setup and a stale revision is refused', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  assert.deepEqual(await store.addExpense({ date: TODAY, amountMinor: 1, expectedRevision: 0 }), {
    ok: false,
    reason: 'not-initialized',
  });
  await store.setup(setupInput());
  const first = await store.addExpense({ date: TODAY, amountMinor: 1_000, expectedRevision: 1 });
  assert.equal(first.ok, true);
  assert.deepEqual(
    await store.addExpense({ date: TODAY, amountMinor: 1_000, expectedRevision: 1 }),
    { ok: false, reason: 'stale' },
  );
  assert.deepEqual(await store.deleteExpense({ id: 'expense-9', expectedRevision: 2 }), {
    ok: false,
    reason: 'missing',
  });
});

test('a second mutation while a write is in flight returns busy (no queueing)', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput());
  const revision = store.getSnapshot().snapshot.revision;
  const first = store.addExpense({ date: TODAY, amountMinor: 1_000, expectedRevision: revision });
  const second = store.addExpense({ date: TODAY, amountMinor: 2_000, expectedRevision: revision });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.deepEqual(b, { ok: false, reason: 'busy' });
  assert.equal(store.getSnapshot().snapshot.expenses.length, 1);
});

test('500 limit / 620 spent stays 500 / 620 / overspend 120 after a restart', async () => {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput());
  await store.addExpense({ date: TODAY, amountMinor: 35_000, expectedRevision: 1 });
  await store.addExpense({ date: TODAY, amountMinor: 27_000, expectedRevision: 2 });
  const restarted = buildStore(storage);
  await restarted.load();
  const snapshot = restarted.getSnapshot().snapshot;
  assert.equal(snapshot.allowances[0].amountMinor, 50_000);
  assert.equal(snapshot.allowances[0].revision, 1);
  assert.equal(snapshot.balanceMinor, 1_183_000);
  const view = model.dayLimitView(snapshot, TODAY);
  assert.equal(view.spentMinor, 62_000);
  assert.equal(view.remainingMinor, -12_000);
  assert.equal(view.overspendMinor, 12_000);
});

/** A valid empty envelope string produced by the production serializer. */
function emptyEnvelope() {
  return serializeFinanceSnapshot(createEmptyFinanceSnapshot(NOW), NOW);
}
