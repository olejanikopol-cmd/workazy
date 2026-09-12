/**
 * PROCESS-GLOBAL recorder hardware coordinator.
 *
 * The native recorder and the audio-session mode are process-global, so hardware
 * ownership must be too: every binding instance (every recorder surface) shares
 * ONE coordinator, and a binding instance is never an ownership boundary.
 *
 * Invariants:
 * - one authoritative hardware owner at a time, identified by
 *   `{ sessionId, epoch, kind }` (epoch bumped on every activation);
 * - every hardware operation is queued on ONE process-level chain and re-checks
 *   ownership WHEN IT RUNS, so work queued by a superseded session is skipped;
 * - global mode changes apply only while the caller is authoritative, and because
 *   the handoff itself is queued behind them, a stale change can never land after a
 *   newer owner took over;
 * - the status-listener slot has exactly one owner, and a session may only clear
 *   the listener it installed itself;
 * - PHYSICAL RESERVATIONS are independent from the LOGICAL owner: an unresolved
 *   capture keeps the hardware reserved even after its session was logically
 *   released (`owner === null`), and EVERY activation must resolve all outstanding
 *   reservations (or be refused with a typed `HardwareHandoffBlockedError`).
 */
import type { MediaKind } from './mediaLimits';


export type HardwareOwner = { sessionId: string; epoch: number; kind: MediaKind };

/**
 * Physical-stop duty for one owner. It is NEVER cleared in a `finally`:
 * `required` (registered, capture possibly live) → `stopping` (attempt in flight) →
 * `confirmedStopped` (native contract proved the capture ended) or `failed`
 * (the attempt failed / could not be confirmed: the duty stays and blocks handoff).
 */
export type PhysicalStopState = 'required' | 'stopping' | 'confirmedStopped' | 'failed';

export type HardwareTaskOutcome<T> =
  | { status: 'ran'; value: T }
  | { status: 'skipped'; value?: undefined };

export type RecorderHardwareCoordinator = {
  /** Serialized handoff; resolves with the new ownership token. */
  activate(input: { sessionId: string; kind: MediaKind }): Promise<HardwareOwner>;
  currentOwner(): HardwareOwner | null;
  isOwner(owner: HardwareOwner | null): boolean;
  /** Frees the hardware only when the caller is still the owner. */
  deactivate(owner: HardwareOwner | null): void;
  /** Queues a hardware operation; skipped unless the caller still owns it. */
  runHardwareTask<T>(
    owner: HardwareOwner,
    task: () => Promise<T> | T,
  ): Promise<HardwareTaskOutcome<T>>;
  /**
   * Global recorder-mode change under ownership control. Because `activate` is
   * queued behind every in-flight hardware operation, a stale mode change can never
   * land after a newer owner took over: it either applies while its caller still
   * owns the hardware, or it is skipped.
   */
  runModeChange(
    owner: HardwareOwner,
    input: { enabled: boolean; apply: (enabled: boolean) => Promise<void> },
  ): Promise<'applied' | 'skipped'>;
  /**
   * Queued PHYSICAL audio-mode transition that must still be valid WHEN IT RUNS.
   *
   * Used for the release-time playback-mode restore, which cannot require logical
   * ownership (the owner is released right after) but must never land underneath a
   * newer recording owner: it runs on the SAME global queue (so a handoff can never
   * take effect before an in-flight transition settled) and it re-validates at
   * execution time — a newer logical owner, a foreign physical reservation (another
   * session may be capturing) or its own still-unresolved capture makes it `skipped`.
   */
  runAudioModeTransition(
    owner: HardwareOwner,
    input: { enabled: boolean; apply: (enabled: boolean) => Promise<void> },
  ): Promise<'applied' | 'skipped'>;
  statusListenerOwner(): string | null;
  /**
   * Registers the operation that PHYSICALLY stops this owner's capture. It is
   * registered when the capture begins (before any stop await) and executed by the
   * coordinator during a handoff, so a new owner can never take over while the
   * previous physical recorder is still capturing.
   */
  registerPhysicalStop(owner: HardwareOwner, stop: () => Promise<void>): void;
  /** Confirms the capture physically ENDED (native contract) and clears the duty. */
  confirmPhysicalStop(owner: HardwareOwner): void;
  /**
   * Drops a duty only when nothing was ever captured for it. A failed or pending
   * duty is NEVER cleared here, so stale cleanup cannot erase a real obligation.
   */
  abandonPhysicalStop(owner: HardwareOwner): void;
  /** Explicit obligation state (for diagnostics/tests/UI). */
  physicalStopState(owner: HardwareOwner | null): PhysicalStopState | null;
  /** Retries a session's physical shutdown without any logical-owner requirement. */
  retryReservation(owner: HardwareOwner): Promise<'none' | 'confirmed' | 'failed'>;
  /** Number of unresolved physical reservations (diagnostics/tests/UI). */
  unresolvedReservationCount(): number;
  /** True while a capture may still be physically running for that owner. */
  hasPendingPhysicalStop(owner: HardwareOwner | null): boolean;
  /** Claims the listener slot for a non-stale owner. */
  claimStatusListener(owner: HardwareOwner): boolean;
  /** Clears the slot only when the caller owns it. */
  releaseStatusListener(sessionId: string): void;
};

