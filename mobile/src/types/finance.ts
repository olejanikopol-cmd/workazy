/**
 * Native Finance domain types (Slice 6A).
 *
 * Deliberately separate from the web `lib/types.ts` FinanceState: this is a native
 * V1 envelope and is NOT wire-compatible with the legacy API (see the Slice 6 brief,
 * §1 and §8). Concepts and identifiers (SalarySchedule, expense, obligation kinds)
 * stay recognizable and backward-mappable, while money is ALWAYS a safe integer in
 * minor units — never a float, never a major-unit number.
 *
 * Product invariants encoded by these types:
 * - `balanceMinor` may be negative (signed balance is allowed).
 * - Expected income (schedules and one-time expectations) never touches the balance.
 * - Obligations never touch the balance.
 * - A per-date allowance snapshot is stored separately from expenses and is never
 *   rewritten by operations.
 */

export type FinanceMinor = number;

export type FinanceCurrency = 'UAH' | 'USD' | 'EUR' | 'PLN';

export const FINANCE_CURRENCIES: readonly FinanceCurrency[] = ['UAH', 'USD', 'EUR', 'PLN'];

export type FinanceLimitMode = 'auto' | 'manual';

/** Legacy rows keep their historical record but have no balance effect. */
export type FinanceBalancePolicy = 'applied' | 'legacy-history';

export type FinanceExpense = {
  id: string;
  /** Local calendar date YYYY-MM-DD. */
  date: string;
  amountMinor: FinanceMinor;
  note?: string;
  category?: string;
  balancePolicy: FinanceBalancePolicy;
  createdAt: string;
  updatedAt?: string;
};

export type FinanceIncome = {
  id: string;
  date: string;
  amountMinor: FinanceMinor;
  note?: string;
  source?: string;
  createdAt: string;
  updatedAt?: string;
};

/** Monthly expected income; SalarySchedule-compatible (dayOfMonth + title). */
export type FinanceSalarySchedule = {
  id: string;
  dayOfMonth: number;
  expectedAmountMinor: FinanceMinor;
  title: string;
  active: boolean;
  createdAt: string;
  updatedAt?: string;
};

export type FinanceExpectationResolution = 'received' | 'skipped';

export type FinanceOneTimeExpectation = {
  id: string;
  date: string;
  amountMinor: FinanceMinor;
  title: string;
  /** Absent = unresolved/overdue; `received` also carries the receipt link. */
  resolution?: FinanceExpectationResolution;
  /** Historical reference to the receipt; retained even if it is later edited. */
  receivedIncomeId?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt?: string;
};

export type FinanceObligationKind = 'payment' | 'debt' | 'receivable' | 'purchase';

export type FinanceObligation = {
  id: string;
  kind: FinanceObligationKind;
  title: string;
  amountMinor: FinanceMinor;
  /** Optional local due date; required only to enable a reminder. */
  dueDate?: string;
  /** Optional local wall-clock reminder time HH:MM. */
  reminderTime?: string;
  /**
   * Reminder INTENT only in Slice 6A: no OS notification is scheduled or reconciled
   * for Finance yet (deferred to Slice 6B).
   */
  reminderEnabled: boolean;
  completed: boolean;
  completedAt?: string;
  note?: string;
  createdAt: string;
  updatedAt?: string;
};

/** Why the stored per-date allowance exists. `revision` marks explicit replaces. */
/**
 * Resolution of ONE monthly SalarySchedule occurrence, identified by
 * `scheduleId + date`. Retained as a historical identifier even after the schedule
 * (or its linked receipt) is deleted, so a deleted occurrence never resolves again.
 */
export type FinanceOccurrenceResolution = {
  scheduleId: string;
  /** The occurrence's local calendar date (the clamped day-of-month). */
  date: string;
  resolution: FinanceExpectationResolution;
  /** Receipt link, present only for `received`. */
  receivedIncomeId?: string;
  resolvedAt: string;
  updatedAt?: string;
};

export type FinanceAllowanceReason = 'auto' | 'manual' | 'explicit-change';

export type FinanceAllowance = {
  /** Local calendar date the snapshot belongs to (at most one row per date). */
  date: string;
  mode: FinanceLimitMode;
  amountMinor: FinanceMinor;
  /** Committed balance used as the AUTO numerator (before that day's mutation). */
  baseBalanceMinor: FinanceMinor;
  /** AUTO horizon date (exclusive) and its Gregorian day count. */
  horizonDate: string | null;
  days: number | null;
  reason: FinanceAllowanceReason;
  revision: number;
  capturedAt: string;
};

export type FinanceSettings = {
  currency: FinanceCurrency;
  /** Locked once Finance contains data (the brief's currency lock). */
  limitMode: FinanceLimitMode;
  manualLimitMinor: FinanceMinor | null;
  /** Explicit AUTO fallback horizon (> today); never an assumed 30-day month. */
  fallbackEndDate: string | null;
};

/** Bookkeeping for the (separately authorized) legacy transfer; not imported in 6A. */
export type FinanceMigrationRecord = {
  transferId: string;
  appliedAt: string;
  source: 'finance-state' | 'planner-finances';
  changes: readonly string[];
} | null;

export type FinanceSnapshotV1 = {
  version: 1;
  /** Once true, only money commands are accepted; setup is the only pre-setup write. */
  initialized: boolean;
  settings: FinanceSettings;
  balanceMinor: FinanceMinor;
  balanceUpdatedAt: string | null;
  expenses: readonly FinanceExpense[];
  incomes: readonly FinanceIncome[];
  salarySchedules: readonly FinanceSalarySchedule[];
  oneTimeExpectations: readonly FinanceOneTimeExpectation[];
  /** Monthly occurrence resolutions (`scheduleId + date`), never fabricated. */
  occurrenceResolutions: readonly FinanceOccurrenceResolution[];
  obligations: readonly FinanceObligation[];
  allowances: readonly FinanceAllowance[];
  migration: FinanceMigrationRecord;
  /** Monotonic committed revision of this envelope (drives stale-write rejection). */
  revision: number;
  savedAt: string;
};

export type FinanceStateSnapshot = FinanceSnapshotV1;
