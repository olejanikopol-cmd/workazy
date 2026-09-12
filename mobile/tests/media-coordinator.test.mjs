import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournalStore } from '../src/features/journal/journalStore.ts';
import { parseSnapshot } from '../src/storage/journalStorage.ts';
import { createLocalMediaRepository } from '../src/services/media/localMediaRepository.ts';
import { createJournalMediaCoordinator } from '../src/services/media/journalMediaCoordinator.ts';
import { createRecorderPortsFromDeps } from '../src/services/media/recorderBindingsCore.ts';
import { createRecorderController } from '../src/services/media/recorderController.ts';
import { createRecorderSurfaceLifecycle } from '../src/services/media/recorderSurfaceLifecycle.ts';

const NOW = new Date('2026-09-11T12:00:00.000Z');
const STAGING = '/sandbox/cache/workazy-journal-media/v1/staging';
const OBJECTS = '/sandbox/document/workazy-journal-media/v1/objects';

/** Minimal in-memory MediaFilePort for the coordinator tests. */
function filePort() {
  const files = new Map();
  const dirs = new Set();
  let failingOperation = null; // { name, path | null }
  return {
    files,
    dirs,
    failOperation(name, options = {}) {
      failingOperation = { name, path: options.path ?? null };
    },
    seed(path, sizeBytes) {
      files.set(path, { sizeBytes });
    },
    has(path) {
      return files.has(path) || dirs.has(path);
    },
    roots: () => ({ staging: STAGING, objects: OBJECTS }),
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    toUri: (path) => `file://${path}`,
    async ensureDir(path) {
      dirs.add(path);
    },
    async stat(path) {
      const file = files.get(path);
      if (file) return { exists: true, sizeBytes: file.text !== undefined ? file.text.length : file.sizeBytes, isDirectory: false };
      if (dirs.has(path)) return { exists: true, sizeBytes: null, isDirectory: true };
      return { exists: false, sizeBytes: null, isDirectory: false };
    },
    async copy(from, to) {
      const file = files.get(from);
      if (!file) throw new Error('missing source');
      files.set(to, { ...file });
    },
    async move(from, to) {
      const file = files.get(from);
      if (!file) throw new Error('missing source');
      files.set(to, { ...file });
      files.delete(from);
    },
    async remove(path) {
      if (
        failingOperation !== null &&
        failingOperation.name === 'remove' &&
        (failingOperation.path === null || failingOperation.path === path)
      ) {
        failingOperation = null;
        throw new Error('remove failed');
      }
      files.delete(path);
      dirs.delete(path);
      for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
      for (const key of [...dirs.keys()]) if (key.startsWith(`${path}/`)) dirs.delete(key);
    },
    async listNames(path) {
      const names = new Set();
      for (const key of [...files.keys(), ...dirs.keys()]) {
        if (!key.startsWith(`${path}/`)) continue;
        names.add(key.slice(path.length + 1).split('/')[0]);
      }
      return [...names];
    },
    async readText(path) {
      const file = files.get(path);
      return file && file.text !== undefined ? file.text : null;
    },
    async writeText(path, text) {
      files.set(path, { text });
      dirs.add(path.slice(0, path.lastIndexOf('/')));
    },
  };
}

function storageAdapter({ raw = null, failWrites = false } = {}) {
  let rawValue = raw;
  let failing = failWrites;
  return {
    raw: () => rawValue,
    failNextWrite() {
      failing = true;
    },
    async getItem() {
      return rawValue;
    },
    async setItem(key, value) {
      if (failing) {
        failing = false;
        throw new Error('write failed');
      }
      rawValue = value;
    },
  };
}

let ids = 0;
function makeStore(adapter) {
  return createJournalStore({
    storage: adapter,
    now: () => NOW,
    createId: () => `entry-${++ids}`,
  });
}

