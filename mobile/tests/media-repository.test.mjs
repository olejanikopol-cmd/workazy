import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_MEDIA_MANIFEST_FILE,
  isSafeMediaId,
  isSafeMediaFileName,
  parseManifest,
  serializeManifest,
} from '../src/storage/localMediaManifest.ts';
import { createLocalMediaRepository } from '../src/services/media/localMediaRepository.ts';

const STAGING = '/sandbox/cache/workazy-journal-media/v1/staging';
const OBJECTS = '/sandbox/document/workazy-journal-media/v1/objects';

/** In-memory file port mirroring the production MediaFilePort shape. */
function filePort({ root = '/sandbox' } = {}) {
  const files = new Map(); // path -> { sizeBytes } | { text }
  const dirs = new Set();
  const log = [];
  let failNext = null;
  let listGate = null;
  let manifestGate = null;
  let removeGate = null;

  const port = {
    files,
    dirs,
    log,
    failOperation(name, times = 1) {
      failNext = { name, times };
    },
    copySizeDelta: 0,
    pauseListing(deferred) {
      listGate = deferred;
    },
    pauseManifestRead(deferred) {
      manifestGate = deferred;
    },
    pauseRemove(deferred) {
      removeGate = deferred;
    },
    seed(path, sizeBytes) {
      files.set(path, { sizeBytes });
    },
    seedText(path, text) {
      files.set(path, { text });
    },
    has(path) {
      return files.has(path) || dirs.has(path);
    },
    roots() {
      return { staging: `${root}/cache/workazy-journal-media/v1/staging`, objects: `${root}/document/workazy-journal-media/v1/objects` };
    },
    join(...parts) {
      return parts.join('/').replace(/\/+/g, '/');
    },
    toUri(path) {
      return `file://${path}`;
    },
    async ensureDir(path) {
      log.push(`mkdir:${path}`);
      dirs.add(path);
    },
    async stat(path) {
      const file = files.get(path);
      if (file) return { exists: true, sizeBytes: file.text !== undefined ? file.text.length : file.sizeBytes, isDirectory: false };
      if (dirs.has(path)) return { exists: true, sizeBytes: null, isDirectory: true };
      return { exists: false, sizeBytes: null, isDirectory: false };
    },
    async copy(from, to) {
      log.push(`copy:${from}->${to}`);
      if (failNext && failNext.name === 'copy') {
        failNext.times -= 1;
        if (failNext.times <= 0) failNext = null;
        throw new Error('copy failed');
      }
      const file = files.get(from);
      if (!file) throw new Error('missing source');
      const copy = { ...file };
      if (copy.sizeBytes !== undefined && port.copySizeDelta) {
        copy.sizeBytes = copy.sizeBytes + port.copySizeDelta;
      }
      files.set(to, copy);
    },
    async move(from, to) {
      log.push(`move:${from}->${to}`);
      if (failNext && failNext.name === 'move') {
        failNext.times -= 1;
        if (failNext.times <= 0) failNext = null;
        throw new Error('move failed');
      }
      const file = files.get(from);
      if (!file) throw new Error('missing source');
      files.set(to, { ...file });
      files.delete(from);
    },
    async remove(path) {
      log.push(`remove:${path}`);
      if (removeGate) {
        const gate = removeGate;
        removeGate = null;
        await gate.promise; // the delete is paused mid-flight
      }
      if (failNext && failNext.name === 'remove') {
        failNext.times -= 1;
        if (failNext.times <= 0) failNext = null;
        throw new Error('remove failed');
      }
      files.delete(path);
      dirs.delete(path);
      for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
      for (const key of [...dirs.keys()]) if (key.startsWith(`${path}/`)) dirs.delete(key);
    },
    async listNames(path) {
      if (listGate) {
        const gate = listGate;
        listGate = null;
        await gate.promise; // the sweep is paused mid-flight here
      }
      const names = new Set();
      for (const key of [...files.keys(), ...dirs.keys()]) {
        if (!key.startsWith(`${path}/`)) continue;
        const rest = key.slice(path.length + 1);
        names.add(rest.split('/')[0]);
      }
      return [...names];
    },
    async readText(path) {
      if (manifestGate) {
        const gate = manifestGate;
        manifestGate = null;
        await gate.promise; // the sweep is paused during an ownership read
      }
      const file = files.get(path);
      if (!file || file.text === undefined) return null;
      return file.text;
    },
    async writeText(path, text) {
      log.push(`write:${path}`);
      if (failNext && failNext.name === 'writeText') {
        failNext.times -= 1;
        if (failNext.times <= 0) failNext = null;
        throw new Error('write failed');
      }
      files.set(path, { text });
      dirs.add(path.slice(0, path.lastIndexOf('/')));
    },
  };
  return port;
}

