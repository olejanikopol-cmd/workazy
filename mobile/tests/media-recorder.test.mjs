import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorderController } from '../src/services/media/recorderController.ts';
import { mediaFailure } from '../src/services/media/mediaContracts.ts';

const AUDIO_MAX = 900_000;
const VIDEO_MAX = 600_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const IDENTITY = {
  sheetKey: 'journal-new-1',
  entryId: null,
  draftKey: 'draft-1',
  draftRevision: 0,
};

/** Fake native/file/permission/clock/repository ports (production shapes). */
function harness() {
  const h = {
    permission: {
      audio: { status: 'granted', canAskAgain: true },
      video: { status: 'granted', canAskAgain: true },
    },
    permissionGets: [],
    permissionRequests: [],
    prepareCalls: [],
    startCalls: [],
    stopCalls: [],
    releaseCalls: [],
    autoStop: null,
    ended: new Map(),
    sizes: new Map(),
    removed: [],
    adopted: [],
    discarded: [],
    sessionIds: 0,
    nowMs: 1_000,
    gatePrepare: null,
    gateStart: null,
    gateAdopt: null,
    gatePermissionGet: null,
    gateRelease: null,
    gateStop: null,
    failStartFor: null,
    openSessions: [],
    stopSessions: [],
    releasedSessionIds: [],
    adoptResult: null,
    grantOnRequest: false,
    /** Authoritative attach decision (null = attachment allowed). */
    authorize: null,
    authorizeCalls: [],
    /** Simulates iOS resetting the native recorder duration once stop() lands. */
    iosDurationBeforeStopMs: null,
  };

  for (const kind of ['audio', 'video']) h.ended.set(kind, deferred());

  const ports = {
    permissions: {
      async get(kind) {
        h.permissionGets.push(kind);
        if (h.gatePermissionGet) {
          const gate = h.gatePermissionGet;
          h.gatePermissionGet = null;
          await gate.promise;
        }
        return h.permission[kind];
      },
      async request(kind) {
        h.permissionRequests.push(kind);
        if (h.grantOnRequest) h.permission[kind] = { status: 'granted', canAskAgain: true };
        return h.permission[kind];
      },
    },
    native: {
      /**
       * Session-scoped native recorder, mirroring the production binding contract:
       * every session owns its own result promise, stop and release.
       */
      openSession({ sessionId, kind }) {
        const ended = deferred();
        h.ended.set(kind, ended); // the CURRENT session's result for this kind
        const record = {
          sessionId,
          kind,
          started: false,
          stopCalls: 0,
          released: false,
          ended,
          autoStop: null,
          resolveEndedOnRelease: null,
        };
        h.openSessions.push(record);
        return {
          sessionId,
          kind,
          async start(options) {
            if (kind === 'audio') h.prepareCalls.push('audio');
            h.startCalls.push({ kind, options, sessionId });
            if (h.gateStart) {
              const gate = h.gateStart;
              h.gateStart = null;
              await gate.promise;
            }
            if (h.failStartFor === sessionId) throw new Error('start failed');
            record.started = true;
          },
          async stop() {
            record.stopCalls += 1;
            h.stopCalls.push(kind);
            h.stopSessions.push(sessionId);
            if (h.gateStop) {
              const gate = h.gateStop;
              h.gateStop = null;
              await gate.promise;
            }
          },
          async recordingEnded() {
            return record.ended.promise;
          },
          onAutoStop(callback) {
            record.autoStop = callback;
            h.autoStop = callback;
            return () => {
              if (record.autoStop === callback) record.autoStop = null;
              if (h.autoStop === callback) h.autoStop = null;
            };
          },
          async release() {
            record.released = true;
            h.releaseCalls.push(kind);
            h.releasedSessionIds.push(sessionId);
            if (h.gateRelease) {
              const gate = h.gateRelease;
              h.gateRelease = null;
              await gate.promise;
            }
            // Production release settles a pending take with its result so a late
            // native URI is reported exactly once.
            if (record.resolveEndedOnRelease !== null) {
              record.ended.resolve(record.resolveEndedOnRelease);
              record.resolveEndedOnRelease = null;
            }
          },
        };
      },
    },
    files: {
      async size(uri) {
        return h.sizes.has(uri) ? h.sizes.get(uri) : null;
      },
      async remove(uri) {
        h.removed.push(uri);
      },
    },
    clock: { monotonicMs: () => h.nowMs },
    identity: {
      authorize(input) {
        h.authorizeCalls.push(input);
        return h.authorize ? h.authorize(input) : null;
      },
    },
    repository: {
      async adoptCapture(result, owner) {
        if (h.gateAdopt) await h.gateAdopt.promise;
        if (h.adoptResult) return h.adoptResult;
        const draft = {
          id: `local-media-00000000-0000-4000-8000-00000000000${h.adopted.length + 1}`,
          kind: result.kind,
          owner: { ...owner },
          stagingPath: `/staging/${owner.sessionId}/recording.m4a`,
          fileName: 'recording.m4a',
          mimeType: result.mimeType,
          sizeBytes: h.sizes.get(result.uri),
          durationMs: result.durationMs,
          createdAt: '2026-09-11T12:00:00.000Z',
        };
        h.adopted.push(draft);
        return { ok: true, draft };
      },
      async discard(draft) {
        h.discarded.push(draft.id);
        return { removed: [draft.stagingPath], failed: [] };
      },
    },
    ids: {
      sessionId() {
        h.sessionIds += 1;
        return `session-00000000-0000-4000-8000-00000000000${h.sessionIds}`;
      },
    },
  };

  return { h, ports, controller: createRecorderController(ports), h_repository: ports.repository };
}

