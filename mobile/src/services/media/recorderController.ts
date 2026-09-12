/**
 * Production recorder controller: one active capture session at a time.
 *
 * Pure policy with injected ports (permission/native recorder/file stat/clock/
 * repository), so the UI and tests drive the SAME state machine. Adapters
 * translate native events into these ports.
 *
 * Guarantees:
 * - A synchronous transition gate is taken before every permission/prepare/
 *   start/stop await; duplicate taps settle at most once.
 * - The long-running native "recording ended" promise never blocks the stop
 *   control: stop is a separate short operation.
 * - Elapsed time comes from a MONOTONIC clock (never wall-clock timestamps or
 *   interval ticks). The controller enforces its own duration deadline in
 *   addition to the native auto-stop.
 * - Cancelling increments the operation generation, so late native/permission
 *   results cannot attach to a newer session; their files are cleaned instead.
 * - No capture ever starts while the app is not active.
 */
import {
  isNativeMimeForKind,
  limitsFor,
  maxDurationSeconds,
  normalizeMime,
  validateCaptureMetadata,
  type MediaKind,
} from './mediaLimits';
import {
  mediaFailure,
  type CaptureResult,
  type CleanupResult,
  type LocalMediaDraft,
  type MediaFailure,
  type MediaOwner,
  type PermissionState,
} from './mediaContracts';
import type { AdoptOutcome } from './localMediaRepository';

export type RecorderState =
  | 'idle'
  | 'requesting-permission'
  | 'preparing'
  | 'ready'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'validating-file'
  | 'preview'
  | 'adopting'
  | 'attached'
  | 'denied'
  | 'error'
  | 'cancelling'
  | 'cancelled';

export type RecorderTake = {
  uri: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
};

export type RecorderSnapshot = {
  state: RecorderState;
  kind: MediaKind | null;
  /** Monotonic elapsed ms while recording (0 otherwise). */
  elapsedMs: number;
  /** Fixed take duration while previewing; null until the file is validated. */
  durationMs: number | null;
  limitMs: number;
  error: MediaFailure | null;
  permission: PermissionState | null;
  /** True while the native recorder is capturing. */
  recording: boolean;
  /** Uncommitted validated take (preview) or null. */
  take: RecorderTake | null;
};

/**
 * Authoritative attach decision. `captured` is the owner recorded when the
 * recorder surface opened; `current` is the controller's live owner (null when
 * this recorder no longer owns the session). The surface adds its own live sheet
 * identity, draft revision and busy state.
 */
export type AttachAuthorization = {
  captured: MediaOwner;
  current: MediaOwner | null;
};

/** A recorder session's own native resources (created per session). */
export type NativeRecordingSession = {
  readonly sessionId: string;
  readonly kind: MediaKind;
  /** Prepares (audio) and starts capture. */
  start(options: { forDurationSeconds: number }): Promise<void>;
  /** Requests the native stop; the ended promise carries the result. */
  stop(): Promise<void>;
  /** Resolves when capture ENDS (manual stop or native auto-stop). */
  recordingEnded(): Promise<CaptureResult | undefined>;
  /** Native auto-stop notification for THIS session. */
  onAutoStop(callback: () => void): () => void;
  /** Releases only this session's resources (never a newer session's hardware). */
  release(): Promise<void>;
};

export type OwnerIdentity = {
  sheetKey: string;
  entryId: string | null;
  draftKey: string;
  draftRevision: number;
};

export type RecorderPorts = {
  permissions: {
    get(kind: MediaKind): Promise<PermissionState>;
    request(kind: MediaKind): Promise<PermissionState>;
  };
  native: {
    /**
     * Creates the native handle for ONE recorder session. Every native resource
     * (recorder reference, listeners, timers, temp URI, release) belongs to this
     * handle, so a stale session can only ever clean its own resources.
     */
    openSession(input: { sessionId: string; kind: MediaKind }): NativeRecordingSession;
  };
  files: {
    /** Finalized file size; null when unknown/unreadable. */
    size(uri: string): Promise<number | null>;
    /** Best-effort removal of a native temp capture file. */
    remove(uri: string): Promise<void>;
  };
  clock: {
    /** Monotonic milliseconds (performance.now-like). */
    monotonicMs(): number;
  };
  repository: {
    adoptCapture(result: CaptureResult, owner: MediaOwner): Promise<AdoptOutcome>;
    discard(draft: LocalMediaDraft): Promise<CleanupResult>;
  };
  ids: {
    sessionId(): string;
  };
  identity: {
    /** Returns a failure when this take must NOT be attached to any draft. */
    authorize(input: AttachAuthorization): MediaFailure | null;
  };
};

