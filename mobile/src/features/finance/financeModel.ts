/**
 * Pure Finance model: every money/allowance/expectation/obligation operation.
 *
 * All functions take a committed V1 snapshot and return a NEW snapshot (or a typed
 * failure) — no side effects, no storage, no clock reads. Encoded invariants:
 *
 * - Money is a safe integer in minor units; every delta is checked for safety and
 *   negative balances are allowed (never clamped to zero).
 * - Expected income (schedules/one-time) NEVER changes the balance; only recorded
 *   actual income does.
 * - Obligations NEVER change the balance.
 * - A per-date allowance row is written once (per day, pre-mutation base) and is
 *   never rewritten by expenses, income, edits, deletes or schedule changes; only
 *   an explicit confirmed change replaces today's row (revision + 1).
 */
import type {
  FinanceAllowance,
  FinanceCurrency,
  FinanceExpense,
  FinanceIncome,
  FinanceLimitMode,
  FinanceObligation,
  FinanceObligationKind,
  FinanceOccurrenceResolution,
  FinanceOneTimeExpectation,
  FinanceSalarySchedule,
  FinanceSnapshotV1,
} from '@/types/finance';
import {
  addCalendarDays,
  calendarDayDiff,
  clampDayOfMonth,
  dateInMonth,
  isValidIsoDate,
  isValidWallClockTime,
  monthKeyOf,
  localDateIso,
  shiftMonthKey,
} from './financeDates';
import { addMinor, aggregateMinor, divideMinorFloor, isSafeMinor } from './financeMoney';
import { validateFinanceAggregates } from './financeAggregates';

export type FinanceModelError =
  | 'not-initialized'
  | 'currency-locked'
  | 'validation'
  | 'future-date'
  | 'missing'
  | 'overflow'
  | 'no-horizon'
  | 'already-received'
  | 'receipt-linked'
  | 'unsafe-amount';

export type ModelResult =
  | { ok: true; snapshot: FinanceSnapshotV1 }
  | { ok: false; error: FinanceModelError };

export type FinanceClock = { nowIso: string; today: string };

const TEXT_LIMITS = { title: 300, note: 4_000, text: 200 } as const;


/**
 * Changed-field semantics: a form cap applies ONLY to a value the user actually
 * edited. An untouched value (including long legacy text or incidental whitespace)
 * is preserved byte-for-byte.
 */
function textChangeValid(
  next: string | undefined,
  previous: string | undefined,
  max: number,
): boolean {
  if (next === undefined) return true; // absence is preserved, never created
  if (previous !== undefined && next === previous) return true; // unchanged => exact
  return next.length <= max;
}

/** Recomputes the committed revision and returns a fresh immutable snapshot. */
function withCommitted(
  snapshot: FinanceSnapshotV1,
  patch: Partial<FinanceSnapshotV1>,
  savedAt: string,
): FinanceSnapshotV1 {
  return { ...snapshot, ...patch, revision: snapshot.revision + 1, savedAt };
}

/**
 * Same as `withCommitted`, but WITHOUT claiming a new committed revision: used when
 * the change is merged into a larger transaction (the day's allowance snapshot is
 * established in the SAME revision as the operation it accompanies).
 */
function withPatched(
  snapshot: FinanceSnapshotV1,
  patch: Partial<FinanceSnapshotV1>,
  savedAt: string,
): FinanceSnapshotV1 {
  return { ...snapshot, ...patch, savedAt };
}

function fail(error: FinanceModelError): ModelResult {
  return { ok: false, error };
}

/**
 * Safe signed balance delta: `null` means the result left the CHECKED money range
 * (safe integer AND within the supported magnitude), which callers report as a
 * typed `overflow` failure instead of persisting an unusable balance.
 */
function applyDelta(snapshot: FinanceSnapshotV1, delta: number): number | null {
  const next = addMinor(snapshot.balanceMinor, delta);
  return next !== null && isSafeMinor(next) ? next : null;
}

/**
 * Every checked money aggregate must stay a safe integer. The pure predicate lives in
 * `financeAggregates` so the storage parser enforces the same rule on hydration.
 */
export const validateAggregates = validateFinanceAggregates;

/** Rejects a candidate whose aggregates would be unsafe (checked BEFORE persist). */
function guardAggregates(snapshot: FinanceSnapshotV1): ModelResult | null {
  return validateAggregates(snapshot) === null ? null : fail('overflow');
}

type MoneyDeltaGuardInput = {
  rows: readonly { date?: string; amountMinor: number }[];
  /** Signed per-date deltas of the candidate (a moved row appears twice). */
  deltas: readonly { date: string; deltaMinor: number }[];
  /** Signed net change of the overall total. */
  totalDeltaMinor: number;
};

/**
 * Predictive aggregate guard: the affected day totals and the overall total must
 * stay safe integers. Rejects the command with `overflow` BEFORE a candidate is
 * built or persisted, so an unsafe aggregate can never be stored, displayed as
 * zero, or clamped.
 */
function guardMoneyDelta(input: MoneyDeltaGuardInput): FinanceModelError | null {
  const total = aggregateMinor(input.rows.map((row) => row.amountMinor));
  if (total === null) return 'overflow';
  if (addMinor(total, input.totalDeltaMinor) === null) return 'overflow';
  for (const entry of input.deltas) {
    if (!Number.isSafeInteger(entry.deltaMinor)) return 'overflow';
    const dayTotal = aggregateMinor(
      input.rows.filter((row) => row.date === entry.date).map((row) => row.amountMinor),
    );
    if (dayTotal === null) return 'overflow';
    if (addMinor(dayTotal, entry.deltaMinor) === null) return 'overflow';
  }
  return null;
}

/** Actual operations are dated today or earlier; future entries are rejected. */
export function isAcceptableOperationDate(date: string, today: string): boolean {
  const diff = calendarDayDiff(today, date);
  return diff !== null && diff <= 0;
}

export function requireInitialized(snapshot: FinanceSnapshotV1): FinanceModelError | null {
  return snapshot.initialized ? null : 'not-initialized';
}

/**
 * Store-facing drafts: the same fields the UI form collects, without the clock or
 * generated IDs (the store adds both). Unchanged optional fields stay absent so a
 * form edit never rewrites data the user did not touch.
 */
export type FinanceLimitModeInput = FinanceLimitMode;

export type ExpenseDraft = {
  date: string;
  amountMinor: number;
  note?: string;
  category?: string;
};

export type IncomeDraft = {
  date: string;
  amountMinor: number;
  note?: string;
  source?: string;
};

export type ScheduleDraft = {
  /** True only after editing the amount field; never persisted. */
  amountChanged?: boolean;
  dayOfMonth: number;
  expectedAmountMinor: number;
  title: string;
  active: boolean;
};

export type ExpectationDraft = {
  date: string;
  amountMinor: number;
  title: string;
};

export type ReceiveDraft = {
  id: string;
  amountMinor: number;
  date: string;
  note?: string;
  source?: string;
};

export type ObligationDraft = {
  kind: FinanceObligationKind;
  title: string;
  amountMinor: number;
  dueDate?: string;
  reminderTime?: string;
  reminderEnabled: boolean;
  note?: string;
};

/** Monthly occurrence drafts (identity = scheduleId + date). */
export type MonthlyReceiveDraft = {
  scheduleId: string;
  date: string;
  amountMinor: number;
  incomeDate: string;
  note?: string;
  source?: string;
};

// --------------------------------------------------------------------------- //
// Setup, currency and balance correction
// --------------------------------------------------------------------------- //

export type SetupInput = {
  currency: FinanceCurrency;
  balanceMinor: number;
  limitMode: FinanceLimitMode;
  manualLimitMinor: number | null;
  fallbackEndDate: string | null;
  clock: FinanceClock;
};

