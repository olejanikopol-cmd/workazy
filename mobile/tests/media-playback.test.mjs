import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYBACK_CLEANUP_ERROR_MESSAGE,
  PLAYBACK_FILE_MESSAGE,
  PLAYBACK_NATIVE_ERROR_MESSAGE,
  createPlaybackController,
} from '../src/services/media/playbackController.ts';

/** Fake native device whose commands reject exactly where the test says so. */
function fakeDevice(options = {}) {
  const calls = [];
  return {
    calls,
    play() {
      calls.push('play');
      if (options.playThrows) throw new Error('play failed');
    },
    pause() {
      calls.push('pause');
      if (options.pauseThrows) throw new Error('pause failed');
    },
    async seek(seconds) {
      calls.push(`seek:${seconds}`);
      if (options.seekRejects) throw new Error('seek failed');
    },
    release() {
      calls.push('release');
      if (options.releaseThrows) throw new Error('release failed');
    },
  };
}

function controllerWith(options = {}) {
  const device = fakeDevice(options);
  const exclusivity = [];
  const controller = createPlaybackController({
    getDevice: () => device,
    onClaimExclusive: () => exclusivity.push('claim'),
    onReleaseExclusive: () => exclusivity.push('release'),
  });
  controller.setResolution('ready');
  return { controller, device, exclusivity };
}

/** Collects unhandled rejections so a test can prove none escaped. */
function watchUnhandledRejections() {
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on('unhandledRejection', handler);
  return {
    seen,
    async stop() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.off('unhandledRejection', handler);
      return seen;
    },
  };
}

test('normal playback stays play -> pause -> resume through real commands', () => {
  const { controller, device } = controllerWith();
  assert.equal(controller.getStatus().state, 'paused');

  controller.toggle();
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  assert.equal(controller.getStatus().state, 'playing');
  assert.deepEqual(device.calls, ['play']);

  controller.toggle();
  controller.setNativeStatus({ playing: false, error: null, didJustFinish: false });
  assert.equal(controller.getStatus().state, 'paused');
  assert.deepEqual(device.calls, ['play', 'pause']);

  controller.toggle(); // resume
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  assert.equal(controller.getStatus().state, 'playing');
  assert.deepEqual(device.calls, ['play', 'pause', 'play']);
});

test('a rejected play runs the safe cleanup and never claims to be playable', () => {
  const { controller, device, exclusivity } = controllerWith({ playThrows: true });
  controller.toggle();
  const status = controller.getStatus();
  assert.equal(status.state, 'unavailable');
  assert.equal(status.message, PLAYBACK_NATIVE_ERROR_MESSAGE);
  assert.equal(status.canRetry, true);
  assert.deepEqual(device.calls, ['play', 'pause', 'release']); // stopped, then released
  assert.deepEqual(exclusivity, ['claim', 'release']); // exclusivity cleared
  // A later 'ready' resolution can never resurrect the failed card.
  controller.setResolution('ready');
  assert.equal(controller.getStatus().state, 'unavailable');
});

test('a rejected pause while switching runs the FULL failure cleanup (no hidden playback)', () => {
  const watcher = watchUnhandledRejections();
  const { controller, device, exclusivity } = controllerWith({ pauseThrows: true });
  controller.toggle();
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  assert.equal(controller.getStatus().state, 'playing');

  controller.deactivate(); // another clip takes over; the stop fails
  const status = controller.getStatus();
  assert.equal(status.state, 'unavailable'); // honest: playback did NOT keep running
  assert.equal(status.errorReason, 'command');
  assert.equal(status.canRetry, true);
  // The player was stopped and RELEASED, and exclusivity was yielded exactly once.
  assert.deepEqual(device.calls, ['play', 'pause', 'pause', 'release']);
  assert.deepEqual(exclusivity, ['claim', 'release']);
  return watcher.stop().then((escaped) => assert.deepEqual(escaped, []));
});

