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
import type { Idea, IdeaStatus } from '@/types/idea';
import {
  allowDelayedConfirmation,
  createRecordsSheetLock,
  ideaDraftDirty,
  isDraftUnchanged,
  type IdeaDraft,
  type RecordsSheetLock,
} from '../records/recordsSheetGuard';
import {
  DEFAULT_IDEA_CATEGORY,
  DEFAULT_IDEA_STATUS,
  IDEA_CATEGORY_LABELS,
  IDEA_STATUS_LABELS,
  ideaCategoryOptions,
  ideaStatusOptions,
  type IdeaInput,
} from './ideaModel';
import type { IdeaMutationResult } from './ideaStore';

export type IdeaSheetMode = 'add' | 'read' | 'edit';

/** What the finished operation was, so the parent can reveal/clear correctly. */
export type IdeaCompletionOutcome =
  | { action: 'created' }
  | { action: 'saved'; id: string }
  | { action: 'deleted'; id: string };

type IdeaSheetProps = {
  /** Deterministic identity shared with the parent's open-sheet state. */
  sheetKey: string;
  mode: IdeaSheetMode;
  ideaId?: string;
  ideas: readonly Idea[];
  saving: boolean;
  storeError: string | null;
  /** Close request; the parent applies it only for the CURRENT sheet key. */
  onClose: (sheetKey: string) => void;
  /** True while THIS sheet is still the current one (parent-owned identity). */
  isCurrent: () => boolean;
  /** Close/reveal after a successful mutation, guarded by sheet identity. */
  onSaveComplete: (sheetKey: string, outcome: IdeaCompletionOutcome) => void;
  onAdd: (input: IdeaInput) => Promise<IdeaMutationResult>;
  onEdit: (id: string, input: IdeaInput) => Promise<IdeaMutationResult>;
  onSetStatus: (id: string, status: IdeaStatus) => Promise<IdeaMutationResult>;
  onRemove: (id: string) => Promise<IdeaMutationResult>;
};

const REASON_MESSAGES: Record<string, string> = {
  validation: 'Проверьте поля идеи.',
  missing: 'Идея не найдена.',
  'title-blank': 'Введите название идеи.',
  'title-too-long': 'Слишком длинное название — максимум 300 знаков.',
  'description-too-long': 'Слишком длинное описание — максимум 2000 знаков.',
  'not-ready': 'Идеи ещё загружаются. Повторите попытку.',
  busy: 'Дождитесь завершения предыдущего действия.',
  storage: 'Не удалось сохранить. Черновик сохранён — повторите попытку.',
};

function messageFor(result: IdeaMutationResult): string {
  if (result.ok) return '';
  return REASON_MESSAGES[result.reason] ?? 'Проверьте поля идеи.';
}

function draftFromIdea(idea: Idea | null): IdeaDraft {
  return {
    title: idea?.title ?? '',
    description: idea?.description ?? '',
    category: idea?.category ?? DEFAULT_IDEA_CATEGORY,
    status: idea?.status ?? DEFAULT_IDEA_STATUS,
  };
}
/**
 * Full-screen native ideas sheet. Read mode resolves the idea live from the
 * committed store and offers a quick status change (web inline select) without
 * leaving the sheet or changing its position. Save, status change and delete
 * share one synchronous busy lock; dirty dismissal is confirmed; a stale
 * completion can never close a newer sheet because the parent compares
 * `sheetKey`.
 */
