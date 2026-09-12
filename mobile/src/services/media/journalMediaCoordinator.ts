/**
 * Journal media coordinator: the ONLY place where file work and journal
 * metadata writes are ordered together in production.
 *
 * Ordering guarantees (see the brief's cleanup table):
 * - Save with additions: hold leases -> prepare/verify every file -> re-check the
 *   current owner and the latest committed rows -> store write -> release only
 *   the committed leases. A failed metadata write keeps the leases and the
 *   prepared files so the draft stays retryable with the same take ids.
 * - Removing an attachment / deleting an entry: durable metadata removal FIRST;
 *   owned files are deleted only afterwards and only for now-unreferenced media.
 *   A failed write leaves the playable committed attachment intact.
 * - A cleanup failure after a successful removal is reported and retryable; it
 *   never reports the metadata save as failed.
 * - Delete decisions always read the CURRENT hydrated committed references, never
 *   a stale list captured across awaits.
 *
 * It also owns the active leases so startup/foreground reconciliation cannot race
 * a draft promotion or a playback source.
 */
import type { JournalMediaAttachmentInput, JournalEntryInput } from '@/features/journal/journalModel';
import type { JournalMutationResult, JournalStore } from '@/features/journal/journalStore';
import {
  mediaFailure,
  type DraftIdentity,
  type LocalMediaDraft,
  type MediaFailure,
} from './mediaContracts';
import type { LocalMediaRepository, ReconcileInput, ReconcileOutcome } from './localMediaRepository';

export type CoordinatorDeps = {
  repository: LocalMediaRepository;
  store: JournalStore;
  /** Synchronous identity of the editor that is CURRENTLY open (or null). */
  currentOwner: () => DraftIdentity | null;
};

export type CoordinatorCleanup = { failed: { path: string; message: string }[] };

export type CoordinatorOutcome =
  | { ok: true; entryId: string; cleanup: CoordinatorCleanup }
  | { ok: false; failure: MediaFailure; cleanup?: CoordinatorCleanup };

export type JournalMediaCoordinator = {
  /** Register a staged/adopted take as an active lease (kept out of sweeps). */
  lease(draft: LocalMediaDraft): void;
  /** Drop a lease (after commit or after explicit cleanup). */
  releaseLease(mediaId: string): void;
  /** Register a live recorder session so its staging directory is never swept. */
  leaseSession(sessionId: string): void;
  releaseSession(sessionId: string): void;
  activeMediaIds(): ReadonlySet<string>;
  activeSessionIds(): ReadonlySet<string>;
  /**
   * Explicitly abandon uncommitted draft takes: release their leases, then remove
   * only their own staging/promoted files (re-reading committed references and
   * refusing anything still referenced). Failures stay retryable via reconcile.
   */
  abandonDrafts(drafts: readonly LocalMediaDraft[]): Promise<CoordinatorCleanup>;
  /** New entry: prepare all takes, then ONE journal write with the metadata. */
  commitNewEntry(
    owner: DraftIdentity,
    input: JournalEntryInput,
    date: string,
    drafts: readonly LocalMediaDraft[],
  ): Promise<CoordinatorOutcome>;
  /** Existing entry: prepare additions, then merge into the latest row. */
  commitEdit(
    owner: DraftIdentity,
    entryId: string,
    input: JournalEntryInput,
    change: { add: readonly LocalMediaDraft[]; removeIds?: readonly string[] },
  ): Promise<CoordinatorOutcome>;
  /** Reader action: metadata removal first, then owned-file cleanup. */
  removeCommittedAttachment(entryId: string, mediaId: string): Promise<CoordinatorOutcome>;
  /** Entry deletion: metadata first, then cleanup of its now-unreferenced files. */
  deleteEntry(entryId: string): Promise<CoordinatorOutcome>;
  /** Startup/foreground reconciliation; no-ops unless the journal is hydrated. */
  reconcile(): Promise<ReconcileOutcome>;
};

function failure(code: Parameters<typeof mediaFailure>[0]): CoordinatorOutcome {
  return { ok: false, failure: mediaFailure(code) };
}

function mapStoreReason(reason: string): Parameters<typeof mediaFailure>[0] {
  switch (reason) {
    case 'not-ready':
      return 'not-ready';
    case 'busy':
      return 'busy';
    case 'storage':
    case 'invalid-snapshot':
      return 'save-failed';
    case 'duplicate-id':
    case 'media-duplicate':
      return 'manifest-invalid';
    case 'missing':
    case 'media-missing':
      return 'entry-missing';
    default:
      // Every remaining reason is a text/media input validation failure.
      return 'validation-failed';
  }
}

