/**
 * Finance model tests: the real production model over committed V1 snapshots.
 * Covers the brief's product invariants (fixed allowance, signed balance, exact
 * deltas, expected-vs-actual income, obligations, horizon rules).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyFinanceSnapshot } from '../src/storage/financeStorage.ts';
import * as model from '../src/features/finance/financeModel.ts';
import { formatMoneyMinor } from '../src/features/finance/financeMoney.ts';

const NOW = '2026-09-12T09:00:00.000Z';
const TODAY = '2026-09-12';

const clock = (today = TODAY, nowIso = NOW) => ({ today, nowIso });

/** Initialized snapshot with an active monthly expectation on `salaryDay`. */
function initialized({
  balanceMinor = 0,
  limitMode = 'auto',
  manualLimitMinor = null,
  salaryDay = null,
} = {}) {
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
    manualLimitMinor,
    fallbackEndDate: null,
    clock: clock(),
  });
  assert.equal(setup.ok, true);
  return setup.snapshot;
}

function expectOk(result) {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result.snapshot;
}

test('AUTO allowance is derived from the pre-mutation balance and a calendar horizon', () => {
  // 12,800.00 with an expectation 10 calendar days away => 1,280.00
  const start = initialized({ balanceMinor: 1_280_000, salaryDay: 22 });
  const established = model.establishAllowance(start, { date: TODAY, clock: clock() });
  assert.equal(established.ok, true);
  assert.equal(established.allowance.amountMinor, 128_000);
  assert.equal(established.allowance.horizonDate, '2026-09-22');
  assert.equal(established.allowance.days, 10);
  assert.equal(established.allowance.baseBalanceMinor, 1_280_000);
  assert.equal(established.allowance.reason, 'auto');
  assert.equal(established.allowance.revision, 1);
});

test('500 limit / 350 spent => 150 remaining, limit unchanged', () => {
  let snapshot = initialized({
    balanceMinor: 1_245_000,
    limitMode: 'manual',
    manualLimitMinor: 50_000,
  });
  snapshot = expectOk(model.establishAllowance(snapshot, { date: TODAY, clock: clock() }));
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 35_000, clock: clock() }),
  );
  const view = model.dayLimitView(snapshot, TODAY);
  assert.equal(view.allowance.amountMinor, 50_000);
  assert.equal(view.spentMinor, 35_000);
  assert.equal(view.remainingMinor, 15_000);
  assert.equal(view.overspendMinor, null);
  assert.equal(snapshot.balanceMinor, 1_210_000);
});

test('500 limit / 620 spent => overspend 120 and the limit STAYS 500', () => {
  let snapshot = initialized({
    balanceMinor: 1_245_000,
    limitMode: 'manual',
    manualLimitMinor: 50_000,
  });
  snapshot = expectOk(model.establishAllowance(snapshot, { date: TODAY, clock: clock() }));
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 35_000, clock: clock() }),
  );
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e2', date: TODAY, amountMinor: 27_000, clock: clock() }),
  );
  const view = model.dayLimitView(snapshot, TODAY);
  assert.equal(view.allowance.amountMinor, 50_000); // never rewritten by expenses
  assert.equal(view.spentMinor, 62_000);
  assert.equal(view.remainingMinor, -12_000);
  assert.equal(view.overspendMinor, 12_000);
  assert.equal(formatMoneyMinor(view.remainingMinor, 'UAH'), '−120,00 ₴');
  assert.equal(snapshot.balanceMinor, 1_183_000);
});

test("today's saved limit is untouched by expense/income edits and deletes", () => {
  let snapshot = initialized({
    balanceMinor: 1_000_000,
    limitMode: 'manual',
    manualLimitMinor: 50_000,
  });
  snapshot = expectOk(model.establishAllowance(snapshot, { date: TODAY, clock: clock() }));
  const savedLimit = model.allowanceFor(snapshot, TODAY).amountMinor;
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 20_000, clock: clock() }),
  );
  snapshot = expectOk(
    model.addIncome(snapshot, { id: 'i1', date: TODAY, amountMinor: 500_000, clock: clock() }),
  );
  snapshot = expectOk(
    model.editExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 33_000, clock: clock() }),
  );
  snapshot = expectOk(model.deleteExpense(snapshot, { id: 'e1', clock: clock() }));
  snapshot = expectOk(model.deleteIncome(snapshot, { id: 'i1', clock: clock() }));
  assert.equal(model.allowanceFor(snapshot, TODAY).amountMinor, savedLimit);
  assert.equal(model.allowanceFor(snapshot, TODAY).revision, 1);
  assert.equal(snapshot.allowances.length, 1);
});

