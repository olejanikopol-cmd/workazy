/**
 * Pure guard for async sheet completion.
 *
 * A slow save racing a newly opened sheet must not let the old sheet's
 * completion close the new one. The parent keeps a single `openSheet` state;
 * `closeSheetIfSame` applies a completion only when the completed sheet key is
 * still the open one. Used by `PlanDayView` with `PlanItemSheet`.
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

/** True when a draft change count still matches the snapshot taken at save start. */
export function isDraftUnchanged(revisionNow: number, revisionAtSave: number): boolean {
  return revisionNow === revisionAtSave;
}