/**
 * Finance sections: Обзор / Операции / Обязательства. Presentation only — every
 * action is delegated to the screen, which owns the store commands.
 */
import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import Card from '@/components/Card';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type {
  FinanceCurrency,
  FinanceExpense,
  FinanceIncome,
  FinanceObligation,
  FinanceOneTimeExpectation,
  FinanceSalarySchedule,
  FinanceSnapshotV1,
} from '@/types/finance';
import { formatFinanceDate } from './financeDates';
import { formatMoneyMinor } from './financeMoney';
import * as model from './financeModel';
import type { FinanceNotificationState } from './financeNotificationController';
import { financeReminderLabel } from './financeNotificationPresentation';
import { OBLIGATION_KIND_LABELS } from './FinanceForms';

/**
 * Minor units for display. An unsafe aggregate (which production state can never
 * reach) is surfaced as an explicit error text instead of a fake zero.
 */
export function formatMinorOrError(
  minor: number | null,
  currency: FinanceCurrency,
): string {
  return minor === null ? 'ошибка данных' : formatMoneyMinor(minor, currency);
}

export function ActionButton({
  label,
  onPress,
  tone = 'default',
}: {
  label: string;
  onPress: () => void;
  tone?: 'default' | 'success';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.button, tone === 'success' ? styles.buttonSuccess : null]}
    >
      <AppText variant="label" color={tone === 'success' ? 'success' : 'primary'}>
        {label}
      </AppText>
    </Pressable>
  );
}

function Row({
  title,
  subtitle,
  value,
  valueTone = 'primary',
  onPress,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  valueTone?: 'primary' | 'success' | 'danger' | 'muted' | 'secondary';
  onPress?: () => void;
}) {
  const content = (
    <View style={styles.row}>
      <View style={styles.rowCopy}>
        <AppText variant="body">{title}</AppText>
        {subtitle === undefined ? null : (
          <AppText variant="meta" color="muted">
            {subtitle}
          </AppText>
        )}
      </View>
      {value === undefined ? null : (
        <AppText variant="label" color={valueTone}>
          {value}
        </AppText>
      )}
    </View>
  );
  if (onPress === undefined) return content;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress}>
      {content}
    </Pressable>
  );
}

export function FinanceLimitCard({
  snapshot,
  currency,
  date,
  view,
  onChangeLimit,
}: {
  snapshot: FinanceSnapshotV1;
  currency: FinanceCurrency;
  date: string;
  view: model.DayLimitView;
  onChangeLimit: () => void;
}) {
  const savedMode = view.allowance?.mode ?? snapshot.settings.limitMode;
  const modeLabel = savedMode === 'auto' ? 'Авто' : 'Ручной';
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <AppText variant="label">Дневной лимит · {modeLabel}</AppText>
        <AppText variant="meta" color="muted">
          {formatFinanceDate(date)}
        </AppText>
      </View>
      {view.unavailable ? (
        <AppText variant="body" color="secondary">
          Лимит не зафиксирован. Укажите дату следующего дохода или ручной лимит — или задайте
          лимит на сегодня ниже.
        </AppText>
      ) : (
        <AppText variant="section">{formatMoneyMinor(view.allowance!.amountMinor, currency)}</AppText>
      )}
      <Row
        title="Потрачено сегодня"
        value={formatMinorOrError(view.spentMinor, currency)}
        valueTone="secondary"
      />
      {view.remainingMinor === null ? null : view.remainingMinor < 0 ? (
        <Row
          title="Превышение"
          value={formatMoneyMinor(view.overspendMinor ?? 0, currency)}
          valueTone="danger"
        />
      ) : (
        <Row
          title="Остаток"
          value={formatMoneyMinor(view.remainingMinor, currency)}
          valueTone="success"
        />
      )}
      <AppText variant="meta" color="muted">
        {savedMode === 'auto'
          ? 'Авто: лимит рассчитан на этот день из баланса и дней до дохода. Расходы не пересчитывают его; завтра лимит будет новым.'
          : 'Ручной: лимит сохраняется на этот день и не пересчитывается расходами.'}
      </AppText>
      <View style={styles.actionsRow}>
        <ActionButton label="Изменить лимит на сегодня" onPress={onChangeLimit} />
      </View>
    </Card>
  );
}

