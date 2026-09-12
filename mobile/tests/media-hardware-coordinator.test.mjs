import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorderHardwareCoordinator } from '../src/services/media/recorderHardwareCoordinator.ts';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('ownership is process-global: one authoritative owner and a serialized handoff', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const a = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  assert.equal(coordinator.isOwner(a), true);

  const bHandoff = coordinator.activate({ sessionId: 'session-B', kind: 'audio' });
  // The handoff is queued: A stays authoritative until prior work settles.
  assert.equal(coordinator.isOwner(a), true);
  const b = await bHandoff;
  assert.equal(coordinator.isOwner(a), false);
  assert.equal(coordinator.isOwner(b), true);
  assert.notEqual(a.epoch, b.epoch);

  // A stale session can never free the hardware the newer one owns.
  coordinator.deactivate(a);
  assert.equal(coordinator.isOwner(b), true);
  coordinator.deactivate(b);
  assert.equal(coordinator.currentOwner(), null);
});

test('work queued before a handoff runs for its owner; work queued after is skipped', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const a = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  const blockers = deferred();
  const applied = [];

  const running = coordinator.runHardwareTask(a, async () => {
    applied.push('A:long');
    await blockers.promise;
  });
  const beforeHandoff = coordinator.runHardwareTask(a, () => {
    applied.push('A:queued-before-handoff');
  });
  const bHandoff = coordinator.activate({ sessionId: 'session-B', kind: 'audio' });
  blockers.resolve();
  await running;
  const firstOutcome = await beforeHandoff;
  const b = await bHandoff;

  // FIFO: work queued before the handoff completes while A is still authoritative,
  // which is exactly why B can never be disturbed by it.
  assert.deepEqual(applied, ['A:long', 'A:queued-before-handoff']);
  assert.equal(firstOutcome.status, 'ran');
  assert.equal(coordinator.isOwner(b), true);

  const afterHandoff = await coordinator.runHardwareTask(a, () => 'touched-B');
  assert.equal(afterHandoff.status, 'skipped');
  assert.equal(coordinator.currentOwner()?.sessionId, 'session-B');
});

test('a mode change cannot land after a newer owner took over', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const a = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  const modeGate = deferred();
  const modes = [];

  const change = coordinator.runModeChange(a, {
    enabled: false,
    apply: async (enabled) => {
      modes.push(enabled ? 'recording' : 'playback');
      await modeGate.promise;
    },
  });
  const bHandoff = coordinator.activate({ sessionId: 'session-B', kind: 'audio' });
  modeGate.resolve();
  const outcome = await change;
  const b = await bHandoff;

  assert.equal(outcome, 'applied'); // applied while A was still authoritative
  assert.equal(coordinator.isOwner(b), true);

  // A stale mode change requested AFTER the handoff is skipped entirely.
  const stale = await coordinator.runModeChange(a, {
    enabled: false,
    apply: async (enabled) => {
      modes.push(enabled ? 'recording' : 'playback');
    },
  });
  assert.equal(stale, 'skipped');
  assert.deepEqual(modes, ['playback']); // B's hardware mode was never touched by A
});

test('the status-listener slot has one owner and only its owner may clear it', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const a = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  assert.equal(coordinator.claimStatusListener(a), true);
  assert.equal(coordinator.statusListenerOwner(), 'session-A');

  const b = await coordinator.activate({ sessionId: 'session-B', kind: 'audio' });
  assert.equal(coordinator.claimStatusListener(a), false); // stale claims are refused
  assert.equal(coordinator.claimStatusListener(b), true);
  coordinator.releaseStatusListener('session-A'); // a stale clear is a no-op
  assert.equal(coordinator.statusListenerOwner(), 'session-B');
  coordinator.releaseStatusListener('session-B');
  assert.equal(coordinator.statusListenerOwner(), null);
});

test('in-flight stale completions cannot overwrite the shared ownership', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const a = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  const b = await coordinator.activate({ sessionId: 'session-B', kind: 'audio' });
  assert.equal(coordinator.isOwner(a), false);
  assert.equal(coordinator.isOwner(b), true);
  const outcome = await coordinator.runHardwareTask(a, () => 'touched-B');
  assert.equal(outcome.status, 'skipped');
  assert.equal(coordinator.currentOwner()?.sessionId, 'session-B');
});
