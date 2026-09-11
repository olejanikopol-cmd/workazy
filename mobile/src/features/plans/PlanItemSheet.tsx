import { Ionicons } from '@expo/vector-icons';
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
import type { PlanTask } from '@/types/plan';
import { formatFullDate } from './planDates';
import { validateTitle } from './planModel';
import { isDraftUnchanged } from './planSheetGuard';
import type { MutationResult } from './planStore';

export type PlanSheetMode = 'add' | 'read' | 'edit';

type PlanItemSheetProps = {
  mode: PlanSheetMode;
  /** Item to resolve live from the store (read/edit modes). */
  itemId?: string;
  /** Concrete captured date for an add draft. */
  targetDate?: string;
  tasks: readonly PlanTask[];
  saving: boolean;
  storeError: string | null;
  onClose: () => void;
  /** Close after an async mutation completes, guarded by sheet identity. */
  onSaveComplete: () => void;
  onAdd: (title: string, date: string) => Promise<MutationResult>;
  onEdit: (id: string, title: string) => Promise<MutationResult>;
  onToggle: (id: string) => Promise<MutationResult>;
  onRemove: (id: string) => Promise<MutationResult>;
  onMove: (id: string, direction: -1 | 1) => Promise<MutationResult>;
};

const MAX_LENGTH_TEXT =
  'Слишком длинный текст — максимум 300 знаков.';
const BLANK_TEXT = 'Введите текст пункта.';

/**
 * Full-screen native modal for the daily plan. Read mode resolves the item by
 * ID from the committed store snapshot (never a stale copy). Add/edit keep the
 * draft until a write succeeds and guard dirty dismissal, Android back and the
 * Cancel button with an explicit discard confirmation.
 */
