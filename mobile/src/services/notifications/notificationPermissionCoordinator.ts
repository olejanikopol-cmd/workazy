import type { NotificationPermissionStatus } from './localNotificationContract';
/** One explicit prompt flight. Reads started before a prompt cannot publish stale state. */
export function createNotificationPermissionCoordinator(port: {
  read(): Promise<NotificationPermissionStatus>;
  request(): Promise<NotificationPermissionStatus>;
}) {
  let flight: Promise<NotificationPermissionStatus> | null = null;
  let epoch = 0;
  let current: NotificationPermissionStatus | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async read(): Promise<NotificationPermissionStatus> {
      if (flight) return flight;
      const captured = epoch;
      const result = await port.read();
      if (captured !== epoch) return flight ?? current ?? result;
      current = result;
      return result;
    },
    request(): Promise<NotificationPermissionStatus> {
      if (flight) return flight;
      epoch++;
      flight = Promise.resolve().then(port.request).then((result) => {
        current = result;
        return result;
      }).finally(() => {
        flight = null;
        // Notify only after the prompt flight settles: listeners can safely reconcile.
        for (const listener of listeners) listener();
      });
      return flight;
    },
  };
}
