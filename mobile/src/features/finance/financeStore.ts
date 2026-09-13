/**
 * Finance store: hydration gate, ONE committed immutable snapshot, persist-before-
 * commit and a synchronous write lock.
 *
 * Guarantees (Slice 6 brief §8):
 * - `loading | ready | load-error`; a corrupt/unknown envelope blocks writes and
 *   keeps the original bytes (no normalization, no empty-state replacement).
 * - Parse before publish AND before every write: the exact envelope string is
 *   strictly re-parsed and only then published, so an invalid candidate can never
 *   reach storage or the UI.
 * - Deeply frozen snapshots (rows, nested references and settings included).
 * - Monotonic committed revision; CRUD accepts the expected revision and reports
 *   `stale` instead of overwriting newer state.
 * - A failed write leaves the previous committed snapshot and the UI draft intact.
 * - Every money command first establishes the day's allowance from the PRE-mutation
 *   committed state, in the SAME write, and never rewrites an existing row.
 */
import type { FinanceSnapshotV1 } from '@/types/finance';
import type { FinanceStorage } from '@/storage/financeStorage';
import {
  FINANCE_STORAGE_KEY,
  createEmptyFinanceSnapshot,
  parseFinanceSnapshot,
  serializeFinanceSnapshot,
} from '@/storage/financeStorage';
import { localDateIso } from './financeDates';
import * as model from './financeModel';
import type { FinanceModelError } from './financeModel';

export type FinancePhase = 'loading' | 'ready' | 'load-error';

export type FinanceFailureReason =
  | FinanceModelError
  | 'not-ready'
  | 'busy'
  | 'stale'
  | 'storage'
  | 'load-error'
  | 'no-allowance';

export type FinanceState = {
  phase: FinancePhase;
  snapshot: FinanceSnapshotV1;
  saving: boolean;
  error: string | null;
};

export type FinanceMutationResult =
  | {
      ok: true;
      revision: number;
      /** True when this command created today's allowance row. */
      allowanceCreated: boolean;
      /** Set when no usable horizon exists (limit unavailable on this date). */
      horizonMissing: boolean;
    }
  | { ok: false; reason: FinanceFailureReason };

/** Every mutating command carries the revision it was built from (stale guard). */
export type Revisioned<T> = T & { expectedRevision: number };

export type FinanceStoreDeps = {
  storage: FinanceStorage;
  now: () => Date;
  createId: (prefix: string) => string;
};

export type FinanceStore = {
  getSnapshot(): FinanceState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  retryLoad(): Promise<void>;
  /** Establishes a day's allowance (read-only day-open or pre-mutation step). */
  ensureDay(date: string): Promise<FinanceMutationResult>;
  setup(input: model.SetupInput): Promise<FinanceMutationResult>;
  correctBalance(input: Revisioned<{ balanceMinor: number }>): Promise<FinanceMutationResult>;
  changeTodayAllowance(
    input: Revisioned<{ date: string; manualLimitMinor?: number | null }>,
  ): Promise<FinanceMutationResult>;
  /** Permanent limit settings + optional explicit application to today (one write). */
  saveLimitSettings(
    input: Revisioned<{
      limitMode: model.FinanceLimitModeInput;
      manualLimitMinor: number | null;
      fallbackEndDate: string | null;
      applyToday: boolean;
      date: string;
    }>,
  ): Promise<FinanceMutationResult>;
  /** Explicit today's limit action: CREATES the row when it does not exist yet. */
  applyLimitToday(
    input: Revisioned<{
      date: string;
      mode: model.FinanceLimitModeInput;
      manualLimitMinor?: number | null;
    }>,
  ): Promise<FinanceMutationResult>;
  /** “Получено” for a monthly occurrence (income + resolution + balance in ONE write). */
  receiveMonthlyOccurrence(
    input: Revisioned<model.MonthlyReceiveDraft>,
  ): Promise<FinanceMutationResult>;
  skipMonthlyOccurrence(
    input: Revisioned<{ scheduleId: string; date: string }>,
  ): Promise<FinanceMutationResult>;
  reopenMonthlyOccurrence(
    input: Revisioned<{ scheduleId: string; date: string }>,
  ): Promise<FinanceMutationResult>;
  updateSettings(
    input: Revisioned<{
      limitMode?: model.FinanceLimitModeInput;
      manualLimitMinor?: number | null;
      fallbackEndDate?: string | null;
    }>,
  ): Promise<FinanceMutationResult>;
  addExpense(input: Revisioned<model.ExpenseDraft>): Promise<FinanceMutationResult>;
  editExpense(input: Revisioned<model.ExpenseDraft & { id: string }>): Promise<FinanceMutationResult>;
  deleteExpense(input: Revisioned<{ id: string }>): Promise<FinanceMutationResult>;
  addIncome(input: Revisioned<model.IncomeDraft>): Promise<FinanceMutationResult>;
  editIncome(input: Revisioned<model.IncomeDraft & { id: string }>): Promise<FinanceMutationResult>;
  deleteIncome(input: Revisioned<{ id: string }>): Promise<FinanceMutationResult>;
  addSchedule(input: Revisioned<model.ScheduleDraft>): Promise<FinanceMutationResult>;
  editSchedule(
    input: Revisioned<model.ScheduleDraft & { id: string }>,
  ): Promise<FinanceMutationResult>;
  deleteSchedule(input: Revisioned<{ id: string }>): Promise<FinanceMutationResult>;
  addExpectation(input: Revisioned<model.ExpectationDraft>): Promise<FinanceMutationResult>;
  editExpectation(
    input: Revisioned<model.ExpectationDraft & { id: string }>,
  ): Promise<FinanceMutationResult>;
  skipExpectation(input: Revisioned<{ id: string }>): Promise<FinanceMutationResult>;
  reopenExpectation(input: Revisioned<{ id: string }>): Promise<FinanceMutationResult>;
  deleteExpectation(input: Revisioned<{ id: string }>): Promise<FinanceMutationResult>;
  receiveExpectation(input: Revisioned<model.ReceiveDraft>): Promise<FinanceMutationResult>;
  addObligation(input: Revisioned<model.ObligationDraft>): Promise<FinanceMutationResult>;
  editObligation(
    input: Revisioned<model.ObligationDraft & { id: string }>,
  ): Promise<FinanceMutationResult>;
  setObligationCompleted(
    input: Revisioned<{ id: string; completed: boolean }>,
  ): Promise<FinanceMutationResult>;
  deleteObligation(input: Revisioned<{ id: string }>): Promise<FinanceMutationResult>;
};

