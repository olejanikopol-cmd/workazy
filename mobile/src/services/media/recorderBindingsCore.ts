/**
 * Session-scoped recorder bindings (the implementation the app actually runs).
 *
 * Every native resource (status listener, duration sampling, result promise, temp
 * URI, stop, release) belongs to the `NativeRecordingSession` that created it, and
 * every hardware operation goes through the PROCESS-GLOBAL hardware coordinator, so
 * a stale session can never touch a newer session's recorder or the global mode.
 *
 * Native dependencies are injected so the SAME implementation is exercised by tests;
 * `expoRecorderBindings.ts` wires the real Expo modules into it.
 *
 * Audio duration policy: the duration used for validation is the authoritative
 * duration of the FINALIZED file (`probeFinalAudioDurationMs`). While-recording
 * sampling is for the UI/fallback only; a failed probe yields no duration (typed
 * failure upstream) instead of accepting a stale lower sample.
 */
import {
  AUDIO_BITS_PER_SECOND,
  MAX_AUDIO_DURATION_MS,
  MAX_VIDEO_DURATION_MS,
  MAX_VIDEO_SIZE_BYTES,
  type MediaKind,
} from './mediaLimits';
import type { CaptureResult, PermissionState, PermissionStatus } from './mediaContracts';
import type { NativeRecordingSession, RecorderPorts } from './recorderController';
import {
  sharedRecorderHardwareCoordinator,
  type HardwareOwner,
  type RecorderHardwareCoordinator,
} from './recorderHardwareCoordinator';

export const VIDEO_CODEC = 'avc1' as const; // H.264: required for `videoBitrate` on iOS.

/** Sampling cadence for the UI timer/fallback (SDK default polling is 500 ms). */
export const AUDIO_SAMPLE_MS = 250;

/** Typed binding failure so the controller can react precisely. */
export class RecorderBindingError extends Error {
  readonly code: 'background' | 'superseded' | 'camera-not-mounted';
  constructor(code: 'background' | 'superseded' | 'camera-not-mounted') {
    super(code);
    this.name = 'RecorderBindingError';
    this.code = code;
  }
}

export type NativePermissionResponse = {
  status?: string;
  granted?: boolean;
  canAskAgain?: boolean;
};

export function toPermissionState(response: NativePermissionResponse | null): PermissionState {
  const raw = response?.status ?? (response?.granted === true ? 'granted' : 'undetermined');
  let status: PermissionStatus;
  if (response?.granted === true || raw === 'granted') status = 'granted';
  else if (raw === 'undetermined') status = 'undetermined';
  else if (raw === 'restricted') status = 'restricted';
  else status = 'denied';
  const canAskAgain = response?.canAskAgain ?? status === 'undetermined';
  return { status, canAskAgain: status === 'denied' ? canAskAgain : status !== 'restricted' };
}

export type NativeRecordingStatus = {
  isFinished: boolean;
  hasError: boolean;
  error: string | null;
  url: string | null;
};

/** The single native audio recorder, addressed only through a session. */
export type NativeAudioDevice = {
  enableRecordingMode(): Promise<void>;
  restorePlaybackMode(): Promise<void>;
  prepareRecording(options: { bitRate: number; numberOfChannels: number }): Promise<void>;
  startRecording(options: { forDurationSeconds: number }): void;
  stopRecording(): Promise<void>;
  status(): { durationMillis: number | null; isRecording: boolean; url: string | null };
  uri(): string | null;
  setStatusListener(listener: ((status: NativeRecordingStatus) => void) | null): void;
};

/** The camera surface, addressed only through a session. */
export type NativeCameraDevice = {
  record(options: {
    maxDurationSeconds: number;
    maxFileSizeBytes: number;
    codec: typeof VIDEO_CODEC;
  }): Promise<{ uri: string } | undefined>;
  stopRecording(): void;
};