let mediaIds = 0;
let sessionIds = 0;
function makeRepository(port) {
  return createLocalMediaRepository({
    port,
    createMediaId: () => `local-media-00000000-0000-4000-8000-${String(++mediaIds).padStart(12, '0')}`,
    createSessionId: () => `session-00000000-0000-4000-8000-${String(++sessionIds).padStart(12, '0')}`,
    now: () => NOW,
  });
}

function ownerFor(port, sessionId, overrides = {}) {
  return {
    sheetKey: 'journal-new-1',
    entryId: null,
    draftKey: 'draft-1',
    draftRevision: 1,
    sessionId,
    generation: 1,
    ...overrides,
  };
}

function journalInput(overrides = {}) {
  return {
    ...{
      title: '',
      body: 'Текст записи',
      mood: '',
      tags: '',
      changed: { title: false, body: false, mood: false, tags: false },
    },
    ...overrides,
  };
}

/** Native take -> adopted draft (repository only; no journal write yet). */
async function take(repo, port, sessionId, { size = 4_000, duration = 8_000, kind = 'audio', index = 1 } = {}) {
  const nativeUri = `/native/take-${index}.${kind === 'audio' ? 'm4a' : 'mp4'}`;
  port.seed(nativeUri, size);
  const outcome = await repo.adoptCapture(
    {
      uri: nativeUri,
      kind,
      mimeType: kind === 'audio' ? 'audio/mp4' : 'video/mp4',
      durationMs: duration,
    },
    ownerFor(port, sessionId),
  );
  assert.equal(outcome.ok, true);
  return outcome.draft;
}

function setup({ raw = null } = {}) {
  const adapter = storageAdapter({ raw });
  const store = makeStore(adapter);
  const port = filePort();
  const repository = makeRepository(port);
  const state = { current: null };
  const coordinator = createJournalMediaCoordinator({
    repository,
    store,
    currentOwner: () => state.current,
  });
  return { adapter, store, port, repository, coordinator, state };
}
test('end-to-end: repository prepare -> journal bytes -> new store -> local playback', async () => {
  const { adapter, store, port, repository, coordinator, state } = setup();
  await store.load();
  const session = coordinator.activeSessionIds();
  assert.equal(session.size, 0);
  assert.ok(repository);

  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000001');
  state.current = owner;
  const audio = await take(repository, port, owner.sessionId, { index: 1 });
  const video = await take(repository, port, owner.sessionId, { size: 9_000, duration: 12_000, kind: 'video', index: 2 });
  coordinator.lease(audio);
  coordinator.lease(video);

  const outcome = await coordinator.commitNewEntry(owner, journalInput({ body: 'С вложениями' }), '2026-09-11', [audio, video]);
  assert.equal(outcome.ok, true);
  assert.equal(coordinator.activeMediaIds().size, 0); // leases released after commit

  // The durable envelope carries METADATA only.
  const raw = adapter.raw();
  const parsed = parseSnapshot(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.entries.length, 1);
  const media = parsed.snapshot.entries[0].media;
  assert.equal(media.length, 2);
  assert.deepEqual(media.map((item) => item.type), ['audio', 'video']);
  assert.equal(media[0].transcriptionStatus, 'pending');
  assert.equal(media[0].transcriptEdited, false);
  for (const item of media) {
    assert.equal('uri' in item, false);
    assert.equal('base64' in item, false);
    assert.equal('source' in item, false);
    assert.equal('file' in item, false);
  }
  assert.equal(raw.includes('file://'), false); // no playback/temp URI in the journal
  assert.equal(raw.includes('base64'), false);

  // A brand-new store + repository resolve the same files offline.
  const freshAdapter = storageAdapter({ raw });
  const freshStore = makeStore(freshAdapter);
  const freshPort = filePort();
  for (const [key, value] of port.files) freshPort.files.set(key, value);
  for (const dir of port.dirs) freshPort.dirs.add(dir);
  const freshRepository = makeRepository(freshPort);
  await freshStore.load();
  const freshMedia = freshStore.getSnapshot().entries[0].media;
  assert.equal(freshMedia.length, 2);
  for (const item of freshMedia) {
    const resolved = await freshRepository.resolve({ id: item.id, type: item.type, mimeType: item.mimeType });
    assert.equal('unavailable' in resolved, false, item.id);
    assert.equal(resolved.uri.startsWith('file://'), true);
  }
});

