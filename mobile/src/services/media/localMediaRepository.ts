/**
 * Local media repository: owns journal media FILES inside this app's sandbox.
 *
 * Responsibilities (all through an injected file port, so the policy is
 * unit-testable and Expo stays in `expoMediaFiles.ts`):
 * - `adoptCapture`: copy a finalized native take into the owned staging
 *   namespace and return an in-memory draft (no journal write yet).
 * - `prepare`: verify the staged file and promote it into a durable object
 *   directory with a strict ownership manifest BEFORE metadata may reference it.
 * - `resolve`: derive the ephemeral playback locator from the manifest.
 * - `discard`: remove only the abandoned take's staging directory.
 * - `reconcile`: delete owned, unreferenced, unleased files; retain anything
 *   that is referenced, leased, unknown or corrupt.
 *
 * Ownership = a VALID manifest plus a contained generated path. An id prefix or
 * an unknown/remote metadata row never authorizes a file deletion.
 */
import {
  extensionForMime,
  isMimeAllowedForKind,
  isNativeMimeForKind,
  normalizeMime,
  validateCaptureMetadata,
  type MediaKind,
} from './mediaLimits';
import {
  mediaFailure,
  type CaptureResult,
  type CleanupResult,
  type JournalMediaInput,
  type DraftIdentity,
  type LocalMediaDraft,
  type MediaFailure,
  type MediaOwner,
  type MediaResolution,
  type PreparedLocalMedia,
} from './mediaContracts';
import {
  LOCAL_MEDIA_MANIFEST_FILE,
  isSafeMediaFileName,
  isSafeMediaId,
  parseManifest,
  serializeManifest,
  type LocalMediaManifestV1,
} from '@/storage/localMediaManifest';

export const STAGING_RELATIVE = 'workazy-journal-media/v1/staging';
export const OBJECTS_RELATIVE = 'workazy-journal-media/v1/objects';

export type FileStat = { exists: boolean; sizeBytes: number | null; isDirectory: boolean };

export type MediaFilePort = {
  /** Absolute sandbox roots derived from the CURRENT container (never stored). */
  roots(): { staging: string; objects: string };
  join(...parts: string[]): string;
  /** `file://` URI for a runtime playback/recorder API call. */
  toUri(absolutePath: string): string;
  ensureDir(absolutePath: string): Promise<void>;
  stat(absolutePath: string): Promise<FileStat>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Removes a file, or a directory tree that this repository owns. */
  remove(absolutePath: string): Promise<void>;
  /** Entry names inside a directory (empty when it does not exist). */
  listNames(absolutePath: string): Promise<string[]>;
  readText(absolutePath: string): Promise<string | null>;
  writeText(absolutePath: string, text: string): Promise<void>;
};

export type RepositoryDeps = {
  port: MediaFilePort;
  /** `local-media-<uuid>` generator (collision-checked per promotion). */
  createMediaId: () => string;
  /** `session-<uuid>` generator for staging directories. */
  createSessionId: () => string;
  now: () => Date;
};

export type AdoptOutcome = { ok: true; draft: LocalMediaDraft } | { ok: false; failure: MediaFailure };
export type PrepareOutcome =
  | { ok: true; prepared: PreparedLocalMedia }
  | { ok: false; failure: MediaFailure };

export type ReconcileInput = {
  /**
   * Authoritative readers. They are called again IMMEDIATELY before every
   * destructive delete (never a snapshot taken before an await), so a file that
   * became referenced/leased while the sweep was working can never be removed.
   */
  references: () => ReadonlySet<string>;
  /** Session ids whose staging takes are currently in use. */
  leasedSessions: () => ReadonlySet<string>;
  /** Prepared/committed media ids held by an active editor draft or recorder. */
  leasedMedia: () => ReadonlySet<string>;
  /**
   * Last safety gate re-read before each delete (journal hydrated, no conflicting
   * write). A `false`/throwing gate means "uncertain": nothing is deleted.
   */
  canDelete?: () => boolean;
};

