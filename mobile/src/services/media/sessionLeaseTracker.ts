/**
 * Session-lease bookkeeping for a recorder surface.
 *
 * A recorder session is leased SYNCHRONOUSLY at the moment its identity is
 * created (before any native await), and the previous session is released before
 * the new one is leased. That guarantees:
 * - a live session's staging directory is protected from sweeps from its first
 *   instant, not after an awaited startup;
 * - re-records, permission retries, recorder restarts and kind switches never
 *   accumulate leases;
 * - a stale asynchronous startup completion cannot re-register an obsolete
 *   session, because registration never happens on an awaited path;
 * - closing the surface releases exactly the session that was current.
 */
export type SessionLeaseTracker = {
  /** Leases `sessionId`; releases the previously leased session first. */
  opened(sessionId: string): void;
  /** Releases whichever session is current (idempotent). */
  closed(): void;
  current(): string | null;
};

export function createSessionLeaseTracker(
  leaseSession: (sessionId: string) => void,
  releaseSession: (sessionId: string) => void,
): SessionLeaseTracker {
  let active: string | null = null;
  return {
    opened(sessionId) {
      if (sessionId.length === 0) return; // never lease an unminted id
      if (active === sessionId) return; // same session: no release/lease churn
      if (active !== null) {
        // Release the previous session BEFORE taking the new lease.
        releaseSession(active);
        active = null;
      }
      active = sessionId;
      leaseSession(sessionId);
    },
    closed() {
      if (active === null) return;
      const previous = active;
      active = null;
      releaseSession(previous);
    },
    current: () => active,
  };
}