function audioResult(uri, sizeBytes, durationMs, mimeType = 'audio/mp4') {
  return { uri, kind: 'audio', mimeType, durationMs, reportedSizeBytes: sizeBytes };
}

function videoResult(uri, sizeBytes, durationMs, mimeType = 'video/mp4') {
  return { uri, kind: 'video', mimeType, durationMs, width: 720, height: 1280 };
}

/**
 * Wait until the controller left every transient state. The production
 * validation chain awaits the file port, so tests must flush it (never assume a
 * fixed number of microtasks).
 */
/** Let pending native promise callbacks run. */
async function flush(turns = 3) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function settle(controller) {
  const transient = new Set([
    'preparing',
    'starting',
    'stopping',
    'validating-file',
    'adopting',
    'cancelling',
    'requesting-permission',
  ]);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (!transient.has(controller.getSnapshot().state)) return controller.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`settle timeout in state ${controller.getSnapshot().state}`);
}

test('no startup prompt: granted permission is read, never requested, and one tap starts audio', async () => {
  const { h, controller } = harness();
  assert.equal(controller.getSnapshot().state, 'idle');
  assert.deepEqual(h.permissionGets, []); // opening the controller does not prompt or read

  const pending = controller.startAudio(IDENTITY);
  await pending;
  assert.deepEqual(h.permissionGets, ['audio']);
  assert.deepEqual(h.permissionRequests, []); // already granted -> no prompt
  assert.deepEqual(h.prepareCalls, ['audio']);
  assert.equal(h.startCalls.length, 1);
  assert.equal(h.startCalls[0].options.forDurationSeconds, AUDIO_MAX / 1000);
  assert.equal(controller.getSnapshot().state, 'recording');
  assert.equal(controller.getSnapshot().recording, true);
});

test('an undetermined permission is requested exactly once, then recording starts', async () => {
  const { h, controller } = harness();
  h.permission.audio = { status: 'undetermined', canAskAgain: true };
  h.grantOnRequest = true; // the user grants the prompt
  await controller.startAudio(IDENTITY);
  assert.deepEqual(h.permissionRequests, ['audio']);
  assert.equal(controller.getSnapshot().state, 'recording');
});

