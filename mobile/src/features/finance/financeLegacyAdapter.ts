/**
 * Legacy → native Finance transfer adapter (PURE, tested; no UI/runtime transfer).
 *
 * Converts an explicitly selected legacy snapshot (web `FinanceState`, or the
 * `personal-planner-v1.finances` subtree) into a native V1 snapshot with a full
 * report. Rules from the Slice 6 brief §8:
 *
 * - Validate EVERY source row first; anything unsupported, imprecise, duplicated or
 *   malformed blocks the WHOLE conversion (no silent salvage, no dropped rows).
 * - Legacy major-unit numbers are converted by DECIMAL parsing of their canonical
 *   representation — never float multiplication; >2 decimals or binary artifacts
 *   block with a report.
 * - The legacy balance becomes `balanceMinor` as-is (imported expenses are NOT
 *   subtracted again) and imported expenses are `balancePolicy: 'legacy-history'`.
 * - Web currency is assumed UAH and the assumption is stated in the report.
 * - No receipts, incomes or allowance snapshots are invented.
 * - `debt`/`purchase` map 1:1; `receivable`/`payment` are never guessed from text.
 */
import type {
  FinanceExpense,
  FinanceObligation,
  FinanceObligationKind,
  FinanceSalarySchedule,
  FinanceSnapshotV1,
} from '@/types/finance';
import { createEmptyFinanceSnapshot, parseFinanceSnapshot, serializeFinanceSnapshot, PERSISTED_TEXT_LIMIT } from '@/storage/financeStorage';
import { isValidIsoDate, isValidIsoTimestamp } from './financeDates';
import { aggregateMinor, parseMoneyToMinor } from './financeMoney';
import { validateAggregates } from './financeModel';

export type LegacySourceKind = 'finance-state' | 'planner-finances';

export type LegacyTransferOptions = {
  source: LegacySourceKind;
  transferId: string;
  /** Accepted transfer instant (ISO). */
  nowIso: string;
};

export type LegacyTransferResult =
  | {
      ok: true;
      snapshot: FinanceSnapshotV1;
      /** Human-readable changes/assumptions applied to the source data. */
      changes: readonly string[];
      /** Stable transfer identity recorded in the envelope (idempotency key). */
      transferId: string;
      /** True when the same transfer was already applied (no double append). */
      idempotent: boolean;
    }
  | { ok: false; blockers: readonly string[]; changes: readonly string[] };

const LEGACY_KINDS: readonly FinanceObligationKind[] = [
  'payment',
  'debt',
  'receivable',
  'purchase',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Converts a legacy major-unit number to minor units by decimal parsing of its
 * canonical string form. Returns null for imprecise/unsupported values, which must
 * block the conversion (no silent rounding of legitimate source data).
 */
export function legacyMajorToMinor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const canonical = String(value);
  if (canonical.includes('e') || canonical.includes('E')) return null; // binary/exp artifact
  const parsed = parseMoneyToMinor(canonical);
  return parsed.ok ? parsed.amountMinor : null;
}

type Collected<T> = { rows: T[]; blockers: string[]; changes: string[] };

