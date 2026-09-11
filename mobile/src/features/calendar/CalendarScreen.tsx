import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import AppText from '@/components/AppText';
import Screen from '@/components/Screen';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { CalendarEvent } from '@/types/calendar';
import CalendarEventRow from './CalendarEventRow';
import CalendarEventSheet from './CalendarEventSheet';
import CalendarMonth from './CalendarMonth';
import { dateIso } from './calendarDates';
import { agendaForDate, type CalendarEventInput } from './calendarModel';
import { applySheetCompletion } from './calendarSheetGuard';
import { calendarStore, useCalendarStore } from './useCalendarStore';
import {
  calendarRequestReconcile,
  focusCalendar,
  refreshCalendarToday,
  requestCalendarPermission,
  retryCalendarReconcile,
  useCalendarNotifications,
  useCalendarToday,
} from './useCalendarLifecycle';
import type { CalendarMutationResult } from './calendarStore';

type SheetState =
  | { key: string; mode: 'add'; targetDate: string }
  | { key: string; mode: 'read'; itemId: string };

function todayParts(): { year: number; month: number; date: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return { year, month, date };
}

/**
 * Calendar workspace: Monday-first month grid, selected-day agenda, event CRUD
 * (each mutation immediately triggers coordination of the latest committed
 * notification state) and contextual notification permission/reconcile states.
 * Month/selection are retained across tab switches in the session; cold launch
 * selects today; the today marker tracks focus/foreground/periodic refreshes.
 */
