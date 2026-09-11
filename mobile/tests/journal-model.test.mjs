import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_MOOD_MAX_LENGTH,
  JOURNAL_TAG_MAX_COUNT,
  JOURNAL_TAG_MAX_LENGTH,
  JOURNAL_TITLE_MAX_LENGTH,
  addEntry,
  editEntry,
  normalizeBody,
  parseTagInput,
  removeEntry,
  validateTags,
} from '../src/features/journal/journalModel.ts';
import {
  MOOD_CHOICES,
  entryMeta,
  entryPreview,
  historyOrder,
  searchEntries,
} from '../src/features/journal/journalSelectors.ts';

const NOW = new Date('2026-09-11T12:00:00.000Z');
const LATER = new Date('2026-09-11T13:00:00.000Z');
const DATE = '2026-09-11';

// Explicit per-field change flags (what the editor computes from its initial
// draft). Nothing counts as changed unless the test flags it.
function input(overrides = {}) {
  const { changed, ...values } = overrides;
  return {
    title: '',
    body: 'Текст записи',
    mood: '',
    tags: '',
    ...values,
    changed: { title: false, body: false, mood: false, tags: false, ...(changed ?? {}) },
  };
}

function entry(overrides = {}) {
  return {
    id: 'entry-1',
    date: DATE,
    body: 'Тело',
    tags: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

test('addEntry prepends a row with both timestamps on the same instant', () => {
  const existing = [entry({ id: 'entry-old', date: '2026-09-01' })];
  const result = addEntry(existing, { ...input({ title: ' Заголовок ', mood: 'Спокойно' }), id: 'entry-new', date: DATE, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].id, 'entry-new'); // prepend
  assert.equal(result.entries[0].title, 'Заголовок'); // outer trim
  assert.equal(result.entries[0].mood, 'Спокойно');
  assert.equal(result.entries[0].createdAt, NOW.toISOString());
  assert.equal(result.entries[0].updatedAt, NOW.toISOString());
  assert.equal(result.entries[0].date, DATE);
  assert.equal(result.entry.id, 'entry-new');
  assert.equal(existing.length, 1); // input untouched
});

test('addEntry omits an absent title/mood and rejects a blank text-only body', () => {
  const ok = addEntry([], { ...input({ title: '   ', mood: '' }), id: 'e1', date: DATE, now: NOW });
  assert.equal(ok.ok, true);
  assert.equal('title' in ok.entries[0], false);
  assert.equal('mood' in ok.entries[0], false);
  assert.deepEqual(ok.entries[0].tags, []);

  const blank = addEntry([], { ...input({ body: '   \n  ' }), id: 'e2', date: DATE, now: NOW });
  assert.deepEqual(blank, { ok: false, reason: 'body-blank' });
});

test('addEntry enforces visible field limits without truncating', () => {
  const longTitle = addEntry([], {
    ...input({ title: 'x'.repeat(JOURNAL_TITLE_MAX_LENGTH + 1) }),
    id: 'e1',
    date: DATE,
    now: NOW,
  });
  assert.deepEqual(longTitle, { ok: false, reason: 'title-too-long' });

  const longMood = addEntry([], {
    ...input({ mood: 'm'.repeat(JOURNAL_MOOD_MAX_LENGTH + 1) }),
    id: 'e1',
    date: DATE,
    now: NOW,
  });
  assert.deepEqual(longMood, { ok: false, reason: 'mood-too-long' });

  const manyTags = addEntry([], {
    ...input({ tags: Array.from({ length: JOURNAL_TAG_MAX_COUNT + 1 }, (_, i) => `t${i}`).join(', ') }),
    id: 'e1',
    date: DATE,
    now: NOW,
  });
  assert.deepEqual(manyTags, { ok: false, reason: 'tags-too-many' });

  const longTag = addEntry([], {
    ...input({ tags: 'y'.repeat(JOURNAL_TAG_MAX_LENGTH + 1) }),
    id: 'e1',
    date: DATE,
    now: NOW,
  });
  assert.deepEqual(longTag, { ok: false, reason: 'tag-too-long' });
});

test('tag parsing trims tokens, drops empties and keeps order/case/duplicates', () => {
  assert.deepEqual(parseTagInput(' Работа ,, дом ,Работа '), ['Работа', 'дом', 'Работа']);
  assert.deepEqual(parseTagInput(''), []);
  assert.equal(validateTags(['a']).ok, true);
  assert.equal(validateTags(Array.from({ length: 20 }, () => 't')).ok, true);
  const result = addEntry([], {
    ...input({ tags: ' Работа, дом ' }),
    id: 'e1',
    date: DATE,
    now: NOW,
  });
  assert.deepEqual(result.entries[0].tags, ['Работа', 'дом']);
});

test('body keeps every internal newline/space and is only outer-trimmed', () => {
  const raw = '\n\nПервая строка  \n\n\nВторая строка\t\u00A0\n\n';
  // Outer trim (like the web `saveEntry`) removes leading/trailing whitespace
  // including the trailing tab/NBSP; everything internal is preserved exactly.
  assert.equal(normalizeBody(raw), 'Первая строка  \n\n\nВторая строка');
  const result = addEntry([], { ...input({ body: raw }), id: 'e1', date: DATE, now: NOW });
  assert.equal(result.entries[0].body, normalizeBody(raw));
});

test('a 100k-character body survives add and edit byte-for-byte', () => {
  const body = ['Привет 🌙', 'e\u0301', '  spaced  '].join('\n\n') + '\n' + 'Ж'.repeat(100_000);
  const added = addEntry([], { ...input({ body }), id: 'e1', date: DATE, now: NOW });
  assert.equal(added.ok, true);
  assert.equal(added.entries[0].body.length > 100_000, true);
  assert.equal(added.entries[0].body, body.trim());

  const edited = editEntry(added.entries, 'e1', input({ body }), LATER);
  assert.equal(edited.ok, true);
  assert.equal(edited.entries[0].body, body.trim());
});

test('editEntry preserves id/date/createdAt/position/media and untouched tags', () => {
  const media = [
    {
      id: 'media-1',
      journalEntryId: 'legacy-media',
      type: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
      transcript: 'Голос',
      transcriptEdited: false,
      transcriptionStatus: 'ready',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  ];
  const legacyTags = ['очень длинный тег с запятой, внутри', 'x'.repeat(120)];
  // A legacy row WITHOUT the createdAt key at all (the parser only sets it when present).
  const legacyRow = entry({
    id: 'legacy-media',
    date: '2026-09-02',
    title: 'Старое',
    mood: 'Незнакомое',
    tags: legacyTags,
    media,
  });
  delete legacyRow.createdAt;
  const entries = [
    entry({ id: 'a', date: '2026-09-01' }),
    legacyRow,
    entry({ id: 'c', date: '2026-09-03' }),
  ];

  const result = editEntry(
    entries,
    'legacy-media',
    {
      title: 'Новое',
      body: 'Другое тело',
      mood: 'Незнакомое',
      tags: legacyTags.join(', '),
      changed: { title: true, body: true, mood: false, tags: false },
    },
    LATER,
  );
  assert.equal(result.ok, true);
  const next = result.entries[1];
  assert.equal(next.id, 'legacy-media'); // identity
  assert.equal(next.date, '2026-09-02'); // captured date untouched
  assert.equal('createdAt' in next, false); // absence preserved
  assert.equal(next.updatedAt, LATER.toISOString());
  assert.equal(next.title, 'Новое');
  assert.equal(next.body, 'Другое тело');
  assert.equal(next.mood, 'Незнакомое'); // unknown stored mood preserved
  assert.deepEqual(next.tags, legacyTags); // UNTOUCHED tags verbatim (no re-parse)
  assert.deepEqual(next.media, media); // metadata preserved exactly
  assert.equal(result.entries.length, 3); // position preserved
  assert.equal(result.entries[0].id, 'a');
  assert.equal(result.entries[2].id, 'c');
});

test('editEntry only re-parses tags when they were edited', () => {
  const entries = [entry({ id: 'e1', tags: ['легаси, с запятой'] })];
  const untouched = editEntry(entries, 'e1', input({ body: 'Тот же', tags: 'что-то другое' }), LATER);
  assert.deepEqual(untouched.entries[0].tags, ['легаси, с запятой']);

  const edited = editEntry(entries, 'e1', input({ body: 'Тот же', tags: 'новый, тег', changed: { tags: true } }), LATER);
  assert.deepEqual(edited.entries[0].tags, ['новый', 'тег']);
});

test('editEntry clears a title/mood when emptied and protects a text-only body', () => {
  const entries = [entry({ id: 'e1', title: 'Заголовок', mood: 'Радостно', body: 'Текст' })];
  const cleared = editEntry(
    entries,
    'e1',
    input({ body: 'Текст', title: '  ', mood: '', changed: { title: true, mood: true } }),
    LATER,
  );
  assert.equal(cleared.ok, true);
  assert.equal('title' in cleared.entries[0], false);
  assert.equal('mood' in cleared.entries[0], false);

  const blank = editEntry(entries, 'e1', input({ body: '   ', changed: { body: true } }), LATER);
  assert.deepEqual(blank, { ok: false, reason: 'body-blank' });

  // A row WITH attachments may keep an empty body (legacy/media compatibility).
  const withMedia = [
    entry({
      id: 'm1',
      body: '',
      media: [
        {
          id: 'media-1',
          journalEntryId: 'm1',
          type: 'audio',
          mimeType: 'audio/m4a',
          sizeBytes: 10,
          transcriptEdited: false,
          transcriptionStatus: 'pending',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
    }),
  ];
  const allowed = editEntry(withMedia, 'm1', input({ body: '', changed: { body: true } }), LATER);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.entries[0].body, '');
  assert.equal(allowed.entries[0].media.length, 1);
});

test('editEntry fails for a missing id and removeEntry removes exactly one row', () => {
  const entries = [entry({ id: 'e1' }), entry({ id: 'e2' })];
  assert.deepEqual(editEntry(entries, 'nope', input(), LATER), { ok: false, reason: 'missing' });
  const removed = removeEntry(entries, 'e1');
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.entries.map((item) => item.id), ['e2']);
  assert.deepEqual(removeEntry(entries, 'nope'), { ok: false, reason: 'missing' });
});

test('historyOrder sorts by date then createdAt (missing last) and stays stable', () => {
  const a = entry({ id: 'a', date: '2026-09-11', createdAt: '2026-09-11T08:00:00.000Z' });
  const b = entry({ id: 'b', date: '2026-09-11', createdAt: '2026-09-11T09:00:00.000Z' });
  const c = entry({ id: 'c', date: '2026-09-11', createdAt: undefined });
  const d = entry({ id: 'd', date: '2026-09-12', createdAt: '2026-09-12T07:00:00.000Z' });
  const e = entry({ id: 'e', date: '2026-09-11', createdAt: '2026-09-11T09:00:00.000Z' }); // tie with b
  const ordered = historyOrder([a, b, c, d, e]);
  assert.deepEqual(ordered.map((item) => item.id), ['d', 'b', 'e', 'a', 'c']);
  // Sorting never rewrites storage order.
  assert.deepEqual([a, b, c, d, e].map((item) => item.id), ['a', 'b', 'c', 'd', 'e']);
});

test('searchEntries matches title/body/mood/tags/transcripts case-insensitively', () => {
  const withTranscript = entry({
    id: 't',
    body: 'Тело',
    tags: ['Работа'],
    media: [
      {
        id: 'media-1',
        journalEntryId: 't',
        type: 'audio',
        mimeType: 'audio/m4a',
        sizeBytes: 5,
        transcript: 'Расшифровка голоса',
        transcriptEdited: false,
        transcriptionStatus: 'ready',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ],
  });
  const plain = entry({ id: 'p', body: 'Планы на день', mood: 'Спокойно' });
  const all = [withTranscript, plain];
  assert.deepEqual(searchEntries(all, '').length, 2);
  assert.deepEqual(searchEntries(all, 'тело').map((i) => i.id), ['t']);
  assert.deepEqual(searchEntries(all, 'РАБОТА').map((i) => i.id), ['t']);
  assert.deepEqual(searchEntries(all, 'голоса').map((i) => i.id), ['t']);
  assert.deepEqual(searchEntries(all, 'спокойно').map((i) => i.id), ['p']);
  assert.deepEqual(searchEntries(all, 'нет такого'), []);
});

test('row helpers produce bounded previews, meta and mood choices', () => {
  assert.equal(entryPreview('Первая строка\nВторая'), 'Первая строка Вторая');
  assert.equal(entryPreview('x'.repeat(400)).length, 161);
  assert.equal(entryPreview('   '), '');
  assert.equal(entryMeta(entry({ mood: 'Спокойно', tags: ['дом'] })), 'Спокойно · #дом');
  assert.equal(entryMeta(entry()), '');
  assert.deepEqual([...MOOD_CHOICES], ['Спокойно', 'Энергично', 'Тяжело', 'Радостно']);
});

test('a tag-only edit preserves the untouched body byte-for-byte', () => {
  const body = '  Первая строка  \n\n\nВторая строка  \t';
  const entries = [entry({ id: 'e1', body, tags: ['старый'] })];
  const result = editEntry(
    entries,
    'e1',
    input({ body, tags: 'новый, тег', changed: { tags: true } }),
    LATER,
  );
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].body, body); // no trim, no normalization
  assert.deepEqual(result.entries[0].tags, ['новый', 'тег']);
});

test('a body-only edit preserves an untouched title/mood exactly (including empty strings)', () => {
  const cases = [
    { title: '   ', mood: '' }, // present-but-empty values stay present and empty
    { title: ' Заголовок ', mood: 'Незнакомое настроение' }, // raw whitespace/legacy mood stay
  ];
  for (const stored of cases) {
    const entries = [entry({ id: 'e1', title: stored.title, mood: stored.mood, body: 'Старое' })];
    const result = editEntry(
      entries,
      'e1',
      input({ title: '', body: 'Новое тело', mood: '', changed: { body: true } }),
      LATER,
    );
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].title, stored.title);
    assert.equal('title' in result.entries[0], true);
    assert.equal(result.entries[0].mood, stored.mood);
    assert.equal(result.entries[0].body, 'Новое тело');
  }
});

