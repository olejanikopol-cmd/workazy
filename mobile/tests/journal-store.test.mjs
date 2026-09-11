import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournalStore } from '../src/features/journal/journalStore.ts';
import {
  JOURNAL_STORAGE_KEY,
  parseSnapshot,
  serializeSnapshot,
} from '../src/storage/journalStorage.ts';

const NOW = new Date('2026-09-11T12:00:00.000Z');
const SAVED_AT = '2026-09-11T11:00:00.000Z';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function adapter({ raw = null } = {}) {
  const log = [];
  let rawValue = raw;
  let failWrite = false;
  let readGate = null;
  return {
    log,
    raw: () => rawValue,
    failNextWrite() {
      failWrite = true;
    },
    gateReads(gate) {
      readGate = gate;
    },
    async getItem(key) {
      log.push(`get:${key}`);
      if (readGate) await readGate.promise;
      return rawValue;
    },
    async setItem(key, value) {
      log.push(`set:${key}`);
      if (failWrite) {
        failWrite = false;
        throw new Error('write failed');
      }
      rawValue = value;
    },
  };
}

function store(adapterRef, { now = () => NOW, id = 'entry-1' } = {}) {
  return createJournalStore({
    storage: adapterRef,
    now,
    createId: () => id,
  });
}

function input(overrides = {}) {
  const { changed, ...values } = overrides;
  return {
    title: '',
    body: 'Текст',
    mood: '',
    tags: '',
    ...values,
    changed: { title: false, body: false, mood: false, tags: false, ...(changed ?? {}) },
  };
}

test('missing key is a ready empty store and writes nothing', async () => {
  const storage = adapter();
  const s = store(storage);
  await s.load();
  assert.equal(s.getSnapshot().phase, 'ready');
  assert.deepEqual(s.getSnapshot().entries, []);
  assert.deepEqual(storage.log, [`get:${JOURNAL_STORAGE_KEY}`]);
});