/** First setup — the ONLY mutation accepted before `initialized` is true. */
export function initializeFinance(snapshot: FinanceSnapshotV1, input: SetupInput): ModelResult {
  if (snapshot.initialized) return fail('validation');
  if (!isSafeMinor(input.balanceMinor)) return fail('unsafe-amount');
  if (input.limitMode === 'manual') {
    const manual = input.manualLimitMinor;
    if (manual === null || !isSafeMinor(manual) || manual < 0) return fail('validation');
  }
  if (input.fallbackEndDate !== null) {
    if (!isValidIsoDate(input.fallbackEndDate)) return fail('validation');
    const diff = calendarDayDiff(input.clock.today, input.fallbackEndDate);
    if (diff === null || diff <= 0) return fail('validation');
  }
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        initialized: true,
        settings: {
          currency: input.currency,
          limitMode: input.limitMode,
          manualLimitMinor: input.limitMode === 'manual' ? input.manualLimitMinor : null,
          fallbackEndDate: input.fallbackEndDate,
        },
        balanceMinor: input.balanceMinor,
        balanceUpdatedAt: input.clock.nowIso,
      },
      input.clock.nowIso,
    ),
  };
}

/**
 * Explicit balance correction: a replacement, never modelled as income/expense, so
 * it is excluded from spent/income statistics. Signed values are allowed.
 */
export function correctBalance(
  snapshot: FinanceSnapshotV1,
  input: { balanceMinor: number; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  if (!isSafeMinor(input.balanceMinor)) return fail('unsafe-amount');
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { balanceMinor: input.balanceMinor, balanceUpdatedAt: input.clock.nowIso },
      input.clock.nowIso,
    ),
  };
}

/**
 * Settings updates (limit mode / manual amount / fallback horizon) define the
 * DEFAULT for future days: an existing allowance row is never rewritten here.
 */
export function updateFinanceSettings(
  snapshot: FinanceSnapshotV1,
  input: {
    limitMode?: FinanceLimitMode;
    manualLimitMinor?: number | null;
    fallbackEndDate?: string | null;
    clock: FinanceClock;
  },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const nextMode = input.limitMode ?? snapshot.settings.limitMode;
  const nextManual =
    input.manualLimitMinor !== undefined
      ? input.manualLimitMinor
      : snapshot.settings.manualLimitMinor;
  if (nextManual !== null && (!isSafeMinor(nextManual) || nextManual < 0)) {
    return fail('validation');
  }
  if (nextMode === 'manual' && nextManual === null) return fail('validation');
  const nextFallback =
    input.fallbackEndDate !== undefined ? input.fallbackEndDate : snapshot.settings.fallbackEndDate;
  if (nextFallback !== null) {
    if (!isValidIsoDate(nextFallback)) return fail('validation');
    const diff = calendarDayDiff(input.clock.today, nextFallback);
    if (diff === null || diff <= 0) return fail('validation');
  }
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        settings: {
          ...snapshot.settings,
          limitMode: nextMode,
          manualLimitMinor: nextManual,
          fallbackEndDate: nextFallback,
        },
      },
      input.clock.nowIso,
    ),
  };
}

/** Currency is locked once Finance contains data (the brief's currency lock). */
export function financeContainsData(snapshot: FinanceSnapshotV1): boolean {
  return (
    snapshot.initialized ||
    snapshot.expenses.length > 0 ||
    snapshot.incomes.length > 0 ||
    snapshot.salarySchedules.length > 0 ||
    snapshot.oneTimeExpectations.length > 0 ||
    snapshot.occurrenceResolutions.length > 0 ||
    snapshot.obligations.length > 0 ||
    snapshot.allowances.length > 0
  );
}

export function changeCurrency(
  snapshot: FinanceSnapshotV1,
  input: { currency: FinanceCurrency; clock: FinanceClock },
): ModelResult {
  if (financeContainsData(snapshot)) return fail('currency-locked');
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { settings: { ...snapshot.settings, currency: input.currency } },
      input.clock.nowIso,
    ),
  };
}

export type ExpenseInput = {
  id: string;
  date: string;
  amountMinor: number;
  note?: string;
  category?: string;
  clock: FinanceClock;
};

function validateActual(
  date: string,
  amountMinor: number,
  clock: FinanceClock,
  short: { note?: string; label?: string },
  /**
   * Present when EDITING: the stored values of the entity. Text caps then apply only
   * to values the user actually changed, so an accepted legacy value survives.
   */
  previous?: { note?: string; label?: string },
): FinanceModelError | null {
  if (!isValidIsoDate(date)) return 'validation';
  if (!isAcceptableOperationDate(date, clock.today)) return 'future-date';
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return 'validation';
  if (!textChangeValid(short.note, previous?.note, TEXT_LIMITS.note)) return 'validation';
  if (!textChangeValid(short.label, previous?.label, TEXT_LIMITS.text)) return 'validation';
  return null;
}

export function addExpense(snapshot: FinanceSnapshotV1, input: ExpenseInput): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const invalid = validateActual(input.date, input.amountMinor, input.clock, {
    note: input.note,
    label: input.category,
  });
  if (invalid) return fail(invalid);
  const aggregate = guardMoneyDelta({
    rows: snapshot.expenses,
    deltas: [{ date: input.date, deltaMinor: input.amountMinor }],
    totalDeltaMinor: input.amountMinor,
  });
  if (aggregate) return fail(aggregate);
  const balance = applyDelta(snapshot, -input.amountMinor);
  if (balance === null) return fail('overflow');
  const expense: FinanceExpense = {
    id: input.id,
    date: input.date,
    amountMinor: input.amountMinor,
    balancePolicy: 'applied',
    createdAt: input.clock.nowIso,
  };
  if (input.note !== undefined) expense.note = input.note;
  if (input.category !== undefined) expense.category = input.category;
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { expenses: [...snapshot.expenses, expense], balanceMinor: balance },
      input.clock.nowIso,
    ),
  };
}

/** Edit: add the OLD amount back, subtract the NEW one (exact inverse delta). */
export function editExpense(snapshot: FinanceSnapshotV1, input: ExpenseInput): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.expenses.find((expense) => expense.id === input.id);
  if (existing === undefined) return fail('missing');
  // Changed-field semantics: an UNTOUCHED long/legacy value is preserved exactly,
  // while an actually edited text field must obey the form limits.
  const invalid = validateActual(
    input.date,
    input.amountMinor,
    input.clock,
    { note: input.note, label: input.category },
    { note: existing.note, label: existing.category },
  );
  if (invalid) return fail(invalid);
  const delta =
    existing.balancePolicy === 'applied' ? addMinor(existing.amountMinor, -input.amountMinor) : 0;
  if (delta === null) return fail('overflow');
  const balance = applyDelta(snapshot, delta);
  if (balance === null) return fail('overflow');
  const next: FinanceExpense = {
    id: existing.id,
    date: input.date,
    amountMinor: input.amountMinor,
    balancePolicy: existing.balancePolicy,
    createdAt: existing.createdAt,
    updatedAt: input.clock.nowIso,
  };
  if (input.note !== undefined) next.note = input.note;
  if (input.category !== undefined) next.category = input.category;
  const candidate = withCommitted(
    snapshot,
    {
      expenses: snapshot.expenses.map((expense) => (expense.id === next.id ? next : expense)),
      balanceMinor: balance,
    },
    input.clock.nowIso,
  );
  return guardAggregates(candidate) ?? { ok: true, snapshot: candidate };
}