/** Thrown when a handoff is refused because the previous capture is not confirmed stopped. */
export class HardwareHandoffBlockedError extends Error {
  readonly code = 'handoff-blocked' as const;
  readonly detail: string;
  constructor(detail: string) {
    super('hardware-handoff-blocked');
    this.name = 'HardwareHandoffBlockedError';
    this.detail = detail;
  }
}

export function createRecorderHardwareCoordinator(): RecorderHardwareCoordinator {
  let owner: HardwareOwner | null = null;
  let epoch = 0;
  let listenerOwner: string | null = null;
  /** Physical-stop duty per owner key (`sessionId#epoch`). */
  const physicalStops = new Map<
    string,
    {
      owner: HardwareOwner;
      stop: () => Promise<void>;
      state: PhysicalStopState;
      attempts: number;
    }
  >();

  function keyOf(candidate: HardwareOwner): string {
    return `${candidate.sessionId}#${candidate.epoch}`;
  }
  /** One process-level chain for every hardware operation and ownership handoff. */
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function isOwner(candidate: HardwareOwner | null): boolean {
    if (candidate === null || owner === null) return false;
    return owner.sessionId === candidate.sessionId && owner.epoch === candidate.epoch;
  }

  return {
    async activate(input) {
      // Queued handoff: it takes effect only after prior hardware work settled AND
      // the previous owner's capture is CONFIRMED physically stopped. A failed or
      // unconfirmable stop keeps the duty and blocks the handoff (one stuck recorder
      // is preferable to two concurrently recording).
      return await enqueue(async () => {
        // PHYSICAL SHUTDOWN FIRST, and it is keyed to RESERVATIONS, not to the
        // logical owner: a reservation survives a logical release (owner === null),
        // so a new session can never start while an earlier capture is unresolved.
        for (const [key, duty] of [...physicalStops]) {
          if (duty.state === 'confirmedStopped') {
            physicalStops.delete(key);
            continue;
          }
          duty.state = 'stopping';
          duty.attempts += 1;
          try {
            await duty.stop(); // must PROVE the capture physically ended
            duty.state = 'confirmedStopped';
            physicalStops.delete(key);
          } catch (error) {
            duty.state = 'failed'; // stays: every activation remains blocked
            throw new HardwareHandoffBlockedError(
              `${duty.owner.sessionId}:${error instanceof Error ? error.message : 'stop-failed'}`,
            );
          }
        }
        const previous = owner;
        if (previous !== null && previous.sessionId !== input.sessionId) listenerOwner = null;
        epoch += 1;
        owner = { sessionId: input.sessionId, kind: input.kind, epoch };
        return owner;
      });
    },

    registerPhysicalStop(candidate, stop) {
      if (candidate === null) return;
      // Registered even for a logically superseded session: the reservation is the
      // physical truth and must outlive logical ownership.
      physicalStops.set(keyOf(candidate), { owner: candidate, stop, state: 'required', attempts: 0 });
    },

    confirmPhysicalStop(candidate) {
      const key = keyOf(candidate);
      const duty = physicalStops.get(key);
      if (duty === undefined) return;
      duty.state = 'confirmedStopped';
      physicalStops.delete(key);
    },

    abandonPhysicalStop(candidate) {
      const key = keyOf(candidate);
      const duty = physicalStops.get(key);
      if (duty === undefined) return;
      // Only an untouched reservation may be dropped; a pending/failed one means a
      // capture might still be running and must never be erased by stale cleanup.
      if (duty.state === 'required' && duty.attempts === 0) physicalStops.delete(key);
    },

    async retryReservation(candidate) {
      return await enqueue(async () => {
        const key = keyOf(candidate);
        const duty = physicalStops.get(key);
        if (duty === undefined) return 'none' as const;
        duty.state = 'stopping';
        duty.attempts += 1;
        try {
          await duty.stop();
          duty.state = 'confirmedStopped';
          physicalStops.delete(key);
          return 'confirmed' as const;
        } catch {
          duty.state = 'failed'; // stays registered: the hardware stays reserved
          return 'failed' as const;
        }
      });
    },

    unresolvedReservationCount() {
      return physicalStops.size;
    },

    physicalStopState(candidate) {
      if (candidate === null) return null;
      return physicalStops.get(keyOf(candidate))?.state ?? null;
    },

    hasPendingPhysicalStop(candidate) {
      if (candidate === null) return false;
      const duty = physicalStops.get(keyOf(candidate));
      return duty !== undefined && duty.state !== 'confirmedStopped';
    },

    currentOwner: () => owner,
    isOwner,

    deactivate(candidate) {
      if (candidate === null || !isOwner(candidate)) return; // never frees hardware it does not own
      // LOGICAL release only: any physical reservation survives (an unresolved
      // capture keeps the hardware reserved even with no logical owner).
      owner = null;
      listenerOwner = null;
    },

    async runHardwareTask(candidate, task) {
      return await enqueue(async () => {
        // Re-checked WHEN THE TASK RUNS: superseded work is skipped.
        if (!isOwner(candidate)) return { status: 'skipped' as const };
        const value = await task();
        return { status: 'ran' as const, value };
      });
    },

    async runModeChange(candidate, input) {
      return await enqueue(async () => {
        if (!isOwner(candidate)) return 'skipped' as const;
        await input.apply(input.enabled);
        // The handoff is queued behind this task, so ownership cannot move mid-apply.
        return 'applied' as const;
      });
    },

    async runAudioModeTransition(candidate, input) {
      return await enqueue(async () => {
        // VALIDATED WHEN IT RUNS, never only before queueing: if another session
        // became (or is becoming) the authoritative recording owner, this stale
        // transition must not touch the process-global audio mode.
        if (!isOwner(candidate)) {
          if (owner !== null) return 'skipped' as const; // a newer owner took over
          for (const duty of physicalStops.values()) {
            // A foreign reservation means another session may be capturing; our own
            // still-unresolved capture means the recorder may still be running.
            if (keyOf(duty.owner) !== keyOf(candidate)) return 'skipped' as const;
            if (duty.state !== 'confirmedStopped') return 'skipped' as const;
          }
        }
        await input.apply(input.enabled);
        // The handoff and every native start are queued behind this task, so no
        // recording can begin before the global mode has settled here.
        return 'applied' as const;
      });
    },

    statusListenerOwner: () => listenerOwner,

    claimStatusListener(candidate) {
      if (!isOwner(candidate)) return false;
      listenerOwner = candidate.sessionId;
      return true;
    },

    releaseStatusListener(sessionId) {
      if (listenerOwner !== sessionId) return; // not ours to clear
      listenerOwner = null;
    },
  };
}

/**
 * The ONE coordinator every production binding instance shares. Tests create a
 * coordinator and pass the SAME instance to every binding they build, mirroring
 * production sharing (never one coordinator per binding).
 */
export const sharedRecorderHardwareCoordinator = createRecorderHardwareCoordinator();
