/**
 * Finance tab (Slice 6A): ONE bottom tab with three internal sections —
 * Обзор / Операции / Обязательства. All state comes from the native Finance store;
 * every command is revision-guarded and persists before it commits.
 *
 * Notification status is independent from Finance persistence and sheet submissions.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { useFinanceNotifications, financeNotificationController } from './useFinanceNotifications';
import FinanceNotificationStatus from './FinanceNotificationStatus';
import { financeNotificationNavigation } from '@/services/notifications/financeNotificationNavigation';
import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import Screen from '@/components/Screen';
import SegmentedControl from '@/components/SegmentedControl';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type {
  FinanceExpense,
  FinanceIncome,
  FinanceObligation,
  FinanceOneTimeExpectation,
  FinanceSalarySchedule,
} from '@/types/finance';
import { createSheetRegistry, type SheetInstance } from './financeDay';
import { localDateIso } from './financeDates';
import { useFinanceToday } from './useFinanceDay';
import * as model from './financeModel';
import FinanceCalendar from './FinanceCalendar';
import {
  FinanceBalanceSheet,
  FinanceExpectationSheet,
  FinanceExpenseSheet,
  FinanceIncomeSheet,
  FinanceLimitSheet,
  FinanceLimitSettingsSheet,
  FinanceObligationSheet,
  FinanceReceiveSheet,
  FinanceSetupSheet,
  type SheetOutcome,
} from './FinanceSheets';
import {
  FinanceExpectationsCard,
  FinanceObligations,
  FinanceOperations,
  FinanceOverview,
} from './FinanceSections';
import { financeStore, useFinanceStore } from './useFinanceStore';

type Segment = 'overview' | 'operations' | 'obligations';

type SheetState =
  | { kind: 'none' }
  | { kind: 'expense-create' }
  | { kind: 'expense-edit'; expense: FinanceExpense }
  | { kind: 'income-create' }
  | { kind: 'income-edit'; income: FinanceIncome }
  | { kind: 'balance' }
  | { kind: 'limit' }
  | { kind: 'limit-settings' }
  | { kind: 'receive-monthly'; scheduleId: string; date: string; title: string; amountMinor: number }
  | { kind: 'obligation-create' }
  | { kind: 'obligation-edit'; obligation: FinanceObligation }
  | { kind: 'expectation-create' }
  | { kind: 'expectation-edit'; expectation: FinanceOneTimeExpectation }
  | { kind: 'schedule-create' }
  | { kind: 'schedule-edit'; schedule: FinanceSalarySchedule }
  | { kind: 'receive'; expectation: FinanceOneTimeExpectation };

const REASON_TEXT: Record<string, string> = {
  busy: 'Сохранение уже идёт — повторите через мгновение.',
  storage: 'Не удалось сохранить изменения. Проверьте устройство и повторите попытку.',
  stale: 'Данные изменились. Обновите экран и повторите.',
  'load-error': 'Сохранённые данные повреждены. Они не изменяются — повторите позже.',
  validation: 'Проверьте заполненные поля.',
  'not-initialized': 'Сначала завершите настройку финансов.',
  'future-date': 'Фактическая операция не может быть в будущем.',
  'already-received': 'Это ожидание уже получено. Проверьте связанный доход.',
  'receipt-linked': 'Связанный доход нельзя изменить здесь. Измените сам доход.',
  missing: 'Запись не найдена — возможно, она уже удалена.',
  'unsafe-amount': 'Слишком большая сумма.',
  'no-allowance': 'Лимит на этот день ещё не зафиксирован.',
};

export default function FinanceScreen() {
  const state = useFinanceStore();
  const notifications = useFinanceNotifications();
  const notificationIntent = useSyncExternalStore(financeNotificationNavigation.subscribe, financeNotificationNavigation.getSnapshot);
  useFocusEffect(useCallback(() => { void financeNotificationController.request(); }, []));
  const snapshot = state.snapshot;
  const { today, refresh: refreshDay } = useFinanceToday();
  const [segment, setSegment] = useState<Segment>('overview');
  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' });
  const [sheetInstance, setSheetInstance] = useState<SheetInstance | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => today);
  const [monthKey, setMonthKey] = useState(() => today.slice(0, 7));
  const [filter, setFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [showCompleted, setShowCompleted] = useState(false);
  const busy = state.saving;
  const revision = snapshot.revision;
  const currency = snapshot.settings.currency;
  // One identity registry: a late async save can only close ITS OWN sheet instance.
  const registryRef = useRef(createSheetRegistry());
  const previousToday = useRef(today);
  // The revision/identity the OPEN sheet was created with (never a later render).
  const activeRevision = sheetInstance?.revision ?? revision;
  const activeInstance = sheetInstance?.instanceId ?? -1;

  /** Opens a sheet and records the revision/entity it must submit against. */
  function openSheet(next: SheetState, entityId: string | null = null) {
    const instance = registryRef.current.open(entityId, snapshot.revision);
    setSheetInstance(instance);
    setBanner(null);
    setSheet(next);
  }

  useEffect(() => {
    // Midnight/foreground: only a selection that still pointed at the OLD today follows.
    const previous = previousToday.current;
    if (previous === today) return;
    previousToday.current = today;
    setSelectedDate((current) => (current === previous ? today : current));
    setMonthKey((current) => (current === previous.slice(0, 7) ? today.slice(0, 7) : current));
  }, [today]);

  useEffect(() => {
    void financeStore.load();
  }, []);

  useEffect(() => {
    // Consume external navigation after this render; never replace an open draft.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !notificationIntent || state.phase !== 'ready' || sheet.kind !== 'none') return;
      const target = snapshot.obligations.find((row) => row.id === notificationIntent.obligationId);
      setSegment('obligations');
      setShowCompleted(target?.completed ?? false);
      if (target) {
        const instance = registryRef.current.open(target.id, snapshot.revision);
        setSheetInstance(instance);
        setSheet({ kind: 'obligation-edit', obligation: target });
      }
      financeNotificationNavigation.clear(notificationIntent.token);
    });
    return () => { cancelled = true; };
  }, [notificationIntent, state.phase, snapshot.obligations, snapshot.revision, sheet.kind]);

  // Day establishment: every Finance focus samples the local clock and a missing
  // snapshot is written from the committed state BEFORE the limit is shown.
  useEffect(() => {
    if (state.phase !== 'ready' || !snapshot.initialized || sheet.kind !== 'none' || notificationIntent) return;
    if (today !== localDateIso(new Date())) { refreshDay(); return; }
    void financeStore.ensureDay(today);
  }, [state.phase, snapshot.initialized, snapshot.revision, today, sheet.kind, refreshDay, notificationIntent]);

  /**
  "   * Async completion of ONE sheet instance: a newer sheet stays open and untouched,
  "   * a failed save keeps the draft open with an honest message, and a stale submit is
  "   * never applied to a newer entity/revision.
  "   */
  const finish = useCallback(
    (instanceId: number, result: { ok: boolean; reason?: string }): SheetOutcome => {
      if (!registryRef.current.isCurrent(instanceId) && instanceId !== -1) {
        return result.ok ? { ok: true } : { ok: false, message: REASON_TEXT[result.reason ?? ''] ?? 'Не удалось сохранить.' };
      }
      if (result.ok) {
        if (registryRef.current.close(instanceId)) {
          setSheetInstance(null);
          setSheet({ kind: 'none' });
        }
        setBanner(null);
        return { ok: true };
      }
      const message = REASON_TEXT[result.reason ?? ''] ?? 'Не удалось выполнить действие.';
      setBanner(message);
      return { ok: false, message };
    },
    [],
  );

  /** Setup has no entity/revision identity, so it closes directly. */
  const finishSetup = useCallback((result: { ok: boolean; reason?: string }): SheetOutcome => {
    if (result.ok) return { ok: true };
    const message = REASON_TEXT[result.reason ?? ''] ?? 'Не удалось выполнить действие.';
    setBanner(message);
    return { ok: false, message };
  }, []);

  /** Completion bound to the OPEN sheet instance (identity-guarded). */
  const finishActive = useCallback(
    (result: { ok: boolean; reason?: string }): SheetOutcome => finish(activeInstance, result),
    [finish, activeInstance],
  );

  const closeSheet = useCallback(() => {
    registryRef.current.closeCurrent();
    setSheetInstance(null);
    setSheet({ kind: 'none' });
  }, []);
  const limitView = useMemo(() => model.dayLimitView(snapshot, today), [snapshot, today]);
  const nextLimits = useMemo(() => {
    const horizon = model.allowanceHorizon(snapshot, today);
    return horizon === null ? null : horizon.days;
  }, [snapshot, today]);

  if (state.phase === 'loading') {
    return (
      <Screen contentContainerStyle={styles.content}>
        <AppText variant="pageTitle">Финансы</AppText>
        <AppText variant="meta" color="muted">
          Загружаем данные…
        </AppText>
      </Screen>
    );
  }

  if (state.phase === 'load-error') {
    return (
      <Screen contentContainerStyle={styles.content}>
        <AppText variant="pageTitle">Финансы</AppText>
        <AppText variant="body" color="danger">
          {state.error}
        </AppText>
        <AppText variant="meta" color="muted">
          Данные не изменяются и не удаляются: повторите попытку позже.
        </AppText>
        <Pressable
          accessibilityRole="button"
          onPress={() => void financeStore.retryLoad()}
          style={styles.primaryButton}
        >
          <AppText variant="label">Повторить</AppText>
        </Pressable>
      </Screen>
    );
  }

  if (!snapshot.initialized) {
    return (
      <Screen scroll contentContainerStyle={styles.content}>
        <AppText variant="pageTitle">Финансы</AppText>
        <AppText variant="body" color="secondary">
          Настройте валюту и текущий баланс. Дальше: фиксированный дневной лимит, расходы, доходы и
          обязательства — локально, без облака.
        </AppText>
        {banner === null ? null : (
          <AppText variant="meta" color="danger">
            {banner}
          </AppText>
        )}
        <FinanceSetupSheet
          busy={busy}
          onCancel={() => setBanner(null)}
          onSubmit={async (input) =>
            finishSetup(
              await financeStore.setup({
                currency: input.currency,
                balanceMinor: input.balanceMinor,
                limitMode: input.limitMode,
                manualLimitMinor: input.manualLimitMinor,
                fallbackEndDate: input.fallbackEndDate,
                clock: { nowIso: new Date().toISOString(), today },
              }),
            )
          }
        />
      </Screen>
    );
  }

  return (
    <Screen scroll contentContainerStyle={styles.content}>
      <AppText variant="pageTitle">Финансы</AppText>
      {banner === null && state.error === null ? null : (
        <View style={styles.banner}>
          <AppText variant="meta" color="danger">
            {banner ?? state.error}
          </AppText>
        </View>
      )}
      <FinanceNotificationStatus state={notifications} />
      <SegmentedControl
        items={[
          { value: 'overview', label: 'Обзор' },
          { value: 'operations', label: 'Операции' },
          { value: 'obligations', label: 'Обязательства' },
        ]}
        value={segment}
        onChange={setSegment}
      />

      {segment === 'overview' ? (
        <>
          <FinanceOverview
            snapshot={snapshot}
            currency={currency}
            today={today}
            view={limitView}
            onChangeBalance={() => openSheet({ kind: 'balance' })}
            onChangeLimit={() => openSheet({ kind: 'limit' })}
            onChangeLimitSettings={() => openSheet({ kind: 'limit-settings' })}
            onAddExpense={() => openSheet({ kind: 'expense-create' })}
            onAddIncome={() => openSheet({ kind: 'income-create' })}
            onAddExpectation={(kind) =>
              openSheet({ kind: kind === 'monthly' ? 'schedule-create' : 'expectation-create' })
            }
            onEditExpectation={(expectation) => openSheet({ kind: 'expectation-edit', expectation })}
            onReceiveExpectation={(expectation) => openSheet({ kind: 'receive', expectation })}
            onSkipExpectation={(expectation) =>
              void financeStore
                .skipExpectation({ id: expectation.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
            onReopenExpectation={(expectation) =>
              void financeStore
                .reopenExpectation({ id: expectation.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
            onDeleteExpectation={(expectation) =>
              void financeStore
                .deleteExpectation({ id: expectation.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
          />
          <FinanceExpectationsCard
            snapshot={snapshot}
            currency={currency}
            onAddSchedule={() => openSheet({ kind: 'schedule-create' })}
            onEditSchedule={(schedule) => openSheet({ kind: 'schedule-edit', schedule })}
            onDeleteSchedule={(schedule) =>
              void financeStore
                .deleteSchedule({ id: schedule.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
            onAddExpectation={() => openSheet({ kind: 'expectation-create' })}
            onEditExpectation={(expectation) => openSheet({ kind: 'expectation-edit', expectation })}
            onReceiveExpectation={(expectation) => openSheet({ kind: 'receive', expectation })}
            onSkipExpectation={(expectation) =>
              void financeStore
                .skipExpectation({ id: expectation.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
            onReopenExpectation={(expectation) =>
              void financeStore
                .reopenExpectation({ id: expectation.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
            onDeleteExpectation={(expectation) =>
              void financeStore
                .deleteExpectation({ id: expectation.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
            today={today}
            onReceiveOccurrence={(occurrence) =>
              openSheet({
                kind: 'receive-monthly',
                scheduleId: occurrence.scheduleId,
                date: occurrence.date,
                title: occurrence.title,
                amountMinor: occurrence.amountMinor,
              })
            }
            onSkipOccurrence={(occurrence) =>
              void financeStore
                .skipMonthlyOccurrence({ ...occurrence, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
            onReopenOccurrence={(occurrence) =>
              void financeStore
                .reopenMonthlyOccurrence({ ...occurrence, expectedRevision: revision })
                .then((result) => finish(activeInstance, result))
            }
          />
          <FinanceCalendar
            snapshot={snapshot}
            monthKey={monthKey}
            selectedDate={selectedDate}
            today={today}
            onSelect={(date) => {
              setSelectedDate(date);
              setMonthKey(date.slice(0, 7));
            }}
            onMonthChange={setMonthKey}
          />
        </>
      ) : null}

      {segment === 'operations' ? (
        <FinanceOperations
          snapshot={snapshot}
          currency={currency}
          selectedDate={selectedDate}
          filter={filter}
          onFilter={setFilter}
          onClearFilter={() => setSelectedDate(today)}
          onAddExpense={() => openSheet({ kind: 'expense-create' })}
          onAddIncome={() => openSheet({ kind: 'income-create' })}
          onEdit={(expense, income) => {
            if (expense !== null) openSheet({ kind: 'expense-edit', expense });
            if (income !== null) openSheet({ kind: 'income-edit', income });
          }}
          onDelete={(expense, income) => {
            if (expense !== null) {
              void financeStore
                .deleteExpense({ id: expense.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result));
              return;
            }
            if (income !== null) {
              void financeStore
                .deleteIncome({ id: income.id, expectedRevision: revision })
                .then((result) => finish(activeInstance, result));
            }
          }}
        />
      ) : null}

      {segment === 'obligations' ? (
        <FinanceObligations
          notifications={notifications}
          snapshot={snapshot}
          currency={currency}
          showCompleted={showCompleted}
          onToggleList={() => setShowCompleted((current) => !current)}
          onAdd={() => openSheet({ kind: 'obligation-create' })}
          onEdit={(obligation) => openSheet({ kind: 'obligation-edit', obligation })}
          onToggleCompleted={(obligation) =>
            void financeStore
              .setObligationCompleted({
                id: obligation.id,
                completed: !obligation.completed,
                expectedRevision: revision,
              })
              .then((result) => finish(activeInstance, result))
          }
          onDelete={(obligation) =>
            void financeStore
              .deleteObligation({ id: obligation.id, expectedRevision: revision })
              .then((result) => finish(activeInstance, result))
          }
        />
      ) : null}

      {sheet.kind === 'expense-create' ? (
        <FinanceExpenseSheet
          mode="create"
          currency={currency}
          today={today}
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async (draft) =>
            finishActive(await financeStore.addExpense({ ...draft, expectedRevision: activeRevision }))
          }
        />
      ) : null}

      {sheet.kind === 'expense-edit' ? (
        <FinanceExpenseSheet
          mode="edit"
          currency={currency}
          today={today}
          busy={busy}
          initial={{
            amountText: String(sheet.expense.amountMinor / 100),
            date: sheet.expense.date,
            category: sheet.expense.category,
            note: sheet.expense.note,
          }}
          onCancel={closeSheet}
          onSubmit={async (draft) =>
            finishActive(
              await financeStore.editExpense({
                id: sheet.expense.id,
                ...draft,
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'income-create' ? (
        <FinanceIncomeSheet
          mode="create"
          currency={currency}
          today={today}
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async (draft) =>
            finishActive(await financeStore.addIncome({ ...draft, expectedRevision: activeRevision }))
          }
        />
      ) : null}

      {sheet.kind === 'income-edit' ? (
        <FinanceIncomeSheet
          mode="edit"
          currency={currency}
          today={today}
          busy={busy}
          initial={{
            amountText: String(sheet.income.amountMinor / 100),
            date: sheet.income.date,
            source: sheet.income.source,
            note: sheet.income.note,
          }}
          onCancel={closeSheet}
          onSubmit={async (draft) =>
            finishActive(
              await financeStore.editIncome({
                id: sheet.income.id,
                ...draft,
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'balance' ? (
        <FinanceBalanceSheet
          currency={currency}
          currentMinor={snapshot.balanceMinor}
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async (balanceMinor) =>
            finishActive(
              await financeStore.correctBalance({ balanceMinor, expectedRevision: activeRevision }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'limit' ? (
        <FinanceLimitSheet
          currency={currency}
          beforeMinor={limitView.allowance?.amountMinor ?? null}
          autoPreviewMinor={
            nextLimits === null
              ? null
              : Math.floor(Math.max(0, snapshot.balanceMinor) / nextLimits)
          }
          manualMinor={
            limitView.allowance !== null && limitView.allowance.mode === 'manual'
              ? limitView.allowance.amountMinor
              : null
          }
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async ({ mode, manualLimitMinor }) =>
            finishActive(
              await financeStore.applyLimitToday({
                date: localDateIso(new Date()),
                mode,
                manualLimitMinor,
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'obligation-create' ? (
        <FinanceObligationSheet
          mode="create"
          currency={currency}
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async (draft) =>
            finishActive(await financeStore.addObligation({ ...draft, expectedRevision: activeRevision }))
          }
        />
      ) : null}

      {sheet.kind === 'obligation-edit' ? (
        <FinanceObligationSheet
          mode="edit"
          currency={currency}
          busy={busy}
          initial={{
            kind: sheet.obligation.kind,
            title: sheet.obligation.title,
            amountText: String(sheet.obligation.amountMinor / 100),
            dueDate: sheet.obligation.dueDate,
            reminderTime: sheet.obligation.reminderTime,
            reminderEnabled: sheet.obligation.reminderEnabled,
            note: sheet.obligation.note,
          }}
          onCancel={closeSheet}
          onSubmit={async (draft) =>
            finishActive(
              await financeStore.editObligation({
                id: sheet.obligation.id,
                ...draft,
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'expectation-create' || sheet.kind === 'schedule-create' ? (
        <FinanceExpectationSheet
          mode="create"
          initialKind={sheet.kind === 'schedule-create' ? 'monthly' : 'oneTime'}
          currency={currency}
          today={today}
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async (input) => {
            if (input.kind === 'monthly') {
              return finishActive(
                await financeStore.addSchedule({
                  ...input.draft,
                  expectedRevision: activeRevision,
                }),
              );
            }
            return finishActive(
              await financeStore.addExpectation({
                ...input.draft,
                expectedRevision: activeRevision,
              }),
            );
          }}
        />
      ) : null}

      {sheet.kind === 'expectation-edit' ? (
        <FinanceExpectationSheet
          mode="edit"
          initialKind="oneTime"
          currency={currency}
          today={today}
          busy={busy}
          initial={{
            title: sheet.expectation.title,
            amountText: String(sheet.expectation.amountMinor / 100),
            date: sheet.expectation.date,
          }}
          onCancel={closeSheet}
          onSubmit={async (input) =>
            finishActive(
              await financeStore.editExpectation({
                id: sheet.expectation.id,
                date: input.kind === 'oneTime' ? input.draft.date : sheet.expectation.date,
                amountMinor:
                  input.kind === 'oneTime'
                    ? input.draft.amountMinor
                    : sheet.expectation.amountMinor,
                title: input.draft.title,
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'schedule-edit' ? (
        <FinanceExpectationSheet
          mode="edit"
          initialKind="monthly"
          currency={currency}
          today={today}
          busy={busy}
          initial={{
            title: sheet.schedule.title,
            amountText: String(sheet.schedule.expectedAmountMinor / 100),
            dayOfMonth: sheet.schedule.dayOfMonth,
            active: sheet.schedule.active,
          }}
          onCancel={closeSheet}
          onSubmit={async (input) =>
            finishActive(
              await financeStore.editSchedule({
                id: sheet.schedule.id,
                amountChanged: input.kind === 'monthly' ? input.draft.amountChanged : true,
                title: input.draft.title,
                dayOfMonth:
                  input.kind === 'monthly' ? input.draft.dayOfMonth : sheet.schedule.dayOfMonth,
                expectedAmountMinor:
                  input.kind === 'monthly'
                    ? input.draft.expectedAmountMinor
                    : input.draft.amountMinor,
                active: input.kind === 'monthly' ? input.draft.active : sheet.schedule.active,
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'limit-settings' ? (
        <FinanceLimitSettingsSheet
          currency={currency}
          limitMode={snapshot.settings.limitMode}
          manualMinor={snapshot.settings.manualLimitMinor}
          fallbackEndDate={snapshot.settings.fallbackEndDate}
          autoPreviewMinor={
            nextLimits === null
              ? null
              : Math.floor(Math.max(0, snapshot.balanceMinor) / nextLimits)
          }
          todayHasAllowance={limitView.allowance !== null}
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async (input) =>
            finishActive(
              await financeStore.saveLimitSettings({
                limitMode: input.limitMode,
                manualLimitMinor: input.manualLimitMinor,
                fallbackEndDate: input.fallbackEndDate,
                applyToday: input.applyToday,
                date: localDateIso(new Date()),
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'receive-monthly' ? (
        <FinanceReceiveSheet
          currency={currency}
          today={today}
          title={sheet.title}
          expectedText={String(sheet.amountMinor / 100).replace('.', ',')}
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async (draft) =>
            finishActive(
              await financeStore.receiveMonthlyOccurrence({
                scheduleId: sheet.scheduleId,
                date: sheet.date,
                amountMinor: draft.amountMinor,
                incomeDate: draft.date,
                note: draft.note,
                source: draft.source,
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}

      {sheet.kind === 'receive' ? (
        <FinanceReceiveSheet
          currency={currency}
          today={today}
          title={sheet.expectation.title}
          expectedText={String(sheet.expectation.amountMinor / 100).replace('.', ',')}
          busy={busy}
          onCancel={closeSheet}
          onSubmit={async (draft) =>
            finishActive(
              await financeStore.receiveExpectation({
                id: sheet.expectation.id,
                ...draft,
                expectedRevision: activeRevision,
              }),
            )
          }
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  banner: {
    borderRadius: radius.item,
    backgroundColor: colors.surfaceElevated,
    padding: spacing.md,
  },
  primaryButton: {
    minHeight: touchTarget,
    borderRadius: radius.segment,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