test('a media-only new entry is valid; a blank text-only entry is not', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000002');
  state.current = owner;

  const blank = await coordinator.commitNewEntry(owner, journalInput({ body: '   ' }), '2026-09-11', []);
  assert.equal(blank.ok, false);
  assert.equal(blank.failure.code, 'validation-failed'); // body-blank input gate
  assert.equal(store.getSnapshot().entries.length, 0);

  const draft = await take(repository, port, owner.sessionId, { index: 3 });
  const mediaOnly = await coordinator.commitNewEntry(owner, journalInput({ body: '' }), '2026-09-11', [draft]);
  assert.equal(mediaOnly.ok, true);
  const entry = store.getSnapshot().entries[0];
  assert.equal(entry.body, '');
  assert.equal(entry.media.length, 1);
});

test('a failed metadata write keeps the bytes, the prepared file and the lease; retry reuses the same take id', async () => {
  const { adapter, store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000010');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 10 });
  coordinator.lease(draft);

  const before = adapter.raw();
  adapter.failNextWrite();
  const failed = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(failed.ok, false);
  assert.equal(failed.failure.code, 'save-failed');
  assert.equal(adapter.raw(), before); // committed bytes unchanged
  assert.equal(store.getSnapshot().entries.length, 0);
  assert.equal(coordinator.activeMediaIds().has(draft.id), true); // lease kept
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true); // file kept

  const retry = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(retry.ok, true);
  const entries = store.getSnapshot().entries;
  assert.equal(entries.length, 1); // no duplicate entry
  assert.equal(entries[0].media.length, 1); // no duplicate media row
  assert.equal(entries[0].media[0].id, draft.id);
  assert.equal(entries[0].media[0].journalEntryId, entries[0].id); // correct parent
});

test('commitEdit merges additions/removals into the latest row and cleans removed files after the write', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000020');
  state.current = owner;
  const first = await take(repository, port, owner.sessionId, { index: 20 });
  const second = await take(repository, port, owner.sessionId, { index: 21 });
  const created = await coordinator.commitNewEntry(
    owner,
    journalInput({ body: 'Первый текст', title: 'Заголовок', tags: 'дом, утро', mood: 'calm' }),
    '2026-09-11',
    [first, second],
  );
  assert.equal(created.ok, true, created.ok ? '' : `code=${created.failure.code}`);
  const entryId = created.entryId;
  const before = store.getSnapshot().entries[0];

  // A stale editor snapshot that only knows about `first` must not replace media[].
  const third = await take(repository, port, owner.sessionId, { index: 22 });
  const edited = await coordinator.commitEdit(
    owner,
    entryId,
    journalInput({ body: 'Обновлённый текст', tags: 'дом, утро', mood: 'calm', changed: { title: false, body: true, mood: false, tags: false } }),
    { add: [third], removeIds: [first.id] },
  );
  assert.equal(edited.ok, true, edited.ok ? '' : `code=${edited.failure.code}`);
  const after = store.getSnapshot().entries[0];
  assert.deepEqual(after.media.map((item) => item.id), [second.id, third.id]); // unrelated media preserved
  assert.equal(after.title, before.title); // untouched fields preserved exactly
  assert.equal(after.tags.join(', '), 'дом, утро');
  assert.equal(after.mood, 'calm');
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.date, before.date);
  assert.equal(port.has(`${OBJECTS}/${first.id}`), false); // removed file cleaned AFTER the write
  assert.equal(port.has(`${OBJECTS}/${second.id}`), true);
  assert.equal(port.has(`${OBJECTS}/${third.id}`), true);
});

