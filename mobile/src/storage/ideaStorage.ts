/**
 * Native ideas persistence: single storage key, versioned envelope, strict
 * parser/serializer, and the injected key/value storage interface.
 *
 * Structural parsing only: unknown Idea enums, missing/invalid timestamps,
 * duplicate or empty ids, bad arrays/types reject the WHOLE snapshot with
 * `load-error` and leave the stored bytes untouched. Titles/descriptions longer
 * than the input limits still load (the limits are input rules), matching the
 * web client's tolerance for previously valid rows.
 */
import type { Idea, IdeaCategory, IdeaStatus, IdeasSnapshotV1 } from '@/types/idea';
import { isValidIsoTimestamp } from '@/features/plans/planDates';

/** Distinct key from the web planner's browser-storage key. */
export const IDEAS_STORAGE_KEY = 'workazy-native-ideas-v1';

export type IdeaStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type IdeasParseResult =
  | { ok: true; snapshot: IdeasSnapshotV1 }
  | { ok: false; error: string };

/** Live product semantics — order matters for the UI filter rows. */
export const IDEA_CATEGORIES: readonly IdeaCategory[] = [
  'thought',
  'want',
  'project',
  'purchase',
  'someday',
];

export const IDEA_STATUSES: readonly IdeaStatus[] = [
  'new',
  'thinking',
  'plan',
  'done',
  'archive',
];

/** Copy rows so subscribers cannot mutate committed state. */
export function cloneIdeas(ideas: readonly Idea[]): Idea[] {
  return ideas.map((idea) => ({ ...idea }));
}

/**
 * Deep-freeze copy for the PUBLISHED store state (rows + array), so external
 * mutation of a returned snapshot cannot change committed state, notify
 * subscribers, or leak into a later write. Stable reference kept for
 * `useSyncExternalStore`.
 */
export function deepFreezeIdeas(ideas: readonly Idea[]): readonly Idea[] {
  return Object.freeze(ideas.map((idea) => Object.freeze({ ...idea })));
}

export function serializeSnapshot(ideas: readonly Idea[], savedAt: string): string {
  const snapshot: IdeasSnapshotV1 = {
    version: 1,
    ideas: cloneIdeas(ideas),
    savedAt,
  };
  return JSON.stringify(snapshot);
}

export function isIdeaCategory(value: unknown): value is IdeaCategory {
  return typeof value === 'string' && IDEA_CATEGORIES.includes(value as IdeaCategory);
}

export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return typeof value === 'string' && IDEA_STATUSES.includes(value as IdeaStatus);
}

export function parseSnapshot(raw: string): IdeasParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not-object' };
  }
  const object = parsed as Record<string, unknown>;
  if (object.version !== 1) return { ok: false, error: 'unknown-version' };
  if (!Array.isArray(object.ideas)) return { ok: false, error: 'ideas-not-array' };
  if (typeof object.savedAt !== 'string' || !isValidIsoTimestamp(object.savedAt)) {
    return { ok: false, error: 'bad-saved-at' };
  }

  const ideas: Idea[] = [];
  const seenIds = new Set<string>();
  for (const rawIdea of object.ideas) {
    if (rawIdea === null || typeof rawIdea !== 'object' || Array.isArray(rawIdea)) {
      return { ok: false, error: 'idea-not-object' };
    }
    const item = rawIdea as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return { ok: false, error: 'bad-idea-id' };
    }
    if (seenIds.has(item.id)) return { ok: false, error: 'duplicate-idea-id' };
    seenIds.add(item.id);
    if (typeof item.title !== 'string' || item.title.trim().length === 0) {
      return { ok: false, error: 'bad-idea-title' };
    }
    if (item.description !== undefined && typeof item.description !== 'string') {
      return { ok: false, error: 'bad-idea-description' };
    }
    if (!isIdeaCategory(item.category)) return { ok: false, error: 'bad-idea-category' };
    if (!isIdeaStatus(item.status)) return { ok: false, error: 'bad-idea-status' };
    if (typeof item.createdAt !== 'string' || !isValidIsoTimestamp(item.createdAt)) {
      return { ok: false, error: 'bad-idea-created-at' };
    }
    if (typeof item.updatedAt !== 'string' || !isValidIsoTimestamp(item.updatedAt)) {
      return { ok: false, error: 'bad-idea-updated-at' };
    }

    const idea: Idea = {
      id: item.id,
      title: item.title,
      category: item.category,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
    if (item.description !== undefined) idea.description = item.description as string;
    ideas.push(idea);
  }

  return { ok: true, snapshot: { version: 1, ideas, savedAt: object.savedAt } };
}
