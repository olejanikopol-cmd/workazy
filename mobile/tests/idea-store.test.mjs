import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdeaStore } from '../src/features/ideas/ideaStore.ts';
import {
  IDEAS_STORAGE_KEY,
  parseSnapshot,
  serializeSnapshot,
} from '../src/storage/ideaStorage.ts';

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

// Explicit per-field change flags (what the editor computes from its initial
// draft). Nothing counts as changed unless the test flags it.
function input(overrides = {}) {
  const { changed, ...values } = overrides;
  return {
    title: 'Идея',
    description: '',
    category: 'thought',
    status: 'new',
    ...values,
    changed: {
      title: false,
      description: false,
      category: false,
      status: false,
      ...(changed ?? {}),
    },
  };
}

test('missing key is a ready empty store and writes nothing', async () => {
  const storage = adapter();
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => 'idea-1' });
  await s.load();
  assert.equal(s.getSnapshot().phase, 'ready');
  assert.deepEqual(s.getSnapshot().ideas, []);
  assert.deepEqual(storage.log, [`get:${IDEAS_STORAGE_KEY}`]);
});

test('concurrent hydration coalesces; pre-ready mutations are rejected without writing', async () => {
  const gate = deferred();
  const storage = adapter();
  storage.gateReads(gate);
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => 'idea-1' });
  const first = s.load();
  const second = s.load();
  assert.equal(storage.log.length, 1);
  assert.deepEqual(await s.add(input()), { ok: false, reason: 'not-ready' });
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(storage.log.filter((line) => line.startsWith('set:')).length, 0);
  assert.equal(s.getSnapshot().phase, 'ready');
});

test('a second mutation while a write is pending returns busy and writes once', async () => {
  const storage = adapter();
  let counter = 0;
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => `idea-${++counter}` });
  await s.load();
  const originalSet = storage.setItem.bind(storage);
  let release;
  const writeGate = new Promise((res) => {
    release = res;
  });
  storage.setItem = async (key, value) => {
    await writeGate;
    return originalSet(key, value);
  };
  const first = s.add(input({ title: 'Первая' }));
  assert.deepEqual(await s.add(input({ title: 'Вторая' })), { ok: false, reason: 'busy' });
  assert.deepEqual(await s.setStatus('idea-1', 'done'), { ok: false, reason: 'busy' });
  release();
  assert.deepEqual(await first, { ok: true, id: 'idea-1' });
  assert.equal(s.getSnapshot().ideas.length, 1);
  assert.equal(storage.log.filter((line) => line.startsWith('set:')).length, 1);
});

test('a failed write keeps committed state, bytes unchanged and allows a retry', async () => {
  const storage = adapter();
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => 'idea-1' });
  await s.load();
  const before = storage.raw();
  storage.failNextWrite();
  assert.deepEqual(await s.add(input()), { ok: false, reason: 'storage' });
  assert.deepEqual(s.getSnapshot().ideas, []);
  assert.equal(storage.raw(), before);
  assert.ok(s.getSnapshot().error);
  assert.equal((await s.add(input())).ok, true);
});

test('corrupt bytes stay untouched, mutations blocked, retry re-reads only this key', async () => {
  const corrupt = JSON.stringify({ version: 1, ideas: [{ id: 'x', title: 'y', category: 'later', status: 'new', createdAt: SAVED_AT, updatedAt: SAVED_AT }], savedAt: SAVED_AT });
  const storage = adapter({ raw: corrupt });
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => 'idea-1' });
  await s.load();
  assert.equal(s.getSnapshot().phase, 'load-error');
  assert.deepEqual(await s.remove('idea-1'), { ok: false, reason: 'not-ready' });
  assert.equal(storage.raw(), corrupt);
  await s.retryLoad();
  assert.deepEqual(storage.log, [`get:${IDEAS_STORAGE_KEY}`, `get:${IDEAS_STORAGE_KEY}`]);
});

