/** In-memory intent; notifications never mutate Finance domain data. */
let intent: { token: number; obligationId: string | null } | null = null;
let next = 0;
const listeners = new Set<() => void>();
export const financeNotificationNavigation = {
  getSnapshot: () => intent,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  target(obligationId: string | null) { intent = { token: ++next, obligationId }; for (const listener of listeners) listener(); },
  clear(token: number) { if (intent?.token !== token) return; intent = null; for (const listener of listeners) listener(); },
};
