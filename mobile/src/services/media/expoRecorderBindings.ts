/**
 * Real Expo wiring for the session-scoped recorder bindings.
 *
 * All policy lives in `recorderBindingsCore.ts` (injectable, tested directly with
 * fakes). This module only binds the installed Expo modules to those dependencies,
 * including probes for the AUTHORITATIVE duration of finalized media:
 *
 * - audio: `createAudioPlayer(uri)` reports the decoded `duration` of the file
 *   after it is finalized, which is the duration used for validation;
 * - video: `createVideoPlayer(uri)` reports the loaded media duration.
 *
 * The while-recording sampling produced by the core is a UI/fallback value only.
 */
import { AppState } from 'react-native';
import { File } from 'expo-file-system';
import {
  AudioModule,
  RecordingPresets,
  createAudioPlayer,
  type AudioRecorder,
  type RecordingStatus,
} from 'expo-audio';
import { Camera } from 'expo-camera';
import { createVideoPlayer, type VideoPlayerStatus } from 'expo-video';
import { mimeForExtension, type MediaKind } from './mediaLimits';
import {
  VIDEO_CODEC,
  createRecorderPortsFromDeps,
  toPermissionState,
  type NativeRecordingStatus,
} from './recorderBindingsCore';
import type { LocalMediaRepository } from './localMediaRepository';
import type { RecorderPorts } from './recorderController';

/** Metadata/warm-up bound for a finalized-media duration probe. */
const PROBE_TIMEOUT_MS = 5_000;

export { VIDEO_CODEC, toPermissionState } from './recorderBindingsCore';
export type { NativeRecordingStatus } from './recorderBindingsCore';

/** The camera surface contract, implemented by the video recorder surface. */
export type CameraHandle = {
  /** Starts recording; the result promise resolves when recording ENDS. */
  record(options: {
    maxDurationSeconds: number;
    maxFileSizeBytes: number;
    codec: typeof VIDEO_CODEC;
  }): Promise<{ uri: string } | undefined>;
  /** Synchronous native stop request; the record promise carries the result. */
  stopRecording(): void;
};

/**
 * Mutable slot for the native camera view and the active audio status listener.
 * Created once per recorder surface; all writes go through its own methods, so no
 * memoized value is mutated and no ref is read during render.
 */
export type MediaHandleSlot = {
  setCamera(view: unknown): void;
  getCamera(): unknown;
  setAudioStatusListener(listener: ((status: RecordingStatus) => void) | null): void;
  emitAudioStatus(status: RecordingStatus): void;
};

export function createMediaHandleSlot(): MediaHandleSlot {
  let camera: unknown = null;
  let audioStatus: ((status: RecordingStatus) => void) | null = null;
  return {
    setCamera: (view) => {
      camera = view;
    },
    getCamera: () => camera,
    setAudioStatusListener: (listener) => {
      audioStatus = listener;
    },
    emitAudioStatus: (status) => {
      audioStatus?.(status);
    },
  };
}

export type ExpoRecorderBindingInput = {
  recorder: AudioRecorder;
  slot: MediaHandleSlot;
  /** Camera handle getter; null while the video surface is not mounted. */
  getCameraHandle: () => CameraHandle | null;
  /** Playback audio mode used when no recording is active. */
  restorePlaybackMode: () => Promise<void>;
  /** Recording audio mode (allowsRecording: true, playback in silent mode). */
  enableRecordingMode: () => Promise<void>;
  /** Production local media repository (injected, never a second instance). */
  repository: Pick<LocalMediaRepository, 'adoptCapture' | 'discard'>;
  /** Authoritative attach decision supplied by the owning recorder surface. */
  identity: RecorderPorts['identity'];
  /**
   * Called SYNCHRONOUSLY the moment a recorder session id is minted, before any
   * native work — this is where the session lease is taken.
   */
  onSessionCreated: (sessionId: string) => void;
  /** Injectable scheduler (tests may drive it manually). */
  schedule?: (callback: () => void, everyMs: number) => () => void;
  /**
   * Lifecycle authorization read immediately before a native capture starts.
   * Defaults to the real app state: the app must be active.
   */
  isLifecycleAuthorized?: () => boolean;
};

/** Maps the expo-audio recording status onto the binding contract. */
export function toRecordingStatus(status: RecordingStatus): NativeRecordingStatus {
  return {
    isFinished: status.isFinished === true,
    hasError: status.hasError === true,
    error: status.error ?? null,
    url: status.url ?? null,
  };
}