export function createJournalMediaCoordinator(deps: CoordinatorDeps): JournalMediaCoordinator {
  const leaseDrafts = new Map<string, LocalMediaDraft>();
  const sessionLeases = new Set<string>();

  /**
   * Serializes every operation that can promote, reference or delete media. A
   * sweep therefore can never run in the middle of a commit, and a commit can
   * never be interleaved with destructive cleanup.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function lease(draft: LocalMediaDraft): void {
    leaseDrafts.set(draft.id, draft);
  }

  function releaseLease(mediaId: string): void {
    leaseDrafts.delete(mediaId);
  }

  function activeMediaIds(): ReadonlySet<string> {
    return new Set(leaseDrafts.keys());
  }

  function activeSessionIds(): ReadonlySet<string> {
    const sessions = new Set<string>(sessionLeases);
    for (const draft of leaseDrafts.values()) sessions.add(draft.owner.sessionId);
    return sessions;
  }

  /** Every media id referenced by the CURRENT committed rows. */
  function committedMediaIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of deps.store.getSnapshot().entries) {
      for (const media of entry.media ?? []) ids.add(media.id);
    }
    return ids;
  }

  function isHydrated(): boolean {
    return deps.store.getSnapshot().phase === 'ready';
  }

  function ownerMatches(owner: DraftIdentity): boolean {
    const current = deps.currentOwner();
    if (current === null) return false;
    return (
      current.sheetKey === owner.sheetKey &&
      current.entryId === owner.entryId &&
      current.draftKey === owner.draftKey &&
      current.draftRevision === owner.draftRevision
    );
  }

  /**
   * Authoritative readers handed to the repository. The repository re-reads them
   * immediately before every delete, so a sweep can never remove a file that was
   * committed or leased while the sweep was in flight.
   */
  function readers(): ReconcileInput {
    return {
      references: () => committedMediaIds(),
      leasedSessions: () => activeSessionIds(),
      leasedMedia: () => activeMediaIds(),
      canDelete: () => {
        const state = deps.store.getSnapshot();
        return state.phase === 'ready' && !state.saving;
      },
    };
  }

  /** Sweep owned, unreferenced, unleased files. Caller holds the operation lock. */
  async function sweep(): Promise<CoordinatorCleanup> {
    if (!isHydrated()) return { failed: [] };
    const state = deps.store.getSnapshot();
    if (state.saving) return { failed: [] };
    const result = await deps.repository.reconcile(readers(), { hydrated: true });
    return { failed: result.failed };
  }

  async function abandonDrafts(
    drafts: readonly LocalMediaDraft[],
  ): Promise<CoordinatorCleanup> {
    return await runExclusive(async () => {
      const failed: { path: string; message: string }[] = [];
      for (const draft of drafts) releaseLease(draft.id);
      for (const draft of drafts) {
        const staged = await deps.repository.discard(draft);
        failed.push(...staged.failed);
        // A promoted-but-uncommitted take (failed save retry) is removed only when
        // the CURRENT committed metadata does not reference or lease it.
        const removed = await deps.repository.removeOwned(draft.id, {
          isReferenced: () => committedMediaIds().has(draft.id),
          isLeased: () => activeMediaIds().has(draft.id),
        });
        failed.push(...removed.failed);
      }
      return { failed };
    });
  }

  async function prepareAll(
    drafts: readonly LocalMediaDraft[],
    owner: DraftIdentity,
  ): Promise<
    { ok: true; metadata: JournalMediaAttachmentInput[] } | { ok: false; outcome: CoordinatorOutcome }
  > {
    const metadata: JournalMediaAttachmentInput[] = [];
    for (const draft of drafts) {
      const prepared = await deps.repository.prepare(draft, owner);
      if (!prepared.ok) return { ok: false, outcome: { ok: false, failure: prepared.failure } };
      metadata.push(prepared.prepared.metadata);
    }
    return { ok: true, metadata };
  }

  async function commitNewEntry(
    owner: DraftIdentity,
    input: JournalEntryInput,
    date: string,
    drafts: readonly LocalMediaDraft[],
  ): Promise<CoordinatorOutcome> {
    return await runExclusive(() => commitNewEntryExclusive(owner, input, date, drafts));
  }

  async function commitNewEntryExclusive(
    owner: DraftIdentity,
    input: JournalEntryInput,
    date: string,
    drafts: readonly LocalMediaDraft[],
  ): Promise<CoordinatorOutcome> {
    if (!isHydrated()) return failure('not-ready');
    for (const draft of drafts) lease(draft);
    const prepared = await prepareAll(drafts, owner);
    if (!prepared.ok) return prepared.outcome; // leases + files stay retryable
    // Re-check the CURRENT owner after the awaits: a superseded editor must not
    // write, and the takes belong to that old session.
    if (!ownerMatches(owner)) return failure('busy');

    const result: JournalMutationResult = await deps.store.addWithMedia(
      input,
      date,
      prepared.metadata,
    );
    if (!result.ok) {
      // Metadata failed: keep the leases/files so the SAME draft can be retried.
      return { ok: false, failure: mediaFailure(mapStoreReason(result.reason)) };
    }
    for (const draft of drafts) releaseLease(draft.id);
    return { ok: true, entryId: result.id ?? '', cleanup: { failed: [] } };
  }

  async function commitEdit(
    owner: DraftIdentity,
    entryId: string,
    input: JournalEntryInput,
    change: { add: readonly LocalMediaDraft[]; removeIds?: readonly string[] },
  ): Promise<CoordinatorOutcome> {
    return await runExclusive(() => commitEditExclusive(owner, entryId, input, change));
  }

  async function commitEditExclusive(
    owner: DraftIdentity,
    entryId: string,
    input: JournalEntryInput,
    change: { add: readonly LocalMediaDraft[]; removeIds?: readonly string[] },
  ): Promise<CoordinatorOutcome> {
    if (!isHydrated()) return failure('not-ready');
    const add = change.add ?? [];
    const removeIds = change.removeIds ?? [];
    for (const draft of add) lease(draft);
    const prepared = await prepareAll(add, owner);
    if (!prepared.ok) return prepared.outcome;
    if (!ownerMatches(owner)) return failure('busy');

    const result = await deps.store.editWithMedia(entryId, input, {
      add: prepared.metadata,
      removeIds,
    });
    if (!result.ok) return { ok: false, failure: mediaFailure(mapStoreReason(result.reason)) };
    // Metadata committed: additions are referenced now, removals may be cleaned.
    for (const draft of add) releaseLease(draft.id);
    return { ok: true, entryId, cleanup: await sweep() };
  }

  async function removeCommittedAttachment(
    entryId: string,
    mediaId: string,
  ): Promise<CoordinatorOutcome> {
    return await runExclusive(() => removeCommittedAttachmentExclusive(entryId, mediaId));
  }

  async function removeCommittedAttachmentExclusive(
    entryId: string,
    mediaId: string,
  ): Promise<CoordinatorOutcome> {
    if (!isHydrated()) return failure('not-ready');
    // Durable metadata removal FIRST; files are only cleaned after success.
    const result = await deps.store.removeMedia(entryId, mediaId);
    if (!result.ok) return { ok: false, failure: mediaFailure(mapStoreReason(result.reason)) };
    releaseLease(mediaId);
    return { ok: true, entryId, cleanup: await sweep() };
  }

  async function deleteEntry(entryId: string): Promise<CoordinatorOutcome> {
    return await runExclusive(() => deleteEntryExclusive(entryId));
  }

  async function deleteEntryExclusive(entryId: string): Promise<CoordinatorOutcome> {
    if (!isHydrated()) return failure('not-ready');
    const result = await deps.store.remove(entryId);
    if (!result.ok) return { ok: false, failure: mediaFailure(mapStoreReason(result.reason)) };
    // Only after a durable removal may the now-unreferenced owned files vanish.
    return { ok: true, entryId, cleanup: await sweep() };
  }

  async function reconcile(): Promise<ReconcileOutcome> {
    // Serialized with commits/adoptions/deletes, and blocked while the journal is
    // unhydrated/corrupt or mid-write (uncertain state ⇒ no deletion).
    return await runExclusive(async () => {
      const state = deps.store.getSnapshot();
      if (state.phase !== 'ready' || state.saving) {
        return { removed: [], failed: [], blocked: true, retained: [] };
      }
      return await deps.repository.reconcile(readers(), { hydrated: true });
    });
  }

  return {
    lease,
    releaseLease,
    leaseSession: (sessionId: string) => {
      sessionLeases.add(sessionId);
    },
    releaseSession: (sessionId: string) => {
      sessionLeases.delete(sessionId);
    },
    activeMediaIds,
    activeSessionIds,
    abandonDrafts,
    commitNewEntry,
    commitEdit,
    removeCommittedAttachment,
    deleteEntry,
    reconcile,
  };
}
