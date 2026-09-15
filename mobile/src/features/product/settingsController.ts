import type { NotificationPermissionStatus } from '@/services/notifications/localNotificationContract';
export type SettingsState = Readonly<{ permission: NotificationPermissionStatus | null; busy: boolean; error: string | null }>;
export function permissionLabel(permission: NotificationPermissionStatus | null) {
  if (!permission) return 'Статус пока неизвестен';
  if (permission.provisional) return 'Разрешена тихая доставка';
  if (permission.granted) return 'Уведомления разрешены';
  return permission.status === 'denied' || !permission.canAskAgain ? 'Уведомления выключены в настройках' : 'Разрешение ещё не запрошено';
}
export function createSettingsController(port: {
  read(): Promise<NotificationPermissionStatus>; request(): Promise<NotificationPermissionStatus>; openSettings(): Promise<void>;
}) {
  let state: SettingsState = Object.freeze({ permission: null, busy: false, error: null });
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<SettingsState>) => { state = Object.freeze({ ...state, ...patch }); for (const fn of listeners) fn(); };
  async function run(operation: () => Promise<NotificationPermissionStatus>) {
    const current = ++generation;
    publish({ busy: true, error: null });
    try { const permission = await operation(); if (generation === current) publish({ permission, busy: false }); }
    catch { if (generation === current) publish({ permission: null, busy: false, error: 'Не удалось проверить разрешение. Повторите попытку.' }); }
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh: () => run(port.read),
    request: () => run(port.request),
    async openSettings() {
      try { await port.openSettings(); }
      catch { publish({ error: 'Не удалось открыть настройки. Откройте их на устройстве и выберите Workazy.' }); }
    },
  };
}
