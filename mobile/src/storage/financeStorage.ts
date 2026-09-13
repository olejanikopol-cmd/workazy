/**
 * Native Finance persistence: single versioned key, strict parser and serializer.
 *
 * The parser validates the WHOLE envelope (and every row) and never repairs,
 * filters or defaults anything: corrupt bytes, an unknown version, duplicate IDs,
 * invalid dates, inconsistent reminders/resolutions or unsafe integers all yield
 * `load-error`, so the caller can keep the original bytes and block writes instead
 * of silently normalizing a damaged state.
 */
import {
  FINANCE_CURRENCIES,
  type FinanceAllowance,
  type FinanceCurrency,
  type FinanceExpense,
  type FinanceIncome,
  type FinanceLimitMode,
  type FinanceObligation,
  type FinanceObligationKind,
  type FinanceOccurrenceResolution,
  type FinanceOneTimeExpectation,
  type FinanceSalarySchedule,
  type FinanceSnapshotV1,
} from '@/types/finance';
import {
  isValidIsoDate,
  isValidIsoTimestamp,
  isValidWallClockTime,
} from '@/features/finance/financeDates';
import { MAX_MONEY_MINOR } from '@/features/finance/financeMoney';
import { validateFinanceAggregates } from '@/features/finance/financeAggregates';

/** Distinct key from any web/browser-storage key. */
export const FINANCE_STORAGE_KEY = 'workazy-native-finance-v1';

export type FinanceStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type FinanceParseResult =
  | { ok: true; snapshot: FinanceSnapshotV1 }
  | { ok: false; error: string };

const OBLIGATION_KINDS: readonly FinanceObligationKind[] = [
  'payment',
  'debt',
  'receivable',
  'purchase',
];
const LIMIT_MODES: readonly FinanceLimitMode[] = ['auto', 'manual'];
const ALLOWANCE_REASONS = ['auto', 'manual', 'explicit-change'] as const;

const LIMITS = { id: 120, title: 300, note: 4_000, text: 200 } as const;

/**
 * Persisted-text bounds are deliberately LARGER than the form limits: a value that
 * the (separately authorized) migration accepted as valid legacy content must
 * survive hydration byte-for-byte, while a hard upper bound still protects the
 * envelope from absurd payloads. Form limits apply to NEW/CHANGED input only.
 */
export const PERSISTED_TEXT_LIMIT = 100_000;

/** Exact string member check (never coerces arrays/objects/numbers). */
function isExactString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** Exact optional string: absent, or a real string (null/array/object are invalid). */
function isOptionalString(value: unknown, max: number): value is string | undefined {
  return value === undefined || isExactString(value, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(object: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(object).every((key) => allowed.includes(key));
}

function isMoney(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= -MAX_MONEY_MINOR &&
    value <= MAX_MONEY_MINOR
  );
}

function isPositiveMoney(value: unknown): value is number {
  return isMoney(value) && value > 0;
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.id;
}

function isTitleLike(value: unknown): value is string {
  return isExactString(value, PERSISTED_TEXT_LIMIT) && value.trim().length > 0;
}

/** Reads a persisted local date: an exact string only (arrays/numbers are invalid). */
function readIsoDate(value: unknown): string | null {
  return typeof value === 'string' && isValidIsoDate(value) ? value : null;
}

/** Reads a persisted wall-clock time: an exact `HH:MM` string only. */
function readWallClock(value: unknown): string | null {
  return typeof value === 'string' && isValidWallClockTime(value) ? value : null;
}

/** Reads a persisted ISO timestamp: an exact string only. */
function readTimestamp(value: unknown): string | null {
  return typeof value === 'string' && isValidIsoTimestamp(value) ? value : null;
}

function optionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || readTimestamp(value) !== null;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > PERSISTED_TEXT_LIMIT) return null;
    result.push(entry);
  }
  return result;
}

