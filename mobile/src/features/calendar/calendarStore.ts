/**
 * Pure calendar store factory: hydration gate, one committed events array plus
 * notification registry, persist-before-commit, and a synchronous write lock.
 *
 * The factory is instantiated once by the native binding module
 * (`useCalendarStore.ts`), which supplies AsyncStorage, a real clock and the ID
 * generator. All mutations are rejected until hydration succeeds, and a second
 * mutation while a write is pending returns `busy` without queueing or writing.
 * `setRegistry` merges into the CURRENT committed events (never a stale copy),
 * so deferred notification reconciliation cannot overwrite a newer event edit.
 */
import {
  CALENDAR_STORAGE_KEY,
  parseSnapshot,
  serializeSnapshot,
  type CalendarStorage,
} from '@/storage/calendarStorage';
import type { CalendarEvent, CalendarNotificationRecord } from '@/types/calendar';
import { addEvent, editEvent, removeEvent, type CalendarEventInput } from './calendarModel';

export type CalendarPhase = 'loading' | 'ready' | 'load-error';

export type CalendarState = {
  phase: CalendarPhase;
  events: readonly CalendarEvent[];
  registry: readonly CalendarNotificationRecord[];
  saving: boolean;
  error: string | null;
};

export type CalendarMutationResult =
  | { ok: true }
  | { ok: false; reason: 'not-ready' | 'busy' | 'validation' | 'missing' | 'storage' };

export type CreateCalendarStoreDeps = {
  storage: CalendarStorage;
  now: () => Date;
  createId: () => string;
};

export type CalendarStore = {
  getSnapshot(): CalendarState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  retryLoad(): Promise<void>;
  add(input: CalendarEventInput): Promise<CalendarMutationResult>;
  edit(id: string, input: CalendarEventInput): Promise<CalendarMutationResult>;
  remove(id: string): Promise<CalendarMutationResult>;
  setRegistry(records: readonly CalendarNotificationRecord[]): Promise<CalendarMutationResult>;
  /** Monotonic revision of committed EVENT state (bumped by add/edit/remove). */
  getRevision(): number;
};

const INITIAL_EVENTS: readonly CalendarEvent[] = [];
const INITIAL_REGISTRY: readonly CalendarNotificationRecord[] = [];

const FAIL_NOT_READY: CalendarMutationResult = { ok: false, reason: 'not-ready' };
const FAIL_BUSY: CalendarMutationResult = { ok: false, reason: 'busy' };

export function createCalendarStore({
  storage,
  now,
  createId,
}: CreateCalendarStoreDeps): CalendarStore {
  let phase: CalendarPhase = 'loading';
  let events: readonly CalendarEvent[] = INITIAL_EVENTS;
  let registry: readonly CalendarNotificationRecord[] = INITIAL_REGISTRY;
  let saving = false;
  let errorText: string | null = null;
  let state: CalendarState = { phase, events, registry, saving, error: errorText };
  let listeners = new Set<() => void>();
  let loadPromise: Promise<void> | null = null;
  let revision = 0;

  function publish(): void {
    state = { phase, events, registry, saving, error: errorText };
    for (const listener of listeners) listener();
  }

  function getSnapshot(): CalendarState {
    return state;
  }

  function getRevision(): number {
    return revision;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function doRead(): Promise<void> {
    try {
      const raw = await storage.getItem(CALENDAR_STORAGE_KEY);
      if (raw === null) {
        events = INITIAL_EVENTS;
        registry = INITIAL_REGISTRY;
        phase = 'ready';
        errorText = null;
        revision += 1;
        publish();
        return;
      }
      const parsed = parseSnapshot(raw);
      if (!parsed.ok) {
        events = INITIAL_EVENTS;
        registry = INITIAL_REGISTRY;
        phase = 'load-error';
        errorText = 'Сохранённые данные календаря повреждены. Повторите попытку позже.';
        publish();
        return;
      }
      events = parsed.snapshot.events;
      registry = parsed.snapshot.registry;
      phase = 'ready';
      errorText = null;
      revision += 1;
      publish();
    } catch {
      events = INITIAL_EVENTS;
      registry = INITIAL_REGISTRY;
      phase = 'load-error';
      errorText = 'Не удалось прочитать сохранённые данные календаря. Повторите попытку.';
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

  /**
   * Persist-before-commit: compute the next immutable arrays, await one full
   * envelope write, then publish. The write lock is synchronous — a second
   * mutation sees `saving` immediately and returns `busy`.
   */
  async function commit(
    nextEvents: readonly CalendarEvent[],
    nextRegistry: readonly CalendarNotificationRecord[],
  ): Promise<CalendarMutationResult> {
    if (nextEvents === events && nextRegistry === registry) return { ok: true };
    const envelope = serializeSnapshot(nextEvents, nextRegistry, now().toISOString());
    saving = true;
    errorText = null;
    publish();
    try {
      await storage.setItem(CALENDAR_STORAGE_KEY, envelope);
    } catch {
      saving = false;
      errorText = 'Не удалось сохранить изменения календаря. Повторите попытку.';
      publish();
      return { ok: false, reason: 'storage' };
    }
    const eventsChanged = nextEvents !== events;
    events = nextEvents;
    registry = nextRegistry;
    if (eventsChanged) revision += 1;
    saving = false;
    errorText = null;
    publish();
    return { ok: true };
  }

  function gate(): CalendarMutationResult | null {
    if (phase !== 'ready') return FAIL_NOT_READY;
    if (saving) return FAIL_BUSY;
    return null;
  }

  async function add(input: CalendarEventInput): Promise<CalendarMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = addEvent(events, { ...input, id: createId(), now: now() });
    if (!result.ok) return { ok: false, reason: 'validation' };
    return commit(result.events, registry);
  }

  async function edit(id: string, input: CalendarEventInput): Promise<CalendarMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = editEvent(events, id, input, now());
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.events, registry);
  }

  async function remove(id: string): Promise<CalendarMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    const result = removeEvent(events, id);
    if (!result.ok) return { ok: false, reason: result.reason };
    return commit(result.events, registry);
  }

  async function setRegistry(
    records: readonly CalendarNotificationRecord[],
  ): Promise<CalendarMutationResult> {
    const blocked = gate();
    if (blocked) return blocked;
    return commit(events, records);
  }

  return {
    getSnapshot,
    getRevision,
    subscribe,
    load,
    retryLoad,
    add,
    edit,
    remove,
    setRegistry,
  };
}
