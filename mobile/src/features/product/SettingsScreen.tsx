import { useCallback, useSyncExternalStore } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';
import Screen from '@/components/Screen';
import Card from '@/components/Card';
import AppText from '@/components/AppText';
import ProductButton from '@/components/ProductButton';
import { spacing } from '@/theme';
import { notificationPermissions } from '@/services/notifications/expoLocalNotifications';
import { createSettingsController, permissionLabel } from './settingsController';
import { onboardingStore } from './productRuntime';
import { privacyParagraphs } from './productContent';
const controller = createSettingsController({ read: notificationPermissions.read, request: notificationPermissions.request,
  openSettings: () => Linking.openSettings() });
export default function SettingsScreen() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useFocusEffect(useCallback(() => {
    void controller.refresh();
    const appState = AppState.addEventListener('change', (next) => { if (next === 'active') void controller.refresh(); });
    const stop = notificationPermissions.subscribe(() => void controller.refresh());
    return () => { appState.remove(); stop(); };
  }, []));
  const denied = state.permission && !state.permission.granted && !state.permission.canAskAgain;
  const version = Constants.expoConfig?.version;
  const build = Constants.nativeBuildVersion;
  return <SafeAreaView style={styles.flex} edges={['bottom', 'left', 'right']}><Screen scroll contentContainerStyle={styles.content}>
    <ProductButton label="Назад" secondary onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/plans'); }} />
    <AppText variant="pageTitle" accessibilityRole="header">Настройки</AppText>
    <Card style={styles.card}>
      <AppText variant="section" accessibilityRole="header">Уведомления</AppText>
      <AppText accessibilityLiveRegion="polite">{state.busy ? 'Проверяем разрешение…' : permissionLabel(state.permission)}</AppText>
      <AppText color="secondary">Напоминания настраиваются в календаре и обязательствах. Разрешение само по себе не означает, что напоминание запланировано.</AppText>
      {state.error ? <AppText color="danger" accessibilityRole="alert">{state.error}</AppText> : null}
      {denied ? <ProductButton label="Открыть настройки устройства" onPress={() => void controller.openSettings()} />
        : state.permission && !state.permission.granted ? <ProductButton label="Разрешить уведомления" disabled={state.busy} onPress={() => void controller.request()} /> : null}
      <ProductButton label={state.error ? 'Повторить проверку' : 'Обновить статус'} secondary disabled={state.busy} onPress={() => void controller.refresh()} />
    </Card>
    <Card style={styles.card}>
      <AppText variant="section" accessibilityRole="header">Помощь</AppText>
      <ProductButton label="Знакомство с Workazy" secondary onPress={() => onboardingStore.replay()} />
      <AppText variant="section" accessibilityRole="header">О Workazy</AppText>
      <AppText color="secondary">Личный планер для дел, записей и финансов. Начните с одного пункта плана или записи в дневнике.</AppText>
      {version ? <AppText variant="meta" color="muted">Версия {version}{build ? ` · Сборка ${build}` : ''}</AppText> : null}
    </Card>
    <Card style={styles.card}>
      <AppText variant="section" accessibilityRole="header">Ваши данные</AppText>
      {privacyParagraphs.map((text) => <AppText color="secondary" key={text}>{text}</AppText>)}
    </Card>
    <View />
  </Screen></SafeAreaView>;
}
const styles = StyleSheet.create({ flex: { flex: 1 }, content: { gap: spacing.lg }, card: { gap: spacing.md } });