test('denied / restricted / error permissions never prepare or start capture', async () => {
  const cases = [
    ['denied', { status: 'denied', canAskAgain: true }, 'denied', 'permission-denied'],
    ['restricted', { status: 'restricted', canAskAgain: false }, 'denied', 'permission-restricted'],
  ];
  for (const [name, permission, state, code] of cases) {
    const { h, controller } = harness();
    h.permission.audio = permission;
    await controller.startAudio(IDENTITY);
    assert.equal(controller.getSnapshot().state, state, name);
    assert.equal(controller.getSnapshot().error.code, code, name);
    assert.deepEqual(h.prepareCalls, [], name);
    assert.deepEqual(h.startCalls, [], name);
  }
  // A native permission exception surfaces as a typed error, not a crash.
  const { h, ports, controller } = harness();
  ports.permissions.get = async () => {
    throw new Error('boom');
  };
  await controller.startAudio(IDENTITY);
  assert.equal(controller.getSnapshot().state, 'error');
  assert.equal(controller.getSnapshot().error.code, 'permission-error');
  assert.deepEqual(h.startCalls, []);
});

test('video: one record tap starts, the same control stops, and stop never waits for the long take', async () => {
  const { h, controller } = harness();
  await controller.openVideo(IDENTITY);
  assert.deepEqual(h.permissionGets, ['video', 'audio']); // camera, then microphone
  assert.equal(controller.getSnapshot().state, 'ready');
  assert.equal(h.startCalls.length, 0); // opening the camera never records

  await controller.startVideoRecording();
  assert.equal(controller.getSnapshot().state, 'recording');
  assert.equal(h.startCalls[0].options.forDurationSeconds, VIDEO_MAX / 1000);

  // The ended promise is still pending: stop must return immediately.
  await controller.stop();
  assert.deepEqual(h.stopCalls, ['video']);
  assert.equal(controller.getSnapshot().state, 'stopping');

  h.sizes.set('file://video-1.mp4', 5_000_000);
  h.ended.get('video').resolve(videoResult('file://video-1.mp4', 5_000_000, 12_000));
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');
  assert.equal(controller.getSnapshot().take.mimeType, 'video/mp4');
  assert.equal(controller.getSnapshot().take.durationMs, 12_000);
});

test('duplicate start/stop taps settle at most once', async () => {
  const { h, ports, controller } = harness();
  const gate = deferred();
  h.gatePrepare = gate;
  const first = controller.startAudio(IDENTITY);
  h.gatePrepare = null;
  const second = controller.startAudio(IDENTITY); // gate is busy -> refused
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(h.prepareCalls, ['audio']);
  assert.equal(h.startCalls.length, 1);

  h.sizes.set('file://audio-1.m4a', 1_000);
  await controller.stop();
  await controller.stop(); // second stop is refused by the state guard
  assert.deepEqual(h.stopCalls, ['audio']);
  h.ended.get('audio').resolve(audioResult('file://audio-1.m4a', 1_000, 5_000));
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');
  assert.ok(ports);
});

test('native auto-stop and the manual stop settle the take exactly once', async () => {
  const { h, controller } = harness();
  h.sizes.set('file://audio-2.m4a', 2_000);
  await controller.startAudio(IDENTITY);
  assert.equal(typeof h.autoStop, 'function');
  h.autoStop(); // native limit reached
  await controller.stop().catch(() => {});
  h.ended.get('audio').resolve(audioResult('file://audio-2.m4a', 2_000, AUDIO_MAX));
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview'); // exactly one take
  // A second late resolution cannot create a second take or state change.
  h.ended.get('audio').resolve(audioResult('file://audio-2.m4a', 2_000, AUDIO_MAX));
  await Promise.resolve();
  assert.equal(controller.getSnapshot().take.durationMs, AUDIO_MAX);
});