export function FinanceOverview({
  snapshot,
  currency,
  today,
  view,
  onChangeBalance,
  onChangeLimit,
  onChangeLimitSettings,
  onAddExpense,
  onAddIncome,
  onAddExpectation,
  onEditExpectation,
  onReceiveExpectation,
  onSkipExpectation,
  onReopenExpectation,
  onDeleteExpectation,
}: {
  snapshot: FinanceSnapshotV1;
  currency: FinanceCurrency;
  today: string;
  view: model.DayLimitView;
  onChangeBalance: () => void;
  onChangeLimit: () => void;
  onChangeLimitSettings: () => void;
  onAddExpense: () => void;
  onAddIncome: () => void;
  onAddExpectation: (kind: 'monthly' | 'oneTime') => void;
  onEditExpectation: (expectation: FinanceOneTimeExpectation) => void;
  onReceiveExpectation: (expectation: FinanceOneTimeExpectation) => void;
  onSkipExpectation: (expectation: FinanceOneTimeExpectation) => void;
  onReopenExpectation: (expectation: FinanceOneTimeExpectation) => void;
  onDeleteExpectation: (expectation: FinanceOneTimeExpectation) => void;
}) {
  const nextIncome = model.nextExpectedIncomeDate(snapshot, today);
  const nextObligation = model.nextOpenObligation(snapshot);
  // Pending/overdue actionable expectations come BEFORE future events (product rule),
  // while the AUTO horizon itself stays strictly future (see nextExpectedIncomeDate).
  const actionable = model
    .actionableMonthlyOccurrences(snapshot, today)
    .filter((row) => row.bucket !== 'future' && row.resolved === null);
  return (
    <>
      <Card style={styles.card}>
        <AppText variant="label">Доступный баланс</AppText>
        <AppText variant="pageTitle" color={snapshot.balanceMinor < 0 ? 'danger' : 'success'}>
          {formatMoneyMinor(snapshot.balanceMinor, currency)}
        </AppText>
        <AppText variant="meta" color="muted">
          Отдельно от дневного остатка. Исправление баланса не считается расходом или доходом.
        </AppText>
        <View style={styles.actionsRow}>
          <ActionButton label="Исправить баланс" onPress={onChangeBalance} />
        </View>
      </Card>

      <FinanceLimitCard
        snapshot={snapshot}
        currency={currency}
        date={today}
        view={view}
        onChangeLimit={onChangeLimit}
      />

      <View style={styles.actionsRow}>
        <ActionButton label="Добавить расход" onPress={onAddExpense} />
        <ActionButton label="Добавить доход" tone="success" onPress={onAddIncome} />
        <ActionButton label="Лимит и режим" onPress={onChangeLimitSettings} />
      </View>

      <Card style={styles.card}>
        <AppText variant="label">Ближайшие события</AppText>
        {actionable.map((row) => (
          <Row
            key={`${row.scheduleId}:${row.date}`}
            title={row.bucket === 'overdue' ? 'Просроченный доход' : 'Ожидается сегодня'}
            subtitle={`Ожидание · ${formatFinanceDate(row.date)}`}
            value={formatMoneyMinor(row.amountMinor, currency)}
          />
        ))}
        <Row
          title="Ожидаемый доход"
          subtitle={
            nextIncome === null
              ? 'Ожиданий нет — добавьте месячное или разовое ожидание'
              : 'Баланс не меняется до фактического получения'
          }
          value={nextIncome === null ? '—' : formatFinanceDate(nextIncome)}
          valueTone={nextIncome === null ? 'muted' : 'primary'}
        />
        <Row
          title="Обязательство"
          subtitle={
            nextObligation === null
              ? 'Открытых обязательств нет'
              : OBLIGATION_KIND_LABELS[nextObligation.kind]
          }
          value={
            nextObligation === null
              ? '—'
              : nextObligation.dueDate === undefined
                ? 'Без срока'
                : formatFinanceDate(nextObligation.dueDate)
          }
          valueTone={nextObligation === null ? 'muted' : 'primary'}
        />
      </Card>
    </>
  );
}

/**
 * Expected income management (Overview sheet): monthly schedules and one-time
 * expectations with receive/skip/reopen/delete. Nothing here touches the balance
 * except the explicit “Получено” receipt.
 */