export type UseTakeOutcome =
  | { ok: true; draft: LocalMediaDraft }
  | { ok: false; failure: MediaFailure };

export type RecorderController = {
  getSnapshot(): RecorderSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * New recorder surface identity (called when the surface opens). Creates this
   * session's native handle synchronously and closes the previous one.
   */
  open(identity: OwnerIdentity, kind: MediaKind): void;
  /** Audio action: permission -> prepare -> start in one tap. */
  startAudio(identity: OwnerIdentity): Promise<void>;
  /** Video action: permission -> prepare -> ready (camera surface visible). */
  openVideo(identity: OwnerIdentity): Promise<void>;
  /** Video record control in `ready`; the same control stops while recording. */
  startVideoRecording(): Promise<void>;
  /** Stop control: valid while starting/recording. */
  stop(): Promise<void>;
  /** Promote the previewed take into the editor draft (repository adoption). */
  useTake(): Promise<UseTakeOutcome>;
  /** Discard only this uncommitted take and return to ready. */
  reRecord(): Promise<void>;
  /** Cancel the whole session from any state; cleans owned uncommitted files. */
  cancel(): Promise<void>;
  /** Timer tick + deadline enforcement (called by the surface interval). */
  tick(): void;
  /** AppState changes: background/interruption stops once and never resumes. */
  setAppState(next: string): void;
  /** Refresh permission state after returning from Settings (no prompting). */
  refreshPermission(): Promise<void>;
  /** Owner this recorder captured at open time (null when it has none). */
  getOwner(): MediaOwner | null;
  /** True while this recorder surface is active (not idle/cancelled). */
  isActive(): boolean;
  /** Current app state, for tests/UI. */
  appState(): string;
};

const INITIAL: RecorderSnapshot = Object.freeze({
  state: 'idle' as const,
  kind: null,
  elapsedMs: 0,
  durationMs: null,
  limitMs: 0,
  error: null,
  permission: null,
  recording: false,
  take: null,
});