test('published snapshots are frozen: external mutation cannot touch committed state', async () => {
  const storage = adapter();
  let counter = 0;
  const s = createJournalStore({ storage, now: () => NOW, createId: () => `entry-${++counter}` });
  await s.load();
  await s.add(
    input({ body: 'Сохранённое', tags: 'дом', changed: { tags: true } }),
    '2026-09-10',
  );
  await s.add(
    input({ body: 'С медиа' }),
    '2026-09-11',
  );
  // Attach media metadata through a load round-trip (no media mutation API).
  const withMedia = serializeSnapshot(
    [
      {
        id: 'entry-1',
        date: '2026-09-11',
        body: 'С медиа',
        tags: [],
        media: [
          {
            id: 'media-1',
            journalEntryId: 'entry-1',
            type: 'audio',
            mimeType: 'audio/m4a',
            sizeBytes: 10,
            transcript: 'текст',
            transcriptEdited: false,
            transcriptionStatus: 'ready',
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        ],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ],
    SAVED_AT,
  );
  const mediaStorage = adapter({ raw: withMedia });
  const mediaStore = createJournalStore({ storage: mediaStorage, now: () => NOW, createId: () => 'x' });
  await mediaStore.load();
  const mediaSnapshot = mediaStore.getSnapshot();
  let notifications = 0;
  mediaStore.subscribe(() => (notifications += 1));

  // 1) row body
  assert.throws(() => {
    mediaSnapshot.entries[0].body = 'взлом';
  }, TypeError);
  // 2) tags array
  assert.throws(() => {
    mediaSnapshot.entries[0].tags.push('взлом');
  }, TypeError);
  // 3) nested media object (transcription field included)
  assert.throws(() => {
    mediaSnapshot.entries[0].media[0].transcript = 'взлом';
  }, TypeError);
  // 4) media array itself
  assert.throws(() => {
    mediaSnapshot.entries[0].media.pop();
  }, TypeError);

  assert.equal(mediaStore.getSnapshot().entries[0].body, 'С медиа');
  assert.equal(mediaStore.getSnapshot().entries[0].media[0].transcript, 'текст');
  assert.equal(notifications, 0); // no subscriber notification
  assert.equal(mediaStorage.log.filter((line) => line.startsWith('set:')).length, 0); // no write

  // 5) a later legitimate mutation must not persist any attempted change.
  const edited = await mediaStore.edit('entry-1', input({
    title: 'Правка',
    body: 'С медиа',
    tags: '',
    changed: { title: true },
  }));
  assert.equal(edited.ok, true);
  const reloaded = parseSnapshot(mediaStorage.raw());
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.snapshot.entries[0].body, 'С медиа');
  assert.deepEqual(reloaded.snapshot.entries[0].tags, []);
  assert.equal(reloaded.snapshot.entries[0].media[0].transcript, 'текст');
  assert.equal(reloaded.snapshot.entries[0].title, 'Правка');
});

test('published idea/entry arrays stay a stable reference for subscribers', async () => {
  const storage = adapter();
  const s = store(storage);
  await s.load();
  const first = s.getSnapshot();
  assert.equal(s.getSnapshot(), first); // stable identity (useSyncExternalStore)
  const list = s.getSnapshot().entries;
  assert.throws(() => {
    list.push({ id: 'x', date: '2026-01-01', body: 'x', tags: [] });
  }, TypeError);
  assert.deepEqual(s.getSnapshot().entries, []);
});

test('concurrent hydration coalesces into a single read and a second load is a no-op', async () => {
  const gate = deferred();
  const storage = adapter();
  storage.gateReads(gate);
  const s = store(storage);
  const first = s.load();
  const second = s.load();
  assert.equal(storage.log.length, 1);
  gate.resolve();
  await Promise.all([first, second]);
  await s.load();
  assert.equal(storage.log.filter((line) => line.startsWith('get:')).length, 1);
  assert.equal(s.getSnapshot().phase, 'ready');
});

test('mutations before hydration are rejected without writing', async () => {
  const gate = deferred();
  const storage = adapter();
  storage.gateReads(gate);
  const s = store(storage);
  const loading = s.load();
  assert.deepEqual(await s.add(input(), '2026-09-11'), { ok: false, reason: 'not-ready' });
  assert.deepEqual(await s.remove('entry-1'), { ok: false, reason: 'not-ready' });
  gate.resolve();
  await loading;
  assert.equal(storage.log.some((line) => line.startsWith('set:')), false);
});

test('a second mutation while a write is pending returns busy and writes once', async () => {
  const storage = adapter();
  const s = store(storage);
  await s.load();
  storage.log.length = 0;
  // Block the first write by gating the storage call.
  const originalSet = storage.setItem.bind(storage);
  let release;
  const writeGate = new Promise((res) => {
    release = res;
  });
  storage.setItem = async (key, value) => {
    await writeGate;
    return originalSet(key, value);
  };
  const first = s.add(input({ body: 'Первый' }), '2026-09-11');
  const second = s.add(input({ body: 'Второй' }), '2026-09-11');
  assert.deepEqual(await second, { ok: false, reason: 'busy' });
  release();
  assert.deepEqual(await first, { ok: true, id: 'entry-1' });
  assert.equal(s.getSnapshot().entries.length, 1);
  assert.equal(s.getSnapshot().entries[0].body, 'Первый');
  assert.equal(storage.log.filter((line) => line.startsWith('set:')).length, 1);
});

test('a failed write keeps committed state, stores unchanged bytes and allows a retry', async () => {
  const storage = adapter();
  const s = store(storage);
  await s.load();
  const before = storage.raw();
  storage.failNextWrite();
  const failed = await s.add(input({ body: 'Черновик' }), '2026-09-11');
  assert.deepEqual(failed, { ok: false, reason: 'storage' });
  assert.deepEqual(s.getSnapshot().entries, []);
  assert.equal(storage.raw(), before); // bytes untouched
  assert.ok(s.getSnapshot().error);

  const retried = await s.add(input({ body: 'Черновик' }), '2026-09-11');
  assert.equal(retried.ok, true);
  assert.equal(s.getSnapshot().entries.length, 1);
});

test('corrupt bytes stay untouched, mutations are blocked and retry re-reads only this key', async () => {
  const corrupt = '{ not json';
  const storage = adapter({ raw: corrupt });
  const s = store(storage);
  await s.load();
  assert.equal(s.getSnapshot().phase, 'load-error');
  assert.deepEqual(await s.add(input(), '2026-09-11'), { ok: false, reason: 'not-ready' });
  assert.equal(storage.raw(), corrupt);
  assert.deepEqual(storage.log, [`get:${JOURNAL_STORAGE_KEY}`]);
  await s.retryLoad();
  assert.deepEqual(storage.log, [`get:${JOURNAL_STORAGE_KEY}`, `get:${JOURNAL_STORAGE_KEY}`]);
  assert.equal(s.getSnapshot().phase, 'load-error'); // still corrupt, still untouched
});

test('restart round-trip keeps a 100k body exactly, and an unrelated edit preserves it', async () => {
  const body = 'Ж'.repeat(100_000) + '\n\n🌙 e\u0301  конец';
  const storageA = adapter();
  const storeA = store(storageA);
  await storeA.load();
  const added = await storeA.add(
    input({ title: 'Длинная', body, mood: 'Спокойно', tags: 'дом, работа' }),
    '2026-09-11',
  );
  assert.equal(added.ok, true);
  const bytes = storageA.raw();

  const storageB = adapter({ raw: bytes });
  const storeB = store(storageB, { now: () => new Date('2026-09-11T13:00:00.000Z') });
  await storeB.load();
  const [entry] = storeB.getSnapshot().entries;
  assert.equal(entry.body, body.trim());
  assert.equal(entry.title, 'Длинная');
  assert.equal(entry.mood, 'Спокойно');
  assert.deepEqual(entry.tags, ['дом', 'работа']);

  // Unrelated edit (title only) keeps the body byte-for-byte, then restart again.
  const edited = await storeB.edit(entry.id, {
    title: 'Другая',
    body: entry.body,
    mood: entry.mood ?? '',
    tags: entry.tags.join(', '),
    changed: { title: true },
  });
  assert.equal(edited.ok, true);
  const storageC = adapter({ raw: storageB.raw() });
  const storeC = store(storageC);
  await storeC.load();
  assert.equal(storeC.getSnapshot().entries[0].body, body.trim());
  assert.equal(storeC.getSnapshot().entries[0].title, 'Другая');
  // Only the journal key was ever touched (no Plan/Calendar writes, no seeds).
  for (const line of [...storageA.log, ...storageB.log, ...storageC.log]) {
    assert.equal(line.endsWith(JOURNAL_STORAGE_KEY), true, line);
  }
});

test('edit/remove keep identity, date, createdAt and stored order', async () => {
  let counter = 0;
  const storage = adapter();
  const s = createJournalStore({
    storage,
    now: () => NOW,
    createId: () => `entry-${++counter}`,
  });
  await s.load();
  await s.add(input({ body: 'Первая' }), '2026-09-10');
  await s.add(input({ body: 'Вторая' }), '2026-09-11');
  const [second, first] = s.getSnapshot().entries; // newest prepended
  assert.equal(first.body, 'Первая');
  const edited = await s.edit(first.id, input({ body: 'Первая (правка)' }), '2026-09-10');
  assert.equal(edited.ok, true);
  const rows = s.getSnapshot().entries;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].id, first.id); // position preserved
  assert.equal(rows[1].date, '2026-09-10');
  assert.equal(rows[1].createdAt, first.createdAt);
  assert.equal(rows[1].updatedAt, NOW.toISOString());

  const removed = await s.remove(second.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(s.getSnapshot().entries.map((row) => row.id), [first.id]);
});

