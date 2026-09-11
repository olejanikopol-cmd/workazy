import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { Idea } from '@/types/idea';
import { IDEA_CATEGORY_LABELS, IDEA_STATUS_LABELS } from './ideaModel';

type IdeaRowProps = {
  idea: Idea;
  disabled: boolean;
  onPress: (ideaId: string) => void;
};

/** Idea row: title, optional description preview, category + status badges. */
export default function IdeaRow({ idea, disabled, onPress }: IdeaRowProps) {
  const description = idea.description?.trim() ?? '';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Открыть идею «${idea.title}»`}
      disabled={disabled}
      onPress={() => onPress(idea.id)}
      style={({ pressed }) => [styles.row, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <View style={styles.badgeRow}>
        <View style={styles.badge}>
          <AppText variant="meta" color="accent">
            {IDEA_CATEGORY_LABELS[idea.category]}
          </AppText>
        </View>
        <View style={styles.badge}>
          <AppText variant="meta" color="secondary">
            {IDEA_STATUS_LABELS[idea.status]}
          </AppText>
        </View>
      </View>
      <AppText variant="label" numberOfLines={2}>
        {idea.title}
      </AppText>
      {description.length > 0 ? (
        <AppText variant="meta" color="secondary" numberOfLines={2}>
          {description}
        </AppText>
      ) : null}
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
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 999,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
});