/** MIME for a finalized native file, derived from its container. */
export function mimeForUri(uri: string, kind: MediaKind): string | null {
  const clean = uri.split('?')[0].split('#')[0];
  const extension = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
  const mime = mimeForExtension(extension);
  if (mime === null) return null;
  if (kind === 'audio' && !mime.startsWith('audio/')) return null;
  if (kind === 'video' && !mime.startsWith('video/')) return null;
  return mime;
}

/**
 * Authoritative duration of a FINALIZED audio file, read by the real audio player
 * (decoded media duration), bounded and always released.
 */
export async function probeFinalAudioDurationMs(uri: string): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    let settled = false;
    let player: ReturnType<typeof createAudioPlayer> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        player?.remove();
      } catch {
        // Releasing is best-effort.
      }
      resolve(value);
    };
    timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    try {
      player = createAudioPlayer(uri);
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.error !== null && status.error !== undefined) {
          finish(null);
          return;
        }
        if (status.isLoaded && Number.isFinite(status.duration) && status.duration > 0) {
          finish(Math.round(status.duration * 1000));
        }
      });
    } catch {
      finish(null);
    }
  });
}

/** Duration of a finalized video file read from the loaded media. */
export async function probeVideoDurationMs(uri: string): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    let settled = false;
    let player: ReturnType<typeof createVideoPlayer> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        player?.release();
      } catch {
        // Releasing is best-effort.
      }
      resolve(value);
    };
    timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    try {
      player = createVideoPlayer(uri);
      player.addListener('statusChange', (payload: { status: VideoPlayerStatus }) => {
        if (payload.status === 'readyToPlay') {
          const seconds = player?.duration ?? Number.NaN;
          finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
        } else if (payload.status === 'error') {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

export function createExpoRecorderPorts(input: ExpoRecorderBindingInput): RecorderPorts {
  const schedule =
    input.schedule ??
    ((callback: () => void, everyMs: number) => {
      const timer = setInterval(callback, everyMs);
      return () => clearInterval(timer);
    });

  return createRecorderPortsFromDeps({
    audio: {
      enableRecordingMode: () => input.enableRecordingMode(),
      restorePlaybackMode: () => input.restorePlaybackMode(),
      prepareRecording: async (options) => {
        await input.recorder.prepareToRecordAsync({
          ...RecordingPresets.HIGH_QUALITY,
          bitRate: options.bitRate,
          numberOfChannels: options.numberOfChannels,
        });
      },
      startRecording: (options) => {
        input.recorder.record({ forDuration: options.forDurationSeconds });
      },
      stopRecording: () => input.recorder.stop(),
      status: () => {
        const status = input.recorder.getStatus();
        return {
          durationMillis: Number.isFinite(status.durationMillis) ? status.durationMillis : null,
          isRecording: status.isRecording === true,
          url: status.url ?? null,
        };
      },
      uri: () => input.recorder.uri ?? null,
      setStatusListener: (listener) => {
        input.slot.setAudioStatusListener(
          listener === null ? null : (status: RecordingStatus) => listener(toRecordingStatus(status)),
        );
      },
    },
    video: { getDevice: () => input.getCameraHandle() },
    probeFinalAudioDurationMs,
    probeVideoDurationMs,
    permissions: {
      get: async (kind) =>
        toPermissionState(
          kind === 'audio'
            ? await AudioModule.getRecordingPermissionsAsync()
            : await Camera.getCameraPermissionsAsync(),
        ),
      request: async (kind) =>
        toPermissionState(
          kind === 'audio'
            ? await AudioModule.requestRecordingPermissionsAsync()
            : await Camera.requestCameraPermissionsAsync(),
        ),
    },
    files: {
      async size(uri) {
        const file = new File(uri);
        if (!file.exists) return null;
        const size = file.size;
        return Number.isFinite(size) && size > 0 ? size : null;
      },
      async remove(uri) {
        const file = new File(uri);
        if (file.exists) file.delete();
      },
    },
    clock: {
      // Monotonic where available: never wall-clock timestamps as elapsed time.
      monotonicMs: () => {
        const perf = globalThis.performance;
        return typeof perf?.now === 'function' ? perf.now() : Date.now();
      },
    },
    repository: input.repository,
    identity: input.identity,
    createSessionId: () => `session-${randomUuid()}`,
    schedule,
    mimeForUri,
    onSessionCreated: input.onSessionCreated,
    isLifecycleAuthorized:
      input.isLifecycleAuthorized ?? (() => (AppState.currentState ?? 'active') === 'active'),
  });
}

/** UUID v4 from the platform crypto (expo-crypto provides `globalThis.crypto`). */
export function randomUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