function parseExpense(raw: unknown): FinanceExpense | string {
  if (!isRecord(raw)) return 'expense-not-object';
  if (
    !hasOnlyKeys(raw, [
      'id',
      'date',
      'amountMinor',
      'note',
      'category',
      'balancePolicy',
      'createdAt',
      'updatedAt',
    ])
  ) {
    return 'expense-unknown-key';
  }
  if (!isValidId(raw.id)) return 'expense-id';
  const expenseDate = readIsoDate(raw.date);
  if (expenseDate === null) return 'expense-date';
  if (!isPositiveMoney(raw.amountMinor)) return 'expense-amount';
  if (!isOptionalString(raw.note, PERSISTED_TEXT_LIMIT)) return 'expense-note';
  if (!isOptionalString(raw.category, PERSISTED_TEXT_LIMIT)) return 'expense-category';
  if (raw.balancePolicy !== 'applied' && raw.balancePolicy !== 'legacy-history') {
    return 'expense-balance-policy';
  }
  if (typeof raw.createdAt !== 'string' || !isValidIsoTimestamp(raw.createdAt)) {
    return 'expense-created-at';
  }
  if (!optionalTimestamp(raw.updatedAt)) return 'expense-updated-at';
  const expense: FinanceExpense = {
    id: raw.id,
    date: expenseDate,
    amountMinor: raw.amountMinor,
    balancePolicy: raw.balancePolicy,
    createdAt: raw.createdAt,
  };
  if (raw.note !== undefined) expense.note = raw.note;
  if (raw.category !== undefined) expense.category = raw.category;
  if (raw.updatedAt !== undefined) expense.updatedAt = raw.updatedAt;
  return expense;
}

function parseIncome(raw: unknown): FinanceIncome | string {
  if (!isRecord(raw)) return 'income-not-object';
  if (!hasOnlyKeys(raw, ['id', 'date', 'amountMinor', 'note', 'source', 'createdAt', 'updatedAt'])) {
    return 'income-unknown-key';
  }
  if (!isValidId(raw.id)) return 'income-id';
  const incomeDate = readIsoDate(raw.date);
  if (incomeDate === null) return 'income-date';
  if (!isPositiveMoney(raw.amountMinor)) return 'income-amount';
  if (!isOptionalString(raw.note, PERSISTED_TEXT_LIMIT)) return 'income-note';
  if (!isOptionalString(raw.source, PERSISTED_TEXT_LIMIT)) return 'income-source';
  if (typeof raw.createdAt !== 'string' || !isValidIsoTimestamp(raw.createdAt)) {
    return 'income-created-at';
  }
  if (!optionalTimestamp(raw.updatedAt)) return 'income-updated-at';
  const income: FinanceIncome = {
    id: raw.id,
    date: incomeDate,
    amountMinor: raw.amountMinor,
    createdAt: raw.createdAt,
  };
  if (raw.note !== undefined) income.note = raw.note;
  if (raw.source !== undefined) income.source = raw.source;
  if (raw.updatedAt !== undefined) income.updatedAt = raw.updatedAt;
  return income;
}

