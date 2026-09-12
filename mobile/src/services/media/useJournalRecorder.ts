/**
 * Recorder hook: binds the production recorder controller to the native audio
 * recorder, the camera surface and the app lifecycle.
 *
 * Kept in `services/media` so Expo imports stay inside the media boundary; the
 * surfaces in `features/journal/media` only consume the returned API.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState, Linking } from 'react-native';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import type { CameraView } from 'expo-camera';
import { createExpoRecorderPorts, createMediaHandleSlot, type CameraHandle } from './expoRecorderBindings';
import { createCallbackSlot } from './callbackSlot';
import { createSessionLeaseTracker } from './sessionLeaseTracker';
import { createRecorderSurfaceLifecycle } from './recorderSurfaceLifecycle';
import { mediaFailure, type MediaFailure } from './mediaContracts';
import {
  leaseRecorderSession,
  mediaRepository,
  releaseRecorderSession,
} from './journalMediaRuntime';
import {
  createRecorderController,
  type AttachAuthorization,
  type OwnerIdentity,
  type RecorderController,
  type RecorderSnapshot,
} from './recorderController';

/** Recording options: AAC/M4A high-quality preset, 96 kbit/s mono for voice. */
export const AUDIO_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  bitRate: 96_000,
  numberOfChannels: 1,
};

/** Native camera target; the actual bitrate is a CameraView prop (900 kbit/s). */
export const VIDEO_TARGET_QUALITY = '720p' as const;

export type JournalRecorderOptions = {
  /** Authoritative attach decision (live sheet identity, revision, busy state). */
  authorize: (input: AttachAuthorization) => MediaFailure | null;
  /** Reports the recorder session id as soon as the surface opens it. */
  onSessionOpened?: (sessionId: string) => void;
};

export type JournalRecorderApi = {
  controller: RecorderController;
  snapshot: RecorderSnapshot;
  /** Attach to `<CameraView ref={...} />`; native handle kept in a mutable slot. */
  cameraRefCallback: (view: CameraView | null) => void;
  startAudio: (identity: OwnerIdentity) => Promise<void>;
  openVideo: (identity: OwnerIdentity) => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  openSettings: () => Promise<void>;
  refreshPermission: () => Promise<void>;
};

export function useJournalRecorder(options: JournalRecorderOptions): JournalRecorderApi {
  // Native handles live in a stable slot object; the recorder status listener only
  // forwards into it, so nothing is mutated during render.
  const slot = useMemo(() => createMediaHandleSlot(), []);
  const recorder = useAudioRecorder(AUDIO_RECORDING_OPTIONS, (status) => {
    slot.emitAudioStatus(status);
  });

  // Late-bound callbacks: the controller is created once, and the surface's live
  // identity/busy state is read when the decision is made. The default refuses
  // attachment (safe) until the owning surface registers its real callback.
  const authorizeSlot = useMemo(
    () => createCallbackSlot<[AttachAuthorization], MediaFailure | null>(() => mediaFailure('busy')),
    [],
  );
  const sessionOpenedSlot = useMemo(
    () => createCallbackSlot<[string], void>(() => undefined),
    [],
  );
  // ONE session lease at a time: a new session releases the previous one. Created
  // once, and written only through its own methods.
  const sessionTracker = useMemo(
    () => createSessionLeaseTracker(leaseRecorderSession, releaseRecorderSession),
    [],
  );
  useEffect(() => {
    authorizeSlot.set(options.authorize);
  }, [authorizeSlot, options.authorize]);
  useEffect(() => {
    sessionOpenedSlot.set(options.onSessionOpened ?? (() => undefined));
  }, [options.onSessionOpened, sessionOpenedSlot]);

  const controller = useMemo(
    () =>
      createRecorderController(
        createExpoRecorderPorts({
          recorder,
          slot,
          getCameraHandle: (): CameraHandle | null => {
            const view = slot.getCamera() as CameraView | null;
            if (view === null) return null;
            return {
              record: async (options) =>
                await view.recordAsync({
                  maxDuration: options.maxDurationSeconds,
                  maxFileSize: options.maxFileSizeBytes,
                  codec: options.codec,
                }),
              stopRecording: () => {
                view.stopRecording();
              },
            };
          },
          enableRecordingMode: async () => {
            await AudioModule.setAudioModeAsync({
              allowsRecording: true,
              playsInSilentMode: true,
              shouldPlayInBackground: false,
              interruptionMode: 'doNotMix',
            });
          },
          restorePlaybackMode: async () => {
            // Recording mode is configured only for the active owner.
            await AudioModule.setAudioModeAsync({
              allowsRecording: false,
              playsInSilentMode: true,
              shouldPlayInBackground: false,
            });
          },
          repository: mediaRepository,
          // Late-bound: the surface's live identity/busy state is consulted when
          // the decision is made, and the controller itself is never recreated.
          identity: { authorize: (input) => authorizeSlot.invoke(input) },
          // Synchronous lease point: the session exists from this instant, before
          // any native await, and no stale async completion can re-register it.
          onSessionCreated: (sessionId: string) => {
            sessionTracker.opened(sessionId);
            sessionOpenedSlot.invoke(sessionId);
          },
        }),
      ),
    [authorizeSlot, recorder, sessionOpenedSlot, sessionTracker, slot],
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  // Unmount teardown uses the SAME production lifecycle the tests drive: release
  // whichever session lease is current and invalidate the controller (generation
  // bump, own-resource stop/release, own-take cleanup, late URI collected).
  const lifecycle = useMemo(
    () =>
      createRecorderSurfaceLifecycle({
        releaseSessionLease: () => sessionTracker.closed(),
        cancel: () => controller.cancel(),
      }),
    [controller, sessionTracker],
  );
  useEffect(() => () => void lifecycle.dispose(), [lifecycle]);

  // Lifecycle: initial state comes from AppState; background stops exactly once.
  useEffect(() => {
    controller.setAppState(AppState.currentState ?? 'active');
    const subscription = AppState.addEventListener('change', (next) => {
      controller.setAppState(next);
    });
    return () => subscription.remove();
  }, [controller]);

  // Timer: monotonic elapsed ms + controller deadline while recording.
  useEffect(() => {
    if (snapshot.state !== 'recording') return undefined;
    const timer = setInterval(() => controller.tick(), 200);
    return () => clearInterval(timer);
  }, [controller, snapshot.state]);

  return {
    controller,
    snapshot,
    cameraRefCallback: useCallback(
      (view: CameraView | null) => {
        slot.setCamera(view);
      },
      [slot],
    ),
    startAudio: useCallback(
      async (identity: OwnerIdentity) => {
        await controller.startAudio(identity);
      },
      [controller],
    ),
    openVideo: useCallback(
      async (identity: OwnerIdentity) => {
        await controller.openVideo(identity);
      },
      [controller],
    ),
    stop: useCallback(async () => {
      await controller.stop();
    }, [controller]),
    cancel: useCallback(async () => {
      await controller.cancel();
    }, [controller]),
    openSettings: useCallback(async () => {
      await Linking.openSettings();
    }, []),
    refreshPermission: useCallback(async () => {
      await controller.refreshPermission();
    }, [controller]),
  };
}
