import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCalendarLifecycle } from '@/features/calendar/useCalendarLifecycle';
import { colors } from '@/theme';

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.background,
    card: colors.surface,
    text: colors.textPrimary,
    border: colors.border,
    notification: colors.danger,
  },
};

/**
 * Root layout: dark navigation theme, light status bar, stack with default
 * headers hidden. The calendar lifecycle hook registers the foreground
 * notification handler and reconciles reminders without blocking navigation.
 */
export default function RootLayout() {
  useCalendarLifecycle();
  return (
    <ThemeProvider value={navigationTheme}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </ThemeProvider>
  );
}