/** Delete: refund exactly this row's amount (legacy history refunds nothing). */
export function deleteExpense(
  snapshot: FinanceSnapshotV1,
  input: { id: string; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.expenses.find((expense) => expense.id === input.id);
  if (existing === undefined) return fail('missing');
  const balance =
    existing.balancePolicy === 'applied'
      ? applyDelta(snapshot, existing.amountMinor)
      : snapshot.balanceMinor;
  if (balance === null) return fail('unsafe-amount');
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        expenses: snapshot.expenses.filter((expense) => expense.id !== input.id),
        balanceMinor: balance,
      },
      input.clock.nowIso,
    ),
  };
}

export type IncomeInput = {
  id: string;
  date: string;
  amountMinor: number;
  note?: string;
  source?: string;
  clock: FinanceClock;
};

export function addIncome(snapshot: FinanceSnapshotV1, input: IncomeInput): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const invalid = validateActual(input.date, input.amountMinor, input.clock, {
    note: input.note,
    label: input.source,
  });
  if (invalid) return fail(invalid);
  const aggregate = guardMoneyDelta({
    rows: snapshot.incomes,
    deltas: [{ date: input.date, deltaMinor: input.amountMinor }],
    totalDeltaMinor: input.amountMinor,
  });
  if (aggregate) return fail(aggregate);
  const balance = applyDelta(snapshot, input.amountMinor);
  if (balance === null) return fail('overflow');
  const income: FinanceIncome = {
    id: input.id,
    date: input.date,
    amountMinor: input.amountMinor,
    createdAt: input.clock.nowIso,
  };
  if (input.note !== undefined) income.note = input.note;
  if (input.source !== undefined) income.source = input.source;
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { incomes: [...snapshot.incomes, income], balanceMinor: balance },
      input.clock.nowIso,
    ),
  };
}

/** Edit receipt: subtract the OLD amount and add the NEW one; the occurrence key stays. */
export function editIncome(snapshot: FinanceSnapshotV1, input: IncomeInput): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.incomes.find((income) => income.id === input.id);
  if (existing === undefined) return fail('missing');
  // Changed-field semantics: untouched text keeps its exact value.
  const invalid = validateActual(
    input.date,
    input.amountMinor,
    input.clock,
    { note: input.note, label: input.source },
    { note: existing.note, label: existing.source },
  );
  if (invalid) return fail(invalid);
  const delta = addMinor(-existing.amountMinor, input.amountMinor);
  if (delta === null) return fail('overflow');
  const balance = applyDelta(snapshot, delta);
  if (balance === null) return fail('overflow');
  const next: FinanceIncome = {
    id: existing.id,
    date: input.date,
    amountMinor: input.amountMinor,
    createdAt: existing.createdAt,
    updatedAt: input.clock.nowIso,
  };
  if (input.note !== undefined) next.note = input.note;
  if (input.source !== undefined) next.source = input.source;
  const candidate = withCommitted(
    snapshot,
    {
      incomes: snapshot.incomes.map((income) => (income.id === next.id ? next : income)),
      balanceMinor: balance,
    },
    input.clock.nowIso,
  );
  return guardAggregates(candidate) ?? { ok: true, snapshot: candidate };
}

/**
 * Delete a receipt: reverse its amount and clear its received marker, which makes
 * the linked one-time expectation unresolved again (its source still exists).
 */
export function deleteIncome(
  snapshot: FinanceSnapshotV1,
  input: { id: string; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.incomes.find((income) => income.id === input.id);
  if (existing === undefined) return fail('missing');
  const balance = applyDelta(snapshot, -existing.amountMinor);
  if (balance === null) return fail('unsafe-amount');
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        incomes: snapshot.incomes.filter((income) => income.id !== input.id),
        oneTimeExpectations: snapshot.oneTimeExpectations.map((expectation) =>
          expectation.receivedIncomeId === input.id
            ? reopenExpectationRow(expectation, input.clock.nowIso)
            : expectation,
        ),
        // A deleted receipt reopens its monthly occurrence (the schedule/source
        // still exists), so the occurrence becomes unresolved again.
        occurrenceResolutions: snapshot.occurrenceResolutions.filter(
          (row) => row.receivedIncomeId !== input.id,
        ),
        balanceMinor: balance,
      },
      input.clock.nowIso,
    ),
  };
}

/** Clears resolution/receipt-link fields by omission (never by writing null). */
function reopenExpectationRow(
  expectation: FinanceOneTimeExpectation,
  updatedAt: string,
): FinanceOneTimeExpectation {
  return {
    id: expectation.id,
    date: expectation.date,
    amountMinor: expectation.amountMinor,
    title: expectation.title,
    createdAt: expectation.createdAt,
    updatedAt,
  };
}

// --------------------------------------------------------------------------- //
// Expected income: monthly schedules and one-time expectations
// --------------------------------------------------------------------------- //

/** Bounded monthly recurrence lookup (never materialized for thousands of years). */
const MAX_SCHEDULE_LOOKAHEAD_MONTHS = 60;

function isStrictlyAfter(candidate: string, afterDate: string): boolean {
  const diff = calendarDayDiff(afterDate, candidate);
  return diff !== null && diff > 0;
}

function earliest(current: string | null, candidate: string): string {
  if (current === null) return candidate;
  return candidate < current ? candidate : current;
}

/** One-time expectations count until they are received or skipped. */
export function isUnresolvedExpectation(expectation: FinanceOneTimeExpectation): boolean {
  return expectation.resolution === undefined && expectation.amountMinor > 0;
}

/** Stable occurrence identity for a monthly schedule: scheduleId + local date. */
export function occurrenceResolved(
  snapshot: FinanceSnapshotV1,
  scheduleId: string,
  date: string,
): FinanceOccurrenceResolution | null {
  return (
    snapshot.occurrenceResolutions.find(
      (row) => row.scheduleId === scheduleId && row.date === date,
    ) ?? null
  );
}

/** A monthly occurrence is unresolved until it is received or skipped. */
export function isUnresolvedOccurrence(
  snapshot: FinanceSnapshotV1,
  scheduleId: string,
  date: string,
): boolean {
  return occurrenceResolved(snapshot, scheduleId, date) === null;
}

/** The schedule occurrence date inside the month of `date` (clamped), or null. */
export function occurrenceDateFor(
  schedule: FinanceSalarySchedule,
  date: string,
): string | null {
  const key = monthKeyOf(date);
  if (key === null) return null;
  return dateInMonth(Number(key.slice(0, 4)), Number(key.slice(5, 7)), schedule.dayOfMonth);
}


/**
 * Earliest unresolved positive expected income date strictly AFTER `afterDate`, or
 * null when no horizon exists. Multiple expectations on the same earliest date give
 * a single horizon (future expected amounts are never summed into the numerator).
 */
export function nextExpectedIncomeDate(
  snapshot: FinanceSnapshotV1,
  afterDate: string,
): string | null {
  if (!isValidIsoDate(afterDate)) return null;
  let best: string | null = null;
  for (const expectation of snapshot.oneTimeExpectations) {
    if (!isUnresolvedExpectation(expectation)) continue;
    if (!isStrictlyAfter(expectation.date, afterDate)) continue;
    best = earliest(best, expectation.date);
  }
  const monthKey = afterDate.slice(0, 7);
  for (let offset = 0; offset <= MAX_SCHEDULE_LOOKAHEAD_MONTHS; offset += 1) {
    const key = shiftMonthKey(monthKey, offset);
    if (key === null) break;
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    let monthBest: string | null = null;
    for (const schedule of snapshot.salarySchedules) {
      if (!schedule.active || schedule.expectedAmountMinor <= 0) continue;
      const occurrence = dateInMonth(year, month, schedule.dayOfMonth);
      if (occurrence === null || !isStrictlyAfter(occurrence, afterDate)) continue;
      // A RECEIVED or SKIPPED occurrence no longer forms a horizon.
      if (!isUnresolvedOccurrence(snapshot, schedule.id, occurrence)) continue;
      monthBest = monthBest === null ? occurrence : earliest(monthBest, occurrence);
    }
    if (monthBest !== null) {
      best = earliest(best, monthBest);
      break; // months ascend, so the first month with an occurrence is the earliest
    }
  }
  return best;
}

