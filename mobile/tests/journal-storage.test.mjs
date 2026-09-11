import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_STORAGE_KEY,
  cloneEntries,
  parseSnapshot,
  serializeSnapshot,
} from '../src/storage/journalStorage.ts';

const SAVED_AT = '2026-09-11T12:00:00.000Z';

function media(overrides = {}) {
  return {
    id: 'media-1',
    journalEntryId: 'entry-1',
    type: 'audio',
    mimeType: 'audio/m4a',
    sizeBytes: 1024,
    transcriptEdited: false,
    transcriptionStatus: 'ready',
    createdAt: SAVED_AT,
    updatedAt: SAVED_AT,
    ...overrides,
  };
}

function entry(overrides = {}) {
  return { id: 'entry-1', date: '2026-09-11', body: 'Тело', tags: [], ...overrides };
}

function envelope(entries, savedAt = SAVED_AT) {
  return JSON.stringify({ version: 1, entries, savedAt });
}

test('the journal envelope uses its own native key', () => {
  assert.equal(JOURNAL_STORAGE_KEY, 'workazy-native-journal-v1');
});

test('round-trip keeps optional fields absent vs present exactly', () => {
  const entries = [
    entry({ id: 'entry-1', title: 'Заголовок', mood: 'Спокойно', tags: ['дом', 'Дом'], createdAt: SAVED_AT, updatedAt: SAVED_AT }),
    entry({ id: 'entry-2', body: '', tags: [] }), // no title/mood/createdAt/media
    entry({ id: 'entry-3', body: 'С вложением', tags: [], media: [], createdAt: SAVED_AT }),
    entry({ id: 'entry-4', body: 'Полные метаданные', tags: [], media: [media({ journalEntryId: 'entry-4', originalFilename: 'a.m4a', durationMs: 1500, transcript: 'Привет', transcriptionError: 'нет', transcriptionProvider: 'groq' })], createdAt: SAVED_AT, updatedAt: SAVED_AT }),
  ];
  const parsed = parseSnapshot(serializeSnapshot(entries, SAVED_AT));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.savedAt, SAVED_AT);
  assert.deepEqual(parsed.snapshot.entries, entries);
  // Optional absence is preserved (no fabricated keys).
  assert.equal('title' in parsed.snapshot.entries[1], false);
  assert.equal('mood' in parsed.snapshot.entries[1], false);
  assert.equal('createdAt' in parsed.snapshot.entries[1], false);
  assert.equal('media' in parsed.snapshot.entries[1], false);
  assert.equal(parsed.snapshot.entries[2].media.length, 0); // present-but-empty stays
});

test('cloneEntries deep-copies tags and media so committed state cannot be mutated', () => {
  const source = [entry({ tags: ['a'], media: [media({ transcript: 't' })] })];
  const copy = cloneEntries(source);
  copy[0].tags.push('b');
  copy[0].media[0].transcript = 'изменено';
  copy[0].body = 'изменено';
  assert.deepEqual(source[0].tags, ['a']);
  assert.equal(source[0].media[0].transcript, 't');
  assert.equal(source[0].body, 'Тело');
});

test('legacy tolerance: long text/tags, unknown mood, empty body and data-URL-like prose load unchanged', () => {
  const legacyTags = Array.from({ length: 40 }, (_, i) => `tag-${i}`);
  const raw = envelope([
    entry({
      id: 'legacy-1',
      title: 'T'.repeat(500), // longer than the input limit: still loads
      body: 'B'.repeat(200_000), // far beyond the 5,000 transport cap
      mood: 'Неведомое настроение',
      tags: legacyTags,
    }),
    entry({
      id: 'legacy-2',
      body: 'Строка похожа на данные: data:text/plain;base64,SGVsbG8gV29ybGQ=',
      tags: [],
      media: [media({ journalEntryId: 'legacy-2', transcript: 'data:audio/m4a;base64,QUJDRA==' })],
      createdAt: SAVED_AT,
      updatedAt: SAVED_AT,
    }),
  ]);
  const parsed = parseSnapshot(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.entries[0].tags.length, 40);
  assert.equal(parsed.snapshot.entries[0].mood, 'Неведомое настроение');
  assert.equal(
    parsed.snapshot.entries[1].media[0].transcript,
    'data:audio/m4a;base64,QUJDRA==',
  );
  assert.equal(parsed.snapshot.entries[1].body.includes('data:text/plain'), true);
});

