/** A tap target is session UI state, never a Calendar mutation. */
export function createCalendarNotificationNavigation() {
  let intent: Readonly<{ token: number; eventId: string | null }> | null = null;
  let token = 0;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => intent,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    target(eventId: string | null) { intent = Object.freeze({ token: ++token, eventId }); publish(); },
    clear(current: number) { if (intent?.token === current) { intent = null; publish(); } },
  };
}
export const calendarNotificationNavigation = createCalendarNotificationNavigation();
export function resolveCalendarTap(intent: { eventId: string | null } | null, phase: string, sheetOpen: boolean,
  events: readonly { id: string; date: string }[]) {
  if (!intent || phase !== 'ready' || sheetOpen) return { consume: false as const };
  return { consume: true as const, event: events.find((event) => event.id === intent.eventId) ?? null };
}
