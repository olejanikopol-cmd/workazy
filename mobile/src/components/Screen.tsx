import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { PropsWithChildren } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, screenPadding, spacing } from '@/theme';

type ScreenProps = PropsWithChildren<{
  /** Use a ScrollView so long content scrolls clear of the tab bar. */
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}>;

/**
 * Screen shell: dark background, content padding, top safe-area inset.
 * The tab navigator owns the bottom inset, so no double bottom padding here.
 */
export default function Screen({
  scroll = false,
  style,
  contentContainerStyle,
  children,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const topInset = insets.top + screenPadding;

  if (!scroll) {
    return (
      <View style={[styles.container, { paddingTop: topInset }, style]}>{children}</View>
    );
  }

  return (
    <ScrollView
      style={styles.flex}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingTop: topInset },
        contentContainerStyle,
      ]}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: screenPadding,
    paddingBottom: spacing.xxl,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: screenPadding,
    paddingBottom: spacing.xxl,
    backgroundColor: colors.background,
  },
});