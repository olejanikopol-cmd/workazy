/**
 * Playback lifecycle controller (production policy for one attachment card).
 *
 * Guarantees:
 * - any failure (native status error, rejected play/pause/seek/replay, load error)
 *   runs the SAME safe cleanup exactly once: mark failing -> guarded pause ->
 *   guarded release -> clear exclusive playback ownership -> publish an honest
 *   unavailable state. No native playback continues behind an error card.
 * - completion rewind failures are caught: the clip is released and the card
 *   reports it instead of leaving an unhandled rejection.
 * - switching clips / unmount guard pause+release and swallow rejections.
 * - `retryReady()` starts from a CLEAN released state; the caller re-resolves the
 *   committed media and builds a fresh controller/player for the new attempt.
 * - normal behaviour stays: play -> pause -> resume.
 */
export type PlaybackDevice = {
  play(): void;
  pause(): void;
  seek(seconds: number): Promise<void>;
  release(): void;
};

export type PlaybackFailureReason = 'native' | 'command' | 'cleanup' | 'file';

export type PlaybackStatus = {
  state: 'loading' | 'ready' | 'playing' | 'paused' | 'unavailable';
  message: string | null;
  canRetry: boolean;
  errorReason: PlaybackFailureReason | null;
};

export const PLAYBACK_NATIVE_ERROR_MESSAGE = 'Не удалось воспроизвести запись. Повторите попытку.';
export const PLAYBACK_FILE_MESSAGE = 'Файл недоступен на этом устройстве.';
export const PLAYBACK_CLEANUP_ERROR_MESSAGE =
  'Запись завершилась, но перемотка не удалась. Откройте вложение заново.';

export type PlaybackController = {
  getStatus(): PlaybackStatus;
  subscribe(listener: () => void): () => void;
  /** Resolution result of the committed file (never guesses a URL). */
  setResolution(resolution: 'loading' | 'ready' | 'unavailable', message?: string | null): void;
  /** Native player state (from the SDK status hook/events). */
  setNativeStatus(status: { playing: boolean; error: string | null; didJustFinish: boolean }): void;
  toggle(): void;
  /**
   * NATIVE/externally controlled playback started (e.g. expo-video's own controls,
   * which never call `toggle()`). This is the SAME exclusivity claim `toggle()`
   * performs, exposed as a production API so the video event bridge can report real
   * native starts. Idempotent for repeated native playing/status events, never
   * recreates the player/controller, and compatible with toggle-based (audio)
   * ownership. A native pause keeps exclusivity: the clip stays the active media
   * until completion, error or another clip claiming ownership.
   */
  onNativePlaybackStarted(): void;
  seek(seconds: number): void;
  /** Another clip took over: pause (guarded) and yield exclusivity. */
  deactivate(): void;
  /** Unmount: guarded pause + release, never throwing. */
  dispose(): void;
  /** Starts a clean retry cycle (after the caller re-resolved the media). */
  retryReady(): void;
};

export type PlaybackControllerInput = {
  /** Device accessor: null until the fresh native player exists. */
  getDevice: () => PlaybackDevice | null;
  /** Called when this card becomes the one playing clip. */
  onClaimExclusive?: () => void;
  /** Called when this card stops owning playback (failure/completion/switch). */
  onReleaseExclusive?: () => void;
};