let counter = 0;
function repository(port) {
  return createLocalMediaRepository({
    port,
    createMediaId: () => `local-media-00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    createSessionId: () => `session-00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    now: () => new Date('2026-09-11T12:00:00.000Z'),
  });
}

function owner(sessionId, overrides = {}) {
  return {
    sheetKey: 'journal-new-1',
    entryId: null,
    draftKey: 'draft-1',
    draftRevision: 0,
    sessionId,
    generation: 1,
    ...overrides,
  };
}

function audioCapture(uri, sizeBytes, durationMs, mimeType = 'audio/mp4') {
  return { uri, kind: 'audio', mimeType, durationMs, reportedSizeBytes: sizeBytes };
}

/** Re-read readers, mirroring the production ReconcileInput contract. */
function readers({ references = [], leasedSessions = [], leasedMedia = [], canDelete } = {}) {
  const asSet = (value) => new Set(typeof value === 'function' ? value() : value);
  return {
    references: () => asSet(references),
    leasedSessions: () => asSet(leasedSessions),
    leasedMedia: () => asSet(leasedMedia),
    ...(canDelete ? { canDelete } : {}),
  };
}

let sessionCounter = 0;
function nextSession() {
  sessionCounter += 1;
  return `session-00000000-0000-4000-8000-${String(900 + sessionCounter).padStart(12, '0')}`;
}

test('the manifest parser accepts only strict owned scalars', () => {
  const valid = {
    version: 1,
    mediaId: 'local-media-11111111-2222-4333-8444-555555555555',
    fileName: 'recording.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 1024,
    durationMs: 2500,
    createdAt: '2026-09-11T12:00:00.000Z',
  };
  assert.equal(parseManifest(serializeManifest(valid)).ok, true);
  assert.equal(isSafeMediaId(valid.mediaId), true);
  assert.equal(isSafeMediaId('local-media-..%2f..%2fetc'), false);
  assert.equal(isSafeMediaFileName('recording.m4a'), true);
  assert.equal(isSafeMediaFileName('../recording.m4a'), false);
  assert.equal(isSafeMediaFileName('recording.exe'), false);

  const bad = [
    ['nope', 'invalid-json'],
    [JSON.stringify({ ...valid, version: 2 }), 'unknown-version'],
    [JSON.stringify({ ...valid, extra: 1 }), 'unknown-key:extra'],
    [JSON.stringify({ ...valid, mediaId: 'local-media-../../etc/passwd' }), 'bad-media-id'],
    [JSON.stringify({ ...valid, fileName: 'other.m4a' }), 'bad-file-name'],
    [JSON.stringify({ ...valid, fileName: 'recording.mp4' }), 'bad-mime-type'],
    [JSON.stringify({ ...valid, mimeType: 'video/mp4' }), 'bad-mime-type'],
    [JSON.stringify({ ...valid, mimeType: 'audio/webm' }), 'bad-mime-type'],
    [JSON.stringify({ ...valid, sizeBytes: 0 }), 'bad-size-bytes'],
    [JSON.stringify({ ...valid, sizeBytes: -5 }), 'bad-size-bytes'],
    [JSON.stringify({ ...valid, sizeBytes: 1.5 }), 'bad-size-bytes'],
    [JSON.stringify({ ...valid, durationMs: 0 }), 'bad-duration-ms'],
    [JSON.stringify({ ...valid, durationMs: null }), 'bad-duration-ms'],
    [JSON.stringify({ ...valid, createdAt: '2026-09-11' }), 'bad-created-at'],
  ];
  for (const [raw, expected] of bad) {
    const parsed = parseManifest(raw);
    assert.equal(parsed.ok, false, expected);
    if (!parsed.ok) assert.equal(parsed.error, expected);
  }
});

