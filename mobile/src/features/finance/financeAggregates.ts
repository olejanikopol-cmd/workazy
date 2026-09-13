/**
 * Money-aggregate validation shared by the MODEL, the STORE (before any write) and
 * the STORAGE PARSER (before publishing hydrated state).
 *
 * Every checked aggregate — balance, totals, per-date totals and stored allowance
 * math — must remain a safe integer. This module is pure and dependency-light so
 * both the persistence layer and the domain can use the SAME predicate: an unsafe
 * aggregate is an error, never clamped and never converted to zero.
 */
import type { FinanceSnapshotV1 } from '@/types/finance';
import { addMinor, aggregateMinor, isSafeMinor } from './financeMoney';

export type AggregateIssue = 'overflow';

/** Returns the issue found in the snapshot aggregates, or null when all are safe. */
export function validateFinanceAggregates(snapshot: FinanceSnapshotV1): AggregateIssue | null {
  if (!isSafeMinor(snapshot.balanceMinor)) return 'overflow';
  if (aggregateMinor(snapshot.expenses.map((row) => row.amountMinor)) === null) return 'overflow';
  if (aggregateMinor(snapshot.incomes.map((row) => row.amountMinor)) === null) return 'overflow';
  if (aggregateMinor(snapshot.obligations.map((row) => row.amountMinor)) === null) return 'overflow';
  if (aggregateMinor(snapshot.oneTimeExpectations.map((row) => row.amountMinor)) === null) {
    return 'overflow';
  }
  if (aggregateMinor(snapshot.salarySchedules.map((row) => row.expectedAmountMinor)) === null) {
    return 'overflow';
  }
  const perDateExpense = new Map<string, number>();
  for (const row of snapshot.expenses) {
    const next = addMinor(perDateExpense.get(row.date) ?? 0, row.amountMinor);
    if (next === null) return 'overflow';
    perDateExpense.set(row.date, next);
  }
  const perDateIncome = new Map<string, number>();
  for (const row of snapshot.incomes) {
    const next = addMinor(perDateIncome.get(row.date) ?? 0, row.amountMinor);
    if (next === null) return 'overflow';
    perDateIncome.set(row.date, next);
  }
  for (const row of snapshot.allowances) {
    if (!isSafeMinor(row.amountMinor) || row.amountMinor < 0) return 'overflow';
    if (!isSafeMinor(row.baseBalanceMinor)) return 'overflow';
  }
  return null;
}
