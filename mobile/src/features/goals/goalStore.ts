import {
  GOALS_STORAGE_KEY,
  deepFreezeGoals,
  parseGoalSnapshot,
  serializeGoalSnapshot,
  type GoalStorage,
} from '@/storage/goalStorage';
import type { Goal } from '@/types/goal';
import {
  createGoal,
  editGoal,
  removeGoal,
  setGoalCompleted,
  setGoalProgress,
  type GoalDraft,
  type GoalFailure,
} from './goalModel';

export type GoalState = Readonly<{
  phase: 'loading' | 'ready' | 'load-error';
  goals: readonly Goal[];
  revision: number;
  saving: boolean;
  error: string | null;
}>;

export type GoalMutation =
  | { ok: true; id?: string; revision: number }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'busy'
        | 'stale'
        | 'duplicate-id'
        | 'storage'
        | 'invalid-snapshot'
        | GoalFailure;
    };

type GoalStoreDependencies = {
  storage: GoalStorage;
  now(): Date;
  createId(): string;
};

const EMPTY_GOALS: readonly Goal[] = deepFreezeGoals([]);

export function createGoalStore(deps: GoalStoreDependencies) {
  let goals = EMPTY_GOALS;
  let revision = 0;
  let phase: GoalState['phase'] = 'loading';
  let saving = false;
  let error: string | null = null;
  let loadFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function makeState(): GoalState {
    return Object.freeze({ phase, goals, revision, saving, error });
  }

  let state = makeState();

  function publish(): void {
    state = makeState();
    for (const listener of listeners) listener();
  }

  function load(): Promise<void> {
    if (loadFlight) return loadFlight;
    if (phase === 'ready' || phase === 'load-error') return Promise.resolve();

    loadFlight = (async () => {
      try {
        const raw = await deps.storage.getItem(GOALS_STORAGE_KEY);
        if (raw === null) {
          goals = EMPTY_GOALS;
          revision = 0;
          phase = 'ready';
          error = null;
        } else {
          const parsed = parseGoalSnapshot(raw);
          if (!parsed.ok) throw new Error('corrupt-goal-snapshot');
          goals = deepFreezeGoals(parsed.snapshot.goals);
          revision = parsed.snapshot.revision;
          phase = 'ready';
          error = null;
        }
      } catch {
        goals = EMPTY_GOALS;
        revision = 0;
        phase = 'load-error';
        error = 'Сохранённые цели не удалось прочитать. Данные не изменены — повторите попытку.';
      }
      publish();
    })().finally(() => {
      loadFlight = null;
    });
    return loadFlight;
  }

  function retryLoad(): Promise<void> {
    if (phase !== 'load-error') return Promise.resolve();
    phase = 'loading';
    error = null;
    publish();
    return load();
  }

  function mutationGate(expectedRevision: number): GoalMutation | null {
    if (phase !== 'ready') return { ok: false, reason: 'not-ready' };
    if (saving) return { ok: false, reason: 'busy' };
    if (expectedRevision !== revision) return { ok: false, reason: 'stale' };
    return null;
  }

  async function commit(next: readonly Goal[]): Promise<GoalMutation> {
    const nextRevision = revision + 1;
    let raw: string;
    try {
      raw = serializeGoalSnapshot(next, nextRevision, deps.now().toISOString());
    } catch {
      error = 'Цель не сохранена: данные не прошли проверку. Черновик остался открыт.';
      publish();
      return { ok: false, reason: 'invalid-snapshot' };
    }
    if (!parseGoalSnapshot(raw).ok) {
      error = 'Цель не сохранена: данные не прошли проверку. Черновик остался открыт.';
      publish();
      return { ok: false, reason: 'invalid-snapshot' };
    }

    saving = true;
    error = null;
    publish();
    try {
      await deps.storage.setItem(GOALS_STORAGE_KEY, raw);
    } catch {
      saving = false;
      error = 'Не удалось сохранить цель. Черновик остался открыт — повторите попытку.';
      publish();
      return { ok: false, reason: 'storage' };
    }

    goals = deepFreezeGoals(next);
    revision = nextRevision;
    saving = false;
    error = null;
    publish();
    return { ok: true, revision };
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    retryLoad,
    async add(input: GoalDraft & { expectedRevision: number }): Promise<GoalMutation> {
      const blocked = mutationGate(input.expectedRevision);
      if (blocked) return blocked;
      const id = deps.createId();
      if (!id.trim() || goals.some((goal) => goal.id === id)) {
        return { ok: false, reason: 'duplicate-id' };
      }
      const result = createGoal(goals, { ...input, id, now: deps.now() });
      if (!result.ok) return result;
      const saved = await commit(result.goals);
      return saved.ok ? { ...saved, id } : saved;
    },
    async edit(
      id: string,
      input: GoalDraft & { expectedRevision: number },
    ): Promise<GoalMutation> {
      const blocked = mutationGate(input.expectedRevision);
      if (blocked) return blocked;
      const result = editGoal(goals, id, { ...input, now: deps.now() });
      return result.ok ? commit(result.goals) : result;
    },
    async setProgress(
      id: string,
      progress: number,
      expectedRevision: number,
    ): Promise<GoalMutation> {
      const blocked = mutationGate(expectedRevision);
      if (blocked) return blocked;
      const result = setGoalProgress(goals, id, progress, deps.now());
      return result.ok ? commit(result.goals) : result;
    },
    async setCompleted(
      id: string,
      completed: boolean,
      expectedRevision: number,
    ): Promise<GoalMutation> {
      const blocked = mutationGate(expectedRevision);
      if (blocked) return blocked;
      const result = setGoalCompleted(goals, id, completed, deps.now());
      return result.ok ? commit(result.goals) : result;
    },
    async remove(id: string, expectedRevision: number): Promise<GoalMutation> {
      const blocked = mutationGate(expectedRevision);
      if (blocked) return blocked;
      const result = removeGoal(goals, id);
      return result.ok ? commit(result.goals) : result;
    },
  };
}

export type GoalStore = ReturnType<typeof createGoalStore>;