test('expense edit/delete are exact inverses', () => {
  let snapshot = initialized({ balanceMinor: 100_000 });
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 25_000, clock: clock() }),
  );
  assert.equal(snapshot.balanceMinor, 75_000);
  snapshot = expectOk(
    model.editExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 5_000, clock: clock() }),
  );
  assert.equal(snapshot.balanceMinor, 95_000);
  snapshot = expectOk(model.deleteExpense(snapshot, { id: 'e1', clock: clock() }));
  assert.equal(snapshot.balanceMinor, 100_000);
});

test('income edit/delete are exact inverses and may leave a signed balance', () => {
  let snapshot = initialized({ balanceMinor: 10_000 });
  snapshot = expectOk(
    model.addIncome(snapshot, { id: 'i1', date: TODAY, amountMinor: 5_000, clock: clock() }),
  );
  assert.equal(snapshot.balanceMinor, 15_000);
  snapshot = expectOk(
    model.editIncome(snapshot, { id: 'i1', date: TODAY, amountMinor: 1_000, clock: clock() }),
  );
  assert.equal(snapshot.balanceMinor, 11_000);
  snapshot = expectOk(model.deleteIncome(snapshot, { id: 'i1', clock: clock() }));
  assert.equal(snapshot.balanceMinor, 10_000);
});

test('a negative balance is allowed and never clamped', () => {
  let snapshot = initialized({ balanceMinor: 1_000, salaryDay: 22 });
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 6_000, clock: clock() }),
  );
  assert.equal(snapshot.balanceMinor, -5_000);
  const established = model.establishAllowance(snapshot, { date: TODAY, clock: clock() });
  assert.equal(established.ok, true);
  assert.equal(established.allowance.amountMinor, 0); // AUTO limit 0 with a visible deficit
  assert.equal(established.allowance.baseBalanceMinor, -5_000);
  assert.equal(snapshot.balanceMinor, -5_000);
});

test('no usable horizon => the limit is unavailable and stays unrecorded', () => {
  const snapshot = initialized({ balanceMinor: 1_000_000 });
  const established = model.establishAllowance(snapshot, { date: TODAY, clock: clock() });
  assert.equal(established.ok, true);
  assert.equal(established.allowance, null);
  assert.equal(established.reason, 'no-horizon');
  assert.equal(established.snapshot.allowances.length, 0); // no synthetic row
  // Expenses and the balance stay usable without a limit.
  const spent = expectOk(
    model.addExpense(established.snapshot, {
      id: 'e1',
      date: TODAY,
      amountMinor: 10_000,
      clock: clock(),
    }),
  );
  assert.equal(spent.balanceMinor, 990_000);
  assert.equal(model.dayLimitView(spent, TODAY).unavailable, true);
  assert.equal(model.dayLimitView(spent, TODAY).spentMinor, 10_000);
});

test('an explicit AUTO fallback horizon substitutes for a missing expectation', () => {
  const empty = createEmptyFinanceSnapshot(NOW);
  const setup = model.initializeFinance(empty, {
    currency: 'UAH',
    balanceMinor: 300_000,
    limitMode: 'auto',
    manualLimitMinor: null,
    fallbackEndDate: '2026-09-15', // 3 calendar days away
    clock: clock(),
  });
  assert.equal(setup.ok, true);
  const established = model.establishAllowance(setup.snapshot, { date: TODAY, clock: clock() });
  assert.equal(established.allowance.amountMinor, 100_000); // 3000 / 3
  assert.equal(established.allowance.horizonDate, '2026-09-15');
});

