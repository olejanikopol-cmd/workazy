import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { StyleSheet, type ColorValue } from 'react-native';
import { colors, radius, spacing, typography } from '@/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

function tabIcon(activeName: IoniconName, name: IoniconName) {
  return function TabBarIcon({
    color,
    focused,
  }: {
    color: ColorValue;
    focused: boolean;
    size: number;
  }) {
    return <Ionicons name={focused ? activeName : name} color={color} size={24} />;
  };
}

/**
 * Exactly four bottom tabs, in product order:
 * Планы / Календарь / Записи / Финансы.
 *
 * No `initialRouteName` is set: expo-router registers these routes as
 * `plans/index`, `calendar/index`, etc., and a short `"plans"` value would not
 * match any registered name. The first declared tab (Планы) is the navigator
 * default, and `app/index.tsx` redirects the cold launch to `/(tabs)/plans`.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarHideOnKeyboard: true,
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarItemStyle: styles.tabBarItem,
        tabBarStyle: styles.tabBar,
      }}
    >
      <Tabs.Screen
        name="plans"
        options={{ title: 'Планы', tabBarIcon: tabIcon('list', 'list-outline') }}
      />
      <Tabs.Screen
        name="calendar"
        options={{ title: 'Календарь', tabBarIcon: tabIcon('calendar', 'calendar-outline') }}
      />
      <Tabs.Screen
        name="records"
        options={{ title: 'Записи', tabBarIcon: tabIcon('book', 'book-outline') }}
      />
      <Tabs.Screen
        name="finance"
        options={{ title: 'Финансы', tabBarIcon: tabIcon('wallet', 'wallet-outline') }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: radius.segment,
    borderTopRightRadius: radius.segment,
  },
  tabBarLabel: {
    fontSize: typography.meta.fontSize,
    lineHeight: typography.meta.lineHeight,
    fontWeight: '500',
  },
  tabBarItem: {
    paddingVertical: spacing.xs,
  },
});