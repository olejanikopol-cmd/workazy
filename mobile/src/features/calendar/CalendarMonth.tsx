import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import { dateIso, monthGrid, monthLabel } from './calendarDates';

type CalendarMonthProps = {
  year: number;
  month: number;
  selectedDate: string;
  today: string;
  eventsByDate: ReadonlySet<string>;
  onSelectDate: (iso: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
};

/**
 * Monday-first month grid. Blank cells are not actionable. Today and selected
 * are communicated by more than color alone (border + background + weight).
 * Seven day targets stay ≥44pt by reducing horizontal padding, not hit size.
 */
export default function CalendarMonth({
  year,
  month,
  selectedDate,
  today,
  eventsByDate,
  onSelectDate,
  onPrevMonth,
  onNextMonth,
  onToday,
}: CalendarMonthProps) {
  const grid = monthGrid(year, month);
  const label = monthLabel(year, month);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Предыдущий месяц"
          onPress={onPrevMonth}
          style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
        </Pressable>
        <AppText variant="label" style={styles.monthLabel}>
          {label}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Следующий месяц"
          onPress={onNextMonth}
          style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
        </Pressable>
      </View>

      <View style={styles.weekdays}>
        {grid.weekdays.map((day) => (
          <View key={day} style={styles.weekdayCell}>
            <AppText variant="meta" color="muted">
              {day}
            </AppText>
          </View>
        ))}
      </View>

      <View style={styles.grid}>
        {grid.cells.map((day, index) => {
          if (day === null) {
            return <View key={`blank-${index}`} style={styles.dayCell} />;
          }
          const iso = dateIso(year, month, day);
          const isSelected = iso === selectedDate;
          const isToday = iso === today;
          const hasEvents = eventsByDate.has(iso);
          return (
            <Pressable
              key={iso}
              accessibilityRole="button"
              accessibilityLabel={`${day} ${label}`}
              accessibilityState={{ selected: isSelected }}
              onPress={() => onSelectDate(iso)}
              style={({ pressed }) => [
                styles.dayCell,
                isToday && styles.todayCell,
                isSelected && styles.selectedCell,
                pressed && styles.pressed,
              ]}
            >
              <AppText
                variant="label"
                color={isSelected ? 'primary' : isToday ? 'accent' : 'secondary'}
                style={[styles.dayNumber, isToday && styles.todayNumber, isSelected && styles.selectedNumber]}
              >
                {day}
              </AppText>
              <View style={[styles.dot, hasEvents && styles.dotVisible]} />
            </Pressable>
          );
        })}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Вернуться к сегодняшнему дню"
        onPress={onToday}
        style={({ pressed }) => [styles.todayButton, pressed && styles.pressed]}
      >
        <AppText variant="label" color="accent">
          Сегодня
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.card,
    // Reduced padding keeps a 44pt hit height for the seven day columns on
    // compact iPhones (~375pt width): `screenPadding 20 * 2` + `padding 12 * 2`
    // leaves ~311pt/7 ≈ 44.4pt per column. Cells use a FIXED height target so
    // touch never drops below 44pt even on narrower screens.
    padding: spacing.md,
    gap: spacing.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  navButton: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.iconButton,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthLabel: {
    flex: 1,
    textAlign: 'center',
    textTransform: 'capitalize',
  },
  weekdays: {
    flexDirection: 'row',
  },
  weekdayCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.2857%',
    minHeight: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.item,
  },
  todayCell: {
    borderColor: colors.accent,
    borderWidth: 1,
  },
  selectedCell: {
    backgroundColor: colors.surfaceSelected,
  },
  dayNumber: {
    fontWeight: '500',
  },
  todayNumber: {
    fontWeight: '700',
  },
  selectedNumber: {
    fontWeight: '700',
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'transparent',
    marginTop: 2,
  },
  dotVisible: {
    backgroundColor: colors.accent,
  },
  todayButton: {
    alignSelf: 'center',
    minHeight: touchTarget,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  pressed: {
    opacity: 0.72,
  },
});