test('a fallback horizon in the past is rejected at setup and on update', () => {
  const empty = createEmptyFinanceSnapshot(NOW);
  const bad = model.initializeFinance(empty, {
    currency: 'UAH',
    balanceMinor: 0,
    limitMode: 'auto',
    manualLimitMinor: null,
    fallbackEndDate: TODAY,
    clock: clock(),
  });
  assert.deepEqual(bad, { ok: false, error: 'validation' });
  const good = initialized({ balanceMinor: 100_000 });
  assert.deepEqual(
    model.updateFinanceSettings(good, { fallbackEndDate: '2026-09-01', clock: clock() }),
    { ok: false, error: 'validation' },
  );
});

test("today's unresolved expected income is not a zero-day divisor", () => {
  let snapshot = initialized({ balanceMinor: 500_000, salaryDay: 22 });
  snapshot = expectOk(
    model.addOneTimeExpectation(snapshot, {
      id: 'x1',
      date: TODAY,
      amountMinor: 100_000,
      title: 'Возврат долга',
      clock: clock(),
    }),
  );
  const established = model.establishAllowance(snapshot, { date: TODAY, clock: clock() });
  // The horizon stays the next FUTURE date (the schedule), today's expectation is not
  // divided into a zero-day limit.
  assert.equal(established.allowance.horizonDate, '2026-09-22');
  assert.equal(established.allowance.days, 10);
  assert.equal(established.allowance.amountMinor, 50_000);
});


test('monthly expectations clamp to the real month end (29/30/31, leap years)', () => {
  const withDay = (day) =>
    expectOk(
      model.addSalarySchedule(initialized({ balanceMinor: 0 }), {
        id: 's1',
        dayOfMonth: day,
        expectedAmountMinor: 100_000,
        title: `План ${day}`,
        active: true,
        clock: clock(),
      }),
    );
  // 31 -> 30 in April, 31 -> 28 in February 2026, 31 -> 29 in leap February 2024.
  assert.equal(model.nextExpectedIncomeDate(withDay(31), '2026-04-01'), '2026-04-30');
  assert.equal(model.nextExpectedIncomeDate(withDay(31), '2026-02-01'), '2026-02-28');
  assert.equal(model.nextExpectedIncomeDate(withDay(31), '2024-02-01'), '2024-02-29');
  // 30 -> 28 in February 2026; 29 -> 28 in February 2026 but 29 stays in April.
  assert.equal(model.nextExpectedIncomeDate(withDay(30), '2026-02-01'), '2026-02-28');
  assert.equal(model.nextExpectedIncomeDate(withDay(29), '2026-02-01'), '2026-02-28');
  assert.equal(model.nextExpectedIncomeDate(withDay(29), '2026-04-01'), '2026-04-29');
  // Day-of-month 1 stays on the first.
  assert.equal(model.nextExpectedIncomeDate(withDay(1), '2026-04-01'), '2026-05-01');
});

test('the horizon is the EARLIEST unresolved expectation strictly after today', () => {
  let snapshot = initialized({ balanceMinor: 0, salaryDay: 25 });
  snapshot = expectOk(
    model.addOneTimeExpectation(snapshot, {
      id: 'x1',
      date: '2026-09-20',
      amountMinor: 50_000,
      title: 'Аванс',
      clock: clock(),
    }),
  );
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-09-20');
  // Skipping it removes that occurrence from the horizon (no balance effect).
  const before = snapshot.balanceMinor;
  snapshot = expectOk(model.skipOneTimeExpectation(snapshot, { id: 'x1', clock: clock() }));
  assert.equal(snapshot.balanceMinor, before);
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-09-25');
  // Reopening restores it.
  snapshot = expectOk(model.reopenOneTimeExpectation(snapshot, { id: 'x1', clock: clock() }));
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-09-20');
});

