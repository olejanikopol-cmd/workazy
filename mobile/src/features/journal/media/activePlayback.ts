/**
 * Identity-guarded active-playback ownership for the journal sheet.
 *
 * A card may only clear or replace the active media id if it IS the current owner at
 * that moment. A late `onFinished`/failure callback from media A can therefore never
 * clear media B's playback (the defect: `setActiveMediaId(null)` from an old card).
 * The sheet uses these exact helpers in its state updaters.
 */
export function clearActivePlayback(current: string | null, mediaId: string): string | null {
  return current === mediaId ? null : current;
}

export function claimActivePlayback(current: string | null, mediaId: string): string {
  return current === mediaId ? mediaId : mediaId;
}