export type ScheduleInput = {
  /** True only after editing the amount field; never persisted. */
  amountChanged?: boolean;
  id: string;
  dayOfMonth: number;
  expectedAmountMinor: number;
  title: string;
  active: boolean;
  clock: FinanceClock;
};

function validateSchedule(
  input: ScheduleInput,
  previousScheduleTitle?: string,
): FinanceModelError | null {
  if (
    !Number.isSafeInteger(input.dayOfMonth) ||
    input.dayOfMonth < 1 ||
    input.dayOfMonth > 31
  ) {
    return 'validation';
  }
  if (!Number.isSafeInteger(input.expectedAmountMinor) || input.expectedAmountMinor < 0) {
    return 'validation';
  }
  if (previousScheduleTitle === undefined || input.title !== previousScheduleTitle) {
    if (input.title.trim().length === 0) return 'validation';
  }
  if (!textChangeValid(input.title, previousScheduleTitle, TEXT_LIMITS.title)) {
    return 'validation';
  }
  return null;
}

export function addSalarySchedule(
  snapshot: FinanceSnapshotV1,
  input: ScheduleInput,
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const invalid = validateSchedule(input);
  if (invalid) return fail(invalid);
  const schedule: FinanceSalarySchedule = {
    id: input.id,
    dayOfMonth: input.dayOfMonth,
    expectedAmountMinor: input.expectedAmountMinor,
    title: input.title,
    active: input.active,
    createdAt: input.clock.nowIso,
  };
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { salarySchedules: [...snapshot.salarySchedules, schedule] },
      input.clock.nowIso,
    ),
  };
}

/** Editing a schedule affects future/unresolved expectations only (zero balance). */
export function editSalarySchedule(
  snapshot: FinanceSnapshotV1,
  input: ScheduleInput,
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.salarySchedules.find((schedule) => schedule.id === input.id);
  if (existing === undefined) return fail('missing');
  if (input.expectedAmountMinor === 0 && (input.amountChanged || existing.expectedAmountMinor !== 0)) return fail('validation');
  const invalid = validateSchedule(input, existing.title);
  if (invalid) return fail(invalid);
  const next: FinanceSalarySchedule = {
    id: existing.id,
    dayOfMonth: input.dayOfMonth,
    expectedAmountMinor: input.expectedAmountMinor,
    title: input.title,
    active: input.active,
    createdAt: existing.createdAt,
    updatedAt: input.clock.nowIso,
  };
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        salarySchedules: snapshot.salarySchedules.map((schedule) =>
          schedule.id === next.id ? next : schedule,
        ),
      },
      input.clock.nowIso,
    ),
  };
}

/** Deleting/pausing a schedule never deletes receipts or their historical refs. */
export function deleteSalarySchedule(
  snapshot: FinanceSnapshotV1,
  input: { id: string; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  if (!snapshot.salarySchedules.some((schedule) => schedule.id === input.id)) {
    return fail('missing');
  }
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        salarySchedules: snapshot.salarySchedules.filter(
          (schedule) => schedule.id !== input.id,
        ),
      },
      input.clock.nowIso,
    ),
  };
}
export type ExpectationInput = {
  id: string;
  date: string;
  amountMinor: number;
  title: string;
  clock: FinanceClock;
};

function validateExpectation(
  input: ExpectationInput,
  previous?: { title: string },
): FinanceModelError | null {
  if (input.title.trim().length === 0) return 'validation';
  if (!isValidIsoDate(input.date)) return 'validation';
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return 'validation';
  if (!textChangeValid(input.title, previous?.title, TEXT_LIMITS.title)) return 'validation';
  return null;
}

export function addOneTimeExpectation(
  snapshot: FinanceSnapshotV1,
  input: ExpectationInput,
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const invalid = validateExpectation(input);
  if (invalid) return fail(invalid);
  const aggregate = guardMoneyDelta({
    rows: snapshot.oneTimeExpectations,
    deltas: [],
    totalDeltaMinor: input.amountMinor,
  });
  if (aggregate) return fail(aggregate);
  const expectation: FinanceOneTimeExpectation = {
    id: input.id,
    date: input.date,
    amountMinor: input.amountMinor,
    title: input.title,
    createdAt: input.clock.nowIso,
  };
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { oneTimeExpectations: [...snapshot.oneTimeExpectations, expectation] },
      input.clock.nowIso,
    ),
  };
}

/** Edits an expectation (zero balance). A linked receipt makes the money read-only. */
export function editOneTimeExpectation(
  snapshot: FinanceSnapshotV1,
  input: ExpectationInput,
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.oneTimeExpectations.find((item) => item.id === input.id);
  if (existing === undefined) return fail('missing');
  const invalid = validateExpectation(input, { title: existing.title });
  if (invalid) return fail(invalid);
  if (existing.receivedIncomeId !== undefined && input.amountMinor !== existing.amountMinor) {
    return fail('receipt-linked');
  }
  const next: FinanceOneTimeExpectation = { ...existing, title: input.title };
  if (existing.receivedIncomeId === undefined) {
    next.date = input.date;
    next.amountMinor = input.amountMinor;
  }
  next.updatedAt = input.clock.nowIso;
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        oneTimeExpectations: snapshot.oneTimeExpectations.map((item) =>
          item.id === next.id ? next : item,
        ),
      },
      input.clock.nowIso,
    ),
  };
}

/** “Пропустить”: resolves an expectation with NO balance effect. */
export function skipOneTimeExpectation(
  snapshot: FinanceSnapshotV1,
  input: { id: string; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.oneTimeExpectations.find((item) => item.id === input.id);
  if (existing === undefined) return fail('missing');
  if (existing.receivedIncomeId !== undefined) return fail('receipt-linked');
  const next: FinanceOneTimeExpectation = {
    ...existing,
    resolution: 'skipped',
    resolvedAt: input.clock.nowIso,
    updatedAt: input.clock.nowIso,
  };
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        oneTimeExpectations: snapshot.oneTimeExpectations.map((item) =>
          item.id === next.id ? next : item,
        ),
      },
      input.clock.nowIso,
    ),
  };
}

/** Reopening a skipped occurrence removes its marker (received ones are read-only). */
export function reopenOneTimeExpectation(
  snapshot: FinanceSnapshotV1,
  input: { id: string; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.oneTimeExpectations.find((item) => item.id === input.id);
  if (existing === undefined) return fail('missing');
  if (existing.receivedIncomeId !== undefined) return fail('receipt-linked');
  const next: FinanceOneTimeExpectation = {
    id: existing.id,
    date: existing.date,
    amountMinor: existing.amountMinor,
    title: existing.title,
    createdAt: existing.createdAt,
    updatedAt: input.clock.nowIso,
  };
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        oneTimeExpectations: snapshot.oneTimeExpectations.map((item) =>
          item.id === next.id ? next : item,
        ),
      },
      input.clock.nowIso,
    ),
  };
}

/** Deletes the expectation only; a linked receipt and its historical ref are kept. */
export function deleteOneTimeExpectation(
  snapshot: FinanceSnapshotV1,
  input: { id: string; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  if (!snapshot.oneTimeExpectations.some((item) => item.id === input.id)) return fail('missing');
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        oneTimeExpectations: snapshot.oneTimeExpectations.filter((item) => item.id !== input.id),
      },
      input.clock.nowIso,
    ),
  };
}