function collectExpenses(raw: unknown): Collected<FinanceExpense> {
  const blockers: string[] = [];
  const changes: string[] = [];
  const rows: FinanceExpense[] = [];
  if (!Array.isArray(raw)) {
    return { rows, blockers: ['expenses: отсутствует или не массив'], changes };
  }
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `expenses[${index}]`;
    if (!isRecord(item)) {
      blockers.push(`${where}: не объект`);
      return;
    }
    const id = item.id;
    if (typeof id !== 'string' || id.length === 0) {
      blockers.push(`${where}: отсутствует id`);
      return;
    }
    if (seen.has(id)) {
      blockers.push(`${where}: повторяющийся id ${id}`);
      return;
    }
    seen.add(id);
    if (!isValidIsoDate(String(item.date))) {
      blockers.push(`${where}: некорректная дата ${String(item.date)}`);
      return;
    }
    const amountMinor = legacyMajorToMinor(item.amount);
    if (amountMinor === null || amountMinor <= 0) {
      blockers.push(`${where}: сумма ${String(item.amount)} не представима в копейках`);
      return;
    }
    if (typeof item.createdAt !== 'string' || !isValidIsoTimestamp(item.createdAt)) {
      blockers.push(`${where}: некорректный createdAt`);
      return;
    }
    const expense: FinanceExpense = {
      id,
      date: String(item.date),
      amountMinor,
      // The legacy balance already absorbed these expenses: editing/deleting such a
      // row must not refund/debit today's balance.
      balancePolicy: 'legacy-history',
      createdAt: item.createdAt,
    };
    if (typeof item.note === 'string') expense.note = item.note;
    changes.push(`${where}: balancePolicy=legacy-history`);
    rows.push(expense);
  });
  return { rows, blockers, changes };
}
function collectSchedules(raw: unknown): Collected<FinanceSalarySchedule> {
  const blockers: string[] = [];
  const changes: string[] = [];
  const rows: FinanceSalarySchedule[] = [];
  if (!Array.isArray(raw)) {
    return { rows, blockers: ['salarySchedules: отсутствует или не массив'], changes };
  }
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `salarySchedules[${index}]`;
    if (!isRecord(item)) {
      blockers.push(`${where}: не объект`);
      return;
    }
    const id = item.id;
    if (typeof id !== 'string' || id.length === 0) {
      blockers.push(`${where}: отсутствует id`);
      return;
    }
    if (seen.has(id)) {
      blockers.push(`${where}: повторяющийся id ${id}`);
      return;
    }
    seen.add(id);
    const day = item.dayOfMonth;
    if (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 1 || day > 31) {
      blockers.push(`${where}: некорректный dayOfMonth`);
      return;
    }
    const expectedAmountMinor = legacyMajorToMinor(item.amount);
    if (expectedAmountMinor === null || expectedAmountMinor < 0) {
      blockers.push(`${where}: сумма ${String(item.amount)} не представима в копейках`);
      return;
    }
    if (typeof item.title !== 'string' || item.title.trim().length === 0) {
      blockers.push(`${where}: отсутствует title`);
      return;
    }
    if (typeof item.createdAt !== 'string' || !isValidIsoTimestamp(item.createdAt)) {
      blockers.push(`${where}: некорректный createdAt`);
      return;
    }
    const schedule: FinanceSalarySchedule = {
      id,
      dayOfMonth: day,
      expectedAmountMinor,
      title: item.title,
      // Legacy schedules are active expectations; no source label is fabricated.
      active: true,
      createdAt: item.createdAt,
    };
    if (typeof item.updatedAt === 'string' && isValidIsoTimestamp(item.updatedAt)) {
      schedule.updatedAt = item.updatedAt;
    }
    if (expectedAmountMinor === 0) {
      changes.push(`${where}: нулевая сумма сохранена без горизонта`);
    }
    rows.push(schedule);
  });
  return { rows, blockers, changes };
}
function collectObligations(raw: unknown): Collected<FinanceObligation> {
  const blockers: string[] = [];
  const changes: string[] = [];
  const rows: FinanceObligation[] = [];
  if (raw === undefined) return { rows, blockers, changes }; // optional collection
  if (!Array.isArray(raw)) return { rows, blockers: ['obligations: не массив'], changes };
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `obligations[${index}]`;
    if (!isRecord(item)) {
      blockers.push(`${where}: не объект`);
      return;
    }
    const id = item.id;
    if (typeof id !== 'string' || id.length === 0) {
      blockers.push(`${where}: отсутствует id`);
      return;
    }
    if (seen.has(id)) {
      blockers.push(`${where}: повторяющийся id ${id}`);
      return;
    }
    seen.add(id);
    // Never guess receivable/payment from text.
    const kind = item.kind;
    if (typeof kind !== 'string' || !LEGACY_KINDS.includes(kind as FinanceObligationKind)) {
      blockers.push(`${where}: неподдерживаемый kind ${String(kind)}`);
      return;
    }
    if (kind === 'receivable' || kind === 'payment') {
      blockers.push(`${where}: kind ${kind} нельзя вывести из legacy данных автоматически`);
      return;
    }
    const amountMinor = legacyMajorToMinor(item.amount);
    if (amountMinor === null || amountMinor <= 0) {
      blockers.push(`${where}: сумма ${String(item.amount)} не представима в копейках`);
      return;
    }
    if (typeof item.title !== 'string' || item.title.trim().length === 0) {
      blockers.push(`${where}: отсутствует title`);
      return;
    }
    if (typeof item.completed !== 'boolean') {
      blockers.push(`${where}: отсутствует completed`);
      return;
    }
    if (typeof item.createdAt !== 'string' || !isValidIsoTimestamp(item.createdAt)) {
      blockers.push(`${where}: некорректный createdAt`);
      return;
    }
    let dueDate: string | undefined;
    if (item.dueDate !== undefined && item.dueDate !== null && item.dueDate !== '') {
      if (!isValidIsoDate(String(item.dueDate))) {
        blockers.push(`${where}: некорректная dueDate`);
        return;
      }
      dueDate = String(item.dueDate);
    }
    let reminderTime: string | undefined;
    if (item.reminderTime !== undefined && item.reminderTime !== null && item.reminderTime !== '') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.reminderTime))) {
        blockers.push(`${where}: некорректное reminderTime`);
        return;
      }
      reminderTime = String(item.reminderTime);
    }
    if (reminderTime !== undefined && dueDate === undefined) {
      blockers.push(`${where}: reminderTime без dueDate — требуется решение`);
      return;
    }
    const obligation: FinanceObligation = {
      id,
      kind: kind as FinanceObligationKind,
      title: item.title,
      amountMinor,
      // A due date implies the legacy default 09:00 reminder intent; an already
      // completed obligation keeps its intent recorded but is not re-armed.
      reminderEnabled: dueDate !== undefined && !item.completed,
      completed: item.completed,
      createdAt: item.createdAt,
    };
    if (dueDate !== undefined) obligation.dueDate = dueDate;
    if (reminderTime !== undefined) {
      obligation.reminderTime = reminderTime;
    } else if (dueDate !== undefined) {
      // The web defaulted to a 09:00 reminder on the due date: preserve that intent
      // explicitly and record it as a migration change.
      obligation.reminderTime = '09:00';
      changes.push(`${where}: добавлено reminderTime 09:00 как legacy-интент`);
    }
    if (item.completed && dueDate !== undefined) {
      changes.push(`${where}: для выполненного обязательства напоминание не взводится`);
    }
    if (typeof item.completedAt === 'string' && isValidIsoTimestamp(item.completedAt)) {
      obligation.completedAt = item.completedAt;
    } else if (item.completed) {
      obligation.completedAt = item.createdAt;
      changes.push(`${where}: completedAt выведен из createdAt`);
    }
    if (typeof item.note === 'string') obligation.note = item.note;
    if (typeof item.updatedAt === 'string' && isValidIsoTimestamp(item.updatedAt)) {
      obligation.updatedAt = item.updatedAt;
    }
    rows.push(obligation);
  });
  return { rows, blockers, changes };
}
/**
 * Decodes the explicitly selected legacy source. Never guesses between competing
 * snapshots: `planner-finances` requires the `finances` subtree to exist.
 */