export type RecorderBindingsDeps = {
  audio: NativeAudioDevice;
  video: { getDevice: () => NativeCameraDevice | null };
  /** Authoritative duration of a FINALIZED audio file (null when unavailable). */
  probeFinalAudioDurationMs: (uri: string) => Promise<number | null>;
  /** Duration of a finalized video file read from the loaded media. */
  probeVideoDurationMs: (uri: string) => Promise<number | null>;
  permissions: RecorderPorts['permissions'];
  files: RecorderPorts['files'];
  clock: RecorderPorts['clock'];
  repository: RecorderPorts['repository'];
  identity: RecorderPorts['identity'];
  createSessionId: () => string;
  /** Repeating scheduler (injectable for tests); returns its own cancel function. */
  schedule: (callback: () => void, everyMs: number) => () => void;
  /** MIME for a finalized native file, derived from its container. */
  mimeForUri: (uri: string, kind: MediaKind) => string | null;
  /** Notified SYNCHRONOUSLY when a session id is minted (lease point). */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Lifecycle authorization, checked immediately BEFORE the native capture starts
   * (a preparation that finishes in the background must not start recording).
   */
  isLifecycleAuthorized: () => boolean;
  /** Shared process-level hardware coordinator (defaults to the production one). */
  coordinator?: RecorderHardwareCoordinator;
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** One recorder session: it owns every resource created for it. */
type SessionRecord = {
  sessionId: string;
  kind: MediaKind;
  /**
   * Eagerly-settled activation outcome. Handlers are attached at creation, so a
   * `handoff-blocked` refusal can never surface as a process unhandled rejection
   * (even when the permission flow finishes later, or start() is never called).
   */
  activation: Promise<{ ok: true; owner: HardwareOwner } | { ok: false; error: unknown }>;
  owner: HardwareOwner | null;
  ended: Deferred<CaptureResult | undefined> | null;
  autoStop: (() => void) | null;
  cancelPoll: (() => void) | null;
  disposed: boolean;
  started: boolean;
  /** Best duration sample seen while recording (UI timer/fallback only). */
  lastSampleMs: number | null;
  /** Settled promise for this session's result (created once per take). */
  result: Promise<CaptureResult | undefined> | null;
  /**
   * RAW video completion promise (may reject). It is the ONLY proof that a video
   * capture physically ended: `stopRecording()` merely requests the stop.
   */
  completion: Promise<{ uri: string } | undefined> | null;
  /** True while the camera is believed to be capturing (until completion settles). */
  capturing: boolean;
};

export function createRecorderPortsFromDeps(
  deps: RecorderBindingsDeps,
  coordinator: RecorderHardwareCoordinator = deps.coordinator ?? sharedRecorderHardwareCoordinator,
): RecorderPorts {
  async function ownerOf(record: SessionRecord): Promise<HardwareOwner> {
    if (record.owner === null) {
      const outcome = await record.activation;
      if (!outcome.ok) throw outcome.error; // typed refusal, consumed by the caller
      record.owner = outcome.owner;
    }
    return record.owner;
  }

  async function stillOwner(record: SessionRecord): Promise<boolean> {
    const owner = await ownerOf(record);
    return !record.disposed && coordinator.isOwner(owner);
  }

  /**
   * Installs the shared status listener ONLY through the coordinator's slot: a
   * session that does not own the hardware (or the slot) cannot install or clear it.
   */
  function attachAudioStatusListener(
    record: SessionRecord,
    listener: ((status: NativeRecordingStatus) => void) | null,
  ): void {
    if (listener === null) {
      if (coordinator.statusListenerOwner() !== record.sessionId) return; // not ours
      coordinator.releaseStatusListener(record.sessionId);
      deps.audio.setStatusListener(null);
      return;
    }
    if (record.disposed) return;
    const owner = record.owner;
    if (owner === null || !coordinator.claimStatusListener(owner)) return; // stale
    deps.audio.setStatusListener(listener);
  }

  function stopPoll(record: SessionRecord): void {
    if (record.cancelPoll !== null) {
      record.cancelPoll();
      record.cancelPoll = null;
    }
  }

  /**
   * Finalize an audio take: the duration comes from the FINALIZED FILE probe, not
   * from the while-recording samples. A failed probe yields no duration, which the
   * controller rejects as a typed failure instead of accepting a stale value.
   */
  async function finalizeAudio(record: SessionRecord): Promise<CaptureResult | undefined> {
    const uri = deps.audio.uri() ?? deps.audio.status().url ?? null;
    if (uri === null) return undefined;
    const mimeType = deps.mimeForUri(uri, 'audio');
    if (mimeType === null) return undefined;
    let durationMs: number | null = null;
    try {
      durationMs = await deps.probeFinalAudioDurationMs(uri);
    } catch {
      durationMs = null;
    }
    return { uri, kind: 'audio', mimeType, durationMs };
  }

  function settleAudio(record: SessionRecord): void {
    if (record.disposed) return;
    const settled = record.ended;
    if (settled === null) return; // nothing pending
    if (record.result !== null) return; // already finalizing (duplicate stop)
    record.ended = null;
    stopPoll(record);
    attachAudioStatusListener(record, null);
    record.result = finalizeAudio(record).then((result) => {
      settled.resolve(result);
      return result;
    });
  }

  function startAudio(record: SessionRecord): void {
    record.ended = deferred<CaptureResult | undefined>();
    record.result = null;
    record.lastSampleMs = null;
    const listener = (status: NativeRecordingStatus): void => {
      if (record.disposed) return;
      const sample = deps.audio.status().durationMillis;
      if (sample !== null && Number.isFinite(sample) && sample > 0) {
        record.lastSampleMs = record.lastSampleMs === null ? sample : Math.max(record.lastSampleMs, sample);
      }
      if (status.hasError) {
        const settled = record.ended;
        record.ended = null;
        stopPoll(record);
        attachAudioStatusListener(record, null);
        settled?.resolve(undefined);
        return;
      }
      if (!deps.audio.status().isRecording && (status.isFinished || record.started)) {
        record.autoStop?.();
        settleAudio(record);
      }
    };
    record.cancelPoll = deps.schedule(() => {
      const sample = deps.audio.status().durationMillis;
      if (sample !== null && Number.isFinite(sample) && sample > 0) {
        record.lastSampleMs = record.lastSampleMs === null ? sample : Math.max(record.lastSampleMs, sample);
      }
    }, AUDIO_SAMPLE_MS);
    attachAudioStatusListener(record, listener);
    const owner = record.owner;
    if (owner !== null) {
      // The PHYSICAL stop is registered the moment capture begins, so a later
      // handoff can always stop this recording even if the logical stop arrives late.
      coordinator.registerPhysicalStop(owner, async () => {
        // Runs inside the handoff (queue held): the physical stop always executes,
        // even when the logical owner was already superseded.
        if (!deps.audio.status().isRecording) return; // nothing physically running
        await deps.audio.stopRecording();
        settleAudio(record);
      });
    }
    deps.audio.startRecording({ forDurationSeconds: MAX_AUDIO_DURATION_MS / 1000 });
    record.started = true;
  }

  /** One session handle: it owns exactly the resources created for it. */
  function createSession(sessionId: string, kind: MediaKind): NativeRecordingSession {
    const record: SessionRecord = {
      sessionId,
      kind,
      activation: coordinator.activate({ sessionId, kind }).then(
        (owner) => ({ ok: true as const, owner }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      owner: null,
      ended: null,
      autoStop: null,
      cancelPoll: null,
      disposed: false,
      started: false,
      lastSampleMs: null,
      result: null,
      completion: null,
      capturing: false,
    };

    async function release(): Promise<void> {
      if (record.disposed) return;
      stopPoll(record);
      record.autoStop = null;
      // Settle this take first so its finalized URI/duration is reported exactly once.
      settleAudio(record);
      attachAudioStatusListener(record, null); // clears only THIS session's listener
      record.disposed = true;
      const owner = record.owner;
      if (owner === null) return;
      // PHYSICAL shutdown first, independent of logical ownership: a live capture
      // must be stopped (or its reservation kept, which blocks every activation).
      if (record.capturing || deps.audio.status().isRecording) {
        // Fire-and-forget the PHYSICAL shutdown: the reservation is only cleared on
        // a confirmed stop, so a capture that cannot settle keeps blocking every
        // activation. The logical release must never hang on it.
        void coordinator.retryReservation(owner).catch(() => undefined);
      } else {
        coordinator.abandonPhysicalStop(owner);
      }
      if (!coordinator.isOwner(owner)) return; // superseded: touch no global state
      // Ownership-guarded BEST-EFFORT teardown: the physical stop is already
      // guaranteed by the reservation above, so the logical release must never
      // block on a queue that an unresolved shutdown still holds.
      if (kind === 'audio') {
        // NEVER mutate the process-global audio mode directly: this goes through the
        // SAME shared queue as activation/start/stop and is re-validated when it runs,
        // so a delayed restore can never land underneath a newer recording owner.
        void coordinator
          .runAudioModeTransition(owner, { enabled: false, apply: () => deps.audio.restorePlaybackMode() })
          .catch(() => undefined);
      } else {
        void coordinator
          .runHardwareTask(owner, () => {
            deps.video.getDevice()?.stopRecording();
          })
          .catch(() => undefined);
      }
      coordinator.deactivate(owner); // frees the hardware only when still ours
    }

    return {
      sessionId,
      kind,
      async start(options): Promise<void> {
        const owner = await ownerOf(record);
        if (record.disposed || !coordinator.isOwner(owner)) {
          throw new RecorderBindingError('superseded');
        }
        if (kind === 'audio') {
          await coordinator.runModeChange(owner, {
            enabled: true,
            apply: () => deps.audio.enableRecordingMode(),
          });
          if (!(await stillOwner(record))) throw new RecorderBindingError('superseded');
          const prepared = await coordinator.runHardwareTask(owner, () =>
            deps.audio.prepareRecording({
              bitRate: AUDIO_BITS_PER_SECOND,
              numberOfChannels: 1,
            }),
          );
          if (prepared.status === 'skipped') throw new RecorderBindingError('superseded');
          if (!(await stillOwner(record))) throw new RecorderBindingError('superseded');
          const started = await coordinator.runHardwareTask(owner, () => {
            // FINAL GATES inside the queued callback, immediately before the native
            // capture call: the app may have been backgrounded while this waited in
            // the hardware queue, and the session may have been superseded.
            if (!coordinator.isOwner(owner) || record.disposed) {
              throw new RecorderBindingError('superseded');
            }
            if (!deps.isLifecycleAuthorized()) throw new RecorderBindingError('background');
            startAudio(record);
            return true;
          });
          if (started.status === 'skipped') throw new RecorderBindingError('superseded');
          return;
        }

        const started = await coordinator.runHardwareTask(owner, () => {
          // FINAL GATES inside the queued callback, immediately before the native
          // capture call (see the audio path).
          if (!coordinator.isOwner(owner) || record.disposed) {
            throw new RecorderBindingError('superseded');
          }
          if (!deps.isLifecycleAuthorized()) throw new RecorderBindingError('background');
          const device = deps.video.getDevice();
          if (device === null) throw new RecorderBindingError('camera-not-mounted');
          // `recordAsync` resolves when recording ENDS: retained per session, never
          // awaited here, so the queue is not held for the whole recording.
          const pending = device.record({
            maxDurationSeconds: Math.min(options.forDurationSeconds, MAX_VIDEO_DURATION_MS / 1000),
            maxFileSizeBytes: MAX_VIDEO_SIZE_BYTES,
            codec: VIDEO_CODEC,
          });
          coordinator.registerPhysicalStop(owner, async () => {
            if (!record.capturing) {
              coordinator.confirmPhysicalStop(owner);
              return;
            }
            const device = deps.video.getDevice();
            device?.stopRecording(); // only REQUESTS the stop (may throw)
            const completion = record.completion;
            if (completion === null) throw new Error('video-completion-unknown');
            // ONLY the original record() completion proves the capture ended; a
            // rejection or a never-settling promise keeps the duty pending and the
            // handoff blocked (no second capture).
            await completion;
            record.capturing = false;
            coordinator.confirmPhysicalStop(owner);
          });
          // The RAW completion is the physical-end proof; `record.result` is the
          // settled value used by the take path.
          record.completion = pending;
          record.capturing = true;
          record.result = pending
            .then(async (result) => {
              if (result === undefined) return undefined;
              return {
                uri: result.uri,
                kind: 'video' as const,
                mimeType: deps.mimeForUri(result.uri, 'video'),
                durationMs: await deps.probeVideoDurationMs(result.uri),
              };
            })
            .then((value) => {
              // The take settled: the capture physically ended, so the duty may be
              // confirmed (never dropped in a generic finally block).
              record.capturing = false;
              coordinator.confirmPhysicalStop(owner);
              return value;
            })
            .catch(() => undefined);
          return true;
        });
        if (started.status === 'skipped') throw new RecorderBindingError('superseded');
      },
      async stop(): Promise<void> {
        const owner = await ownerOf(record);
        if (record.disposed) return;
        if (!coordinator.isOwner(owner)) return; // a stale session never stops B
        if (kind === 'audio') {
          const stopped = await coordinator.runHardwareTask(owner, async () => {
            await deps.audio.stopRecording();
            settleAudio(record);
            return true;
          });
          void stopped;
          return;
        }
        await coordinator.runHardwareTask(owner, () => {
          deps.video.getDevice()?.stopRecording();
        });
      },
      async recordingEnded(): Promise<CaptureResult | undefined> {
        if (kind === 'audio') {
          const pending = record.ended;
          if (pending !== null) return await pending.promise;
          if (record.result !== null) return await record.result;
          return undefined;
        }
        return (await record.result) ?? undefined;
      },
      onAutoStop(callback): () => void {
        record.autoStop = callback;
        return () => {
          if (record.autoStop === callback) record.autoStop = null;
        };
      },
      release,
    };
  }

  return {
    permissions: deps.permissions,
    native: {
      openSession: ({ sessionId, kind }) => createSession(sessionId, kind),
    },
    files: deps.files,
    clock: deps.clock,
    repository: deps.repository,
    identity: deps.identity,
    ids: {
      sessionId: () => {
        const sessionId = deps.createSessionId();
        deps.onSessionCreated?.(sessionId); // synchronous lease point
        return sessionId;
      },
    },
  };
}
