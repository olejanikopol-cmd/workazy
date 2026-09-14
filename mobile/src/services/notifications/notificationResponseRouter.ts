import { financeOwnership } from './financeNotificationContract';
import type { FinanceObligation } from '@/types/finance';
export type LocalNotificationResponse = {
  actionIdentifier: string;
  notification: { date: number; request: { identifier: string; content: { data?: Record<string, unknown> } } };
};
/** Owner dispatch; Calendar keeps its existing default app-opening behavior. */
export function createNotificationResponseRouter(deps: {
  load(): Promise<void>;
  getState(): { phase: string; snapshot: { obligations: readonly FinanceObligation[] } };
  openFinance(id: string | null): void;
}) {
  const seen = new Set<string>();
  let latest = 0;
  return async (response: LocalNotificationResponse) => {
    const request = response.notification.request;
    const id = financeOwnership({ identifier: request.identifier, data: request.content.data ?? null });
    if (id === null) return;
    const key = JSON.stringify([request.identifier, response.notification.date, response.actionIdentifier]);
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 128) seen.delete(seen.values().next().value!);
    const generation = ++latest;
    await deps.load();
    if (generation !== latest) return;
    const state = deps.getState();
    const live = state.phase === 'ready' && state.snapshot.obligations.some((r) => r.id === id);
    deps.openFinance(live ? id : null);
  };
}