test('native auto-stop without a result is a capture failure, never a fake take', async () => {
  const { h, controller } = harness();
  await controller.startAudio(IDENTITY);
  h.autoStop();
  h.ended.get('audio').resolve(undefined);
  await flush();
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'error');
  assert.equal(controller.getSnapshot().error.code, 'capture-failed');
  assert.equal(controller.getSnapshot().take, null);
  assert.ok(h.releaseCalls.includes('audio'));
});

test('finalized file validation: exact limits pass, over-limit/unknown/wrong MIME are rejected', async () => {
  const cases = [
    ['audio', 25_165_824, AUDIO_MAX, 'audio/mp4', 'preview', null],
    ['audio', 25_165_825, AUDIO_MAX, 'audio/mp4', 'error', 'file-too-large'],
    ['audio', 1_000, AUDIO_MAX + 1, 'audio/mp4', 'error', 'duration-too-long'],
    ['audio', 0, 1_000, 'audio/mp4', 'error', 'capture-empty'],
    ['audio', 1_000, 0, 'audio/mp4', 'error', 'duration-unknown'],
    ['audio', 1_000, null, 'audio/mp4', 'error', 'duration-unknown'],
    ['audio', 1_000, 1_000, 'audio/webm', 'error', 'mime-unsupported'],
  ];
  for (const [kind, size, duration, mime, expectedState, expectedCode] of cases) {
    const { h, controller } = harness();
    const uri = `file://take-${kind}-${size}-${duration}-${mime}.m4a`;
    h.sizes.set(uri, size);
    await controller.startAudio(IDENTITY);
    await controller.stop();
    h.ended.get('audio').resolve({
      uri,
      kind: 'audio',
      mimeType: mime,
      durationMs: duration,
    });
    await settle(controller);
    assert.equal(controller.getSnapshot().state, expectedState, `${size}/${duration}/${mime}`);
    if (expectedCode) assert.equal(controller.getSnapshot().error.code, expectedCode);
  }
});

test('the timer is monotonic, survives clock changes and enforces the deadline once', async () => {
  const { h, controller } = harness();
  const startedAt = h.nowMs;
  await controller.startAudio(IDENTITY);
  h.nowMs += 5_000;
  controller.tick();
  assert.equal(controller.getSnapshot().elapsedMs, 5_000);

  // A wall-clock jump backwards must not produce a negative elapsed value.
  h.nowMs -= 60_000;
  controller.tick();
  assert.equal(controller.getSnapshot().elapsedMs, 0);

  // The controller deadline requests the native stop exactly once.
  h.nowMs = startedAt + AUDIO_MAX + 1;
  controller.tick();
  controller.tick();
  controller.tick();
  assert.deepEqual(h.stopCalls, ['audio']);
});

test('interruption/background stops capture once and never auto-resumes', async () => {
  const { h, controller } = harness();
  await controller.startAudio(IDENTITY);
  controller.setAppState('background');
  assert.deepEqual(h.stopCalls, ['audio']);
  controller.setAppState('background');
  assert.deepEqual(h.stopCalls, ['audio']); // once only
  controller.setAppState('active');
  assert.equal(h.startCalls.length, 1); // no automatic resume
  assert.equal(controller.appState(), 'active');
});

test('an inactive app never starts a capture but keeps the surface usable', async () => {
  const { h, controller } = harness();
  controller.setAppState('inactive');
  await controller.startAudio(IDENTITY);
  // Nothing may be prepared or started while the app is not active.
  assert.deepEqual(h.prepareCalls, []);
  assert.deepEqual(h.startCalls, []);
  assert.equal(controller.getSnapshot().state, 'idle');
  assert.equal(controller.getSnapshot().recording, false);
  assert.equal(h.openSessions.length, 1); // the session exists but released its handle
  assert.equal(h.openSessions[0].released, true);
});

