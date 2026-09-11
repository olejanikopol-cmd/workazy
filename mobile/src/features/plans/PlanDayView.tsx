import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import AppText from '@/components/AppText';
import SegmentedControl from '@/components/SegmentedControl';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { PlanTask } from '@/types/plan';
import PlanItemRow from './PlanItemRow';
import PlanItemSheet from './PlanItemSheet';
import { dayProgress, tasksForDate } from './planModel';
import { formatFullDate, formatPlanDay } from './planDates';
import { closeSheetIfSame } from './planSheetGuard';
import type { PlanDay } from './usePlanDay';
import { planStore, usePlanStore } from './usePlanStore';

type SheetState =
  | { key: string; mode: 'add'; targetDate: string }
  | { key: string; mode: 'read'; itemId: string };

const DATE_SEGMENTS = [
  { value: 'today', label: 'Сегодня' },
  { value: 'tomorrow', label: 'Завтра' },
] as const;

type PlanDayViewProps = {
  /** Relative Today/Tomorrow selection owned by the Plans workspace. */
  day: PlanDay;
};

/**
 * The common daily-plan view: real selected date/title and progress, a relative
 * Today/Tomorrow selector, one add action, and a single FlatList with the day's
 * rows. Loading and load-error are explicit states — never an empty day. The
 * relative day lives in `PlansScreen` so switching segments keeps it.
 */
export default function PlanDayView({ day }: PlanDayViewProps) {
  const state = usePlanStore();
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const { mode, setMode, date, today, tomorrow } = day;

  useEffect(() => {
    void planStore.load();
  }, []);

  const dayTasks = tasksForDate(state.tasks, date);
  const progress = dayProgress(state.tasks, date);
  const mutationsLocked = state.phase !== 'ready' || state.saving;

  function openAdd(): void {
    // Capture the concrete date when opening the add editor. Midnight/resume
    // must not silently change the draft's target date.
    setSheet({ key: `add-${date}-${Date.now()}`, mode: 'add', targetDate: date });
  }

  function openRead(itemId: string): void {
    setSheet({ key: `read-${itemId}-${Date.now()}`, mode: 'read', itemId });
  }

  if (state.phase === 'loading') {
    return (
      <View style={styles.centerState}>
        <ActivityIndicator color={colors.accent} />
        <AppText variant="meta" color="muted">
          Загрузка плана…
        </AppText>
      </View>
    );
  }

  if (state.phase === 'load-error') {
    return (
      <View style={styles.centerState}>
        <AppText variant="body" color="secondary" style={styles.errorStateText}>
          {state.error ?? 'Не удалось загрузить план.'}
        </AppText>
        <Pressable
          accessibilityRole="button"
          onPress={() => void planStore.retryLoad()}
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
        >
          <AppText variant="label">Повторить</AppText>
        </Pressable>
      </View>
    );
  }

  const header = (
    <View style={styles.headerBlock}>
      <View style={styles.titleRow}>
        <View style={styles.titleCopy}>
          <AppText variant="section">{formatPlanDay(date, today, tomorrow)}</AppText>
          <AppText variant="meta" color="muted">
            {formatFullDate(date)}
          </AppText>
        </View>
        <View
          accessible
          accessibilityLabel={`${progress.percent} процентов выполнено`}
          style={styles.score}
        >
          <AppText variant="section" style={styles.scoreValue}>
            {progress.percent}
          </AppText>
          <AppText variant="meta" color="muted">
            %
          </AppText>
        </View>
      </View>

      <SegmentedControl<PlanDay['mode']>
        items={DATE_SEGMENTS}
        value={mode}
        onChange={setMode}
      />

      <View
        accessible
        accessibilityLabel={`Выполнено ${progress.done} из ${progress.total} пунктов`}
        style={styles.progressCard}
      >
        <View style={styles.progressCopyRow}>
          <AppText variant="label" color="primary">
            Твой ритм
          </AppText>
          <AppText variant="meta" color="muted">
            {progress.done} из {progress.total} выполнено
          </AppText>
        </View>
        <View style={styles.track}>
          <View style={[styles.trackFill, { width: `${progress.percent}%` }]} />
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Добавить пункт"
        disabled={mutationsLocked}
        onPress={openAdd}
        style={({ pressed }) => [
          styles.addButton,
          mutationsLocked && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <Ionicons name="add" size={20} color={colors.textPrimary} />
        <AppText variant="label">Добавить пункт</AppText>
      </Pressable>

      <View style={styles.sectionHeading}>
        <AppText variant="label" color="secondary">
          План
        </AppText>
        <AppText variant="meta" color="muted">
          {dayTasks.length} пунктов
        </AppText>
      </View>

      {state.error ? (
        <View accessibilityRole="alert" style={styles.errorBanner}>
          <AppText variant="meta" color="danger" style={styles.errorStateText}>
            {state.error}
          </AppText>
        </View>
      ) : null}
    </View>
  );
return (
    <View style={styles.container}>
      <FlatList
        data={dayTasks}
        keyExtractor={(task) => task.id}
        renderItem={renderRow}
        ListHeaderComponent={header}
        ListEmptyComponent={emptyState}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
      {sheet ? (
        <PlanItemSheet
          key={sheet.key}
          mode={sheet.mode}
          itemId={sheet.mode === 'read' ? sheet.itemId : undefined}
          targetDate={sheet.mode === 'add' ? sheet.targetDate : undefined}
          tasks={state.tasks}
          saving={state.saving}
          storeError={state.error}
          onClose={() => setSheet(null)}
          onSaveComplete={() =>
            setSheet((current) => closeSheetIfSame(current, sheet.key))
          }
          onAdd={(title, targetDateValue) => planStore.add(title, targetDateValue)}
          onEdit={(id, title) => planStore.edit(id, title)}
          onToggle={(id) => planStore.toggle(id)}
          onRemove={(id) => planStore.remove(id)}
          onMove={(id, direction) => planStore.move(id, direction)}
        />
      ) : null}
    </View>
  );

  function emptyState() {
    return (
      <View style={styles.empty}>
        <Ionicons name="sunny-outline" size={28} color={colors.accent} />
        <AppText variant="body" color="secondary" style={styles.emptyTitle}>
          День пока свободен
        </AppText>
        <AppText variant="meta" color="muted">
          Добавьте пункт, чтобы начать.
        </AppText>
      </View>
    );
  }

  function renderRow({ item, index }: ListRenderItemInfo<PlanTask>) {
    return (
      <PlanItemRow
        task={item}
        index={index}
        disabled={mutationsLocked}
        onToggle={(id) => void planStore.toggle(id)}
        onPressRead={openRead}
      />
    );
  }
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerState: {
    flex: 1,
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xxl,
  },
  errorStateText: {
    textAlign: 'center',
  },
  retryButton: {
    minHeight: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    borderRadius: radius.input,
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
  },
  headerBlock: {
    gap: spacing.lg,
    paddingBottom: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  titleCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  score: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
  },
  scoreValue: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    color: colors.accent,
  },
  progressCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.card,
    padding: spacing.xl,
    gap: spacing.md,
  },
  progressCopyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  track: {
    height: 5,
    borderRadius: 999,
    backgroundColor: colors.surfaceElevated,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  addButton: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.input,
    backgroundColor: colors.surfaceSelected,
    borderColor: colors.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  errorBanner: {
    backgroundColor: 'rgba(239, 113, 134, 0.1)',
    borderColor: 'rgba(239, 113, 134, 0.28)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.item,
    padding: spacing.lg,
  },
  listContent: {
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  empty: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    marginTop: spacing.xs,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.72,
  },
});