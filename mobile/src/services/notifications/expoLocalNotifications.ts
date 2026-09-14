/** Sole Expo notification boundary. Domain facades supply ownership payloads. */
import * as Notifications from 'expo-notifications';
import { IosAuthorizationStatus } from 'expo-notifications';
import type { NotificationTrigger } from 'expo-notifications';
import { decodeTriggerEpochMs, decodeTriggerShape, type NotificationPermissionStatus,
  type PendingNotification, type LocalNotificationOS } from './localNotificationContract';
import { createNotificationPermissionCoordinator } from './notificationPermissionCoordinator';

function mapPermission(
  status: Notifications.NotificationPermissionsStatus,
): NotificationPermissionStatus {
  const ios = status.ios;
  if (ios) {
    if (ios.status === IosAuthorizationStatus.AUTHORIZED) {
      return { granted: true, provisional: false, canAskAgain: true, status: 'granted' };
    }
    if (ios.status === IosAuthorizationStatus.PROVISIONAL) {
      return { granted: true, provisional: true, canAskAgain: true, status: 'provisional' };
    }
    if (ios.status === IosAuthorizationStatus.EPHEMERAL) {
      return { granted: true, provisional: false, canAskAgain: true, status: 'ephemeral' };
    }
    if (ios.status === IosAuthorizationStatus.DENIED) {
      return { granted: false, provisional: false, canAskAgain: false, status: 'denied' };
    }
    return { granted: false, provisional: false, canAskAgain: true, status: 'undetermined' };
  }
  // Android / fallback: generic granted flag.
  return {
    granted: status.granted,
    provisional: false,
    canAskAgain: status.canAskAgain,
    status: status.granted ? 'granted' : status.canAskAgain ? 'undetermined' : 'denied',
  };
}

function triggerEpochMs(
  trigger: NotificationTrigger,
  data: Record<string, unknown> | null,
): number | null {
  // Tolerant decode of every shape returned by the installed SDK: JS
  // `{ type: 'date', date: Date }`, native `{ type: 'date', timestamp }` and
  // iOS `{ type: 'timeInterval', seconds, repeats }` for one-shot date alerts.
  // The timeInterval shape has no absolute instant on its own, so the schedule
  // context recorded in `data.scheduledAt` is required; it is always present
  // for requests this module scheduled.
  const scheduledAt =
    data && typeof data.scheduledAt === 'number' ? (data.scheduledAt as number) : undefined;
  return decodeTriggerEpochMs(trigger, scheduledAt);
}

const permissions = createNotificationPermissionCoordinator({
  read: async () => mapPermission(await Notifications.getPermissionsAsync()),
  request: async () => mapPermission(await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  })),
});
export const notificationPermissions = permissions;
export const expoLocalNotifications: LocalNotificationOS = {
  getPermissions: permissions.read,
  requestPermissions: permissions.request,
  async listPending(): Promise<PendingNotification[]> {
    const requests = await Notifications.getAllScheduledNotificationsAsync();
    return requests.map((request) => {
      const data = (request.content.data as Record<string, unknown> | null) ?? null;
      const trigger = request.trigger as unknown as { repeats?: boolean } | null;
      return { identifier: request.identifier, triggerAt: triggerEpochMs(request.trigger, data),
        triggerShape: decodeTriggerShape(request.trigger), data,
        contentTitle: request.content.title ?? '', contentBody: request.content.body ?? '',
        ...(typeof trigger?.repeats === 'boolean' ? { repeats: trigger.repeats } : {}),
      };
    });
  },
  async schedule(request) {
    return Notifications.scheduleNotificationAsync({ identifier: request.id,
      content: { title: request.title, body: request.body,
        data: { ...request.data, scheduledAt: new Date().getTime() } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(request.triggerAt) },
    });
  },
  async cancel(id) { await Notifications.cancelScheduledNotificationAsync(id); },
};

/** Register the foreground presentation handler once (root layout). */
export function registerForegroundNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}
export const notificationResponses = {
  subscribe: Notifications.addNotificationResponseReceivedListener,
  last: Notifications.getLastNotificationResponseAsync,
  clear: Notifications.clearLastNotificationResponseAsync,
};