test('a zero-amount schedule is retained but is not a horizon candidate', () => {
  let snapshot = initialized({ balanceMinor: 0 });
  snapshot = expectOk(
    model.addSalarySchedule(snapshot, {
      id: 's0',
      dayOfMonth: 20,
      expectedAmountMinor: 0,
      title: 'Нулевая',
      active: true,
      clock: clock(),
    }),
  );
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), null);
  snapshot = expectOk(
    model.addSalarySchedule(snapshot, {
      id: 's1',
      dayOfMonth: 22,
      expectedAmountMinor: 100_000,
      title: 'Зарплата',
      active: true,
      clock: clock(),
    }),
  );
  assert.equal(model.nextExpectedIncomeDate(snapshot, TODAY), '2026-09-22');
});

test('expected income never changes the balance; only a receipt does', () => {
  let snapshot = initialized({ balanceMinor: 100_000 });
  snapshot = expectOk(
    model.addSalarySchedule(snapshot, {
      id: 's1',
      dayOfMonth: 25,
      expectedAmountMinor: 2_000_000,
      title: 'Зарплата',
      active: true,
      clock: clock(),
    }),
  );
  snapshot = expectOk(
    model.addOneTimeExpectation(snapshot, {
      id: 'x1',
      date: '2026-09-20',
      amountMinor: 300_000,
      title: 'Возврат',
      clock: clock(),
    }),
  );
  assert.equal(snapshot.balanceMinor, 100_000); // expectations are invisible to balance
  snapshot = expectOk(
    model.editOneTimeExpectation(snapshot, {
      id: 'x1',
      date: '2026-09-21',
      amountMinor: 400_000,
      title: 'Возврат долга',
      clock: clock(),
    }),
  );
  assert.equal(snapshot.balanceMinor, 100_000);

  const received = expectOk(
    model.receiveOneTimeExpectation(snapshot, {
      id: 'x1',
      incomeId: 'i1',
      amountMinor: 400_000,
      date: TODAY,
      clock: clock(),
    }),
  );
  assert.equal(received.balanceMinor, 500_000); // only the receipt moves money
  assert.equal(received.incomes.length, 1);
  const row = received.oneTimeExpectations.find((item) => item.id === 'x1');
  assert.equal(row.resolution, 'received');
  assert.equal(row.receivedIncomeId, 'i1');
});

test('a receipt cannot be posted twice (duplicate-safe) and deleting it reopens', () => {
  let snapshot = initialized({ balanceMinor: 0 });
  snapshot = expectOk(
    model.addOneTimeExpectation(snapshot, {
      id: 'x1',
      date: '2026-09-20',
      amountMinor: 300_000,
      title: 'Возврат',
      clock: clock(),
    }),
  );
  snapshot = expectOk(
    model.receiveOneTimeExpectation(snapshot, {
      id: 'x1',
      incomeId: 'i1',
      amountMinor: 300_000,
      date: TODAY,
      clock: clock(),
    }),
  );
  const balanceAfterReceipt = snapshot.balanceMinor;
  // Rapid second tap / retry: typed failure, no second income, no double credit.
  assert.deepEqual(
    model.receiveOneTimeExpectation(snapshot, {
      id: 'x1',
      incomeId: 'i2',
      amountMinor: 300_000,
      date: TODAY,
      clock: clock(),
    }),
    { ok: false, error: 'already-received' },
  );
  assert.equal(snapshot.incomes.length, 1);
  assert.equal(snapshot.balanceMinor, balanceAfterReceipt);
  // Deleting the receipt reverses the amount and makes the expectation unresolved.
  const reopened = expectOk(model.deleteIncome(snapshot, { id: 'i1', clock: clock() }));
  assert.equal(reopened.balanceMinor, 0);
  assert.equal(reopened.incomes.length, 0);
  const row = reopened.oneTimeExpectations.find((item) => item.id === 'x1');
  assert.equal(row.resolution, undefined);
  assert.equal(row.receivedIncomeId, undefined);
  assert.equal(model.nextExpectedIncomeDate(reopened, TODAY), '2026-09-20');
});