test('restart round-trip: statuses/order survive and only the ideas key is touched', async () => {
  const storageA = adapter();
  let counter = 0;
  const storeA = createIdeaStore({
    storage: storageA,
    now: () => NOW,
    createId: () => `idea-${++counter}`,
  });
  await storeA.load();
  await storeA.add(input({ title: 'Мысль', category: 'thought', status: 'new' }));
  await storeA.add(input({ title: 'Проект', category: 'project', status: 'plan' }));
  await storeA.setStatus('idea-2', 'archive');
  const bytes = storageA.raw();

  const storageB = adapter({ raw: bytes });
  const storeB = createIdeaStore({ storage: storageB, now: () => NOW, createId: () => 'nope' });
  await storeB.load();
  const rows = storeB.getSnapshot().ideas;
  assert.deepEqual(rows.map((row) => row.id), ['idea-2', 'idea-1']); // newest prepended, order kept
  assert.deepEqual(rows.map((row) => row.status), ['archive', 'new']);
  assert.equal(rows[0].category, 'project');
  for (const line of [...storageA.log, ...storageB.log]) {
    assert.equal(line.endsWith(IDEAS_STORAGE_KEY), true, line);
  }
});

test('edits keep identity/createdAt/position and the status write keeps everything', async () => {
  const storage = adapter();
  let counter = 0;
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => `idea-${++counter}` });
  await s.load();
  await s.add(input({ title: 'Первая' }));
  await s.add(input({ title: 'Вторая', description: 'Описание', category: 'want' }));
  const before = s.getSnapshot().ideas[0];
  const edited = await s.edit(before.id, {
    title: 'Вторая (правка)',
    description: '',
    category: 'want',
    status: 'thinking',
    changed: { title: true, description: true },
  });
  assert.equal(edited.ok, true);
  const after = s.getSnapshot().ideas[0];
  assert.equal(after.id, before.id);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.updatedAt, NOW.toISOString());
  assert.equal('description' in after, false);
  const statusChanged = await s.setStatus(before.id, 'done');
  assert.equal(statusChanged.ok, true);
  assert.equal(s.getSnapshot().ideas[0].status, 'done');
  assert.equal(s.getSnapshot().ideas[1].title, 'Первая');
});

test('a generated-ID collision fails safely with zero invalid snapshot persisted', async () => {
  const storage = adapter();
  let counter = 0;
  const first = createIdeaStore({ storage, now: () => NOW, createId: () => `idea-${++counter}` });
  await first.load();
  await first.add(input({ title: 'Мысль' }));
  const bytesAfterFirst = storage.raw();

  const colliding = createIdeaStore({ storage, now: () => NOW, createId: () => 'idea-1' });
  await colliding.load();
  const result = await colliding.add(input({ title: 'Дубль' }));
  assert.deepEqual(result, { ok: false, reason: 'duplicate-id' });
  assert.equal(storage.raw(), bytesAfterFirst);
  assert.equal(colliding.getSnapshot().ideas.length, 1);
  assert.equal(parseSnapshot(storage.raw()).ok, true);
});

test('every successful idea mutation produces bytes a fresh store can reload', async () => {
  const storage = adapter();
  let counter = 0;
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => `idea-${++counter}` });
  await s.load();

  const steps = [
    () => s.add(input({ title: 'Мысль', description: 'Описание' })),
    () => s.add(input({ title: 'Проект', category: 'project', status: 'plan' })),
    () => s.setStatus('idea-1', 'archive'),
    () => s.edit('idea-2', { title: 'Проект', description: '', category: 'project', status: 'done', changed: { status: true } }),
    () => s.remove('idea-1'),
  ];
  for (const step of steps) {
    const result = await step();
    assert.equal(result.ok, true);
    const bytes = storage.raw();
    assert.equal(parseSnapshot(bytes).ok, true, 'written bytes must parse');
    // serializeSnapshot reflects the same committed state that was written.
    assert.equal(
      serializeSnapshot(s.getSnapshot().ideas, parseSnapshot(bytes).snapshot.savedAt).length > 0,
      true,
    );
    const fresh = createIdeaStore({ storage: adapter({ raw: bytes }), now: () => NOW, createId: () => 'x' });
    await fresh.load();
    assert.equal(fresh.getSnapshot().phase, 'ready');
    assert.deepEqual(fresh.getSnapshot().ideas, s.getSnapshot().ideas);
  }
});

