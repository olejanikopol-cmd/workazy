import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlayerLifecycle } from '../src/services/media/playerLifecycle.ts';
import {
  claimActivePlayback,
  clearActivePlayback,
} from '../src/features/journal/media/activePlayback.ts';
import { createVideoEventBridge } from '../src/features/journal/media/videoEventBridge.ts';

/**
 * ONE shared sheet-level active-playback state, exactly like JournalSheet: a single
 * `activeMediaId` that every card (audio AND video) claims and clears through the
 * production identity-guarded helpers.
 *
 * VIDEO cards are driven through the production event bridge that `LocalVideoPlayer`
 * wires to the real expo-video events (`playingChange` / `playToEnd` / `statusChange`)
 * — never through `controller.toggle()`, which the native controls do not call.
 */
function createSheet() {
  return {
    activeMediaId: null,
    claim(mediaId) {
      this.activeMediaId = claimActivePlayback(this.activeMediaId, mediaId);
    },
    // Same guarded updater the sheet uses for BOTH audio and video onFinished
    // (natural end, error cleanup, deactivation, unmount).
    finish(mediaId) {
      this.activeMediaId = clearActivePlayback(this.activeMediaId, mediaId);
    },
  };
}

/** One media card bound to the shared sheet state (kind: 'audio' | 'video'). */
function createCard(sheet, { mediaId, kind, pauseThrows = false }) {
  const calls = [];
  const claims = [];
  const yields = [];
  const lifecycle = createPlayerLifecycle();
  const player = {
    calls,
    play: () => calls.push('play'),
    pause: () => {
      calls.push('pause');
      if (pauseThrows) throw new Error('pause failed');
    },
    seek: async () => undefined,
    release: () => calls.push('release'),
  };
  lifecycle.setDevice(player, player);
  lifecycle.setCallbacks({
    onClaimExclusive: () => {
      claims.push(mediaId);
      sheet.claim(mediaId);
    },
    // MediaAttachmentCard forwards onFinished to the audio AND video player, and the
    // player lifecycle calls it on finish, error cleanup, switch and unmount.
    onReleaseExclusive: () => {
      yields.push(mediaId);
      sheet.finish(mediaId);
    },
  });
  const controller = lifecycle.controller();
  controller.setResolution('ready');
  // The EXACT production bridge the video player uses.
  const bridge = createVideoEventBridge(controller);
  return { kind, mediaId, calls, claims, yields, lifecycle, controller, bridge };
}

/** Audio: the real UI path (the play button calls controller.toggle()). */
function playAudio(sheet, options) {
  const card = createCard(sheet, options);
  card.controller.toggle();
  card.controller.setNativeStatus({ playing: true, error: null, didJustFinish: false });
  return card;
}

/** Video: the REAL native path — expo-video's own controls, no toggle() anywhere. */
function playNativeVideo(sheet, options) {
  const card = createCard(sheet, options);
  card.bridge.handlePlayingChange({ isPlaying: true });
  return card;
}

test('a native video start (no toggle) claims exclusivity and the sheet active id', () => {
  const sheet = createSheet();
  const b = playNativeVideo(sheet, { mediaId: 'video-B', kind: 'video' });
  assert.equal(sheet.activeMediaId, 'video-B');
  assert.deepEqual(b.claims, ['video-B']);
  assert.equal(b.calls.includes('play'), false); // no controller-issued play was needed
});

test('native start -> playToEnd releases exclusivity and clears the active id', () => {
  const sheet = createSheet();
  const b = playNativeVideo(sheet, { mediaId: 'video-B', kind: 'video' });
  b.bridge.handlePlayToEnd();
  // The yield only happens when the controller really HELD exclusivity.
  assert.deepEqual(b.yields, ['video-B']);
  assert.equal(sheet.activeMediaId, null);
});

test('native start -> status error runs the failure cleanup and clears the active id', () => {
  const sheet = createSheet();
  const b = playNativeVideo(sheet, { mediaId: 'video-B', kind: 'video' });
  b.bridge.handleStatusChange({ status: 'error' });
  assert.equal(b.controller.getStatus().state, 'unavailable');
  assert.equal(b.calls.filter((call) => call === 'release').length, 1);
  assert.deepEqual(b.yields, ['video-B']);
  assert.equal(sheet.activeMediaId, null);
});

test('native pause keeps exclusivity, later completion still clears the id', () => {
  const sheet = createSheet();
  const b = playNativeVideo(sheet, { mediaId: 'video-B', kind: 'video' });
  b.bridge.handlePlayingChange({ isPlaying: false }); // native pause
  assert.equal(sheet.activeMediaId, 'video-B'); // policy: still the active media
  b.bridge.handlePlayToEnd();
  assert.equal(sheet.activeMediaId, null);
  assert.deepEqual(b.yields, ['video-B']);
});

