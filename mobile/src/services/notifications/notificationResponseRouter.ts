import { NOTIFICATION_OWNER, notificationId } from './calendarNotificationContract';
import { financeOwnership } from './financeNotificationContract';
import type { FinanceObligation } from '@/types/finance';
export type LocalNotificationResponse = {
  actionIdentifier: string;
  notification: { date: number; request: { identifier: string; content: { data?: Record<string, unknown> } } };
};
/** Owner dispatch; optional Calendar target support added in Slice 7. */
export function createNotificationResponseRouter(deps: {
  load(): Promise<void>;
  getState(): { phase: string; snapshot: { obligations: readonly FinanceObligation[] } };
  openFinance(id: string | null): void;
  calendar?: { load(): Promise<void>; getState(): { phase: string; events: readonly { id: string }[] }; open(id: string | null): void };
}) {
  const seen = new Set<string>();
  let latest = 0;
  return async (response: LocalNotificationResponse) => {
    const request = response.notification.request;
    const id = financeOwnership({ identifier: request.identifier, data: request.content.data ?? null });
    const data = request.content.data;
    const calendarId = deps.calendar && data?.owner === NOTIFICATION_OWNER && typeof data.eventId === 'string' && data.eventId &&
      (data.kind === 'start' || data.kind === 'advance') && request.identifier === notificationId(data.eventId, data.kind) ? data.eventId : null;
    if (id === null && calendarId === null) return;
    const key = JSON.stringify([request.identifier, response.notification.date, response.actionIdentifier]);
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 128) seen.delete(seen.values().next().value!);
    const generation = ++latest;
    if (calendarId !== null && deps.calendar) {
      await deps.calendar.load();
      if (generation !== latest) return;
      const calendar = deps.calendar.getState();
      deps.calendar.open(calendar.phase === 'ready' && calendar.events.some((event) => event.id === calendarId) ? calendarId : null);
      return;
    }
    await deps.load();
    if (generation !== latest) return;
    const state = deps.getState();
    const live = state.phase === 'ready' && state.snapshot.obligations.some((r) => r.id === id);
    deps.openFinance(live ? id : null);
  };
}