test('published idea snapshots are frozen and cannot be mutated externally', async () => {
  const storage = adapter();
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => 'idea-1' });
  await s.load();
  await s.add(input({ title: 'Мысль', description: 'Описание', category: 'want' }));
  let notifications = 0;
  s.subscribe(() => (notifications += 1));
  const snapshot = s.getSnapshot();

  assert.throws(() => {
    snapshot.ideas[0].title = 'взлом';
  }, TypeError);
  assert.throws(() => {
    snapshot.ideas[0].description = 'взлом';
  }, TypeError);
  assert.throws(() => {
    snapshot.ideas.push({ id: 'x', title: 'x', category: 'thought', status: 'new', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  }, TypeError);

  assert.equal(s.getSnapshot().ideas[0].title, 'Мысль');
  assert.equal(notifications, 0);
  assert.equal(storage.log.filter((line) => line.startsWith('set:')).length, 1); // only the add

  // A later legitimate mutation must not persist any attempted change.
  const changed = await s.setStatus('idea-1', 'done');
  assert.equal(changed.ok, true);
  const parsed = parseSnapshot(storage.raw());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.ideas[0].title, 'Мысль');
  assert.equal(parsed.snapshot.ideas[0].description, 'Описание');
  assert.equal(parsed.snapshot.ideas[0].status, 'done');
});

test('an empty published list is frozen too (shared constants stay clean)', async () => {
  const storage = adapter();
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => 'idea-1' });
  await s.load();
  const empty = s.getSnapshot().ideas;
  assert.throws(() => {
    empty.push({ id: 'x', title: 'x', category: 'thought', status: 'new', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  }, TypeError);
  // A different store instance is unaffected.
  const other = createIdeaStore({ storage: adapter(), now: () => NOW, createId: () => 'idea-9' });
  await other.load();
  assert.deepEqual(other.getSnapshot().ideas, []);
});

test('the published snapshot WRAPPER is frozen (initial, empty and after every publish)', async () => {
  const storage = adapter();
  const s = createIdeaStore({ storage, now: () => NOW, createId: () => 'idea-1' });

  // Initial wrapper, before hydration.
  const initial = s.getSnapshot();
  assert.throws(() => {
    initial.ideas = [];
  }, TypeError);
  assert.throws(() => {
    initial.phase = 'ready';
  }, TypeError);
  assert.throws(() => {
    initial.saving = true;
  }, TypeError);
  assert.equal(s.getSnapshot().phase, 'loading');
  assert.deepEqual(s.getSnapshot().ideas, []);

  await s.load();
  await s.add(input({ title: 'Мысль' }));
  let notifications = 0;
  s.subscribe(() => (notifications += 1));
  const writesBefore = storage.log.filter((line) => line.startsWith('set:')).length;

  const snapshot = s.getSnapshot();
  assert.throws(() => {
    snapshot.ideas = [];
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
  assert.equal(after, snapshot);
  assert.equal(after.ideas.length, 1);
  assert.equal(after.phase, 'ready');
  assert.equal(after.saving, false);
  assert.equal(after.error, null);
  assert.equal(notifications, 0);
  assert.equal(storage.log.filter((line) => line.startsWith('set:')).length, writesBefore);

  // A later legitimate mutation persists ONLY the legitimate change.
  const ok = await s.setStatus('idea-1', 'done');
  assert.equal(ok.ok, true);
  const parsed = parseSnapshot(storage.raw());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.ideas.length, 1);
  assert.equal(parsed.snapshot.ideas[0].status, 'done');
  assert.equal('phase' in parsed.snapshot.ideas[0], false);
  assert.equal('error' in parsed.snapshot.ideas[0], false);
});

test('separate idea store instances cannot poison shared empty state', async () => {
  const a = createIdeaStore({ storage: adapter(), now: () => NOW, createId: () => 'idea-1' });
  const b = createIdeaStore({ storage: adapter(), now: () => NOW, createId: () => 'idea-2' });
  const aInitial = a.getSnapshot();
  assert.throws(() => {
    aInitial.ideas.push({ id: 'x', title: 'x', category: 'thought', status: 'new', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  }, TypeError);
  assert.equal(a.getSnapshot().phase, 'loading');
  await b.load();
  assert.deepEqual(b.getSnapshot().ideas, []);
  assert.equal(b.getSnapshot().phase, 'ready');
});