export default function PlanItemSheet({
  mode: initialMode,
  itemId,
  targetDate,
  tasks,
  saving,
  storeError,
  onClose,
  onSaveComplete,
  onAdd,
  onEdit,
  onToggle,
  onRemove,
  onMove,
}: PlanItemSheetProps) {
  const [innerMode, setInnerMode] = useState<PlanSheetMode>(initialMode);
  const [draft, setDraft] = useState('');
  const [initialDraft, setInitialDraft] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  // Local busy lock: synchronous with the save tap, so typing/dismissal are
  // locked on the same frame the store write starts (before `saving` re-renders).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Revision of the draft; captured at save start so a stale completion cannot
  // close the sheet if the draft somehow changed mid-write.
  const draftRevisionRef = useRef(0);

  const lockBusy = busy || saving;

  const item = itemId ? tasks.find((task) => task.id === itemId) ?? null : null;
  const isEditing = innerMode === 'add' || innerMode === 'edit';

  const dayItems = item ? tasks.filter((task) => task.date === item.date) : [];
  const dayIndex = item ? dayItems.findIndex((task) => task.id === item.id) : -1;
  const canMoveUp = dayIndex > 0;
  const canMoveDown = dayIndex >= 0 && dayIndex < dayItems.length - 1;

  const headerTitle =
    innerMode === 'read' ? 'Пункт плана' : innerMode === 'edit' ? 'Изменение пункта' : 'Новый пункт';

  const displayDate = innerMode === 'add' && targetDate ? targetDate : item?.date ?? targetDate ?? '';

  function changeDraft(value: string): void {
    draftRevisionRef.current += 1;
    setDraft(value);
    if (validation) setValidation(null);
  }

  function startEdit(): void {
    if (!item || busyRef.current) return;
    setInitialDraft(item.title);
    setDraft(item.title);
    setValidation(null);
    setInnerMode('edit');
  }

  function requestClose(): void {
    if (busyRef.current) return;
    if (innerMode === 'read') {
      onClose();
      return;
    }
    const dirty = innerMode === 'add' ? draft !== '' : draft !== initialDraft;
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert('Отменить изменения?', 'Несохранённый текст будет потерян.', [
      { text: 'Остаться', style: 'cancel' },
      { text: 'Отменить', style: 'destructive', onPress: onClose },
    ]);
  }

  async function handleSave(): Promise<void> {
    if (busyRef.current) return;
    const titleCheck = validateTitle(draft);
    if (!titleCheck.ok) {
      setValidation(titleCheck.reason === 'blank' ? BLANK_TEXT : MAX_LENGTH_TEXT);
      return;
    }
    const revisionAtSave = draftRevisionRef.current;
    busyRef.current = true;
    setBusy(true);
    try {
      if (innerMode === 'add' && targetDate) {
        const result = await onAdd(titleCheck.title, targetDate);
        if (result.ok) {
          if (isDraftUnchanged(draftRevisionRef.current, revisionAtSave)) onSaveComplete();
        } else if (result.reason === 'validation') {
          setValidation(BLANK_TEXT);
        }
        return;
      }
      if (!itemId) return;
      const result = await onEdit(itemId, titleCheck.title);
      if (result.ok) {
        if (isDraftUnchanged(draftRevisionRef.current, revisionAtSave)) onSaveComplete();
      } else if (result.reason === 'validation') {
        setValidation(BLANK_TEXT);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function handleToggle(): void {
    if (itemId && !busyRef.current) void onToggle(itemId);
  }

  function handleMove(direction: -1 | 1): void {
    if (itemId && !busyRef.current) void onMove(itemId, direction);
  }

  function requestDelete(): void {
    if (!item || busyRef.current) return;
    Alert.alert('Удалить пункт?', `«${item.title}» будет удалён безвозвратно.`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          if (busyRef.current) return;
          const result = await onRemove(item.id);
          if (result.ok) onSaveComplete();
          // On failure the sheet stays open and storeError stays visible.
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
                {displayDate ? formatFullDate(displayDate) : ''}
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
                <View
                  style={[styles.statusBadge, item.completed ? styles.statusDone : styles.statusPending]}
                >
                  <AppText
                    variant="meta"
                    color={item.completed ? 'success' : 'muted'}
                    style={styles.statusText}
                  >
                    {item.completed ? 'Выполнено' : 'Не выполнено'}
                  </AppText>
                </View>
                <AppText variant="body" style={styles.readText}>
                  {item.title}
                </AppText>

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
                    onPress={handleToggle}
                    style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}
                  >
                    <Ionicons
                      name={item.completed ? 'refresh-outline' : 'checkmark-circle-outline'}
                      size={20}
                      color={colors.success}
                    />
                    <AppText variant="label">
                      {item.completed ? 'Вернуть в работу' : 'Отметить выполненным'}
                    </AppText>
                  </Pressable>
                  <View style={styles.moveRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Переместить пункт выше"
                      disabled={lockBusy || !canMoveUp}
                      onPress={() => handleMove(-1)}
                      style={({ pressed }) => [
                        styles.actionRow,
                        styles.moveButton,
                        (!canMoveUp || lockBusy) && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Ionicons name="chevron-up" size={20} color={colors.textSecondary} />
                      <AppText variant="label">Выше</AppText>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Переместить пункт ниже"
                      disabled={lockBusy || !canMoveDown}
                      onPress={() => handleMove(1)}
                      style={({ pressed }) => [
                        styles.actionRow,
                        styles.moveButton,
                        (!canMoveDown || lockBusy) && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Ionicons name="chevron-down" size={20} color={colors.textSecondary} />
                      <AppText variant="label">Ниже</AppText>
                    </Pressable>
                  </View>
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
                Пункт не найден.
              </AppText>
            ) : null}
{isEditing ? (
              <View style={styles.editorBlock}>
                <TextInput
                  value={draft}
                  onChangeText={changeDraft}
                  editable={!lockBusy}
                  multiline
                  placeholder="Текст пункта"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  textAlignVertical="top"
                  accessibilityLabel="Текст пункта"
                />
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
  flex: {
    flex: 1,
  },
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
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
  headerCopy: {
    flex: 1,
  },
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
  errorText: {
    textAlign: 'center',
  },
  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 999,
  },
  statusDone: {
    backgroundColor: colors.accentSoft,
  },
  statusPending: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusText: {
    fontWeight: '600',
  },
  readBlock: {
    gap: spacing.lg,
  },
  readText: {
    fontSize: 17,
    lineHeight: 26,
  },
  notFound: {
    paddingVertical: spacing.xxl,
    textAlign: 'center',
  },
  actionStack: {
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
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
  dangerRow: {
    borderColor: 'rgba(239, 113, 134, 0.34)',
  },
  moveRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  moveButton: {
    flex: 1,
  },
  editorBlock: {
    gap: spacing.sm,
  },
  input: {
    minHeight: 120,
    maxHeight: 320,
    padding: spacing.lg,
    borderRadius: radius.input,
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontSize: 17,
    lineHeight: 24,
  },
  validationText: {
    marginTop: spacing.xs,
  },
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
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.72,
  },
});