export type ReconcileOutcome = CleanupResult & {
  /** True when nothing was cleaned because the journal is corrupt/unhydrated. */
  blocked: boolean;
  /** Owned directories intentionally kept (referenced, leased, unknown, invalid). */
  retained: string[];
};

export type LocalMediaRepository = {
  adoptCapture(result: CaptureResult, owner: MediaOwner): Promise<AdoptOutcome>;
  prepare(draft: LocalMediaDraft, owner: DraftIdentity): Promise<PrepareOutcome>;
  resolve(media: Pick<JournalMediaInput, 'id' | 'type' | 'mimeType'>): Promise<MediaResolution>;
  discard(draft: LocalMediaDraft): Promise<CleanupResult>;
  reconcile(input: ReconcileInput, { hydrated }: { hydrated: boolean }): Promise<ReconcileOutcome>;
  /**
   * Remove ONE owned object (promoted but unreferenced/unleased). Re-reads the
   * ownership record and the caller's guards before deleting; refuses when the
   * record is invalid or the media might still be needed.
   */
  removeOwned(
    mediaId: string,
    guards: { isReferenced: () => boolean; isLeased: () => boolean },
  ): Promise<CleanupResult>;
};

const SESSION_PATTERN = /^session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function safeToken(value: string, pattern: RegExp): boolean {
  if (!pattern.test(value)) return false;
  return !value.includes('..') && !value.includes('/') && !value.includes('\\');
}

