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
import type { JournalEntry } from '@/types/journal';
import { formatJournalFullDate } from '../records/recordsDates';
import {
  allowDelayedConfirmation,
  createRecordsSheetLock,
  isDraftUnchanged,
  journalDraftDirty,
  type JournalDraft,
  type RecordsSheetLock,
} from '../records/recordsSheetGuard';
import { MOOD_CHOICES } from './journalSelectors';
import type { JournalEntryInput } from './journalModel';
import type { JournalMutationResult } from './journalStore';

export type JournalSheetMode = 'add' | 'read' | 'edit';

/** What the finished operation was, so the parent can reveal/clear correctly. */
export type JournalCompletionOutcome =
  | { action: 'created' }
  | { action: 'saved'; id: string }
  | { action: 'deleted'; id: string };

type JournalSheetProps = {
  /** Deterministic identity shared with the parent's open-sheet state. */
  sheetKey: string;
  mode: JournalSheetMode;
  entryId?: string;
  /** Captured local date for a new entry. */
  targetDate?: string;
  entries: readonly JournalEntry[];
  saving: boolean;
  storeError: string | null;
  /** Close request; the parent applies it only for the CURRENT sheet key. */
  onClose: (sheetKey: string) => void;
  /** True while THIS sheet is still the current one (parent-owned identity). */
  isCurrent: () => boolean;
  /** Close/reveal after a successful CREATE/DELETE, guarded by sheet identity. */
  onSaveComplete: (sheetKey: string, outcome: JournalCompletionOutcome) => void;
  /**
   * A successful EDIT stays in the sheet: the sheet returns to the reader and the
   * parent may only reveal/clear for the CURRENT identity (never close it).
   */
  onEditSaved: (sheetKey: string, entryId: string) => void;
  onAdd: (input: JournalEntryInput, date: string) => Promise<JournalMutationResult>;
  onEdit: (id: string, input: JournalEntryInput) => Promise<JournalMutationResult>;
  onRemove: (id: string) => Promise<JournalMutationResult>;
};

const BLANK_BODY = 'Введите текст записи.';

const REASON_MESSAGES: Record<string, string> = {
  validation: 'Проверьте поля записи.',
  missing: 'Запись не найдена.',
  'not-ready': 'Записи ещё загружаются. Повторите попытку.',
  busy: 'Дождитесь завершения предыдущего действия.',
  storage: 'Не удалось сохранить. Черновик сохранён — повторите попытку.',
  'body-blank': BLANK_BODY,
  'title-too-long': 'Слишком длинный заголовок — максимум 300 знаков.',
  'mood-too-long': 'Слишком длинное настроение — максимум 60 знаков.',
  'tags-too-many': 'Слишком много тегов — максимум 20.',
  'tag-too-long': 'Слишком длинный тег — максимум 40 знаков.',
};

function messageFor(result: JournalMutationResult): string {
  if (result.ok) return '';
  return REASON_MESSAGES[result.reason] ?? 'Проверьте поля записи.';
}

function draftFromEntry(entry: JournalEntry | null): JournalDraft {
  return {
    title: entry?.title ?? '',
    body: entry?.body ?? '',
    mood: entry?.mood ?? '',
    tags: (entry?.tags ?? []).join(', '),
  };
}
/**
 * Full-screen native journal sheet.
 *
 * Read mode resolves the entry live from the committed store by ID (never a
 * stale preview copy) and shows the real body, selectable and scrollable.
 * Add/edit keep the draft until a write succeeds; every field is covered by
 * dirty-close protection and save/delete share one synchronous busy lock, so a
 * dismiss/save cannot race a pending write. A stale completion can never close a
 * newer sheet because the parent compares `sheetKey`.
 */