test('reader attachment removal deletes metadata first and never deletes files when the write fails', async () => {
  const { adapter, store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000030');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 30 });
  const created = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(created.ok, true);
  const entryId = created.entryId;

  const before = adapter.raw();
  adapter.failNextWrite();
  const failed = await coordinator.removeCommittedAttachment(entryId, draft.id);
  assert.equal(failed.ok, false);
  assert.equal(failed.failure.code, 'save-failed');
  assert.equal(adapter.raw(), before);
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true); // still playable
  assert.equal(store.getSnapshot().entries[0].media.length, 1);

  const removed = await coordinator.removeCommittedAttachment(entryId, draft.id);
  assert.equal(removed.ok, true);
  assert.equal(store.getSnapshot().entries[0].media, undefined); // empty but the entry survives
  assert.equal(store.getSnapshot().entries.length, 1);
  assert.equal(port.has(`${OBJECTS}/${draft.id}`), false);
});

test('deleting an entry removes it first and only then cleans its owned files', async () => {
  const { adapter, store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000040');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 40 });
  const created = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(created.ok, true);

  adapter.failNextWrite();
  const failed = await coordinator.deleteEntry(created.entryId);
  assert.equal(failed.ok, false);
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true); // no file deletion on failure
  assert.equal(store.getSnapshot().entries.length, 1);

  const deleted = await coordinator.deleteEntry(created.entryId);
  assert.equal(deleted.ok, true);
  assert.equal(store.getSnapshot().entries.length, 0);
  assert.equal(port.has(`${OBJECTS}/${draft.id}`), false);
});

test('a foreign/unowned media reference never authorizes deleting files', async () => {
  const { store, port, coordinator } = setup();
  await store.load();
  // A legacy row whose media came from the server (no local ownership record).
  port.seed('/sandbox/document/somewhere-else/secret.m4a', 1_000);
  const legacy = {
    version: 1,
    entries: [
      {
        id: 'legacy-entry',
        date: '2026-09-10',
        body: 'старая запись',
        tags: [],
        media: [
          {
            id: 'server-media-1',
            journalEntryId: 'legacy-entry',
            type: 'audio',
            mimeType: 'audio/mp4',
            sizeBytes: 1_000,
            durationMs: 2_000,
            transcriptEdited: false,
            transcriptionStatus: 'ready',
            transcript: 'Расшифровка',
            createdAt: '2026-09-10T10:00:00.000Z',
            updatedAt: '2026-09-10T10:00:00.000Z',
          },
        ],
        createdAt: '2026-09-10T10:00:00.000Z',
        updatedAt: '2026-09-10T10:00:00.000Z',
      },
    ],
    savedAt: '2026-09-10T10:00:00.000Z',
  };
  const adapter2 = storageAdapter({ raw: JSON.stringify(legacy) });
  const store2 = makeStore(adapter2);
  await store2.load();
  assert.equal(store2.getSnapshot().entries.length, 1);

  const result = await coordinator.deleteEntry('legacy-entry');
  assert.equal(result.ok, false); // nothing was committed through this coordinator
  assert.equal(store2.getSnapshot().entries.length, 1);
  assert.equal(port.has('/sandbox/document/somewhere-else/secret.m4a'), true);
  assert.equal(port.has(`${OBJECTS}/server-media-1`), false);
});

test('a superseded editor/recorder owner cannot write and keeps its files', async () => {
  const { adapter, store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000050');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 50 });

  // The sheet was closed and a NEWER editor/session took over.
  state.current = ownerFor(port, 'session-00000000-0000-4000-8000-000000000051', {
    sheetKey: 'journal-new-2',
    draftKey: 'draft-2',
    draftRevision: 5,
  });
  const before = adapter.raw();
  const refused = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(refused.ok, false);
  assert.equal(refused.failure.code, 'busy');
  assert.equal(adapter.raw(), before);
  assert.equal(store.getSnapshot().entries.length, 0);
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true); // file kept for retry
  assert.equal(coordinator.activeMediaIds().has(draft.id), true);
});

