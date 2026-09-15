import { Alert, Pressable, StyleSheet } from 'react-native';
import AppText from './AppText';
import { spacing, touchTarget } from '@/theme';
/** Captures the caller's existing revision-guarded command; no domain mutation here. */
export default function ConfirmDeleteButton({ label = 'Удалить', description, onConfirm }: {
  label?: string; description: string; onConfirm(): void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} style={styles.button} onPress={() => {
    let confirmed = false;
    Alert.alert('Удалить запись?', description, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => { if (!confirmed) { confirmed = true; onConfirm(); } } },
    ]);
  }}>
    <AppText variant="meta" color="danger">{label}</AppText>
  </Pressable>;
}
const styles = StyleSheet.create({ button: { minHeight: touchTarget, minWidth: touchTarget,
  justifyContent: 'center', paddingVertical: spacing.sm } });