export default function JournalSheet({
  sheetKey,
  mode: initialMode,
  entryId,
  targetDate,
  entries,
  saving,
  storeError,
  onClose,
  isCurrent,
  onSaveComplete,
  onEditSaved,
  onAdd,
  onEdit,
  onRemove,
}: JournalSheetProps) {
  const entry = entryId ? entries.find((item) => item.id === entryId) ?? null : null;
  const [innerMode, setInnerMode] = useState<JournalSheetMode>(initialMode);
  const [draft, setDraft] = useState<JournalDraft>(() => draftFromEntry(entry));
  const [initialDraft, setInitialDraft] = useState<JournalDraft>(() => draftFromEntry(entry));
  const [validation, setValidation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lockRef = useRef<RecordsSheetLock | null>(null);
  const lock = (lockRef.current ??= createRecordsSheetLock());
  const draftRevisionRef = useRef(0);

  const lockBusy = busy || saving;
  const isEditing = innerMode === 'add' || innerMode === 'edit';
  const date = innerMode === 'add' ? targetDate ?? '' : entry?.date ?? targetDate ?? '';
  const headerTitle =
    innerMode === 'read' ? 'Запись' : innerMode === 'edit' ? 'Изменение записи' : 'Новая запись';

  function change<K extends keyof JournalDraft>(field: K, value: JournalDraft[K]): void {
    draftRevisionRef.current += 1;
    setDraft((current) => ({ ...current, [field]: value }));
    if (validation) setValidation(null);
  }

  function toggleMood(choice: string): void {
    change('mood', draft.mood === choice ? '' : choice);
  }

  function startEdit(): void {
    if (!entry || lock.isBusy()) return;
    const snapshot = draftFromEntry(entry);
    setDraft(snapshot);
    setInitialDraft(snapshot);
    setValidation(null);
    setInnerMode('edit');
  }

  function requestClose(): void {
    if (lock.isBusy()) return;
    if (innerMode === 'read') {
      onClose(sheetKey);
      return;
    }
    if (!journalDraftDirty(draft, initialDraft)) {
      onClose(sheetKey);
      return;
    }
    const revisionAtConfirm = draftRevisionRef.current;
    Alert.alert('Отменить изменения?', 'Несохранённый текст будет потерян.', [
      { text: 'Остаться', style: 'cancel' },
      {
        text: 'Отменить',
        style: 'destructive',
        // Delayed callback: re-check identity, revision and busy state.
        onPress: () => {
          if (
            !allowDelayedConfirmation({
              stillCurrent: isCurrent(),
              busy: lock.isBusy(),
              revisionAtConfirm,
              revisionNow: draftRevisionRef.current,
            })
          ) {
            return;
          }
          onClose(sheetKey);
        },
      },
    ]);
  }

  async function handleSave(): Promise<void> {
    if (lock.isBusy()) return;
    const revisionAtSave = draftRevisionRef.current;
    if (!lock.acquire()) return;
    setBusy(true);
    try {
      const input: JournalEntryInput = {
        title: draft.title,
        body: draft.body,
        mood: draft.mood,
        tags: draft.tags,
        // Only fields the user actually changed are validated/normalized.
        changed: {
          title: draft.title !== initialDraft.title,
          body: draft.body !== initialDraft.body,
          mood: draft.mood !== initialDraft.mood,
          tags: draft.tags !== initialDraft.tags,
        },
      };
      const isCreate = innerMode === 'add' || !entryId;
      const result = isCreate ? await onAdd(input, date) : await onEdit(entryId, input);
      if (result.ok) {
        if (!isDraftUnchanged(draftRevisionRef.current, revisionAtSave)) return;
        if (isCreate) {
          onSaveComplete(sheetKey, { action: 'created' });
          return;
        }
        // A successful edit returns to this entry's reader (content re-derives
        // from the committed store on the next render) instead of closing.
        setInnerMode('read');
        onEditSaved(sheetKey, entryId as string);
        return;
      }
      setValidation(messageFor(result));
    } finally {
      lock.release();
      setBusy(false);
    }
  }

  function requestDelete(): void {
    if (!entry || lock.isBusy()) return;
    const targetId = entry.id;
    const label = entry.title?.trim() || formatJournalFullDate(entry.date) || 'запись';
    const revisionAtConfirm = draftRevisionRef.current;
    Alert.alert('Удалить запись?', `«${label}» будет удалена безвозвратно.`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          // Delayed callback: never mutate/close once another sheet is current.
          if (
            !allowDelayedConfirmation({
              stillCurrent: isCurrent(),
              busy: lock.isBusy(),
              revisionAtConfirm,
              revisionNow: draftRevisionRef.current,
            })
          ) {
            return;
          }
          if (!lock.acquire()) return;
          setBusy(true);
          try {
            const result = await onRemove(targetId);
            if (result.ok) onSaveComplete(sheetKey, { action: 'deleted', id: targetId });
            else setValidation(messageFor(result));
          } finally {
            lock.release();
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={requestClose}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <AppText variant="meta" color="muted">
                {date ? formatJournalFullDate(date) : ''}
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
            keyboardDismissMode="interactive"
          >
            {storeError ? (
              <View accessibilityRole="alert" style={styles.errorBanner}>
                <AppText variant="meta" color="danger" style={styles.errorText}>
                  {storeError}
                </AppText>
              </View>
            ) : null}

            {innerMode === 'read' && entry ? (
              <View style={styles.readBlock}>
                {entry.title !== undefined && entry.title.trim().length > 0 ? (
                  <AppText variant="body" style={styles.readTitle}>
                    {entry.title}
                  </AppText>
                ) : null}
                <View style={styles.readMeta}>
                  <AppText variant="meta" color="muted">
                    {formatJournalFullDate(entry.date)}
                  </AppText>
                  {entry.mood !== undefined && entry.mood.trim().length > 0 ? (
                    <AppText variant="meta" color="accent">
                      {entry.mood}
                    </AppText>
                  ) : null}
                  {entry.tags.length > 0 ? (
                    <AppText variant="meta" color="muted">
                      {entry.tags.map((tag) => `#${tag}`).join(' ')}
                    </AppText>
                  ) : null}
                </View>
                {entry.body.length > 0 ? (
                  <AppText variant="body" selectable style={styles.readBody}>
                    {entry.body}
                  </AppText>
                ) : (
                  <AppText variant="body" color="muted">
                    Текст не заполнен.
                  </AppText>
                )}
                {(entry.media ?? []).length > 0 ? (
                  <AppText variant="meta" color="muted" style={styles.mediaNote}>
                    Во вложении {entry.media?.length} файл(а). Воспроизведение появится
                    в следующем обновлении — метаданные сохранены.
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

            {innerMode === 'read' && !entry ? (
              <AppText variant="body" color="secondary" style={styles.notFound}>
                Запись не найдена.
              </AppText>
            ) : null}

            {isEditing ? (
              <View style={styles.editorBlock}>
                <TextInput
                  value={draft.title}
                  onChangeText={(value) => change('title', value)}
                  editable={!lockBusy}
                  placeholder="Заголовок (необязательно)"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  accessibilityLabel="Заголовок записи"
                />

                <TextInput
                  value={draft.body}
                  onChangeText={(value) => change('body', value)}
                  editable={!lockBusy}
                  multiline
                  scrollEnabled
                  placeholder="Что происходит?"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, styles.bodyInput]}
                  textAlignVertical="top"
                  accessibilityLabel="Текст записи"
                />

                <View style={styles.fieldGroup}>
                  <AppText variant="label" color="secondary">
                    Настроение
                  </AppText>
                  <View style={styles.chipRow}>
                    {MOOD_CHOICES.map((choice) => {
                      const selected = draft.mood === choice;
                      return (
                        <Pressable
                          key={choice}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          disabled={lockBusy}
                          onPress={() => toggleMood(choice)}
                          style={({ pressed }) => [
                            styles.chip,
                            selected && styles.chipSelected,
                            pressed && styles.pressed,
                          ]}
                        >
                          <AppText variant="label" color={selected ? 'primary' : 'muted'}>
                            {choice}
                          </AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                  {draft.mood.length > 0 &&
                  !MOOD_CHOICES.includes(draft.mood as (typeof MOOD_CHOICES)[number]) ? (
                    <AppText variant="meta" color="muted">
                      Сохранённое настроение: {draft.mood}
                    </AppText>
                  ) : null}
                </View>

                <TextInput
                  value={draft.tags}
                  onChangeText={(value) => change('tags', value)}
                  editable={!lockBusy}
                  placeholder="Теги через запятую"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  style={styles.input}
                  accessibilityLabel="Теги записи"
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
                <AppText variant="label">Сохранить</AppText>
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
  readBody: { lineHeight: 26 },
  mediaNote: { lineHeight: 18 },
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
  // Bounded, scroll-enabled field: a 100k-character body stays editable with a
  // reachable caret instead of building an unbounded native layout.
  bodyInput: { minHeight: 180, maxHeight: 320 },
  fieldGroup: { gap: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipSelected: {
    backgroundColor: colors.surfaceSelected,
    borderColor: colors.accentSoft,
  },
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
  saveButton: { backgroundColor: colors.surfaceSelected, borderColor: colors.accentSoft },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
});