test('adoptCapture copies (never moves) the finalized native file into owned staging', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);

  const outcome = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  assert.equal(outcome.ok, true);
  const draft = outcome.draft;
  assert.equal(draft.sizeBytes, 4_000);
  assert.equal(draft.durationMs, 8_000);
  assert.equal(draft.mimeType, 'audio/mp4');
  assert.equal(draft.fileName, 'recording.m4a');
  assert.equal(draft.stagingPath, `${STAGING}/${session}/${draft.id}.m4a`);
  assert.equal(isSafeMediaId(draft.id), true);
  assert.equal(port.has('/native/take.m4a'), true); // the source is untouched
  assert.equal(port.has(draft.stagingPath), true);
  assert.equal(port.dirs.has(`${STAGING}/${session}`), true);
});

test('adoptCapture rejects empty/oversize/unknown/wrong-MIME captures with typed failures', async () => {
  const cases = [
    ['empty', 0, 5_000, 'audio/mp4', 'capture-empty'],
    ['oversize', 25_165_825, 5_000, 'audio/mp4', 'file-too-large'],
    ['no-duration', 1_000, null, 'audio/mp4', 'duration-unknown'],
    ['zero-duration', 1_000, 0, 'audio/mp4', 'duration-unknown'],
    ['too-long', 1_000, 900_001, 'audio/mp4', 'duration-too-long'],
    ['wrong-mime', 1_000, 5_000, 'audio/webm', 'mime-unsupported'],
    ['unknown-mime', 1_000, 5_000, null, 'mime-unsupported'],
  ];
  for (const [name, size, duration, mime, code] of cases) {
    const port = filePort();
    const repo = repository(port);
    port.seed('/native/take.m4a', size);
    const outcome = await repo.adoptCapture(
      { uri: '/native/take.m4a', kind: 'audio', mimeType: mime, durationMs: duration },
      owner(nextSession()),
    );
    assert.equal(outcome.ok, false, name);
    if (!outcome.ok) assert.equal(outcome.failure.code, code, name);
  }
  // A missing native file is reported, never invented.
  const port = filePort();
  const repo = repository(port);
  const missing = await repo.adoptCapture(audioCapture('/native/gone.m4a', 1_000, 1_000), owner(nextSession()));
  assert.equal(missing.ok, false);
  assert.equal(missing.failure.code, 'file-missing');
});

test('adoptCapture never accepts a partially copied staging file', async () => {
  const port = filePort();
  const repo = repository(port);
  port.seed('/native/take.m4a', 4_000);
  port.copySizeDelta = -1_000; // the copy lands short
  const outcome = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(nextSession()));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'adopt-failed');
});

test('prepare promotes the staged take with a valid ownership manifest', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  assert.equal(adopted.ok, true);

  const prepared = await repo.prepare(adopted.draft, owner(session));
  assert.equal(prepared.ok, true);
  const metadata = prepared.prepared.metadata;
  assert.equal(metadata.id, adopted.draft.id);
  assert.equal(metadata.type, 'audio');
  assert.equal(metadata.sizeBytes, 4_000);
  assert.equal(metadata.durationMs, 8_000);
  assert.equal('journalEntryId' in metadata, false); // the store supplies the parent

  const manifestPath = `${OBJECTS}/${adopted.draft.id}/${LOCAL_MEDIA_MANIFEST_FILE}`;
  const raw = await port.readText(manifestPath);
  const parsed = parseManifest(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.sizeBytes, 4_000);
  assert.equal(port.has(`${OBJECTS}/${adopted.draft.id}/recording.m4a`), true);

  // Idempotent retry with the SAME stable take id (failed metadata write retry).
  const retry = await repo.prepare(adopted.draft, owner(session));
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.prepared.metadata, metadata);
});

test('prepare never overwrites a foreign object directory and keeps the draft retryable', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  assert.equal(adopted.ok, true);

  // A foreign directory with the same id but a different size.
  const foreign = `${OBJECTS}/${adopted.draft.id}`;
  port.dirs.add(foreign);
  port.seedText(
    `${foreign}/${LOCAL_MEDIA_MANIFEST_FILE}`,
    serializeManifest({
      version: 1,
      mediaId: adopted.draft.id,
      fileName: 'recording.m4a',
      mimeType: 'audio/mp4',
      sizeBytes: 9_999,
      durationMs: 1_000,
      createdAt: '2026-09-11T12:00:00.000Z',
    }),
  );
  const outcome = await repo.prepare(adopted.draft, owner(session));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'adopt-failed');
  assert.equal(port.files.get(`${foreign}/${LOCAL_MEDIA_MANIFEST_FILE}`).text.includes('9999'), true);
});