export type ReceiveInput = {
  id: string;
  incomeId: string;
  amountMinor: number;
  date: string;
  note?: string;
  source?: string;
  clock: FinanceClock;
};

/**
 * “Получено”: income + received resolution + balance in ONE snapshot.
 *
 * Duplicate-safe by construction: an already received occurrence fails with
 * `already-received`, so rapid taps/retries can never post twice (the store also
 * rejects a second concurrent mutation with `busy`).
 */
export function receiveOneTimeExpectation(
  snapshot: FinanceSnapshotV1,
  input: ReceiveInput,
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.oneTimeExpectations.find((item) => item.id === input.id);
  if (existing === undefined) return fail('missing');
  if (existing.resolution === 'received' || existing.receivedIncomeId !== undefined) {
    return fail('already-received');
  }
  const invalid = validateActual(input.date, input.amountMinor, input.clock, {
    note: input.note,
    label: input.source,
  });
  if (invalid) return fail(invalid);
  if (snapshot.incomes.some((income) => income.id === input.incomeId)) return fail('validation');
  const balance = applyDelta(snapshot, input.amountMinor);
  if (balance === null) return fail('overflow');
  const income: FinanceIncome = {
    id: input.incomeId,
    date: input.date,
    amountMinor: input.amountMinor,
    createdAt: input.clock.nowIso,
  };
  if (input.note !== undefined) income.note = input.note;
  if (input.source !== undefined) income.source = input.source;
  const receipt: FinanceOneTimeExpectation = {
    ...existing,
    resolution: 'received',
    receivedIncomeId: input.incomeId,
    resolvedAt: input.clock.nowIso,
    updatedAt: input.clock.nowIso,
  };
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        incomes: [...snapshot.incomes, income],
        oneTimeExpectations: snapshot.oneTimeExpectations.map((item) =>
          item.id === receipt.id ? receipt : item,
        ),
        balanceMinor: balance,
      },
      input.clock.nowIso,
    ),
  };
}

// --------------------------------------------------------------------------- //
// Obligations (never change the balance)
// --------------------------------------------------------------------------- //

export type ObligationInput = {
  id: string;
  kind: FinanceObligationKind;
  title: string;
  amountMinor: number;
  dueDate?: string;
  reminderTime?: string;
  reminderEnabled: boolean;
  note?: string;
  clock: FinanceClock;
};

function validateObligation(
  input: ObligationInput,
  previous?: { title: string; note?: string },
): FinanceModelError | null {
  if (input.title.trim().length === 0) return 'validation';
  if (!textChangeValid(input.title, previous?.title, TEXT_LIMITS.title)) return 'validation';
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return 'validation';
  if (input.dueDate !== undefined && !isValidIsoDate(input.dueDate)) return 'validation';
  if (input.reminderTime !== undefined && !isValidWallClockTime(input.reminderTime)) {
    return 'validation';
  }
  if (input.reminderTime !== undefined && input.dueDate === undefined) return 'validation';
  if (input.reminderEnabled && (input.dueDate === undefined || input.reminderTime === undefined)) {
    return 'validation';
  }
  if (!textChangeValid(input.note, previous?.note, TEXT_LIMITS.note)) return 'validation';
  return null;
}

/** Reminder intent starts OFF for new items; enabling needs a due date and time. */
export function addObligation(snapshot: FinanceSnapshotV1, input: ObligationInput): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const invalid = validateObligation(input);
  if (invalid) return fail(invalid);
  const aggregate = guardMoneyDelta({
    rows: snapshot.obligations,
    deltas: [],
    totalDeltaMinor: input.amountMinor,
  });
  if (aggregate) return fail(aggregate);
  const obligation: FinanceObligation = {
    id: input.id,
    kind: input.kind,
    title: input.title,
    amountMinor: input.amountMinor,
    reminderEnabled: input.reminderEnabled,
    completed: false,
    createdAt: input.clock.nowIso,
  };
  if (input.dueDate !== undefined) obligation.dueDate = input.dueDate;
  if (input.reminderTime !== undefined) obligation.reminderTime = input.reminderTime;
  if (input.note !== undefined) obligation.note = input.note;
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { obligations: [...snapshot.obligations, obligation] },
      input.clock.nowIso,
    ),
  };
}

/** Editing due date/time/title only reshapes reminder intent (zero balance). */
export function editObligation(snapshot: FinanceSnapshotV1, input: ObligationInput): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.obligations.find((item) => item.id === input.id);
  if (existing === undefined) return fail('missing');
  const invalid = validateObligation(input, { title: existing.title, note: existing.note });
  if (invalid) return fail(invalid);
  const next: FinanceObligation = {
    id: existing.id,
    kind: input.kind,
    title: input.title,
    amountMinor: input.amountMinor,
    reminderEnabled: input.reminderEnabled,
    completed: existing.completed,
    createdAt: existing.createdAt,
    updatedAt: input.clock.nowIso,
  };
  // Removing the due date explicitly turns the reminder off (time is dropped too).
  if (input.dueDate !== undefined) next.dueDate = input.dueDate;
  if (input.dueDate !== undefined && input.reminderTime !== undefined && input.reminderEnabled) {
    next.reminderTime = input.reminderTime;
  }
  if (input.note !== undefined) next.note = input.note;
  if (existing.completed && existing.completedAt !== undefined) {
    next.completedAt = existing.completedAt;
  }
  const candidate = withCommitted(
    snapshot,
    { obligations: snapshot.obligations.map((item) => (item.id === next.id ? next : item)) },
    input.clock.nowIso,
  );
  return guardAggregates(candidate) ?? { ok: true, snapshot: candidate };
}

/** Completion/reopen is status-only: “Отметить выполненным” never moves money. */
export function setObligationCompleted(
  snapshot: FinanceSnapshotV1,
  input: { id: string; completed: boolean; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = snapshot.obligations.find((item) => item.id === input.id);
  if (existing === undefined) return fail('missing');
  const next: FinanceObligation = { ...existing, completed: input.completed };
  if (input.completed) {
    // Completing turns reminder intent off; due date and time stay recorded.
    next.reminderEnabled = false;
    next.completedAt = input.clock.nowIso;
  } else {
    delete next.completedAt;
  }
  next.updatedAt = input.clock.nowIso;
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { obligations: snapshot.obligations.map((item) => (item.id === next.id ? next : item)) },
      input.clock.nowIso,
    ),
  };
}

export function deleteObligation(
  snapshot: FinanceSnapshotV1,
  input: { id: string; clock: FinanceClock },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  if (!snapshot.obligations.some((item) => item.id === input.id)) return fail('missing');
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      { obligations: snapshot.obligations.filter((item) => item.id !== input.id) },
      input.clock.nowIso,
    ),
  };
}

// --------------------------------------------------------------------------- //
// Monthly SalarySchedule occurrences (resolved by scheduleId + date)
// --------------------------------------------------------------------------- //

type OccurrenceBase = { scheduleId: string; date: string; clock: FinanceClock };

function findSchedule(
  snapshot: FinanceSnapshotV1,
  scheduleId: string,
): FinanceSalarySchedule | null {
  return snapshot.salarySchedules.find((row) => row.id === scheduleId) ?? null;
}

/** The schedule's occurrence date for the month of `date`, or null. */
function expectedOccurrenceDate(schedule: FinanceSalarySchedule, date: string): string | null {
  return occurrenceDateFor(schedule, date);
}