test('cancel during recording cleans the take and ignores the late native result', async () => {
  const { h, controller } = harness();
  await controller.startAudio(IDENTITY);
  await controller.cancel();
  assert.equal(controller.getSnapshot().state, 'cancelled');
  h.sizes.set('file://late.m4a', 1_000);
  h.ended.get('audio').resolve(audioResult('file://late.m4a', 1_000, 3_000));
  await flush();
  await settle(controller);
  assert.equal(controller.getSnapshot().take, null); // never attached
  assert.ok(h.removed.includes('file://late.m4a')); // late URI cleaned
  assert.ok(h.releaseCalls.includes('audio'));
});

test('cancel while adopting discards the freshly adopted draft', async () => {
  const { h, controller } = harness();
  h.sizes.set('file://take.m4a', 4_000);
  await controller.startAudio(IDENTITY);
  await controller.stop();
  h.ended.get('audio').resolve(audioResult('file://take.m4a', 4_000, 8_000));
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');

  const gate = deferred();
  h.gateAdopt = gate;
  const adopting = controller.useTake();
  await controller.cancel();
  gate.resolve();
  const outcome = await adopting;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'cancelled');
  assert.equal(h.discarded.length, 1); // the just-adopted copy was cleaned
  assert.equal(controller.getSnapshot().state, 'cancelled');
});

test('useTake adopts the previewed take, removes the native temp and returns the draft', async () => {
  const { h, controller } = harness();
  await controller.startAudio(IDENTITY);
  await controller.stop();
  h.sizes.set('file://good.m4a', 6_000);
  h.ended.get('audio').resolve(audioResult('file://good.m4a', 6_000, 9_000));
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');

  const outcome = await controller.useTake();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.draft.kind, 'audio');
  assert.equal(outcome.draft.owner.sheetKey, IDENTITY.sheetKey);
  assert.equal(outcome.draft.owner.draftKey, IDENTITY.draftKey);
  assert.equal(outcome.draft.owner.entryId, null);
  assert.equal(typeof outcome.draft.owner.sessionId, 'string');
  assert.equal(outcome.draft.owner.generation > 0, true);
  assert.equal(controller.getSnapshot().state, 'attached');
  assert.ok(h.removed.includes('file://good.m4a')); // native temp cleaned after adoption
});

test('re-record cleans only the uncommitted take and returns to ready', async () => {
  const { h, controller } = harness();
  await controller.openVideo(IDENTITY);
  await controller.startVideoRecording();
  await controller.stop();
  h.sizes.set('file://abandoned.mov', 7_000);
  h.ended.get('video').resolve(videoResult('file://abandoned.mov', 7_000, 4_000, 'video/quicktime'));
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');

  await controller.reRecord();
  assert.equal(controller.getSnapshot().state, 'ready'); // camera ready again
  assert.equal(controller.getSnapshot().take, null);
  assert.ok(h.removed.includes('file://abandoned.mov'));
  assert.deepEqual(h.discarded, []); // nothing was committed, nothing committed was touched
});

test('returning from Settings refreshes a denied permission without auto-recording', async () => {
  const { h, controller } = harness();
  h.permission.audio = { status: 'denied', canAskAgain: false };
  await controller.startAudio(IDENTITY);
  assert.equal(controller.getSnapshot().state, 'denied');
  assert.deepEqual(h.permissionRequests, ['audio']); // asked once while requestable? not here

  // The user grants access in Settings and returns.
  h.permission.audio = { status: 'granted', canAskAgain: true };
  await controller.refreshPermission();
  assert.equal(controller.getSnapshot().permission.status, 'granted');
  assert.equal(controller.getSnapshot().state, 'ready');
  assert.equal(h.startCalls.length, 0); // never records automatically
});