test('a failed manifest write cleans the partial promotion but keeps the staging copy', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  assert.equal(adopted.ok, true);
  port.failOperation('writeText');
  const outcome = await repo.prepare(adopted.draft, owner(session));
  assert.equal(outcome.ok, false);
  assert.equal(port.has(`${OBJECTS}/${adopted.draft.id}`), false); // no half-promoted dir
  assert.equal(port.has(adopted.draft.stagingPath), true); // retryable draft
});

test('resolve returns an ephemeral playback source or an honest unavailable state', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  const prepared = await repo.prepare(adopted.draft, owner(session));
  assert.equal(prepared.ok, true);
  const media = prepared.prepared.metadata;

  const playable = await repo.resolve({ id: media.id, type: 'audio', mimeType: media.mimeType });
  assert.equal('unavailable' in playable, false);
  assert.equal(playable.uri, `file://${OBJECTS}/${media.id}/recording.m4a`);
  assert.equal(playable.mimeType, 'audio/mp4');

  // The file disappears (OS purge/manual): metadata is retained, nothing deleted.
  port.files.delete(`${OBJECTS}/${media.id}/recording.m4a`);
  const missing = await repo.resolve({ id: media.id, type: 'audio', mimeType: media.mimeType });
  assert.equal('unavailable' in missing, true);
  assert.equal(missing.reason, 'missing-file');
  assert.equal(port.has(`${OBJECTS}/${media.id}/${LOCAL_MEDIA_MANIFEST_FILE}`), true);

  // A corrupt manifest is reported as invalid, never guessed.
  port.seedText(`${OBJECTS}/${media.id}/${LOCAL_MEDIA_MANIFEST_FILE}`, '{ broken');
  const invalid = await repo.resolve({ id: media.id, type: 'audio', mimeType: media.mimeType });
  assert.equal('unavailable' in invalid, true);
  assert.equal(invalid.reason, 'invalid-manifest');
});

test('discard removes only the abandoned take’s own staging directory', async () => {
  const port = filePort();
  const repo = repository(port);
  const sessionA = nextSession();
  const sessionB = nextSession();
  port.seed('/native/a.m4a', 1_000);
  port.seed('/native/b.m4a', 1_000);
  const draftA = (await repo.adoptCapture(audioCapture('/native/a.m4a', 1_000, 2_000), owner(sessionA))).draft;
  const draftB = (await repo.adoptCapture(audioCapture('/native/b.m4a', 1_000, 2_000), owner(sessionB))).draft;

  const cleanup = await repo.discard(draftA);
  assert.equal(port.has(draftA.stagingPath), false);
  assert.equal(cleanup.removed.includes(draftA.stagingPath), true);
  assert.equal(port.has(draftB.stagingPath), true); // another session is untouched

  // Two takes of the SAME session: discarding one keeps the other's file.
  const sharedSession = nextSession();
  port.seed('/native/c.m4a', 1_000);
  port.seed('/native/d.m4a', 1_000);
  const draftC = (await repo.adoptCapture(audioCapture('/native/c.m4a', 1_000, 2_000), owner(sharedSession))).draft;
  const draftD = (await repo.adoptCapture(audioCapture('/native/d.m4a', 1_000, 2_000), owner(sharedSession))).draft;
  assert.notEqual(draftC.stagingPath, draftD.stagingPath);
  await repo.discard(draftC);
  assert.equal(port.has(draftC.stagingPath), false);
  assert.equal(port.has(draftD.stagingPath), true); // same-session sibling survives
});