function parseSchedule(raw: unknown): FinanceSalarySchedule | string {
  if (!isRecord(raw)) return 'schedule-not-object';
  if (
    !hasOnlyKeys(raw, [
      'id',
      'dayOfMonth',
      'expectedAmountMinor',
      'title',
      'active',
      'createdAt',
      'updatedAt',
    ])
  ) {
    return 'schedule-unknown-key';
  }
  if (!isValidId(raw.id)) return 'schedule-id';
  if (
    typeof raw.dayOfMonth !== 'number' ||
    !Number.isSafeInteger(raw.dayOfMonth) ||
    raw.dayOfMonth < 1 ||
    raw.dayOfMonth > 31
  ) {
    return 'schedule-day-of-month';
  }
  // A legacy zero amount is retained (it is simply not a horizon candidate).
  if (!isMoney(raw.expectedAmountMinor) || raw.expectedAmountMinor < 0) return 'schedule-amount';
  if (!isTitleLike(raw.title)) return 'schedule-title';
  if (typeof raw.active !== 'boolean') return 'schedule-active';
  if (typeof raw.createdAt !== 'string' || !isValidIsoTimestamp(raw.createdAt)) {
    return 'schedule-created-at';
  }
  if (!optionalTimestamp(raw.updatedAt)) return 'schedule-updated-at';
  const schedule: FinanceSalarySchedule = {
    id: raw.id,
    dayOfMonth: raw.dayOfMonth,
    expectedAmountMinor: raw.expectedAmountMinor,
    title: raw.title,
    active: raw.active,
    createdAt: raw.createdAt,
  };
  if (raw.updatedAt !== undefined) schedule.updatedAt = raw.updatedAt;
  return schedule;
}

function parseExpectation(raw: unknown): FinanceOneTimeExpectation | string {
  if (!isRecord(raw)) return 'expectation-not-object';
  if (
    !hasOnlyKeys(raw, [
      'id',
      'date',
      'amountMinor',
      'title',
      'resolution',
      'receivedIncomeId',
      'resolvedAt',
      'createdAt',
      'updatedAt',
    ])
  ) {
    return 'expectation-unknown-key';
  }
  if (!isValidId(raw.id)) return 'expectation-id';
  const expectationDate = readIsoDate(raw.date);
  if (expectationDate === null) return 'expectation-date';
  if (!isPositiveMoney(raw.amountMinor)) return 'expectation-amount';
  if (!isTitleLike(raw.title)) return 'expectation-title';
  if (
    raw.resolution !== undefined &&
    raw.resolution !== 'received' &&
    raw.resolution !== 'skipped'
  ) {
    return 'expectation-resolution';
  }
  if (raw.receivedIncomeId !== undefined && !isValidId(raw.receivedIncomeId)) {
    return 'expectation-received-income-id';
  }
  if (!optionalTimestamp(raw.resolvedAt)) return 'expectation-resolved-at';
  if (typeof raw.createdAt !== 'string' || !isValidIsoTimestamp(raw.createdAt)) {
    return 'expectation-created-at';
  }
  if (!optionalTimestamp(raw.updatedAt)) return 'expectation-updated-at';
  // Receipt/resolution consistency: a receipt link exists only with `received`, and
  // `received` always keeps its link.
  if (raw.resolution === 'received' && raw.receivedIncomeId === undefined) {
    return 'expectation-received-without-link';
  }
  if (raw.resolution !== 'received' && raw.receivedIncomeId !== undefined) {
    return 'expectation-link-without-receipt';
  }
  const expectation: FinanceOneTimeExpectation = {
    id: raw.id,
    date: expectationDate,
    amountMinor: raw.amountMinor,
    title: raw.title,
    createdAt: raw.createdAt,
  };
  if (raw.resolution !== undefined) expectation.resolution = raw.resolution;
  if (raw.receivedIncomeId !== undefined) expectation.receivedIncomeId = raw.receivedIncomeId;
  if (raw.resolvedAt !== undefined) expectation.resolvedAt = raw.resolvedAt;
  if (raw.updatedAt !== undefined) expectation.updatedAt = raw.updatedAt;
  return expectation;
}


