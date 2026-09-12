/**
 * Attachment card for one journal media item.
 *
 * Committed items show real local availability («На устройстве»), duration/size
 * and a real player. A missing file or remote-only metadata shows
 * «Файл недоступен на этом устройстве» with retry and a CONFIRMED local removal
 * (metadata removal is committed before any file is deleted). Staged (uncommitted)
 * takes show that they will be saved with the entry.
 */
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { JournalMedia } from '@/types/journal';
import { useState } from 'react';
import { formatDuration, formatFileSize } from '@/services/media/mediaLimits';
import {
  TRANSCRIPT_PREVIEW_CHARS,
  describeTranscript,
} from '@/services/media/attachmentPresentation';
import { LocalAudioPlayer, LocalVideoPlayer, useLocalMediaSource } from './MediaPlayers';

export type StagedAttachment = {
  id: string;
  kind: 'audio' | 'video';
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
};

type Props = {
  kind: 'audio' | 'video';
  media: JournalMedia | StagedAttachment;
  /** Staged takes are not committed; availability is still local. */
  staged?: boolean;
  active: boolean;
  onActivate: () => void;
  onFinished: () => void;
  onRemove: () => void;
};

function isCommitted(media: JournalMedia | StagedAttachment): media is JournalMedia {
  return 'journalEntryId' in media;
}

export default function MediaAttachmentCard({
  kind,
  media,
  staged = false,
  active,
  onActivate,
  onFinished,
  onRemove,
}: Props) {
  const committed = !staged && isCommitted(media);
  // Staged takes have no durable object yet: never resolve one for them.
  const { resolved, retry, attempt } = useLocalMediaSource(committed ? media : null);
  const transcript = committed
    ? describeTranscript(media)
    : { text: null, note: null, collapsible: false };
  const [expandedTranscript, setExpandedTranscript] = useState(false);
  const durationMs = media.durationMs ?? null;
  const label =
    kind === 'audio'
      ? `Аудио ${formatDuration(durationMs) || ''}`.trim()
      : `Видео ${formatDuration(durationMs) || ''}`.trim();


  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons
          name={kind === 'audio' ? 'mic-outline' : 'videocam-outline'}
          size={18}
          color={colors.textSecondary}
        />
        <View style={styles.headerText}>
          <AppText variant="body">{label}</AppText>
          <AppText variant="meta">
            {[formatFileSize(media.sizeBytes), staged ? 'Готово к сохранению' : 'На устройстве']
              .filter((part) => part.length > 0)
              .join(' · ')}
          </AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={staged ? 'Убрать вложение' : 'Удалить вложение'}
          onPress={onRemove}
          style={styles.iconButton}
        >
          <Ionicons name="trash-outline" size={18} color={colors.textSecondary} />
        </Pressable>
      </View>

      {!staged && resolved.state === 'loading' ? (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.textSecondary} />
          <AppText variant="meta">Проверяем файл…</AppText>
        </View>
      ) : null}

      {!staged && resolved.state === 'unavailable' ? (
        <View style={styles.statusColumn}>
          <AppText variant="meta">{resolved.message}</AppText>
          <View style={styles.statusRow}>
            <Pressable accessibilityRole="button" onPress={retry} style={styles.smallButton}>
              <AppText variant="meta">Повторить</AppText>
            </Pressable>
          </View>
        </View>
      ) : null}

      {!staged && resolved.state === 'ready' && kind === 'audio' ? (
        <LocalAudioPlayer
          key={`audio:${resolved.source.uri}:${attempt}`}
          source={resolved.source}
          active={active}
          onActivate={onActivate}
          onFinished={onFinished}
          onRetry={retry}
        />
      ) : null}

      {!staged && resolved.state === 'ready' && kind === 'video' ? (
        <LocalVideoPlayer
          key={`video:${resolved.source.uri}:${attempt}`}
          source={resolved.source}
          active={active}
          onActivate={onActivate}
          onFinished={onFinished}
          onRetry={retry}
        />
      ) : null}

      {staged ? (
        <AppText variant="meta">Файл уже на устройстве — сохранится вместе с записью.</AppText>
      ) : null}

      {transcript.text !== null ? (
        <View style={styles.transcriptBox}>
          <AppText variant="meta" color="muted">
            Расшифровка
          </AppText>
          <AppText variant="meta" selectable>
            {expandedTranscript || !transcript.collapsible
              ? transcript.text
              : `${transcript.text.slice(0, TRANSCRIPT_PREVIEW_CHARS).trimEnd()}…`}
          </AppText>
          {transcript.collapsible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                expandedTranscript ? 'Свернуть расшифровку' : 'Показать расшифровку полностью'
              }
              onPress={() => setExpandedTranscript((current) => !current)}
              style={styles.smallButton}
            >
              <AppText variant="meta">{expandedTranscript ? 'Свернуть' : 'Показать полностью'}</AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {transcript.note !== null ? <AppText variant="meta">{transcript.note}</AppText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  iconButton: {
    width: touchTarget,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  transcriptBox: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.item,
    backgroundColor: colors.surfaceElevated,
  },
  statusColumn: {
    gap: spacing.xs,
  },
  smallButton: {
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.segment,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