test('a stale draft revision is refused before any journal write', async () => {
  const { adapter, store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000060');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 60 });
  // The user typed more text meanwhile: the captured revision is stale.
  state.current = { ...owner, draftRevision: owner.draftRevision + 1 };
  const before = adapter.raw();
  const refused = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(refused.ok, false);
  assert.equal(refused.failure.code, 'busy');
  assert.equal(adapter.raw(), before);
});

test('the same take id cannot be referenced by two entries', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000070');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 70 });
  const created = await coordinator.commitNewEntry(owner, journalInput({ body: 'Первая' }), '2026-09-11', [draft]);
  assert.equal(created.ok, true);

  const again = await coordinator.commitNewEntry(owner, journalInput({ body: 'Вторая' }), '2026-09-11', [draft]);
  assert.equal(again.ok, false);
  assert.equal(again.failure.code, 'manifest-invalid');
  assert.equal(store.getSnapshot().entries.length, 1); // no duplicate row
  assert.equal(store.getSnapshot().entries[0].media.length, 1);
});

test('reconcile is blocked while the journal is unhydrated or corrupt, and retains unknown manifests', async () => {
  const { store, port, repository, coordinator } = setup();
  // Not loaded yet: nothing may be swept.
  const beforeLoad = await coordinator.reconcile();
  assert.equal(beforeLoad.blocked, true);
  await store.load();

  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000080');
  const draft = await take(repository, port, owner.sessionId, { index: 80 });
  const prepared = await repository.prepare(draft, owner);
  assert.equal(prepared.ok, true);

  // Ownerless owned object + an unknown directory: both are retained.
  port.dirs.add(`${OBJECTS}/not-a-media-id`);
  const swept = await coordinator.reconcile();
  assert.equal(swept.blocked, false);
  assert.deepEqual(swept.failed, []);
  assert.equal(port.has(`${OBJECTS}/${draft.id}`), false); // unreferenced owned object removed
  assert.equal(port.has(`${OBJECTS}/not-a-media-id`), true); // never guessed

  // A corrupt journal blocks every sweep.
  const corruptAdapter = storageAdapter({ raw: '{ broken' });
  const corruptStore = makeStore(corruptAdapter);
  await corruptStore.load();
  assert.equal(corruptStore.getSnapshot().phase, 'load-error');
  const corruptCoordinator = createJournalMediaCoordinator({
    repository,
    store: corruptStore,
    currentOwner: () => null,
  });
  port.seed('/native/after.m4a', 1_000);
  const draftAfter = await take(repository, port, 'session-00000000-0000-4000-8000-000000000081', { index: 81 });
  assert.equal((await repository.prepare(draftAfter, ownerFor(port, draftAfter.owner.sessionId))).ok, true);
  const blocked = await corruptCoordinator.reconcile();
  assert.equal(blocked.blocked, true);
  assert.equal(port.has(`${OBJECTS}/${draftAfter.id}`), true);
});

test('crash boundaries: orphan after promotion, retained reference after commit, retried interrupted delete', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000090');
  state.current = owner;

  // (a) Promotion finished, the process died BEFORE the JSON commit.
  const orphan = await take(repository, port, owner.sessionId, { index: 90 });
  assert.equal((await repository.prepare(orphan, owner)).ok, true);
  assert.equal(port.has(`${OBJECTS}/${orphan.id}/recording.m4a`), true);
  const swept = await coordinator.reconcile();
  assert.equal(port.has(`${OBJECTS}/${orphan.id}`), false); // owned orphan, no reference
  assert.equal(swept.blocked, false); // the journal WAS hydrated, so sweeping ran
  assert.equal(store.getSnapshot().entries.length, 0);

  // (b) The JSON commit succeeded: the reference keeps the file forever.
  const committed = await take(repository, port, owner.sessionId, { index: 91 });
  const created = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [committed]);
  assert.equal(created.ok, true);
  await coordinator.reconcile();
  assert.equal(port.has(`${OBJECTS}/${committed.id}/recording.m4a`), true);

  // (c) The metadata was removed but the process died before the file cleanup.
  const removed = await store.removeMedia(created.entryId, committed.id);
  assert.equal(removed.ok, true);
  assert.equal(port.has(`${OBJECTS}/${committed.id}/recording.m4a`), true);
  await coordinator.reconcile();
  assert.equal(port.has(`${OBJECTS}/${committed.id}`), false);
});