export function decodeLegacySource(
  payload: unknown,
  source: LegacySourceKind,
): { ok: true; value: Record<string, unknown> } | { ok: false; blockers: readonly string[] } {
  if (!isRecord(payload)) return { ok: false, blockers: ['источник: не объект'] };
  if (source === 'finance-state') return { ok: true, value: payload };
  const finances = payload.finances;
  if (finances === undefined) {
    return { ok: false, blockers: ['planner-finances: отсутствует personal-planner-v1.finances'] };
  }
  if (!isRecord(finances)) return { ok: false, blockers: ['planner-finances: finances не объект'] };
  return { ok: true, value: finances };
}

export type LegacyTransferInput = LegacyTransferOptions & {
  /** The (uninitialized, empty) native target this transfer would produce. */
  target: FinanceSnapshotV1;
};

/**
 * Pure legacy → native transfer. Never performs I/O: it returns the target snapshot
 * plus a report, or blockers. Slice 6A ships NO import UI and NO runtime call site
 * (see the brief §8: transfer tooling is out of scope); this adapter exists as
 * tested pure code so a future authorized transfer cannot silently corrupt data.
 */
export function transferLegacyFinance(
  payload: unknown,
  input: LegacyTransferInput,
): LegacyTransferResult {
  const { target, transferId, source, nowIso } = input;
  if (target.migration !== null && target.migration.transferId === transferId) {
    const checked = parseFinanceSnapshot(serializeFinanceSnapshot(target, target.savedAt));
    if (!checked.ok) return { ok: false, blockers: [`invalid-target:${checked.error}`], changes: [] };
    return {
      ok: true,
      snapshot: target,
      changes: target.migration.changes,
      transferId,
      idempotent: true,
    };
  }
  if (
    target.initialized ||
    target.expenses.length > 0 ||
    target.incomes.length > 0 ||
    target.salarySchedules.length > 0 ||
    target.oneTimeExpectations.length > 0 ||
    target.obligations.length > 0 ||
    target.allowances.length > 0
  ) {
    return {
      ok: false,
      blockers: ['target-not-empty: заполненная цель требует отдельного решения о слиянии'],
      changes: [],
    };
  }
  const decoded = decodeLegacySource(payload, source);
  if (!decoded.ok) return { ok: false, blockers: decoded.blockers, changes: [] };
  const value = decoded.value;

  const changes: string[] = [];
  const blockers: string[] = [];
  // Known web currency is UAH; the assumption is stated, never silent.
  changes.push('currency: legacy данные считаются UAH (предположение о валюте)');

  const balanceMinor = legacyMajorToMinor(value.balance);
  if (balanceMinor === null) {
    blockers.push(`balance: ${String(value.balance)} не представим в копейках`);
  }
  if (value.salarySchedules === undefined) blockers.push('salarySchedules: обязательная коллекция');
  if (value.expenses === undefined) blockers.push('expenses: обязательная коллекция');

  const expenses = collectExpenses(value.expenses);
  const schedules = collectSchedules(value.salarySchedules);
  const obligations = collectObligations(value.obligations);
  blockers.push(...expenses.blockers, ...schedules.blockers, ...obligations.blockers);
  changes.push(...expenses.changes, ...schedules.changes, ...obligations.changes);
  if (balanceMinor !== null) changes.push('balance: перенесён как есть (расходы повторно не вычитаются)');
  if (obligations.rows.length === 0 && value.obligations === undefined) {
    changes.push('obligations: отсутствующая коллекция принята как []');
  }
  changes.push('incomes/allowances: не изобретаются');
  if (blockers.length > 0) return { ok: false, blockers, changes };

  const legacyUpdatedAt =
    typeof value.updatedAt === 'string' && isValidIsoTimestamp(value.updatedAt)
      ? value.updatedAt
      : null;
  const snapshot: FinanceSnapshotV1 = {
    ...createEmptyFinanceSnapshot(nowIso, 'UAH'),
    initialized: true,
    expenses: expenses.rows,
    salarySchedules: schedules.rows,
    obligations: obligations.rows,
    balanceMinor: balanceMinor as number,
    // Bookkeeping timestamps are new facts, not claimed historical transaction times.
    balanceUpdatedAt: legacyUpdatedAt ?? nowIso,
    migration: { transferId, appliedAt: nowIso, source, changes },
    revision: 1,
    savedAt: nowIso,
  };
  // Imported aggregates must be safe integers too: an unsafe import is blocked
  // instead of producing an envelope the native parser would refuse.
  const totals = [
    aggregateMinor(expenses.rows.map((row) => row.amountMinor)),
    aggregateMinor(schedules.rows.map((row) => row.expectedAmountMinor)),
    aggregateMinor(obligations.rows.map((row) => row.amountMinor)),
  ];
  if (totals.some((total) => total === null)) {
    return { ok: false, blockers: ['aggregate-overflow: суммы не помещаются в безопасное целое'], changes };
  }
  const aggregateIssue = validateAggregates(snapshot);
  if (aggregateIssue !== null) {
    return { ok: false, blockers: [`aggregate:${aggregateIssue}`], changes };
  }
  for (const [collection, rows] of Object.entries({ expenses: snapshot.expenses, salarySchedules: snapshot.salarySchedules, obligations: snapshot.obligations })) {
    for (const row of rows) {
      for (const [field, text] of Object.entries(row)) {
        if ((field === 'title' || field === 'note') && typeof text === 'string' && text.length > PERSISTED_TEXT_LIMIT) {
          blockers.push(`incompatible-persisted-text:${collection}[${row.id}].${field}: maximum ${PERSISTED_TEXT_LIMIT}`);
        }
      }
    }
  }
  if (blockers.length > 0) return { ok: false, blockers, changes };
  if (legacyUpdatedAt === null) changes.push('updatedAt: отсутствовал — записан момент переноса');
  const checked = parseFinanceSnapshot(serializeFinanceSnapshot(snapshot, snapshot.savedAt));
  if (!checked.ok) return { ok: false, blockers: [`incompatible-v1:${checked.error}`], changes };
  return { ok: true, snapshot, changes, transferId, idempotent: false };
}