function parseObligation(raw: unknown): FinanceObligation | string {
  if (!isRecord(raw)) return 'obligation-not-object';
  if (
    !hasOnlyKeys(raw, [
      'id',
      'kind',
      'title',
      'amountMinor',
      'dueDate',
      'reminderTime',
      'reminderEnabled',
      'completed',
      'completedAt',
      'note',
      'createdAt',
      'updatedAt',
    ])
  ) {
    return 'obligation-unknown-key';
  }
  if (!isValidId(raw.id)) return 'obligation-id';
  if (
    typeof raw.kind !== 'string' ||
    !OBLIGATION_KINDS.includes(raw.kind as FinanceObligationKind)
  ) {
    return 'obligation-kind';
  }
  if (!isTitleLike(raw.title)) return 'obligation-title';
  if (!isPositiveMoney(raw.amountMinor)) return 'obligation-amount';
  let dueDateValue: string | undefined;
  if (raw.dueDate !== undefined) {
    const parsedDue = readIsoDate(raw.dueDate);
    if (parsedDue === null) return 'obligation-due-date';
    dueDateValue = parsedDue;
  }
  let reminderTimeValue: string | undefined;
  if (raw.reminderTime !== undefined) {
    const parsedTime = readWallClock(raw.reminderTime);
    if (parsedTime === null) return 'obligation-reminder-time';
    reminderTimeValue = parsedTime;
  }

  if (raw.reminderTime !== undefined && raw.dueDate === undefined) {
    return 'obligation-reminder-without-due-date';
  }
  if (typeof raw.reminderEnabled !== 'boolean') return 'obligation-reminder-enabled';
  if (raw.reminderEnabled && (raw.dueDate === undefined || raw.reminderTime === undefined)) {
    return 'obligation-reminder-incomplete';
  }
  if (typeof raw.completed !== 'boolean') return 'obligation-completed';
  if (!optionalTimestamp(raw.completedAt)) return 'obligation-completed-at';
  if (raw.completed !== true && raw.completedAt !== undefined) {
    return 'obligation-completed-at-without-completion';
  }
  if (!isOptionalString(raw.note, PERSISTED_TEXT_LIMIT)) return 'obligation-note';
  if (typeof raw.createdAt !== 'string' || !isValidIsoTimestamp(raw.createdAt)) {
    return 'obligation-created-at';
  }
  if (!optionalTimestamp(raw.updatedAt)) return 'obligation-updated-at';
  const obligation: FinanceObligation = {
    id: raw.id,
    kind: raw.kind as FinanceObligationKind,
    title: raw.title,
    amountMinor: raw.amountMinor,
    reminderEnabled: raw.reminderEnabled,
    completed: raw.completed,
    createdAt: raw.createdAt,
  };
  if (dueDateValue !== undefined) obligation.dueDate = dueDateValue;
  if (reminderTimeValue !== undefined) obligation.reminderTime = reminderTimeValue;
  if (raw.completedAt !== undefined) obligation.completedAt = raw.completedAt;
  if (raw.note !== undefined) obligation.note = raw.note;
  if (raw.updatedAt !== undefined) obligation.updatedAt = raw.updatedAt;
  return obligation;
}



function parseAllowance(raw: unknown): FinanceAllowance | string {
  if (!isRecord(raw)) return 'allowance-not-object';
  if (
    !hasOnlyKeys(raw, [
      'date',
      'mode',
      'amountMinor',
      'baseBalanceMinor',
      'horizonDate',
      'days',
      'reason',
      'revision',
      'capturedAt',
    ])
  ) {
    return 'allowance-unknown-key';
  }
  const allowanceDate = readIsoDate(raw.date);
  if (allowanceDate === null) return 'allowance-date';
  if (typeof raw.mode !== 'string' || !LIMIT_MODES.includes(raw.mode as FinanceLimitMode)) {
    return 'allowance-mode';
  }
  if (!isMoney(raw.amountMinor) || raw.amountMinor < 0) return 'allowance-amount';
  if (!isMoney(raw.baseBalanceMinor)) return 'allowance-base-balance';
  const horizonValue = raw.horizonDate === null ? null : readIsoDate(raw.horizonDate);
  if (raw.horizonDate !== null && horizonValue === null) return 'allowance-horizon';
  if (
    raw.days !== null &&
    (typeof raw.days !== 'number' || !Number.isSafeInteger(raw.days) || raw.days <= 0)
  ) {
    return 'allowance-days';
  }
  if (raw.mode === 'auto' && (raw.horizonDate === null || raw.days === null)) {
    return 'allowance-auto-without-horizon';
  }
  if (typeof raw.reason !== 'string' || !ALLOWANCE_REASONS.includes(raw.reason as never)) {
    return 'allowance-reason';
  }
  if (typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 1) {
    return 'allowance-revision';
  }
  if (typeof raw.capturedAt !== 'string' || !isValidIsoTimestamp(raw.capturedAt)) {
    return 'allowance-captured-at';
  }
  return {
    date: allowanceDate,
    mode: raw.mode as FinanceLimitMode,
    amountMinor: raw.amountMinor,
    baseBalanceMinor: raw.baseBalanceMinor,
    horizonDate: horizonValue,
    days: raw.days === null ? null : (raw.days as number),
    reason: raw.reason as FinanceAllowance['reason'],
    revision: raw.revision,
    capturedAt: raw.capturedAt,
  };
}

