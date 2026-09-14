import { Linking, View } from 'react-native';
import AppText from '@/components/AppText';
import { spacing } from '@/theme';
import type { FinanceNotificationState } from './financeNotificationController';
import { ActionButton } from './FinanceSections';
import { financeNotificationController } from './useFinanceNotifications';
export default function FinanceNotificationStatus({ state }: { state: FinanceNotificationState }) {
  const permission = state.permission;
  return <View style={{ gap: spacing.sm }}>
    {state.status === 'error' ? <>
      <AppText variant="meta" color="danger">Данные финансов сохранены. Не удалось обновить напоминания. Предыдущее напоминание может оставаться включённым.</AppText>
      <ActionButton label="Повторить проверку напоминаний" onPress={() => void financeNotificationController.retry()} />
    </> : null}
    {permission?.status === 'denied' || (permission && !permission.granted && !permission.canAskAgain) ? <>
      <AppText variant="meta" color="muted">Уведомления выключены в настройках устройства.</AppText>
      <ActionButton label="Открыть настройки уведомлений" onPress={() => { void Linking.openSettings().catch(() => undefined); }} />
    </> : !permission?.granted ? <ActionButton label="Включить уведомления" onPress={() => void financeNotificationController.requestPermission()} /> : null}
    {permission?.provisional ? <AppText variant="meta" color="muted">Разрешена тихая доставка уведомлений.</AppText> : null}
    {Object.values(state.rows).some((row) => row.status === 'capacity') ? <>
      <AppText variant="meta" color="muted">Не все напоминания запланированы: нет свободного места. Проверим снова при открытии приложения.</AppText>
      <ActionButton label="Проверить свободное место" onPress={() => void financeNotificationController.request()} />
    </> : null}
  </View>;
}