test('reconcile keeps referenced/leased/unknown/corrupt entries and blocks when unhydrated', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  const prepared = await repo.prepare(adopted.draft, owner(session));
  assert.equal(prepared.ok, true);
  const referencedId = prepared.prepared.metadata.id;

  // A second, unreferenced owned object.
  port.seed('/native/orphan.m4a', 4_000);
  const orphanSession = nextSession();
  const orphan = (await repo.adoptCapture(audioCapture('/native/orphan.m4a', 4_000, 8_000), owner(orphanSession))).draft;
  const orphanPrepared = await repo.prepare(orphan, owner(orphanSession));
  assert.equal(orphanPrepared.ok, true);

  // Lease the orphan so the sweep must keep it.
  const leased = await repo.reconcile(
    readers({
      references: [referencedId],
      leasedSessions: [orphanSession],
      leasedMedia: [orphan.id],
    }),
    { hydrated: true },
  );
  assert.equal(port.has(`${OBJECTS}/${orphan.id}`), true);
  assert.equal(port.has(`${OBJECTS}/${referencedId}`), true);
  assert.ok(leased.retained.includes(`${OBJECTS}/${orphan.id}`));

  // Corrupt + unknown directories are retained, never guessed.
  const corruptId = 'local-media-99999999-8888-4777-8666-555555555555';
  port.dirs.add(`${OBJECTS}/${corruptId}`);
  port.seedText(`${OBJECTS}/${corruptId}/${LOCAL_MEDIA_MANIFEST_FILE}`, '{ broken');
  port.dirs.add(`${OBJECTS}/not-ours`);
  const kept = await repo.reconcile(readers({ references: [referencedId] }), { hydrated: true });
  assert.equal(port.has(`${OBJECTS}/${corruptId}`), true);
  assert.equal(port.has(`${OBJECTS}/not-ours`), true);
  assert.ok(kept.retained.includes(`${OBJECTS}/${corruptId}`));

  // Unreferenced + unleased owned objects are removed, and abandoned staging too.
  assert.equal(port.has(`${OBJECTS}/${orphan.id}`), false);
  assert.equal(port.has(`${STAGING}/${orphanSession}`), false);
  assert.equal(port.has(`${OBJECTS}/${referencedId}`), true);

  // Blocked while the journal is not hydrated: nothing is deleted.
  port.seed('/native/third.m4a', 1_000);
  const thirdSession = nextSession();
  const third = (await repo.adoptCapture(audioCapture('/native/third.m4a', 1_000, 1_000), owner(thirdSession))).draft;
  const thirdPrepared = await repo.prepare(third, owner(thirdSession));
  assert.equal(thirdPrepared.ok, true);
  const blocked = await repo.reconcile(readers(), { hydrated: false });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.removed, []);
  assert.equal(port.has(`${OBJECTS}/${third.id}`), true);
});

test('an interleaved commit during a sweep is never deleted (references re-read per delete)', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  const prepared = await repo.prepare(adopted.draft, owner(session));
  assert.equal(prepared.ok, true);
  const mediaId = prepared.prepared.metadata.id;

  // A sweep starts believing nothing is referenced...
  const references = new Set();
  const gate = { promise: null, resolve: null };
  gate.promise = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  port.pauseListing(gate);
  const sweeping = repo.reconcile(readers({ references: () => references }), { hydrated: true });

  // ...the journal commit lands while the sweep is paused...
  references.add(mediaId);
  gate.resolve();
  const result = await sweeping;

  // ...and the freshly committed file is untouched.
  assert.equal(port.has(`${OBJECTS}/${mediaId}/recording.m4a`), true);
  assert.ok(result.retained.includes(`${OBJECTS}/${mediaId}`));
  assert.equal(result.removed.some((path) => path.startsWith(OBJECTS)), false);
});

test('an interleaved lease during a sweep keeps the take (leases re-read per delete)', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  assert.equal(adopted.ok, true);

  const leasedMedia = new Set();
  const gate = { promise: null, resolve: null };
  gate.promise = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  // Freeze the sweep while it lists the staging namespace.
  port.pauseListing(gate);
  const sweeping = repo.reconcile(
    readers({ leasedMedia: () => leasedMedia, leasedSessions: () => [session] }),
    { hydrated: true },
  );
  leasedMedia.add(adopted.draft.id);
  gate.resolve();
  await sweeping;
  assert.equal(port.has(adopted.draft.stagingPath), true); // the live take survives
});

test('an uncertain delete gate leaks the file instead of deleting it', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  const prepared = await repo.prepare(adopted.draft, owner(session));
  assert.equal(prepared.ok, true);

  // The journal became mid-write/unhydrated while the sweep was running.
  const result = await repo.reconcile(readers({ canDelete: () => false }), { hydrated: true });
  assert.equal(port.has(`${OBJECTS}/${adopted.draft.id}/recording.m4a`), true);
  assert.equal(result.removed.some((path) => path.startsWith(OBJECTS)), false);

  // A throwing reader is also treated as "still needed".
  const throwing = await repo.reconcile(
    {
      references: () => {
        throw new Error('journal unavailable');
      },
      leasedSessions: () => new Set(),
      leasedMedia: () => new Set(),
    },
    { hydrated: true },
  );
  assert.equal(port.has(`${OBJECTS}/${adopted.draft.id}/recording.m4a`), true);
  assert.equal(throwing.removed.some((path) => path.startsWith(OBJECTS)), false);
});