function parseOccurrenceResolution(raw: unknown): FinanceOccurrenceResolution | string {
  if (!isRecord(raw)) return 'resolution-not-object';
  if (
    !hasOnlyKeys(raw, ['scheduleId', 'date', 'resolution', 'receivedIncomeId', 'resolvedAt', 'updatedAt'])
  ) {
    return 'resolution-unknown-key';
  }
  if (!isValidId(raw.scheduleId)) return 'resolution-schedule-id';
  const date = readIsoDate(raw.date);
  if (date === null) return 'resolution-date';
  if (raw.resolution !== 'received' && raw.resolution !== 'skipped') return 'resolution-kind';
  if (raw.receivedIncomeId !== undefined && !isValidId(raw.receivedIncomeId)) {
    return 'resolution-received-income-id';
  }
  // Receipt/resolution consistency for monthly occurrences.
  if (raw.resolution === 'received' && raw.receivedIncomeId === undefined) {
    return 'resolution-received-without-link';
  }
  if (raw.resolution !== 'received' && raw.receivedIncomeId !== undefined) {
    return 'resolution-link-without-receipt';
  }
  const resolvedAt = readTimestamp(raw.resolvedAt);
  if (resolvedAt === null) return 'resolution-resolved-at';
  if (!optionalTimestamp(raw.updatedAt)) return 'resolution-updated-at';
  const row: FinanceOccurrenceResolution = {
    scheduleId: raw.scheduleId,
    date,
    resolution: raw.resolution,
    resolvedAt,
  };
  if (raw.receivedIncomeId !== undefined) row.receivedIncomeId = raw.receivedIncomeId;
  if (raw.updatedAt !== undefined) row.updatedAt = raw.updatedAt;
  return row;
}

function parseSettings(raw: unknown): FinanceSnapshotV1['settings'] | string {
  if (!isRecord(raw)) return 'settings-not-object';
  if (!hasOnlyKeys(raw, ['currency', 'limitMode', 'manualLimitMinor', 'fallbackEndDate'])) {
    return 'settings-unknown-key';
  }
  if (
    typeof raw.currency !== 'string' ||
    !(FINANCE_CURRENCIES as readonly string[]).includes(raw.currency)
  ) {
    return 'settings-currency';
  }
  if (
    typeof raw.limitMode !== 'string' ||
    !LIMIT_MODES.includes(raw.limitMode as FinanceLimitMode)
  ) {
    return 'settings-limit-mode';
  }
  if (
    raw.manualLimitMinor !== null &&
    (!isMoney(raw.manualLimitMinor) || raw.manualLimitMinor < 0)
  ) {
    return 'settings-manual-limit';
  }
  const fallbackValue = raw.fallbackEndDate === null ? null : readIsoDate(raw.fallbackEndDate);
  if (raw.fallbackEndDate !== null && fallbackValue === null) return 'settings-fallback-end-date';
  if (raw.limitMode === 'manual' && raw.manualLimitMinor === null) {
    return 'settings-manual-without-amount';
  }
  return {
    currency: raw.currency as FinanceCurrency,
    limitMode: raw.limitMode as FinanceLimitMode,
    manualLimitMinor: raw.manualLimitMinor,
    fallbackEndDate: fallbackValue,
  };
}