test('a 0000 date is rejected before any write (zero writes)', async () => {
  const storage = adapter();
  const s = store(storage);
  await s.load();
  const before = storage.raw();
  assert.deepEqual(await s.add(input(), '0000-01-01'), { ok: false, reason: 'date-invalid' });
  assert.deepEqual(await s.add(input(), '2026-02-30'), { ok: false, reason: 'date-invalid' });
  assert.deepEqual(s.getSnapshot().entries, []);
  assert.equal(storage.raw(), before);
  assert.equal(storage.log.filter((line) => line.startsWith('set:')).length, 0);
});

test('a generated-ID collision fails safely with zero invalid snapshot persisted', async () => {
  const storage = adapter();
  let counter = 0;
  const s = createJournalStore({
    storage,
    now: () => NOW,
    createId: () => `entry-${++counter}`,
  });
  await s.load();
  await s.add(input({ body: 'Первая' }), '2026-09-10');
  const bytesAfterFirst = storage.raw();

  // The generator now hands back an id that already exists.
  const colliding = createJournalStore({
    storage,
    now: () => NOW,
    createId: () => 'entry-1',
  });
  await colliding.load();
  const result = await colliding.add(input({ body: 'Вторая' }), '2026-09-11');
  assert.deepEqual(result, { ok: false, reason: 'duplicate-id' });
  assert.equal(storage.raw(), bytesAfterFirst); // nothing invalid was persisted
  assert.equal(colliding.getSnapshot().entries.length, 1);
  assert.ok(colliding.getSnapshot().error);
  // The stored bytes still reload (never a snapshot the parser would reject).
  assert.equal(parseSnapshot(storage.raw()).ok, true);
});