export default function CalendarScreen() {
  const state = useCalendarStore();
  const notifications = useCalendarNotifications();
  const today = useCalendarToday();
  const [view, setView] = useState(() => {
    const { year, month, date } = todayParts();
    return { year, month, selectedDate: date };
  });
  const [sheet, setSheet] = useState<SheetState | null>(null);
  // Latest open-sheet identity for async completions: an old delete/save that
  // resolves after a NEWER sheet opened must not close the new one, so the
  // completion handler reads the current identity instead of its own closure.
  const sheetRef = useRef<SheetState | null>(null);

  useEffect(() => {
    void calendarStore.load();
  }, []);

  useEffect(() => {
    sheetRef.current = sheet;
  }, [sheet]);

  // On focus: refresh the today marker and reconcile the latest committed state
  // (notification state may be stale after time in another tab/background).
  // `focusCalendar` is the same controller path the lifecycle uses.
  useFocusEffect(
    useCallback(() => {
      void focusCalendar();
    }, []),
  );

  const selectedDate = view.selectedDate;
  const eventsByDate = new Set(state.events.map((event) => event.date));
  const agenda = agendaForDate(state.events, selectedDate);
  const mutationsLocked = state.phase !== 'ready' || state.saving;

  function goToToday(): void {
    const { year, month, date } = todayParts();
    setView({ year, month, selectedDate: date });
    refreshCalendarToday();
  }

  function prevMonth(): void {
    setView((prev) => {
      const month = prev.month - 1;
      const year = month < 0 ? prev.year - 1 : prev.year;
      const normalized = ((month % 12) + 12) % 12;
      // Month arrows select day 1 of the destination month.
      return { year, month: normalized, selectedDate: dateIso(year, normalized, 1) };
    });
  }

  function nextMonth(): void {
    setView((prev) => {
      const month = prev.month + 1;
      const year = month > 11 ? prev.year + 1 : prev.year;
      const normalized = month % 12;
      return { year, month: normalized, selectedDate: dateIso(year, normalized, 1) };
    });
  }

  function selectDate(iso: string): void {
    setView((prev) => ({ ...prev, selectedDate: iso }));
  }

  /** After a save that changed the event's date, move the view to that day. */
  function revealDate(iso: string): void {
    const [year, month] = iso.split('-').map(Number);
    setView((prev) => ({
      year,
      month: month - 1,
      selectedDate: iso,
    }));
    refreshCalendarToday();
  }

  function openAdd(): void {
    setSheet({ key: `add-${selectedDate}-${Date.now()}`, mode: 'add', targetDate: selectedDate });
  }

  function openRead(itemId: string): void {
    setSheet({ key: `read-${itemId}-${Date.now()}`, mode: 'read', itemId });
  }

  /**
   * CRUD wrappers: persist-before-commit, then trigger an immediate
   * coordinated reconciliation of the LATEST committed state (awaited so that,
   * if the app closes right after the operation, notification state is already
   * consistent as far as the operation completed successfully).
   */
  async function addEvent(input: CalendarEventInput): Promise<CalendarMutationResult> {
    const result = await calendarStore.add(input);
    if (result.ok) await calendarRequestReconcile();
    return result;
  }

  async function editEvent(id: string, input: CalendarEventInput): Promise<CalendarMutationResult> {
    const result = await calendarStore.edit(id, input);
    if (result.ok) await calendarRequestReconcile();
    return result;
  }

  async function removeEvent(id: string): Promise<CalendarMutationResult> {
    const result = await calendarStore.remove(id);
    if (result.ok) await calendarRequestReconcile();
    return result;
  }

  /**
   * A save/delete completion carries the identity of the sheet that finished.
   * It is applied to the CURRENT open sheet (via ref), so a slow completion
   * from a deleted event can never close a newer editor opened meanwhile.
   */
  function handleSaveComplete(completedKey: string, destinationDate?: string): void {
    const applied = applySheetCompletion(sheetRef.current, completedKey, destinationDate);
    if (applied.reveal) revealDate(applied.reveal);
    setSheet(applied.next);
  }

  async function handleEnableNotifications(): Promise<void> {
    await requestCalendarPermission();
  }

  async function handleOpenSettings(): Promise<void> {
    try {
      await Linking.openSettings();
    } catch {
      // Settings may be unavailable; the banner remains visible.
    }
  }

  if (state.phase === 'loading') {
    return (
      <Screen>
        <View style={styles.centerState}>
          <ActivityIndicator color={colors.accent} />
          <AppText variant="meta" color="muted">
            Загрузка календаря…
          </AppText>
        </View>
      </Screen>
    );
  }

  if (state.phase === 'load-error') {
    return (
      <Screen>
        <View style={styles.centerState}>
          <AppText variant="body" color="secondary" style={styles.centerText}>
            {state.error ?? 'Не удалось загрузить календарь.'}
          </AppText>
          <Pressable
            accessibilityRole="button"
            onPress={() => void calendarStore.retryLoad()}
            style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
          >
            <AppText variant="label">Повторить</AppText>
          </Pressable>
        </View>
      </Screen>
    );
  }

  const header = (
    <View style={styles.headerBlock}>
      <View style={styles.titleRow}>
        <View style={styles.titleCopy}>
          <AppText variant="pageTitle">Календарь</AppText>
          <AppText variant="meta" color="muted">
            Всё важное — в контексте дня.
          </AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Добавить событие"
          disabled={mutationsLocked}
          onPress={openAdd}
          style={({ pressed }) => [
            styles.addButton,
            mutationsLocked && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Ionicons name="add" size={22} color={colors.textPrimary} />
        </Pressable>
      </View>

      <CalendarMonth
        year={view.year}
        month={view.month}
        selectedDate={selectedDate}
        today={today}
        eventsByDate={eventsByDate}
        onSelectDate={selectDate}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
        onToday={goToToday}
      />

      {notifications.permission && !notifications.permission.granted ? (
        <View style={styles.permissionBanner}>
          <AppText variant="meta" color="secondary" style={styles.bannerText}>
            События сохраняются на устройстве. Включите уведомления, чтобы получать
            напоминания о событиях.
          </AppText>
          {notifications.permission.canAskAgain ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleEnableNotifications()}
              style={({ pressed }) => [styles.bannerButton, pressed && styles.pressed]}
            >
              <AppText variant="label" color="accent">
                Включить уведомления
              </AppText>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleOpenSettings()}
              style={({ pressed }) => [styles.bannerButton, pressed && styles.pressed]}
            >
              <AppText variant="label" color="accent">
                Открыть настройки
              </AppText>
            </Pressable>
          )}
        </View>
      ) : null}

      {notifications.permission?.provisional ? (
        <View style={styles.permissionBanner}>
          <AppText variant="meta" color="secondary" style={styles.bannerText}>
            Уведомления включены в тихом режиме — напоминания появятся без звука.
          </AppText>
        </View>
      ) : null}

      {notifications.reconcileStatus === 'error' ? (
        <View accessibilityRole="alert" style={styles.errorBanner}>
          <AppText variant="meta" color="danger" style={styles.bannerText}>
            {notifications.reconcileError ?? 'Не удалось синхронизировать напоминания.'}
          </AppText>
          <Pressable
            accessibilityRole="button"
            onPress={retryCalendarReconcile}
            style={({ pressed }) => [styles.bannerButton, pressed && styles.pressed]}
          >
            <AppText variant="label" color="danger">
              Повторить
            </AppText>
          </Pressable>
        </View>
      ) : null}

      {notifications.capacityLimited ? (
        <View style={styles.capacityBanner}>
          <AppText variant="meta" color="secondary" style={styles.bannerText}>
            Часть напоминаний не запланирована из-за лимита системы. Они появятся при
            следующем открытии приложения.
          </AppText>
        </View>
      ) : null}

      {notifications.unschedulable.length > 0 ? (
        <View accessibilityRole="alert" style={styles.warningBanner}>
          <AppText variant="meta" color="secondary" style={styles.bannerText}>
            {notifications.unschedulable.length === 1
              ? `Для события «${notifications.unschedulable[0].title}» (${notifications.unschedulable[0].date} ${notifications.unschedulable[0].time}) напоминание нельзя запланировать: это время не существует в вашем часовом поясе из-за перевода часов.`
              : `Для событий (${notifications.unschedulable
                  .slice(0, 3)
                  .map((entry) => `«${entry.title}»`)
                  .join(', ')}${notifications.unschedulable.length > 3 ? ' и других' : ''}) напоминания нельзя запланировать: выбранное время не существует в вашем часовом поясе из-за перевода часов.`}
          </AppText>
        </View>
      ) : null}

      <View style={styles.dayHeading}>
        <View style={styles.dayHeadingCopy}>
          <AppText variant="label" color="secondary">
            Выбранный день
          </AppText>
          <AppText variant="section">{selectedDate}</AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Добавить событие в выбранный день"
          disabled={mutationsLocked}
          onPress={openAdd}
          style={({ pressed }) => [styles.dayAddButton, pressed && styles.pressed]}
        >
          <AppText variant="label" color="accent">
            + Событие
          </AppText>
        </Pressable>
      </View>
    </View>
  );

  return (
    <Screen>
      <FlatList
        data={agenda}
        keyExtractor={(event) => event.id}
        renderItem={renderRow}
        ListHeaderComponent={header}
        ListEmptyComponent={emptyState}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
      {sheet ? (
        <CalendarEventSheet
          key={sheet.key}
          sheetKey={sheet.key}
          mode={sheet.mode}
          itemId={sheet.mode === 'read' ? sheet.itemId : undefined}
          targetDate={sheet.mode === 'add' ? sheet.targetDate : undefined}
          events={state.events}
          saving={state.saving}
          storeError={state.error}
          onClose={() => setSheet(null)}
          onSaveComplete={handleSaveComplete}
          onAdd={addEvent}
          onEdit={editEvent}
          onRemove={removeEvent}
        />
      ) : null}
    </Screen>
  );

  function renderRow({ item }: ListRenderItemInfo<CalendarEvent>) {
    return <CalendarEventRow event={item} disabled={mutationsLocked} onPress={openRead} />;
  }

  function emptyState() {
    return (
      <View style={styles.empty}>
        <Ionicons name="calendar-outline" size={28} color={colors.accent} />
        <AppText variant="body" color="secondary" style={styles.emptyTitle}>
          Событий нет
        </AppText>
        <AppText variant="meta" color="muted">
          Можно оставить этот день свободным.
        </AppText>
      </View>
    );
  }
}
const styles = StyleSheet.create({
  centerState: {
    flex: 1,
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xxl,
  },
  centerText: {
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
  addButton: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.iconButton,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSelected,
    borderColor: colors.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
  },
  permissionBanner: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.item,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  errorBanner: {
    backgroundColor: 'rgba(239, 113, 134, 0.1)',
    borderColor: 'rgba(239, 113, 134, 0.28)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.item,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  capacityBanner: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.item,
    padding: spacing.lg,
  },
  warningBanner: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.item,
    padding: spacing.lg,
  },
  bannerText: {
    lineHeight: 18,
  },
  bannerButton: {
    alignSelf: 'flex-start',
    minHeight: touchTarget,
    justifyContent: 'center',
  },
  dayHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  dayHeadingCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  dayAddButton: {
    minHeight: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
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