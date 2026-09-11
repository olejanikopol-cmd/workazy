import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { JournalEntry } from '@/types/journal';
import { formatJournalDate } from '../records/recordsDates';
import { entryDisplayTitle, entryMeta, entryPreview } from './journalSelectors';

type JournalEntryRowProps = {
  entry: JournalEntry;
  disabled: boolean;
  onPress: (entryId: string) => void;
};

/**
 * History row: date, optional title (display fallback only), body preview and
 * mood/tags/media meta. The preview is display-only — the reader renders the
 * real committed body.
 */
export default function JournalEntryRow({ entry, disabled, onPress }: JournalEntryRowProps) {
  const meta = entryMeta(entry);
  const preview = entryPreview(entry.body);
  // null = the stored date is outside the supported 0001-9999 contract (the
  // parser rejects those rows, so this is defensive); no date is invented.
  const dateLabel = formatJournalDate(entry.date);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Открыть запись ${entryDisplayTitle(entry, dateLabel ?? 'запись')}`}
      disabled={disabled}
      onPress={() => onPress(entry.id)}
      style={({ pressed }) => [styles.row, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <View style={styles.head}>
        {dateLabel !== null ? (
          <AppText variant="meta" color="muted">
            {dateLabel}
          </AppText>
        ) : null}
        {meta.length > 0 ? (
          <AppText variant="meta" color="accent" numberOfLines={1} style={styles.meta}>
            {meta}
          </AppText>
        ) : null}
      </View>
      {entry.title !== undefined && entry.title.trim().length > 0 ? (
        <AppText variant="label" numberOfLines={1}>
          {entry.title}
        </AppText>
      ) : null}
      {preview.length > 0 ? (
        <AppText variant="meta" color="secondary" numberOfLines={2}>
          {preview}
        </AppText>
      ) : (
        <AppText variant="meta" color="muted">
          Текст не заполнен.
        </AppText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: touchTarget,
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  meta: { flexShrink: 1 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
});
