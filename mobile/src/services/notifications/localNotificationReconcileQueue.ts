/** Serializes complete OS reconciliation passes, never individual native calls.
 * Jobs must not acquire this queue recursively. A rejection releases the queue;
 * an unresolved native operation does not. Domain stores remain independent.
 */
export function createLocalNotificationReconcileQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(pass: () => Promise<T>): Promise<T> {
      const result = tail.then(pass);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/** One process-level instance shared by all production notification domains. */
export const localNotificationReconcileQueue = createLocalNotificationReconcileQueue();
