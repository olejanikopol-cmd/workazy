import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import AppText from '@/components/AppText';
import Card from '@/components/Card';
import Screen from '@/components/Screen';
import SegmentedControl from '@/components/SegmentedControl';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { Idea, IdeaCategory, IdeaStatus } from '@/types/idea';
import type { JournalEntry } from '@/types/journal';
import IdeaRow from '../ideas/IdeaRow';
import IdeaSheet, { type IdeaCompletionOutcome } from '../ideas/IdeaSheet';
import {
  IDEA_CATEGORY_LABELS,
  IDEA_STATUS_LABELS,
  filterIdeas,
  ideaCategoryOptions,
  ideaStatusOptions,
  type IdeaFilters,
  type IdeaInput,
} from '../ideas/ideaModel';
import { ideaStore, useIdeaStore } from '../ideas/useIdeaStore';
import JournalEntryRow from '../journal/JournalEntryRow';
import JournalSheet, { type JournalCompletionOutcome } from '../journal/JournalSheet';
import type { JournalEntryInput } from '../journal/journalModel';
import { historyOrder, searchEntries } from '../journal/journalSelectors';
import { journalStore, useJournalStore } from '../journal/useJournalStore';
import { mediaCoordinator } from '@/services/media/journalMediaRuntime';
import { formatJournalFullDate, todayIso } from './recordsDates';
import {
  applySheetCompletion,
  ideaCompletionEffects,
  journalCompletionAction,
  journalCompletionEffects,
} from './recordsSheetGuard';

type RecordsSegment = 'journal' | 'ideas';
type JournalMode = 'write' | 'history';

const recordsSegments = [
  { value: 'journal', label: 'Дневник' },
  { value: 'ideas', label: 'Идеи' },
] as const;

const journalModes = [
  { value: 'write', label: 'Новая запись' },
  { value: 'history', label: 'История' },
] as const;

/** Open sheet identity (one at a time). */
type RecordsSheet =
  | { domain: 'journal'; key: string; mode: 'add'; date: string }
  | { domain: 'journal'; key: string; mode: 'read' | 'edit'; id: string }
  | { domain: 'ideas'; key: string; mode: 'add' }
  | { domain: 'ideas'; key: string; mode: 'read' | 'edit'; id: string };

let sheetCounter = 0;

function nextSheetKey(prefix: string): string {
  sheetCounter += 1;
  return `${prefix}-${Date.now()}-${sheetCounter}`;
}

/**
 * Records workspace: Journal (Новая запись / История with local search) and
 * Ideas (category/status filters), each with its own independent store, phase,
 * error and retry.
 *
 * Segment, Journal mode/search, Ideas filters and the open-sheet identity live
 * HERE, above the conditional feature rendering, so session selections survive
 * switching between Journal and Ideas. A single FlatList owns vertical scrolling
 * in each list mode (no outer ScrollView around it).
 */
