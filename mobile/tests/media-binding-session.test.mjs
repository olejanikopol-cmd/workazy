import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorderPortsFromDeps } from '../src/services/media/recorderBindingsCore.ts';
import { createRecorderController } from '../src/services/media/recorderController.ts';
import { createRecorderSurfaceLifecycle } from '../src/services/media/recorderSurfaceLifecycle.ts';
import { createRecorderHardwareCoordinator } from '../src/services/media/recorderHardwareCoordinator.ts';

const AUDIO_MAX = 900_000;
const SHEET_A = { sheetKey: 'sheet-A', entryId: null, draftKey: 'draft-A', draftRevision: 0 };
const SHEET_B = { sheetKey: 'sheet-B', entryId: null, draftKey: 'draft-B', draftRevision: 0 };
const SHEET_C = { sheetKey: 'sheet-C', entryId: null, draftKey: 'draft-C', draftRevision: 0 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (turns = 8) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const waitFor = async (predicate, what) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * Fake NATIVE dependencies for the REAL binding core. Every gate is awaited INSIDE
 * the exact production operation it claims to pause, and each operation records
 * when it started and when it finished, so ordering can be asserted.
 */
function fakeNative(options = {}) {
  const native = {
    mode: 'idle',
    recording: false,
    durationMillis: 0,
    uri: null,
    listener: null,
    lifecycleAuthorized: true,
    ops: [],
    enableCalls: 0,
    restoreCalls: 0,
    prepareCalls: 0,
    startCalls: 0,
    stopCalls: 0,
    probeDurationMs: options.probeDurationMs ?? 5_000,
    probeFails: options.probeFails ?? false,
    cameraRecords: 0,
    gateEnable: options.gateEnable ?? null,
    gatePrepare: options.gatePrepare ?? null,
    gateStart: options.gateStart ?? null,
    gateStop: options.gateStop ?? null,
    gateRestore: options.gateRestore ?? null,
    gateCamera: options.gateCamera ?? null,
    sessionIds: [],
    timer: null,
  };

  /** Suspends the operation at the gate and records the pause/resume order. */
  async function gate(property, label) {
    const pending = native[property];
    if (pending === null) return;
    native[property] = null;
    native.ops.push(`${label}:paused`);
    await pending.promise;
    native.ops.push(`${label}:resumed`);
  }

  const device = {
    async enableRecordingMode() {
      native.enableCalls += 1;
      native.ops.push('enable:start');
      await gate('gateEnable', 'enable');
      native.mode = 'recording';
      native.ops.push('enable:done');
    },
    async restorePlaybackMode() {
      native.restoreCalls += 1;
      native.ops.push('restore:start');
      await gate('gateRestore', 'restore');
      native.mode = 'playback';
      native.ops.push('restore:done');
    },
    async prepareRecording() {
      native.prepareCalls += 1;
      native.ops.push('prepare:start');
      await gate('gatePrepare', 'prepare');
      native.ops.push('prepare:done');
    },
    startRecording() {
      native.startCalls += 1;
      native.ops.push('start');
      native.recording = true;
      native.durationMillis = 0;
    },
    async stopRecording() {
      native.stopCalls += 1;
      native.ops.push('stop:start');
      await gate('gateStop', 'stop');
      native.recording = false;
      native.durationMillis = 0;
      native.ops.push('stop:done');
    },
    status: () => ({
      durationMillis: native.durationMillis,
      isRecording: native.recording,
      url: native.uri,
    }),
    uri: () => native.uri,
    setStatusListener: (listener) => {
      native.listener = listener;
      native.ops.push(listener === null ? 'listener:null' : 'listener:set');
    },
  };

  const deps = {
    audio: device,
    video: {
      getDevice: () => ({
        record: async () => {
          native.cameraRecords += 1;
          native.ops.push('camera:record');
          await gate('gateCamera', 'camera-record');
          return await new Promise((resolve) => {
            native.cameraPending = resolve;
          });
        },
        stopRecording: () => {
          native.ops.push('camera:stop');
          const pending = native.cameraPending;
          native.cameraPending = null;
          pending?.({ uri: 'file://camera.mp4' });
        },
      }),
    },
    probeFinalAudioDurationMs: async (uri) => {
      native.ops.push(`probe:${uri}`);
      return native.probeFails ? null : native.probeDurationMs;
    },
    probeVideoDurationMs: async () => options.videoDurationMs ?? 4_000,
    permissions: {
      get: async () => ({ status: 'granted', canAskAgain: true }),
      request: async () => ({ status: 'granted', canAskAgain: true }),
    },
    files: {
      size: async () => options.sizeBytes ?? 4_000,
      remove: async (uri) => {
        native.removed = [...(native.removed ?? []), uri];
      },
    },
    clock: { monotonicMs: () => 1_000 },
    repository: {
      adoptCapture: async (result) => {
        const draft = {
          id: `local-media-0000000${native.drafts === undefined ? 1 : native.drafts.length + 1}-0000-4000-8000-000000000000`,
          kind: result.kind,
          owner: { ...SHEET_A, sessionId: 'session-x', generation: 1 },
          stagingPath: `/staging/${result.kind}.m4a`,
          fileName: 'recording.m4a',
          mimeType: result.mimeType,
          sizeBytes: options.sizeBytes ?? 4_000,
          durationMs: result.durationMs,
          createdAt: '2026-09-11T12:00:00.000Z',
        };
        native.drafts = [...(native.drafts ?? []), draft];
        return { ok: true, draft };
      },
      discard: async (draft) => {
        native.discarded = [...(native.discarded ?? []), draft.id];
        return { removed: [], failed: [] };
      },
    },
    identity: { authorize: () => null },
    createSessionId: () => {
      const id = `session-${String(native.sessionIds.length + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
      native.sessionIds.push(id);
      return id;
    },
    schedule: () => () => undefined,
    mimeForUri: (uri, kind) => (kind === 'audio' ? 'audio/mp4' : 'video/mp4'),
    isLifecycleAuthorized: () => native.lifecycleAuthorized,
  };

  return { native, deps };
}

/** One binding instance (a recorder surface) sharing the given coordinator. */
function surface(native, deps, coordinator) {
  const controller = createRecorderController(createRecorderPortsFromDeps(deps, coordinator));
  return { native, controller };
}

function withHardware(options = {}) {
  const coordinator = createRecorderHardwareCoordinator();
  const fake = fakeNative(options);
  return { coordinator, ...fake, ...surface(fake.native, fake.deps, coordinator) };
}

/** Finish an automatic audio stop with a finalized file duration. */
function autoStop(native, uri) {
  native.uri = uri;
  native.recording = false;
  native.durationMillis = 0; // iOS resets the native duration
  native.listener?.({ isFinished: true, hasError: false, error: null, url: uri });
}

test('A: a delayed A stop cannot disturb B recording on the same hardware', async () => {
  const stopGate = deferred();
  const coordinator = createRecorderHardwareCoordinator();
  const fake = fakeNative({ gateStop: stopGate });
  // Two independent recorder surfaces over the SAME process-global hardware.
  const surfaceA = surface(fake.native, fake.deps, coordinator);
  const surfaceB = surface(fake.native, fake.deps, coordinator);
  const native = fake.native;

  await surfaceA.controller.startAudio(SHEET_A);
  assert.equal(surfaceA.controller.getSnapshot().state, 'recording');

  // A's stop really reaches the native stop and is paused there.
  const stoppingA = surfaceA.controller.stop();
  await waitFor(() => native.ops.includes('stop:paused'), 'A stop to be paused');
  assert.equal(native.recording, true); // A has not actually stopped yet

  // B (its own surface) starts while A settles the hardware: accepted, and it
  // records once the serialized handoff completes.
  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await flush(3);
  // The handoff means B's native start may not have happened yet...
  assert.equal(native.ops.includes('stop:resumed'), false);

  stopGate.resolve(); // A's stop finally completes
  await Promise.all([stoppingA, startingB]);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B to record');

  // A's late completion did not disturb B: it is recording and can stop normally.
  const stopsBefore = native.stopCalls;
  assert.equal(native.recording, true);
  await surfaceB.controller.stop();
  assert.equal(native.stopCalls, stopsBefore + 1);
  assert.equal(native.recording, false);
  // B (never A) owned the hardware, and once its take finalized the hardware is
  // free again with no lingering physical reservation.
  const sessionB = native.sessionIds.at(-1);
  assert.notEqual(coordinator.currentOwner()?.sessionId, 'session-00000001-0000-4000-8000-000000000000');
  assert.equal(coordinator.unresolvedReservationCount(), 0);
  assert.equal(coordinator.isOwner({ sessionId: 'session-00000001-0000-4000-8000-000000000000', epoch: 1, kind: 'audio' }), false);
  assert.equal(sessionB.startsWith('session-'), true);
});

test('B: a delayed A mode restore cannot leave B in playback mode', async () => {
  const restoreGate = deferred();
  const hardware = withHardware({ gateRestore: restoreGate });
  const { native, controller } = hardware;

  await controller.startAudio(SHEET_A);
  const cancellingA = controller.cancel();
  await waitFor(() => native.ops.includes('restore:paused'), 'A restore to be paused');

  // B starts while A's global mode restore is still in flight.
  const startingB = controller.startAudio(SHEET_B);
  restoreGate.resolve();
  await Promise.all([cancellingA, startingB]);
  await waitFor(() => controller.getSnapshot().state === 'recording', 'B to record');

  // The LAST global mode change is B's recording mode.
  assert.equal(native.mode, 'recording');
  assert.equal(native.recording, true);
});

test('C/D: a second binding instance cannot disable the first one’s recording hardware', async () => {
  const restoreGate = deferred();
  const coordinator = createRecorderHardwareCoordinator();
  const fake = fakeNative({ gateRestore: restoreGate });
  // Two independent recorder surfaces (two cores) over the SAME hardware.
  const surfaceA = surface(fake.native, fake.deps, coordinator);
  const surfaceB = surface(fake.native, fake.deps, coordinator);

  await surfaceA.controller.startAudio(SHEET_A);
  const cancellingA = surfaceA.controller.cancel();
  await waitFor(() => fake.native.ops.includes('restore:paused'), 'A restore to be paused');

  const startingB = surfaceB.controller.startAudio(SHEET_B);
  restoreGate.resolve();
  await Promise.all([cancellingA, startingB]);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B to record');

  // B owns the hardware: no stale completion from instance A may disable it.
  assert.equal(fake.native.mode, 'recording');
  assert.equal(fake.native.recording, true);
  assert.equal(coordinator.currentOwner()?.kind, 'audio');
  const owner = coordinator.currentOwner();
  assert.equal(owner !== null, true);
  assert.equal(surfaceA.controller.getSnapshot().state === 'recording', false);
});

test('prepare paused -> app backgrounds -> resume: no native start happens', async () => {
  const prepareGate = deferred();
  const hardware = withHardware({ gatePrepare: prepareGate });
  const { native, controller } = hardware;

  const starting = controller.startAudio(SHEET_A);
  await waitFor(() => native.ops.includes('prepare:paused'), 'prepare to be paused');

  // The app leaves the active state while the preparation is in flight.
  native.lifecycleAuthorized = false;
  prepareGate.resolve();
  await starting;
  await flush();

  assert.equal(native.startCalls, 0); // the native capture was never started
  assert.equal(native.recording, false);
  assert.equal(controller.getSnapshot().state, 'idle');
  assert.equal(controller.getSnapshot().recording, false);
  // Only this session's prepared resources were cleaned, and its mode restored.
  assert.equal(native.restoreCalls, 1);
});

test('video: re-record opens a FRESH native session and records again', async () => {
  const hardware = withHardware();
  const { native, controller } = hardware;

  await controller.openVideo(SHEET_A);
  assert.equal(controller.getSnapshot().state, 'ready');
  await controller.startVideoRecording();
  assert.equal(controller.getSnapshot().state, 'recording');
  assert.equal(native.cameraRecords, 1);
  const firstSession = native.sessionIds[0];

  // Stop: the take finalizes and the native handle is released and forgotten.
  await controller.stop();
  await waitFor(() => controller.getSnapshot().state === 'preview', 'video preview');

  // Re-record returns to a camera-ready state backed by a FRESH session.
  await controller.reRecord();
  assert.equal(controller.getSnapshot().state, 'ready');
  assert.equal(native.sessionIds.length, 2);
  assert.notEqual(native.sessionIds[1], firstSession);

  await controller.startVideoRecording();
  assert.equal(controller.getSnapshot().state, 'recording');
  assert.equal(native.cameraRecords, 2); // the disposed handle was never reused
});

test('audio: a finalized handle is never reused for the next take', async () => {
  const hardware = withHardware();
  const { native, controller } = hardware;

  await controller.startAudio(SHEET_A);
  autoStop(native, 'file://first.m4a');
  await waitFor(() => controller.getSnapshot().state === 'preview', 'audio preview');
  assert.equal(controller.getSnapshot().take.durationMs, 5_000);

  await controller.reRecord();
  assert.equal(controller.getSnapshot().state, 'ready');
  await controller.startAudio(SHEET_A); // the next take opens a fresh session
  assert.equal(controller.getSnapshot().state, 'recording');
  assert.equal(native.sessionIds.length, 2);
});

test('automatic completion uses the finalized-file duration, not the last poll', async () => {
  const hardware = withHardware({ probeDurationMs: 5_000 });
  const { native, controller } = hardware;
  await controller.startAudio(SHEET_A);
  native.recording = true;
  native.durationMillis = 4_750; // a stale lower sample exists
  autoStop(native, 'file://auto.m4a');
  await waitFor(() => controller.getSnapshot().state === 'preview', 'preview');
  assert.equal(controller.getSnapshot().take.durationMs, 5_000);
});

test('an over-limit finalized duration is rejected; the exact limit is accepted', async () => {
  const over = withHardware({ probeDurationMs: AUDIO_MAX + 1 });
  await over.controller.startAudio(SHEET_A);
  over.native.recording = true;
  over.native.durationMillis = AUDIO_MAX - 100;
  autoStop(over.native, 'file://over.m4a');
  await waitFor(() => over.controller.getSnapshot().state === 'error', 'over-limit error');
  assert.equal(over.controller.getSnapshot().error.code, 'duration-too-long');

  const exact = withHardware({ probeDurationMs: AUDIO_MAX });
  await exact.controller.startAudio(SHEET_A);
  autoStop(exact.native, 'file://exact.m4a');
  await waitFor(() => exact.controller.getSnapshot().state === 'preview', 'exact limit preview');
  assert.equal(exact.controller.getSnapshot().take.durationMs, AUDIO_MAX);
});

test('a take without an authoritative duration fails safely instead of using a poll sample', async () => {
  const hardware = withHardware({ probeFails: true });
  const { native, controller } = hardware;
  await controller.startAudio(SHEET_A);
  native.recording = true;
  native.durationMillis = 4_750;
  autoStop(native, 'file://noprobe.m4a');
  await waitFor(() => controller.getSnapshot().state === 'error', 'duration error');
  assert.equal(controller.getSnapshot().error.code, 'duration-unknown');
  assert.equal(controller.getSnapshot().take, null);
});

test('surface teardown after Use cannot delete the transferred take', async () => {
  const hardware = withHardware();
  const { native, controller } = hardware;
  await controller.startAudio(SHEET_A);
  autoStop(native, 'file://keep.m4a');
  await waitFor(() => controller.getSnapshot().state === 'preview', 'preview');
  const outcome = await controller.useTake();
  assert.equal(outcome.ok, true);

  let leaseReleased = 0;
  const lifecycle = createRecorderSurfaceLifecycle({
    releaseSessionLease: () => {
      leaseReleased += 1;
    },
    cancel: () => controller.cancel(),
  });
  await lifecycle.dispose();
  await lifecycle.dispose(); // idempotent
  assert.equal(leaseReleased, 1);
  assert.equal(controller.getSnapshot().state, 'cancelled');
  assert.equal((native.discarded ?? []).length, 0); // editor-owned take untouched
});

/**
 * A recorder SURFACE with its OWN fake native recorder, sharing one process-global
 * hardware coordinator (mirrors two surfaces / two recorder objects over one
 * process-global hardware).
 */
function recorderSurface({
  coordinator,
  label,
  ops,
  gateStop = null,
  gatePermission = null,
  gateRestore = null,
  modeState = null,
}) {
  let permissionGate = gatePermission;
  let restoreGate = gateRestore;
  const recorder = {
    label,
    recording: false,
    durationMillis: 0,
    uri: null,
    listener: null,
    mode: 'idle',
    startCalls: 0,
    stopCalls: 0,
    lifecycleAuthorized: true,
    sessionIds: [],
    /** Number of upcoming audio stop calls that must FAIL. */
    stopFailures: optionsStopFailures(),
    videoRecords: 0,
    videoCapturing: false,
    finishCamera: null,
  };
  function optionsStopFailures() {
    return 0;
  }
  let stopGate = gateStop;
  const deps = {
    audio: {
      // Both surfaces may share ONE process-global audio mode object, exactly like
      // the native setAudioModeAsync the production bindings share.
      enableRecordingMode: async () => {
        recorder.mode = 'recording';
        if (modeState !== null) modeState.current = 'recording';
        ops.push(`${label}:enable`);
      },
      restorePlaybackMode: async () => {
        ops.push(`${label}:restore:start`);
        if (restoreGate !== null) {
          const gate = restoreGate;
          restoreGate = null;
          ops.push(`${label}:restore:paused`); // paused INSIDE the real restore call
          await gate.promise;
          ops.push(`${label}:restore:resumed`);
        }
        recorder.mode = 'playback';
        if (modeState !== null) modeState.current = 'playback';
        ops.push(`${label}:restore:done`);
      },
      prepareRecording: async () => {
        ops.push(`${label}:prepare`);
      },
      startRecording: () => {
        recorder.startCalls += 1;
        recorder.recording = true;
        recorder.durationMillis = 0;
        ops.push(`${label}:start`);
      },
      stopRecording: async () => {
        recorder.stopCalls += 1;
        ops.push(`${label}:stop:requested`);
        if (recorder.stopFailures > 0) {
          recorder.stopFailures -= 1;
          ops.push(`${label}:stop:failed`);
          throw new Error('native stop failed'); // the capture keeps running
        }
        if (stopGate !== null) {
          const gate = stopGate;
          stopGate = null;
          ops.push(`${label}:stop:paused`);
          await gate.promise;
          ops.push(`${label}:stop:resumed`);
        }
        recorder.recording = false;
        recorder.durationMillis = 0;
        ops.push(`${label}:stop:done`);
      },
      status: () => ({
        durationMillis: recorder.durationMillis,
        isRecording: recorder.recording,
        url: recorder.uri,
      }),
      uri: () => recorder.uri,
      setStatusListener: (listener) => {
        recorder.listener = listener;
      },
    },
    video: {
      getDevice: () => ({
        record: async () => {
          recorder.videoRecords += 1;
          recorder.videoCapturing = true;
          ops.push(`${label}:camera:record`);
          // The capture stays physically live until the test settles this promise.
          return await new Promise((resolve, reject) => {
            recorder.finishCamera = {
              resolve: (uri = 'file://camera.mp4') => {
                recorder.videoCapturing = false;
                resolve(uri);
              },
              reject,
            };
          });
        },
        stopRecording: () => {
          ops.push(`${label}:camera:stop:requested`);
          if (recorder.cameraStopFails) throw new Error('camera stop request failed');
          // Only REQUESTS the stop: the capture ends when the completion settles.
        },
      }),
    },
    probeFinalAudioDurationMs: async () => 5_000,
    probeVideoDurationMs: async () => 4_000,
    permissions: {
      get: async () => {
        if (permissionGate !== null) {
          const gate = permissionGate;
          permissionGate = null;
          ops.push(`${label}:permission:paused`);
          await gate.promise;
          ops.push(`${label}:permission:resumed`);
        }
        return recorder.permissionState ?? { status: 'granted', canAskAgain: true };
      },
      request: async () => recorder.permissionState ?? { status: 'granted', canAskAgain: true },
    },
    files: { size: async () => 4_000, remove: async () => undefined },
    clock: { monotonicMs: () => 1_000 },
    repository: {
      adoptCapture: async (result) => ({
        ok: true,
        draft: {
          id: 'local-media-00000001-0000-4000-8000-000000000000',
          kind: result.kind,
          owner: { ...SHEET_A, sessionId: 'session-x', generation: 1 },
          stagingPath: '/staging/x.m4a',
          fileName: 'recording.m4a',
          mimeType: result.mimeType,
          sizeBytes: 4_000,
          durationMs: result.durationMs,
          createdAt: '2026-09-11T12:00:00.000Z',
        },
      }),
      discard: async () => ({ removed: [], failed: [] }),
    },
    identity: { authorize: () => null },
    createSessionId: () => {
      const id = `${label}-session-${String(recorder.sessionIds.length + 1).padStart(3, '0')}`;
      recorder.sessionIds.push(id);
      return id;
    },
    schedule: () => () => undefined,
    mimeForUri: (_uri, kind) => (kind === 'audio' ? 'audio/mp4' : 'video/mp4'),
    isLifecycleAuthorized: () => recorder.lifecycleAuthorized,
  };
  return {
    recorder,
    ops,
    controller: createRecorderController(createRecorderPortsFromDeps(deps, coordinator)),
  };
}

test('cancel A with a delayed stop: B cannot start until A physically stops', async () => {
  const stopGate = deferred();
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops, gateStop: stopGate });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });

  await surfaceA.controller.startAudio(SHEET_A);
  assert.equal(surfaceA.recorder.recording, true);

  const cancellingA = surfaceA.controller.cancel();
  await waitFor(() => ops.includes('A:stop:paused'), 'A stop to be paused inside its own hardware task');

  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await flush(4);
  // A is still physically recording, so B must not have started a capture.
  assert.equal(surfaceB.recorder.startCalls, 0);
  assert.equal(surfaceB.recorder.recording, false);

  stopGate.resolve();
  await Promise.all([cancellingA, startingB]);
  // A's physical stop executed...
  assert.equal(surfaceA.recorder.stopCalls >= 1, true);
  assert.equal(surfaceA.recorder.recording, false);
  // ...and only then did B start.
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording');
  assert.equal(surfaceB.recorder.recording, true);
  assert.equal(!!(surfaceA.recorder.recording && surfaceB.recorder.recording), false);
});

test('B starting while A still records physically stops A during the handoff', async () => {
  const stopGate = deferred();
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops, gateStop: stopGate });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });

  await surfaceA.controller.startAudio(SHEET_A);
  assert.equal(surfaceA.recorder.recording, true);

  // B asks for the hardware BEFORE A even begins its logical stop.
  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await waitFor(() => ops.includes('A:stop:paused'), 'the handoff to physically stop A');
  await flush(2);
  // B waits while A is still physically recording.
  assert.equal(surfaceB.recorder.startCalls, 0);
  assert.equal(surfaceA.recorder.recording, true);

  stopGate.resolve();
  await startingB;
  assert.equal(surfaceA.recorder.recording, false); // A was physically stopped
  assert.equal(surfaceA.recorder.stopCalls >= 1, true);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording');
  assert.equal(surfaceB.recorder.recording, true);
  assert.equal(surfaceA.recorder.recording, false);
});

test('audio: lifecycle revoked while the start waits in the hardware queue prevents native start', async () => {
  const stopGate = deferred();
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops, gateStop: stopGate });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });

  // A occupies the shared hardware queue with a paused stop.
  await surfaceA.controller.startAudio(SHEET_A);
  const cancellingA = surfaceA.controller.cancel();
  await waitFor(() => ops.includes('A:stop:paused'), 'A stop to be paused');

  // B's start request is queued behind it...
  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await flush(3);
  assert.equal(surfaceB.recorder.startCalls, 0);
  // ...and the app backgrounds while B waits in the queue.
  surfaceB.recorder.lifecycleAuthorized = false;

  stopGate.resolve();
  await Promise.all([cancellingA, startingB]);
  await flush(2);
  assert.equal(surfaceB.recorder.startCalls, 0); // the queued callback refused to start
  assert.equal(surfaceB.recorder.recording, false);
  assert.equal(surfaceB.controller.getSnapshot().state, 'idle');
});

test('video: lifecycle revoked while the start waits in the hardware queue prevents native start', async () => {
  const stopGate = deferred();
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops, gateStop: stopGate });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });

  await surfaceA.controller.startAudio(SHEET_A);
  const cancellingA = surfaceA.controller.cancel();
  await waitFor(() => ops.includes('A:stop:paused'), 'A stop to be paused');

  await surfaceB.controller.openVideo(SHEET_B);
  const startingB = surfaceB.controller.startVideoRecording();
  await flush(3);
  assert.equal(surfaceB.recorder.videoRecords ?? 0, 0); // queued behind A's stop
  surfaceB.recorder.lifecycleAuthorized = false;

  stopGate.resolve();
  await Promise.all([cancellingA, startingB]);
  await flush(2);
  assert.equal(surfaceB.recorder.videoRecords ?? 0, 0); // no native capture at all
  assert.notEqual(surfaceB.controller.getSnapshot().state, 'recording');
});

test('audio: a FAILED physical stop blocks the handoff until it is confirmed', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });
  surfaceA.recorder.stopFailures = 1; // A's first physical stop FAILS

  await surfaceA.controller.startAudio(SHEET_A);
  assert.equal(surfaceA.recorder.recording, true);

  // B asks for the hardware: the coordinator must attempt A's physical stop first.
  await surfaceB.controller.startAudio(SHEET_B);
  await flush(3);
  assert.equal(ops.includes('A:stop:failed'), true); // the stop really ran and failed
  assert.equal(surfaceA.recorder.recording, true); // the capture is still live
  assert.equal(surfaceB.recorder.startCalls, 0); // B never started a capture
  assert.equal(surfaceB.recorder.recording, false);
  assert.notEqual(surfaceB.controller.getSnapshot().state, 'recording');
  // The duty is retained and visible as a failed obligation.
  const dutyA = coordinator.physicalStopState({ sessionId: surfaceA.recorder.sessionIds[0], epoch: 1, kind: 'audio' });
  assert.equal(dutyA === 'failed' || dutyA === null, true);
  assert.equal(coordinator.hasPendingPhysicalStop({ sessionId: surfaceA.recorder.sessionIds[0], epoch: 1, kind: 'audio' }), true);

  // RETRY: the next start attempt re-runs A's physical stop, which now succeeds.
  await surfaceB.controller.startAudio(SHEET_B);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording after the retry');
  assert.equal(surfaceA.recorder.recording, false); // A is confirmed stopped
  assert.equal(surfaceA.recorder.stopCalls >= 2, true); // the stop was really retried
  assert.equal(surfaceB.recorder.recording, true);
  assert.equal(surfaceB.recorder.startCalls, 1);
});

test('video: the handoff waits for the ORIGINAL record() completion, not the stop command', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });

  await surfaceA.controller.openVideo(SHEET_A);
  await surfaceA.controller.startVideoRecording();
  assert.equal(surfaceA.recorder.videoCapturing, true);

  await surfaceB.controller.openVideo(SHEET_B);
  const startingB = surfaceB.controller.startVideoRecording();
  await waitFor(() => ops.includes('A:camera:stop:requested'), 'A stopRecording request');
  await flush(3);

  // The stop command resolved, but the capture is still physically live: B is blocked.
  assert.equal(surfaceA.recorder.videoCapturing, true);
  assert.equal(surfaceB.recorder.videoRecords, 0);
  assert.equal(!!(surfaceA.recorder.videoCapturing && surfaceB.recorder.videoRecords > 0), false);

  // Only the completion proves the capture ended; then B starts.
  surfaceA.recorder.finishCamera.resolve('file://a.mp4');
  await startingB;
  assert.equal(surfaceA.recorder.videoCapturing, false);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording');
  assert.equal(surfaceB.recorder.videoRecords, 1);
});

test('video: a rejecting completion keeps the handoff blocked (no second capture)', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });

  await surfaceA.controller.openVideo(SHEET_A);
  await surfaceA.controller.startVideoRecording();
  await surfaceB.controller.openVideo(SHEET_B);
  const startingB = surfaceB.controller.startVideoRecording();
  await waitFor(() => ops.includes('A:camera:stop:requested'), 'A stop request');

  surfaceA.recorder.finishCamera.reject(new Error('completion failed'));
  await flush(4);
  assert.equal(surfaceB.recorder.videoRecords, 0); // still blocked, honestly
  assert.notEqual(surfaceB.controller.getSnapshot().state, 'recording');
  await startingB;
});

test('video: a rejecting stopRecording request keeps the handoff blocked', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });
  surfaceA.recorder.cameraStopFails = true;

  await surfaceA.controller.openVideo(SHEET_A);
  await surfaceA.controller.startVideoRecording();
  await surfaceB.controller.openVideo(SHEET_B);
  const startingB = surfaceB.controller.startVideoRecording();
  await flush(4);
  assert.equal(surfaceB.recorder.videoRecords, 0);
  assert.notEqual(surfaceB.controller.getSnapshot().state, 'recording');
  surfaceA.recorder.finishCamera.resolve('file://a.mp4');
  await startingB;
});

test('audio handoff is unaffected by a stale session cleanup', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });
  surfaceA.recorder.stopFailures = 1;

  await surfaceA.controller.startAudio(SHEET_A);
  await surfaceB.controller.startAudio(SHEET_B); // blocked (A's stop failed)
  await flush(2);
  assert.equal(surfaceB.recorder.startCalls, 0);
  // A's stale release must not erase the failed obligation, and A's own cancel stop
  // (a retry of the same native stop) is what finally stops it.
  await surfaceA.controller.cancel();
  await flush(2);
  assert.equal(surfaceA.recorder.recording, false); // its own stop succeeded here
  assert.equal(surfaceB.recorder.startCalls, 0); // B was never allowed to capture
  await surfaceB.controller.startAudio(SHEET_B); // retry: the duty is already confirmed
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording');
  assert.equal(surfaceA.recorder.recording, false);
});

/** Process-level trap: proves no unhandled rejection escapes. */
function watchUnhandledRejections() {
  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on('unhandledRejection', handler);
  return {
    async stop() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.off('unhandledRejection', handler);
      return seen;
    },
  };
}

test('A: a failed stop keeps the PHYSICAL reservation after a logical release', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceC = recorderSurface({ coordinator, label: 'C', ops });
  surfaceA.recorder.stopFailures = 5; // every stop attempt fails for now

  await surfaceA.controller.startAudio(SHEET_A);
  assert.equal(surfaceA.recorder.recording, true);
  // A logically releases (cancel) while its capture cannot be stopped.
  await surfaceA.controller.cancel();
  await flush(3);
  assert.equal(surfaceA.recorder.recording, true); // still physically capturing
  assert.equal(coordinator.currentOwner(), null); // no logical owner remains
  assert.equal(coordinator.unresolvedReservationCount() >= 1, true); // ...but the reservation does

  // C cannot start while the physical reservation is unresolved.
  await surfaceC.controller.startAudio(SHEET_C);
  await flush(3);
  assert.equal(surfaceC.recorder.startCalls, 0);
  assert.equal(surfaceC.recorder.recording, false);
  assert.equal(surfaceC.controller.getSnapshot().error?.code, 'hardware-busy');

  // Retry the shutdown: now it succeeds and only then does C start.
  surfaceA.recorder.stopFailures = 0;
  await surfaceC.controller.startAudio(SHEET_C);
  await waitFor(() => surfaceC.controller.getSnapshot().state === 'recording', 'C recording');
  assert.equal(surfaceA.recorder.recording, false);
  assert.equal(surfaceC.recorder.recording, true);
  assert.equal(!!(surfaceA.recorder.recording && surfaceC.recorder.recording), false);
});

test('B: a pending video completion keeps blocking after a logical release', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });

  await surfaceA.controller.openVideo(SHEET_A);
  await surfaceA.controller.startVideoRecording();
  assert.equal(surfaceA.recorder.videoCapturing, true);
  // A stops requesting the camera, but its original record() completion is pending.
  await surfaceA.controller.stop();
  await flush(2);
  assert.equal(ops.includes('A:camera:stop:requested'), true);
  assert.equal(surfaceA.recorder.videoCapturing, true);

  // A is logically released while its capture is still unresolved.
  await surfaceA.controller.cancel();
  await flush(3);
  assert.equal(coordinator.unresolvedReservationCount() >= 1, true);

  await surfaceB.controller.openVideo(SHEET_B);
  const startingB = surfaceB.controller.startVideoRecording();
  await flush(3);
  assert.equal(surfaceB.recorder.videoRecords, 0); // blocked by the reservation

  // Only the ORIGINAL completion confirms the end.
  surfaceA.recorder.finishCamera.resolve('file://a.mp4');
  await flush(3);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording');
  assert.equal(surfaceB.recorder.videoRecords, 1);
  await startingB.catch(() => undefined);
});

test('C: a stale cleanup cannot erase the reservation blocking activation', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops });
  surfaceA.recorder.stopFailures = 5;

  await surfaceA.controller.startAudio(SHEET_A);
  await surfaceB.controller.startAudio(SHEET_B); // blocked
  await flush(2);
  // Repeated stale cleanup/release attempts on A (and on B) must not free the hardware.
  await surfaceA.controller.cancel();
  await surfaceB.controller.cancel();
  await flush(3);
  assert.equal(coordinator.unresolvedReservationCount() >= 1, true);
  assert.equal(surfaceA.recorder.recording, true);
  surfaceA.recorder.stopFailures = 0;
  await surfaceB.controller.startAudio(SHEET_B);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording');
  assert.equal(surfaceA.recorder.recording, false);
});

test('D: owner === null with an unresolved reservation still blocks activation', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const fake = fakeNative({});
  const ports = createRecorderPortsFromDeps(fake.deps, coordinator);
  const ownerA = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  coordinator.registerPhysicalStop(ownerA, async () => {
    throw new Error('stop failed');
  });
  coordinator.deactivate(ownerA);
  assert.equal(coordinator.currentOwner(), null);

  let refused = null;
  await coordinator.activate({ sessionId: 'session-B', kind: 'audio' }).catch((error) => {
    refused = error;
  });
  assert.notEqual(refused, null); // the activation was refused by the reservation
  assert.equal(refused.code, 'handoff-blocked');
  assert.equal(coordinator.currentOwner(), null); // no ownership transfer happened
  assert.equal(coordinator.unresolvedReservationCount(), 1);
  assert.ok(ports);
});

test('an activation refusal while the permission prompt is pending leaks nothing', async () => {
  const watcher = watchUnhandledRejections();
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const permissionGate = deferred();
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops, gatePermission: permissionGate });
  surfaceA.recorder.stopFailures = 5; // A cannot be stopped → B's activation is refused

  await surfaceA.controller.startAudio(SHEET_A);
  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await waitFor(() => ops.includes('B:permission:paused'), 'B permission to be pending');
  // The activation has already been refused while the permission prompt is pending.
  await flush(3);
  assert.equal(surfaceB.controller.getSnapshot().state, 'requesting-permission');
  assert.equal(surfaceB.recorder.startCalls, 0);

  permissionGate.resolve(); // permission granted afterwards
  await startingB.catch(() => undefined);
  await flush(3);
  assert.equal(surfaceB.recorder.startCalls, 0); // the typed refusal is honoured
  assert.equal(surfaceB.controller.getSnapshot().error?.code, 'hardware-busy');
  assert.deepEqual(await watcher.stop(), []); // nothing rejected unhandled
});

test('an activation refusal followed by a DENIED permission leaks nothing', async () => {
  const watcher = watchUnhandledRejections();
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const permissionGate = deferred();
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops, gatePermission: permissionGate });
  surfaceA.recorder.stopFailures = 5;
  surfaceB.recorder.permissionState = { status: 'denied', canAskAgain: false };

  await surfaceA.controller.startAudio(SHEET_A);
  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await waitFor(() => ops.includes('B:permission:paused'), 'B permission pending');
  permissionGate.resolve(); // the user denies
  await startingB.catch(() => undefined);
  await flush(3);
  assert.equal(surfaceB.controller.getSnapshot().state, 'denied');
  assert.equal(surfaceB.recorder.startCalls, 0); // start() was never called
  assert.deepEqual(await watcher.stop(), []);
});

test('unmounting before the activation outcome settles leaks nothing', async () => {
  const watcher = watchUnhandledRejections();
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const permissionGate = deferred();
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops, gatePermission: permissionGate });
  surfaceA.recorder.stopFailures = 5;

  await surfaceA.controller.startAudio(SHEET_A);
  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await waitFor(() => ops.includes('B:permission:paused'), 'B permission pending');

  // The surface unmounts (production teardown) before anything settles.
  await surfaceB.controller.cancel();
  permissionGate.resolve();
  await startingB.catch(() => undefined);
  await flush(3);
  assert.deepEqual(await watcher.stop(), []);
  assert.equal(surfaceB.recorder.startCalls, 0);
});

test('a paused A playback-restore cannot corrupt B: B waits for it, then mode is recording', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const modeState = { current: 'idle' }; // ONE shared process-global audio mode
  const restoreGate = deferred();
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops, modeState, gateRestore: restoreGate });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops, modeState });

  await surfaceA.controller.startAudio(SHEET_A);
  assert.equal(modeState.current, 'recording');
  // A physically stops successfully -> its REAL playback-mode restore starts and is
  // held INSIDE the native call, holding the shared hardware queue.
  const stoppingA = surfaceA.controller.stop();
  await waitFor(() => ops.includes('A:restore:paused'), 'A restore to pause');
  await stoppingA.catch(() => undefined);
  assert.equal(surfaceA.recorder.recording, false); // the capture DID end
  assert.equal(modeState.current, 'recording'); // the restore has not landed yet

  // B requests a capture WHILE A's restore is still paused.
  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await flush(4);
  // SAFE STATE (A): B has not physically started because it waits behind the restore.
  assert.equal(surfaceB.recorder.startCalls, 0);
  assert.equal(surfaceB.recorder.recording, false);
  assert.equal(ops.includes('B:enable'), false);

  // Only now release A's restore gate: the dangerous completion order is proven.
  restoreGate.resolve();
  await startingB.catch(() => undefined);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording');

  assert.equal(surfaceA.recorder.recording, false);
  assert.equal(surfaceB.recorder.recording, true);
  assert.equal(modeState.current, 'recording'); // NOT left in playback
  assert.equal(coordinator.currentOwner()?.sessionId, surfaceB.recorder.sessionIds.at(-1));
  // Execution order: the stale-prone restore ran BEFORE any B mode/capture call.
  const restoreDone = ops.indexOf('A:restore:done');
  assert.equal(restoreDone >= 0, true);
  assert.equal(ops.indexOf('B:enable') > restoreDone, true);
  assert.equal(ops.indexOf('B:start') > restoreDone, true);
});

test('cross-binding: a delayed A restore cannot corrupt another binding instance B', async () => {
  const coordinator = createRecorderHardwareCoordinator(); // ONE shared coordinator
  const ops = [];
  const modeState = { current: 'idle' }; // ONE shared global audio mode
  const restoreGate = deferred();
  const bindingA = recorderSurface({ coordinator, label: 'A', ops, modeState, gateRestore: restoreGate });
  const bindingB = recorderSurface({ coordinator, label: 'B', ops, modeState });

  await bindingA.controller.startAudio(SHEET_A);
  const stoppingA = bindingA.controller.stop();
  await waitFor(() => ops.includes('A:restore:paused'), 'A restore pause');
  await stoppingA.catch(() => undefined);

  const startingB = bindingB.controller.startAudio(SHEET_B);
  await flush(4);
  assert.equal(bindingB.recorder.startCalls, 0);
  restoreGate.resolve();
  await startingB.catch(() => undefined);
  await waitFor(() => bindingB.controller.getSnapshot().state === 'recording', 'B recording');

  assert.equal(modeState.current, 'recording');
  assert.equal(bindingA.recorder.recording, false);
  assert.equal(bindingB.recorder.recording, true);
  assert.equal(bindingA.recorder.mode, 'playback');
  assert.equal(bindingB.recorder.mode, 'recording');
});

test('a stale restore is SKIPPED once a newer owner exists (no delayed playback mode)', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ownerA = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  const ownerB = await coordinator.activate({ sessionId: 'session-B', kind: 'audio' });
  let mode = 'recording';
  const outcome = await coordinator.runAudioModeTransition(ownerA, {
    enabled: false,
    apply: async () => {
      mode = 'playback';
    },
  });
  assert.equal(outcome, 'skipped'); // validated WHEN IT RAN, not only when queued
  assert.equal(mode, 'recording');
  assert.equal(coordinator.currentOwner()?.sessionId, 'session-B');
  assert.ok(ownerB);
});

test('a release-time restore after a B handoff is skipped and cannot reach playback mode', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ops = [];
  const modeState = { current: 'idle' };
  const stopGate = deferred();
  const surfaceA = recorderSurface({ coordinator, label: 'A', ops, modeState, gateStop: stopGate });
  const surfaceB = recorderSurface({ coordinator, label: 'B', ops, modeState });

  await surfaceA.controller.startAudio(SHEET_A);
  // A's stop is paused INSIDE the native stop, so the release (and its queued
  // restore) happens only after B has already requested activation.
  const stoppingA = surfaceA.controller.stop();
  await waitFor(() => ops.includes('A:stop:paused'), 'A stop to pause');
  const startingB = surfaceB.controller.startAudio(SHEET_B);
  await flush(3);
  stopGate.resolve(); // A finishes stopping and releases, late
  await stoppingA.catch(() => undefined);
  await startingB.catch(() => undefined);
  await waitFor(() => surfaceB.controller.getSnapshot().state === 'recording', 'B recording');

  assert.equal(modeState.current, 'recording'); // the late A restore was skipped
  assert.equal(surfaceB.recorder.recording, true);
  assert.equal(surfaceA.recorder.recording, false);
  // No restore ever landed after B's capture started.
  const bStart = ops.indexOf('B:start');
  const lateRestore = ops.indexOf('A:restore:done');
  assert.equal(lateRestore === -1 || lateRestore < bStart, true);
});

test('a queued restore is skipped while a foreign physical reservation is unresolved', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ownerA = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  let mode = 'recording';
  // An unresolved capture registered for A keeps the hardware reserved.
  coordinator.registerPhysicalStop(ownerA, async () => {
    throw new Error('cannot stop');
  });
  coordinator.deactivate(ownerA);
  assert.equal(coordinator.currentOwner(), null); // owner === null != hardware free
  const outcome = await coordinator.runAudioModeTransition(ownerA, {
    enabled: false,
    apply: async () => {
      mode = 'playback';
    },
  });
  assert.equal(outcome, 'skipped');
  assert.equal(mode, 'recording'); // recording-mode capture may still be live
});

test('with no owner and no reservation the release-time restore is applied', async () => {
  const coordinator = createRecorderHardwareCoordinator();
  const ownerA = await coordinator.activate({ sessionId: 'session-A', kind: 'audio' });
  coordinator.deactivate(ownerA);
  let mode = 'recording';
  const outcome = await coordinator.runAudioModeTransition(ownerA, {
    enabled: false,
    apply: async () => {
      mode = 'playback';
    },
  });
  assert.equal(outcome, 'applied');
  assert.equal(mode, 'playback');
});
