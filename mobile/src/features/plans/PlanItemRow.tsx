import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { PlanTask } from '@/types/plan';
import { rowNumber } from './planModel';

type PlanItemRowProps = {
  task: PlanTask;
  index: number;
  disabled: boolean;
  onToggle: (id: string) => void;
  onPressRead: (id: string) => void;
};

/**
 * One plan row. Checkbox and the text-reader target are distinct sibling
 * pressables (no nested nested pressables); the text preview truncates only on
 * the row, never in the reader. Completion communicates via checkbox state,
 * strikethrough and muted text — not color alone.
 */
export default function PlanItemRow({
  task,
  index,
  disabled,
  onToggle,
  onPressRead,
}: PlanItemRowProps) {
  return (
    <View style={[styles.row, task.completed && styles.rowCompleted]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: task.completed }}
        accessibilityLabel={
          task.completed ? `Вернуть пункт «${task.title}»` : `Выполнить пункт «${task.title}»`
        }
        disabled={disabled}
        onPress={() => onToggle(task.id)}
        style={({ pressed }) => [
          styles.check,
          task.completed && styles.checkChecked,
          pressed && styles.inputPressed,
        ]}
      >
        {task.completed && <Ionicons name="checkmark" size={16} color={colors.success} />}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть пункт «${task.title}»`}
        disabled={disabled}
        onPress={() => onPressRead(task.id)}
        style={({ pressed }) => [styles.body, pressed && styles.inputPressed]}
      >
        <AppText variant="meta" color="muted" style={styles.number}>
          {rowNumber(index)}
        </AppText>
        <AppText
          variant="body"
          color="secondary"
          numberOfLines={2}
          style={[styles.text, task.completed && styles.textCompleted]}
        >
          {task.title}
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.segment,
  },
  rowCompleted: {
    opacity: 0.82,
  },
  check: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.item,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.borderStrong,
    borderWidth: 1,
  },
  checkChecked: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.success,
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget,
    gap: spacing.md,
  },
  number: {
    width: 26,
  },
  text: {
    flex: 1,
  },
  textCompleted: {
    textDecorationLine: 'line-through',
    textDecorationColor: colors.textMuted,
  },
  inputPressed: {
    opacity: 0.7,
  },
});