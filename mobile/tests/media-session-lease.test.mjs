import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLeaseTracker } from '../src/services/media/sessionLeaseTracker.ts';

/** Mirrors the coordinator's live session-lease set. */
function trackerWithSet() {
  const leased = new Set();
  const tracker = createSessionLeaseTracker(
    (sessionId) => leased.add(sessionId),
    (sessionId) => leased.delete(sessionId),
  );
  return { leased, tracker };
}

test('a new session releases the previous lease instead of accumulating', () => {
  const { leased, tracker } = trackerWithSet();

  tracker.opened('session-A');
  assert.deepEqual([...leased], ['session-A']); // leased synchronously at creation
  assert.equal(tracker.current(), 'session-A');

  // Re-record keeps the same session: opening it again is idempotent.
  tracker.opened('session-A');
  assert.equal(leased.size, 1);

  // A new take/restart mints B: A is released first.
  tracker.opened('session-B');
  assert.deepEqual([...leased], ['session-B']);

  // A permission retry mints C: B is released.
  tracker.opened('session-C');
  assert.deepEqual([...leased], ['session-C']);

  // Unmount releases whichever session is current.
  tracker.closed();
  assert.equal(leased.size, 0);
  assert.equal(tracker.current(), null);
  tracker.closed(); // idempotent: never releases twice into someone else's lease
  assert.equal(leased.size, 0);
});

test('live session leases stay bounded to the current session only', () => {
  const { leased, tracker } = trackerWithSet();
  for (let index = 0; index < 50; index += 1) {
    tracker.opened(`session-${index}`);
    assert.equal(leased.size, 1);
  }
  assert.deepEqual([...leased], ['session-49']);
  tracker.closed();
  assert.equal(leased.size, 0);
});

test('an unminted or empty session id is never leased, and only explicit openings lease', () => {
  const { leased, tracker } = trackerWithSet();
  tracker.opened('');
  assert.equal(leased.size, 0);
  assert.equal(tracker.current(), null);

  // The tracker has no asynchronous path: nothing except `opened` can add a lease,
  // so a stale startup completion cannot re-register an obsolete session.
  assert.deepEqual(Object.keys(tracker).sort(), ['closed', 'current', 'opened']);

  // After closing, an OLD id can only come back through a brand new opening.
  tracker.opened('session-old');
  tracker.closed();
  assert.equal(leased.size, 0);
});
