import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IDEA_CATEGORY,
  DEFAULT_IDEA_STATUS,
  IDEA_CATEGORY_LABELS,
  IDEA_DESCRIPTION_MAX_LENGTH,
  IDEA_STATUS_LABELS,
  IDEA_TITLE_MAX_LENGTH,
  addIdea,
  editIdea,
  filterIdeas,
  ideaCategoryOptions,
  ideaStatusOptions,
  removeIdea,
  setIdeaStatus,
} from '../src/features/ideas/ideaModel.ts';

const NOW = new Date('2026-09-11T12:00:00.000Z');
const LATER = new Date('2026-09-11T13:00:00.000Z');

// Explicit per-field change flags (what the editor computes from its initial
// draft). Nothing counts as changed unless the test flags it.
function input(overrides = {}) {
  const { changed, ...values } = overrides;
  return {
    title: 'Идея',
    description: '',
    category: DEFAULT_IDEA_CATEGORY,
    status: DEFAULT_IDEA_STATUS,
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

function idea(overrides = {}) {
  return {
    id: 'idea-1',
    title: 'Идея',
    category: DEFAULT_IDEA_CATEGORY,
    status: DEFAULT_IDEA_STATUS,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

test('labels and ordered options keep the live product semantics', () => {
  assert.deepEqual(IDEA_CATEGORY_LABELS, {
    thought: 'Мысль',
    want: 'Хочуха',
    project: 'Проект',
    purchase: 'Покупка',
    someday: 'Когда-нибудь',
  });
  assert.deepEqual(IDEA_STATUS_LABELS, {
    new: 'Новая',
    thinking: 'Думаю',
    plan: 'В план',
    done: 'Сделано',
    archive: 'Архив',
  });
  assert.deepEqual([...ideaCategoryOptions], ['thought', 'want', 'project', 'purchase', 'someday']);
  assert.deepEqual([...ideaStatusOptions], ['new', 'thinking', 'plan', 'done', 'archive']);
  assert.equal(DEFAULT_IDEA_CATEGORY, 'thought');
  assert.equal(DEFAULT_IDEA_STATUS, 'new');
});

test('addIdea prepends with defaults, shared timestamps and trimmed fields', () => {
  const existing = [idea({ id: 'old' })];
  const result = addIdea(existing, { ...input({ title: '  Купить лампу ', description: '  Тёплый свет  ' }), id: 'idea-new', now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.ideas.length, 2);
  assert.equal(result.ideas[0].id, 'idea-new');
  assert.equal(result.ideas[0].title, 'Купить лампу');
  assert.equal(result.ideas[0].description, 'Тёплый свет');
  assert.equal(result.ideas[0].category, 'thought');
  assert.equal(result.ideas[0].status, 'new');
  assert.equal(result.ideas[0].createdAt, NOW.toISOString());
  assert.equal(result.ideas[0].updatedAt, NOW.toISOString());
  assert.equal(result.idea.id, 'idea-new');
  assert.equal(existing.length, 1);
});

test('addIdea omits a blank description and enforces the visible limits', () => {
  const blank = addIdea([], { ...input({ description: '   ' }), id: 'i1', now: NOW });
  assert.equal(blank.ok, true);
  assert.equal('description' in blank.ideas[0], false);

  assert.deepEqual(addIdea([], { ...input({ title: '   ' }), id: 'i1', now: NOW }), {
    ok: false,
    reason: 'title-blank',
  });
  assert.deepEqual(
    addIdea([], { ...input({ title: 'x'.repeat(IDEA_TITLE_MAX_LENGTH + 1) }), id: 'i1', now: NOW }),
    { ok: false, reason: 'title-too-long' },
  );
  assert.deepEqual(
    addIdea([], {
      ...input({ description: 'd'.repeat(IDEA_DESCRIPTION_MAX_LENGTH + 1) }),
      id: 'i1',
      now: NOW,
    }),
    { ok: false, reason: 'description-too-long' },
  );
});

test('addIdea rejects unknown category/status values', () => {
  assert.deepEqual(
    addIdea([], { ...input({ category: 'later' }), id: 'i1', now: NOW }),
    { ok: false, reason: 'validation' },
  );
  assert.deepEqual(
    addIdea([], { ...input({ status: 'waiting' }), id: 'i1', now: NOW }),
    { ok: false, reason: 'validation' },
  );
});

test('editIdea preserves id/createdAt/position and clears an emptied description', () => {
  const rows = [
    idea({ id: 'a' }),
    idea({ id: 'b', title: 'Вторая', description: 'Описание', category: 'project', status: 'plan', createdAt: LATER.toISOString() }),
    idea({ id: 'c' }),
  ];
  const result = editIdea(
    rows,
    'b',
    {
      title: 'Вторая (правка)',
      description: '',
      category: 'purchase',
      status: 'done',
      changed: { title: true, description: true, category: true, status: true },
    },
    LATER,
  );
  assert.equal(result.ok, true);
  const next = result.ideas[1];
  assert.equal(next.id, 'b');
  assert.equal(next.createdAt, LATER.toISOString());
  assert.equal(next.updatedAt, LATER.toISOString());
  assert.equal(next.title, 'Вторая (правка)');
  assert.equal(next.category, 'purchase');
  assert.equal(next.status, 'done');
  assert.equal('description' in next, false);
  assert.deepEqual(result.ideas.map((row) => row.id), ['a', 'b', 'c']);
});

test('setIdeaStatus changes only status/updatedAt and keeps position', () => {
  const rows = [idea({ id: 'a' }), idea({ id: 'b', title: 'Заголовок', description: 'Оп', category: 'want' })];
  const archived = setIdeaStatus(rows, 'b', 'archive', LATER);
  assert.equal(archived.ok, true);
  assert.equal(archived.ideas[1].status, 'archive');
  assert.equal(archived.ideas[1].title, 'Заголовок');
  assert.equal(archived.ideas[1].description, 'Оп');
  assert.equal(archived.ideas[1].category, 'want');
  assert.equal(archived.ideas[1].createdAt, rows[1].createdAt);
  assert.equal(archived.ideas[1].updatedAt, LATER.toISOString());
  assert.equal(archived.ideas[0], rows[0]);
  assert.deepEqual(setIdeaStatus(rows, 'nope', 'done', LATER), { ok: false, reason: 'missing' });
  assert.deepEqual(setIdeaStatus(rows, 'a', 'later', LATER), { ok: false, reason: 'validation' });
});

test('removeIdea and filterIdeas follow the AND/All semantics', () => {
  const rows = [
    idea({ id: 'a', category: 'thought', status: 'new' }),
    idea({ id: 'b', category: 'project', status: 'plan' }),
    idea({ id: 'c', category: 'project', status: 'archive' }),
  ];
  assert.deepEqual(removeIdea(rows, 'b').ideas.map((row) => row.id), ['a', 'c']);
  assert.deepEqual(removeIdea(rows, 'nope'), { ok: false, reason: 'missing' });

  assert.deepEqual(filterIdeas(rows, { category: 'all', status: 'all' }).map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(filterIdeas(rows, { category: 'project', status: 'all' }).map((r) => r.id), ['b', 'c']);
  assert.deepEqual(filterIdeas(rows, { category: 'all', status: 'archive' }).map((r) => r.id), ['c']);
  assert.deepEqual(filterIdeas(rows, { category: 'project', status: 'plan' }).map((r) => r.id), ['b']);
  assert.deepEqual(filterIdeas(rows, { category: 'thought', status: 'plan' }), []);
  // Archive stays stored and reachable; plan does not change any other field.
  assert.equal(rows[2].status, 'archive');
});

test('a category/status edit preserves a long legacy description exactly', () => {
  const legacyDescription = 'D'.repeat(IDEA_DESCRIPTION_MAX_LENGTH + 500) + '  \n  конец  ';
  const rows = [idea({ id: 'b', title: 'Легаси', description: legacyDescription, category: 'want', status: 'new' })];
  const result = editIdea(
    rows,
    'b',
    input({
      title: 'Легаси',
      description: legacyDescription,
      category: 'project',
      status: 'thinking',
      changed: { category: true, status: true },
    }),
    LATER,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ideas[0].description, legacyDescription); // byte-for-byte
  assert.equal(result.ideas[0].category, 'project');
  assert.equal(result.ideas[0].status, 'thinking');

  // Quick status change (production inline control) preserves it too.
  const quick = setIdeaStatus(rows, 'b', 'archive', LATER);
  assert.equal(quick.ok, true);
  assert.equal(quick.ideas[0].description, legacyDescription);
});

test('an over-limit legacy title/description does not block other idea edits', () => {
  const legacyTitle = 'T'.repeat(IDEA_TITLE_MAX_LENGTH + 50);
  const legacyDescription = 'D'.repeat(IDEA_DESCRIPTION_MAX_LENGTH + 50);
  const rows = [idea({ id: 'b', title: legacyTitle, description: legacyDescription, category: 'want', status: 'new' })];
  const result = editIdea(
    rows,
    'b',
    input({
      title: legacyTitle,
      description: legacyDescription,
      category: 'someday',
      status: 'new',
      changed: { category: true },
    }),
    LATER,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ideas[0].title, legacyTitle);
  assert.equal(result.ideas[0].description, legacyDescription);
  assert.equal(result.ideas[0].category, 'someday');
});

test('editing the description itself still enforces the current limit', () => {
  const rows = [idea({ id: 'b', description: 'Старое' })];
  const tooLong = editIdea(
    rows,
    'b',
    input({ description: 'D'.repeat(IDEA_DESCRIPTION_MAX_LENGTH + 1), changed: { description: true } }),
    LATER,
  );
  assert.deepEqual(tooLong, { ok: false, reason: 'description-too-long' });

  const tooLongTitle = editIdea(
    rows,
    'b',
    input({ title: 'T'.repeat(IDEA_TITLE_MAX_LENGTH + 1), changed: { title: true } }),
    LATER,
  );
  assert.deepEqual(tooLongTitle, { ok: false, reason: 'title-too-long' });

  const blankTitle = editIdea(rows, 'b', input({ title: '   ', changed: { title: true } }), LATER);
  assert.deepEqual(blankTitle, { ok: false, reason: 'title-blank' });
});

test('untouched present-but-empty description survives an unrelated edit', () => {
  const rows = [idea({ id: 'b', description: '' })];
  const result = editIdea(
    rows,
    'b',
    input({ title: 'Идея', description: '', category: 'want', status: 'new', changed: { category: true } }),
    LATER,
  );
  assert.equal(result.ok, true);
  assert.equal('description' in result.ideas[0], true);
  assert.equal(result.ideas[0].description, '');
});