test('every successful mutation produces bytes a fresh store can reload', async () => {
  const storage = adapter();
  let counter = 0;
  const s = createJournalStore({
    storage,
    now: () => NOW,
    createId: () => `entry-${++counter}`,
  });
  await s.load();

  const steps = [
    () => s.add(input({ title: 'Первая', body: 'Тело', tags: 'дом', changed: { tags: true } }), '2026-09-10'),
    () => s.add(input({ body: 'Вторая', mood: 'Спокойно' }), '2026-09-11'),
    () => s.edit('entry-1', input({ title: 'Правка', body: 'Тело', tags: 'дом', changed: { title: true } })),
    () => s.edit('entry-2', input({ body: 'Вторая', mood: 'Радостно', changed: { mood: true } })),
    () => s.remove('entry-1'),
  ];
  for (const step of steps) {
    const result = await step();
    assert.equal(result.ok, true);
    const bytes = storage.raw();
    const parsed = parseSnapshot(bytes);
    assert.equal(parsed.ok, true, 'written bytes must parse');
    // A brand-new store hydrates the same bytes successfully.
    const fresh = store(adapter({ raw: bytes }));
    await fresh.load();
    assert.equal(fresh.getSnapshot().phase, 'ready');
    assert.deepEqual(fresh.getSnapshot().entries, s.getSnapshot().entries);
  }
});

test('early years 0001/0009/0099/0100 remain valid through persistence', async () => {
  const storage = adapter();
  let counter = 0;
  const s = createJournalStore({ storage, now: () => NOW, createId: () => `entry-${++counter}` });
  await s.load();
  for (const date of ['0001-01-01', '0009-09-09', '0099-12-31', '0100-01-01']) {
    const result = await s.add(input({ body: `Запись ${date}` }), date);
    assert.equal(result.ok, true, date);
  }
  const parsed = parseSnapshot(storage.raw());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.snapshot.entries.map((row) => row.date).sort(), [
    '0001-01-01',
    '0009-09-09',
    '0099-12-31',
    '0100-01-01',
  ]);
  // 0000 stays rejected while the early years above stay accepted.
  assert.deepEqual(await s.add(input(), '0000-12-31'), { ok: false, reason: 'date-invalid' });
});

test('the published snapshot WRAPPER is frozen (initial, empty and after every publish)', async () => {
  const storage = adapter();
  const s = store(storage);

  // Initial wrapper, before any hydration: replacing/mutating it must throw.
  const initial = s.getSnapshot();
  assert.throws(() => {
    initial.entries = [];
  }, TypeError);
  assert.throws(() => {
    initial.phase = 'ready';
  }, TypeError);
  assert.throws(() => {
    initial.saving = true;
  }, TypeError);
  assert.equal(s.getSnapshot().phase, 'loading');
  assert.deepEqual(s.getSnapshot().entries, []);

  await s.load();
  await s.add(input({ body: 'Запись' }), '2026-09-11');
  let notifications = 0;
  s.subscribe(() => (notifications += 1));
  const writesBefore = storage.log.filter((line) => line.startsWith('set:')).length;

  const snapshot = s.getSnapshot();
  assert.throws(() => {
    snapshot.entries = [];
  }, TypeError);
  assert.throws(() => {
    snapshot.phase = 'load-error';
  }, TypeError);
  assert.throws(() => {
    snapshot.saving = true;
  }, TypeError);
  assert.throws(() => {
    snapshot.error = 'взлом';
  }, TypeError);

  const after = s.getSnapshot();
  assert.equal(after, snapshot); // getSnapshot() still returns the unchanged view
  assert.equal(after.entries.length, 1);
  assert.equal(after.phase, 'ready');
  assert.equal(after.saving, false);
  assert.equal(after.error, null);
  assert.equal(notifications, 0); // no subscriber notification
  assert.equal(storage.log.filter((line) => line.startsWith('set:')).length, writesBefore);

  // A later legitimate mutation persists ONLY the legitimate change.
  const ok = await s.edit('entry-1', input({ body: 'Правка', changed: { body: true } }));
  assert.equal(ok.ok, true);
  const parsed = parseSnapshot(storage.raw());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.entries.length, 1);
  assert.equal(parsed.snapshot.entries[0].body, 'Правка');
  assert.equal('phase' in parsed.snapshot.entries[0], false); // no wrapper fields leaked
  assert.equal('error' in parsed.snapshot.entries[0], false);
});

test('separate journal store instances cannot poison shared empty state', async () => {
  const a = store(adapter());
  const b = store(adapter());
  const aInitial = a.getSnapshot();
  assert.throws(() => {
    aInitial.entries.push({ id: 'x', date: '2026-01-01', body: 'x', tags: [] });
  }, TypeError);
  assert.equal(a.getSnapshot().phase, 'loading');
  await b.load();
  assert.deepEqual(b.getSnapshot().entries, []);
  assert.equal(b.getSnapshot().phase, 'ready');
});