test('data-URL-like prose and transcripts survive while no URI/base64 enters the journal', async () => {
  const { adapter, store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000100');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 100 });
  const prose = 'data:text/plain;base64,SGVsbG8gd29ybGQ= и обычный текст';
  const created = await coordinator.commitNewEntry(
    owner,
    journalInput({ body: prose, changed: { title: false, body: true, mood: false, tags: false } }),
    '2026-09-11',
    [draft],
  );
  assert.equal(created.ok, true);
  const raw = adapter.raw();
  assert.equal(raw.includes(prose), true); // prose is preserved verbatim
  const parsed = parseSnapshot(raw);
  assert.equal(parsed.snapshot.entries[0].body, prose);
  assert.equal(parsed.snapshot.entries[0].media[0].id.startsWith('local-media-'), true);
  assert.equal(raw.includes('file://'), false);
});

test('a retry whose durable recording disappeared fails safely and commits no metadata', async () => {
  const { adapter, store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000200');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 200 });
  coordinator.lease(draft);

  const before = adapter.raw();
  adapter.failNextWrite();
  const failed = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(failed.ok, false);
  assert.equal(failed.failure.code, 'save-failed');
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true);

  // The durable recording vanishes (container/OS loss) while its manifest stays.
  port.files.delete(`${OBJECTS}/${draft.id}/recording.m4a`);
  const retry = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(retry.ok, false);
  assert.equal(retry.failure.code, 'file-missing');
  assert.equal(adapter.raw(), before); // committed Journal bytes unchanged
  assert.equal(store.getSnapshot().entries.length, 0); // no missing-file attachment committed
  assert.equal(coordinator.activeMediaIds().has(draft.id), true); // still retryable

  // A truncated file is also refused, and a complete file retries idempotently.
  port.seed(`${OBJECTS}/${draft.id}/recording.m4a`, draft.sizeBytes - 1);
  const truncated = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(truncated.ok, false);
  assert.equal(truncated.failure.code, 'file-missing');
  port.seed(`${OBJECTS}/${draft.id}/recording.m4a`, draft.sizeBytes);
  const restored = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(restored.ok, true);
  assert.equal(store.getSnapshot().entries.length, 1);
  assert.equal(store.getSnapshot().entries[0].media.length, 1);
});

test('an adopted, unsaved take is protected by a draft lease from concurrent sweeps', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000210');
  state.current = owner;

  // Watermark: an abandoned staging take IS reclaimable (no lease at all).
  const abandoned = await take(repository, port, 'session-00000000-0000-4000-8000-000000000211', {
    index: 211,
  });
  await coordinator.reconcile();
  assert.equal(port.has(abandoned.stagingPath), false);

  // A live draft take (leased at Use) survives the very same sweep.
  const live = await take(repository, port, owner.sessionId, { index: 210 });
  coordinator.lease(live);
  await coordinator.reconcile();
  assert.equal(port.has(live.stagingPath), true);

  // A promoted-but-unsaved take under a lease also survives...
  const promoted = await repository.prepare(live, owner);
  assert.equal(promoted.ok, true);
  await coordinator.reconcile();
  assert.equal(port.has(`${OBJECTS}/${live.id}/recording.m4a`), true);

  // ...and after a successful save it is kept by the COMMITTED reference instead.
  const committed = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [live]);
  assert.equal(committed.ok, true);
  assert.equal(coordinator.activeMediaIds().has(live.id), false); // the lease was released
  await coordinator.reconcile();
  assert.equal(port.has(`${OBJECTS}/${live.id}/recording.m4a`), true);
  const resolved = await repository.resolve({ id: live.id, type: 'audio', mimeType: 'audio/mp4' });
  assert.equal('unavailable' in resolved, false);
});

