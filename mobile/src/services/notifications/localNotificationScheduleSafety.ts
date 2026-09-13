/** Domain-neutral safety inside an already-held full-pass reconciliation queue.
 * Inventory is authoritative, including foreign requests. A rejected native call
 * may have inserted its request: never allocate again until a successful re-list.
 * Ownership, planning, persistence and trigger matching belong to the caller.
 */
export const DEFAULT_MAX_PENDING = 48;

export type ScheduleOutcome =
  | 'verified'
  | 'schedule-error'
  | 'verification-error'
  | 'inventory-error'
  | 'capacity'
  | 'aborted';

export function createLocalNotificationScheduleSafety<
  Request extends { id: string },
  Pending extends { identifier: string },
>(input: {
  pending: readonly Pending[];
  maxPending?: number;
  listPending(): Promise<Pending[]>;
  schedule(request: Request): Promise<string>;
  matches(pending: Pending, request: Request): boolean;
  shouldAbort(): boolean;
}) {
  let pending = [...input.pending];
  let blocked = false;
  let inFlight = false;
  // A successful call consumes capacity even before the readback resolves.
  let reserved = 0;
  const maxPending = input.maxPending ?? DEFAULT_MAX_PENDING;

  return {
    find(id: string): Pending | undefined {
      return pending.find((item) => item.identifier === id);
    },
    hasCapacity(): boolean {
      return !blocked && !inFlight && pending.length + reserved < maxPending;
    },
    async schedule(request: Request): Promise<ScheduleOutcome> {
      if (input.shouldAbort()) return 'aborted';
      if (blocked || inFlight) return 'inventory-error';
      if (pending.length + reserved >= maxPending) return 'capacity';
      inFlight = true;
      try {
        let failed = false;
        let returned: string | undefined;
        try {
          returned = await input.schedule(request);
          reserved += 1;
        } catch {
          failed = true;
        }
        // No scheduling may resume until this read establishes actual occupancy,
        // regardless of success, rejection, wrong ID, or an apparent early throw.
        blocked = true;
        try {
          pending = await input.listPending();
          reserved = 0;
          blocked = false;
        } catch {
          return input.shouldAbort() ? 'aborted' : 'inventory-error';
        }
        if (input.shouldAbort()) return 'aborted';
        const actual = pending.find((item) => item.identifier === request.id);
        const verified = actual !== undefined && input.matches(actual, request);
        // Recovery determines reality but does not erase the native call error.
        if (failed) return 'schedule-error';
        if (returned !== request.id || !verified) return 'verification-error';
        return 'verified';
      } finally {
        inFlight = false;
      }
    },
  };
}
