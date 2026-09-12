import type { PlaybackController } from '../../../services/media/playbackController';

/**
 * Production bridge between the installed expo-video events and the shared playback
 * controller/lifecycle. `LocalVideoPlayer` wires its real listeners through this
 * exact object, so the ownership chain native controls actually exercise is
 *
 *   expo-video 'playingChange' (true) -> controller.onNativePlaybackStarted()
 *     -> claim exclusivity -> JournalSheet's guarded claim(mediaId)
 *   expo-video 'playToEnd'            -> controller completion
 *     -> release exclusivity -> JournalSheet's guarded clear(mediaId)
 *   expo-video 'statusChange' error   -> the controller's centralized failure
 *     cleanup (pause, release, yield exclusivity) -> guarded clear(mediaId)
 *
 * It exists as a plain module (no React Native / Expo imports) so the real event
 * semantics can be exercised in tests against the real controller instead of a
 * test-only look-alike.
 */
export const VIDEO_PLAYBACK_ERROR = 'video-playback-error';

export type VideoEventBridge = {
  /** expo-video `playingChange`: native UI controls included. */
  handlePlayingChange(payload: { isPlaying: boolean }): void;
  /** expo-video `playToEnd`: the real end-of-source signal. */
  handlePlayToEnd(): void;
  /** expo-video `statusChange`. */
  handleStatusChange(payload: { status: string }): void;
};

export function createVideoEventBridge(controller: PlaybackController): VideoEventBridge {
  return {
    handlePlayingChange({ isPlaying }) {
      if (isPlaying) {
        // A real native start (its own controls included): own the shared active id
        // through the controller instead of mutating UI state directly.
        controller.onNativePlaybackStarted();
        controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
        return;
      }
      // Native pause keeps exclusivity: the clip stays the active media until it
      // completes, fails, or another clip claims the active id.
      controller.setNativeStatus({ playing: false, error: null, didJustFinish: false });
    },

    handlePlayToEnd() {
      // Real completion: the controller pauses, rewinds and yields exclusivity.
      controller.setNativeStatus({ playing: false, error: null, didJustFinish: true });
    },

    handleStatusChange({ status }) {
      if (status !== 'error') return;
      // The controller runs the SAME centralized failure cleanup as every other
      // playback failure and yields exclusivity, so the active id cannot go stale.
      controller.setNativeStatus({ playing: false, error: VIDEO_PLAYBACK_ERROR, didJustFinish: false });
    },
  };
}
