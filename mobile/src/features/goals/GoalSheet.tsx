import { useEffect, useRef, useState } from 'react';
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
import SegmentedControl from '@/components/SegmentedControl';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { Goal, GoalPeriod } from '@/types/goal';
import { goalDefaultDeadline } from './goalDates';
import type { GoalDraft } from './goalModel';
import type { GoalMutation } from './goalStore';

const periods = [
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'year', label: 'Год' },
] as const;

const messages: Record<string, string> = {
  storage: 'Не удалось сохранить. Черновик остался открыт.',
  stale: 'Цель изменилась. Закройте форму и откройте её снова.',
  busy: 'Сохранение уже идёт.',
  missing: 'Цель больше не существует.',
  title: 'Проверьте название.',
  description: 'Описание слишком длинное.',
  deadline: 'Проверьте срок.',
  progress: 'Прогресс должен быть целым числом от 0 до 100.',
  'not-ready': 'Данные ещё загружаются.',
  'duplicate-id': 'Не удалось создать идентификатор. Повторите попытку.',
  'invalid-snapshot': 'Данные не прошли проверку. Черновик остался открыт.',
  'period-key': 'Дата устройства недоступна.',
  period: 'Проверьте период.',
};

function message(result: GoalMutation): string {
  return result.ok ? '' : (messages[result.reason] ?? 'Не удалось сохранить.');
}

function localDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

type GoalSheetProps = {
  sheetKey: string;
  mode: 'add' | 'read';
  goalId?: string;
  period: GoalPeriod;
  today: string;
  goals: readonly Goal[];
  saving: boolean;
  storeError: string | null;
  isCurrent(): boolean;
  onClose(): void;
  expectedRevision: number;
  onAdd(input: GoalDraft, expectedRevision: number): Promise<GoalMutation>;
  onEdit(id: string, input: GoalDraft, expectedRevision: number): Promise<GoalMutation>;
  onDelete(id: string, expectedRevision: number): Promise<GoalMutation>;
  onComplete(key: string): void;
};

