/**
 * Legacy → native Finance adapter tests (pure conversion, no runtime transfer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyFinanceSnapshot, parseFinanceSnapshot } from '../src/storage/financeStorage.ts';
import {
  decodeLegacySource,
  legacyMajorToMinor,
  transferLegacyFinance as productionTransferLegacyFinance,
} from '../src/features/finance/financeLegacyAdapter.ts';
import * as model from '../src/features/finance/financeModel.ts';

// Every successful legacy fixture must satisfy the production persisted contract.
function transferLegacyFinance(...args) {
  const result = productionTransferLegacyFinance(...args);
  if (result.ok) assert.equal(parseFinanceSnapshot(JSON.stringify(result.snapshot)).ok, true);
  return result;
}

const NOW = '2026-09-12T09:00:00.000Z';

const legacyPayroll = {
  id: 'salary-1',
  dayOfMonth: 25,
  amount: 20000,
  title: 'Зарплата',
  createdAt: '2026-01-05T08:00:00.000Z',
  updatedAt: '2026-02-05T08:00:00.000Z',
};

const legacySource = () => ({
  balance: 12800,
  updatedAt: '2026-03-01T10:00:00.000Z',
  salarySchedules: [legacyPayroll],
  expenses: [
    {
      id: 'expense-1',
      date: '2026-02-14',
      amount: 350.5,
      note: 'Продукти',
      createdAt: '2026-02-14T18:00:00.000Z',
    },
  ],
  obligations: [
    {
      id: 'obligation-1',
      kind: 'debt',
      title: 'Долг другу',
      amount: 1000,
      dueDate: '2026-03-10',
      completed: false,
      createdAt: '2026-02-01T09:00:00.000Z',
    },
    {
      id: 'obligation-2',
      kind: 'purchase',
      title: 'Ноутбук',
      amount: 45000,
      completed: true,
      reminderTime: '10:30',
      dueDate: '2026-01-20',
      createdAt: '2026-01-01T09:00:00.000Z',
    },
  ],
});

function transfer(payload, transferId = 'transfer-1', source = 'finance-state') {
  return transferLegacyFinance(payload, {
    source,
    transferId,
    nowIso: NOW,
    target: createEmptyFinanceSnapshot(NOW),
  });
}

test('legacy major numbers convert by decimal parsing, not float math', () => {
  assert.equal(legacyMajorToMinor(12800), 1_280_000);
  assert.equal(legacyMajorToMinor(350.5), 35_050);
  assert.equal(legacyMajorToMinor(0.1), 10);
  assert.equal(legacyMajorToMinor(-19.99), -1_999);
  assert.equal(legacyMajorToMinor(1234.567), null); // > 2 decimals: blocked, not rounded
  assert.equal(legacyMajorToMinor('100'), null);
  assert.equal(legacyMajorToMinor(Number.NaN), null);
  assert.equal(legacyMajorToMinor(1e21), null); // exponent artifact
});

test('a valid legacy snapshot converts losslessly (no invented money)', () => {
  const result = transfer(legacySource());
  assert.equal(result.ok, true);
  const snapshot = result.snapshot;
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.settings.currency, 'UAH'); // stated assumption
  assert.equal(snapshot.balanceMinor, 1_280_000); // as-is, expenses NOT subtracted again
  assert.equal(snapshot.balanceUpdatedAt, '2026-03-01T10:00:00.000Z');
  assert.equal(snapshot.incomes.length, 0); // never invented
  assert.equal(snapshot.allowances.length, 0); // established only after acceptance
  assert.equal(snapshot.oneTimeExpectations.length, 0);
  assert.deepEqual(snapshot.expenses, [
    {
      id: 'expense-1',
      date: '2026-02-14',
      amountMinor: 35_050,
      note: 'Продукти',
      balancePolicy: 'legacy-history',
      createdAt: '2026-02-14T18:00:00.000Z',
    },
  ]);
  assert.deepEqual(snapshot.salarySchedules, [
    {
      id: 'salary-1',
      dayOfMonth: 25,
      expectedAmountMinor: 2_000_000,
      title: 'Зарплата',
      active: true,
      createdAt: '2026-01-05T08:00:00.000Z',
      updatedAt: '2026-02-05T08:00:00.000Z',
    },
  ]);
  const debt = snapshot.obligations.find((item) => item.id === 'obligation-1');
  assert.equal(debt.kind, 'debt');
  assert.equal(debt.amountMinor, 100_000);
  assert.equal(debt.dueDate, '2026-03-10');
  assert.equal(debt.reminderEnabled, true); // legacy default reminder intent preserved
  assert.equal(debt.reminderTime, '09:00'); // explicit, and reported as a change
  assert.equal(debt.completed, false);
  const purchase = snapshot.obligations.find((item) => item.id === 'obligation-2');
  assert.equal(purchase.kind, 'purchase');
  assert.equal(purchase.completed, true);
  assert.equal(purchase.reminderTime, '10:30');
  assert.equal(purchase.reminderEnabled, false); // completed rows are not re-armed
  assert.equal(purchase.completedAt, '2026-01-01T09:00:00.000Z');
  assert.equal(snapshot.migration.transferId, 'transfer-1');
  assert.equal(snapshot.migration.source, 'finance-state');
  assert.equal(result.changes.some((line) => line.includes('UAH')), true);
  assert.equal(result.changes.some((line) => line.includes('legacy-history')), true);
  // The produced envelope is a valid V1 snapshot.
  assert.equal(parseFinanceSnapshot(JSON.stringify({ ...snapshot })).ok, true);
});

test('imprecise, duplicated, malformed or unsupported rows block the WHOLE transfer', () => {
  const imprecise = legacySource();
  imprecise.expenses[0].amount = 12.345;
  const impreciseResult = transfer(imprecise);
  assert.equal(impreciseResult.ok, false);
  assert.equal(impreciseResult.blockers.some((line) => line.includes('не представима')), true);

  const duplicated = legacySource();
  duplicated.expenses.push({ ...duplicated.expenses[0] });
  const duplicateResult = transfer(duplicated);
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.blockers.some((line) => line.includes('повторяющийся id')), true);

  const badDate = legacySource();
  badDate.expenses[0].date = '2026-02-30';
  assert.equal(transfer(badDate).ok, false);

  const badKind = legacySource();
  badKind.obligations[0].kind = 'receivable'; // never guessed from legacy text
  assert.equal(transfer(badKind).ok, false);

  const badReminder = legacySource();
  badReminder.obligations.push({
    id: 'obligation-3',
    kind: 'debt',
    title: 'Без даты',
    amount: 100,
    reminderTime: '09:00', // reminder time without a due date
    completed: false,
    createdAt: '2026-02-01T09:00:00.000Z',
  });
  const reminderResult = transfer(badReminder);
  assert.equal(reminderResult.ok, false);
  assert.equal(reminderResult.blockers.some((line) => line.includes('reminderTime без dueDate')), true);

  const missingCollections = legacySource();
  delete missingCollections.expenses;
  assert.equal(transfer(missingCollections).ok, false);

  // No partial conversion and no writes happen in the failure path.
  assert.equal('snapshot' in impreciseResult, false);
});

test('an absent obligations collection becomes [], never a guess', () => {
  const source = legacySource();
  delete source.obligations;
  const result = transfer(source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.obligations, []);
  assert.equal(result.changes.some((line) => line.includes('obligations')), true);
});

test('the planner snapshot source is decoded explicitly, never guessed', () => {
  const explicit = transfer(
    { finances: legacySource() },
    'transfer-planner',
    'planner-finances',
  );
  assert.equal(explicit.ok, true);
  assert.equal(explicit.snapshot.migration.source, 'planner-finances');
  const missing = decodeLegacySource({}, 'planner-finances');
  assert.equal(missing.ok, false);
  const wrongSource = transfer({ finances: legacySource() }, 'transfer-2', 'finance-state');
  assert.equal(wrongSource.ok, false); // no guessing between competing shapes
});

test('a populated target refuses automatic replacement; the same transfer is idempotent', () => {
  const first = transfer(legacySource());
  assert.equal(first.ok, true);
  // The same transfer ID applied to its own target is idempotent, not an append.
  const repeated = transferLegacyFinance(legacySource(), {
    source: 'finance-state',
    transferId: 'transfer-1',
    nowIso: '2026-09-13T09:00:00.000Z',
    target: first.snapshot,
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.snapshot, first.snapshot);
  // A DIFFERENT transfer onto a populated target is refused (later merge design needed).
  const conflicting = transferLegacyFinance(legacySource(), {
    source: 'finance-state',
    transferId: 'transfer-2',
    nowIso: NOW,
    target: first.snapshot,
  });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.blockers.some((line) => line.includes('target-not-empty')), true);
});

test('a legacy zero schedule is retained but is not a horizon candidate', () => {
  const source = legacySource();
  source.salarySchedules = [
    { ...legacyPayroll, id: 'salary-zero', amount: 0, dayOfMonth: 20, title: 'Нулевая' },
    { ...legacyPayroll, id: 'salary-paid', amount: 20000, dayOfMonth: 25 },
  ];
  const result = transfer(source);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.salarySchedules.length, 2); // retained, not dropped
  assert.equal(result.changes.some((line) => line.includes('нулевая сумма')), true);
  const horizon = model.nextExpectedIncomeDate(result.snapshot, '2026-09-12');
  assert.equal(horizon, '2026-09-25'); // the zero row is skipped
  // Imported expenses appear in history but never move the imported balance.
  const view = model.spentOn(result.snapshot, '2026-02-14');
  assert.equal(view, 35_050);
  assert.equal(result.snapshot.balanceMinor, 1_280_000);
});

test('a missing legacy updatedAt uses the transfer instant (new bookkeeping)', () => {
  const source = legacySource();
  delete source.updatedAt;
  const result = transfer(source);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.balanceUpdatedAt, NOW);
  assert.equal(result.changes.some((line) => line.includes('updatedAt')), true);
});
