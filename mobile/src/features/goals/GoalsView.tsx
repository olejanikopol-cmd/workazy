import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import AppText from '@/components/AppText';
import Card from '@/components/Card';
import ProductButton from '@/components/ProductButton';
import SegmentedControl from '@/components/SegmentedControl';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { Goal, GoalPeriod } from '@/types/goal';
import { goalPeriodKey } from './goalDates';
import { goalsForPeriod, type GoalDraft } from './goalModel';
import GoalSheet from './GoalSheet';
import { goalStore, useGoalStore } from './useGoalStore';

const periods = [
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'year', label: 'Год' },
] as const;

type SheetState = {
  key: string;
  mode: 'add' | 'read';
  goalId?: string;
  period: GoalPeriod;
  revision: number;
};

let sheetSequence = 0;

function dateFromIso(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  const value = new Date(0);
  value.setHours(12, 0, 0, 0);
  value.setFullYear(year, month - 1, day);
  return value;
}

export default function GoalsView({ today }: { today: string }) {
  const state = useGoalStore();
  const [period, setPeriod] = useState<GoalPeriod>('week');
  const [allPeriods, setAllPeriods] = useState(false);
  const [showCompleted, setShowCompleted] = useState(true);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const sheetRef = useRef<SheetState | null>(null);

  function commitSheet(next: SheetState | null): void {
    sheetRef.current = next;
    setSheet(next);
  }

  useEffect(() => {
    void goalStore.load();
  }, []);

  const currentPeriodKey = goalPeriodKey(period, dateFromIso(today));
  const rows = useMemo(() => {
    if (!currentPeriodKey) return [];
    if (!allPeriods) {
      return goalsForPeriod(state.goals, period, currentPeriodKey, showCompleted);
    }
    return state.goals
      .filter((goal) => goal.period === period && (showCompleted || !goal.completed))
      .sort(
        (left, right) =>
          right.periodKey.localeCompare(left.periodKey) ||
          left.deadline.localeCompare(right.deadline) ||
          left.id.localeCompare(right.id),
      );
  }, [state.goals, period, currentPeriodKey, showCompleted, allPeriods]);

  function open(mode: SheetState['mode'], goalId?: string): void {
    commitSheet({
      key: `goal-${++sheetSequence}`,
      mode,
      goalId,
      period,
      revision: state.revision,
    });
  }

  if (state.phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
        <AppText color="muted">Загрузка целей…</AppText>
      </View>
    );
  }

  if (state.phase === 'load-error') {
    return (
      <View style={styles.center}>
        <AppText accessibilityRole="alert" color="danger" style={styles.centerText}>
          {state.error}
        </AppText>
        <ProductButton label="Повторить" onPress={() => void goalStore.retryLoad()} />
      </View>
    );
  }

  if (!currentPeriodKey) {
    return (
      <View style={styles.center}>
        <AppText accessibilityRole="alert">
          Дата устройства недоступна. Проверьте дату и время.
        </AppText>
      </View>
    );
  }

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <View style={styles.titleCopy}>
          <AppText variant="label" color="accent">
            Направление
          </AppText>
          <AppText variant="pageTitle" accessibilityRole="header">
            Цели
          </AppText>
          <AppText color="secondary">Один понятный ориентир и явный прогресс.</AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Добавить цель"
          accessibilityState={{ disabled: state.saving }}
          disabled={state.saving}
          style={styles.add}
          onPress={() => open('add')}
        >
          <AppText variant="pageTitle">+</AppText>
        </Pressable>
      </View>

      <SegmentedControl
        items={periods}
        value={period}
        onChange={(value) => {
          setPeriod(value);
          setAllPeriods(false);
        }}
      />

      <View style={styles.filterRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: !allPeriods }}
          style={styles.filter}
          onPress={() => setAllPeriods(false)}
        >
          <AppText color={!allPeriods ? 'accent' : 'muted'}>Текущий период</AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: allPeriods }}
          style={styles.filter}
          onPress={() => setAllPeriods(true)}
        >
          <AppText color={allPeriods ? 'accent' : 'muted'}>Все периоды</AppText>
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ checked: showCompleted }}
        style={styles.filter}
        onPress={() => setShowCompleted((value) => !value)}
      >
        <AppText color="secondary">
          {showCompleted ? 'Скрыть выполненные' : 'Показать выполненные'}
        </AppText>
      </Pressable>
      {state.error ? (
        <AppText accessibilityRole="alert" color="danger">
          {state.error}
        </AppText>
      ) : null}
    </View>
  );

  function renderGoal({ item }: ListRenderItemInfo<Goal>) {
    const decreaseDisabled = item.completed || state.saving || item.progress === 0;
    const increaseDisabled = item.completed || state.saving;
    return (
      <Card style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Открыть цель ${item.title}`}
          onPress={() => open('read', item.id)}
          style={styles.cardOpen}
        >
          <View style={styles.cardTop}>
            <AppText variant="meta" color="muted">
              {item.periodKey} · до {item.deadline}
            </AppText>
            <AppText variant="meta" color={item.completed ? 'success' : 'secondary'}>
              {item.completed ? 'Выполнено' : 'В работе'}
            </AppText>
          </View>
          <AppText variant="section">{item.title}</AppText>
          {item.description ? (
            <AppText color="secondary" numberOfLines={3}>
              {item.description}
            </AppText>
          ) : null}
          <AppText accessibilityLabel={`Прогресс ${item.progress} процентов`}>
            Прогресс: {item.progress}%
          </AppText>
          <View accessibilityElementsHidden style={styles.track}>
            <View style={[styles.fill, { width: `${item.progress}%` }]} />
          </View>
        </Pressable>

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Уменьшить прогресс цели ${item.title}`}
            accessibilityState={{ disabled: decreaseDisabled }}
            disabled={decreaseDisabled}
            style={styles.smallAction}
            onPress={() =>
              void goalStore.setProgress(item.id, Math.max(0, item.progress - 10), state.revision)
            }
          >
            <AppText color="muted">−10%</AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Увеличить прогресс цели ${item.title}`}
            accessibilityState={{ disabled: increaseDisabled }}
            disabled={increaseDisabled}
            style={styles.smallAction}
            onPress={() =>
              void goalStore.setProgress(
                item.id,
                Math.min(100, item.progress + 10),
                state.revision,
              )
            }
          >
            <AppText color="accent">+10%</AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ checked: item.completed, disabled: state.saving }}
            disabled={state.saving}
            style={styles.complete}
            onPress={() =>
              void goalStore.setCompleted(item.id, !item.completed, state.revision)
            }
          >
            <AppText color={item.completed ? 'accent' : 'success'}>
              {item.completed ? 'Вернуть (0%)' : 'Завершить'}
            </AppText>
          </Pressable>
        </View>
      </Card>
    );
  }

  return (
    <View style={styles.flex}>
      <FlatList
        data={rows}
        keyExtractor={(goal) => goal.id}
        renderItem={renderGoal}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={styles.empty}>
            <AppText variant="section">Целей пока нет</AppText>
            <AppText color="muted" style={styles.centerText}>
              {allPeriods
                ? 'В выбранном разделе целей нет.'
                : 'Добавьте ориентир для текущего периода.'}
            </AppText>
            <ProductButton
              label="Добавить цель"
              disabled={state.saving}
              onPress={() => open('add')}
            />
          </View>
        }
        contentContainerStyle={styles.list}
      />
      {sheet ? (
        <GoalSheet
          key={sheet.key}
          sheetKey={sheet.key}
          mode={sheet.mode}
          goalId={sheet.goalId}
          period={sheet.period}
          today={today}
          goals={state.goals}
          expectedRevision={sheet.revision}
          saving={state.saving}
          storeError={state.error}
          isCurrent={() => sheetRef.current?.key === sheet.key}
          onClose={() => {
            if (sheetRef.current?.key === sheet.key) commitSheet(null);
          }}
          onComplete={(key) => {
            if (sheetRef.current?.key === key) commitSheet(null);
          }}
          onAdd={(input: GoalDraft, expectedRevision) =>
            goalStore.add({ ...input, expectedRevision })
          }
          onEdit={(id, input, expectedRevision) =>
            goalStore.edit(id, { ...input, expectedRevision })
          }
          onDelete={(id, expectedRevision) => goalStore.remove(id, expectedRevision)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { gap: spacing.lg, paddingBottom: spacing.lg },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  titleCopy: { flex: 1, gap: spacing.xs },
  add: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.iconButton,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSelected,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentSoft,
  },
  filterRow: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' },
  filter: { minHeight: touchTarget, justifyContent: 'center' },
  list: { paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  card: { gap: spacing.md },
  cardOpen: { gap: spacing.sm },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  track: {
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: colors.surfaceElevated,
  },
  fill: { height: '100%', backgroundColor: colors.accent },
  actions: { flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' },
  smallAction: { minWidth: touchTarget, minHeight: touchTarget, justifyContent: 'center' },
  complete: { minHeight: touchTarget, justifyContent: 'center' },
  empty: { alignItems: 'center', gap: spacing.md, padding: spacing.xxl },
  center: {
    flex: 1,
    minHeight: 240,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  centerText: { textAlign: 'center' },
});