test('the final guard is re-read AFTER the ownership read and before the delete', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  const prepared = await repo.prepare(adopted.draft, owner(session));
  assert.equal(prepared.ok, true);
  const mediaId = prepared.prepared.metadata.id;

  // The sweep reaches the object and starts reading its ownership manifest...
  const references = new Set();
  const gate = { promise: null, resolve: null };
  gate.promise = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  port.pauseListing(gate);
  const sweeping = repo.reconcile(readers({ references: () => references }), { hydrated: true });
  // ...the journal references it while that read is in flight...
  references.add(mediaId);
  gate.resolve();
  const result = await sweeping;

  // ...and the guard re-read after the async read keeps the file.
  assert.equal(port.has(`${OBJECTS}/${mediaId}/recording.m4a`), true);
  assert.ok(result.retained.includes(`${OBJECTS}/${mediaId}`));
  assert.equal(result.removed.some((path) => path.startsWith(OBJECTS)), false);
});

test('a lease added during the ownership read also prevents the delete', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/take.m4a', 4_000);
  const adopted = await repo.adoptCapture(audioCapture('/native/take.m4a', 4_000, 8_000), owner(session));
  const prepared = await repo.prepare(adopted.draft, owner(session));
  assert.equal(prepared.ok, true);
  const mediaId = prepared.prepared.metadata.id;

  const leased = new Set();
  const gate = { promise: null, resolve: null };
  gate.promise = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  port.pauseManifestRead(gate);
  const sweeping = repo.reconcile(readers({ leasedMedia: () => leased }), { hydrated: true });
  leased.add(mediaId);
  gate.resolve();
  await sweeping;
  assert.equal(port.has(`${OBJECTS}/${mediaId}/recording.m4a`), true);
});

test('a sibling take adopted during another take’s discard survives (no directory race)', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/a.m4a', 1_000);
  const draftA = (await repo.adoptCapture(audioCapture('/native/a.m4a', 1_000, 2_000), owner(session))).draft;

  // Discard A: its own file removal is paused mid-flight...
  const gate = { promise: null, resolve: null };
  gate.promise = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  port.pauseRemove(gate);
  const discarding = repo.discard(draftA);
  await new Promise((resolve) => setTimeout(resolve, 1));

  // ...a SIBLING take B is adopted into the same session directory...
  port.seed('/native/b.m4a', 1_000);
  const adoptingB = repo.adoptCapture(audioCapture('/native/b.m4a', 1_000, 2_000), owner(session));
  gate.resolve();
  const [cleanupA, adoptedB] = await Promise.all([discarding, adoptingB]);

  // ...and A's cleanup can never remove the session directory A no longer owns.
  assert.equal(adoptedB.ok, true);
  assert.equal(port.has(draftA.stagingPath), false); // A's own file is gone
  assert.equal(port.has(adoptedB.draft.stagingPath), true); // B survives
  assert.equal(cleanupA.removed.includes(adoptedB.draft.stagingPath), false);

  // B is fully usable: it can be promoted and then resolved for playback.
  const promotedB = await repo.prepare(adoptedB.draft, owner(session));
  assert.equal(promotedB.ok, true);
  const resolved = await repo.resolve({
    id: adoptedB.draft.id,
    type: 'audio',
    mimeType: adoptedB.draft.mimeType,
  });
  assert.equal('unavailable' in resolved, false);
});

test('two sibling takes: discarding one keeps the other resolvable', async () => {
  const port = filePort();
  const repo = repository(port);
  const session = nextSession();
  port.seed('/native/one.m4a', 1_000);
  port.seed('/native/two.m4a', 2_000);
  const draftOne = (await repo.adoptCapture(audioCapture('/native/one.m4a', 1_000, 2_000), owner(session))).draft;
  const draftTwo = (await repo.adoptCapture(audioCapture('/native/two.m4a', 2_000, 3_000), owner(session))).draft;
  assert.notEqual(draftOne.stagingPath, draftTwo.stagingPath);

  await repo.discard(draftOne);
  assert.equal(port.has(draftOne.stagingPath), false);
  assert.equal(port.has(draftTwo.stagingPath), true);
  const promoted = await repo.prepare(draftTwo, owner(session));
  assert.equal(promoted.ok, true);
  const resolved = await repo.resolve({ id: draftTwo.id, type: 'audio', mimeType: 'audio/mp4' });
  assert.equal('unavailable' in resolved, false);
});
