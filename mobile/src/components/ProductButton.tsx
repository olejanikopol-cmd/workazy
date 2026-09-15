import { Pressable, StyleSheet } from 'react-native';
import AppText from './AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
export default function ProductButton({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress(): void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, (pressed || disabled) && styles.dim]}>
    <AppText variant="label" style={styles.text}>{label}</AppText>
  </Pressable>;
}
const styles = StyleSheet.create({
  button: { minHeight: touchTarget, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.input,
    backgroundColor: colors.surfaceSelected, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accentSoft, justifyContent: 'center' },
  secondary: { backgroundColor: colors.surface, borderColor: colors.border }, dim: { opacity: 0.6 }, text: { textAlign: 'center' },
});
