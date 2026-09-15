import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';
import { colors, radius, touchTarget } from '@/theme';
import { SETTINGS_ROUTE } from './productContent';
export default function SettingsButton() {
  return <Pressable accessibilityRole="button" accessibilityLabel="Настройки" onPress={() => router.navigate(SETTINGS_ROUTE)}
    style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]}>
    <Ionicons name="settings-outline" size={24} color={colors.textSecondary} accessible={false} />
  </Pressable>;
}
const styles = StyleSheet.create({ button: { minWidth: touchTarget, minHeight: touchTarget, alignItems: 'center', justifyContent: 'center',
  borderRadius: radius.iconButton, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border } });