const LOAD_ERROR_TEXT =
  'Сохранённые данные финансов повреждены. Мы их не трогаем — повторите попытку позже.';
const READ_ERROR_TEXT = 'Не удалось прочитать сохранённые данные. Повторите попытку.';
const WRITE_ERROR_TEXT =
  'Не удалось сохранить изменения. Проверьте устройство и повторите попытку.';

/** Recursively freezes the committed snapshot (rows, nested refs and settings). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * One central classification for EVERY store command: a command that can change the
 * pre-mutation balance or the AUTO horizon MUST declare `allowance-first`, so the
 * day's allowance is established from the PRE-mutation committed state inside the
 * same candidate and the same durable write. Adding a command without a
 * classification is impossible: the runner reads this table and tests assert it.
 */
export type FinanceCommandPolicy = 'allowance-first' | 'plain';

export const FINANCE_COMMAND_POLICY = {
  setup: 'plain',
  changeTodayAllowance: 'plain',
  applyLimitToday: 'plain',
  correctBalance: 'allowance-first',
  updateSettings: 'allowance-first',
  saveLimitSettings: 'allowance-first',
  addExpense: 'allowance-first',
  editExpense: 'allowance-first',
  deleteExpense: 'allowance-first',
  addIncome: 'allowance-first',
  editIncome: 'allowance-first',
  deleteIncome: 'allowance-first',
  addSchedule: 'allowance-first',
  editSchedule: 'allowance-first',
  deleteSchedule: 'allowance-first',
  addExpectation: 'allowance-first',
  editExpectation: 'allowance-first',
  deleteExpectation: 'allowance-first',
  skipExpectation: 'allowance-first',
  reopenExpectation: 'allowance-first',
  receiveExpectation: 'allowance-first',
  receiveMonthlyOccurrence: 'allowance-first',
  skipMonthlyOccurrence: 'allowance-first',
  reopenMonthlyOccurrence: 'allowance-first',
  addObligation: 'allowance-first',
  editObligation: 'allowance-first',
  setObligationCompleted: 'allowance-first',
  deleteObligation: 'allowance-first',
} as const;

export type FinanceCommandName = keyof typeof FINANCE_COMMAND_POLICY;