export function createPlaybackController(input: PlaybackControllerInput): PlaybackController {
  let status: PlaybackStatus = {
    state: 'loading',
    message: null,
    canRetry: false,
    errorReason: null,
  };
  let resolution: 'loading' | 'ready' | 'unavailable' = 'loading';
  let nativePlaying = false;
  let cleanedUp = false;
  let released = false;
  /** Exclusivity is claimed/released at most once per cycle. */
  let holdsExclusivity = false;
  const listeners = new Set<() => void>();

  function publish(next: PlaybackStatus): void {
    status = Object.freeze(next);
    for (const listener of listeners) listener();
  }

  function publishReady(): void {
    publish({
      state: nativePlaying ? 'playing' : 'paused',
      message: null,
      canRetry: false,
      errorReason: null,
    });
  }

  /** Guarded pause: a rejection here must never escape as an unhandled rejection. */
  function safePause(): void {
    try {
      input.getDevice()?.pause();
    } catch {
      // Ignored: cleanup continues.
    }
  }

  /** Guarded release: attempted once per controller cycle. */
  function safeRelease(): void {
    if (released) return;
    released = true;
    try {
      input.getDevice()?.release();
    } catch {
      // Ignored: a failed release must not hide the original failure.
    }
  }

  function claimExclusivity(): void {
    if (holdsExclusivity) return;
    holdsExclusivity = true;
    input.onClaimExclusive?.();
  }

  function releaseExclusivity(): void {
    if (!holdsExclusivity) return; // never yields twice (e.g. completion + failure)
    holdsExclusivity = false;
    input.onReleaseExclusive?.();
  }

  /**
   * The ONE failure path: stop, release, yield exclusivity, publish honestly.
   * Idempotent, so concurrent failures cannot release twice.
   */
  function fail(reason: PlaybackFailureReason, message: string): void {
    const alreadyFailed = cleanedUp;
    cleanedUp = true;
    nativePlaying = false;
    safePause();
    safeRelease();
    releaseExclusivity();
    if (alreadyFailed) return; // cleanup already ran; nothing new to publish
    publish({ state: 'unavailable', message, canRetry: true, errorReason: reason });
  }

  function deviceCommand(command: () => void): boolean {
    if (cleanedUp) return false;
    try {
      command();
      return true;
    } catch {
      fail('command', PLAYBACK_NATIVE_ERROR_MESSAGE);
      return false;
    }
  }

  return {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setResolution(next, message = null) {
      resolution = next;
      if (next === 'unavailable') {
        fail('file', message ?? PLAYBACK_FILE_MESSAGE);
        return;
      }
      if (next === 'loading') {
        publish({ state: 'loading', message: null, canRetry: false, errorReason: null });
        return;
      }
      if (cleanedUp) return; // a failed/released controller never claims to be playable
      publishReady();
    },

    setNativeStatus(next) {
      if (cleanedUp) return;
      if (typeof next.error === 'string' && next.error.length > 0) {
        fail('native', PLAYBACK_NATIVE_ERROR_MESSAGE);
        return;
      }
      nativePlaying = next.playing;
      if (next.didJustFinish) {
        // Completion: pause, rewind, yield exclusivity. A rewind failure is caught
        // and surfaced (never an unhandled rejection, never a stuck player).
        safePause();
        nativePlaying = false;
        releaseExclusivity();
        const device = input.getDevice();
        if (device === null) {
          publish({ state: 'ready', message: null, canRetry: false, errorReason: null });
          return;
        }
        device
          .seek(0)
          .then(() => {
            if (!cleanedUp) {
              publish({ state: 'ready', message: null, canRetry: false, errorReason: null });
            }
          })
          .catch(() => fail('cleanup', PLAYBACK_CLEANUP_ERROR_MESSAGE));
        return;
      }
      if (resolution === 'ready') publishReady();
    },

    toggle() {
      if (cleanedUp) return;
      const device = input.getDevice();
      if (device === null) return;
      if (nativePlaying) {
        deviceCommand(() => device.pause());
        return;
      }
      claimExclusivity();
      deviceCommand(() => device.play());
    },

    onNativePlaybackStarted() {
      if (cleanedUp) return;
      nativePlaying = true;
      // Claims ownership through the configured callback exactly once, so a
      // natively driven start owns the shared active-media id and can therefore
      // release it on completion/error (the defect: exclusivity stayed false).
      claimExclusivity();
      if (resolution === 'ready') publishReady();
    },

    seek(seconds) {
      if (cleanedUp) return;
      const device = input.getDevice();
      if (device === null) return;
      device.seek(seconds).catch(() => fail('command', PLAYBACK_NATIVE_ERROR_MESSAGE));
    },

    /**
     * Another clip takes over. A pause failure here is a REAL playback failure, so
     * it runs the same centralized cleanup (release + yield exclusivity + honest
     * error) instead of leaving hidden playback behind the new UI.
     */
    deactivate() {
      if (cleanedUp) return;
      const device = input.getDevice();
      if (device === null) {
        nativePlaying = false;
        releaseExclusivity();
        return;
      }
      try {
        device.pause();
        nativePlaying = false;
        releaseExclusivity();
      } catch {
        fail('command', PLAYBACK_NATIVE_ERROR_MESSAGE);
      }
    },

    dispose() {
      if (cleanedUp) {
        safeRelease(); // unmount always ensures the native player is gone
        return;
      }
      cleanedUp = true;
      nativePlaying = false;
      safePause();
      safeRelease();
      releaseExclusivity();
    },

    retryReady() {
      // A retry always starts from a clean state; the caller supplies a fresh device.
      cleanedUp = false;
      released = false;
      holdsExclusivity = false;
      nativePlaying = false;
      resolution = 'loading';
      publish({ state: 'loading', message: null, canRetry: false, errorReason: null });
    },
  };
}