test('explicit abandonment releases the lease and cleans staged/promoted files', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000220');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 220 });
  coordinator.lease(draft);
  assert.equal((await repository.prepare(draft, owner)).ok, true);

  const cleanup = await coordinator.abandonDrafts([draft]);
  assert.deepEqual(cleanup.failed, []);
  assert.equal(port.has(`${OBJECTS}/${draft.id}`), false);
  assert.equal(coordinator.activeMediaIds().has(draft.id), false); // no leaked lease
  assert.equal(coordinator.activeSessionIds().has(owner.sessionId), false);
  const later = await coordinator.reconcile();
  assert.equal(later.blocked, false);
  assert.deepEqual(later.failed, []);
});

test('a cleanup failure during abandonment stays recoverable and retryable', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000230');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 230 });
  coordinator.lease(draft);
  assert.equal((await repository.prepare(draft, owner)).ok, true);

  // The owned object directory cannot be removed right now.
  port.failOperation('remove', { path: `${OBJECTS}/${draft.id}` });
  const cleanup = await coordinator.abandonDrafts([draft]);
  assert.equal(cleanup.failed.length > 0, true); // reported, not hidden
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true); // file still owned
  assert.equal(coordinator.activeMediaIds().has(draft.id), false); // the lease is gone

  // The next sweep reclaims it: no permanent leak, no user-data risk.
  const later = await coordinator.reconcile();
  assert.equal(port.has(`${OBJECTS}/${draft.id}`), false);
  assert.equal(later.blocked, false);
});

test('a live recorder session lease protects its staging take from a sweep', async () => {
  const { store, port, repository, coordinator } = setup();
  await store.load();
  const session = 'session-00000000-0000-4000-8000-000000000240';
  const draft = await take(repository, port, session, { index: 240 });
  coordinator.leaseSession(session);
  await coordinator.reconcile();
  assert.equal(port.has(draft.stagingPath), true); // an in-flight recorder is never swept
  coordinator.releaseSession(session);
  await coordinator.reconcile();
  assert.equal(port.has(draft.stagingPath), false); // released => reclaimable
});

test('destructive sweeps and commits are serialized in both orders', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000250');
  state.current = owner;
  const draft = await take(repository, port, owner.sessionId, { index: 250 });
  coordinator.lease(draft);

  // A sweep queued BEFORE the commit cannot delete what the commit publishes.
  const sweepingFirst = coordinator.reconcile();
  const committing = coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  const [sweepResult, commitResult] = await Promise.all([sweepingFirst, committing]);
  assert.equal(commitResult.ok, true);
  assert.equal('blocked' in sweepResult ? sweepResult.blocked : false, false);
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true);

  // The other order: a sweep queued AFTER the commit sees the fresh reference.
  const second = await take(repository, port, owner.sessionId, { index: 251 });
  coordinator.lease(second);
  const commitSecond = coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [second]);
  const sweepSecond = coordinator.reconcile();
  const [committedSecond, sweptSecond] = await Promise.all([commitSecond, sweepSecond]);
  assert.equal(committedSecond.ok, true);
  assert.equal(sweptSecond.blocked, false);

  const resolved = await repository.resolve({ id: second.id, type: 'audio', mimeType: 'audio/mp4' });
  assert.equal('unavailable' in resolved, false);
  for (const entry of store.getSnapshot().entries) {
    assert.equal(entry.media.length, 1);
  }
});