test('a legacy title above the input limit does not block editing another field', () => {
  const legacyTitle = 'T'.repeat(JOURNAL_TITLE_MAX_LENGTH + 500);
  const legacyTags = ['x'.repeat(JOURNAL_TAG_MAX_LENGTH + 10)];
  const entries = [entry({ id: 'e1', title: legacyTitle, tags: legacyTags, body: 'Старое' })];
  const result = editEntry(entries, 'e1', input({ body: 'Новое тело', changed: { body: true } }), LATER);
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].title, legacyTitle); // preserved verbatim
  assert.deepEqual(result.entries[0].tags, legacyTags); // untouched legacy tags too
  assert.equal(result.entries[0].body, 'Новое тело');
  // Editing the mood only is also unaffected by the legacy title.
  const moodOnly = editEntry(
    entries,
    'e1',
    input({ body: 'Старое', mood: 'Радостно', changed: { mood: true } }),
    LATER,
  );
  assert.equal(moodOnly.ok, true);
  assert.equal(moodOnly.entries[0].title, legacyTitle);
  assert.equal(moodOnly.entries[0].mood, 'Радостно');
});

test('editing a field itself still enforces the current input limits', () => {
  const entries = [entry({ id: 'e1', title: 'Старый', body: 'Тело' })];
  assert.deepEqual(
    editEntry(
      entries,
      'e1',
      input({ title: 'x'.repeat(JOURNAL_TITLE_MAX_LENGTH + 1), body: 'Тело', changed: { title: true } }),
      LATER,
    ),
    { ok: false, reason: 'title-too-long' },
  );
  assert.deepEqual(
    editEntry(
      entries,
      'e1',
      input({ body: 'Тело', mood: 'm'.repeat(JOURNAL_MOOD_MAX_LENGTH + 1), changed: { mood: true } }),
      LATER,
    ),
    { ok: false, reason: 'mood-too-long' },
  );
  assert.deepEqual(
    editEntry(
      entries,
      'e1',
      input({ body: 'Тело', tags: 'y'.repeat(JOURNAL_TAG_MAX_LENGTH + 1), changed: { tags: true } }),
      LATER,
    ),
    { ok: false, reason: 'tag-too-long' },
  );
});