/** “Пропустить” for one monthly occurrence (no balance effect, excluded horizon). */
export function skipMonthlyOccurrence(
  snapshot: FinanceSnapshotV1,
  input: OccurrenceBase,
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const schedule = findSchedule(snapshot, input.scheduleId);
  if (schedule === null) return fail('missing');
  if (!isValidIsoDate(input.date)) return fail('validation');
  if (expectedOccurrenceDate(schedule, input.date) !== input.date) return fail('validation');
  const existing = occurrenceResolved(snapshot, input.scheduleId, input.date);
  if (existing !== null && existing.resolution === 'received') return fail('receipt-linked');
  const row: FinanceOccurrenceResolution = {
    scheduleId: input.scheduleId,
    date: input.date,
    resolution: 'skipped',
    resolvedAt: input.clock.nowIso,
  };
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        occurrenceResolutions: [
          ...snapshot.occurrenceResolutions.filter(
            (item) => !(item.scheduleId === input.scheduleId && item.date === input.date),
          ),
          row,
        ],
      },
      input.clock.nowIso,
    ),
  };
}

/** Reopening a skipped monthly occurrence removes its marker. */
export function reopenMonthlyOccurrence(
  snapshot: FinanceSnapshotV1,
  input: OccurrenceBase,
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const existing = occurrenceResolved(snapshot, input.scheduleId, input.date);
  if (existing === null) return fail('missing');
  if (existing.resolution === 'received') return fail('receipt-linked');
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        occurrenceResolutions: snapshot.occurrenceResolutions.filter(
          (row) => !(row.scheduleId === input.scheduleId && row.date === input.date),
        ),
      },
      input.clock.nowIso,
    ),
  };
}

/**
 * “Получено” for a monthly occurrence: actual income + received resolution + balance
 * in ONE snapshot, duplicate-safe (a second attempt is `already-received`). The
 * occurrence identity stays `scheduleId + date` even if the income is later edited.
 */
export function receiveMonthlyOccurrence(
  snapshot: FinanceSnapshotV1,
  input: OccurrenceBase & {
    incomeId: string;
    amountMinor: number;
    incomeDate: string;
    note?: string;
    source?: string;
  },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  const schedule = findSchedule(snapshot, input.scheduleId);
  if (schedule === null) return fail('missing');
  if (!isValidIsoDate(input.date)) return fail('validation');
  if (expectedOccurrenceDate(schedule, input.date) !== input.date) return fail('validation');
  const existing = occurrenceResolved(snapshot, input.scheduleId, input.date);
  if (existing !== null && existing.resolution === 'received') return fail('already-received');
  const invalid = validateActual(input.incomeDate, input.amountMinor, input.clock, {
    note: input.note,
    label: input.source,
  });
  if (invalid) return fail(invalid);
  if (snapshot.incomes.some((income) => income.id === input.incomeId)) return fail('validation');
  const balance = applyDelta(snapshot, input.amountMinor);
  if (balance === null) return fail('overflow');
  const income: FinanceIncome = {
    id: input.incomeId,
    date: input.incomeDate,
    amountMinor: input.amountMinor,
    createdAt: input.clock.nowIso,
  };
  if (input.note !== undefined) income.note = input.note;
  if (input.source !== undefined) income.source = input.source;
  const resolution: FinanceOccurrenceResolution = {
    scheduleId: input.scheduleId,
    date: input.date,
    resolution: 'received',
    receivedIncomeId: input.incomeId,
    resolvedAt: input.clock.nowIso,
  };
  const next = withCommitted(
    snapshot,
    {
      incomes: [...snapshot.incomes, income],
      occurrenceResolutions: [
        ...snapshot.occurrenceResolutions.filter(
          (row) => !(row.scheduleId === input.scheduleId && row.date === input.date),
        ),
        resolution,
      ],
      balanceMinor: balance,
    },
    input.clock.nowIso,
  );
  const guarded = guardAggregates(next);
  if (guarded !== null) return guarded;
  return { ok: true, snapshot: next };
}

/**
 * The schedule's occurrence ON a given local date (clamped day-of-month), or null.
 * This is the actionable receipt target for “today”, NOT the strictly-future
 * horizon helper.
 */
export function occurrenceOnDate(
  snapshot: FinanceSnapshotV1,
  schedule: FinanceSalarySchedule,
  date: string,
): { date: string; resolved: FinanceOccurrenceResolution | null } | null {
  if (occurrenceDateFor(schedule, date) !== date) return null;
  return { date, resolved: occurrenceResolved(snapshot, schedule.id, date) };
}

const MAX_SCHEDULE_LOOKBACK_MONTHS = 60;

/**
 * The NEAREST UNRESOLVED occurrence BEFORE `today` (bounded lookback), so an overdue
 * monthly expectation stays actionable instead of being hidden behind next month.
 */
export function overdueOccurrence(
  snapshot: FinanceSnapshotV1,
  schedule: FinanceSalarySchedule,
  today: string,
): { date: string; resolved: FinanceOccurrenceResolution | null } | null {
  const monthKey = monthKeyOf(today);
  if (monthKey === null) return null;
  for (let offset = 0; offset <= MAX_SCHEDULE_LOOKBACK_MONTHS; offset += 1) {
    const key = shiftMonthKey(monthKey, -offset);
    if (key === null) return null;
    const occurrence = dateInMonth(
      Number(key.slice(0, 4)),
      Number(key.slice(5, 7)),
      schedule.dayOfMonth,
    );
    if (occurrence === null) continue;
    // Do not invent missed payments before this schedule existed.
    if (occurrence < localDateIso(new Date(schedule.createdAt))) return null;
    const diff = calendarDayDiff(occurrence, today);
    if (diff === null || diff <= 0) continue; // strictly before today only
    if (occurrenceResolved(snapshot, schedule.id, occurrence) !== null) continue;
    return { date: occurrence, resolved: null };
  }
  return null;
}

export type ActionableOccurrence = {
  scheduleId: string;
  title: string;
  amountMinor: number;
  date: string;
  /** `overdue` and `today` are actionable receipts; `future` is informational. */
  bucket: 'overdue' | 'today' | 'future';
  resolved: FinanceOccurrenceResolution | null;
};

/**
 * Actionable monthly occurrences in product order: overdue unresolved, today's
 * unresolved, then the next future occurrence of every active schedule. The future
 * AUTO horizon stays strictly-future only (`nextExpectedIncomeDate`); this helper is
 * the receipt/action projection.
 */
export function actionableMonthlyOccurrences(
  snapshot: FinanceSnapshotV1,
  today: string,
): readonly ActionableOccurrence[] {
  const rows: ActionableOccurrence[] = [];
  for (const schedule of snapshot.salarySchedules) {
    if (!schedule.active) continue;
    const row = (
      occurrence: { date: string; resolved: FinanceOccurrenceResolution | null },
      bucket: ActionableOccurrence['bucket'],
    ): ActionableOccurrence => ({
      scheduleId: schedule.id,
      title: schedule.title,
      amountMinor: schedule.expectedAmountMinor,
      date: occurrence.date,
      bucket,
      resolved: occurrence.resolved,
    });
    const overdue = overdueOccurrence(snapshot, schedule, today);
    if (overdue !== null) rows.push(row(overdue, 'overdue'));
    const onToday = occurrenceOnDate(snapshot, schedule, today);
    if (onToday !== null) rows.push(row(onToday, 'today'));
    // Keep skipped past occurrences reachable so the user can reopen them.
    for (const resolution of snapshot.occurrenceResolutions) {
      if (resolution.scheduleId === schedule.id && resolution.date < today && resolution.resolution === 'skipped') {
        rows.push(row({ date: resolution.date, resolved: resolution }, 'overdue'));
      }
    }
    const future = nextScheduleOccurrence(snapshot, schedule, today);
    if (future !== null) rows.push(row(future, 'future'));
  }
  const order: Record<ActionableOccurrence['bucket'], number> = { overdue: 0, today: 1, future: 2 };
  return rows.sort((a, b) => {
    if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.scheduleId < b.scheduleId ? -1 : a.scheduleId > b.scheduleId ? 1 : 0;
  });
}

