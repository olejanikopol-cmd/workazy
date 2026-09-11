import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { CalendarEvent } from '@/types/calendar';
import {
  formatEventFullDate,
  isoToLocalDate,
  localDateToIso,
  zonedDateTimeToUtcEarlier,
} from './calendarDates';
import {
  createSheetLock,
  isDraftUnchanged,
  isSheetDirty,
  type CalendarSheetDraft,
  type SheetLock,
} from './calendarSheetGuard';
import { validateEventInput, type CalendarEventInput } from './calendarModel';
import type { CalendarMutationResult } from './calendarStore';

export type CalendarSheetMode = 'add' | 'read' | 'edit';

const REMINDER_CHOICES = [
  'За 10 минут',
  'За 30 минут',
  'За 1 час',
  'Только в момент события',
] as const;

/** What the add form shows by default. */
const DEFAULT_NEW_TIME = '18:00';
const DEFAULT_NEW_REMINDER = 'За 30 минут';
/** What an existing event WITHOUT a stored reminder maps to in the UI. */
const NO_STORED_REMINDER_LABEL = 'Только в момент события';

const TITLE_BLANK = 'Введите название события.';
const TITLE_LONG = 'Слишком длинное название — максимум 300 знаков.';
const NOTE_LONG = 'Слишком длинная заметка — максимум 1000 знаков.';
const DATE_INVALID = 'Выберите корректную дату.';
const TIME_UNSCHEDULABLE =
  'Выбранное время не существует в вашем часовом поясе из-за перевода часов (DST). Выберите другое время.';

type CalendarEventSheetProps = {
  /** Deterministic identity shared with the parent's open-sheet state. */
  sheetKey: string;
  mode: CalendarSheetMode;
  itemId?: string;
  targetDate?: string;
  events: readonly CalendarEvent[];
  saving: boolean;
  storeError: string | null;
  onClose: () => void;
  /**
   * Close after a successful mutation; passes this sheet's identity so a stale
   * completion can never close a newer sheet. The destination date (for a
   * successful save that moved the event) is the second argument.
   */
  onSaveComplete: (sheetKey: string, destinationDate?: string) => void;
  onAdd: (input: CalendarEventInput) => Promise<CalendarMutationResult>;
  onEdit: (id: string, input: CalendarEventInput) => Promise<CalendarMutationResult>;
  onRemove: (id: string) => Promise<CalendarMutationResult>;
};

// Date <-> stored-string conversion uses the shared full-year-safe calendar
// helpers (`isoToLocalDate`/`localDateToIso`): years 1-99 are never remapped to
// the 1900s and the year is always 4-digit padded.

// The time picker only needs a carrier instant; 1970 is outside the JS 0-99
// remap range, so it is a safe neutral base (no year semantics are stored).
function timeToDate(time: string): Date {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(1970, 0, 1, hours, minutes, 0, 0);
}

function dateToTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Full-screen native modal for calendar events. Read mode resolves the item by
 * ID from the committed store snapshot. Add/edit keep the draft until a write
 * succeeds, guard dirty dismissal/Android back, and lock fields/close while a
 * save is pending. Only a completion for the same sheet identity/revision may
 * close the sheet.
 */