export default function RecordsScreen() {
  const journal = useJournalStore();
  const ideasState = useIdeaStore();
  const [segment, setSegment] = useState<RecordsSegment>('journal');
  const [journalMode, setJournalMode] = useState<JournalMode>('write');
  const [journalQuery, setJournalQuery] = useState('');
  const [ideaFilters, setIdeaFilters] = useState<IdeaFilters>({ category: 'all', status: 'all' });
  const [sheet, setSheet] = useState<RecordsSheet | null>(null);
  // Latest open-sheet identity for async completions/delayed confirmations: an
  // old save/delete/discard that resolves after a NEWER sheet opened must not
  // close/reveal it. Updated SYNCHRONOUSLY with every state transition (never a
  // passive effect), so the identity is already current when a callback runs.
  const sheetRef = useRef<RecordsSheet | null>(null);

  /** The ONLY way the open sheet changes: state + identity move together. */
  function commitSheet(next: RecordsSheet | null): void {
    sheetRef.current = next;
    setSheet(next);
  }

  function isCurrentSheet(sheetKey: string): boolean {
    return sheetRef.current !== null && sheetRef.current.key === sheetKey;
  }

  useEffect(() => {
    void journalStore.load();
    void ideaStore.load();
  }, []);

  // One startup sweep of owned media AFTER hydration succeeds: committed files
  // are kept, abandoned staging/prepared files are removed, corrupt/unhydrated
  // state blocks the sweep instead of guessing. No background service.
  const mediaReconciledRef = useRef(false);
  useEffect(() => {
    if (journal.phase !== 'ready' || mediaReconciledRef.current) return;
    mediaReconciledRef.current = true;
    void mediaCoordinator.reconcile();
  }, [journal.phase]);

  const today = todayIso(new Date());
  const orderedEntries = useMemo(() => historyOrder(journal.entries), [journal.entries]);
  const visibleEntries = useMemo(
    () => searchEntries(orderedEntries, journalQuery),
    [orderedEntries, journalQuery],
  );
  const visibleIdeas = useMemo(
    () => filterIdeas(ideasState.ideas, ideaFilters),
    [ideasState.ideas, ideaFilters],
  );

  const journalBusy = journal.phase !== 'ready' || journal.saving;
  const ideasBusy = ideasState.phase !== 'ready' || ideasState.saving;

  function openJournalComposer(): void {
    // The date is captured when the editor OPENS (midnight/tab changes cannot move it).
    // A device clock outside 0001-9999 has NO supported date, so no editor opens.
    const date = todayIso(new Date());
    if (date === null) return;
    commitSheet({ domain: 'journal', key: nextSheetKey('journal-new'), mode: 'add', date });
  }

  function openJournalReader(id: string): void {
    commitSheet({ domain: 'journal', key: nextSheetKey('journal-read'), mode: 'read', id });
  }

  function openIdeaComposer(): void {
    commitSheet({ domain: 'ideas', key: nextSheetKey('idea-new'), mode: 'add' });
  }

  function openIdeaReader(id: string): void {
    commitSheet({ domain: 'ideas', key: nextSheetKey('idea-read'), mode: 'read', id });
  }

  /**
   * Journal completion policy: only the CURRENT sheet identity may close, switch
   * modes or clear the search.
   */
  /** Close request from a sheet: applied ONLY when that sheet is still current. */
  function handleSheetClose(sheetKey: string): void {
    if (!isCurrentSheet(sheetKey)) return;
    commitSheet(null);
  }

  /** Reveal effects for a journal completion (used by close and in-place paths). */
  function applyJournalReveal(outcome: JournalCompletionOutcome): void {
    const saved =
      outcome.action === 'saved'
        ? journalStore.getSnapshot().entries.find((item) => item.id === outcome.id)
        : undefined;
    const effects = journalCompletionEffects(outcome, saved, journalQuery);
    if (effects.mode) setJournalMode(effects.mode);
    if (effects.clearSearch) setJournalQuery('');
  }

  /**
   * Journal completion policy: only the CURRENT sheet identity may close, switch
   * modes or clear the search; a successful edit stays on the reader.
   */
  function handleJournalComplete(completedKey: string, outcome: JournalCompletionOutcome): void {
    const applied = applySheetCompletion(sheetRef.current, completedKey);
    if (!applied.applied) return;
    if (journalCompletionAction(outcome) === 'stay-open') return; // edit keeps the reader
    commitSheet(null);
    applyJournalReveal(outcome);
  }

  /** A successful edit keeps the sheet open; only reveal for the CURRENT identity. */
  function handleJournalEditSaved(completedKey: string, entryId: string): void {
    if (sheetRef.current === null || sheetRef.current.key !== completedKey) return;
    applyJournalReveal({ action: 'saved', id: entryId });
  }

  /**
   * Ideas completion policy: close only the current sheet, and clear ONLY the
   * filters that would hide the saved/created idea.
   */
  function handleIdeaComplete(completedKey: string, outcome: IdeaCompletionOutcome): void {
    const applied = applySheetCompletion(sheetRef.current, completedKey);
    if (!applied.applied) return;
    commitSheet(null);
    const list = ideaStore.getSnapshot().ideas;
    const target =
      outcome.action === 'created'
        ? list[0]
        : outcome.action === 'saved'
          ? list.find((item) => item.id === outcome.id)
          : undefined;
    const effects = ideaCompletionEffects(outcome, target, ideaFilters);
    if (effects.clearCategory || effects.clearStatus) {
      setIdeaFilters((current) => ({
        category: effects.clearCategory ? 'all' : current.category,
        status: effects.clearStatus ? 'all' : current.status,
      }));
    }
  }

  function toggleCategoryFilter(value: IdeaCategory): void {
    setIdeaFilters((current) => ({
      ...current,
      category: current.category === value ? 'all' : value,
    }));
  }

  function toggleStatusFilter(value: IdeaStatus): void {
    setIdeaFilters((current) => ({ ...current, status: current.status === value ? 'all' : value }));
  }

  async function addJournalEntry(input: JournalEntryInput, date: string) {
    return journalStore.add(input, date);
  }
  async function editJournalEntry(id: string, input: JournalEntryInput) {
    return journalStore.edit(id, input);
  }
  async function addIdeaEntry(input: IdeaInput) {
    return ideaStore.add(input);
  }
  async function editIdeaEntry(id: string, input: IdeaInput) {
    return ideaStore.edit(id, input);
  }
  async function setIdeaEntryStatus(id: string, status: IdeaStatus) {
    return ideaStore.setStatus(id, status);
  }
  async function removeIdeaEntry(id: string) {
    return ideaStore.remove(id);
  }

  const header = (
    <View style={styles.headerBlock}>
      <View style={styles.titleRow}>
        <AppText variant="pageTitle">Записи</AppText>
        {segment === 'ideas' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Добавить идею"
            disabled={ideasBusy}
            onPress={openIdeaComposer}
            style={({ pressed }) => [
              styles.addButton,
              ideasBusy && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <AppText variant="label" color="accent">
              + Идея
            </AppText>
          </Pressable>
        ) : null}
      </View>
      <SegmentedControl items={recordsSegments} value={segment} onChange={setSegment} />

      {segment === 'journal' ? (
        <View style={styles.block}>
          <SegmentedControl items={journalModes} value={journalMode} onChange={setJournalMode} />
          {journalMode === 'history' ? (
            <TextInput
              value={journalQuery}
              onChangeText={setJournalQuery}
              placeholder="Поиск по записям"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              returnKeyType="search"
              style={styles.search}
              accessibilityLabel="Поиск по записям"
            />
          ) : null}
        </View>
      ) : (
        <View style={styles.block}>
          <AppText variant="label" color="secondary">
            Категория
          </AppText>
          <View style={styles.chipRow}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: ideaFilters.category === 'all' }}
              onPress={() => setIdeaFilters((current) => ({ ...current, category: 'all' }))}
              style={({ pressed }) => [
                styles.chip,
                ideaFilters.category === 'all' && styles.chipSelected,
                pressed && styles.pressed,
              ]}
            >
              <AppText variant="label" color={ideaFilters.category === 'all' ? 'primary' : 'muted'}>
                Все
              </AppText>
            </Pressable>
            {ideaCategoryOptions.map((value) => {
              const selected = ideaFilters.category === value;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => toggleCategoryFilter(value)}
                  style={({ pressed }) => [
                    styles.chip,
                    selected && styles.chipSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <AppText variant="label" color={selected ? 'primary' : 'muted'}>
                    {IDEA_CATEGORY_LABELS[value]}
                  </AppText>
                </Pressable>
              );
            })}
          </View>

          <AppText variant="label" color="secondary">
            Статус
          </AppText>
          <View style={styles.chipRow}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: ideaFilters.status === 'all' }}
              onPress={() => setIdeaFilters((current) => ({ ...current, status: 'all' }))}
              style={({ pressed }) => [
                styles.chip,
                ideaFilters.status === 'all' && styles.chipSelected,
                pressed && styles.pressed,
              ]}
            >
              <AppText variant="label" color={ideaFilters.status === 'all' ? 'primary' : 'muted'}>
                Все
              </AppText>
            </Pressable>
            {ideaStatusOptions.map((value) => {
              const selected = ideaFilters.status === value;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => toggleStatusFilter(value)}
                  style={({ pressed }) => [
                    styles.chip,
                    selected && styles.chipSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <AppText variant="label" color={selected ? 'primary' : 'muted'}>
                    {IDEA_STATUS_LABELS[value]}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {segment === 'journal' && journal.error ? (
        <View accessibilityRole="alert" style={styles.errorBanner}>
          <AppText variant="meta" color="danger" style={styles.bannerText}>
            {journal.error}
          </AppText>
        </View>
      ) : null}
      {segment === 'ideas' && ideasState.error ? (
        <View accessibilityRole="alert" style={styles.errorBanner}>
          <AppText variant="meta" color="danger" style={styles.bannerText}>
            {ideasState.error}
          </AppText>
        </View>
      ) : null}
    </View>
  );

  function loadingBlock() {
    return (
      <View style={styles.centerState}>
        <ActivityIndicator color={colors.accent} />
        <AppText variant="meta" color="muted">
          Загрузка…
        </AppText>
      </View>
    );
  }

  function errorBlock(text: string | null, onRetry: () => void) {
    return (
      <View style={styles.centerState}>
        <AppText variant="body" color="secondary" style={styles.centerText}>
          {text ?? 'Не удалось загрузить данные.'}
        </AppText>
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
        >
          <AppText variant="label">Повторить</AppText>
        </Pressable>
      </View>
    );
  }

  function emptyBlock(title: string, description: string) {
    return (
      <View style={styles.empty}>
        <Ionicons name="document-text-outline" size={28} color={colors.accent} />
        <AppText variant="body" color="secondary" style={styles.emptyTitle}>
          {title}
        </AppText>
        <AppText variant="meta" color="muted" style={styles.centerText}>
          {description}
        </AppText>
      </View>
    );
  }

  function renderJournalRow({ item }: ListRenderItemInfo<JournalEntry>) {
    return <JournalEntryRow entry={item} disabled={journalBusy} onPress={openJournalReader} />;
  }

  function renderIdeaRow({ item }: ListRenderItemInfo<Idea>) {
    return <IdeaRow idea={item} disabled={ideasBusy} onPress={openIdeaReader} />;
  }

  const composerPanel = today === null ? (
    <Card style={styles.composerCard}>
      <AppText variant="label" color="accent">
        Дата недоступна
      </AppText>
      <AppText variant="meta" color="muted" style={styles.composerHint}>
        Часы устройства находятся вне поддерживаемого диапазона 0001–9999, поэтому
        дневную запись создать нельзя. Проверьте дату и время устройства.
      </AppText>
    </Card>
  ) : (
    <Card style={styles.composerCard}>
      <AppText variant="label" color="accent">
        Сегодня
      </AppText>
      <AppText variant="section">{formatJournalFullDate(today)}</AppText>
      <AppText variant="meta" color="muted" style={styles.composerHint}>
        Запись сохранится на этом устройстве. Заголовок, настроение и теги — необязательны.
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Написать запись"
        disabled={journalBusy}
        onPress={openJournalComposer}
        style={({ pressed }) => [
          styles.primaryButton,
          journalBusy && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <AppText variant="label">Написать запись</AppText>
      </Pressable>
    </Card>
  );

  // Loading / load-error states keep the header mounted, so a corrupt journal
  // never blocks switching to Ideas (and the other way round).
  if (segment === 'journal' && journal.phase !== 'ready') {
    return (
      <Screen scroll contentContainerStyle={styles.content}>
        {header}
        {journal.phase === 'loading'
          ? loadingBlock()
          : errorBlock(journal.error, () => void journalStore.retryLoad())}
      </Screen>
    );
  }
  if (segment === 'ideas' && ideasState.phase !== 'ready') {
    return (
      <Screen scroll contentContainerStyle={styles.content}>
        {header}
        {ideasState.phase === 'loading'
          ? loadingBlock()
          : errorBlock(ideasState.error, () => void ideaStore.retryLoad())}
      </Screen>
    );
  }

  if (segment === 'journal') {
    const writeMode = journalMode === 'write';
    return (
      <Screen>
        <FlatList
          data={writeMode ? [] : visibleEntries}
          keyExtractor={(entry) => entry.id}
          renderItem={renderJournalRow}
          ListHeaderComponent={
            <>
              {header}
              {writeMode ? composerPanel : null}
              {!writeMode && journal.entries.length > 0 ? (
                <AppText variant="meta" color="muted">
                  {visibleEntries.length === journal.entries.length
                    ? `Всего записей: ${journal.entries.length}`
                    : `Найдено: ${visibleEntries.length} из ${journal.entries.length}`}
                </AppText>
              ) : null}
            </>
          }
          ListEmptyComponent={
            writeMode
              ? null
              : journal.entries.length === 0
                ? emptyBlock('Записей пока нет', 'Создайте первую запись — она сохранится на устройстве.')
                : emptyBlock('Ничего не найдено', 'Попробуйте изменить запрос поиска.')
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
        {sheet?.domain === 'journal' ? (
          <JournalSheet
            key={sheet.key}
            sheetKey={sheet.key}
            mode={sheet.mode}
            entryId={sheet.mode === 'read' || sheet.mode === 'edit' ? sheet.id : undefined}
            targetDate={sheet.mode === 'add' ? sheet.date : undefined}
            entries={journal.entries}
            saving={journal.saving}
            storeError={journal.error}
            onClose={handleSheetClose}
            isCurrent={() => isCurrentSheet(sheet.key)}
            onSaveComplete={handleJournalComplete}
            onEditSaved={handleJournalEditSaved}
            onAdd={addJournalEntry}
            onEdit={editJournalEntry}
            onCommitMediaCreate={mediaCoordinator.commitNewEntry}
            onCommitMediaEdit={mediaCoordinator.commitEdit}
            onRemoveMedia={mediaCoordinator.removeCommittedAttachment}
            onDeleteEntryWithMedia={mediaCoordinator.deleteEntry}
          />
        ) : null}
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={visibleIdeas}
        keyExtractor={(idea) => idea.id}
        renderItem={renderIdeaRow}
        ListHeaderComponent={
          <>
            {header}
            {ideasState.ideas.length > 0 ? (
              <AppText variant="meta" color="muted">
                {visibleIdeas.length === ideasState.ideas.length
                  ? `Всего идей: ${ideasState.ideas.length}`
                  : `Показано: ${visibleIdeas.length} из ${ideasState.ideas.length}`}
              </AppText>
            ) : null}
          </>
        }
        ListEmptyComponent={
          ideasState.ideas.length === 0
            ? emptyBlock('Идей пока нет', 'Добавьте идею — категория и статус помогут потом найти её.')
            : emptyBlock('Ничего не найдено', 'Снимите фильтры категории или статуса.')
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
      {sheet?.domain === 'ideas' ? (
        <IdeaSheet
          key={sheet.key}
          sheetKey={sheet.key}
          mode={sheet.mode}
          ideaId={sheet.mode === 'read' || sheet.mode === 'edit' ? sheet.id : undefined}
          ideas={ideasState.ideas}
          saving={ideasState.saving}
          storeError={ideasState.error}
          onClose={handleSheetClose}
          isCurrent={() => isCurrentSheet(sheet.key)}
          onSaveComplete={handleIdeaComplete}
          onAdd={addIdeaEntry}
          onEdit={editIdeaEntry}
          onSetStatus={setIdeaEntryStatus}
          onRemove={removeIdeaEntry}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  headerBlock: { gap: spacing.md, paddingBottom: spacing.md },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  block: { gap: spacing.sm },
  addButton: {
    minHeight: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.input,
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
  },
  search: {
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
  errorBanner: {
    backgroundColor: 'rgba(239, 113, 134, 0.1)',
    borderColor: 'rgba(239, 113, 134, 0.28)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.item,
    padding: spacing.lg,
  },
  bannerText: { lineHeight: 18 },
  composerCard: { gap: spacing.sm },
  composerHint: { lineHeight: 18 },
  primaryButton: {
    marginTop: spacing.sm,
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.input,
    backgroundColor: colors.surfaceSelected,
    borderColor: colors.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
  },
  listContent: { paddingBottom: spacing.xxl, gap: spacing.sm },
  centerState: {
    flex: 1,
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xxl,
  },
  centerText: { textAlign: 'center' },
  retryButton: {
    minHeight: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    borderRadius: radius.input,
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
  },
  empty: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: { marginTop: spacing.xs, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
});
