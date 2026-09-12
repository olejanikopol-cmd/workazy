/**
 * Full-screen journal recorder surface (audio or video) hosted INSIDE the
 * existing JournalSheet modal: no stacked native modals and no router state.
 *
 * One control per action, no hold gestures: audio's record tap flows through
 * permission/prepare into recording and the same tap stops; video opens the
 * camera, then one tap records and the same tap stops. Cancel is available in
 * every state; preview exposes Use / Re-record / Cancel.
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, type CameraType } from 'expo-camera';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import {
  VIDEO_BITS_PER_SECOND,
  formatDuration,
  formatFileSize,
  limitsFor,
} from '@/services/media/mediaLimits';
import type { LocalMediaDraft, MediaFailure } from '@/services/media/mediaContracts';
import { authorizeAttach } from '@/services/media/attachAuthorization';
import type { AttachAuthorization, OwnerIdentity } from '@/services/media/recorderController';
import { VIDEO_TARGET_QUALITY, useJournalRecorder } from '@/services/media/useJournalRecorder';
import { abandonStagedDrafts } from '@/services/media/journalMediaRuntime';
import { LocalAudioPlayer, LocalVideoPlayer } from './MediaPlayers';

export type RecorderKind = 'audio' | 'video';

type Props = {
  visible: boolean;
  kind: RecorderKind;
  /** Live sheet identity getter; a stale revision is never captured. */
  getIdentity: () => OwnerIdentity;
  /** Parent's SYNCHRONOUS busy/lock state (never a rendered flag). */
  isEditorBusy: () => boolean;
  /** Parent's SYNCHRONOUS "this sheet is still the open one" check. */
  isCurrent: () => boolean;
  onUse: (draft: LocalMediaDraft) => void;
  onCancel: () => void;
  /** Reported when the recorder session opens, so the sheet can verify its own. */
  onSessionOpened?: (sessionId: string) => void;
};

