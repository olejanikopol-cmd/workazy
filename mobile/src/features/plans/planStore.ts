/**
 * Pure daily-plan store factory: hydration gate, one committed tasks array,
 * persist-before-commit, and a synchronous write lock.
 *
 * The factory is instantiated once by the native binding module
 * (`usePlanStore.ts`), which supplies AsyncStorage, a real clock and the ID
 * generator. All mutations are rejected until hydration succeeds, and a second
 * mutation while a write is pending returns `busy` without queueing or writing.
 * Storage is the only source of truth; the web "keep completed first" merge is
 * deliberately not ported — explicit uncheck must stay unchecked.
 */
import {
  PLAN_STORAGE_KEY,
  parseSnapshot,
  serializeSnapshot,
  type PlanStorage,
} from '@/storage/planStorage';
import type { PlanTask } from '@/types/plan';
import {
  addTask,
  editTask,
  moveTask,
  removeTask,
  toggleTask,
} from './planModel';

export type PlanPhase = 'loading' | 'ready' | 'load-error';

export type PlanState = {
  phase: PlanPhase;
  tasks: readonly PlanTask[];
  saving: boolean;
  error: string | null;
};

export type MutationResult =
  | { ok: true }
  | { ok: false; reason: 'not-ready' | 'busy' | 'validation' | 'missing' | 'storage' };

export type CreatePlanStoreDeps = {
  storage: PlanStorage;
  now: () => Date;
  createId: () => string;
};

export type PlanStore = {
  getSnapshot(): PlanState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  retryLoad(): Promise<void>;
  add(title: string, date: string): Promise<MutationResult>;
  edit(id: string, title: string): Promise<MutationResult>;
  toggle(id: string): Promise<MutationResult>;
  remove(id: string): Promise<MutationResult>;
  move(id: string, direction: -1 | 1): Promise<MutationResult>;
};

const INITIAL_TASKS: readonly PlanTask[] = [];

const FAIL_NOT_READY: MutationResult = { ok: false, reason: 'not-ready' };
const FAIL_BUSY: MutationResult = { ok: false, reason: 'busy' };

export function createPlanStore({ storage, now, createId }: CreatePlanStoreDeps): PlanStore {
  let phase: PlanPhase = 'loading';
  let tasks: readonly PlanTask[] = INITIAL_TASKS;
  let saving = false;
  let errorText: string | null = null;
  let state: PlanState = { phase, tasks, saving, error: errorText };
  let listeners = new Set<() => void>();
  let loadPromise: Promise<void> | null = null;

  function publish(): void {
    state = { phase, tasks, saving, error: errorText };
    for (const listener of listeners) listener();
  }

  function getSnapshot(): PlanState {
    return state;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function doRead(): Promise<void> {
    try {
      const raw = await storage.getItem(PLAN_STORAGE_KEY);
      if (raw === null) {
        tasks = INITIAL_TASKS;
        phase = 'ready';
        errorText = null;
        publish();
        return;
      }
      const parsed = parseSnapshot(raw);
      if (!parsed.ok) {
        tasks = INITIAL_TASKS;
        phase = 'load-error';
        errorText =
          'Сохранённые данные повреждены. Мы их не трогаем — повторите попытку позже.';
        publish();
        return;
      }
      tasks = parsed.snapshot.tasks;
      phase = 'ready';
      errorText = null;
      publish();
    } catch {
      tasks = INITIAL_TASKS;
      phase = 'load-error';
      errorText = 'Не удалось прочитать сохранённые данные. Повторите попытку.';
      publish();
    }
  }

  /** Primary hydration. Coalesces in-flight reads and is a no-op once ready. */
  function load(): Promise<void> {
    if (phase === 'ready' || phase === 'load-error') return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = doRead().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  /** Explicit reload after a load error. */
  function retryLoad(): Promise<void> {
    if (phase !== 'load-error') return Promise.resolve();
    phase = 'loading';
    publish();
    return load();
  }

  /**
   * Persist-before-commit: compute the next immutable array, await one full
   * envelope write, then publish it. The write lock is synchronous — a second
   * mutation sees `saving` immediately and returns `busy`.
   */
  async function commit(next: readonly PlanTask[]): Promise<MutationResult> {
    if (next === tasks) return { ok: true };
    const envelope = serializeSnapshot(next, now().toISOString());
    saving = true;
    errorText = null;
    publish();
    try {
      await storage.setItem(PLAN_STORAGE_KEY, envelope);
    } catch {
      saving = false;
      errorText =
        'Не удалось сохранить изменения. Проверьте устройство и повторите попытку.';
      publish();
      return { ok: false, reason: 'storage' };
    }
    tasks = next;
    saving = false;
    errorText = null;
    publish();
    return { ok: true };
  }

  function gate(): MutationResult | null {
    if (phase !== 'ready') return FAIL_NOT_READY;
    if (saving) return FAIL_BUSY;
    return null;
  }

  async function add(rawTitle: string, date: string): Promise<MutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = addTask(tasks, {
      id: createId(),
      title: rawTitle,
      date,
      now: now(),
    });
    if (!result.ok) return { ok: false, reason: 'validation' };
    return commit(result.tasks);
  }

  async function edit(id: string, rawTitle: string): Promise<MutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = editTask(tasks, id, rawTitle, now());
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.tasks);
  }

  async function toggle(id: string): Promise<MutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = toggleTask(tasks, id, now());
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.tasks);
  }

  async function remove(id: string): Promise<MutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = removeTask(tasks, id);
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.tasks);
  }

  async function move(id: string, direction: -1 | 1): Promise<MutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = moveTask(tasks, id, direction, now());
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.tasks);
  }

  return {
    getSnapshot,
    subscribe,
    load,
    retryLoad,
    add,
    edit,
    toggle,
    remove,
    move,
  };
}