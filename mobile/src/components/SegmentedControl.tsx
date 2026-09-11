import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';

type SegmentItem<T extends string> = {
  value: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  items: readonly SegmentItem<T>[];
  value: T;
  onChange: (value: T) => void;
};

/**
 * Accessible segmented control. Selection is communicated by background,
 * weight and color; hit targets are at least 44pt.
 */
export default function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <View accessibilityRole="tablist" style={styles.container}>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={item.label}
            onPress={() => onChange(item.value)}
            style={({ pressed }) => [
              styles.item,
              selected && styles.itemSelected,
              pressed && styles.itemPressed,
            ]}
          >
            <AppText
              variant="label"
              color={selected ? 'primary' : 'muted'}
              style={selected ? styles.labelSelected : undefined}
            >
              {item.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: spacing.xs,
    padding: 4,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.segment,
  },
  item: {
    flex: 1,
    minHeight: touchTarget,
    borderRadius: radius.item,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  itemSelected: {
    backgroundColor: colors.surfaceSelected,
  },
  itemPressed: {
    opacity: 0.72,
  },
  labelSelected: {
    fontWeight: '600',
  },
});