test('a stale recorder whose editor was replaced cannot attach; its take is cleaned', async () => {
  const { h, controller } = harness();
  await controller.startAudio(IDENTITY);
  await controller.stop();
  h.sizes.set('file://a.m4a', 4_000);
  h.ended.get('audio').resolve(audioResult('file://a.m4a', 4_000, 8_000));
  await flush();
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');
  const captured = controller.getOwner();
  assert.equal(captured !== null, true);

  // Editor B replaced A (new sheet/revision/session): the authoritative check refuses.
  h.authorize = () => mediaFailure('busy');
  const outcome = await controller.useTake();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'busy');
  assert.equal(h.adopted.length, 0); // nothing was adopted for B
  assert.ok(h.removed.includes('file://a.m4a')); // the stale take was cleaned
  assert.equal(controller.getSnapshot().take, null);
  assert.equal(controller.getSnapshot().state, 'cancelled');
});

test('a take adopted just before the editor was replaced is discarded, never attached', async () => {
  const { h, controller } = harness();
  await controller.startAudio(IDENTITY);
  await controller.stop();
  h.sizes.set('file://late-owner.m4a', 4_000);
  h.ended.get('audio').resolve(audioResult('file://late-owner.m4a', 4_000, 8_000));
  await flush();
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');

  // Allowed before the await, refused after it (the draft changed underneath).
  let calls = 0;
  h.authorize = () => {
    calls += 1;
    return calls === 1 ? null : mediaFailure('busy');
  };
  const outcome = await controller.useTake();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'busy');
  assert.equal(h.discarded.length, 1); // the adopted copy was cleaned
  assert.equal(h.adopted.length, 1);
  assert.equal(controller.getSnapshot().state, 'cancelled');
  assert.equal(controller.getSnapshot().take, null);
});

test('cancel during start keeps cleanup for the late native URI and discards it exactly once', async () => {
  const { h, controller } = harness();
  const gate = deferred();
  h.gateStart = gate;
  const starting = controller.startAudio(IDENTITY);
  // Let permission + prepare finish so the native start is genuinely in flight.
  await flush();
  assert.equal(h.startCalls.length, 1); // the native start is genuinely in flight
  assert.equal(controller.getSnapshot().state, 'preparing');
  const cancelling = controller.cancel();
  gate.resolve();
  await Promise.all([starting, cancelling]);
  assert.equal(controller.getSnapshot().state, 'cancelled');

  h.ended.get('audio').resolve(audioResult('file://late-start.m4a', 1_000, 3_000));
  await flush();
  assert.equal(controller.getSnapshot().state, 'cancelled'); // never preview
  assert.equal(controller.getSnapshot().take, null);
  assert.equal(h.removed.filter((uri) => uri === 'file://late-start.m4a').length, 1);
});

test('cancel during stop/finalization cannot publish preview and keeps no temp file', async () => {
  const { h, controller } = harness();
  await controller.startAudio(IDENTITY);
  await controller.stop();
  assert.equal(controller.getSnapshot().state, 'stopping');
  await controller.cancel(); // cancelled while the native finalization is pending
  h.sizes.set('file://finalize.m4a', 4_000);
  h.ended.get('audio').resolve(audioResult('file://finalize.m4a', 4_000, 8_000));
  await flush();
  assert.equal(controller.getSnapshot().state, 'cancelled');
  assert.equal(controller.getSnapshot().take, null);
  assert.ok(h.removed.includes('file://finalize.m4a'));
  assert.equal(h.adopted.length, 0);
});

test('re-record is refused while a finalization is still in flight (no stale preview)', async () => {
  const { h, controller } = harness();
  await controller.openVideo(IDENTITY);
  await controller.startVideoRecording();
  await controller.stop();
  assert.equal(controller.getSnapshot().state, 'stopping');

  // Re-record cannot start a new session over an unsettled finalization.
  await controller.reRecord();
  assert.equal(controller.getSnapshot().state, 'stopping');
  assert.deepEqual(h.releaseCalls, []);

  // The in-flight finalization settles normally exactly once.
  h.sizes.set('file://only.mov', 5_000);
  h.ended.get('video').resolve(videoResult('file://only.mov', 5_000, 4_000));
  await flush();
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');
  assert.equal(controller.getSnapshot().take.uri, 'file://only.mov');
});