test('a native status error while playing stops and releases the player', () => {
  const { controller, device, exclusivity } = controllerWith();
  controller.toggle();
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  controller.setNativeStatus({ playing: true, error: 'AVFoundation -11800', didJustFinish: false });
  assert.equal(controller.getStatus().state, 'unavailable');
  assert.equal(controller.getStatus().errorReason, 'native');
  assert.deepEqual(device.calls, ['play', 'pause', 'release']);
  assert.deepEqual(exclusivity, ['claim', 'release']);
});

test('a rejected seek (scrub) is surfaced through the same cleanup', async () => {
  const watcher = watchUnhandledRejections();
  const { controller, device } = controllerWith({ seekRejects: true });
  controller.seek(12);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await watcher.stop(), []);
  assert.equal(controller.getStatus().state, 'unavailable');
  assert.equal(controller.getStatus().errorReason, 'command');
  assert.deepEqual(device.calls, ['seek:12', 'pause', 'release']);
});

test('a failing completion rewind is caught and reported (no unhandled rejection)', async () => {
  const watcher = watchUnhandledRejections();
  const { controller, device, exclusivity } = controllerWith({ seekRejects: true });
  controller.toggle(); // the user played it, so this card owns exclusivity
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  controller.setNativeStatus({ playing: false, error: null, didJustFinish: true });
  const escaped = await watcher.stop();
  assert.deepEqual(escaped, []);
  assert.equal(controller.getStatus().state, 'unavailable');
  assert.equal(controller.getStatus().message, PLAYBACK_CLEANUP_ERROR_MESSAGE);
  // The rewind was attempted, the clip was stopped and released exactly once.
  assert.equal(device.calls.includes('seek:0'), true);
  assert.equal(device.calls.includes('pause'), true);
  assert.equal(device.calls.filter((call) => call === 'release').length, 1);
  assert.deepEqual(exclusivity, ['claim', 'release']);
});

test('a successful completion rewinds, releases exclusivity and stays replayable', async () => {
  const { controller, device, exclusivity } = controllerWith();
  controller.toggle();
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  controller.setNativeStatus({ playing: false, error: null, didJustFinish: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(controller.getStatus().state, 'ready');
  assert.deepEqual(device.calls, ['play', 'pause', 'seek:0']);
  assert.deepEqual(exclusivity, ['claim', 'release']);
  controller.toggle(); // replay from the start on the same player
  assert.deepEqual(device.calls, ['play', 'pause', 'seek:0', 'play']);
});

test('unmount/dispose guards a rejecting pause AND release', async () => {
  const watcher = watchUnhandledRejections();
  const { controller, device } = controllerWith({ pauseThrows: true, releaseThrows: true });
  controller.toggle();
  controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  controller.dispose();
  controller.dispose(); // idempotent
  const escaped = await watcher.stop();
  assert.deepEqual(escaped, []);
  assert.deepEqual(device.calls, ['play', 'pause', 'release']); // exactly one release attempt
});

test('a missing/undecodable file is unavailable with retry, and retry starts clean', () => {
  const { controller, device, exclusivity } = controllerWith();
  controller.setResolution('unavailable', 'Файл недоступен на этом устройстве.');
  assert.equal(controller.getStatus().state, 'unavailable');
  assert.equal(controller.getStatus().message, PLAYBACK_FILE_MESSAGE);
  assert.equal(controller.getStatus().canRetry, true);
  assert.deepEqual(device.calls, ['pause', 'release']); // stopped + released, never left playing
  assert.deepEqual(exclusivity, []); // nothing was claimed, so nothing to yield

  // Retry: the card re-resolves and mounts a FRESH controller/player.
  controller.retryReady();
  assert.equal(controller.getStatus().state, 'loading');
  controller.setResolution('ready');
  assert.equal(controller.getStatus().state, 'paused');
  controller.toggle();
  assert.equal(device.calls.includes('play'), true);
});

test('a failed retry stays honest instead of pretending to be playable', () => {
  const { controller } = controllerWith();
  controller.setResolution('unavailable', 'Файл недоступен на этом устройстве.');
  controller.retryReady();
  controller.setResolution('unavailable', 'Файл недоступен на этом устройстве.');
  const status = controller.getStatus();
  assert.equal(status.state, 'unavailable');
  assert.equal(status.canRetry, true);
  assert.equal(status.errorReason, 'file');
});
