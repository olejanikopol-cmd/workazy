/**
 * Pure ideas store factory: hydration gate, one committed ideas array,
 * persist-before-commit, and a synchronous write lock.
 *
 * Instantiated once by the native binding (`useIdeaStore.ts`). Mutations are
 * rejected until hydration succeeds and a second mutation while a write is
 * pending returns `busy` without queueing or writing. Committed rows are copied
 * so subscribers can never mutate committed state.
 *
 * The journal store is fully independent: corrupt ideas cannot block journal
 * (and vice versa), each has its own key and its own retry.
 */
import {
  IDEAS_STORAGE_KEY,
  deepFreezeIdeas,
  parseSnapshot,
  serializeSnapshot,
  type IdeaStorage,
} from '@/storage/ideaStorage';
import type { Idea, IdeaStatus } from '@/types/idea';
import {
  addIdea,
  editIdea,
  removeIdea,
  setIdeaStatus,
  type IdeaInput,
  type IdeaValidationReason,
} from './ideaModel';

export type IdeasPhase = 'loading' | 'ready' | 'load-error';

export type IdeasState = {
  phase: IdeasPhase;
  ideas: readonly Idea[];
  saving: boolean;
  error: string | null;
};

export type IdeaMutationResult =
  | { ok: true; /** Created idea id, present for `add` (used to reveal it). */ id?: string }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'busy'
        | 'missing'
        | 'storage'
        | 'duplicate-id'
        | 'invalid-snapshot'
        | IdeaValidationReason;
    };

export type CreateIdeaStoreDeps = {
  storage: IdeaStorage;
  now: () => Date;
  createId: () => string;
};

export type IdeaStore = {
  getSnapshot(): IdeasState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  retryLoad(): Promise<void>;
  add(input: IdeaInput): Promise<IdeaMutationResult>;
  edit(id: string, input: IdeaInput): Promise<IdeaMutationResult>;
  setStatus(id: string, status: IdeaStatus): Promise<IdeaMutationResult>;
  remove(id: string): Promise<IdeaMutationResult>;
};

const INITIAL_IDEAS: readonly Idea[] = deepFreezeIdeas([]);

const FAIL_NOT_READY: IdeaMutationResult = { ok: false, reason: 'not-ready' };
const FAIL_BUSY: IdeaMutationResult = { ok: false, reason: 'busy' };

export function createIdeaStore({
  storage,
  now,
  createId,
}: CreateIdeaStoreDeps): IdeaStore {
  let phase: IdeasPhase = 'loading';
  let ideas: readonly Idea[] = INITIAL_IDEAS;
  let saving = false;
  let errorText: string | null = null;
  // Every published wrapper is FROZEN (initial state included): external code
  // can neither replace `ideas` nor mutate `phase`/`saving`/`error` on a snapshot
  // returned by getSnapshot(). Rows are deep-frozen too.
  function makeState(): IdeasState {
    return Object.freeze({ phase, ideas, saving, error: errorText });
  }
  let state: IdeasState = makeState();
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
      const raw = await storage.getItem(IDEAS_STORAGE_KEY);
      if (raw === null) {
        ideas = INITIAL_IDEAS;
        phase = 'ready';
        errorText = null;
        publish();
        return;
      }
      const parsed = parseSnapshot(raw);
      if (!parsed.ok) {
        ideas = INITIAL_IDEAS;
        phase = 'load-error';
        errorText = 'Сохранённые идеи повреждены. Мы их не трогаем — повторите попытку позже.';
        publish();
        return;
      }
      ideas = deepFreezeIdeas(parsed.snapshot.ideas);
      phase = 'ready';
      errorText = null;
      publish();
    } catch {
      ideas = INITIAL_IDEAS;
      phase = 'load-error';
      errorText = 'Не удалось прочитать сохранённые идеи. Повторите попытку.';
      publish();
    }
  }

  function load(): Promise<void> {
    if (phase === 'ready' || phase === 'load-error') return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = doRead().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  function retryLoad(): Promise<void> {
    if (phase !== 'load-error') return Promise.resolve();
    phase = 'loading';
    publish();
    return load();
  }

  async function commit(next: readonly Idea[]): Promise<IdeaMutationResult> {
    if (next === ideas) return { ok: true };
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
      await storage.setItem(IDEAS_STORAGE_KEY, envelope);
    } catch {
      saving = false;
      errorText = 'Не удалось сохранить идею. Черновик сохранён — повторите попытку.';
      publish();
      return { ok: false, reason: 'storage' };
    }
    ideas = deepFreezeIdeas(next);
    saving = false;
    errorText = null;
    publish();
    return { ok: true };
  }

  function gate(): IdeaMutationResult | null {
    if (phase !== 'ready') return FAIL_NOT_READY;
    if (saving) return FAIL_BUSY;
    return null;
  }

  async function add(input: IdeaInput): Promise<IdeaMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const id = createId();
    // A generated-ID collision must fail safely instead of producing a snapshot
    // the parser would reject (duplicate ids).
    if (id.length === 0 || ideas.some((idea) => idea.id === id)) {
      errorText = 'Не удалось создать идею: конфликт идентификатора. Повторите попытку.';
      publish();
      return { ok: false, reason: 'duplicate-id' };
    }
    const result = addIdea(ideas, { ...input, id, now: now() });
    if (!result.ok) return { ok: false, reason: result.reason };
    const committed = await commit(result.ideas);
    if (!committed.ok) return committed;
    return { ok: true, id: result.idea.id };
  }

  async function edit(id: string, input: IdeaInput): Promise<IdeaMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = editIdea(ideas, id, input, now());
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.ideas);
  }

  async function setStatus(id: string, status: IdeaStatus): Promise<IdeaMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = setIdeaStatus(ideas, id, status, now());
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.ideas);
  }

  async function remove(id: string): Promise<IdeaMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = removeIdea(ideas, id);
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.ideas);
  }

  return { getSnapshot: () => state, subscribe, load, retryLoad, add, edit, setStatus, remove };
}
