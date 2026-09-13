/**
 * Compact Finance month calendar: a view into Finance data only (actual
 * expense/income activity, unresolved expected income and obligation due markers),
 * with the saved allowance shown for the selected day when it exists. It never
 * creates Calendar events and never presents a forecast as historical fact.
 */
import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { FinanceSnapshotV1 } from '@/types/finance';
import { monthRange } from './financeDates';
import * as model from './financeModel';

const MONTH_TITLES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;

function monthTitle(key: string): string {
  return `${MONTH_TITLES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

/** Day cells for a `YYYY-MM` key, including leading blanks (Monday-first grid). */
function dayCells(key: string): (string | null)[] {
  const range = monthRange(key);
  if (range === null) return [];
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const first = new Date(0);
  first.setFullYear(year, month - 1, 1);
  first.setHours(12, 0, 0, 0);
  const offset = (first.getDay() + 6) % 7;
  const days = Number(range.last.slice(8, 10));
  const cells: (string | null)[] = [];
  for (let index = 0; index < offset; index += 1) cells.push(null);
  for (let day = 1; day <= days; day += 1) {
    cells.push(`${key}-${String(day).padStart(2, '0')}`);
  }
  return cells;
}

export default function FinanceCalendar({
  snapshot,
  monthKey,
  selectedDate,
  today,
  onSelect,
  onMonthChange,
}: {
  snapshot: FinanceSnapshotV1;
  monthKey: string;
  selectedDate: string;
  today: string;
  onSelect: (date: string) => void;
  onMonthChange: (nextMonthKey: string) => void;
}) {
  const cells = dayCells(monthKey);
  const totals = model.monthTotals(snapshot, monthKey);
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Предыдущий месяц"
          onPress={() => onMonthChange(shift(monthKey, -1))}
          style={styles.monthButton}
        >
          <AppText variant="label" color="accent">
            ‹
          </AppText>
        </Pressable>
        <View style={styles.headerCopy}>
          <AppText variant="label">{monthTitle(monthKey)}</AppText>
          <AppText variant="meta" color="muted">
            Расходы {formatShort(totals.expenseMinor)} · Доходы {formatShort(totals.incomeMinor)}
          </AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Следующий месяц"
          onPress={() => onMonthChange(shift(monthKey, 1))}
          style={styles.monthButton}
        >
          <AppText variant="label" color="accent">
            ›
          </AppText>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {cells.map((date, index) => {
          if (date === null) return <View key={`blank-${index}`} style={styles.cell} />;
          const totalsForDay = model.dayTotals(snapshot, date);
          const expectations = model.unresolvedExpectationsOn(snapshot, date).length;
          // Monthly expected income occurrences are a Finance projection too.
          const monthlyExpectations = model.unresolvedMonthlyOccurrencesOn(snapshot, date).length;
          const due = model.openObligationsOn(snapshot, date).length;
          const allowance = model.allowanceFor(snapshot, date);
          const selected = date === selectedDate;
          return (
            <Pressable
              key={date}
              accessibilityRole="button"
              accessibilityLabel={date}
              accessibilityState={{ selected }}
              onPress={() => onSelect(date)}
              style={[styles.cell, selected ? styles.cellSelected : null]}
            >
              <AppText variant="meta" color={date === today ? 'accent' : 'primary'}>
                {Number(date.slice(8, 10))}
              </AppText>
              <View style={styles.markers}>
                {(totalsForDay.expenseMinor ?? 0) > 0 ? <View style={styles.dotExpense} /> : null}
                {(totalsForDay.incomeMinor ?? 0) > 0 ? <View style={styles.dotIncome} /> : null}
                {expectations + monthlyExpectations > 0 ? (
                  <View style={styles.dotExpectation} />
                ) : null}
                {due > 0 ? <View style={styles.dotDue} /> : null}
                {allowance !== null ? <View style={styles.dotAllowance} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function shift(key: string, delta: number): string {
  const total = Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** Whole-unit label; `null` marks an unsafe aggregate instead of a fake zero. */
function formatShort(minor: number | null): string {
  if (minor === null) return '—';
  const whole = Math.trunc(minor / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `₴${whole}`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.card,
    padding: spacing.md,
    gap: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerCopy: { alignItems: 'center', flex: 1 },
  monthButton: {
    minWidth: touchTarget,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: radius.item,
  },
  cellSelected: { backgroundColor: colors.surfaceSelected },
  markers: { flexDirection: 'row', gap: 3 },
  dotExpense: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.danger },
  dotIncome: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.success },
  dotExpectation: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
  dotDue: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.textSecondary },
  dotAllowance: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong },
});