export function createFinanceStore({ storage, now, createId }: FinanceStoreDeps): FinanceStore {
  let phase: FinancePhase = 'loading';
  let snapshot: FinanceSnapshotV1 = deepFreeze(
    createEmptyFinanceSnapshot('1970-01-01T00:00:00.000Z'),
  );
  let saving = false;
  let errorText: string | null = null;
  // The very first snapshot is frozen too: `createFinanceStore()` must not hand out
  // a mutable wrapper before `load()` publishes the first state.
  let state: FinanceState = deepFreeze({ phase, snapshot, saving, error: errorText });
  const listeners = new Set<() => void>();
  let loadPromise: Promise<void> | null = null;
  /** True when storage returned bytes we refused to interpret: writes stay blocked. */
  let corruptBytes = false;

  function publish(): void {
    // Every publication is a NEW deeply frozen wrapper: consumers can never mutate
    // `phase`, `saving`, `error`, the envelope or any nested row/setting.
    state = deepFreeze({ phase, snapshot, saving, error: errorText });
    for (const listener of listeners) listener();
  }

  function clock(): model.FinanceClock {
    const instant = now();
    return { nowIso: instant.toISOString(), today: localDateIso(instant) };
  }

  async function doRead(): Promise<void> {
    try {
      const raw = await storage.getItem(FINANCE_STORAGE_KEY);
      if (raw === null) {
        snapshot = deepFreeze(createEmptyFinanceSnapshot(now().toISOString()));
        corruptBytes = false;
        phase = 'ready';
        errorText = null;
        publish();
        return;
      }
      const parsed = parseFinanceSnapshot(raw);
      if (!parsed.ok) {
        // The original bytes are retained and never replaced with an empty state.
        corruptBytes = true;
        snapshot = deepFreeze(createEmptyFinanceSnapshot(now().toISOString()));
        phase = 'load-error';
        errorText = LOAD_ERROR_TEXT;
        publish();
        return;
      }
      snapshot = deepFreeze(parsed.snapshot);
      corruptBytes = false;
      phase = 'ready';
      errorText = null;
      publish();
    } catch {
      corruptBytes = false;
      phase = 'load-error';
      errorText = READ_ERROR_TEXT;
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
    errorText = null;
    publish();
    return load();
  }

  /**
   * Persist-before-commit: serialize, strictly re-parse the exact bytes, freeze the
   * validated snapshot, await ONE durable write, then publish. Nothing here mutates
   * the committed snapshot before the write resolves.
   */
  async function commit(
    candidate: FinanceSnapshotV1,
    expectedRevision: number | null,
  ): Promise<FinanceMutationResult> {
    if (expectedRevision !== null && expectedRevision !== snapshot.revision) {
      return { ok: false, reason: 'stale' };
    }
    // EVERY checked money aggregate must stay a safe integer BEFORE anything is
    // written: an unsafe candidate is a typed `overflow` failure (never clamped,
    // never persisted, never displayed as zero).
    const aggregateIssue = model.validateAggregates(candidate);
    if (aggregateIssue !== null) return { ok: false, reason: aggregateIssue };
    // Monotonic committed revision: a transaction that merged changes without
    // bumping (e.g. the day's allowance) still advances exactly one revision.
    const next =
      candidate.revision > snapshot.revision
        ? candidate
        : { ...candidate, revision: snapshot.revision + 1 };
    const savedAt = now().toISOString();
    const envelope = serializeFinanceSnapshot(next, savedAt);
    const validated = parseFinanceSnapshot(envelope); // parse BEFORE every write
    if (!validated.ok) return { ok: false, reason: 'validation' };
    const frozen = deepFreeze(validated.snapshot);
    saving = true;
    errorText = null;
    publish();
    try {
      await storage.setItem(FINANCE_STORAGE_KEY, envelope);
    } catch {
      saving = false;
      errorText = WRITE_ERROR_TEXT;
      publish();
      return { ok: false, reason: 'storage' };
    }
    snapshot = frozen;
    saving = false;
    errorText = null;
    publish();
    return { ok: true, revision: frozen.revision, allowanceCreated: false, horizonMissing: false };
  }

  function gate(expectedRevision: number | null): FinanceMutationResult | null {
    if (phase === 'load-error' || corruptBytes) return { ok: false, reason: 'load-error' };
    if (phase !== 'ready') return { ok: false, reason: 'not-ready' };
    if (saving) return { ok: false, reason: 'busy' }; // synchronous lock, no queueing
    if (expectedRevision !== null && expectedRevision !== snapshot.revision) {
      return { ok: false, reason: 'stale' };
    }
    return null;
  }
  /**
   * Runs a command with the policy its classification requires (see the table above).
   */
  async function runCommand(
    name: FinanceCommandName,
    expectedRevision: number | null,
    mutate: (base: FinanceSnapshotV1) => model.ModelResult,
  ): Promise<FinanceMutationResult> {
    if (FINANCE_COMMAND_POLICY[name] === 'allowance-first') {
      return await commitMoney(expectedRevision, mutate);
    }
    return await commitState(expectedRevision, mutate);
  }
  /**
   * Establishes TODAY's allowance from the PRE-mutation committed state and applies
   * `mutate` to the RESULTING snapshot in the SAME write. An existing row is never
   * replaced, so today's limit survives every operation, edit, delete and restart.
   */
  async function commitMoney(
    expectedRevision: number | null,
    mutate: (base: FinanceSnapshotV1) => model.ModelResult,
  ): Promise<FinanceMutationResult> {
    const blocked = gate(expectedRevision);
    if (blocked) return blocked;
    const commandClock = clock();
    const established = model.establishAllowance(snapshot, {
      date: commandClock.today,
      clock: commandClock,
    });
    if (!established.ok) return { ok: false, reason: established.error };
    const base = established.snapshot;
    const mutated = mutate(base);
    if (!mutated.ok) return { ok: false, reason: mutated.error };
    // With no pre-mutation horizon, a newly usable setting/expectation may
    // establish the missing row in this SAME write. Existing rows remain fixed.
    const completed = model.establishAllowance(mutated.snapshot, {
      date: commandClock.today,
      clock: commandClock,
    });
    if (!completed.ok) return { ok: false, reason: completed.error };
    // A provisional day-open row is not a previous committed allowance revision.
    const existed = model.allowanceFor(snapshot, commandClock.today) !== null;
    const candidate = existed ? completed.snapshot : {
      ...completed.snapshot,
      allowances: completed.snapshot.allowances.map(row =>
        row.date === commandClock.today ? { ...row, revision: 1 } : row),
    };
    const committed = await commit(candidate, expectedRevision);
    if (!committed.ok) return committed;
    return {
      ok: true,
      revision: committed.revision,
      allowanceCreated: !existed && completed.allowance !== null,
      horizonMissing: completed.allowance === null,
    };
  }

  /** A pure settings/obligation/schedule write (no balance or allowance change). */
  async function commitState(
    expectedRevision: number | null,
    mutate: (base: FinanceSnapshotV1) => model.ModelResult,
  ): Promise<FinanceMutationResult> {
    const blocked = gate(expectedRevision);
    if (blocked) return blocked;
    const mutated = mutate(snapshot);
    if (!mutated.ok) return { ok: false, reason: mutated.error };
    return await commit(mutated.snapshot, expectedRevision);
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    retryLoad,

    /** Read-only day-open and the pre-mutation step of every money command. */
    async ensureDay(date) {
      const blocked = gate(null);
      if (blocked) return blocked;
      const established = model.establishAllowance(snapshot, { date, clock: clock() });
      if (!established.ok) return { ok: false, reason: established.error };
      if (!established.changed) {
        return {
          ok: true,
          revision: snapshot.revision,
          allowanceCreated: false,
          horizonMissing: established.allowance === null,
        };
      }
      const committed = await commit(established.snapshot, null);
      if (!committed.ok) return committed;
      return {
        ok: true,
        revision: committed.revision,
        allowanceCreated: true,
        horizonMissing: false,
      };
    },

    async setup(input) {
      return await commitState(null, (base) => model.initializeFinance(base, { ...input, clock: clock() }));
    },

    async correctBalance(input) {
      return await runCommand('correctBalance', input.expectedRevision, (base) =>
        model.correctBalance(base, { balanceMinor: input.balanceMinor, clock: clock() }),
      );
    },

    async changeTodayAllowance(input) {
      return await runCommand('changeTodayAllowance', input.expectedRevision, (base) =>
        model.changeTodayAllowance(base, {
          date: input.date,
          manualLimitMinor: input.manualLimitMinor,
          clock: clock(),
        }),
      );
    },

    async saveLimitSettings(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('saveLimitSettings', expectedRevision, (base) =>
        model.saveLimitSettings(base, { ...draft, clock: clock() }),
      );
    },

    async applyLimitToday(input) {
      return await runCommand('applyLimitToday', input.expectedRevision, (base) =>
        model.applyTodayAllowance(base, {
          date: input.date,
          mode: input.mode,
          manualLimitMinor: input.manualLimitMinor,
          clock: clock(),
        }),
      );
    },

    async receiveMonthlyOccurrence(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('receiveMonthlyOccurrence', expectedRevision, (base) =>
        model.receiveMonthlyOccurrence(base, {
          ...draft,
          incomeId: createId('income'),
          clock: clock(),
        }),
      );
    },

    async skipMonthlyOccurrence(input) {
      return await runCommand('skipMonthlyOccurrence', input.expectedRevision, (base) =>
        model.skipMonthlyOccurrence(base, {
          scheduleId: input.scheduleId,
          date: input.date,
          clock: clock(),
        }),
      );
    },

    async reopenMonthlyOccurrence(input) {
      return await runCommand('reopenMonthlyOccurrence', input.expectedRevision, (base) =>
        model.reopenMonthlyOccurrence(base, {
          scheduleId: input.scheduleId,
          date: input.date,
          clock: clock(),
        }),
      );
    },

    async updateSettings(input) {
      return await runCommand('updateSettings', input.expectedRevision, (base) =>
        model.updateFinanceSettings(base, {
          limitMode: input.limitMode,
          manualLimitMinor: input.manualLimitMinor,
          fallbackEndDate: input.fallbackEndDate,
          clock: clock(),
        }),
      );
    },

    async addExpense(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('addExpense', expectedRevision, (base) =>
        model.addExpense(base, { id: createId('expense'), ...draft, clock: clock() }),
      );
    },

    async editExpense(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('editExpense', expectedRevision, (base) =>
        model.editExpense(base, { ...draft, clock: clock() }),
      );
    },

    async deleteExpense(input) {
      return await runCommand('deleteExpense', input.expectedRevision, (base) =>
        model.deleteExpense(base, { id: input.id, clock: clock() }),
      );
    },

    async addIncome(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('addIncome', expectedRevision, (base) =>
        model.addIncome(base, { id: createId('income'), ...draft, clock: clock() }),
      );
    },

    async editIncome(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('editIncome', expectedRevision, (base) =>
        model.editIncome(base, { ...draft, clock: clock() }),
      );
    },

    async deleteIncome(input) {
      return await runCommand('deleteIncome', input.expectedRevision, (base) =>
        model.deleteIncome(base, { id: input.id, clock: clock() }),
      );
    },

    async receiveExpectation(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('receiveExpectation', expectedRevision, (base) =>
        model.receiveOneTimeExpectation(base, {
          ...draft,
          incomeId: createId('income'),
          clock: clock(),
        }),
      );
    },

    async addSchedule(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('addSchedule', expectedRevision, (base) =>
        model.addSalarySchedule(base, { id: createId('schedule'), ...draft, clock: clock() }),
      );
    },

    async editSchedule(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('editSchedule', expectedRevision, (base) =>
        model.editSalarySchedule(base, { ...draft, clock: clock() }),
      );
    },

    async deleteSchedule(input) {
      return await runCommand('deleteSchedule', input.expectedRevision, (base) =>
        model.deleteSalarySchedule(base, { id: input.id, clock: clock() }),
      );
    },

    async addExpectation(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('addExpectation', expectedRevision, (base) =>
        model.addOneTimeExpectation(base, {
          id: createId('expectation'),
          ...draft,
          clock: clock(),
        }),
      );
    },

    async editExpectation(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('editExpectation', expectedRevision, (base) =>
        model.editOneTimeExpectation(base, { ...draft, clock: clock() }),
      );
    },

    async skipExpectation(input) {
      return await runCommand('skipExpectation', input.expectedRevision, (base) =>
        model.skipOneTimeExpectation(base, { id: input.id, clock: clock() }),
      );
    },

    async reopenExpectation(input) {
      return await runCommand('reopenExpectation', input.expectedRevision, (base) =>
        model.reopenOneTimeExpectation(base, { id: input.id, clock: clock() }),
      );
    },

    async deleteExpectation(input) {
      return await runCommand('deleteExpectation', input.expectedRevision, (base) =>
        model.deleteOneTimeExpectation(base, { id: input.id, clock: clock() }),
      );
    },

    async addObligation(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('addObligation', expectedRevision, (base) =>
        model.addObligation(base, { id: createId('obligation'), ...draft, clock: clock() }),
      );
    },

    async editObligation(input) {
      const { expectedRevision, ...draft } = input;
      return await runCommand('editObligation', expectedRevision, (base) =>
        model.editObligation(base, { ...draft, clock: clock() }),
      );
    },

    async setObligationCompleted(input) {
      return await runCommand('setObligationCompleted', input.expectedRevision, (base) =>
        model.setObligationCompleted(base, {
          id: input.id,
          completed: input.completed,
          clock: clock(),
        }),
      );
    },

    async deleteObligation(input) {
      return await runCommand('deleteObligation', input.expectedRevision, (base) =>
        model.deleteObligation(base, { id: input.id, clock: clock() }),
      );
    },
  };
}