function parseMigration(raw: unknown): FinanceSnapshotV1['migration'] | string {
  if (raw === null) return null;
  if (!isRecord(raw)) return 'migration-not-object';
  if (!hasOnlyKeys(raw, ['transferId', 'appliedAt', 'source', 'changes'])) {
    return 'migration-unknown-key';
  }
  if (!isValidId(raw.transferId)) return 'migration-transfer-id';
  if (typeof raw.appliedAt !== 'string' || !isValidIsoTimestamp(raw.appliedAt)) {
    return 'migration-applied-at';
  }
  if (raw.source !== 'finance-state' && raw.source !== 'planner-finances') {
    return 'migration-source';
  }
  const changes = parseStringArray(raw.changes);
  if (changes === null) return 'migration-changes';
  return { transferId: raw.transferId, appliedAt: raw.appliedAt, source: raw.source, changes };
}

function parseCollection<T>(
  raw: unknown,
  parseRow: (row: unknown) => T | string,
  options: { identity?: (row: T) => string } = {},
): { ok: true; rows: T[] } | { ok: false; error: string } {
  // Any non-array (missing, null, object, string) is a structural violation.
  if (!Array.isArray(raw)) return { ok: false, error: 'not-array' };
  const rows: T[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const parsed = parseRow(row);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    const identity = parsed as { id?: string; date?: string };
    const key = options.identity !== undefined ? options.identity(parsed) : (identity.id ?? identity.date);
    if (key !== undefined) {
      if (seen.has(key)) return { ok: false, error: `duplicate-id:${key}` };
      seen.add(key);
    }
    rows.push(parsed);
  }
  return { ok: true, rows };
}