export function createLocalMediaRepository(deps: RepositoryDeps): LocalMediaRepository {
  const { port } = deps;

  /**
   * Serializes every operation that can create, move or delete files inside this
   * repository's own namespaces (adopt, prepare, discard, owned removal, sweep).
   * A directory-emptiness observation can therefore never be invalidated by a
   * concurrent adoption, and no destructive cleanup runs concurrently with it.
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

  const stagingRoot = (): string => port.roots().staging;
  const objectsRoot = (): string => port.roots().objects;

  function objectDir(mediaId: string): string {
    if (!isSafeMediaId(mediaId)) throw new Error('unsafe-media-id');
    return port.join(objectsRoot(), mediaId);
  }

  function stagingDir(sessionId: string): string {
    if (!safeToken(sessionId, SESSION_PATTERN)) throw new Error('unsafe-session-id');
    return port.join(stagingRoot(), sessionId);
  }

  function isInsideStaging(candidate: string): boolean {
    const root = stagingRoot();
    return candidate !== root && candidate.startsWith(`${root}/`);
  }

  async function readManifest(mediaId: string): Promise<LocalMediaManifestV1 | null> {
    let raw: string | null = null;
    try {
      raw = await port.readText(port.join(objectDir(mediaId), LOCAL_MEDIA_MANIFEST_FILE));
    } catch {
      return null;
    }
    if (raw === null) return null;
    const parsed = parseManifest(raw);
    if (!parsed.ok) return null;
    if (parsed.manifest.mediaId !== mediaId) return null;
    return parsed.manifest;
  }

  async function removeOwnedDir(dir: string, results: CleanupResult): Promise<void> {
    try {
      await port.remove(dir);
      results.removed.push(dir);
    } catch (error) {
      results.failed.push({
        path: dir,
        message: error instanceof Error ? error.message : 'remove-failed',
      });
    }
  }

  async function adoptCapture(result: CaptureResult, owner: MediaOwner): Promise<AdoptOutcome> {
    const kind: MediaKind = result.kind;
    const mimeType = result.mimeType === null ? null : normalizeMime(result.mimeType);
    if (mimeType === null || !isMimeAllowedForKind(kind, mimeType)) {
      return { ok: false, failure: mediaFailure('mime-unsupported') };
    }
    // Native captures must use a container the native recorder produces.
    if (!isNativeMimeForKind(kind, mimeType)) {
      return { ok: false, failure: mediaFailure('mime-unsupported') };
    }

    // Stat the finalized native file first: zero/unknown sizes are errors.
    let nativeStat: FileStat;
    try {
      nativeStat = await port.stat(result.uri);
    } catch {
      return { ok: false, failure: mediaFailure('stat-failed') };
    }
    if (!nativeStat.exists || nativeStat.isDirectory) {
      return { ok: false, failure: mediaFailure('file-missing') };
    }
    const validated = validateCaptureMetadata(kind, {
      sizeBytes: nativeStat.sizeBytes,
      durationMs: result.durationMs,
      mimeType,
    });
    if (!validated.ok) {
      switch (validated.reason) {
        case 'size-invalid':
          return { ok: false, failure: mediaFailure('capture-empty') };
        case 'size-too-large':
          return { ok: false, failure: mediaFailure('file-too-large') };
        case 'duration-invalid':
          return { ok: false, failure: mediaFailure('duration-unknown') };
        case 'duration-too-long':
          return { ok: false, failure: mediaFailure('duration-too-long') };
        default:
          return { ok: false, failure: mediaFailure('mime-unsupported') };
      }
    }

    const fileName = `recording.${extensionForMime(mimeType)}`;
    if (!isSafeMediaFileName(fileName)) return { ok: false, failure: mediaFailure('adopt-failed') };
    if (!safeToken(owner.sessionId, SESSION_PATTERN)) {
      return { ok: false, failure: mediaFailure('adopt-failed') };
    }

    const mediaId = deps.createMediaId();
    if (!isSafeMediaId(mediaId)) return { ok: false, failure: mediaFailure('adopt-failed') };
    const directory = stagingDir(owner.sessionId);
    // Unique per take: two takes inside one session (re-record) can never
    // overwrite each other's staged file. The DURABLE name stays the generated
    // `recording.<ext>` recorded in the ownership manifest.
    const stagingPath = port.join(directory, `${mediaId}.${extensionForMime(mimeType)}`);
    try {
      await port.ensureDir(directory);
      if (!isInsideStaging(stagingPath)) return { ok: false, failure: mediaFailure('adopt-failed') };
      // Copy (never move) the only valid source: the native temp file stays
      // intact until this copy is complete.
      await port.copy(result.uri, stagingPath);
      const staged = await port.stat(stagingPath);
      if (!staged.exists || staged.sizeBytes === null || staged.sizeBytes <= 0) {
        return { ok: false, failure: mediaFailure('adopt-failed') };
      }
      if (staged.sizeBytes !== nativeStat.sizeBytes) {
        // A partial copy is worse than a retry.
        return { ok: false, failure: mediaFailure('adopt-failed') };
      }
      const draft: LocalMediaDraft = {
        id: mediaId,
        kind,
        owner: { ...owner },
        stagingPath,
        fileName,
        mimeType,
        sizeBytes: staged.sizeBytes,
        durationMs: result.durationMs as number,
        createdAt: deps.now().toISOString(),
      };
      if (result.width !== undefined && Number.isFinite(result.width) && result.width > 0) {
        draft.width = result.width;
      }
      if (result.height !== undefined && Number.isFinite(result.height) && result.height > 0) {
        draft.height = result.height;
      }
      return { ok: true, draft };
    } catch {
      return { ok: false, failure: mediaFailure('adopt-failed') };
    }
  }


  async function prepare(draft: LocalMediaDraft, owner: DraftIdentity): Promise<PrepareOutcome> {
    if (!isSafeMediaId(draft.id) || !isSafeMediaFileName(draft.fileName)) {
      return { ok: false, failure: mediaFailure('adopt-failed') };
    }
    if (!isInsideStaging(draft.stagingPath)) {
      return { ok: false, failure: mediaFailure('adopt-failed') };
    }
    // Only the take's OWN editor draft may promote it (session token stays on
    // the draft itself; containment below keeps the paths inside our staging).
    if (owner.sheetKey !== draft.owner.sheetKey || owner.draftKey !== draft.owner.draftKey) {
      return { ok: false, failure: mediaFailure('busy') };
    }

    const directory = objectDir(draft.id);
    const existing = await port.stat(directory);
    if (existing.exists) {
      // Stable take id already promoted (retry after a failed metadata write).
      const manifest = await readManifest(draft.id);
      if (manifest === null) {
        // Unowned/corrupt record: never overwritten, never referenced.
        return { ok: false, failure: mediaFailure('adopt-failed') };
      }
      if (manifest.sizeBytes === draft.sizeBytes && manifest.mimeType === draft.mimeType) {
        // The retry must verify the DURABLE recording itself, not just the
        // directory/manifest: a vanished or truncated file must block the
        // metadata commit instead of committing a missing-file attachment.
        const filePath = port.join(directory, manifest.fileName);
        let durable: FileStat;
        try {
          durable = await port.stat(filePath);
        } catch {
          return { ok: false, failure: mediaFailure('stat-failed') };
        }
        if (
          !durable.exists ||
          durable.isDirectory ||
          durable.sizeBytes === null ||
          durable.sizeBytes <= 0 ||
          durable.sizeBytes !== manifest.sizeBytes
        ) {
          // Ownership record without its recording: unusable, never committed.
          return { ok: false, failure: mediaFailure('file-missing') };
        }
        const metadata: JournalMediaInput = {
          id: draft.id,
          type: draft.kind,
          mimeType: manifest.mimeType,
          sizeBytes: manifest.sizeBytes,
          durationMs: manifest.durationMs,
        };
        if (draft.width !== undefined) metadata.width = draft.width;
        if (draft.height !== undefined) metadata.height = draft.height;
        if (draft.originalFilename !== undefined) {
          metadata.originalFilename = draft.originalFilename;
        }
        return { ok: true, prepared: { metadata, createdAt: manifest.createdAt } };
      }
      // An unexpected/foreign directory is never overwritten.
      return { ok: false, failure: mediaFailure('adopt-failed') };
    }

    let staged: FileStat;
    try {
      staged = await port.stat(draft.stagingPath);
    } catch {
      return { ok: false, failure: mediaFailure('stat-failed') };
    }
    if (!staged.exists || staged.isDirectory) {
      return { ok: false, failure: mediaFailure('file-missing') };
    }
    const validated = validateCaptureMetadata(draft.kind, {
      sizeBytes: staged.sizeBytes,
      durationMs: draft.durationMs,
      mimeType: draft.mimeType,
    });
    if (!validated.ok) {
      switch (validated.reason) {
        case 'size-too-large':
          return { ok: false, failure: mediaFailure('file-too-large') };
        case 'duration-too-long':
          return { ok: false, failure: mediaFailure('duration-too-long') };
        case 'size-invalid':
          return { ok: false, failure: mediaFailure('capture-empty') };
        case 'duration-invalid':
          return { ok: false, failure: mediaFailure('duration-unknown') };
        default:
          return { ok: false, failure: mediaFailure('mime-unsupported') };
      }
    }

    const target = port.join(directory, draft.fileName);
    try {
      await port.ensureDir(directory);
      // Copy FIRST: the only valid source must survive until the destination AND
      // its ownership manifest are complete and verified.
      await port.copy(draft.stagingPath, target);
      const finalStat = await port.stat(target);
      if (
        !finalStat.exists ||
        finalStat.isDirectory ||
        finalStat.sizeBytes === null ||
        finalStat.sizeBytes !== staged.sizeBytes
      ) {
        await removeOwnedDir(directory, { removed: [], failed: [] });
        return { ok: false, failure: mediaFailure('adopt-failed') };
      }
      const createdAt = deps.now().toISOString();
      const manifest: LocalMediaManifestV1 = {
        version: 1,
        mediaId: draft.id,
        fileName: draft.fileName,
        mimeType: draft.mimeType,
        sizeBytes: finalStat.sizeBytes,
        durationMs: draft.durationMs,
        createdAt,
      };
      await port.writeText(port.join(directory, LOCAL_MEDIA_MANIFEST_FILE), serializeManifest(manifest));
      const verified = await readManifest(draft.id);
      if (verified === null) {
        await removeOwnedDir(directory, { removed: [], failed: [] });
        return { ok: false, failure: mediaFailure('manifest-invalid') };
      }
      // Promotion is durable and verified: the staging copy is now redundant.
      try {
        await port.remove(draft.stagingPath);
      } catch {
        // Leaving the staging copy behind is harmless; reconcile sweeps it.
      }
      const metadata: JournalMediaInput = {
        id: draft.id,
        type: draft.kind,
        mimeType: draft.mimeType,
        sizeBytes: finalStat.sizeBytes,
        durationMs: draft.durationMs,
      };
      if (draft.width !== undefined) metadata.width = draft.width;
      if (draft.height !== undefined) metadata.height = draft.height;
      if (draft.originalFilename !== undefined) {
        metadata.originalFilename = draft.originalFilename;
      }
      return { ok: true, prepared: { metadata, createdAt: verified.createdAt } };
    } catch {
      await removeOwnedDir(directory, { removed: [], failed: [] });
      return { ok: false, failure: mediaFailure('adopt-failed') };
    }
  }

  async function resolve(
    media: Pick<JournalMediaInput, 'id' | 'type' | 'mimeType'>,
  ): Promise<MediaResolution> {
    const unavailable = (reason: 'missing-file' | 'invalid-manifest' | 'unreadable') => ({
      unavailable: true as const,
      reason,
      message: failureTextForResolution(reason),
    });
    if (!isSafeMediaId(media.id)) return unavailable('invalid-manifest');

    let manifestStat: FileStat;
    try {
      manifestStat = await port.stat(port.join(objectDir(media.id), LOCAL_MEDIA_MANIFEST_FILE));
    } catch {
      return unavailable('unreadable');
    }
    if (!manifestStat.exists) return unavailable('missing-file');
    const manifest = await readManifest(media.id);
    if (manifest === null) return unavailable('invalid-manifest');

    const filePath = port.join(objectDir(media.id), manifest.fileName);
    let fileStat: FileStat;
    try {
      fileStat = await port.stat(filePath);
    } catch {
      return unavailable('unreadable');
    }
    if (!fileStat.exists || fileStat.isDirectory) return unavailable('missing-file');
    return {
      uri: port.toUri(filePath),
      mimeType: manifest.mimeType,
      kind: manifest.mimeType.startsWith('audio') ? 'audio' : 'video',
    };
  }

  function failureTextForResolution(
    reason: 'missing-file' | 'invalid-manifest' | 'unreadable',
  ): string {
    switch (reason) {
      case 'missing-file':
        return 'Файл недоступен на этом устройстве.';
      case 'invalid-manifest':
        return 'Файл записи повреждён или не принадлежит приложению.';
      case 'unreadable':
        return 'Не удалось прочитать файл записи. Повторите попытку.';
    }
  }

  /**
   * Remove ONLY the abandoned take's own staging directory. The draft's own
   * session id is authoritative, and the path must be contained in staging, so
   * this can never touch durable objects or an unrelated cache directory.
   */
  async function discard(draft: LocalMediaDraft): Promise<CleanupResult> {
    const results: CleanupResult = { removed: [], failed: [] };
    if (!isInsideStaging(draft.stagingPath)) return results;
    if (!safeToken(draft.owner.sessionId, SESSION_PATTERN)) return results;
    const sessionDir = stagingDir(draft.owner.sessionId);
    if (!draft.stagingPath.startsWith(`${sessionDir}/`)) return results;
    // Remove ONLY this take's own staged file: another take of the same session
    // (a re-record) must never lose its file to this cleanup.
    try {
      const staged = await port.stat(draft.stagingPath);
      if (staged.exists) {
        await port.remove(draft.stagingPath);
        results.removed.push(draft.stagingPath);
      }
    } catch (error) {
      results.failed.push({
        path: draft.stagingPath,
        message: error instanceof Error ? error.message : 'remove-failed',
      });
      return results;
    }
    // The session directory is deliberately NOT deleted here: an emptiness
    // observation can go stale across an await (a sibling take may be adopted into
    // the same directory), and a recursive delete would then destroy sibling data.
    // An empty owned directory is harmless and is reclaimed by the sweep, which
    // only removes directories of UNLEASED sessions and re-reads that guard
    // immediately before deleting.
    void sessionDir;
    return results;
  }

  /**
   * Sweep owned, unreferenced, unleased files. Retains referenced, leased,
   * unknown and corrupt entries. Blocked (does nothing) while the journal is not
   * hydrated or is corrupt.
   */
  /**
   * Re-read the authoritative state. Uncertain (throwing) readers are treated as
   * "still needed", so the sweep leaks a temporary file instead of risking user data.
   */
  function stillNeeded(input: ReconcileInput, mediaId: string | null, sessionId: string | null): boolean {
    try {
      if (input.canDelete !== undefined && !input.canDelete()) return true;
      if (sessionId !== null && input.leasedSessions().has(sessionId)) return true;
      if (mediaId !== null && (input.references().has(mediaId) || input.leasedMedia().has(mediaId))) {
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  async function removeOwned(
    mediaId: string,
    guards: { isReferenced: () => boolean; isLeased: () => boolean },
  ): Promise<CleanupResult> {
    const results: CleanupResult = { removed: [], failed: [] };
    if (!isSafeMediaId(mediaId)) return results;
    const manifest = await readManifest(mediaId);
    if (manifest === null) return results; // unowned/corrupt: never touched
    const filePath = port.join(objectDir(mediaId), manifest.fileName);
    const file = await port.stat(filePath);
    if (!file.exists || file.isDirectory) return results; // already gone
    try {
      if (guards.isReferenced() || guards.isLeased()) return results; // still needed
    } catch {
      return results; // uncertain ⇒ retain
    }
    await removeOwnedDir(objectDir(mediaId), results);
    return results;
  }

  async function reconcile(
    input: ReconcileInput,
    { hydrated }: { hydrated: boolean },
  ): Promise<ReconcileOutcome> {
    const results: CleanupResult = { removed: [], failed: [] };
    const retained: string[] = [];
    if (!hydrated) return { ...results, blocked: true, retained };

    let stagingNames: string[] = [];
    try {
      stagingNames = await port.listNames(stagingRoot());
    } catch {
      stagingNames = [];
    }
    for (const name of stagingNames) {
      const dir = port.join(stagingRoot(), name);
      if (!safeToken(name, SESSION_PATTERN)) {
        retained.push(dir); // unknown directory inside our namespace
        continue;
      }
      // No async lookup is needed for staging, so the guard below is the final
      // statement before the destructive delete (session id is path-derived).
      if (stillNeeded(input, null, name)) {
        retained.push(dir); // an active take (re-read right before the delete)
        continue;
      }
      await removeOwnedDir(dir, results); // the awaited delete itself
    }

    let objectNames: string[] = [];
    try {
      objectNames = await port.listNames(objectsRoot());
    } catch {
      objectNames = [];
    }
    for (const name of objectNames) {
      const dir = port.join(objectsRoot(), name);
      if (!isSafeMediaId(name)) {
        retained.push(dir); // not ours to interpret
        continue;
      }
      // 1) Every ASYNC ownership lookup happens first...
      const manifest = await readManifest(name);
      if (manifest === null) {
        retained.push(dir); // corrupt/unowned: never guess
        continue;
      }
      // 2) ...then ALL authoritative guards are re-read synchronously, with NO
      // await between them and the destructive delete below.
      if (stillNeeded(input, name, null)) {
        retained.push(dir); // referenced/leased NOW: state changed during the read
        continue;
      }
      if (manifest.mediaId !== name || !isSafeMediaFileName(manifest.fileName)) {
        retained.push(dir); // ownership/path no longer valid
        continue;
      }
      await removeOwnedDir(dir, results); // the awaited delete itself
    }

    return { ...results, blocked: false, retained };
  }

  return {
    adoptCapture: (result, owner) => runExclusive(() => adoptCapture(result, owner)),
    prepare: (draft, owner) => runExclusive(() => prepare(draft, owner)),
    resolve,
    discard: (draft) => runExclusive(() => discard(draft)),
    reconcile: (input, options) => runExclusive(() => reconcile(input, options)),
    removeOwned: (mediaId, guards) => runExclusive(() => removeOwned(mediaId, guards)),
  };
}