test('changed-field normalization applies only to the changed field', () => {
  const entries = [entry({ id: 'e1', title: '  Заголовок  ', body: '  Тело  ', mood: '  Спокойно  ' })];
  // Only the title changes: it is trimmed, the body and mood keep their raw form.
  const titleOnly = editEntry(
    entries,
    'e1',
    input({ title: '  Новый  ', body: '  Тело  ', mood: '  Спокойно  ', changed: { title: true } }),
    LATER,
  );
  assert.equal(titleOnly.ok, true);
  assert.equal(titleOnly.entries[0].title, 'Новый');
  assert.equal(titleOnly.entries[0].body, '  Тело  ');
  assert.equal(titleOnly.entries[0].mood, '  Спокойно  ');

  // Only the body changes: title/mood keep their stored raw whitespace.
  const bodyOnly = editEntry(
    entries,
    'e1',
    input({ title: '  Заголовок  ', body: '  Новое тело  ', mood: '  Спокойно  ', changed: { body: true } }),
    LATER,
  );
  assert.equal(bodyOnly.entries[0].title, '  Заголовок  ');
  assert.equal(bodyOnly.entries[0].body, 'Новое тело');
  assert.equal(bodyOnly.entries[0].mood, '  Спокойно  ');
});

test('addEntry rejects dates outside the 0001-9999 written contract', () => {
  assert.deepEqual(addEntry([], { ...input(), id: 'e1', date: '0000-01-01', now: NOW }), {
    ok: false,
    reason: 'date-invalid',
  });
  assert.deepEqual(addEntry([], { ...input(), id: 'e1', date: '2026-02-30', now: NOW }), {
    ok: false,
    reason: 'date-invalid',
  });
  for (const date of ['0001-01-01', '0009-09-09', '0099-12-31', '0100-01-01', '2026-09-11']) {
    const ok = addEntry([], { ...input(), id: 'e1', date, now: NOW });
    assert.equal(ok.ok, true, date);
    assert.equal(ok.entries[0].date, date);
  }
});