test('obligations: all four kinds, zero balance effect, status-only completion', () => {
  let snapshot = initialized({ balanceMinor: 100_000 });
  for (const kind of ['payment', 'debt', 'receivable', 'purchase']) {
    snapshot = expectOk(
      model.addObligation(snapshot, {
        id: `o-${kind}`,
        kind,
        title: `Обязательство ${kind}`,
        amountMinor: 25_000,
        dueDate: '2026-09-20',
        reminderTime: '09:00',
        reminderEnabled: true,
        clock: clock(),
      }),
    );
  }
  assert.equal(snapshot.balanceMinor, 100_000); // obligations never move money
  assert.equal(snapshot.obligations.length, 4);

  // Completion is status-only and turns the reminder intent off.
  snapshot = expectOk(
    model.setObligationCompleted(snapshot, { id: 'o-debt', completed: true, clock: clock() }),
  );
  assert.equal(snapshot.balanceMinor, 100_000);
  const completed = snapshot.obligations.find((item) => item.id === 'o-debt');
  assert.equal(completed.completed, true);
  assert.equal(completed.reminderEnabled, false);
  assert.equal(completed.dueDate, '2026-09-20'); // due date and time stay recorded
  assert.equal(typeof completed.completedAt, 'string');

  // Reopen clears the completion timestamp and keeps the money untouched.
  snapshot = expectOk(
    model.setObligationCompleted(snapshot, { id: 'o-debt', completed: false, clock: clock() }),
  );
  assert.equal(snapshot.obligations.find((item) => item.id === 'o-debt').completedAt, undefined);
  assert.equal(snapshot.balanceMinor, 100_000);

  // Edit + delete keep the balance untouched as well.
  snapshot = expectOk(
    model.editObligation(snapshot, {
      id: 'o-purchase',
      kind: 'purchase',
      title: 'Ноутбук',
      amountMinor: 300_000,
      dueDate: '2026-10-01',
      reminderTime: '10:00',
      reminderEnabled: true,
      clock: clock(),
    }),
  );
  assert.equal(snapshot.balanceMinor, 100_000);
  snapshot = expectOk(model.deleteObligation(snapshot, { id: 'o-purchase', clock: clock() }));
  assert.equal(snapshot.balanceMinor, 100_000);
  assert.equal(snapshot.obligations.length, 3);
});

test('reminder intent requires a due date and time; removing the date turns it off', () => {
  const snapshot = initialized({ balanceMinor: 0 });
  assert.deepEqual(
    model.addObligation(snapshot, {
      id: 'o1',
      kind: 'payment',
      title: 'Аренда',
      amountMinor: 50_000,
      reminderEnabled: true, // no due date/time
      clock: clock(),
    }),
    { ok: false, error: 'validation' },
  );
  assert.deepEqual(
    model.addObligation(snapshot, {
      id: 'o2',
      kind: 'payment',
      title: 'Аренда',
      amountMinor: 50_000,
      reminderTime: '09:00', // time without a date
      reminderEnabled: false,
      clock: clock(),
    }),
    { ok: false, error: 'validation' },
  );
  const withReminder = expectOk(
    model.addObligation(snapshot, {
      id: 'o3',
      kind: 'payment',
      title: 'Аренда',
      amountMinor: 50_000,
      dueDate: '2026-09-20',
      reminderTime: '09:00',
      reminderEnabled: true,
      clock: clock(),
    }),
  );
  // Removing the due date explicitly turns the reminder off and drops the time.
  const cleared = expectOk(
    model.editObligation(withReminder, {
      id: 'o3',
      kind: 'payment',
      title: 'Аренда',
      amountMinor: 50_000,
      reminderEnabled: false,
      clock: clock(),
    }),
  );
  const row = cleared.obligations.find((item) => item.id === 'o3');
  assert.equal(row.dueDate, undefined);
  assert.equal(row.reminderTime, undefined);
  assert.equal(row.reminderEnabled, false);
});

