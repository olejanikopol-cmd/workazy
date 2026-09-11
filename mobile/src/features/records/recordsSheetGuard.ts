/**
 * Records-owned sheet policy: synchronous busy lock, completion identity guard
 * and dirty detection for the Journal and Ideas editors.
 *
 * This mirrors the Calendar/Plan policy but lives in Records so neither feature
 * has to generalize the other. Completion is applied ONLY to the sheet identity
 * captured when the operation started: an old async save/delete completion can
 * never close, clear or redirect a newer editor, and a stale confirmation can
 * never discard a newer draft.
 */
import type { IdeaCategory, IdeaStatus } from '@/types/idea';

/** Synchronous busy lock shared by an editor's save, delete and status writes. */
export type RecordsSheetLock = {
  /** True when it became busy; false when an operation is already pending. */
  acquire(): boolean;
  release(): void;
  isBusy(): boolean;
};

/**
 * Synchronous (non-async) lock. `acquire` is taken BEFORE any await and returns
 * false while an operation is pending, so a second save/delete/status write or
 * a dismissal is rejected immediately and every control can be disabled for the
 * whole duration of the pending operation.
 */
export function createRecordsSheetLock(): RecordsSheetLock {
  let busy = false;
  return {
    acquire(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    release(): void {
      busy = false;
    },
    isBusy(): boolean {
      return busy;
    },
  };
}

export type CompletionOutcome<T> = { next: T | null; applied: boolean };

/**
 * Apply an async completion to the CURRENT open sheet. `applied` is true only
 * when the completed sheet is still the open one; the caller uses it to reveal /
 * clear / redirect. A superseded completion changes nothing.
 */
export function applySheetCompletion<T extends { key: string }>(
  open: T | null,
  completedKey: string,
): CompletionOutcome<T> {
  if (open === null || open.key !== completedKey) return { next: open, applied: false };
  return { next: null, applied: true };
}

/** True when a draft change count still matches the snapshot taken at save start. */
export function isDraftUnchanged(revisionNow: number, revisionAtSave: number): boolean {
  return revisionNow === revisionAtSave;
}

/** Journal editor fields relevant to dirty detection (tags compared raw). */
export type JournalDraft = {
  title: string;
  body: string;
  mood: string;
  tags: string;
};

/** Every journal field participates, including the raw tag input. */
export function journalDraftDirty(draft: JournalDraft, initial: JournalDraft): boolean {
  return (
    draft.title !== initial.title ||
    draft.body !== initial.body ||
    draft.mood !== initial.mood ||
    draft.tags !== initial.tags
  );
}

/** Idea editor fields relevant to dirty detection. */
export type IdeaDraft = {
  title: string;
  description: string;
  category: IdeaCategory;
  status: IdeaStatus;
};

/** Every idea field participates (title/description/category/status). */
export function ideaDraftDirty(draft: IdeaDraft, initial: IdeaDraft): boolean {
  return (
    draft.title !== initial.title ||
    draft.description !== initial.description ||
    draft.category !== initial.category ||
    draft.status !== initial.status
  );
}

// ---------------------------------------------------------------------------
// Parent completion policy (used by RecordsScreen for both domains).
// ---------------------------------------------------------------------------

/** What a finished sheet operation was, so the parent can reveal/clear. */
export type SheetOutcome =
  | { action: 'created' }
  | { action: 'saved'; id: string }
  | { action: 'deleted'; id: string };

/**
 * Whether a finished operation should close the sheet. A successful EDIT keeps
 * the sheet open and returns to the reader (the saved entry stays on screen);
 * create and delete close it.
 */
export function journalCompletionAction(outcome: SheetOutcome): 'close' | 'stay-open' {
  return outcome.action === 'saved' ? 'stay-open' : 'close';
}

export type JournalCompletionEffects = {
  /** Switch the journal mode (create reveals History). */
  mode: 'write' | 'history' | null;
  /** Clear the search so the created/saved entry is visible. */
  clearSearch: boolean;
};

/**
 * Journal completion policy: a create switches to History and clears the search;
 * an edit clears the search ONLY when the current query would hide the saved
 * entry; a delete changes nothing beyond closing the sheet.
 */
export function journalCompletionEffects(
  outcome: SheetOutcome,
  savedEntry: { title?: string; body: string; mood?: string; tags: readonly string[]; media?: readonly { transcript?: string }[] } | undefined,
  query: string,
): JournalCompletionEffects {
  if (outcome.action === 'created') return { mode: 'history', clearSearch: true };
  if (outcome.action === 'deleted') return { mode: null, clearSearch: false };
  const needle = query.trim().toLowerCase();
  if (savedEntry === undefined) return { mode: null, clearSearch: false };
  const transcripts = (savedEntry.media ?? []).map((item) => item.transcript ?? '').join(' ');
  const text = [
    savedEntry.title ?? '',
    savedEntry.body,
    savedEntry.mood ?? '',
    savedEntry.tags.join(' '),
    transcripts,
  ]
    .join(' ')
    .toLowerCase();
  return { mode: null, clearSearch: needle.length > 0 && !text.includes(needle) };
}

export type IdeaCompletionEffects = {
  /** Remove the category filter (because it would hide the idea). */
  clearCategory: boolean;
  /** Remove the status filter (because it would hide the idea). */
  clearStatus: boolean;
};

/**
 * Ideas completion policy: clear ONLY the excluding filters so the created or
 * saved idea is visible; a delete changes nothing.
 */
export function ideaCompletionEffects(
  outcome: SheetOutcome,
  target: { category: IdeaCategory; status: IdeaStatus } | undefined,
  filters: { category: IdeaCategory | 'all'; status: IdeaStatus | 'all' },
): IdeaCompletionEffects {
  if (outcome.action === 'deleted' || target === undefined) {
    return { clearCategory: false, clearStatus: false };
  }
  return {
    clearCategory: filters.category !== 'all' && filters.category !== target.category,
    clearStatus: filters.status !== 'all' && filters.status !== target.status,
  };
}

// ---------------------------------------------------------------------------
// Delayed confirmation guard (discard / delete confirmations).
// ---------------------------------------------------------------------------

export type DelayedConfirmationCheck = {
  /** Is the sheet that OPENED the confirmation still the current one? */
  stillCurrent: boolean;
  /** Is a save/delete/status operation already pending? */
  busy: boolean;
  /** Draft/operation revision captured when the confirmation opened. */
  revisionAtConfirm: number;
  /** Current draft revision. */
  revisionNow: number;
};

/**
 * A confirmation callback runs LATER, so it must re-check the CURRENT state
 * before closing or mutating: the confirming sheet must still be the current
 * one, no operation may be pending, and the draft must not have changed while
 * the confirmation was open. A confirmation opened for sheet A therefore can
 * never close or mutate anything once sheet B has become current.
 */
export function allowDelayedConfirmation(check: DelayedConfirmationCheck): boolean {
  if (!check.stillCurrent) return false;
  if (check.busy) return false;
  return isDraftUnchanged(check.revisionNow, check.revisionAtConfirm);
}