test('repeated native playing events are idempotent (no duplicate ownership)', () => {
  const sheet = createSheet();
  const b = playNativeVideo(sheet, { mediaId: 'video-B', kind: 'video' });
  b.bridge.handlePlayingChange({ isPlaying: true });
  b.bridge.handlePlayingChange({ isPlaying: true });
  assert.deepEqual(b.claims, ['video-B']); // claimed exactly once
  assert.equal(sheet.activeMediaId, 'video-B');
  b.bridge.handlePlayToEnd();
  assert.deepEqual(b.yields, ['video-B']); // yielded exactly once
  assert.equal(sheet.activeMediaId, null);
});

test('native video A -> audio B: a late A completion cannot clear the audio B', () => {
  const sheet = createSheet();
  const a = playNativeVideo(sheet, { mediaId: 'video-A', kind: 'video' });
  assert.equal(sheet.activeMediaId, 'video-A');
  const b = playAudio(sheet, { mediaId: 'audio-B', kind: 'audio' });
  assert.equal(sheet.activeMediaId, 'audio-B');
  a.bridge.handlePlayToEnd(); // late completion from the old video
  assert.equal(sheet.activeMediaId, 'audio-B');
  assert.equal(b.calls.includes('release'), false); // B's player is untouched
});

test('video A -> audio B: a stale A error cleanup cannot clear the audio B', () => {
  const sheet = createSheet();
  const a = playNativeVideo(sheet, { mediaId: 'video-A', kind: 'video' });
  const b = playAudio(sheet, { mediaId: 'audio-B', kind: 'audio' });
  a.bridge.handleStatusChange({ status: 'error' });
  assert.equal(a.controller.getStatus().state, 'unavailable');
  assert.equal(sheet.activeMediaId, 'audio-B');
  assert.equal(b.calls.includes('release'), false); // B's player is untouched
});

test('audio A -> native video B: a stale audio callback cannot clear the video B', () => {
  const sheet = createSheet();
  const a = playAudio(sheet, { mediaId: 'audio-A', kind: 'audio' });
  const b = playNativeVideo(sheet, { mediaId: 'video-B', kind: 'video' });
  assert.equal(sheet.activeMediaId, 'video-B');
  a.controller.deactivate();
  a.controller.setNativeStatus({ playing: false, error: null, didJustFinish: true });
  assert.equal(sheet.activeMediaId, 'video-B');
  // B may still clear itself.
  b.bridge.handlePlayToEnd();
  assert.equal(sheet.activeMediaId, null);
});

test('a FAILED pause during a mixed switch still cannot clear the new active id', () => {
  const sheet = createSheet();
  const a = playAudio(sheet, { mediaId: 'audio-A', kind: 'audio', pauseThrows: true });
  const b = playNativeVideo(sheet, { mediaId: 'video-B', kind: 'video' });
  assert.equal(sheet.activeMediaId, 'video-B');
  a.controller.deactivate();
  assert.equal(a.controller.getStatus().state, 'unavailable');
  assert.equal(a.calls.filter((call) => call === 'release').length, 1);
  assert.equal(sheet.activeMediaId, 'video-B');
  assert.equal(b.calls.includes('release'), false);
});

test('A -> B -> C: stale native/audio callbacks leave the audio C active', () => {
  const sheet = createSheet();
  const a = playNativeVideo(sheet, { mediaId: 'video-A', kind: 'video' });
  const b = playAudio(sheet, { mediaId: 'audio-B', kind: 'audio' });
  const c = playNativeVideo(sheet, { mediaId: 'video-C', kind: 'video' });
  assert.equal(sheet.activeMediaId, 'video-C');
  a.bridge.handlePlayToEnd();
  b.controller.setNativeStatus({ playing: false, error: null, didJustFinish: true });
  assert.equal(sheet.activeMediaId, 'video-C');
  c.bridge.handlePlayToEnd();
  assert.equal(sheet.activeMediaId, null);
});

test('production wiring: the real video events drive the shared controller', () => {
  const players = readFileSync(new URL('../src/features/journal/media/MediaPlayers.tsx', import.meta.url), 'utf8');
  const card = readFileSync(new URL('../src/features/journal/media/MediaAttachmentCard.tsx', import.meta.url), 'utf8');
  const video = players.slice(players.indexOf('export function LocalVideoPlayer'));
  // The video player uses the production bridge for the REAL expo-video events...
  assert.match(video, /const bridge = createVideoEventBridge\(controller\)/);
  assert.match(video, /addListener\('playingChange'/);
  assert.match(video, /addListener\('statusChange'/);
  assert.match(video, /addListener\('playToEnd'/);
  assert.match(video, /bridge\.handlePlayingChange/);
  assert.match(video, /bridge\.handleStatusChange/);
  assert.match(video, /bridge\.handlePlayToEnd/);
  // ...never by mutating the sheet state directly from a native event.
  assert.equal(/if \(payload\.isPlaying\) onActivate\(\)/.test(video), false);
  // The card forwards onFinished to the VIDEO player, not only to audio.
  const videoUsage = card.slice(card.indexOf('<LocalVideoPlayer'));
  assert.match(videoUsage, /onFinished=\{onFinished\}/);
  assert.match(videoUsage, /onActivate=\{onActivate\}/);
});
