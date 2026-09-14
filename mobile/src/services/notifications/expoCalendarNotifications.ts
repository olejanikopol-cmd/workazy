/** Compatible Calendar facade over the single shared Expo boundary. */
import { expoLocalNotifications } from './expoLocalNotifications';
import { NOTIFICATION_OWNER, type CalendarNotificationContract } from './calendarNotificationContract';
export { registerForegroundNotificationHandler } from './expoLocalNotifications';
export const expoCalendarNotifications: CalendarNotificationContract = {
  getPermissions: expoLocalNotifications.getPermissions,
  requestPermissions: expoLocalNotifications.requestPermissions,
  listPending: expoLocalNotifications.listPending,
  cancel: expoLocalNotifications.cancel,
  schedule: (request) => expoLocalNotifications.schedule({ ...request, data: {
    owner: NOTIFICATION_OWNER, eventId: request.eventId, kind: request.kind,
    fingerprint: request.fingerprint, targetTriggerAt: request.triggerAt,
  } }),
};
