import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerLifecycle } from '../src/services/media/playerLifecycle.ts';

/** Fake native player wrapper whose commands are observable. */
function fakePlayer(options = {}) {
  const calls = [];
  return {
    calls,
    play() {
      calls.push('play');
    },
    pause() {
      calls.push('pause');
      if (options.pauseThrows) throw new Error('pause failed');
    },
    async seek(seconds) {
      calls.push(`seek:${seconds}`);
    },
    release() {
      calls.push('release');
      if (options.releaseThrows) throw new Error('release failed');
    },
  };
}

/**
 * Simulates an ordinary React rerender: the parent passes NEW inline callbacks on
 * every render while the same player/source stays mounted.
 */
function rerender(lifecycle, state) {
  state.render = (state.render ?? 0) + 1;
  const render = state.render;
  lifecycle.setCallbacks({
    onClaimExclusive: () => {
      state.claims += 1;
      // Records WHICH render's callback fired, proving the latest one is used.
      state.claimRender = render;
    },
    onReleaseExclusive: () => {
      state.releases += 1;
      state.activeMediaId = null;
    },
  });
}

test('A: rerender callback changes never dispose the audio player or controller', () => {
  const lifecycle = createPlayerLifecycle();
  const player = fakePlayer();
  const state = { claims: 0, releases: 0, activeMediaId: 'media-1' };
  lifecycle.setDevice(player, player);

  for (let render = 0; render < 5; render += 1) rerender(lifecycle, state);
  const controller = lifecycle.controller();
  controller.setResolution('ready');
  controller.toggle(); // play
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  assert.equal(controller.getStatus().state, 'playing');

  // The parent rerenders (activeMediaId changed → new callbacks).
  state.activeMediaId = 'media-1';
  for (let render = 0; render < 3; render += 1) rerender(lifecycle, state);
  assert.equal(lifecycle.controller(), controller); // SAME controller
  assert.deepEqual(player.calls, ['play']); // the player was never removed
  assert.equal(lifecycle.stats().disposed, 0);

  // Playback continues: pause, then resume, on the very same player.
  controller.toggle();
  controller.setNativeStatus({ playing: false, error: null, didJustFinish: false });
  assert.equal(controller.getStatus().state, 'paused');
  controller.toggle();
  assert.deepEqual(player.calls, ['play', 'pause', 'play']);
  // Exclusivity is claimed once and HELD across pause/resume (a pause does not yield
  // it), and the callback used is the one from the render in effect at that moment.
  assert.equal(state.claims, 1);
  assert.equal(state.claimRender, 5);
});

test('B: the same holds for video (one controller per player across rerenders)', () => {
  const lifecycle = createPlayerLifecycle();
  const player = fakePlayer();
  const state = { claims: 0, releases: 0, activeMediaId: 'video-1' };
  lifecycle.setDevice(player, player);
  for (let render = 0; render < 4; render += 1) rerender(lifecycle, state);

  const controller = lifecycle.controller();
  controller.setResolution('ready');
  controller.toggle();
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  for (let render = 0; render < 4; render += 1) rerender(lifecycle, state);

  assert.equal(lifecycle.controller(), controller);
  assert.deepEqual(player.calls, ['play']);
  assert.equal(state.claims, 1);
  assert.equal(lifecycle.stats().disposed, 0);
});

test('C: a REAL player/source replacement retires the old one exactly once', () => {
  const lifecycle = createPlayerLifecycle();
  const first = fakePlayer();
  const second = fakePlayer();
  const state = { claims: 0, releases: 0, activeMediaId: 'media-1' };
  lifecycle.setDevice(first, first);
  const firstController = lifecycle.controller();
  firstController.setResolution('ready');
  firstController.toggle();

  // A new player instance (e.g. a retry remount or a new source).
  lifecycle.setDevice(second, second);
  assert.deepEqual(first.calls, ['play', 'pause', 'release']); // released exactly once
  assert.notEqual(lifecycle.controller(), firstController);

  const secondController = lifecycle.controller();
  secondController.setResolution('ready');
  rerender(lifecycle, state);
  secondController.toggle();
  assert.deepEqual(second.calls, ['play']); // the new player works
  assert.equal(lifecycle.stats().releases, 1);
});

test('D: unmount releases the active player exactly once and is idempotent', () => {
  const lifecycle = createPlayerLifecycle();
  const player = fakePlayer();
  lifecycle.setDevice(player, player);
  const controller = lifecycle.controller();
  controller.setResolution('ready');
  controller.toggle();

  lifecycle.dispose();
  lifecycle.dispose(); // idempotent
  assert.equal(player.calls.filter((call) => call === 'release').length, 1);
  assert.equal(lifecycle.stats().releases, 1);
  assert.equal(lifecycle.stats().disposed, 1);
  assert.equal(lifecycle.isDisposed(), true);
});

test('a rejecting pause on unmount still releases the player exactly once', () => {
  const lifecycle = createPlayerLifecycle();
  const player = fakePlayer({ pauseThrows: true });
  lifecycle.setDevice(player, player);
  const controller = lifecycle.controller();
  controller.setResolution('ready');
  controller.toggle();
  lifecycle.dispose();
  assert.equal(player.calls.includes('release'), true);
  assert.equal(lifecycle.stats().releases, 1);
});

test('a failing switch cleanup releases the player and yields exclusivity once', () => {
  const lifecycle = createPlayerLifecycle();
  const player = fakePlayer({ pauseThrows: true });
  const state = { claims: 0, releases: 0, activeMediaId: 'media-1' };
  lifecycle.setDevice(player, player);
  const controller = lifecycle.controller();
  rerender(lifecycle, state);
  controller.setResolution('ready');
  controller.toggle();
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });

  controller.deactivate(); // switching to another clip; the pause fails
  assert.equal(controller.getStatus().state, 'unavailable');
  assert.equal(player.calls.filter((call) => call === 'release').length, 1);
  assert.equal(state.releases, 1);
});