test('the next open obligation prefers overdue/nearest due; undated items are last', () => {
  let snapshot = initialized({ balanceMinor: 0 });
  snapshot = expectOk(
    model.addObligation(snapshot, {
      id: 'o-late',
      kind: 'debt',
      title: 'Долг',
      amountMinor: 1_000,
      dueDate: '2026-09-01', // overdue
      reminderEnabled: false,
      clock: clock(),
    }),
  );
  snapshot = expectOk(
    model.addObligation(snapshot, {
      id: 'o-soon',
      kind: 'payment',
      title: 'Платёж',
      amountMinor: 1_000,
      dueDate: '2026-09-20',
      reminderEnabled: false,
      clock: clock(),
    }),
  );
  snapshot = expectOk(
    model.addObligation(snapshot, {
      id: 'o-nodate',
      kind: 'purchase',
      title: 'Покупка',
      amountMinor: 1_000,
      reminderEnabled: false,
      clock: clock(),
    }),
  );
  assert.equal(model.nextOpenObligation(snapshot).id, 'o-late');
  assert.deepEqual(
    model.openObligationsOn(snapshot, '2026-09-20').map((item) => item.id),
    ['o-soon'],
  );
  snapshot = expectOk(
    model.setObligationCompleted(snapshot, { id: 'o-late', completed: true, clock: clock() }),
  );
  assert.equal(model.nextOpenObligation(snapshot).id, 'o-soon');
  snapshot = expectOk(
    model.setObligationCompleted(snapshot, { id: 'o-soon', completed: true, clock: clock() }),
  );
  assert.equal(model.nextOpenObligation(snapshot), null); // undated is not a fake "next"
});

test('legacy-history expenses count in spent totals but never move the balance', () => {
  const applied = initialized({ balanceMinor: 500_000 });
  const withExpense = expectOk(
    model.addExpense(applied, {
      id: 'old',
      date: '2026-08-01',
      amountMinor: 20_000,
      clock: clock(),
    }),
  );
  // Simulate the imported legacy row exactly as the adapter produces it.
  const imported = {
    ...withExpense,
    expenses: withExpense.expenses.map((expense) => ({
      ...expense,
      balancePolicy: 'legacy-history',
    })),
    revision: withExpense.revision + 1,
  };
  const balanceBefore = imported.balanceMinor;
  assert.equal(model.spentOn(imported, '2026-08-01'), 20_000); // visible in history
  const edited = expectOk(
    model.editExpense(imported, {
      id: 'old',
      date: '2026-08-01',
      amountMinor: 33_000,
      clock: clock(),
    }),
  );
  assert.equal(edited.balanceMinor, balanceBefore); // no refund/debit from legacy rows
  const deleted = expectOk(model.deleteExpense(edited, { id: 'old', clock: clock() }));
  assert.equal(deleted.balanceMinor, balanceBefore);
  assert.equal(deleted.expenses.length, 0);
});

test('an explicit balance correction is a replacement, not a transaction', () => {
  let snapshot = initialized({ balanceMinor: 100_000 });
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 10_000, clock: clock() }),
  );
  snapshot = expectOk(model.correctBalance(snapshot, { balanceMinor: -2_500, clock: clock() }));
  assert.equal(snapshot.balanceMinor, -2_500); // signed replacement, no clamping
  assert.equal(snapshot.expenses.length, 1); // excluded from statistics
  assert.equal(snapshot.incomes.length, 0);
  // A later edit of the applied expense still uses the delta table.
  const edited = expectOk(
    model.editExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 4_000, clock: clock() }),
  );
  assert.equal(edited.balanceMinor, -2_500 + 10_000 - 4_000);
});

test('tomorrow derives a NEW AUTO snapshot from the then-current balance', () => {
  // Day one: 15,000 over 6 calendar days => 2,500.
  let snapshot = initialized({ balanceMinor: 1_500_000, salaryDay: 18 });
  const dayOne = model.establishAllowance(snapshot, { date: TODAY, clock: clock() });
  assert.equal(dayOne.allowance.amountMinor, 250_000);
  snapshot = dayOne.snapshot;
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: TODAY, amountMinor: 300_000, clock: clock() }),
  );
  // Today's row is untouched...
  assert.equal(model.allowanceFor(snapshot, TODAY).amountMinor, 250_000);
  assert.equal(model.dayLimitView(snapshot, TODAY).remainingMinor, -50_000);
  // ...and the NEXT day recalculates from the committed balance: 12,000 / 5 = 2,400.
  const tomorrow = '2026-09-13';
  const dayTwo = model.establishAllowance(snapshot, { date: tomorrow, clock: clock(tomorrow) });
  assert.equal(dayTwo.allowance.amountMinor, 240_000);
  assert.equal(dayTwo.allowance.days, 5);
  assert.equal(dayTwo.allowance.baseBalanceMinor, 1_200_000);
  assert.equal(dayTwo.allowance.revision, 1);
  // Both rows coexist: one row per date, never a rewritten history.
  assert.equal(dayTwo.snapshot.allowances.length, 2);
});