test('re-record after a preview discards the take and a later session cannot reuse it', async () => {
  const { h, controller } = harness();
  await controller.openVideo(IDENTITY);
  await controller.startVideoRecording();
  await controller.stop();
  h.sizes.set('file://first.mov', 5_000);
  h.ended.get('video').resolve(videoResult('file://first.mov', 5_000, 4_000));
  await flush();
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');

  await controller.reRecord();
  assert.equal(controller.getSnapshot().state, 'ready');
  assert.equal(controller.getSnapshot().take, null);
  assert.ok(h.removed.includes('file://first.mov')); // the abandoned take was cleaned

  // A NEW session records again and only its own result can be previewed.
  await controller.startVideoRecording();
  assert.equal(controller.getSnapshot().state, 'recording');
  assert.equal(controller.getSnapshot().take, null);
});

test('video requires BOTH camera and microphone; refreshing one never reaches ready', async () => {
  const { h, controller } = harness();
  h.permission.video = { status: 'granted', canAskAgain: true };
  h.permission.audio = { status: 'denied', canAskAgain: false };
  await controller.openVideo(IDENTITY);
  assert.equal(controller.getSnapshot().state, 'denied');
  assert.equal(controller.getSnapshot().error.code, 'permission-denied');
  assert.deepEqual(h.prepareCalls, []); // the camera never becomes recordable
  assert.deepEqual(h.startCalls, []);

  // Settings return: camera still granted, microphone still denied -> denied.
  await controller.refreshPermission();
  assert.notEqual(controller.getSnapshot().state, 'ready');
  assert.equal(controller.getSnapshot().error.code, 'permission-denied');

  // Both usable -> ready, still without recording.
  h.permission.audio = { status: 'granted', canAskAgain: true };
  await controller.refreshPermission();
  assert.equal(controller.getSnapshot().state, 'ready');
  assert.equal(h.startCalls.length, 0);
});

test('a stale same-kind permission completion cannot revive a replaced session', async () => {
  const { h, controller } = harness();
  h.permission.audio = { status: 'denied', canAskAgain: false };
  await controller.startAudio(IDENTITY);
  assert.equal(controller.getSnapshot().state, 'denied');

  // Session 1's refresh is still pending when session 2 opens.
  const gate = deferred();
  h.permission.audio = { status: 'granted', canAskAgain: true };
  h.gatePermissionGet = gate;
  const refreshing = controller.refreshPermission();
  await controller.startAudio(IDENTITY); // session 2
  assert.equal(controller.getSnapshot().state, 'recording');
  gate.resolve();
  await refreshing;
  // The stale result from session 1 must not have changed session 2 at all.
  assert.equal(controller.getSnapshot().state, 'recording');
  assert.equal(h.startCalls.length, 1);
});

test('cancel while releaseNative is pending never resurrects preview (exact interleaving)', async () => {
  const { h, controller } = harness();
  const gate = deferred();
  h.gateRelease = gate; // armed BEFORE the take so the release cannot slip past it
  await controller.startAudio(IDENTITY);
  h.sizes.set('file://release.m4a', 4_000);
  h.ended.get('audio').resolve(audioResult('file://release.m4a', 4_000, 9_000));
  await flush(2);
  assert.equal(controller.getSnapshot().state, 'validating-file');

  // Cancel while releaseNative is still pending...
  const cancelling = controller.cancel();
  await flush(2);
  gate.resolve();                    // ...then let it resolve.
  await cancelling;
  await flush();

  assert.equal(controller.getSnapshot().state, 'cancelled'); // no preview resurrection
  assert.equal(controller.getSnapshot().take, null);
  assert.equal(controller.getSnapshot().durationMs, null);
  assert.equal(h.removed.filter((uri) => uri === 'file://release.m4a').length, 1); // once
  assert.equal(h.adopted.length, 0);
});

