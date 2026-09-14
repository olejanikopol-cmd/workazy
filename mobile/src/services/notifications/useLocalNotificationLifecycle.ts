import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { router, useRootNavigationState } from 'expo-router';
import { calendarNotificationController } from '@/features/calendar/useCalendarLifecycle';
import { calendarStore } from '@/features/calendar/useCalendarStore';
import { financeStore } from '@/features/finance/useFinanceStore';
import { financeNotificationController } from './financeNotificationRuntime';
import { notificationPermissions, notificationResponses, registerForegroundNotificationHandler } from './expoLocalNotifications';
import { createNotificationResponseRouter, type LocalNotificationResponse } from './notificationResponseRouter';
import { financeNotificationNavigation } from './financeNotificationNavigation';
export function useLocalNotificationLifecycle() {
  const navigation = useRootNavigationState();
  const ready = useRef(false);
  const pending = useRef<string | null | undefined>(undefined);
  const open = useCallback((id: string | null) => {
    if (!ready.current) { pending.current = id; return; }
    financeNotificationNavigation.target(id);
    router.navigate('/(tabs)/finance');
  }, []);
  useEffect(() => {
    ready.current = Boolean(navigation?.key);
    if (navigation?.key && pending.current !== undefined) {
      const id = pending.current; pending.current = undefined; open(id);
    }
  }, [navigation?.key, open]);
  useEffect(() => {
    let alive = true;
    registerForegroundNotificationHandler();
    const dispatch = createNotificationResponseRouter({ load: financeStore.load, getState: financeStore.getSnapshot,
      openFinance: (id) => { if (alive) open(id); } });
    let receivedLive = false;
    const receive = (r: LocalNotificationResponse) => {
      if (alive) void dispatch(r).then(() => {
        if (alive) return notificationResponses.clear();
      }).catch(() => undefined);
    };
    const responses = notificationResponses.subscribe((r) => { receivedLive = true; receive(r); });
    // A delayed cold-start read must not overwrite a newer live response.
    void notificationResponses.last().then((r) => { if (r && !receivedLive) receive(r); }).catch(() => undefined);
    calendarNotificationController.setAppState(AppState.currentState);
    void calendarStore.load().then(() => { if (alive) calendarNotificationController.start(); });
    const stopFinance = financeNotificationController.start();
    const refresh = () => { void calendarNotificationController.refreshPermission(); void calendarNotificationController.requestReconcile(); void financeNotificationController.request(); };
    const stopPermissions = notificationPermissions.subscribe(refresh);
    const appState = AppState.addEventListener('change', (next) => {
      calendarNotificationController.setAppState(next);
      if (next === 'active') void financeNotificationController.request();
    });
    const interval = setInterval(() => {
      calendarNotificationController.handlePeriodicTick();
      if (AppState.currentState === 'active') void financeNotificationController.request();
    }, 60_000);
    return () => { alive = false; stopFinance(); stopPermissions(); responses.remove(); appState.remove(); clearInterval(interval); };
  }, [open]);
}
