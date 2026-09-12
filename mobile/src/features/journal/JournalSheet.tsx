import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import MediaAttachmentCard from './media/MediaAttachmentCard';
import { claimActivePlayback, clearActivePlayback } from './media/activePlayback';
import MediaRecorderOverlay, { type RecorderKind } from './media/MediaRecorderOverlay';
import { failureMessage, type DraftIdentity, type LocalMediaDraft } from '@/services/media/mediaContracts';
import {
  abandonStagedDrafts,
  leaseDraftMedia,
  registerJournalDraftOwner,
} from '@/services/media/journalMediaRuntime';
import type { CoordinatorOutcome } from '@/services/media/journalMediaCoordinator';

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
  /** Media-owning mutations are orchestrated by the journal media coordinator. */
  onCommitMediaCreate: (
    owner: DraftIdentity,
    input: JournalEntryInput,
    date: string,
    drafts: readonly LocalMediaDraft[],
  ) => Promise<CoordinatorOutcome>;
  onCommitMediaEdit: (
    owner: DraftIdentity,
    entryId: string,
    input: JournalEntryInput,
    change: { add: readonly LocalMediaDraft[]; removeIds?: readonly string[] },
  ) => Promise<CoordinatorOutcome>;
  onRemoveMedia: (entryId: string, mediaId: string) => Promise<CoordinatorOutcome>;
  onDeleteEntryWithMedia: (entryId: string) => Promise<CoordinatorOutcome>;
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
  onCommitMediaCreate,
  onCommitMediaEdit,
  onRemoveMedia,
  onDeleteEntryWithMedia,
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
  /** Prepared takes that will be committed with this draft, in order. */
  const [staged, setStaged] = useState<LocalMediaDraft[]>([]);
  /** Synchronous mirror of `staged` for the unmount cleanup path. */
  const stagedRef = useRef<LocalMediaDraft[]>([]);
  /** Committed attachments staged for removal by the next successful save. */
  const [removedMediaIds, setRemovedMediaIds] = useState<string[]>([]);
  const [recorderKind, setRecorderKind] = useState<RecorderKind | null>(null);
  /** Session id of the recorder THIS sheet opened (recorded at open time). */
  const recorderSessionRef = useRef<string | null>(null);
  const [activeMediaId, setActiveMediaId] = useState<string | null>(null);

  /**
   * Live sheet-level identity, published SYNCHRONOUSLY by the handlers that
   * change it (never read during render), so the coordinator can refuse a
   * superseded sheet or a changed draft revision.
   */
  function syncDraftOwner(): void {
    registerJournalDraftOwner({
      sheetKey,
      entryId: entryId ?? null,
      draftKey: sheetKey,
      draftRevision: draftRevisionRef.current,
    });
  }
  const getDraftIdentity = useCallback(
    (): DraftIdentity => ({
      sheetKey,
      entryId: entryId ?? null,
      draftKey: sheetKey,
      draftRevision: draftRevisionRef.current,
    }),
    [entryId, sheetKey],
  );
  function commitStaged(next: LocalMediaDraft[]): void {
    stagedRef.current = next;
    setStaged(next);
  }

  useEffect(() => {
    syncDraftOwner();
    return () => {
      registerJournalDraftOwner(null);
      // A closed/abandoned draft must not leak its uncommitted staging files.
      void abandonStagedDrafts(stagedRef.current);
      stagedRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity fields are stable per sheet
  }, []);

  const mediaDirty = staged.length > 0 || removedMediaIds.length > 0;
  const entryMedia = (entry?.media ?? []).filter((item) => !removedMediaIds.includes(item.id));

  const lockBusy = busy || saving;
  const isEditing = innerMode === 'add' || innerMode === 'edit';
  const date = innerMode === 'add' ? targetDate ?? '' : entry?.date ?? targetDate ?? '';
  const headerTitle =
    innerMode === 'read' ? 'Запись' : innerMode === 'edit' ? 'Изменение записи' : 'Новая запись';

  function change<K extends keyof JournalDraft>(field: K, value: JournalDraft[K]): void {
    draftRevisionRef.current += 1;
    syncDraftOwner();
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
    syncDraftOwner();
    setInnerMode('edit');
  }

  /** Stage a committed attachment removal; it applies on the next Save. */
  function stageAttachmentRemoval(mediaId: string): void {
    if (lock.isBusy()) return;
    const revisionAtConfirm = draftRevisionRef.current;
    Alert.alert('Убрать вложение?', 'Файл удалится после сохранения записи.', [
      { text: 'Остаться', style: 'cancel' },
      {
        text: 'Убрать',
        style: 'destructive',
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
          draftRevisionRef.current += 1;
          syncDraftOwner();
          setRemovedMediaIds((current) =>
            current.includes(mediaId) ? current : [...current, mediaId],
          );
        },
      },
    ]);
  }

  /** Reader action: attachment deletion commits immediately, reader stays open. */
  function requestAttachmentDelete(mediaId: string): void {
    if (!entry || lock.isBusy()) return;
    const targetId = entry.id;
    const revisionAtConfirm = draftRevisionRef.current;
    Alert.alert('Удалить вложение?', 'Файл будет удалён с этого устройства.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
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
            const outcome = await onRemoveMedia(targetId, mediaId);
            if (!outcome.ok) setValidation(failureMessage(outcome.failure.code));
            else if (outcome.cleanup.failed.length > 0) {
              // The metadata removal is committed; the leftover file is retryable.
              setValidation('Вложение убрано, но файл не удалось удалить. Повторите позже.');
            }
          } finally {
            lock.release();
            setBusy(false);
          }
        },
      },
    ]);
  }

  function removeStaged(mediaId: string): void {
    if (lock.isBusy()) return;
    draftRevisionRef.current += 1;
    syncDraftOwner();
    const removedDraft = stagedRef.current.find((draft) => draft.id === mediaId);
    commitStaged(stagedRef.current.filter((draft) => draft.id !== mediaId));
    // Only this abandoned take's own files (never a committed object); the
    // abandonment releases its lease and stays retryable on failure.
    if (removedDraft) void abandonStagedDrafts([removedDraft]);
  }

  function requestClose(): void {
    if (lock.isBusy()) return;
    if (innerMode === 'read') {
      onClose(sheetKey);
      return;
    }
    if (!journalDraftDirty(draft, initialDraft) && !mediaDirty) {
      onClose(sheetKey);
      return;
    }
    const revisionAtConfirm = draftRevisionRef.current;
    // Discarding a draft also abandons its uncommitted takes.
    Alert.alert('Отменить изменения?', 'Несохранённые текст и вложения будут потеряны.', [
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
      const owner: DraftIdentity = { ...getDraftIdentity(), draftRevision: revisionAtSave };
      const adds = staged;
      const removes = removedMediaIds;

      if (isCreate && adds.length > 0) {
        // Text + all prepared attachments commit in ONE journal write.
        const outcome = await onCommitMediaCreate(owner, input, date, adds);
        if (!outcome.ok) {
          setValidation(failureMessage(outcome.failure.code));
          return;
        }
      } else if (!isCreate && (adds.length > 0 || removes.length > 0)) {
        const outcome = await onCommitMediaEdit(owner, entryId as string, input, {
          add: adds,
          removeIds: removes,
        });
        if (!outcome.ok) {
          setValidation(failureMessage(outcome.failure.code));
          return;
        }
        if (outcome.cleanup.failed.length > 0) {
          setValidation('Запись сохранена, но файл вложения не удалось удалить. Повторите позже.');
        }
      } else {
        const result = isCreate ? await onAdd(input, date) : await onEdit(entryId as string, input);
        if (!result.ok) {
          setValidation(messageFor(result));
          return;
        }
      }

      if (!isDraftUnchanged(draftRevisionRef.current, revisionAtSave)) return;
      // Committed: the store now references these ids, so they are never discarded.
      commitStaged([]);
      setRemovedMediaIds([]);
      if (isCreate) {
        onSaveComplete(sheetKey, { action: 'created' });
        return;
      }
      // A successful edit returns to this entry's reader (content re-derives
      // from the committed store on the next render) instead of closing.
      setInnerMode('read');
      onEditSaved(sheetKey, entryId as string);
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
            const outcome = await onDeleteEntryWithMedia(targetId);
            if (outcome.ok) onSaveComplete(sheetKey, { action: 'deleted', id: targetId });
            else setValidation(failureMessage(outcome.failure.code));
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
                {entryMedia.length > 0 ? (
                  <View style={styles.attachmentList}>
                    {entryMedia.map((item) => (
                      <MediaAttachmentCard
                        key={item.id}
                        kind={item.type}
                        media={item}
                        active={activeMediaId === item.id}
                        onActivate={() => setActiveMediaId((current) => claimActivePlayback(current, item.id))}
                        onFinished={() => setActiveMediaId((current) => clearActivePlayback(current, item.id))}
                        onRemove={() => requestAttachmentDelete(item.id)}
                      />
                    ))}
                  </View>
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

                <View style={styles.fieldGroup}>
                  <AppText variant="label" color="secondary">
                    Вложения
                  </AppText>
                  {entryMedia.length > 0 ? (
                    <AppText variant="meta" color="muted">
                      Отмеченные вложения удалятся после сохранения.
                    </AppText>
                  ) : null}
                  <View style={styles.attachmentList}>
                    {staged.map((draftMedia) => (
                      <MediaAttachmentCard
                        key={draftMedia.id}
                        staged
                        kind={draftMedia.kind}
                        media={{
                          id: draftMedia.id,
                          kind: draftMedia.kind,
                          mimeType: draftMedia.mimeType,
                          sizeBytes: draftMedia.sizeBytes,
                          durationMs: draftMedia.durationMs,
                        }}
                        active={false}
                        onActivate={() => undefined}
                        onFinished={() => undefined}
                        onRemove={() => removeStaged(draftMedia.id)}
                      />
                    ))}
                    {entryMedia.map((item) => (
                      <MediaAttachmentCard
                        key={item.id}
                        kind={item.type}
                        media={item}
                        active={activeMediaId === item.id}
                        onActivate={() => setActiveMediaId((current) => claimActivePlayback(current, item.id))}
                        onFinished={() => setActiveMediaId((current) => clearActivePlayback(current, item.id))}
                        onRemove={() => stageAttachmentRemoval(item.id)}
                      />
                    ))}
                  </View>
                  <View style={styles.chipRow}>
                    {(['audio', 'video'] as const).map((kind) => (
                      <Pressable
                        key={kind}
                        accessibilityRole="button"
                        accessibilityLabel={kind === 'audio' ? 'Записать аудио' : 'Записать видео'}
                        disabled={lockBusy}
                        onPress={() => setRecorderKind(kind)}
                        style={({ pressed }) => [
                          styles.chip,
                          pressed && styles.pressed,
                          lockBusy && styles.disabled,
                        ]}
                      >
                        <Ionicons
                          name={kind === 'audio' ? 'mic-outline' : 'videocam-outline'}
                          size={16}
                          color={colors.textSecondary}
                        />
                        <AppText variant="label">{kind === 'audio' ? 'Аудио' : 'Видео'}</AppText>
                      </Pressable>
                    ))}
                  </View>
                  <AppText variant="meta" color="muted">
                    Аудио до 15 минут, видео до 10 минут. Файлы хранятся на устройстве.
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
                <AppText variant="label">Сохранить</AppText>
              </Pressable>
            </View>
          ) : null}
        </KeyboardAvoidingView>

        {recorderKind ? (
          <MediaRecorderOverlay
            visible
            kind={recorderKind}
            getIdentity={getDraftIdentity}
            // Synchronous authoritative sources: the parent's current-sheet ref and
            // the sheet's own busy lock (never a rendered flag that lags a frame).
            isEditorBusy={() => lock.isBusy() || saving}
            isCurrent={() => isCurrent()}
            onSessionOpened={(sessionId) => {
              recorderSessionRef.current = sessionId;
            }}
            onUse={(media) => {
              // Identity gate: the completion must belong to THIS sheet AND to the
              // recorder session this sheet opened. A stale recorder (its editor
              // replaced, or a newer session opened) must never attach its take to
              // a newer draft — it is cleaned instead.
              const expectedSession = recorderSessionRef.current;
              if (
                !isCurrent() ||
                expectedSession === null ||
                expectedSession !== media.owner.sessionId ||
                media.owner.sheetKey !== sheetKey ||
                media.owner.draftKey !== sheetKey
              ) {
                void abandonStagedDrafts([media]);
                return;
              }
              // The take joins THIS draft synchronously and bumps its revision.
              draftRevisionRef.current += 1;
              syncDraftOwner();
              // A loaded, unsaved take is protected from sweeps while it waits.
              leaseDraftMedia(media);
              commitStaged([...stagedRef.current, media]);
              setRecorderKind(null);
            }}
            onCancel={() => setRecorderKind(null)}
          />
        ) : null}
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
  attachmentList: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
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
