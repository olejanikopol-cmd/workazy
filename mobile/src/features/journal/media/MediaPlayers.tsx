/**
 * Local journal media playback: resolve owned files, then play them with real
 * native players. No URI is ever persisted and no remote/cloud source is guessed.
 *
 * Playback policy: exactly one clip plays at a time (the parent passes the active
 * media id); players are released when their card unmounts or the sheet closes.
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { JournalMedia } from '@/types/journal';
import { mediaRepository } from '@/services/media/journalMediaRuntime';
import { formatDuration } from '@/services/media/mediaLimits';
import type { LocalPlaybackSource } from '@/services/media/mediaContracts';
import { createPlayerLifecycle } from '@/services/media/playerLifecycle';
import { createVideoEventBridge } from './videoEventBridge';

export type ResolvedMedia =
  | { state: 'loading'; source: null; message: null }
  | { state: 'ready'; source: LocalPlaybackSource; message: null }
  | { state: 'unavailable'; source: null; message: string };

/** Resolve a committed attachment to an ephemeral playback source. */
export function useLocalMediaSource(media: JournalMedia | null): {
  resolved: ResolvedMedia;
  retry: () => void;
  /** Increments per retry; used to remount a fresh native player. */
  attempt: number;
} {
  const [attempt, setAttempt] = useState(0);
  // The resolved value is keyed: a stale resolution for a previous media item or
  // attempt can never be shown as the current one.
  const [resolvedState, setResolved] = useState<{ key: string; value: ResolvedMedia } | null>(null);
  const key = media === null ? null : `${media.id}:${attempt}`;

  useEffect(() => {
    if (media === null || key === null) return undefined;
    let cancelled = false;
    const resolvedKey = key;
    void mediaRepository
      .resolve({ id: media.id, type: media.type, mimeType: media.mimeType })
      .then((result) => {
        if (cancelled) return;
        setResolved({
          key: resolvedKey,
          value:
            'unavailable' in result
              ? { state: 'unavailable', source: null, message: result.message }
              : { state: 'ready', source: result, message: null },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setResolved({
          key: resolvedKey,
          value: {
            state: 'unavailable',
            source: null,
            message: 'Не удалось открыть файл записи. Повторите попытку.',
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key, media]);

  const resolved: ResolvedMedia =
    media === null
      ? { state: 'unavailable', source: null, message: 'Файл недоступен на этом устройстве.' }
      : resolvedState !== null && resolvedState.key === key
        ? resolvedState.value
        : { state: 'loading', source: null, message: null };

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { resolved, retry, attempt };
}

type AudioPlayerProps = {
  source: LocalPlaybackSource;
  active: boolean;
  onActivate: () => void;
  onFinished: () => void;
  /** Re-resolves the committed local media (honest retry, never a fake play). */
  onRetry?: () => void;
};

/** Audio: play/pause, elapsed/total, restart and tap-to-seek. */
export function LocalAudioPlayer({ source, active, onActivate, onFinished, onRetry }: AudioPlayerProps) {
  const player = useAudioPlayer(source.uri);
  const status = useAudioPlayerStatus(player);
  const totalSeconds = Number.isFinite(status.duration) ? status.duration : 0;
  const currentSeconds = Number.isFinite(status.currentTime) ? status.currentTime : 0;
  const [trackWidth, setTrackWidth] = useState(0);
  /**
   * Every native command and every failure cleanup goes through the production
   * playback controller: no command rejection escapes and no playback continues
   * behind an error card.
   */
  const lifecycle = useMemo(() => createPlayerLifecycle(), []);
  const controller = lifecycle.controller();
  // Callbacks are re-bound on every render and NEVER recreate the controller or
  // touch the native player, so an ordinary parent rerender cannot dispose playback.
  lifecycle.setCallbacks({ onClaimExclusive: () => onActivate(), onReleaseExclusive: () => onFinished() });
  const playback = useSyncExternalStore(controller.subscribe, controller.getStatus);

  // Binding the SAME player again only refreshes the wrapper; a REAL player/source
  // replacement retires the previous controller exactly once.
  useEffect(() => {
    lifecycle.setDevice(
      {
        play: () => player.play(),
        pause: () => player.pause(),
        seek: (seconds) => player.seekTo(seconds),
        release: () => player.remove(),
      },
      player,
    );
  }, [lifecycle, player]);

  // Unmount: release the active player exactly once.
  useEffect(() => () => lifecycle.dispose(), [lifecycle]);
  /** REAL playback state: the control never lies about what is happening. */
  const playing = playback.state === 'playing';

  useEffect(() => {
    controller.setNativeStatus({
      playing: status.playing === true,
      error: status.error ?? null,
      didJustFinish: status.didJustFinish === true,
    });
  }, [controller, status.didJustFinish, status.error, status.playing]);

  useEffect(() => {
    controller.setResolution('ready');
  }, [controller]);

  // Another clip took over: a failed stop runs the full failure cleanup.
  useEffect(() => {
    if (!active) controller.deactivate();
  }, [active, controller]);

  const fraction = totalSeconds > 0 ? Math.min(1, currentSeconds / totalSeconds) : 0;

  if (playback.state === 'unavailable') {
    return (
      <View style={styles.errorBox}>
        <AppText variant="meta">{playback.message}</AppText>
        {onRetry === undefined ? null : (
          <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
            <AppText variant="meta">Повторить</AppText>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={styles.playerRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Пауза' : 'Воспроизвести'}
        onPress={() => {
          // 1st tap plays, 2nd pauses, 3rd resumes — through the controller.
          controller.toggle();
        }}
        style={styles.playButton}
      >
        <Ionicons name={playing ? 'pause' : 'play'} size={18} color={colors.background} />
      </Pressable>
      <Pressable
        accessibilityRole="adjustable"
        accessibilityLabel="Позиция воспроизведения"
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        onPress={(event) => {
          if (totalSeconds <= 0 || trackWidth <= 0) return;
          const ratio = Math.max(0, Math.min(1, event.nativeEvent.locationX / trackWidth));
          controller.seek(ratio * totalSeconds);
        }}
        style={styles.progressTrack}
      >
        <View style={[styles.progressFill, { width: `${Math.round(fraction * 100)}%` }]} />
      </Pressable>
      <AppText variant="meta" style={styles.timerText}>
        {`${formatDuration(Math.round(currentSeconds * 1000))} / ${formatDuration(
          Math.round(totalSeconds * 1000),
        )}`}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="С начала"
        onPress={() => {
          controller.seek(0);
        }}
        style={styles.iconButton}
      >
        <Ionicons name="refresh" size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

type VideoPlayerProps = {
  source: LocalPlaybackSource;
  active: boolean;
  onActivate: () => void;
  /**
   * Called when this video stops owning playback (natural end, error cleanup or
   * deactivation). Identity-guarded by the sheet, so a stale A callback can never
   * clear a newer B.
   */
  onFinished?: () => void;
  /** Re-resolves the committed local media after a decode failure. */
  onRetry?: () => void;
};

/** Video: native controls, background playback and PiP disabled. */
export function LocalVideoPlayer({ source, active, onActivate, onFinished, onRetry }: VideoPlayerProps) {
  const player = useVideoPlayer(source.uri, (instance) => {
    instance.loop = false;
  });
  const lifecycle = useMemo(() => createPlayerLifecycle(), []);
  const controller = lifecycle.controller();
  lifecycle.setCallbacks({
    onClaimExclusive: () => onActivate(),
    // Natural end, error cleanup, switch or unmount: the sheet's identity-guarded
    // updater decides whether THIS video may clear the active id.
    onReleaseExclusive: () => onFinished?.(),
  });
  const playback = useSyncExternalStore(controller.subscribe, controller.getStatus);

  useEffect(() => {
    lifecycle.setDevice(
      {
        play: () => player.play(),
        pause: () => player.pause(),
        seek: async (seconds) => {
          player.currentTime = seconds;
        },
        release: () => player.release(),
      },
      player,
    );
  }, [lifecycle, player]);

  useEffect(() => () => lifecycle.dispose(), [lifecycle]);

  useEffect(() => {
    controller.setResolution('ready');
  }, [controller]);

  useEffect(() => {
    // The REAL expo-video events drive the SHARED playback controller through the
    // production bridge: a native-controlled start (its own play button included)
    // claims exclusivity and the sheet's active id, and completion/error release it
    // again through the identity-guarded callback.
    const bridge = createVideoEventBridge(controller);
    const playing = player.addListener('playingChange', (payload: { isPlaying: boolean }) => {
      bridge.handlePlayingChange(payload);
    });
    const status = player.addListener('statusChange', (payload: { status: string }) => {
      bridge.handleStatusChange(payload);
    });
    const ended = player.addListener('playToEnd', () => {
      bridge.handlePlayToEnd();
    });
    return () => {
      playing.remove();
      status.remove();
      ended.remove();
    };
  }, [controller, player]);

  // Another clip took over: a failed stop runs the full failure cleanup.
  useEffect(() => {
    if (!active) controller.deactivate();
  }, [active, controller]);

  if (playback.state === 'unavailable') {
    return (
      <View style={styles.errorBox}>
        <AppText variant="meta">{playback.message}</AppText>
        {onRetry === undefined ? null : (
          <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
            <AppText variant="meta">Повторить</AppText>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <VideoView
      player={player}
      style={styles.videoSurface}
      nativeControls
      contentFit="contain"
      allowsPictureInPicture={false}
    />
  );
}

const styles = StyleSheet.create({
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  playButton: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: touchTarget / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  progressTrack: {
    flex: 1,
    height: 24,
    justifyContent: 'center',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  timerText: {
    minWidth: 72,
    textAlign: 'right',
  },
  iconButton: {
    width: 32,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBox: {
    gap: spacing.xs,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.item,
    backgroundColor: colors.surfaceElevated,
  },
  retryButton: {
    minHeight: 32,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    borderRadius: radius.segment,
    backgroundColor: colors.surfaceSelected,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoSurface: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radius.item,
    backgroundColor: '#000',
    marginTop: spacing.sm,
  },
});
