/**
 * Stable player-controller lifecycle for one attachment card.
 *
 * A playback controller must live exactly as long as its NATIVE PLAYER/SOURCE, never
 * as long as a callback identity:
 * - `setCallbacks` re-binds changing parent callbacks WITHOUT touching the controller
 *   or the native player (so an ordinary React rerender cannot dispose playback);
 * - `setDevice` binds the native player wrapper and disposes the previous controller
 *   exactly once only when the player/source REALLY changed (token identity);
 * - `dispose` (unmount) releases the active player exactly once and is idempotent.
 *
 * `MediaPlayers` uses this exact implementation for audio and video.
 */
import { createPlaybackController, type PlaybackController, type PlaybackDevice } from './playbackController';

export type PlayerLifecycleCallbacks = {
  onClaimExclusive?: () => void;
  onReleaseExclusive?: () => void;
};

export type PlayerLifecycleStats = {
  /** Controllers created for this card (one per player/source generation). */
  created: number;
  /** Controllers retired (real replacement or unmount). */
  disposed: number;
  /** Native release calls issued through the lifecycle. */
  releases: number;
};

export type PlayerLifecycle = {
  controller(): PlaybackController;
  /** Late-bound callbacks; never recreates the controller or touches the player. */
  setCallbacks(next: PlayerLifecycleCallbacks): void;
  /**
   * Binds the native player. `token` identifies the player/source instance: a new
   * token retires the previous controller exactly once, the same token only
   * refreshes the wrapper (a rerender never disposes playback).
   */
  setDevice(next: PlaybackDevice | null, token?: unknown): void;
  currentDevice(): PlaybackDevice | null;
  dispose(): void;
  isDisposed(): boolean;
  stats(): PlayerLifecycleStats;
};

export function createPlayerLifecycle(): PlayerLifecycle {
  let device: PlaybackDevice | null = null;
  let deviceToken: unknown = undefined;
  let disposed = false;
  let created = 0;
  let disposedCount = 0;
  let releases = 0;
  const callbacks: PlayerLifecycleCallbacks = {};

  function build(): PlaybackController {
    created += 1;
    return createPlaybackController({
      getDevice: () => {
        const current = device;
        if (current === null) return null;
        return {
          play: () => current.play(),
          pause: () => current.pause(),
          seek: (seconds) => current.seek(seconds),
          release: () => {
            releases += 1;
            current.release();
          },
        };
      },
      onClaimExclusive: () => callbacks.onClaimExclusive?.(),
      onReleaseExclusive: () => callbacks.onReleaseExclusive?.(),
    });
  }

  let controller = build();

  return {
    controller: () => controller,

    setCallbacks(next) {
      callbacks.onClaimExclusive = next.onClaimExclusive;
      callbacks.onReleaseExclusive = next.onReleaseExclusive;
    },

    setDevice(next, token) {
      if (disposed) return;
      if (token !== undefined && token === deviceToken) {
        device = next; // same player/source: refresh the wrapper only
        return;
      }
      if (device !== null) {
        // A REAL player/source replacement: retire the old controller/player once.
        controller.dispose();
        disposedCount += 1;
        controller = build();
      }
      device = next;
      deviceToken = token;
    },

    currentDevice: () => device,

    dispose() {
      if (disposed) return;
      disposed = true;
      controller.dispose();
      disposedCount += 1;
      device = null;
    },

    isDisposed: () => disposed,
    stats: () => ({ created, disposed: disposedCount, releases }),
  };
}
