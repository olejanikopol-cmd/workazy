/**
 * Authoritative "may this take be attached?" decision.
 *
 * Used by the recorder surface BOTH immediately before adoption and again after
 * the awaited adoption, so a stale recorder can never transfer media to a newer
 * editor, and never even promotes a file it must not keep.
 *
 * The decision reads only SYNCHRONOUS authoritative sources: the parent's current
 * sheet identity (its own ref, not a rendered prop), the parent's lock/busy
 * state, the draft identity/revision, the recorder session/generation and whether
 * the surface is still mounted. A rendered value that lags a frame can therefore
 * never authorize a transfer.
 */
import { mediaFailure, type DraftIdentity, type MediaFailure, type MediaOwner } from './mediaContracts';

export type AttachAuthorizationContext = {
  /** Owner recorded when the recorder surface opened (null = no session). */
  captured: MediaOwner | null;
  /** The controller's live owner (null when this recorder lost its session). */
  current: MediaOwner | null;
  /** Live sheet-level draft identity. */
  live: DraftIdentity;
  /** Parent's synchronous "this sheet is still the open one" answer. */
  parentIsCurrent: boolean;
  /** Parent's synchronous busy/lock state (never a rendered flag). */
  editorBusy: boolean;
  /** Surface still mounted/visible. */
  mounted: boolean;
};

/** null = the take may be attached; otherwise the refusal reason. */
export function authorizeAttach(context: AttachAuthorizationContext): MediaFailure | null {
  if (!context.mounted) return mediaFailure('cancelled');
  const captured = context.captured;
  const current = context.current;
  if (captured === null || current === null) return mediaFailure('cancelled');
  // The recorder session itself must still be the live one.
  if (
    current.sessionId !== captured.sessionId ||
    current.generation !== captured.generation
  ) {
    return mediaFailure('cancelled');
  }
  // The editor that opened this recorder must still be the open one.
  if (!context.parentIsCurrent) return mediaFailure('busy');
  if (context.editorBusy) return mediaFailure('busy');
  if (
    context.live.sheetKey !== captured.sheetKey ||
    context.live.draftKey !== captured.draftKey ||
    context.live.entryId !== captured.entryId
  ) {
    return mediaFailure('busy');
  }
  if (context.live.draftRevision !== captured.draftRevision) return mediaFailure('busy');
  return null;
}
