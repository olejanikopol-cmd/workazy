/**
 * A stable, mutable holder for a callback that must be consulted LATER (from an
 * event handler or after an await) without recreating the object that reads it.
 *
 * Used so the recorder controller is created exactly once while still asking the
 * owning surface for live identity/busy state, and so no React ref is read during
 * render (all writes go through `set`, called from effects/handlers).
 */
export type CallbackSlot<Args extends unknown[], Result> = {
  set(callback: (...args: Args) => Result): void;
  invoke(...args: Args): Result;
};

export function createCallbackSlot<Args extends unknown[], Result>(
  initial: (...args: Args) => Result,
): CallbackSlot<Args, Result> {
  let current = initial;
  return {
    set: (callback) => {
      current = callback;
    },
    invoke: (...args) => current(...args),
  };
}