test('structural violations reject the WHOLE snapshot', () => {
  const bad = [
    ['not json', 'invalid-json'],
    [JSON.stringify({ version: 2, entries: [], savedAt: SAVED_AT }), 'unknown-version'],
    [JSON.stringify({ version: 1, entries: {}, savedAt: SAVED_AT }), 'entries-not-array'],
    [JSON.stringify({ version: 1, entries: [], savedAt: 'вчера' }), 'bad-saved-at'],
    [envelope([entry({ id: '' })]), 'bad-entry-id'],
    [envelope([entry(), entry()]), 'duplicate-entry-id'],
    [envelope([entry({ date: '2026-02-30' })]), 'bad-entry-date'],
    [envelope([entry({ date: '0000-01-01' })]), 'bad-entry-date'], // year contract
    [envelope([entry({ body: 5 })]), 'bad-entry-body'],
    [envelope([entry({ title: 5 })]), 'bad-entry-title'],
    [envelope([entry({ mood: 5 })]), 'bad-entry-mood'],
    [envelope([entry({ tags: 'a,b' })]), 'bad-entry-tags'],
    [envelope([entry({ tags: [1] })]), 'bad-entry-tags'],
    [envelope([entry({ createdAt: '2026-09-11' })]), 'bad-entry-created-at'],
    [envelope([entry({ updatedAt: '2026-13-01T00:00:00.000Z' })]), 'bad-entry-updated-at'],
    [envelope([entry({ media: {} })]), 'media-not-array'],
    [envelope([entry({ media: [media({ journalEntryId: 'other' })] })]), 'media-entry-mismatch'],
    [envelope([entry({ media: [media({ id: '' })] })]), 'bad-media-id'],
    [envelope([entry({ media: [media()] }), entry({ id: 'entry-2', body: '', media: [media()] })]), 'duplicate-media-id'],
    [envelope([entry({ media: [media({ type: 'image' })] })]), 'bad-media-type'],
    [envelope([entry({ media: [media({ mimeType: '' })] })]), 'bad-media-mime'],
    [envelope([entry({ media: [media({ sizeBytes: -1 })] })]), 'bad-media-size'],
    [envelope([entry({ media: [media({ sizeBytes: Number.NaN })] })]), 'bad-media-size'],
    [envelope([entry({ media: [media({ durationMs: 0 })] })]), 'bad-media-durationMs'],
    [envelope([entry({ media: [media({ width: -5 })] })]), 'bad-media-width'],
    [envelope([entry({ media: [media({ transcriptEdited: 'да' })] })]), 'bad-media-transcript-edited'],
    [envelope([entry({ media: [media({ transcriptionStatus: 'done' })] })]), 'bad-media-transcription-status'],
    [envelope([entry({ media: [media({ createdAt: '2026-02-30T00:00:00.000Z' })] })]), 'bad-media-created-at'],
    [envelope([entry({ media: [media({ updatedAt: 'вчера' })] })]), 'bad-media-updated-at'],
  ];
  for (const [raw, expected] of bad) {
    const parsed = parseSnapshot(raw);
    assert.equal(parsed.ok, false, `${expected} should fail`);
    if (!parsed.ok) assert.equal(parsed.error, expected);
  }
});

test('byte-bearing attachment properties are rejected (explicit metadata schema)', () => {
  const bytes = ['blob', 'file', 'buffer', 'arrayBuffer', 'bytes', 'base64', 'dataUrl', 'uri', 'previewUrl'];
  for (const key of bytes) {
    const raw = envelope([
      entry({ media: [media({ [key]: 'content' })] }),
    ]);
    const parsed = parseSnapshot(raw);
    assert.equal(parsed.ok, false, `${key} must be rejected`);
    if (!parsed.ok) assert.equal(parsed.error, `media-unknown-key:${key}`);
  }
});

test('canonical UTC timestamps accept a Kyiv DST-gap instant and reject impossible dates', () => {
  // 03:30 local does not exist in Europe/Kyiv on 2026-03-29, but the UTC instant is real.
  const gap = envelope([entry({ createdAt: '2026-03-29T03:30:00.000Z', updatedAt: '2026-03-29T03:30:00.000Z' })]);
  assert.equal(parseSnapshot(gap).ok, true);
  // Impossible calendar dates and non-canonical shapes are rejected.
  for (const value of ['2026-02-30T00:00:00.000Z', '2026-09-11T12:00:00Z', '2026-09-11T12:00:00.000+02:00']) {
    const parsed = parseSnapshot(envelope([entry({ createdAt: value })]));
    assert.equal(parsed.ok, false, `${value} must be rejected`);
  }
});