export default function CalendarEventSheet({
  sheetKey,
  mode: initialMode,
  itemId,
  targetDate,
  events,
  saving,
  storeError,
  onClose,
  onSaveComplete,
  onAdd,
  onEdit,
  onRemove,
}: CalendarEventSheetProps) {
  const [innerMode, setInnerMode] = useState<CalendarSheetMode>(initialMode);
  const [title, setTitle] = useState('');
  const [initialTitle, setInitialTitle] = useState('');
  const [date, setDate] = useState(targetDate ?? '');
  const [initialDate, setInitialDate] = useState(targetDate ?? '');
  const [hasTime, setHasTime] = useState(true);
  const [initialHasTime, setInitialHasTime] = useState(true);
  const [time, setTime] = useState(DEFAULT_NEW_TIME);
  const [initialTime, setInitialTime] = useState(DEFAULT_NEW_TIME);
  const [note, setNote] = useState('');
  const [initialNote, setInitialNote] = useState('');
  const [reminder, setReminder] = useState(DEFAULT_NEW_REMINDER);
  const [initialReminder, setInitialReminder] = useState(DEFAULT_NEW_REMINDER);
  const [reminderChanged, setReminderChanged] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous busy lock shared by save and delete (see calendarSheetGuard):
  // acquired BEFORE any await, so a second operation or a dismissal is rejected
  // immediately while the pending one disables every control.
  const lockRef = useRef<SheetLock | null>(null);
  const lock = (lockRef.current ??= createSheetLock());
  const draftRevisionRef = useRef(0);

  const lockBusy = busy || saving;

  const item = itemId ? events.find((event) => event.id === itemId) ?? null : null;
  const isEditing = innerMode === 'add' || innerMode === 'edit';

  const headerTitle =
    innerMode === 'read'
      ? 'Событие'
      : innerMode === 'edit'
        ? 'Изменение события'
        : 'Новое событие';
  const displayDate =
    innerMode === 'add' && targetDate ? targetDate : item?.date ?? targetDate ?? '';

  function draftSnapshot(): CalendarSheetDraft {
    return {
      title,
      note,
      date,
      hasTime,
      time,
      reminder,
    };
  }

  function bumpRevision(): void {
    draftRevisionRef.current += 1;
  }

  function changeTitle(value: string): void {
    bumpRevision();
    setTitle(value);
    if (validation) setValidation(null);
  }

  function changeNote(value: string): void {
    bumpRevision();
    setNote(value);
    if (validation) setValidation(null);
  }

  function startEdit(): void {
    if (!item || lock.isBusy()) return;
    setInitialTitle(item.title);
    setTitle(item.title);
    setInitialDate(item.date);
    setDate(item.date);
    setInitialHasTime(item.time !== undefined);
    setHasTime(item.time !== undefined);
    setInitialTime(item.time ?? DEFAULT_NEW_TIME);
    setTime(item.time ?? DEFAULT_NEW_TIME);
    setInitialNote(item.note ?? '');
    setNote(item.note ?? '');
    // Preserve the stored reminder exactly: an event WITHOUT a reminder shows
    // «Только в момент события» but saves nothing unless the user changes it.
    const storedReminder = item.reminder ?? NO_STORED_REMINDER_LABEL;
    setInitialReminder(storedReminder);
    setReminder(storedReminder);
    setReminderChanged(false);
    setValidation(null);
    setInnerMode('edit');
  }

  function requestClose(): void {
    if (lock.isBusy()) return;
    if (innerMode === 'read') {
      onClose();
      return;
    }
    const initial: CalendarSheetDraft = {
      title: initialTitle,
      note: initialNote,
      date: initialDate,
      hasTime: initialHasTime,
      time: initialTime,
      reminder: initialReminder,
    };
    const dirty = isSheetDirty(draftSnapshot(), initial);
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert('Отменить изменения?', 'Несохранённый текст будет потерян.', [
      { text: 'Остаться', style: 'cancel' },
      { text: 'Отменить', style: 'destructive', onPress: onClose },
    ]);
  }

  function onDateChange(event: DateTimePickerEvent, selected?: Date): void {
    if (lockBusy) return;
    if (Platform.OS === 'android') setShowDatePicker(false);
    if (event.type === 'dismissed' || !selected) return;
    bumpRevision();
    setDate(localDateToIso(selected));
  }

  function onTimeChange(event: DateTimePickerEvent, selected?: Date): void {
    if (lockBusy) return;
    if (Platform.OS === 'android') setShowTimePicker(false);
    if (event.type === 'dismissed' || !selected) return;
    bumpRevision();
    setTime(dateToTime(selected));
  }

  async function handleSave(): Promise<void> {
    if (lock.isBusy()) return;

    // Surface unschedulable local wall-clock times (DST spring-forward gap) and
    // refuse to save misleading reminder state — no silent invalid schedule.
    if (hasTime) {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zonedDateTimeToUtcEarlier(date, time, timeZone) === null) {
        setValidation(TIME_UNSCHEDULABLE);
        return;
      }
    }

    // Preserve the stored reminder exactly if the user did not change it:
    // an event that HAD no reminder keeps no reminder; the displayed default
    // («Только в момент события») is not written back.
    const reminderValue =
      innerMode === 'edit' && !reminderChanged && item
        ? item.reminder
        : reminder;

    const input: CalendarEventInput = {
      title,
      date,
      time: hasTime ? time : undefined,
      note,
      reminder: reminderValue,
    };
    const validated = validateEventInput(input);
    if (!validated.ok) {
      const titleCheck = title.trim();
      if (titleCheck.length === 0) setValidation(TITLE_BLANK);
      else if (titleCheck.length > 300) setValidation(TITLE_LONG);
      else if (note.trim().length > 1000) setValidation(NOTE_LONG);
      else setValidation(DATE_INVALID);
      return;
    }
    const revisionAtSave = draftRevisionRef.current;
    if (!lock.acquire()) return;
    setBusy(true);
    try {
      if (innerMode === 'add') {
        const result = await onAdd(validated.input);
        if (result.ok) {
          if (isDraftUnchanged(draftRevisionRef.current, revisionAtSave)) {
            onSaveComplete(sheetKey, validated.input.date);
          }
        } else if (result.reason === 'validation') {
          setValidation(TITLE_BLANK);
        }
        return;
      }
      if (!itemId) return;
      const result = await onEdit(itemId, validated.input);
      if (result.ok) {
        if (isDraftUnchanged(draftRevisionRef.current, revisionAtSave)) {
          onSaveComplete(sheetKey, validated.input.date);
        }
      } else if (result.reason === 'validation') {
        setValidation(TITLE_BLANK);
      }
    } finally {
      lock.release();
      setBusy(false);
    }
  }

  /**
   * Delete acquires the SAME synchronous busy lock as save: while the removal
   * (plus its awaited reconciliation) is in flight every control — close,
   * edit, save, delete, pickers — is disabled and the modal cannot be dismissed
   * (`requestClose` also checks the lock). A completion for a superseded sheet
   * can never close a newer one because the parent guards by `sheetKey`.
   */
  function requestDelete(): void {
    if (!item || lock.isBusy()) return;
    const targetId = item.id;
    Alert.alert('Удалить событие?', `«${item.title}» будет удалено безвозвратно.`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          if (!lock.acquire()) return;
          setBusy(true);
          try {
            const result = await onRemove(targetId);
            if (result.ok) onSaveComplete(sheetKey);
          } finally {
            lock.release();
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={requestClose}
    >
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <AppText variant="meta" color="muted">
                {displayDate ? formatEventFullDate(displayDate) : ''}
              </AppText>
              <AppText variant="section">{headerTitle}</AppText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
              disabled={lockBusy}
              onPress={requestClose}
              style={({ pressed }) => [
                styles.closeButton,
                lockBusy && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {storeError ? (
              <View accessibilityRole="alert" style={styles.errorBanner}>
                <AppText variant="meta" color="danger" style={styles.errorText}>
                  {storeError}
                </AppText>
              </View>
            ) : null}

            {innerMode === 'read' && item ? (
              <View style={styles.readBlock}>
                <AppText variant="body" style={styles.readTitle}>
                  {item.title}
                </AppText>
                <View style={styles.readMeta}>
                  <AppText variant="meta" color="muted">
                    {formatEventFullDate(item.date)}
                  </AppText>
                  <AppText variant="meta" color="muted">
                    {item.time ?? 'Без времени'}
                  </AppText>
                  <AppText variant="meta" color="muted">
                    {item.reminder ?? 'В момент события'}
                  </AppText>
                </View>
                {item.note ? (
                  <AppText variant="body" color="secondary" style={styles.readNote}>
                    {item.note}
                  </AppText>
                ) : null}
                <View style={styles.actionStack}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={lockBusy}
                    onPress={startEdit}
                    style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}
                  >
                    <Ionicons name="create-outline" size={20} color={colors.textSecondary} />
                    <AppText variant="label">Изменить</AppText>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={lockBusy}
                    onPress={requestDelete}
                    style={({ pressed }) => [
                      styles.actionRow,
                      styles.dangerRow,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Ionicons name="trash-outline" size={20} color={colors.danger} />
                    <AppText variant="label" color="danger">
                      Удалить
                    </AppText>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {innerMode === 'read' && !item ? (
              <AppText variant="body" color="secondary" style={styles.notFound}>
                Событие не найдено.
              </AppText>
            ) : null}

            {isEditing ? (
              <View style={styles.editorBlock}>
                <TextInput
                  value={title}
                  onChangeText={changeTitle}
                  editable={!lockBusy}
                  placeholder="Название события"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  accessibilityLabel="Название события"
                />

                <Pressable
                  accessibilityRole="button"
                  disabled={lockBusy}
                  onPress={() => setShowDatePicker((v) => !v)}
                  style={({ pressed }) => [styles.fieldRow, pressed && styles.pressed]}
                >
                  <AppText variant="label" color="secondary" style={styles.fieldLabel}>
                    Дата
                  </AppText>
                  <AppText variant="label">{formatEventFullDate(date)}</AppText>
                </Pressable>
                {showDatePicker && !lockBusy ? (
                  <DateTimePicker
                    value={isoToLocalDate(date)}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'inline' : 'default'}
                    onChange={onDateChange}
                  />
                ) : null}

                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: hasTime }}
                  disabled={lockBusy}
                  onPress={() => {
                    bumpRevision();
                    setHasTime((v) => !v);
                  }}
                  style={({ pressed }) => [styles.fieldRow, pressed && styles.pressed]}
                >
                  <AppText variant="label" color="secondary" style={styles.fieldLabel}>
                    Без времени
                  </AppText>
                  <Ionicons
                    name={hasTime ? 'square-outline' : 'checkbox'}
                    size={22}
                    color={hasTime ? colors.textMuted : colors.accent}
                  />
                </Pressable>

                {hasTime ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      disabled={lockBusy}
                      onPress={() => setShowTimePicker((v) => !v)}
                      style={({ pressed }) => [styles.fieldRow, pressed && styles.pressed]}
                    >
                      <AppText variant="label" color="secondary" style={styles.fieldLabel}>
                        Время
                      </AppText>
                      <AppText variant="label">{time}</AppText>
                    </Pressable>
                    {showTimePicker && !lockBusy ? (
                      <DateTimePicker
                        value={timeToDate(time)}
                        mode="time"
                        display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                        onChange={onTimeChange}
                      />
                    ) : null}
                  </>
                ) : null}

                <TextInput
                  value={note}
                  onChangeText={changeNote}
                  editable={!lockBusy}
                  multiline
                  placeholder="Заметка (необязательно)"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, styles.noteInput]}
                  textAlignVertical="top"
                  accessibilityLabel="Заметка"
                />

                <View style={styles.reminderBlock}>
                  <AppText variant="label" color="secondary">
                    Дополнительное напоминание
                  </AppText>
                  {REMINDER_CHOICES.map((choice) => {
                    const selected = reminder === choice;
                    return (
                      <Pressable
                        key={choice}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        disabled={lockBusy}
                        onPress={() => {
                          bumpRevision();
                          setReminderChanged(true);
                          setReminder(choice);
                        }}
                        style={({ pressed }) => [
                          styles.reminderRow,
                          selected && styles.reminderRowSelected,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Ionicons
                          name={selected ? 'radio-button-on' : 'radio-button-off'}
                          size={20}
                          color={selected ? colors.accent : colors.textMuted}
                        />
                        <AppText variant="label" color={selected ? 'primary' : 'secondary'}>
                          {choice}
                        </AppText>
                      </Pressable>
                    );
                  })}
                  <AppText variant="meta" color="muted" style={styles.reminderHint}>
                    «Только в момент события» — одно уведомление в момент начала. События
                    сохраняются на устройстве независимо от уведомлений.
                  </AppText>
                </View>

                {validation ? (
                  <View accessibilityRole="alert">
                    <AppText variant="meta" color="danger" style={styles.validationText}>
                      {validation}
                    </AppText>
                  </View>
                ) : null}
              </View>
            ) : null}
          </ScrollView>

          {isEditing ? (
            <View style={styles.footer}>
              <Pressable
                accessibilityRole="button"
                disabled={lockBusy}
                onPress={requestClose}
                style={({ pressed }) => [
                  styles.footerButton,
                  lockBusy && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <AppText variant="label" color="secondary">
                  Отмена
                </AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={lockBusy}
                onPress={handleSave}
                style={({ pressed }) => [
                  styles.footerButton,
                  styles.saveButton,
                  lockBusy && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <AppText variant="label" color="primary">
                  Сохранить
                </AppText>
              </Pressable>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    gap: spacing.lg,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerCopy: { flex: 1 },
  closeButton: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.iconButton,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  errorBanner: {
    backgroundColor: 'rgba(239, 113, 134, 0.1)',
    borderColor: 'rgba(239, 113, 134, 0.28)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.item,
    padding: spacing.lg,
  },
  errorText: { textAlign: 'center' },
  readBlock: { gap: spacing.lg },
  readTitle: { fontSize: 20, lineHeight: 28, fontWeight: '600' },
  readMeta: { gap: spacing.xs },
  readNote: { lineHeight: 24 },
  notFound: { paddingVertical: spacing.xxl, textAlign: 'center' },
  actionStack: { marginTop: spacing.sm, gap: spacing.sm },
  actionRow: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dangerRow: { borderColor: 'rgba(239, 113, 134, 0.34)' },
  editorBlock: { gap: spacing.md },
  input: {
    minHeight: touchTarget,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.input,
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontSize: 17,
    lineHeight: 24,
  },
  noteInput: { minHeight: 100, maxHeight: 240, textAlignVertical: 'top' },
  fieldRow: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.input,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  fieldLabel: { flex: 1 },
  reminderBlock: { gap: spacing.sm },
  reminderRow: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reminderRowSelected: {
    borderColor: colors.accentSoft,
    backgroundColor: colors.surfaceSelected,
  },
  reminderHint: { lineHeight: 18 },
  validationText: { marginTop: spacing.xs },
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.background,
  },
  footerButton: {
    flex: 1,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.input,
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  saveButton: {
    backgroundColor: colors.surfaceSelected,
    borderColor: colors.accentSoft,
  },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
});