export function createRecorderController(ports: RecorderPorts): RecorderController {
  let snapshot: RecorderSnapshot = INITIAL;
  const listeners = new Set<() => void>();
  let owner: MediaOwner | null = null;
  /** The owner is mirrored as `ownerRef` so awaits can detect a replaced session. */
  let ownerRef: MediaOwner | null = null;
  /** Native handle of the CURRENT recorder session (null before/after a session). */
  let nativeSession: NativeRecordingSession | null = null;
  let generation = 0;
  /** Synchronous transition gate for short operations. */
  let transition = false;
  let startedAtMs: number | null = null;
  let deadlineMs: number | null = null;
  let stopRequested = false;
  let appState = 'active';
  let autoStopRegistration: { handle: NativeRecordingSession; unsubscribe: () => void } | null = null;
  let take: (RecorderTake & { result: CaptureResult }) | null = null;
  /** Last observed permission per required capability (never render-derived). */
  let cameraPermissionState: PermissionState | null = null;
  let microphonePermissionState: PermissionState | null = null;

  function publish(next: RecorderSnapshot): void {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  }

  function set(partial: Partial<RecorderSnapshot>): void {
    publish({ ...snapshot, ...partial });
  }

  function errorState(code: Parameters<typeof mediaFailure>[0], kind: MediaKind | null): void {
    set({ state: 'error', error: mediaFailure(code), recording: false, kind: kind ?? snapshot.kind, elapsedMs: 0 });
  }

  function isCurrent(candidate: number): boolean {
    return candidate === generation;
  }

  function acquire(): boolean {
    if (transition) return false;
    transition = true;
    return true;
  }

  function release(): void {
    transition = false;
  }

  /** Monotonic elapsed time for the active recording. */
  function elapsed(): number {
    if (startedAtMs === null) return 0;
    const value = ports.clock.monotonicMs() - startedAtMs;
    return value > 0 ? value : 0;
  }

  /**
   * The auto-stop registration is owned by exactly one session: a stale session may
   * only clear the registration IT installed, never a newer session's.
   */
  function clearAutoStopListener(handle: NativeRecordingSession | null = null): void {
    if (autoStopRegistration === null) return;
    if (handle !== null && autoStopRegistration.handle !== handle) return; // not ours
    const registration = autoStopRegistration;
    autoStopRegistration = null;
    registration.unsubscribe();
  }

  /**
   * Release ONLY the resources of an explicitly captured session handle. A stale
   * session therefore can never release the native recorder of a newer one.
   */
  async function releaseSession(handle: NativeRecordingSession | null): Promise<void> {
    clearAutoStopListener(handle); // only this session's registration
    if (handle === null) return;
    try {
      await handle.release();
    } catch {
      // Releasing is best-effort; the session is being torn down anyway.
    }
  }

  /** The handle owned by the CURRENT session (used only by that session's paths). */
  function currentSession(): NativeRecordingSession | null {
    return nativeSession;
  }

  /**
   * Closes the session handle that THIS controller still owns, e.g. when a new
   * recorder session replaces it. It releases only its own handle.
   */
  function closeOwnedSession(handle: NativeRecordingSession | null): Promise<void> {
    if (handle === null) return Promise.resolve();
    if (nativeSession === handle) nativeSession = null; // never reused afterwards
    return releaseSession(handle);
  }

  /**
   * Clean ONLY the explicitly captured uncommitted take. It never reads or deletes
   * the controller's current take, so a stale operation cannot remove a newer
   * session's take. The recorder never holds a reference to an adopted/transferred
   * take (see the ownership phases in the README).
   */
  function clearOwnedTake(owned: (RecorderTake & { result: CaptureResult }) | null): void {
    if (owned === null) return;
    if (take === owned) take = null; // clear the CURRENT take only if it is ours
  }

  function permissionKind(kind: MediaKind): 'microphone' | 'camera' {
    return kind === 'audio' ? 'microphone' : 'camera';
  }

  /**
   * Ensure the permission needed for `kind` is granted. Returns null when the
   * session is still current and granted; otherwise records the terminal state
   * and returns the failure (denied/restricted/error).
   */
  async function ensurePermission(kind: MediaKind, operation: number): Promise<MediaFailure | null> {
    const target = permissionKind(kind);
    let state: PermissionState;
    try {
      state = target === 'camera' ? await ports.permissions.get('video') : await ports.permissions.get('audio');
      if (!isCurrent(operation)) return mediaFailure('cancelled');
      if (state.status !== 'granted') {
        set({ state: 'requesting-permission', permission: state });
        state = target === 'camera' ? await ports.permissions.request('video') : await ports.permissions.request('audio');
        if (!isCurrent(operation)) return mediaFailure('cancelled');
      }
    } catch {
      if (!isCurrent(operation)) return mediaFailure('cancelled');
      set({ state: 'error', permission: null, error: mediaFailure('permission-error'), recording: false });
      return mediaFailure('permission-error');
    }
    if (target === 'camera') cameraPermissionState = state;
    else microphonePermissionState = state;
    set({ permission: state });
    if (state.status === 'granted') return null;
    if (state.status === 'restricted') {
      set({ state: 'denied', error: mediaFailure('permission-restricted'), recording: false });
      return mediaFailure('permission-restricted');
    }
    set({
      state: 'denied',
      error: mediaFailure(state.canAskAgain ? 'permission-denied' : 'permission-denied'),
      recording: false,
    });
    return mediaFailure('permission-denied');
  }

  /** Best-effort removal of a native temp capture file (never durable data). */
  async function cleanNativeTemp(uri: string | null): Promise<void> {
    if (uri === null) return;
    try {
      await ports.files.remove(uri);
    } catch {
      // The native temp file is owned by the OS/recorder; a failure here must
      // never surface as a broken editor.
    }
  }

  function reasonToCode(reason: string): Parameters<typeof mediaFailure>[0] {
    switch (reason) {
      case 'size-too-large':
        return 'file-too-large';
      case 'duration-too-long':
        return 'duration-too-long';
      case 'duration-invalid':
        return 'duration-unknown';
      case 'mime-unsupported':
        return 'mime-unsupported';
      default:
        return 'capture-empty';
    }
  }

  /**
   * Start capture on the handle the CALLER owns. Every failure path releases only
   * that handle, so a stale session can never release a newer session's hardware.
   */
  async function begin(
    kind: MediaKind,
    operation: number,
    handle: NativeRecordingSession,
  ): Promise<void> {
    set({ state: 'preparing', kind, elapsedMs: 0, durationMs: null, limitMs: limitsFor(kind).maxDurationMs });
    if (appState !== 'active') {
      // Never prepare or start a capture while the app is not active.
      await releaseSession(handle);
      if (!isCurrent(operation) || currentSession() !== handle) return;
      set({ state: 'idle', kind: null });
      return;
    }
    try {
      await handle.start({ forDurationSeconds: maxDurationSeconds(kind) });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      await releaseSession(handle);
      if (!isCurrent(operation) || currentSession() !== handle) return;
      if (code === 'background') {
        // The app left the active state while preparing: nothing started, and the
        // session is cleaned. Never publish recording; newer sessions are untouched.
        set({ state: 'idle', kind: null, recording: false, elapsedMs: 0, error: null });
        return;
      }
      if (code === 'superseded') return; // a newer session owns the hardware now
      if (code === 'handoff-blocked') {
        // The previous physical capture is not confirmed stopped: never start a
        // second capture. The typed failure is recoverable (retry re-attempts).
        errorState('hardware-busy', kind);
        return;
      }
      errorState('start-failed', kind);
      return;
    }
    if (!isCurrent(operation) || currentSession() !== handle) {
      // Cancelled/replaced while starting: stop and release only OUR session and
      // keep a cleanup handler for its late URI (its own result promise).
      try {
        await handle.stop();
      } catch {
        // ignore
      }
      void handle.recordingEnded().then(
        (result) => cleanNativeTemp(result?.uri ?? null),
        () => undefined,
      );
      await releaseSession(handle);
      return;
    }
    if (appState !== 'active') {
      // Never start a capture while the app is not active.
      await releaseSession(handle);
      if (!isCurrent(operation) || currentSession() !== handle) return;
      set({ state: 'idle', kind: null });
      return;
    }
    startedAtMs = ports.clock.monotonicMs();
    deadlineMs = limitsFor(kind).maxDurationMs;
    stopRequested = false;
    set({ state: 'recording', recording: true, elapsedMs: 0 });
    autoStopRegistration = {
      handle,
      unsubscribe: handle.onAutoStop(() => {
        // The native recorder stopped by itself (limit/interruption). The take is
        // settled by this session's `recordingEnded` promise, never twice here.
        stopRequested = true;
      }),
    };
    // This session's ended promise resolves on manual stop AND on auto-stop; it is
    // watched separately so it can never block the stop control.
    void handle.recordingEnded().then(
      (result) => finishCapture(kind, operation, handle, result),
      () => finishCapture(kind, operation, handle, undefined, true),
    );
  }

  /**
   * Validate the finalized file and move to preview (or a typed error).
   *
   * Everything it touches is captured: the session handle it owns and the result it
   * received. A stale finalization therefore cleans its own temp file and releases
   * its own handle, and never publishes state or mutates a newer session.
   */
  async function finishCapture(
    kind: MediaKind,
    operation: number,
    handle: NativeRecordingSession,
    result: CaptureResult | undefined,
    failed = false,
  ): Promise<void> {
    // Superseded means: a newer operation generation, OR a DIFFERENT live session
    // (a nulled handle is the one WE retired here, so it is not a supersession).
    const stale = (): boolean => {
      if (!isCurrent(operation)) return true;
      const current = currentSession();
      return current !== null && current !== handle;
    };
    clearAutoStopListener(handle);
    if (stale()) {
      // Late result from a cancelled/superseded session: clean it, never attach,
      // never keep the temp file, and never touch newer resources (the release is
      // scoped to OUR handle only).
      if (result !== undefined) await cleanNativeTemp(result.uri);
      await releaseSession(handle);
      return;
    }
    startedAtMs = null;
    deadlineMs = null;
    stopRequested = false;
    if (snapshot.state !== 'preview') set({ state: 'stopping', recording: false, elapsedMs: 0 });
    if (failed || result === undefined) {
      await releaseSession(handle);
      if (stale()) return; // superseded: publish nothing
      errorState('capture-failed', kind);
      return;
    }
    set({ state: 'validating-file' });
    let sizeBytes: number | null = null;
    try {
      sizeBytes = await ports.files.size(result.uri);
    } catch {
      sizeBytes = null;
    }
    if (stale()) {
      await cleanNativeTemp(result.uri);
      await releaseSession(handle);
      return;
    }
    const mimeType = result.mimeType === null ? null : normalizeMime(result.mimeType);
    // A native take must report a container the native recorder can produce.
    const validated =
      mimeType !== null && !isNativeMimeForKind(kind, mimeType)
        ? ({ ok: false as const, reason: 'mime-unsupported' as const })
        : validateCaptureMetadata(kind, {
            sizeBytes,
            durationMs: result.durationMs,
            mimeType,
          });
    if (!validated.ok) {
      await cleanNativeTemp(result.uri);
      await releaseSession(handle);
      if (stale()) return; // superseded: publish nothing
      errorState(reasonToCode(validated.reason), kind);
      return;
    }
    // Restore playback mode / stop the camera (preview uses a player). The handle
    // becomes unusable here and is forgotten: re-record opens a FRESH session.
    // Awaited, so a cancellation during this release still prevents the preview.
    await closeOwnedSession(handle);
    if (stale()) {
      // Cancelled/replaced while releasing: the session must NOT be resurrected.
      await cleanNativeTemp(result.uri);
      return;
    }
    take = {
      uri: result.uri,
      kind,
      mimeType: mimeType as string,
      sizeBytes: sizeBytes as number,
      durationMs: result.durationMs as number,
      result,
    };
    set({
      state: 'preview',
      take: {
        uri: result.uri,
        kind,
        mimeType: mimeType as string,
        sizeBytes: sizeBytes as number,
        durationMs: result.durationMs as number,
      },
      durationMs: result.durationMs as number,
      recording: false,
      elapsedMs: 0,
    });
  }

  function currentOwner(): MediaOwner | null {
    return ownerRef;
  }

  function open(identity: OwnerIdentity, kind: MediaKind): void {
    const previous = currentSession();
    generation += 1;
    owner = {
      sheetKey: identity.sheetKey,
      entryId: identity.entryId,
      draftKey: identity.draftKey,
      draftRevision: identity.draftRevision,
      sessionId: ports.ids.sessionId(),
      generation,
    };
    ownerRef = owner;
    // The controller owns the previous handle, so closing it is legitimate; any
    // other (stale) session only ever holds its own handle and cannot reach this one.
    void closeOwnedSession(previous);
    nativeSession = ports.native.openSession({ sessionId: owner.sessionId, kind });
    startedAtMs = null;
    deadlineMs = null;
    stopRequested = false;
    set({
      state: 'idle',
      kind: null,
      elapsedMs: 0,
      durationMs: null,
      limitMs: 0,
      error: null,
      recording: false,
      take: null,
    });
  }

  async function startAudio(identity: OwnerIdentity): Promise<void> {
    if (!acquire()) return; // duplicate tap: never disturb the active session
    open(identity, 'audio');
    const operation = generation;
    const handle = currentSession();
    if (handle === null) return;
    set({
      state: 'requesting-permission',
      kind: 'audio',
      error: null,
      take: null,
      durationMs: null,
      limitMs: limitsFor('audio').maxDurationMs,
    });
    try {
      const failure = await ensurePermission('audio', operation);
      if (failure || !isCurrent(operation) || currentSession() !== handle) return;
      await begin('audio', operation, handle);
    } finally {
      release();
    }
  }

  async function openVideo(identity: OwnerIdentity): Promise<void> {
    if (!acquire()) return; // duplicate tap: never disturb the active session
    open(identity, 'video');
    const operation = generation;
    const handle = currentSession();
    if (handle === null) return;
    set({
      state: 'requesting-permission',
      kind: 'video',
      error: null,
      take: null,
      durationMs: null,
      limitMs: limitsFor('video').maxDurationMs,
    });
    try {
      // Camera and microphone are requested SEQUENTIALLY with session checks. The
      // camera device itself is owned by this session's handle and is only used by
      // `startVideoRecording`, so a stale session never touches it.
      const camera = await ensurePermission('video', operation);
      if (camera || !isCurrent(operation) || currentSession() !== handle) return;
      const microphone = await ensurePermission('audio', operation);
      if (microphone || !isCurrent(operation) || currentSession() !== handle) return;
      if (appState !== 'active') {
        set({ state: 'idle', kind: null });
        return;
      }
      set({ state: 'ready' });
    } finally {
      release();
    }
  }

  async function startVideoRecording(): Promise<void> {
    const operation = generation;
    if (snapshot.state !== 'ready' || snapshot.kind !== 'video') return;
    // Readiness is derived from BOTH current permissions: a revoked camera or
    // microphone must reject here, without any native capture call.
    const unusable = unusableRequiredPermission('video');
    if (unusable !== null) {
      set({
        state: 'denied',
        permission: unusable.state,
        error: mediaFailure(permissionFailureCode(unusable.state)),
        recording: false,
      });
      return;
    }
    const handle = currentSession();
    if (handle === null) return;
    if (!acquire()) return;
    try {
      await begin('video', operation, handle);
    } finally {
      release();
    }
  }

  /** The first required permission that is not currently usable (or null). */
  function unusableRequiredPermission(
    kind: MediaKind,
  ): { which: 'camera' | 'microphone'; state: PermissionState } | null {
    const fallback: PermissionState = { status: 'undetermined', canAskAgain: true };
    if (kind === 'video') {
      if (cameraPermissionState === null || cameraPermissionState.status !== 'granted') {
        return { which: 'camera', state: cameraPermissionState ?? fallback };
      }
    }
    if (microphonePermissionState === null || microphonePermissionState.status !== 'granted') {
      return { which: 'microphone', state: microphonePermissionState ?? fallback };
    }
    return null;
  }

  function permissionFailureCode(state: PermissionState): Parameters<typeof mediaFailure>[0] {
    if (state.status === 'restricted') return 'permission-restricted';
    if (state.status === 'undetermined') return 'permission-unavailable';
    return 'permission-denied';
  }

  async function stop(): Promise<void> {
    const handle = currentSession();
    if (handle === null) return;
    if (snapshot.state !== 'recording' && snapshot.state !== 'starting') return;
    if (!acquire()) return; // duplicate taps settle at most once
    stopRequested = true;
    try {
      set({ state: 'stopping', recording: false });
      await handle.stop(); // this session's own handle
    } catch {
      // The ended promise decides the outcome; a stop failure surfaces there.
    } finally {
      release();
    }
  }

  async function useTake(): Promise<UseTakeOutcome> {
    if (take === null || snapshot.state !== 'preview') {
      return { ok: false, failure: mediaFailure('not-ready') };
    }
    const identity = currentOwner();
    if (identity === null) return { ok: false, failure: mediaFailure('not-ready') };
    if (!acquire()) return { ok: false, failure: mediaFailure('busy') };
    const operation = generation;
    const current = take;
    try {
      // Authoritative check BEFORE adoption: a stale recorder (its draft replaced
      // by a newer editor, its revision changed, or the editor busy) must not
      // adopt anything at all.
      const refused = ports.identity.authorize({ captured: identity, current: ownerRef });
      if (refused !== null) {
        await cleanNativeTemp(current.uri);
        clearOwnedTake(current); // clears the CURRENT take only when it is ours
        if (!isCurrent(operation)) return { ok: false, failure: refused };
        set({ state: 'cancelled', take: null, durationMs: null, recording: false });
        return { ok: false, failure: refused };
      }
      set({ state: 'adopting' });
      const outcome = await ports.repository.adoptCapture(current.result, identity);
      if (!isCurrent(operation)) {
        // Cancelled/superseded while adopting: clean it, never attach.
        if (outcome.ok) await ports.repository.discard(outcome.draft);
        await cleanNativeTemp(current.uri);
        return { ok: false, failure: mediaFailure('cancelled') };
      }
      if (outcome.ok) {
        // Re-check AFTER the await: the draft may have been superseded meanwhile.
        const staleAfterAdopt = ports.identity.authorize({ captured: identity, current: ownerRef });
        if (staleAfterAdopt !== null) {
          await ports.repository.discard(outcome.draft);
          await cleanNativeTemp(current.uri);
          clearOwnedTake(current);
          if (!isCurrent(operation)) return { ok: false, failure: staleAfterAdopt };
          set({ state: 'cancelled', take: null, durationMs: null, recording: false });
          return { ok: false, failure: staleAfterAdopt };
        }
      }
      if (!outcome.ok) {
        set({ state: 'error', error: outcome.failure, recording: false });
        return { ok: false, failure: outcome.failure };
      }
      // OWNERSHIP TRANSFER: the take becomes editor/draft-owned here. The recorder
      // keeps NO reference, so its teardown (cancel/unmount) can never delete it;
      // the caller must abandon it explicitly if it cannot accept it.
      clearOwnedTake(current); // the recorder now holds NO reference to the file
      await cleanNativeTemp(current.uri); // adopted copy is durable; temp is ours to drop
      if (!isCurrent(operation)) {
        // A newer session took over while we cleaned the temp: hand the draft back
        // so the caller can still abandon it explicitly (never silently orphaned).
        return { ok: true, draft: outcome.draft };
      }
      set({ state: 'attached', take: null, durationMs: null, elapsedMs: 0, recording: false });
      return { ok: true, draft: outcome.draft };
    } finally {
      release();
    }
  }

  async function reRecord(): Promise<void> {
    if (snapshot.state !== 'preview' && snapshot.state !== 'error' && snapshot.state !== 'ready') return;
    if (!acquire()) return;
    // Invalidate any finalization that is still in flight for the discarded take.
    generation += 1;
    const operation = generation;
    ownerRef = owner === null ? null : { ...owner, generation };
    const handle = currentSession();
    const ownedTake = take; // captured BEFORE any await
    const ownedKind = snapshot.kind;
    try {
      const nativeUri = ownedTake === null ? null : ownedTake.uri;
      clearOwnedTake(ownedTake);
      await cleanNativeTemp(nativeUri);
      if (handle !== null) {
        // A finalized handle is never reused: release it (its own resources only).
        await releaseSession(handle);
        if (currentSession() === handle) nativeSession = null;
      }
      if (!isCurrent(operation)) return; // a newer session took over while awaiting
      // A fresh native session is opened for the next take, with a NEW session id
      // and generation (a disposed handle can never return to ready).
      if (ownedKind === 'video' && currentSession() === null && ownerRef !== null) {
        open(
          {
            sheetKey: ownerRef.sheetKey,
            entryId: ownerRef.entryId,
            draftKey: ownerRef.draftKey,
            draftRevision: ownerRef.draftRevision,
          },
          'video',
        );
      }
      if (appState !== 'active') {
        set({ state: 'idle', kind: null });
        return;
      }
      set({
        state: 'ready',
        // The take kind is preserved: a fresh video session must still be a video
        // session, otherwise the next record tap would be refused.
        kind: ownedKind,
        take: null,
        durationMs: null,
        elapsedMs: 0,
        error: null,
        recording: false,
      });
    } finally {
      release();
    }
  }

  async function cancel(): Promise<void> {
    // Everything this cancellation may touch is captured BEFORE any await.
    const handle = currentSession();
    const ownedTake = take;
    const wasCapturing =
      snapshot.state === 'recording' || snapshot.state === 'starting' || snapshot.state === 'stopping';
    generation += 1; // invalidate every in-flight operation
    const operation = generation; // this cancellation's own token
    ownerRef = null;
    if (nativeSession === handle) nativeSession = null;
    const nativeUri = ownedTake === null ? null : ownedTake.uri;
    set({ state: 'cancelling', recording: false, error: null });
    if (wasCapturing && handle !== null) {
      try {
        await handle.stop(); // only OUR session's recorder
      } catch {
        // ignore: teardown continues
      }
    }
    await releaseSession(handle); // only OUR session's resources
    clearOwnedTake(ownedTake); // clears the current take only when it is ours
    await cleanNativeTemp(nativeUri);
    if (!isCurrent(operation)) return; // a newer recorder session owns the state now
    set({
      state: 'cancelled',
      kind: null,
      elapsedMs: 0,
      durationMs: null,
      take: null,
      recording: false,
      error: null,
    });
  }

  function tick(): void {
    if (snapshot.state !== 'recording') return;
    const value = elapsed();
    set({ elapsedMs: value });
    if (deadlineMs !== null && value >= deadlineMs && !stopRequested) {
      const kind = snapshot.kind;
      if (kind === null) return;
      // Controller deadline in addition to the native auto-stop.
      stopRequested = true;
      void currentSession()?.stop().catch(() => {
        // The ended promise still settles the take.
      });
    }
  }

  function setAppState(next: string): void {
    appState = next;
    if (next === 'active') return;
    const capturing =
      snapshot.state === 'recording' || snapshot.state === 'starting' || snapshot.state === 'stopping';
    if (!capturing || stopRequested) return;
    const kind = snapshot.kind;
    if (kind === null) return;
    // Interruption/background: stop ONCE; never automatically resume.
    stopRequested = true;
    void currentSession()?.stop().catch(() => {
      // ignore
    });
  }

  /**
   * Re-read the REQUIRED permissions after returning from Settings: camera only
   * for audio, camera AND microphone for video. Never prompts, never records and
   * never applies a result from a replaced session (generation-scoped).
   */
  async function refreshPermission(): Promise<void> {
    const kind = snapshot.kind;
    const operation = generation;
    if (kind === null) return;
    try {
      const camera = await ports.permissions.get(kind === 'audio' ? 'audio' : 'video');
      if (!isCurrent(operation) || kind !== snapshot.kind) return;
      let microphone: PermissionState | null = null;
      if (kind === 'video') {
        // Video needs BOTH: refreshing only the camera must not reach ready.
        microphone = await ports.permissions.get('audio');
        if (!isCurrent(operation) || kind !== snapshot.kind) return;
      }
      if (kind === 'video') cameraPermissionState = camera;
      else microphonePermissionState = camera;
      if (microphone !== null) microphonePermissionState = microphone;

      const unusable = unusableRequiredPermission(kind);
      if (unusable !== null) {
        set({
          permission: unusable.state,
          error: mediaFailure(permissionFailureCode(unusable.state)),
          recording: false,
        });
        // Revoked while ready: leave ready IMMEDIATELY so nothing can start.
        if (snapshot.state === 'ready') set({ state: 'denied' });
        return;
      }
      set({ permission: camera, error: null });
      if (snapshot.state === 'denied' || snapshot.state === 'error') {
        // Access restored: ready to record, NOT auto-recording.
        set({ state: appState === 'active' ? 'ready' : 'idle' });
      }
    } catch {
      // Keep the previous permission state; the user can retry explicitly.
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    startAudio,
    openVideo,
    startVideoRecording,
    stop,
    useTake,
    reRecord,
    cancel,
    tick,
    setAppState,
    refreshPermission,
    getOwner: () => ownerRef,
    isActive: () => snapshot.state !== 'idle' && snapshot.state !== 'cancelled',
    appState: () => appState,
  };
}
