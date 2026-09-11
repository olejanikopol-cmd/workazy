/**
 * Expo binding for the Calendar notification contract.
 *
 * The ONLY module that imports expo-notifications. Maps Expo permission status
 * (including iOS provisional authorization) and pending inventory into the pure
 * contract types. Schedules with an explicit deterministic identifier and a
 * DATE trigger; never uses remote-token/push APIs.
 */
import * as Notifications from 'expo-notifications';
import { IosAuthorizationStatus } from 'expo-notifications';
import type { NotificationTrigger } from 'expo-notifications';
import {
  NOTIFICATION_OWNER,
  NOTIFICATION_TARGET_KEY,
  decodeTriggerEpochMs,
  decodeTriggerShape,
  type CalendarNotificationContract,
  type CalendarNotificationRequest,
  type NotificationPermissionStatus,
  type PendingNotification,
} from './calendarNotificationContract';

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

export const expoCalendarNotifications: CalendarNotificationContract = {
  async getPermissions(): Promise<NotificationPermissionStatus> {
    return mapPermission(await Notifications.getPermissionsAsync());
  },

  async requestPermissions(): Promise<NotificationPermissionStatus> {
    // Explicit user action requests alerts + sound; no badges, critical alerts
    // or provisional request.
    return mapPermission(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      }),
    );
  },

  async listPending(): Promise<PendingNotification[]> {
    const requests = await Notifications.getAllScheduledNotificationsAsync();
    return requests.map((request) => {
      const data = (request.content.data as Record<string, unknown> | null) ?? null;
      return {
        identifier: request.identifier,
        triggerAt: triggerEpochMs(request.trigger, data),
        triggerShape: decodeTriggerShape(request.trigger),
        data,
        contentTitle: request.content.title ?? '',
        contentBody: request.content.body ?? '',
      };
    });
  },

  async schedule(request: CalendarNotificationRequest): Promise<string> {
    return Notifications.scheduleNotificationAsync({
      identifier: request.id,
      content: {
        title: request.title,
        body: request.body,
        data: {
          owner: NOTIFICATION_OWNER,
          eventId: request.eventId,
          kind: request.kind,
          fingerprint: request.fingerprint,
          // The EXACT instant we asked the OS to fire at: persisted inside the
          // request so verification compares against our target rather than a
          // value re-derived from the (lossy, latency-dependent) native trigger.
          [NOTIFICATION_TARGET_KEY]: request.triggerAt,
          // iOS reads a one-shot date alert back as a time-interval trigger
          // measured from the schedule moment; this context lets the read-back
          // decode the absolute instant for display/legacy comparison.
          scheduledAt: new Date().getTime(),
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(request.triggerAt),
      },
    });
  },

  async cancel(id: string): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(id);
  },
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