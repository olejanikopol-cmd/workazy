import type { FinanceExpense, FinanceObligation, FinanceState, SalarySchedule } from "./types";
import { localDateIso, todayIso } from "./planner-data";

export const FINANCE_STATE_KEY = "planner-finance-state";

export const emptyFinanceState = (): FinanceState => ({
  balance: 0,
  salarySchedules: [],
  expenses: [],
  obligations: [],
});

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function normalizeFinanceState(value: unknown): FinanceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyFinanceState();
  const input = value as Partial<FinanceState>;
  return {
    balance: typeof input.balance === "number" && Number.isFinite(input.balance) && input.balance >= 0
      ? roundMoney(input.balance)
      : 0,
    salarySchedules: Array.isArray(input.salarySchedules)
      ? input.salarySchedules.filter((item): item is SalarySchedule => Boolean(
        item
        && typeof item.id === "string"
        && Number.isInteger(item.dayOfMonth)
        && item.dayOfMonth >= 1
        && item.dayOfMonth <= 31
        && typeof item.amount === "number"
        && Number.isFinite(item.amount)
        && item.amount >= 0
        && typeof item.title === "string",
      )).map((item) => ({ ...item, amount: roundMoney(item.amount) }))
      : [],
    expenses: Array.isArray(input.expenses)
      ? input.expenses.filter((item): item is FinanceExpense => Boolean(
        item
        && typeof item.id === "string"
        && typeof item.date === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(item.date)
        && typeof item.amount === "number"
        && Number.isFinite(item.amount)
        && item.amount > 0
        && typeof item.createdAt === "string",
      )).map((item) => ({ ...item, amount: roundMoney(item.amount) }))
      : [],
    obligations: Array.isArray(input.obligations)
      ? input.obligations.filter((item): item is FinanceObligation => Boolean(
        item
        && typeof item.id === "string"
        && (item.kind === "debt" || item.kind === "purchase")
        && typeof item.title === "string"
        && item.title.trim()
        && typeof item.amount === "number"
        && Number.isFinite(item.amount)
        && item.amount > 0
        && (item.dueDate === undefined || (typeof item.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)))
        && (item.reminderTime === undefined || (typeof item.reminderTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.reminderTime)))
        && typeof item.completed === "boolean"
        && typeof item.createdAt === "string"
        && typeof item.updatedAt === "string",
      )).map((item) => ({ ...item, title: item.title.trim(), amount: roundMoney(item.amount) }))
      : [],
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : undefined,
  };
}

function scheduledDate(year: number, month: number, dayOfMonth: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(dayOfMonth, lastDay), 12, 0, 0, 0);
}

export function salaryDateInMonth(schedule: SalarySchedule, year: number, month: number): string {
  return localDateIso(scheduledDate(year, month, schedule.dayOfMonth));
}

export function nextSalaryOccurrence(schedules: SalarySchedule[], fromIso = todayIso()) {
  if (!schedules.length) return null;
  const from = new Date(`${fromIso}T12:00:00`);
  const candidates = schedules.flatMap((schedule) => [0, 1].map((offset) => {
    const base = new Date(from.getFullYear(), from.getMonth() + offset, 1, 12, 0, 0, 0);
    const date = scheduledDate(base.getFullYear(), base.getMonth(), schedule.dayOfMonth);
    return { schedule, date, iso: localDateIso(date) };
  })).filter((candidate) => candidate.iso > fromIso);
  candidates.sort((a, b) => a.iso.localeCompare(b.iso));
  return candidates[0] ?? null;
}

export function daysUntil(nextIso: string | undefined, fromIso = todayIso()): number {
  if (!nextIso) return 0;
  const from = new Date(`${fromIso}T12:00:00`).getTime();
  const next = new Date(`${nextIso}T12:00:00`).getTime();
  return Math.max(0, Math.round((next - from) / 86_400_000));
}

export function dailyBudget(balance: number, nextIso: string | undefined, fromIso = todayIso()): number {
  const days = daysUntil(nextIso, fromIso);
  return days > 0 ? roundMoney(Math.max(0, balance) / days) : 0;
}

export function money(value: number): string {
  return new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 }).format(roundMoney(value));
}