export default function IdeaSheet({
  sheetKey,
  mode: initialMode,
  ideaId,
  ideas,
  saving,
  storeError,
  onClose,
  isCurrent,
  onSaveComplete,
  onAdd,
  onEdit,
  onSetStatus,
  onRemove,
}: IdeaSheetProps) {
  const idea = ideaId ? ideas.find((item) => item.id === ideaId) ?? null : null;
  const [innerMode, setInnerMode] = useState<IdeaSheetMode>(initialMode);
  const [draft, setDraft] = useState<IdeaDraft>(() => draftFromIdea(idea));
  const [initialDraft, setInitialDraft] = useState<IdeaDraft>(() => draftFromIdea(idea));
  const [validation, setValidation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lockRef = useRef<RecordsSheetLock | null>(null);
  const lock = (lockRef.current ??= createRecordsSheetLock());
  const draftRevisionRef = useRef(0);

  const lockBusy = busy || saving;
  const isEditing = innerMode === 'add' || innerMode === 'edit';
  const headerTitle =
    innerMode === 'read' ? 'Идея' : innerMode === 'edit' ? 'Изменение идеи' : 'Новая идея';

  function change<K extends keyof IdeaDraft>(field: K, value: IdeaDraft[K]): void {
    draftRevisionRef.current += 1;
    setDraft((current) => ({ ...current, [field]: value }));
    if (validation) setValidation(null);
  }

  function startEdit(): void {
    if (!idea || lock.isBusy()) return;
    const snapshot = draftFromIdea(idea);
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
    if (!ideaDraftDirty(draft, initialDraft)) {
      onClose(sheetKey);
      return;
    }
    const revisionAtConfirm = draftRevisionRef.current;
    Alert.alert('Отменить изменения?', 'Несохранённые данные будут потеряны.', [
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
      const input: IdeaInput = {
        title: draft.title,
        description: draft.description,
        category: draft.category,
        status: draft.status,
        // Only fields the user actually changed are validated/normalized.
        changed: {
          title: draft.title !== initialDraft.title,
          description: draft.description !== initialDraft.description,
          category: draft.category !== initialDraft.category,
          status: draft.status !== initialDraft.status,
        },
      };
      const isCreate = innerMode === 'add' || !ideaId;
      const result = isCreate ? await onAdd(input) : await onEdit(ideaId, input);
      if (result.ok) {
        if (isDraftUnchanged(draftRevisionRef.current, revisionAtSave)) {
          onSaveComplete(
            sheetKey,
            isCreate ? { action: 'created' } : { action: 'saved', id: ideaId as string },
          );
        }
        return;
      }
      setValidation(messageFor(result));
    } finally {
      lock.release();
      setBusy(false);
    }
  }

  async function handleStatus(next: IdeaStatus): Promise<void> {
    if (!idea || lock.isBusy()) return;
    if (!isCurrent()) return; // a superseded sheet never writes
    if (!lock.acquire()) return;
    setBusy(true);
    try {
      const result = await onSetStatus(idea.id, next);
      setValidation(result.ok ? null : messageFor(result));
    } finally {
      lock.release();
      setBusy(false);
    }
  }

  function requestDelete(): void {
    if (!idea || lock.isBusy()) return;
    const targetId = idea.id;
    const revisionAtConfirm = draftRevisionRef.current;
    Alert.alert('Удалить идею?', `«${idea.title}» будет удалена безвозвратно.`, [
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
                {innerMode === 'add'
                  ? 'Новая идея'
                  : idea
                    ? IDEA_CATEGORY_LABELS[idea.category]
                    : ''}
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

            {innerMode === 'read' && idea ? (
              <View style={styles.readBlock}>
                <View style={styles.badgeRow}>
                  <View style={styles.badge}>
                    <AppText variant="meta" color="accent">
                      {IDEA_CATEGORY_LABELS[idea.category]}
                    </AppText>
                  </View>
                  <View style={styles.badge}>
                    <AppText variant="meta" color="secondary">
                      {IDEA_STATUS_LABELS[idea.status]}
                    </AppText>
                  </View>
                </View>
                <AppText variant="body" style={styles.readTitle}>
                  {idea.title}
                </AppText>
                {idea.description !== undefined && idea.description.trim().length > 0 ? (
                  <AppText variant="body" color="secondary" selectable style={styles.readBody}>
                    {idea.description}
                  </AppText>
                ) : null}

                <View style={styles.fieldGroup}>
                  <AppText variant="label" color="secondary">
                    Статус
                  </AppText>
                  <View style={styles.chipRow}>
                    {ideaStatusOptions.map((status) => {
                      const selected = idea.status === status;
                      return (
                        <Pressable
                          key={status}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          disabled={lockBusy}
                          onPress={() => void handleStatus(status)}
                          style={({ pressed }) => [
                            styles.chip,
                            selected && styles.chipSelected,
                            pressed && styles.pressed,
                          ]}
                        >
                          <AppText variant="label" color={selected ? 'primary' : 'muted'}>
                            {IDEA_STATUS_LABELS[status]}
                          </AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

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

            {innerMode === 'read' && !idea ? (
              <AppText variant="body" color="secondary" style={styles.notFound}>
                Идея не найдена.
              </AppText>
            ) : null}

            {isEditing ? (
              <View style={styles.editorBlock}>
                <TextInput
                  value={draft.title}
                  onChangeText={(value) => change('title', value)}
                  editable={!lockBusy}
                  placeholder="Название идеи"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  accessibilityLabel="Название идеи"
                />
                <TextInput
                  value={draft.description}
                  onChangeText={(value) => change('description', value)}
                  editable={!lockBusy}
                  multiline
                  scrollEnabled
                  placeholder="Описание (необязательно)"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, styles.descriptionInput]}
                  textAlignVertical="top"
                  accessibilityLabel="Описание идеи"
                />

                <View style={styles.fieldGroup}>
                  <AppText variant="label" color="secondary">
                    Категория
                  </AppText>
                  <View style={styles.chipRow}>
                    {ideaCategoryOptions.map((category) => {
                      const selected = draft.category === category;
                      return (
                        <Pressable
                          key={category}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          disabled={lockBusy}
                          onPress={() => change('category', category)}
                          style={({ pressed }) => [
                            styles.chip,
                            selected && styles.chipSelected,
                            pressed && styles.pressed,
                          ]}
                        >
                          <AppText variant="label" color={selected ? 'primary' : 'muted'}>
                            {IDEA_CATEGORY_LABELS[category]}
                          </AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.fieldGroup}>
                  <AppText variant="label" color="secondary">
                    Статус
                  </AppText>
                  <View style={styles.chipRow}>
                    {ideaStatusOptions.map((status) => {
                      const selected = draft.status === status;
                      return (
                        <Pressable
                          key={status}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          disabled={lockBusy}
                          onPress={() => change('status', status)}
                          style={({ pressed }) => [
                            styles.chip,
                            selected && styles.chipSelected,
                            pressed && styles.pressed,
                          ]}
                        >
                          <AppText variant="label" color={selected ? 'primary' : 'muted'}>
                            {IDEA_STATUS_LABELS[status]}
                          </AppText>
                        </Pressable>
                      );
                    })}
                  </View>
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

            {!isEditing && validation ? (
              <View accessibilityRole="alert">
                <AppText variant="meta" color="danger" style={styles.validationText}>
                  {validation}
                </AppText>
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
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 999,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  readBlock: { gap: spacing.lg },
  readTitle: { fontSize: 20, lineHeight: 28, fontWeight: '600' },
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
  // Bounded, scroll-enabled description field (long text stays editable).
  descriptionInput: { minHeight: 140, maxHeight: 280 },
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
