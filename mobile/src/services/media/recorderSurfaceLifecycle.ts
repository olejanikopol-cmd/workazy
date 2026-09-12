/**
 * Recorder surface teardown, extracted so the exact production sequence is
 * testable without React: on unmount the surface releases its session lease and
 * invalidates the controller (which stops/releases only its own session, cleans
 * its own uncommitted take and lets a late native result be cleaned safely).
 *
 * Idempotent: repeated teardown (React strict-mode double effects, unmount after
 * an explicit close) cancels and releases exactly once.
 */
export type RecorderSurfaceLifecycle = {
  /** Idempotent teardown; resolves when the controller cancel settled. */
  dispose(): Promise<void>;
  isDisposed(): boolean;
};

export function createRecorderSurfaceLifecycle(input: {
  /** Invalidates the controller session (generation bump + own-resource cleanup). */
  cancel: () => Promise<void>;
  /** Releases the CURRENT recorder session lease (sweep protection). */
  releaseSessionLease: () => void;
}): RecorderSurfaceLifecycle {
  let disposed = false;
  let pending: Promise<void> | null = null;
  return {
    dispose(): Promise<void> {
      if (pending !== null) return pending;
      if (disposed) return Promise.resolve();
      disposed = true;
      input.releaseSessionLease();
      pending = input.cancel();
      return pending;
    },
    isDisposed: () => disposed,
  };
}
