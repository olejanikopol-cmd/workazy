import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useLocalNotificationLifecycle } from '@/services/notifications/useLocalNotificationLifecycle';
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
 * headers hidden. The shared lifecycle registers the foreground
 * notification handler and reconciles both domains without blocking navigation.
 */
export default function RootLayout() {
  useLocalNotificationLifecycle();
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