export default function MediaRecorderOverlay({
  visible,
  kind,
  getIdentity,
  isEditorBusy,
  isCurrent,
  onUse,
  onCancel,
  onSessionOpened,
}: Props) {
  const mountedRef = useRef(true);

  /**
   * Authoritative attach decision. It reads the parent's SYNCHRONOUS sheet
   * identity and lock state (not rendered props), plus the live draft identity and
   * the recorder session/generation, so a render-lag window can never authorize a
   * transfer to a newer editor.
   */
  const authorize = useCallback(
    ({ captured, current }: AttachAuthorization): MediaFailure | null =>
      authorizeAttach({
        captured,
        current,
        live: getIdentity(),
        parentIsCurrent: isCurrent(),
        editorBusy: isEditorBusy(),
        mounted: mountedRef.current,
      }),
    [getIdentity, isCurrent, isEditorBusy],
  );

  const recorderOptions = useMemo(
    () => ({
      authorize,
      // The hook leases the session itself (synchronously at creation); the sheet
      // is only told which session it must expect on completion.
      onSessionOpened,
    }),
    [authorize, onSessionOpened],
  );

  const {
    snapshot,
    controller,
    cameraRefCallback,
    startAudio,
    openVideo,
    stop,
    cancel,
    openSettings,
    refreshPermission,
  } = useJournalRecorder(recorderOptions);
  const [facing, setFacing] = useState<CameraType>('front');
  const startedRef = useRef(false);

  // Detach: the hook's own cleanup invalidates the controller and releases the
  // current session lease; here only the mounted flag is cleared so a late
  // completion cannot transfer media.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Start the session exactly once per opening, after the explicit user action.
  useEffect(() => {
    if (!visible || startedRef.current) return;
    startedRef.current = true;
    if (kind === 'audio') void startAudio(getIdentity());
    else void openVideo(getIdentity());
  }, [getIdentity, kind, openVideo, startAudio, visible]);

  // Return from Settings: refresh permission WITHOUT prompting or recording.
  useEffect(() => {
    if (!visible) return undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshPermission();
    });
    return () => subscription.remove();
  }, [refreshPermission, visible]);

  const close = useCallback(() => {
    void cancel().then(() => onCancel());
  }, [cancel, onCancel]);

  const limits = limitsFor(kind);
  const recording = snapshot.state === 'recording' || snapshot.state === 'starting';
  const busy =
    snapshot.state === 'preparing' ||
    snapshot.state === 'requesting-permission' ||
    snapshot.state === 'validating-file' ||
    snapshot.state === 'adopting';
  const showCamera =
    kind === 'video' &&
    (snapshot.state === 'ready' || snapshot.state === 'recording' || snapshot.state === 'preparing');

  if (!visible) return null;

  // Hosted INSIDE the journal sheet modal (no stacked competing native modals).
  return (
    <View style={styles.root}>
      <View style={styles.fill}>
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <View style={styles.header}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть запись"
              onPress={close}
              style={styles.headerButton}
            >
              <Ionicons name="close" size={22} color={colors.textPrimary} />
            </Pressable>
            <AppText variant="section">{kind === 'audio' ? 'Аудио' : 'Видео'}</AppText>
            <View style={styles.headerButton}>
              {recording ? (
                <AppText variant="meta">
                  {`${formatDuration(snapshot.elapsedMs)} / ${formatDuration(limits.maxDurationMs)}`}
                </AppText>
              ) : null}
            </View>
          </View>

          {showCamera ? (
            <View style={styles.cameraWrap}>
              <CameraView
                ref={cameraRefCallback}
                style={styles.camera}
                facing={facing}
                mode="video"
                videoQuality={VIDEO_TARGET_QUALITY}
                videoBitrate={VIDEO_BITS_PER_SECOND}
              />
            </View>
          ) : (
            <View style={styles.centerArea}>
              <Ionicons
                name={kind === 'audio' ? 'mic-outline' : 'videocam-outline'}
                size={48}
                color={colors.textSecondary}
              />
              <AppText variant="body">
                {snapshot.state === 'preview'
                  ? 'Проверьте запись'
                  : recording
                    ? 'Идёт запись'
                    : snapshot.state === 'denied'
                      ? 'Нет доступа'
                      : 'Готово к записи'}
              </AppText>
              {snapshot.state === 'preview' && snapshot.take ? (
                <AppText variant="meta">
                  {`${formatDuration(snapshot.take.durationMs)} · ${formatFileSize(snapshot.take.sizeBytes)}`}
                </AppText>
              ) : null}
              {snapshot.state === 'preview' && snapshot.take ? (
                // Explicit preview of the UNCOMMITTED take (native temp file).
                <View style={styles.previewBox}>
                  {snapshot.take.kind === 'audio' ? (
                    <LocalAudioPlayer
                      source={{
                        uri: snapshot.take.uri,
                        mimeType: snapshot.take.mimeType,
                        kind: 'audio',
                      }}
                      active
                      onActivate={() => undefined}
                      onFinished={() => undefined}
                    />
                  ) : (
                    <LocalVideoPlayer
                      source={{
                        uri: snapshot.take.uri,
                        mimeType: snapshot.take.mimeType,
                        kind: 'video',
                      }}
                      active
                      onActivate={() => undefined}
                    />
                  )}
                </View>
              ) : null}
              {busy ? <AppText variant="meta">Подготовка…</AppText> : null}
            </View>
          )}

          {snapshot.error ? (
            <View style={styles.errorBox}>
              <AppText variant="meta">{snapshot.error.message}</AppText>
              <AppText variant="meta">
                {`Ограничение: ${formatDuration(limits.maxDurationMs)} или ${formatFileSize(
                  limits.maxSizeBytes,
                )}.`}
              </AppText>
              {snapshot.permission && !snapshot.permission.canAskAgain ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Открыть настройки устройства"
                  onPress={() => {
                    void openSettings();
                  }}
                  style={styles.secondaryButton}
                >
                  <AppText variant="meta">Открыть настройки</AppText>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <View style={styles.controls}>
            {snapshot.state === 'preview' ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Использовать запись"
                  onPress={() => {
                    void controller.useTake().then((outcome) => {
                      if (!outcome.ok) return;
                      // Guard against a stampede: the take may have become stale
                      // while adoption was in flight (sheet replaced, revision
                      // moved, session cancelled). Then it is cleaned, never attached.
                      const refused = authorize({
                        captured: outcome.draft.owner,
                        current: controller.getOwner(),
                      });
                      if (!mountedRef.current || refused !== null) {
                        void abandonStagedDrafts([outcome.draft]);
                        return;
                      }
                      onUse(outcome.draft);
                    });
                  }}
                  style={styles.primaryButton}
                >
                  <AppText variant="body" style={styles.primaryLabel}>
                    {kind === 'audio' ? 'Использовать аудио' : 'Использовать видео'}
                  </AppText>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Записать заново"
                  onPress={() => {
                    void controller.reRecord();
                  }}
                  style={styles.secondaryButton}
                >
                  <AppText variant="meta">Записать заново</AppText>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={recording ? 'Остановить запись' : 'Начать запись'}
                  disabled={busy || snapshot.state === 'denied' || snapshot.state === 'error'}
                  onPress={() => {
                    // ONE control: the next tap stops. No hold, no double tap.
                    if (recording) {
                      void stop();
                      return;
                    }
                    if (kind === 'audio') {
                      void startAudio(getIdentity());
                      return;
                    }
                    void controller.startVideoRecording();
                  }}
                  style={[styles.recordButton, recording ? styles.recordButtonActive : null]}
                >
                  <Ionicons
                    name={recording ? 'stop' : 'radio-button-on'}
                    size={30}
                    color={recording ? colors.background : colors.danger}
                  />
                </Pressable>
                {kind === 'video' && snapshot.state === 'ready' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Сменить камеру"
                    onPress={() => setFacing((current) => (current === 'front' ? 'back' : 'front'))}
                    style={styles.secondaryButton}
                  >
                    <Ionicons name="camera-reverse-outline" size={20} color={colors.textSecondary} />
                  </Pressable>
                ) : null}
                {snapshot.state === 'denied' || snapshot.state === 'error' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Повторить"
                    onPress={() => {
                      if (kind === 'audio') void startAudio(getIdentity());
                      else void openVideo(getIdentity());
                    }}
                    style={styles.secondaryButton}
                  >
                    <AppText variant="meta">Повторить</AppText>
                  </Pressable>
                ) : null}
              </>
            )}
          </View>
        </SafeAreaView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
    zIndex: 20,
  },
  fill: { flex: 1 },
  safe: { flex: 1, padding: spacing.md, gap: spacing.md },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerButton: {
    width: touchTarget,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraWrap: {
    flex: 1,
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  camera: { flex: 1 },
  previewBox: { alignSelf: 'stretch' },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  errorBox: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  recordButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  recordButtonActive: { backgroundColor: colors.danger },
  primaryButton: {
    minHeight: touchTarget,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.segment,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: { color: colors.background },
  secondaryButton: {
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    borderRadius: radius.segment,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
