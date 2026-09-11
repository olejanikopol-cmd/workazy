import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { CalendarEvent } from '@/types/calendar';
import { formatEventTime } from './calendarDates';
import { reminderLabel } from './calendarModel';

type CalendarEventRowProps = {
  event: CalendarEvent;
  disabled: boolean;
  onPress: (id: string) => void;
};

/** One agenda row: time, title, reminder label; tap opens the read sheet. */
export default function CalendarEventRow({ event, disabled, onPress }: CalendarEventRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Событие «${event.title}»`}
      disabled={disabled}
      onPress={() => onPress(event.id)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.timeColumn}>
        <AppText variant="label" color="secondary" style={styles.time}>
          {formatEventTime(event.time)}
        </AppText>
      </View>
      <View style={styles.body}>
        <AppText variant="body" numberOfLines={2} style={styles.title}>
          {event.title}
        </AppText>
        <AppText variant="meta" color="muted">
          {reminderLabel(event.reminder)}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget + spacing.sm,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.segment,
  },
  timeColumn: {
    width: 56,
  },
  time: {
    fontVariant: ['tabular-nums'],
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontWeight: '500',
  },
  pressed: {
    opacity: 0.72,
  },
});