/**
 * The schedule's first occurrence strictly after `afterDate` (bounded lookup) with
 * its recorded resolution, so the UI can show and resolve the nearest occurrence.
 */
export function nextScheduleOccurrence(
  snapshot: FinanceSnapshotV1,
  schedule: FinanceSalarySchedule,
  afterDate: string,
): { date: string; resolved: FinanceOccurrenceResolution | null } | null {
  const monthKey = monthKeyOf(afterDate);
  if (monthKey === null) return null;
  for (let offset = 0; offset <= MAX_SCHEDULE_LOOKAHEAD_MONTHS; offset += 1) {
    const key = shiftMonthKey(monthKey, offset);
    if (key === null) return null;
    const occurrence = dateInMonth(
      Number(key.slice(0, 4)),
      Number(key.slice(5, 7)),
      schedule.dayOfMonth,
    );
    if (occurrence === null || !isStrictlyAfter(occurrence, afterDate)) continue;
    return { date: occurrence, resolved: occurrenceResolved(snapshot, schedule.id, occurrence) };
  }
  return null;
}

/** Unresolved monthly occurrences falling on one local date (calendar markers). */
export function unresolvedMonthlyOccurrencesOn(
  snapshot: FinanceSnapshotV1,
  date: string,
): readonly { scheduleId: string; title: string; amountMinor: number; date: string }[] {
  const key = monthKeyOf(date);
  if (key === null) return [];
  return scheduleOccurrencesInMonth(snapshot, key).filter(
    (row) => row.date === date && isUnresolvedOccurrence(snapshot, row.scheduleId, row.date),
  );
}

// --------------------------------------------------------------------------- //
// Daily allowance (persisted per local date, never rewritten by operations)
// --------------------------------------------------------------------------- //

export function allowanceFor(
  snapshot: FinanceSnapshotV1,
  date: string,
): FinanceAllowance | null {
  return snapshot.allowances.find((row) => row.date === date) ?? null;
}

/**
 * spent(D) = ALL recorded expenses dated D (legacy history included); income is never
 * subtracted. Returns `null` when the aggregate is not a safe integer, so an overflow
 * can never be displayed or used as if it were zero.
 */
export function spentOn(snapshot: FinanceSnapshotV1, date: string): number | null {
  return aggregateMinor(
    snapshot.expenses.filter((expense) => expense.date === date).map((row) => row.amountMinor),
  );
}

/** Day income total, or `null` when the aggregate is unsafe. */
export function incomeOn(snapshot: FinanceSnapshotV1, date: string): number | null {
  return aggregateMinor(
    snapshot.incomes.filter((income) => income.date === date).map((row) => row.amountMinor),
  );
}

export type DayLimitView = {
  date: string;
  allowance: FinanceAllowance | null;
  /** `null` marks an unsafe aggregate (never silently zero). */
  spentMinor: number | null;
  /** `allowance − spent`, never clamped: −120 stays a visible overspend. */
  remainingMinor: number | null;
  /** Positive overspend amount, or null when within the limit. */
  overspendMinor: number | null;
  /** True when the limit cannot be shown yet (no row and no usable horizon). */
  unavailable: boolean;
  /** True when an internally invalid aggregate means the numbers are not shown. */
  invalid: boolean;
};

export function dayLimitView(snapshot: FinanceSnapshotV1, date: string): DayLimitView {
  const allowance = allowanceFor(snapshot, date);
  const spentMinor = spentOn(snapshot, date);
  if (spentMinor === null) {
    return {
      date,
      allowance,
      spentMinor: null,
      remainingMinor: null,
      overspendMinor: null,
      unavailable: allowance === null,
      invalid: true,
    };
  }
  if (allowance === null) {
    return {
      date,
      allowance: null,
      spentMinor,
      remainingMinor: null,
      overspendMinor: null,
      unavailable: true,
      invalid: false,
    };
  }
  const remainingMinor = addMinor(allowance.amountMinor, -spentMinor);
  if (remainingMinor === null) {
    return {
      date,
      allowance,
      spentMinor,
      remainingMinor: null,
      overspendMinor: null,
      unavailable: false,
      invalid: true,
    };
  }
  return {
    date,
    allowance,
    spentMinor,
    remainingMinor,
    overspendMinor: remainingMinor < 0 ? -remainingMinor : null,
    unavailable: false,
    invalid: false,
  };
}

export type EstablishResult =
  | { ok: true; snapshot: FinanceSnapshotV1; allowance: FinanceAllowance; changed: boolean }
  | {
      ok: true;
      snapshot: FinanceSnapshotV1;
      allowance: null;
      changed: false;
      reason: 'no-horizon' | 'not-initialized';
    }
  | { ok: false; error: FinanceModelError };

/** AUTO horizon: next expected income date, else the explicit fallback (> D). */
export function allowanceHorizon(
  snapshot: FinanceSnapshotV1,
  date: string,
): { horizonDate: string; days: number } | null {
  const fromIncome = nextExpectedIncomeDate(snapshot, date);
  const fallback = snapshot.settings.fallbackEndDate;
  const candidate = fromIncome ?? fallback;
  if (candidate === null) return null;
  const days = calendarDayDiff(date, candidate);
  if (days === null || days <= 0) return null;
  return { horizonDate: candidate, days };
}

/**
 * Establishes the allowance row for a local date from the PRE-mutation committed
 * state. An existing row is returned untouched (never rewritten, never duplicated),
 * so today's limit survives expenses, income, edits, deletes and restarts.
 */
export function establishAllowance(
  snapshot: FinanceSnapshotV1,
  input: { date: string; clock: FinanceClock },
): EstablishResult {
  if (!snapshot.initialized) {
    return { ok: true, snapshot, allowance: null, changed: false, reason: 'not-initialized' };
  }
  if (!isValidIsoDate(input.date)) return { ok: false, error: 'validation' };
  const existing = allowanceFor(snapshot, input.date);
  if (existing !== null) return { ok: true, snapshot, allowance: existing, changed: false };
  if (snapshot.settings.limitMode === 'manual') {
    const manual = snapshot.settings.manualLimitMinor;
    if (manual === null) {
      return { ok: true, snapshot, allowance: null, changed: false, reason: 'no-horizon' };
    }
    const row: FinanceAllowance = {
      date: input.date,
      mode: 'manual',
      amountMinor: manual,
      baseBalanceMinor: snapshot.balanceMinor,
      horizonDate: null,
      days: null,
      reason: 'manual',
      revision: 1,
      capturedAt: input.clock.nowIso,
    };
    return {
      ok: true,
      snapshot: withPatched(
        snapshot,
        { allowances: [...snapshot.allowances, row] },
        input.clock.nowIso,
      ),
      allowance: row,
      changed: true,
    };
  }
  const horizon = allowanceHorizon(snapshot, input.date);
  if (horizon === null) {
    // No usable horizon: the limit is unavailable (no row); expenses stay usable.
    return { ok: true, snapshot, allowance: null, changed: false, reason: 'no-horizon' };
  }
  const row: FinanceAllowance = {
    date: input.date,
    mode: 'auto',
    amountMinor: divideMinorFloor(snapshot.balanceMinor, horizon.days),
    baseBalanceMinor: snapshot.balanceMinor,
    horizonDate: horizon.horizonDate,
    days: horizon.days,
    reason: 'auto',
    revision: 1,
    capturedAt: input.clock.nowIso,
  };
  return {
    ok: true,
    snapshot: withPatched(snapshot, { allowances: [...snapshot.allowances, row] }, input.clock.nowIso),
    allowance: row,
    changed: true,
  };
}

