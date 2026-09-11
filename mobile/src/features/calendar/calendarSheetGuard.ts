/**
 * Pure guard for async calendar sheet completion and draft-dirty detection.
 *
 * A slow save racing a newly opened sheet must not let the old sheet's
 * completion close the new one. The parent keeps a single `openSheet` state;
 * `closeSheetIfSame` applies a completion only when the completed sheet key is
 * still the open one. Used by `CalendarScreen` with `CalendarEventSheet`.
 */
export type OpenSheet = { key: string } | null;

/**
 * Close the open sheet only if it is the sheet whose save/action completed.
 * Generic so the caller's richer sheet state type is preserved.
 */
export function closeSheetIfSame<T extends { key: string }>(
  open: T | null,
  completedKey: string,
): T | null {
  return open !== null && open.key === completedKey ? null : open;
}

/** True when the open sheet is exactly `key` (used before closing). */
export function isSameSheet(open: OpenSheet, key: string): boolean {
  return open !== null && open.key === key;
}

/** Synchronous busy lock shared by the editor's save and delete operations. */
export type SheetLock = {
  /** True when it became busy; false when an operation is already pending. */
  acquire(): boolean;
  release(): void;
  isBusy(): boolean;
};

/**
 * Synchronous (non-async) busy lock. `acquire` is taken BEFORE any await and
 * returns false while an operation is pending, so a second save/delete — or a
 * dismissal — is rejected immediately and the UI can disable every control for
 * the whole duration of the pending operation. Delete uses exactly the same
 * lock as save, so a delete in flight cannot be raced by an edit/save/close.
 */
export function createSheetLock(): SheetLock {
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

/**
 * Apply an async sheet completion (save/delete) to the CURRENT open sheet.
 *
 * The completion is applied only when the completed sheet key still matches the
 * open sheet — an old delete/save completion racing a newly opened sheet must
 * never close the newer instance. The destination-date reveal happens only for
 * the closed sheet's completion (never for a stale one, so the view is not
 * yanked to an old event's date while a newer sheet is open).
 */
export function applySheetCompletion<T extends { key: string }>(
  open: T | null,
  completedKey: string,
  destinationDate?: string,
): { next: T | null; reveal: string | null } {
  const matched = open !== null && open.key === completedKey;
  if (!matched) return { next: open, reveal: null };
  return { next: null, reveal: destinationDate ?? null };
}

/** True when a draft change count still matches the snapshot taken at save start. */
export function isDraftUnchanged(revisionNow: number, revisionAtSave: number): boolean {
  return revisionNow === revisionAtSave;
}

/** Editor draft fields relevant to dirty detection. */
export type CalendarSheetDraft = {
  title: string;
  note: string;
  date: string;
  hasTime: boolean;
  time: string;
  reminder: string;
};

/**
 * Pure dirty detection covering title, note, date, time/Без-времени and
 * reminder. `initial` is the snapshot captured when the sheet opened (for edit
 * it equals the stored item; for add it equals the new-event defaults), so an
 * untouched form is never "dirty". Time is only compared when both states have
 * an exact time enabled.
 */
export function isSheetDirty(
  draft: CalendarSheetDraft,
  initial: CalendarSheetDraft,
): boolean {
  if (draft.title !== initial.title) return true;
  if (draft.note !== initial.note) return true;
  if (draft.date !== initial.date) return true;
  if (draft.hasTime !== initial.hasTime) return true;
  if (draft.hasTime && draft.time !== initial.time) return true;
  if (draft.reminder !== initial.reminder) return true;
  return false;
}