export function parseFinanceSnapshot(raw: string): FinanceParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'not-object' };
  if (
    !hasOnlyKeys(parsed, [
      'version',
      'initialized',
      'settings',
      'balanceMinor',
      'balanceUpdatedAt',
      'expenses',
      'incomes',
      'salarySchedules',
      'oneTimeExpectations',
      'occurrenceResolutions',
      'obligations',
      'allowances',
      'migration',
      'revision',
      'savedAt',
    ])
  ) {
    return { ok: false, error: 'unknown-key' };
  }
  if (parsed.version !== 1) return { ok: false, error: 'unknown-version' };
  if (typeof parsed.initialized !== 'boolean') return { ok: false, error: 'initialized' };
  const settings = parseSettings(parsed.settings);
  if (typeof settings === 'string') return { ok: false, error: settings };
  if (!isMoney(parsed.balanceMinor)) return { ok: false, error: 'balance' };
  // Exact runtime type only: an array/object/number is NOT a timestamp.
  let balanceUpdatedAt: string | null = null;
  if (parsed.balanceUpdatedAt !== null) {
    const read = readTimestamp(parsed.balanceUpdatedAt);
    if (read === null) return { ok: false, error: 'balance-updated-at' };
    balanceUpdatedAt = read;
  }
  if (
    typeof parsed.revision !== 'number' ||
    !Number.isSafeInteger(parsed.revision) ||
    parsed.revision < 0
  ) {
    return { ok: false, error: 'revision' };
  }
  const savedAt = readTimestamp(parsed.savedAt);
  if (savedAt === null) return { ok: false, error: 'saved-at' };
  const migration = parseMigration(parsed.migration);
  if (typeof migration === 'string') return { ok: false, error: migration };

  const expenses = parseCollection(parsed.expenses, parseExpense);
  if (!expenses.ok) return { ok: false, error: expenses.error };
  const incomes = parseCollection(parsed.incomes, parseIncome);
  if (!incomes.ok) return { ok: false, error: incomes.error };
  const schedules = parseCollection(parsed.salarySchedules, parseSchedule);
  if (!schedules.ok) return { ok: false, error: schedules.error };
  const expectations = parseCollection(parsed.oneTimeExpectations, parseExpectation);
  if (!expectations.ok) return { ok: false, error: expectations.error };
  const occurrences = parseCollection(parsed.occurrenceResolutions, parseOccurrenceResolution, {
    identity: (row: FinanceOccurrenceResolution) => `${row.scheduleId}#${row.date}`,
  });
  if (!occurrences.ok) return { ok: false, error: occurrences.error };
  const obligations = parseCollection(parsed.obligations, parseObligation);
  if (!obligations.ok) return { ok: false, error: obligations.error };
  const allowances = parseCollection(parsed.allowances, parseAllowance);
  if (!allowances.ok) return { ok: false, error: allowances.error };

  // Cross-collection reference integrity: every receipt link must exist, and no
  // income may be claimed twice (one-time expectations AND monthly occurrences).
  const incomeIds = new Set(incomes.rows.map((income) => income.id));
  const claimed = new Set<string>();
  for (const expectation of expectations.rows) {
    if (expectation.receivedIncomeId === undefined) continue;
    if (!incomeIds.has(expectation.receivedIncomeId)) {
      return { ok: false, error: 'dangling-receipt' };
    }
    if (claimed.has(expectation.receivedIncomeId)) return { ok: false, error: 'double-receipt' };
    claimed.add(expectation.receivedIncomeId);
  }
  for (const occurrence of occurrences.rows) {
    if (occurrence.receivedIncomeId === undefined) continue;
    if (!incomeIds.has(occurrence.receivedIncomeId)) {
      return { ok: false, error: 'dangling-occurrence-receipt' };
    }
    if (claimed.has(occurrence.receivedIncomeId)) return { ok: false, error: 'double-receipt' };
    claimed.add(occurrence.receivedIncomeId);
  }

  const snapshot: FinanceSnapshotV1 = {
    version: 1,
    initialized: parsed.initialized,
      settings,
      balanceMinor: parsed.balanceMinor,
      balanceUpdatedAt,
      expenses: expenses.rows,
      incomes: incomes.rows,
      salarySchedules: schedules.rows,
      oneTimeExpectations: expectations.rows,
      occurrenceResolutions: occurrences.rows,
      obligations: obligations.rows,
      allowances: allowances.rows,
    migration,
    revision: parsed.revision,
    savedAt,
  };
  // Aggregates must be safe integers BEFORE hydration publishes anything: a state
  // whose sums overflow is corrupt persisted data, not a zero.
  if (validateFinanceAggregates(snapshot) !== null) return { ok: false, error: 'aggregate-overflow' };
  return { ok: true, snapshot };
}

/** Serializes the envelope verbatim (no defaults, no dropped fields). */
export function serializeFinanceSnapshot(snapshot: FinanceSnapshotV1, savedAt: string): string {
  return JSON.stringify({ ...snapshot, version: 1, savedAt });
}

/** Empty-but-valid V1 envelope used before first setup completes. */
export function createEmptyFinanceSnapshot(
  savedAt: string,
  currency: FinanceCurrency = 'UAH',
): FinanceSnapshotV1 {
  return {
    version: 1,
    initialized: false,
    settings: {
      currency,
      limitMode: 'auto',
      manualLimitMinor: null,
      fallbackEndDate: null,
    },
    balanceMinor: 0,
    balanceUpdatedAt: null,
    expenses: [],
    incomes: [],
    salarySchedules: [],
    oneTimeExpectations: [],
    occurrenceResolutions: [],
    obligations: [],
    allowances: [],
    migration: null,
    revision: 0,
    savedAt,
  };
}