export function FinanceExpectationsCard({
  snapshot,
  currency,
  today,
  onAddSchedule,
  onEditSchedule,
  onDeleteSchedule,
  onAddExpectation,
  onEditExpectation,
  onReceiveExpectation,
  onSkipExpectation,
  onReopenExpectation,
  onDeleteExpectation,
  onReceiveOccurrence,
  onSkipOccurrence,
  onReopenOccurrence,
}: {
  snapshot: FinanceSnapshotV1;
  currency: FinanceCurrency;
  today: string;
  onReceiveOccurrence: (occurrence: {
    scheduleId: string;
    date: string;
    title: string;
    amountMinor: number;
  }) => void;
  onSkipOccurrence: (occurrence: { scheduleId: string; date: string }) => void;
  onReopenOccurrence: (occurrence: { scheduleId: string; date: string }) => void;
  onAddSchedule: () => void;
  onEditSchedule: (schedule: FinanceSalarySchedule) => void;
  onDeleteSchedule: (schedule: FinanceSalarySchedule) => void;
  onAddExpectation: () => void;
  onEditExpectation: (expectation: FinanceOneTimeExpectation) => void;
  onReceiveExpectation: (expectation: FinanceOneTimeExpectation) => void;
  onSkipExpectation: (expectation: FinanceOneTimeExpectation) => void;
  onReopenExpectation: (expectation: FinanceOneTimeExpectation) => void;
  onDeleteExpectation: (expectation: FinanceOneTimeExpectation) => void;
}) {
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <AppText variant="label">Ожидаемые доходы</AppText>
        <View style={styles.actionsRow}>
          <Pressable accessibilityRole="button" onPress={onAddSchedule}>
            <AppText variant="label" color="accent">
              + месяц
            </AppText>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onAddExpectation}>
            <AppText variant="label" color="accent">
              + разовое
            </AppText>
          </Pressable>
        </View>
      </View>
      {snapshot.salarySchedules.length === 0 && snapshot.oneTimeExpectations.length === 0 ? (
        <AppText variant="meta" color="muted">
          Ожидания не меняют баланс. Баланс изменится только после нажатия «Получено».
        </AppText>
      ) : null}
      {snapshot.salarySchedules.map((schedule) => {
        // The nearest unresolved/skipped occurrence is actionable per occurrence key.
        // Actionable receipt targets per schedule, in product order: overdue
        // unresolved, TODAY unresolved, then the next future occurrence. A monthly
        // occurrence due today is never skipped in favour of next month.
        const rows = schedule.active
          ? model
              .actionableMonthlyOccurrences(snapshot, today)
              .filter((row) => row.scheduleId === schedule.id)
          : [];
        return (
          <View key={schedule.id} style={styles.entry}>
            <Row
              title={schedule.title}
              subtitle={
                schedule.active
                  ? `Каждый месяц · ${schedule.dayOfMonth} числа`
                  : `Каждый месяц · ${schedule.dayOfMonth} числа · пауза`
              }
              value={formatMoneyMinor(schedule.expectedAmountMinor, currency)}
              valueTone={schedule.active ? 'secondary' : 'muted'}
              onPress={() => onEditSchedule(schedule)}
            />
            {rows.map((occurrence) => {
              const label =
                occurrence.bucket === 'overdue'
                  ? 'Просрочено'
                  : occurrence.bucket === 'today'
                    ? 'Сегодня'
                    : 'Далее';
              const resolvedLabel =
                occurrence.resolved === null
                  ? label
                  : occurrence.resolved.resolution === 'received'
                    ? `${label} · получено`
                    : `${label} · пропущено`;
              return (
                <View key={`${occurrence.scheduleId}:${occurrence.date}`} style={styles.entry}>
                  <AppText variant="meta" color="muted">
                    {resolvedLabel} · {formatFinanceDate(occurrence.date)} ·{' '}
                    {formatMoneyMinor(occurrence.amountMinor, currency)}
                  </AppText>
                  <View style={styles.actionsRow}>
                    {occurrence.resolved === null ? (
                      <>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() =>
                            onReceiveOccurrence({
                              scheduleId: occurrence.scheduleId,
                              date: occurrence.date,
                              title: occurrence.title,
                              amountMinor: occurrence.amountMinor,
                            })
                          }
                        >
                          <AppText variant="meta" color="success">
                            Получено
                          </AppText>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() =>
                            onSkipOccurrence({
                              scheduleId: occurrence.scheduleId,
                              date: occurrence.date,
                            })
                          }
                        >
                          <AppText variant="meta" color="muted">
                            Пропустить
                          </AppText>
                        </Pressable>
                      </>
                    ) : occurrence.resolved?.resolution === 'skipped' ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() =>
                          onReopenOccurrence({
                            scheduleId: occurrence.scheduleId,
                            date: occurrence.date,
                          })
                        }
                      >
                        <AppText variant="meta" color="accent">
                          Вернуть ожидание
                        </AppText>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })}
            <View style={styles.actionsRow}>
              <Pressable accessibilityRole="button" onPress={() => onDeleteSchedule(schedule)}>
                <AppText variant="meta" color="muted">
                  Удалить ожидание (чеки останутся)
                </AppText>
              </Pressable>
            </View>
          </View>
        );
      })}
      {snapshot.oneTimeExpectations.map((expectation) => {
        const resolved = expectation.resolution;
        return (
          <View key={expectation.id} style={styles.entry}>
            <Row
              title={expectation.title}
              subtitle={
                resolved === 'received'
                  ? 'Получено (изменение — через доход)'
                  : resolved === 'skipped'
                    ? 'Пропущено'
                    : `Ожидается · ${formatFinanceDate(expectation.date)}`
              }
              value={formatMoneyMinor(expectation.amountMinor, currency)}
              valueTone={resolved === undefined ? 'secondary' : 'muted'}
              onPress={() => onEditExpectation(expectation)}
            />
            <View style={styles.actionsRow}>
              {resolved === undefined ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onReceiveExpectation(expectation)}
                  >
                    <AppText variant="meta" color="success">
                      Получено
                    </AppText>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onSkipExpectation(expectation)}
                  >
                    <AppText variant="meta" color="muted">
                      Пропустить
                    </AppText>
                  </Pressable>
                </>
              ) : resolved === 'skipped' ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onReopenExpectation(expectation)}
                >
                  <AppText variant="meta" color="accent">
                    Вернуть ожидание
                  </AppText>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => onDeleteExpectation(expectation)}
              >
                <AppText variant="meta" color="muted">
                  Удалить ожидание
                </AppText>
              </Pressable>
            </View>
          </View>
        );
      })}
    </Card>
  );
}