/**
 * Explicit “Изменить лимит на сегодня”: the ONLY way today's row is replaced.
 * AUTO recalculates from the current balance and the current future horizon; MANUAL
 * uses the proposed amount. Expenses stay untouched and overspend is recomputed.
 */
/**
 * Explicit “Изменить лимит на сегодня”.
 *
 * There is NO prerequisite that today's row already exists: an explicit today's
 * action CREATES the row when it is missing (revision 1) and replaces it with
 * revision + 1 when it exists. This is also the recovery path for an AUTO setup
 * with no usable horizon (an explicit MANUAL amount is accepted immediately).
 */
export function applyTodayAllowance(
  snapshot: FinanceSnapshotV1,
  input: {
    date: string;
    mode: FinanceLimitMode;
    manualLimitMinor?: number | null;
    clock: FinanceClock;
  },
): ModelResult {
  const blocked = requireInitialized(snapshot);
  if (blocked) return fail(blocked);
  if (!isValidIsoDate(input.date)) return fail('validation');
  const existing = allowanceFor(snapshot, input.date);
  let row: FinanceAllowance;
  if (input.mode === 'manual') {
    const manual = input.manualLimitMinor;
    if (manual === undefined || manual === null) return fail('validation');
    if (!isSafeMinor(manual) || manual < 0) return fail('validation');
    row = {
      date: input.date,
      mode: 'manual',
      amountMinor: manual,
      baseBalanceMinor: snapshot.balanceMinor,
      horizonDate: null,
      days: null,
      reason: 'explicit-change',
      revision: (existing?.revision ?? 0) + 1,
      capturedAt: input.clock.nowIso,
    };
  } else {
    const horizon = allowanceHorizon(snapshot, input.date);
    if (horizon === null) return fail('no-horizon');
    row = {
      date: input.date,
      mode: 'auto',
      amountMinor: divideMinorFloor(snapshot.balanceMinor, horizon.days),
      baseBalanceMinor: snapshot.balanceMinor,
      horizonDate: horizon.horizonDate,
      days: horizon.days,
      reason: 'explicit-change',
      revision: (existing?.revision ?? 0) + 1,
      capturedAt: input.clock.nowIso,
    };
  }
  return {
    ok: true,
    snapshot: withCommitted(
      snapshot,
      {
        allowances: [
          ...snapshot.allowances.filter((item) => item.date !== input.date),
          row,
        ],
      },
      input.clock.nowIso,
    ),
  };
}

/**
 * Permanent limit settings PLUS an optional explicit application to today, in ONE
 * candidate (one durable write): changing the default mode/manual amount/fallback
 * NEVER rewrites an existing today's row unless `applyToday` is explicitly chosen.
 */
export function saveLimitSettings(
  snapshot: FinanceSnapshotV1,
  input: {
    limitMode: FinanceLimitMode;
    manualLimitMinor: number | null;
    fallbackEndDate: string | null;
    applyToday: boolean;
    date: string;
    clock: FinanceClock;
  },
): ModelResult {
  const settingsResult = updateFinanceSettings(snapshot, {
    limitMode: input.limitMode,
    manualLimitMinor: input.manualLimitMinor,
    fallbackEndDate: input.fallbackEndDate,
    clock: input.clock,
  });
  if (!settingsResult.ok) return settingsResult;
  if (!input.applyToday) return settingsResult;
  return applyTodayAllowance(settingsResult.snapshot, {
    date: input.date,
    mode: input.limitMode,
    manualLimitMinor: input.manualLimitMinor,
    clock: input.clock,
  });
}

/** Legacy alias: MANUAL amount provided => manual, otherwise an AUTO recalculation. */
export function changeTodayAllowance(
  snapshot: FinanceSnapshotV1,
  input: { date: string; manualLimitMinor?: number | null; clock: FinanceClock },
): ModelResult {
  const manual = input.manualLimitMinor;
  const mode: FinanceLimitMode = manual === undefined || manual === null ? 'auto' : 'manual';
  return applyTodayAllowance(snapshot, {
    date: input.date,
    mode,
    manualLimitMinor: manual,
    clock: input.clock,
  });
}

// --------------------------------------------------------------------------- //
// Projections for the UI (overview, obligations, finance calendar)
// --------------------------------------------------------------------------- //

/** Next open obligation: nearest due first (overdue included), undated last. */
export function nextOpenObligation(snapshot: FinanceSnapshotV1): FinanceObligation | null {
  const open = snapshot.obligations.filter((obligation) => !obligation.completed);
  const dated = open
    .filter((obligation) => obligation.dueDate !== undefined)
    .sort((a, b) =>
      a.dueDate === b.dueDate
        ? a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
        : (a.dueDate as string) < (b.dueDate as string)
          ? -1
          : 1,
    );
  if (dated.length > 0) return dated[0];
  return null;
}

export function openObligationsOn(
  snapshot: FinanceSnapshotV1,
  date: string,
): readonly FinanceObligation[] {
  return snapshot.obligations.filter(
    (obligation) => !obligation.completed && obligation.dueDate === date,
  );
}

export function unresolvedExpectationsOn(
  snapshot: FinanceSnapshotV1,
  date: string,
): readonly FinanceOneTimeExpectation[] {
  return snapshot.oneTimeExpectations.filter(
    (expectation) => isUnresolvedExpectation(expectation) && expectation.date === date,
  );
}

export type DayTotals = {
  date: string;
  /** `null` marks an unsafe aggregate (never silently zero). */
  expenseMinor: number | null;
  incomeMinor: number | null;
};

export function dayTotals(snapshot: FinanceSnapshotV1, date: string): DayTotals {
  return {
    date,
    expenseMinor: spentOn(snapshot, date),
    incomeMinor: incomeOn(snapshot, date),
  };
}

/** Month expense/income totals for the compact calendar (actual activity only). */
export function monthTotals(snapshot: FinanceSnapshotV1, monthKey: string): DayTotals {
  const inMonth = (value: string): boolean => value.slice(0, 7) === monthKey;
  return {
    date: monthKey,
    expenseMinor: aggregateMinor(
      snapshot.expenses.filter((expense) => inMonth(expense.date)).map((row) => row.amountMinor),
    ),
    incomeMinor: aggregateMinor(
      snapshot.incomes.filter((income) => inMonth(income.date)).map((row) => row.amountMinor),
    ),
  };
}

/**
 * AUTO snapshot change explainer: tomorrow derives a NEW snapshot from tomorrow's
 * committed balance and remaining calendar days (no carry-over, no compensation).
 */
export function nextDayAutoPreview(
  snapshot: FinanceSnapshotV1,
  today: string,
): { date: string; amountMinor: number; days: number } | null {
  const tomorrow = addCalendarDays(today, 1);
  if (tomorrow === null) return null;
  if (snapshot.settings.limitMode !== 'auto') return null;
  const horizon = allowanceHorizon(snapshot, tomorrow);
  if (horizon === null) return null;
  return {
    date: tomorrow,
    amountMinor: divideMinorFloor(snapshot.balanceMinor, horizon.days),
    days: horizon.days,
  };
}

/** Monthly schedule occurrences inside a month (for the expectation list). */
export function scheduleOccurrencesInMonth(
  snapshot: FinanceSnapshotV1,
  monthKey: string,
): readonly { scheduleId: string; title: string; date: string; amountMinor: number }[] {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const rows: { scheduleId: string; title: string; date: string; amountMinor: number }[] = [];
  for (const schedule of snapshot.salarySchedules) {
    if (!schedule.active) continue;
    const date = dateInMonth(year, month, clampDayOfMonth(year, month, schedule.dayOfMonth));
    if (date === null) continue;
    rows.push({
      scheduleId: schedule.id,
      title: schedule.title,
      date,
      amountMinor: schedule.expectedAmountMinor,
    });
  }
  return rows;
}
