import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AppText from '@/components/AppText';
import ProductButton from '@/components/ProductButton';
import { colors, spacing } from '@/theme';
import { onboardingPages } from './productContent';
import { onboardingVisible } from './onboardingStore';
import { onboardingStore } from './productRuntime';
export default function OnboardingGate() {
  const state = useSyncExternalStore(onboardingStore.subscribe, onboardingStore.getSnapshot);
  useEffect(() => { void onboardingStore.load(); }, []);
  const visible = onboardingVisible(state);
  if (!visible) return null;
  return <Modal animationType="fade" presentationStyle="fullScreen" onRequestClose={() => { if (state.replay) void onboardingStore.finish(); }}>
    <SafeAreaView style={styles.safe}>
      {state.replay ? <Pages saving={false} error={null} replay /> : state.phase === 'loading' ? <View style={styles.loading}><ActivityIndicator color={colors.accent} /><AppText>Открываем Workazy…</AppText></View>
        : state.phase === 'load-error' ? <ScrollView contentContainerStyle={styles.content}><AppText accessibilityRole="alert">{state.error}</AppText><ProductButton label="Повторить" onPress={() => void onboardingStore.load()} /><ProductButton label="Продолжить без сохранения настройки" secondary onPress={() => onboardingStore.dismissError()} /></ScrollView>
          : <Pages saving={state.saving} error={state.error} replay={state.replay} />}
    </SafeAreaView>
  </Modal>;
}
function Pages({ saving, error, replay }: { saving: boolean; error: string | null; replay: boolean }) {
  const [index, setIndex] = useState(0);
  const page = onboardingPages[index];
  const last = index === onboardingPages.length - 1;
  return <ScrollView contentContainerStyle={styles.content}>
    <AppText variant="label" color="accent">Workazy</AppText>
    <AppText accessibilityLiveRegion="polite" variant="meta" color="muted">{index + 1} из {onboardingPages.length}</AppText>
    <View style={styles.copy}>
      <Ionicons name={page.icon} size={36} color={colors.accent} accessible={false} />
      <AppText variant="section" accessibilityRole="header">{page.title}</AppText>
      <AppText color="secondary">{page.body}</AppText>
    </View>
    {error ? <AppText accessibilityRole="alert" color="danger">{error}</AppText> : null}
    <ProductButton label={saving ? 'Сохраняем…' : last ? replay ? 'Готово' : 'Начать' : 'Продолжить'} disabled={saving}
      onPress={() => { if (last) void onboardingStore.finish(); else setIndex(index + 1); }} />
    {index > 0 ? <ProductButton label="Назад" secondary disabled={saving} onPress={() => setIndex(index - 1)} /> : null}
    {!last ? <ProductButton label={replay ? 'Закрыть' : 'Пропустить'} secondary disabled={saving} onPress={() => void onboardingStore.finish()} /> : null}
  </ScrollView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, padding: spacing.xl, gap: spacing.lg }, copy: { flexGrow: 1, justifyContent: 'center', gap: spacing.lg, paddingVertical: spacing.xl },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.lg },
});
