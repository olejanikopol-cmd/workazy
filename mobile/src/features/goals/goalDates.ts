import { isValidIsoDate } from '@/features/plans/planDates';
import type { GoalPeriod } from '@/types/goal';

/** Device-local YYYY-MM-DD without Date.UTC or the year 0–99 constructor remap. */
export function goalLocalDate(date: Date): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function localNoon(year: number, month: number, day: number): Date {
  const value = new Date(0);
  value.setHours(12, 0, 0, 0);
  value.setFullYear(year, month, day);
  return value;
}

/** Week identity is its local Monday; month/year use their local calendar labels. */
export function goalPeriodKey(period: GoalPeriod, date: Date): string | null {
  const iso = goalLocalDate(date);
  if (!iso) return null;
  if (period === 'year') return iso.slice(0, 4);
  if (period === 'month') return iso.slice(0, 7);

  const value = localNoon(date.getFullYear(), date.getMonth(), date.getDate());
  const daysSinceMonday = (value.getDay() + 6) % 7;
  value.setDate(value.getDate() - daysSinceMonday);
  return goalLocalDate(value);
}

export function goalDefaultDeadline(period: GoalPeriod, date: Date): string | null {
  if (!goalLocalDate(date)) return null;
  if (period === 'week') {
    const start = goalPeriodKey('week', date);
    if (!start) return null;
    const [year, month, day] = start.split('-').map(Number);
    const value = localNoon(year, month - 1, day);
    value.setDate(value.getDate() + 6);
    return goalLocalDate(value);
  }
  if (period === 'month') {
    return goalLocalDate(localNoon(date.getFullYear(), date.getMonth() + 1, 0));
  }
  return `${String(date.getFullYear()).padStart(4, '0')}-12-31`;
}

export function isGoalPeriod(value: unknown): value is GoalPeriod {
  return value === 'week' || value === 'month' || value === 'year';
}

export function isGoalPeriodKey(period: GoalPeriod, key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (period === 'year') return /^\d{4}$/.test(key) && Number(key) >= 1;
  if (period === 'month') {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(key) && Number(key.slice(0, 4)) >= 1;
  }
  if (!isValidIsoDate(key)) return false;
  const [year, month, day] = key.split('-').map(Number);
  return localNoon(year, month - 1, day).getDay() === 1;
}