test('ownership transfer: after Use succeeds, recorder teardown never deletes the editor-owned take', async () => {
  const { h, controller } = harness();
  await controller.startAudio(IDENTITY);
  await controller.stop();
  h.sizes.set('file://transfer.m4a', 4_000);
  h.ended.get('audio').resolve(audioResult('file://transfer.m4a', 4_000, 8_000));
  await flush();
  await settle(controller);
  assert.equal(controller.getSnapshot().state, 'preview');

  const outcome = await controller.useTake();
  assert.equal(outcome.ok, true);
  const transferred = outcome.draft;
  assert.equal(h.adopted.length, 1);

  // The recorder surface now unmounts: cancel() must not touch the transferred take.
  await controller.cancel();
  assert.equal(controller.getSnapshot().state, 'cancelled');
  assert.deepEqual(h.discarded, []); // nothing the editor owns was deleted
  assert.equal(h.adopted.length, 1);

  // The editor still owns a valid, adoptable take.
  assert.equal(transferred.stagingPath.startsWith('/staging/'), true);
  assert.equal(h.removed.includes('file://transfer.m4a'), true); // only the native temp went
});

test('ownership transfer: an editor that abandons the transferred take cleans it explicitly', async () => {
  const { h, controller, h_repository: repositoryPort } = harness();
  await controller.startAudio(IDENTITY);
  await controller.stop();
  h.sizes.set('file://abandon.m4a', 4_000);
  h.ended.get('audio').resolve(audioResult('file://abandon.m4a', 4_000, 8_000));
  await flush();
  await settle(controller);
  const outcome = await controller.useTake();
  assert.equal(outcome.ok, true);

  // The editor abandons it (the sheet/runtime path, driven here through the
  // controller-owned repository port with the SAME draft).
  const cleanup = await repositoryPort.discard(outcome.draft);
  assert.equal(cleanup.removed.includes(outcome.draft.stagingPath), true);
  assert.equal(h.discarded.includes(outcome.draft.id), true);
});

test('a revoked microphone throws video out of ready and start rejects without a native call', async () => {
  const { h, controller } = harness();
  h.permission.video = { status: 'granted', canAskAgain: true };
  h.permission.audio = { status: 'granted', canAskAgain: true };
  await controller.openVideo(IDENTITY);
  assert.equal(controller.getSnapshot().state, 'ready');

  // Revoked while ready: Settings return must derive readiness from BOTH.
  h.permission.audio = { status: 'denied', canAskAgain: false };
  await controller.refreshPermission();
  assert.equal(controller.getSnapshot().state, 'denied');
  assert.equal(controller.getSnapshot().error.code, 'permission-denied');

  const startsBefore = h.startCalls.length;
  await controller.startVideoRecording();
  assert.equal(h.startCalls.length, startsBefore); // no native capture call at all
  assert.deepEqual(h.prepareCalls, []); // nothing was prepared for recording either

  // Restoring both makes it ready again, still without recording.
  h.permission.audio = { status: 'granted', canAskAgain: true };
  await controller.refreshPermission();
  assert.equal(controller.getSnapshot().state, 'ready');
  assert.equal(h.startCalls.length, startsBefore);
});

test('losing the camera while ready also blocks startVideoRecording', async () => {
  const { h, controller } = harness();
  await controller.openVideo(IDENTITY);
  assert.equal(controller.getSnapshot().state, 'ready');
  h.permission.video = { status: 'denied', canAskAgain: false };
  await controller.refreshPermission();
  assert.equal(controller.getSnapshot().state, 'denied');
  await controller.startVideoRecording();
  assert.equal(h.startCalls.length, 0);
});