export function FinanceOperations({
  snapshot,
  currency,
  selectedDate,
  filter,
  onFilter,
  onClearFilter,
  onAddExpense,
  onAddIncome,
  onEdit,
  onDelete,
}: {
  snapshot: FinanceSnapshotV1;
  currency: FinanceCurrency;
  selectedDate: string;
  filter: 'all' | 'expense' | 'income';
  onFilter: (next: 'all' | 'expense' | 'income') => void;
  onClearFilter: () => void;
  onAddExpense: () => void;
  onAddIncome: () => void;
  onEdit: (expense: FinanceExpense | null, income: FinanceIncome | null) => void;
  onDelete: (expense: FinanceExpense | null, income: FinanceIncome | null) => void;
}) {
  const expenses =
    filter === 'income' ? [] : snapshot.expenses.filter((row) => row.date === selectedDate);
  const incomes =
    filter === 'expense' ? [] : snapshot.incomes.filter((row) => row.date === selectedDate);
  const rows = [
    ...expenses.map((expense) => ({ kind: 'expense' as const, expense, income: null })),
    ...incomes.map((income) => ({ kind: 'income' as const, expense: null, income })),
  ].sort((a, b) => {
    const left = a.expense?.createdAt ?? a.income?.createdAt ?? '';
    const right = b.expense?.createdAt ?? b.income?.createdAt ?? '';
    if (left !== right) return left < right ? 1 : -1;
    const leftId = a.expense?.id ?? a.income?.id ?? '';
    const rightId = b.expense?.id ?? b.income?.id ?? '';
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const totals = model.dayTotals(snapshot, selectedDate);
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <AppText variant="label">{formatFinanceDate(selectedDate)}</AppText>
        <Pressable accessibilityRole="button" onPress={onClearFilter}>
          <AppText variant="meta" color="accent">
            Все дни
          </AppText>
        </Pressable>
      </View>
      <AppText variant="meta" color="muted">
        Расходы {formatMinorOrError(totals.expenseMinor, currency)} · Доходы{' '}
        {formatMinorOrError(totals.incomeMinor, currency)}
      </AppText>
      <View style={styles.actionsRow}>
        {(['all', 'expense', 'income'] as const).map((value) => (
          <Pressable key={value} accessibilityRole="button" onPress={() => onFilter(value)}>
            <AppText variant="meta" color={filter === value ? 'accent' : 'muted'}>
              {value === 'all' ? 'Все' : value === 'expense' ? 'Расходы' : 'Доходы'}
            </AppText>
          </Pressable>
        ))}
      </View>
      <View style={styles.actionsRow}>
        <ActionButton label="Расход" onPress={onAddExpense} />
        <ActionButton label="Доход" tone="success" onPress={onAddIncome} />
      </View>
      {rows.length === 0 ? (
        <AppText variant="meta" color="muted">
          За этот день фактических операций нет.
        </AppText>
      ) : null}
      {rows.map((row) => (
        <View key={row.expense?.id ?? row.income?.id} style={styles.entry}>
          <Row
            title={
              row.kind === 'expense'
                ? (row.expense?.category ?? row.expense?.note ?? 'Расход')
                : (row.income?.source ?? row.income?.note ?? 'Доход')
            }
            subtitle={
              row.kind === 'expense'
                ? row.expense?.balancePolicy === 'legacy-history'
                  ? 'Историческая запись · баланс не меняется'
                  : 'Расход'
                : 'Доход'
            }
            value={formatMoneyMinor(
              (row.expense?.amountMinor ?? row.income?.amountMinor ?? 0) *
                (row.kind === 'expense' ? -1 : 1),
              currency,
            )}
            valueTone={row.kind === 'expense' ? 'danger' : 'success'}
            onPress={() => onEdit(row.expense, row.income)}
          />
          <Pressable accessibilityRole="button" onPress={() => onDelete(row.expense, row.income)}>
            <AppText variant="meta" color="muted">
              Удалить
            </AppText>
          </Pressable>
        </View>
      ))}
    </Card>
  );
}

export function FinanceObligations({
  snapshot,
  currency,
  showCompleted,
  onToggleList,
  onAdd,
  onEdit,
  onToggleCompleted,
  onDelete,
  notifications,
}: {
  snapshot: FinanceSnapshotV1;
  notifications: FinanceNotificationState;
  currency: FinanceCurrency;
  showCompleted: boolean;
  onToggleList: () => void;
  onAdd: () => void;
  onEdit: (obligation: FinanceObligation) => void;
  onToggleCompleted: (obligation: FinanceObligation) => void;
  onDelete: (obligation: FinanceObligation) => void;
}) {
  const open = snapshot.obligations
    .filter((row) => !row.completed)
    .sort((a, b) => {
      if (a.dueDate === undefined && b.dueDate === undefined) return a.id < b.id ? -1 : 1;
      if (a.dueDate === undefined) return 1;
      if (b.dueDate === undefined) return -1;
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  const rows = showCompleted
    ? snapshot.obligations.filter((row) => row.completed)
    : open;
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <AppText variant="label">{showCompleted ? 'Выполненные' : 'Открытые'}</AppText>
        <Pressable accessibilityRole="button" onPress={onToggleList}>
          <AppText variant="meta" color="accent">
            {showCompleted ? 'Показать открытые' : 'Показать выполненные'}
          </AppText>
        </Pressable>
      </View>
      <AppText variant="meta" color="muted">
        Обязательства не меняют баланс. Фактический расход или доход оформляется отдельно.
      </AppText>
      <ActionButton label="Добавить обязательство" onPress={onAdd} />
      {rows.length === 0 ? (
        <AppText variant="meta" color="muted">
          {showCompleted ? 'Выполненных обязательств нет.' : 'Открытых обязательств нет.'}
        </AppText>
      ) : null}
      {rows.map((obligation) => (
        <View key={obligation.id} style={styles.entry}>
          <Row
            title={obligation.title}
            subtitle={[
              OBLIGATION_KIND_LABELS[obligation.kind],
              obligation.dueDate === undefined ? null : formatFinanceDate(obligation.dueDate),
              financeReminderLabel(obligation, snapshot.revision, notifications),
            ]
              .filter((part) => part !== null)
              .join(' · ')}
            value={formatMoneyMinor(obligation.amountMinor, currency)}
            onPress={() => onEdit(obligation)}
          />
          <View style={styles.actionsRow}>
            <Pressable accessibilityRole="button" onPress={() => onToggleCompleted(obligation)}>
              <AppText variant="meta" color="success">
                {obligation.completed ? 'Вернуть в работу' : 'Отметить выполненным'}
              </AppText>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => onDelete(obligation)}>
              <AppText variant="meta" color="muted">
                Удалить
              </AppText>
            </Pressable>
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  rowCopy: { flex: 1, gap: 2 },
  entry: { gap: spacing.xs },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  button: {
    minHeight: touchTarget,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.segment,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSuccess: { borderColor: colors.successBorder },
});
