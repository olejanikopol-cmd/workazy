/**
 * Pure journal store factory: hydration gate, one committed entries array,
 * persist-before-commit, and a synchronous write lock.
 *
 * Instantiated once by the native binding (`useJournalStore.ts`), which supplies
 * AsyncStorage, a real clock and the ID generator. Mutations are rejected until
 * hydration succeeds and a second mutation while a write is pending returns
 * `busy` without queueing or writing. Committed arrays and their nested tags/
 * media are copied, so subscribers can never mutate committed state.
 *
 * A failed write leaves committed data AND stored bytes unchanged; the caller's
 * draft stays retryable. Nothing is seeded, repaired or dropped.
 */
import {
  JOURNAL_STORAGE_KEY,
  deepFreezeEntries,
  parseSnapshot,
  serializeSnapshot,
  type JournalStorage,
} from '@/storage/journalStorage';
import type { JournalEntry } from '@/types/journal';
import {
  addEntry,
  editEntry,
  removeEntry,
  type JournalEntryInput,
  type JournalValidationReason,
} from './journalModel';

export type JournalPhase = 'loading' | 'ready' | 'load-error';

export type JournalState = {
  phase: JournalPhase;
  entries: readonly JournalEntry[];
  saving: boolean;
  error: string | null;
};

export type JournalMutationResult =
  | { ok: true; /** Created entry id, present for `add` (used to reveal it). */ id?: string }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'busy'
        | 'missing'
        | 'storage'
        | 'duplicate-id'
        | 'invalid-snapshot'
        | JournalValidationReason;
    };

export type CreateJournalStoreDeps = {
  storage: JournalStorage;
  now: () => Date;
  createId: () => string;
};

export type JournalStore = {
  getSnapshot(): JournalState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  retryLoad(): Promise<void>;
  add(input: JournalEntryInput, date: string): Promise<JournalMutationResult>;
  edit(id: string, input: JournalEntryInput): Promise<JournalMutationResult>;
  remove(id: string): Promise<JournalMutationResult>;
};

const INITIAL_ENTRIES: readonly JournalEntry[] = deepFreezeEntries([]);

const FAIL_NOT_READY: JournalMutationResult = { ok: false, reason: 'not-ready' };
const FAIL_BUSY: JournalMutationResult = { ok: false, reason: 'busy' };

export function createJournalStore({
  storage,
  now,
  createId,
}: CreateJournalStoreDeps): JournalStore {
  let phase: JournalPhase = 'loading';
  let entries: readonly JournalEntry[] = INITIAL_ENTRIES;
  let saving = false;
  let errorText: string | null = null;
  // Every published wrapper is FROZEN (initial state included): external code
  // can neither replace `entries` nor mutate `phase`/`saving`/`error` on a
  // snapshot returned by getSnapshot(). Rows/tags/media are deep-frozen too.
  function makeState(): JournalState {
    return Object.freeze({ phase, entries, saving, error: errorText });
  }
  let state: JournalState = makeState();
  const listeners = new Set<() => void>();
  let loadPromise: Promise<void> | null = null;

  function publish(): void {
    state = makeState();
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function doRead(): Promise<void> {
    try {
      const raw = await storage.getItem(JOURNAL_STORAGE_KEY);
      if (raw === null) {
        entries = INITIAL_ENTRIES;
        phase = 'ready';
        errorText = null;
        publish();
        return;
      }
      const parsed = parseSnapshot(raw);
      if (!parsed.ok) {
        entries = INITIAL_ENTRIES;
        phase = 'load-error';
        errorText =
          'Сохранённые записи повреждены. Мы их не трогаем — повторите попытку позже.';
        publish();
        return;
      }
      entries = deepFreezeEntries(parsed.snapshot.entries);
      phase = 'ready';
      errorText = null;
      publish();
    } catch {
      entries = INITIAL_ENTRIES;
      phase = 'load-error';
      errorText = 'Не удалось прочитать сохранённые записи. Повторите попытку.';
      publish();
    }
  }

  /** Primary hydration. Coalesces in-flight reads and is a no-op once settled. */
  function load(): Promise<void> {
    if (phase === 'ready' || phase === 'load-error') return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = doRead().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  /** Explicit reload after a load error (no other store is touched). */
  function retryLoad(): Promise<void> {
    if (phase !== 'load-error') return Promise.resolve();
    phase = 'loading';
    publish();
    return load();
  }

  async function commit(next: readonly JournalEntry[]): Promise<JournalMutationResult> {
    if (next === entries) return { ok: true };
    const envelope = serializeSnapshot(next, now().toISOString());
    // Never persist bytes the app could not load again: the exact bytes about to
    // be written must pass the same parser hydration uses.
    if (!parseSnapshot(envelope).ok) {
      errorText =
        'Изменение не сохранено: данные не прошли проверку. Черновик сохранён — повторите попытку.';
      publish();
      return { ok: false, reason: 'invalid-snapshot' };
    }
    saving = true;
    errorText = null;
    publish();
    try {
      await storage.setItem(JOURNAL_STORAGE_KEY, envelope);
    } catch {
      saving = false;
      errorText = 'Не удалось сохранить запись. Черновик сохранён — повторите попытку.';
      publish();
      return { ok: false, reason: 'storage' };
    }
    entries = deepFreezeEntries(next);
    saving = false;
    errorText = null;
    publish();
    return { ok: true };
  }

  function gate(): JournalMutationResult | null {
    if (phase !== 'ready') return FAIL_NOT_READY;
    if (saving) return FAIL_BUSY;
    return null;
  }

  async function add(input: JournalEntryInput, date: string): Promise<JournalMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const id = createId();
    // A generated-ID collision must fail safely instead of producing a snapshot
    // the parser would reject (duplicate ids).
    if (id.length === 0 || entries.some((entry) => entry.id === id)) {
      errorText = 'Не удалось создать запись: конфликт идентификатора. Повторите попытку.';
      publish();
      return { ok: false, reason: 'duplicate-id' };
    }
    const result = addEntry(entries, { ...input, id, date, now: now() });
    if (!result.ok) return { ok: false, reason: result.reason };
    const committed = await commit(result.entries);
    if (!committed.ok) return committed;
    return { ok: true, id: result.entry.id };
  }

  async function edit(id: string, input: JournalEntryInput): Promise<JournalMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = editEntry(entries, id, input, now());
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.entries);
  }

  async function remove(id: string): Promise<JournalMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = removeEntry(entries, id);
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.entries);
  }

  return { getSnapshot: () => state, subscribe, load, retryLoad, add, edit, remove };
}