test('an explicitly changed limit replaces only today, with revision + 1', () => {
  let snapshot = initialized({ balanceMinor: 0, limitMode: 'auto', salaryDay: 22 });
  snapshot = expectOk(model.establishAllowance(snapshot, { date: TODAY, clock: clock() }));
  const before = model.allowanceFor(snapshot, TODAY);
  snapshot = expectOk(
    model.changeTodayAllowance(snapshot, {
      date: TODAY,
      manualLimitMinor: 50_000,
      clock: clock(),
    }),
  );
  const after = model.allowanceFor(snapshot, TODAY);
  assert.equal(after.amountMinor, 50_000);
  assert.equal(after.reason, 'explicit-change');
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.mode, 'manual');
  assert.equal(snapshot.allowances.length, 1);
  // Settings-only updates never touch an existing row.
  const updated = expectOk(
    model.updateFinanceSettings(snapshot, { limitMode: 'auto', clock: clock() }),
  );
  assert.equal(model.allowanceFor(updated, TODAY).amountMinor, 50_000);
  assert.equal(updated.settings.limitMode, 'auto');
});

test('the finance calendar projection reports day and month activity', () => {
  let snapshot = initialized({ balanceMinor: 1_000_000 });
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e1', date: '2026-09-10', amountMinor: 10_000, clock: clock() }),
  );
  snapshot = expectOk(
    model.addExpense(snapshot, { id: 'e2', date: '2026-09-10', amountMinor: 5_000, clock: clock() }),
  );
  snapshot = expectOk(
    model.addIncome(snapshot, { id: 'i1', date: '2026-09-11', amountMinor: 20_000, clock: clock() }),
  );
  snapshot = expectOk(
    model.addOneTimeExpectation(snapshot, {
      id: 'x1',
      date: '2026-09-10',
      amountMinor: 7_000,
      title: 'Ожидание',
      clock: clock(),
    }),
  );
  const totals = model.dayTotals(snapshot, '2026-09-10');
  assert.equal(totals.expenseMinor, 15_000);
  assert.equal(totals.incomeMinor, 0);
  assert.deepEqual(
    model.unresolvedExpectationsOn(snapshot, '2026-09-10').map((item) => item.id),
    ['x1'],
  );
  const month = model.monthTotals(snapshot, '2026-09');
  assert.equal(month.expenseMinor, 15_000);
  assert.equal(month.incomeMinor, 20_000);
});

test('currency is locked as soon as Finance contains data', () => {
  const empty = createEmptyFinanceSnapshot(NOW);
  const changed = model.changeCurrency(empty, { currency: 'USD', clock: clock() });
  assert.equal(changed.ok, true);
  assert.equal(changed.snapshot.settings.currency, 'USD');
  const afterSetup = initialized({ balanceMinor: 1_000 });
  assert.deepEqual(model.changeCurrency(afterSetup, { currency: 'EUR', clock: clock() }), {
    ok: false,
    error: 'currency-locked',
  });
});

test('future-dated actual operations are rejected (offer expectations instead)', () => {
  const snapshot = initialized({ balanceMinor: 100_000 });
  assert.deepEqual(
    model.addExpense(snapshot, {
      id: 'e1',
      date: '2026-09-13',
      amountMinor: 1_000,
      clock: clock(),
    }),
    { ok: false, error: 'future-date' },
  );
  // A future expectation is fine: it is not an actual event.
  const expectation = model.addOneTimeExpectation(snapshot, {
    id: 'x1',
    date: '2026-10-01',
    amountMinor: 1_000,
    title: 'Ожидание',
    clock: clock(),
  });
  assert.equal(expectation.ok, true);
});