/**
 * Minimal fake NATIVE dependencies for the production binding core, so the real
 * controller + real repository + real coordinator are exercised end to end.
 */
function recordingController(repository) {
  const native = {
    recording: false,
    durationMillis: 0,
    uri: null,
    listener: null,
    restoreCalls: 0,
  };
  const deps = {
    audio: {
      enableRecordingMode: async () => undefined,
      restorePlaybackMode: async () => {
        native.restoreCalls += 1;
      },
      prepareRecording: async () => undefined,
      startRecording: () => {
        native.recording = true;
        native.durationMillis = 0;
      },
      stopRecording: async () => {
        native.recording = false;
        native.durationMillis = 0;
      },
      status: () => ({
        durationMillis: native.durationMillis,
        isRecording: native.recording,
        url: native.uri,
      }),
      uri: () => native.uri,
      setStatusListener: (listener) => {
        native.listener = listener;
      },
    },
    video: { getDevice: () => null },
    probeFinalAudioDurationMs: async () => native.durationMillis,
    probeVideoDurationMs: async () => null,
    permissions: {
      get: async () => ({ status: 'granted', canAskAgain: true }),
      request: async () => ({ status: 'granted', canAskAgain: true }),
    },
    files: { size: async () => 4_000, remove: async () => undefined },
    clock: { monotonicMs: () => 1_000 },
    repository,
    identity: { authorize: () => null },
    createSessionId: () => 'session-00000000-0000-4000-8000-000000000900',
    schedule: () => () => undefined,
    mimeForUri: () => 'audio/mp4',
    isLifecycleAuthorized: () => true,
  };
  return { native, controller: createRecorderController(createRecorderPortsFromDeps(deps)) };
}

test('Use -> surface teardown -> real Journal save succeeds with the file intact', async () => {
  const { store, port, repository, coordinator, state } = setup();
  await store.load();
  const owner = ownerFor(port, 'session-00000000-0000-4000-8000-000000000900');
  state.current = owner;

  const { native, controller } = recordingController(repository);
  await controller.startAudio({
    sheetKey: owner.sheetKey,
    entryId: null,
    draftKey: owner.draftKey,
    draftRevision: owner.draftRevision,
  });
  assert.equal(controller.getSnapshot().state, 'recording');

  // The native recorder finishes with 5 s of audio at a real sandbox URI.
  const nativeUri = `/native/take-900.m4a`;
  port.seed(nativeUri, 4_000);
  native.uri = nativeUri;
  native.durationMillis = 5_000;
  native.recording = false;
  native.listener?.({ isFinished: true, hasError: false, error: null, url: nativeUri });
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(controller.getSnapshot().state, 'preview');

  const outcome = await controller.useTake();
  assert.equal(outcome.ok, true);
  const draft = outcome.draft;
  coordinator.lease(draft); // the editor/draft lease taken at Use

  // The production surface teardown (hook unmount), exactly as the app runs it.
  const lifecycle = createRecorderSurfaceLifecycle({
    releaseSessionLease: () => undefined,
    cancel: () => controller.cancel(),
  });
  await lifecycle.dispose();
  assert.equal(controller.getSnapshot().state, 'cancelled');

  // The editor-owned staged file survived the recorder teardown...
  assert.equal(port.has(draft.stagingPath), true);

  // ...and the real Journal save succeeds with metadata + a playable file.
  const committed = await coordinator.commitNewEntry(owner, journalInput(), '2026-09-11', [draft]);
  assert.equal(committed.ok, true);
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true);
  const resolved = await repository.resolve({ id: draft.id, type: 'audio', mimeType: 'audio/mp4' });
  assert.equal('unavailable' in resolved, false);

  // And the committed attachment is protected from a later sweep.
  await coordinator.reconcile();
  assert.equal(port.has(`${OBJECTS}/${draft.id}/recording.m4a`), true);
});