export default function GoalSheet(props: GoalSheetProps) {
  const [entityId, setEntityId] = useState(props.goalId);
  const goal = entityId ? props.goals.find((item) => item.id === entityId) : undefined;
  const initialPeriod = goal?.period ?? props.period;
  const initialDeadline =
    goal?.deadline ?? goalDefaultDeadline(initialPeriod, localDate(props.today)) ?? props.today;
  const initialDraft = {
    title: goal?.title ?? '',
    description: goal?.description ?? '',
    period: initialPeriod,
    deadline: initialDeadline,
    progress: String(goal?.progress ?? 0),
  };

  const [editing, setEditing] = useState(props.mode === 'add');
  const [draft, setDraft] = useState(initialDraft);
  const { title, description, period, deadline, progress } = draft;
  const draftRef = useRef(initialDraft);
  const draftVersion = useRef(0);
  const submitting = useRef(false);
  const identity = useRef({
    sheetInstanceId: props.sheetKey,
    entityId: props.goalId,
    expectedRevision: props.expectedRevision,
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState(initialDraft);
  const locked = busy || props.saving;
  const dirty = editing && JSON.stringify(baseline) !== JSON.stringify(draft);

  // Native input events may already be queued when editable becomes false.
  // Preserve them synchronously and give each accepted draft its own version.
  function changeDraft(patch: Partial<typeof initialDraft>): void {
    if (!mounted.current || !props.isCurrent()) return;
    draftVersion.current += 1;
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
  }

  function close(): void {
    if (submitting.current || !props.isCurrent()) return;
    if (dirty) {
      Alert.alert('Отменить изменения?', 'Несохранённые данные будут потеряны.', [
        { text: 'Продолжить редактирование', style: 'cancel' },
        { text: 'Отменить изменения', style: 'destructive', onPress: () => {
          if (!submitting.current && mounted.current && props.isCurrent()) props.onClose();
        } },
      ]);
      return;
    }
    props.onClose();
  }

  async function save(): Promise<void> {
    if (submitting.current || props.saving || !mounted.current || !props.isCurrent()) return;
    submitting.current = true;
    const submittedIdentity = { ...identity.current };
    const submittedVersion = draftVersion.current;
    const submittedDraft = { ...draftRef.current };
    const value = submittedDraft.progress.trim() === '' ? Number.NaN : Number(submittedDraft.progress);
    const input = { ...submittedDraft, progress: value };
    setBusy(true);
    setError(null);
    try {
      const result = submittedIdentity.entityId
        ? await props.onEdit(submittedIdentity.entityId, input, submittedIdentity.expectedRevision)
        : await props.onAdd(input, submittedIdentity.expectedRevision);
      if (!mounted.current || !props.isCurrent() ||
          identity.current.sheetInstanceId !== submittedIdentity.sheetInstanceId) return;
      if (!result.ok) {
        setError(message(result));
        return;
      }
      // A retained create draft becomes an edit of the row just committed. Only
      // our own successful revision is adopted; external edits still conflict.
      identity.current = {
        ...submittedIdentity,
        entityId: result.id ?? submittedIdentity.entityId,
        expectedRevision: result.revision,
      };
      setEntityId(identity.current.entityId);
      setBaseline(submittedDraft);
      if (draftVersion.current === submittedVersion) {
        props.onComplete(submittedIdentity.sheetInstanceId);
      }
    } catch {
      if (mounted.current && props.isCurrent()) setError('Не удалось сохранить. Черновик остался открыт.');
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function changePeriod(next: GoalPeriod): void {
    if (submitting.current) return;
    changeDraft({ period: next, deadline: goalDefaultDeadline(next, localDate(props.today)) ?? props.today });
  }

  function cancelEdit(): void {
    if (!goal || submitting.current) return;
    changeDraft({ title: goal.title, description: goal.description ?? '', period: goal.period,
      deadline: goal.deadline, progress: String(goal.progress) });
    setError(null);
    setEditing(false);
  }

  function confirmDelete(): void {
    if (!goal || submitting.current || !props.isCurrent()) return;
    const captured = { ...identity.current };
    Alert.alert('Удалить цель?', `«${goal.title}» будет удалена безвозвратно.`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить', style: 'destructive',
        onPress: async () => {
          if (submitting.current || !mounted.current || !props.isCurrent() || !captured.entityId) return;
          submitting.current = true;
          setBusy(true);
          try {
            const result = await props.onDelete(captured.entityId, captured.expectedRevision);
            if (!mounted.current || !props.isCurrent()) return;
            if (result.ok) props.onComplete(captured.sheetInstanceId);
            else setError(message(result));
          } catch {
            if (mounted.current && props.isCurrent()) setError('Не удалось удалить цель. Повторите попытку.');
          } finally {
            submitting.current = false;
            if (mounted.current) setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <AppText variant="section" accessibilityRole="header">
              {goal ? (editing ? 'Изменить цель' : 'Цель') : 'Новая цель'}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              style={styles.headerButton}
              onPress={close}
            >
              <AppText color="muted">Закрыть</AppText>
            </Pressable>
          </View>

          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {props.storeError ? (
              <AppText accessibilityRole="alert" color="danger">
                {props.storeError}
              </AppText>
            ) : null}
            {error ? (
              <AppText accessibilityRole="alert" color="danger">
                {error}
              </AppText>
            ) : null}

            {!editing && goal ? (
              <View style={styles.read}>
                <AppText variant="pageTitle" selectable>
                  {goal.title}
                </AppText>
                {goal.description ? (
                  <AppText color="secondary" selectable>
                    {goal.description}
                  </AppText>
                ) : null}
                <AppText color="secondary">
                  {periods.find((item) => item.value === goal.period)?.label} · срок{' '}
                  {goal.deadline}
                </AppText>
                <AppText accessibilityLabel={`Прогресс ${goal.progress} процентов`}>
                  Прогресс: {goal.progress}% · {goal.completed ? 'Выполнено' : 'В работе'}
                </AppText>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: locked }}
                  disabled={locked}
                  style={styles.action}
                  onPress={() => setEditing(true)}
                >
                  <AppText color="accent">Изменить</AppText>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Удалить цель"
                  accessibilityState={{ disabled: locked }}
                  disabled={locked}
                  style={styles.action}
                  onPress={confirmDelete}
                >
                  <AppText color="danger">Удалить цель</AppText>
                </Pressable>
              </View>
            ) : (
              <View style={styles.form} pointerEvents={locked ? 'none' : 'auto'}>
                <AppText variant="label">Период</AppText>
                <SegmentedControl items={periods} value={period} onChange={changePeriod} />
                <AppText variant="label">Название</AppText>
                <TextInput
                  accessibilityLabel="Название цели"
                  editable={!locked}
                  value={title}
                  onChangeText={(value) => changeDraft({ title: value })}
                  placeholder="Например, закончить проект"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  style={[styles.input, styles.longInput]}
                />
                <AppText variant="label">Описание (необязательно)</AppText>
                <TextInput
                  accessibilityLabel="Описание цели"
                  editable={!locked}
                  value={description}
                  onChangeText={(value) => changeDraft({ description: value })}
                  placeholder="Почему это важно"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  style={[styles.input, styles.bodyInput]}
                />
                <AppText variant="label">Срок (ГГГГ-ММ-ДД)</AppText>
                <TextInput
                  accessibilityLabel="Срок цели"
                  editable={!locked}
                  value={deadline}
                  onChangeText={(value) => changeDraft({ deadline: value })}
                  keyboardType="numbers-and-punctuation"
                  style={styles.input}
                />
                <AppText variant="label">Прогресс, 0–100%</AppText>
                <TextInput
                  accessibilityLabel="Прогресс цели"
                  editable={!locked}
                  value={progress}
                  onChangeText={(value) => changeDraft({ progress: value })}
                  keyboardType="number-pad"
                  style={styles.input}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Сохранить цель"
                  accessibilityState={{ disabled: locked }}
                  disabled={locked}
                  style={[styles.primary, locked && styles.disabled]}
                  onPress={() => void save()}
                >
                  <AppText variant="label">{busy ? 'Сохраняем…' : 'Сохранить'}</AppText>
                </Pressable>
                {goal ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: locked }}
                    disabled={locked}
                    style={styles.action}
                    onPress={cancelEdit}
                  >
                    <AppText color="muted">Отмена</AppText>
                  </Pressable>
                ) : null}
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  header: {
    minHeight: touchTarget,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerButton: {
    minHeight: touchTarget,
    minWidth: touchTarget,
    justifyContent: 'center',
  },
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl, gap: spacing.lg },
  read: { gap: spacing.lg },
  form: { gap: spacing.md },
  input: {
    minHeight: touchTarget,
    borderRadius: radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontSize: 17,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  longInput: { minHeight: 72 },
  bodyInput: { minHeight: 150, textAlignVertical: 'top' },
  primary: {
    minHeight: touchTarget,
    borderRadius: radius.input,
    backgroundColor: colors.surfaceSelected,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
  },
  action: { minHeight: touchTarget, justifyContent: 'center' },
  disabled: { opacity: 0.45 },
});
