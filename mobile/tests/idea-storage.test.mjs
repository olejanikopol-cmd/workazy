import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDEAS_STORAGE_KEY,
  IDEA_CATEGORIES,
  IDEA_STATUSES,
  cloneIdeas,
  isIdeaCategory,
  isIdeaStatus,
  parseSnapshot,
  serializeSnapshot,
} from '../src/storage/ideaStorage.ts';

const SAVED_AT = '2026-09-11T12:00:00.000Z';

function idea(overrides = {}) {
  return {
    id: 'idea-1',
    title: 'Идея',
    category: 'thought',
    status: 'new',
    createdAt: SAVED_AT,
    updatedAt: SAVED_AT,
    ...overrides,
  };
}

function envelope(ideas, savedAt = SAVED_AT) {
  return JSON.stringify({ version: 1, ideas, savedAt });
}

test('every category/status survives a serialize/parse round-trip', () => {
  const ideas = [];
  for (const category of IDEA_CATEGORIES) {
    for (const status of IDEA_STATUSES) {
      ideas.push(
        idea({
          id: `idea-${category}-${status}`,
          title: `${category}/${status}`,
          category,
          status,
          ...(category === 'want' ? { description: 'Хочу это' } : {}),
        }),
      );
    }
  }
  const parsed = parseSnapshot(serializeSnapshot(ideas, SAVED_AT));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.snapshot.ideas, ideas);
  assert.deepEqual(parsed.snapshot.ideas.map((row) => row.status), ideas.map((row) => row.status));
  // Optional description absence is preserved.
  assert.equal('description' in parsed.snapshot.ideas[0], false);
  assert.equal(parsed.snapshot.ideas.find((row) => row.category === 'want').description, 'Хочу это');
});

test('cloneIdeas copies rows so snapshots never alias each other', () => {
  const source = [idea()];
  const copy = cloneIdeas(source);
  copy[0].title = 'изменено';
  assert.equal(source[0].title, 'Идея');
});

test('legacy long title/description load unchanged (input limits are input rules)', () => {
  const parsed = parseSnapshot(
    envelope([idea({ title: 'T'.repeat(5000), description: 'D'.repeat(9000) })]),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.ideas[0].title.length, 5000);
  assert.equal(parsed.snapshot.ideas[0].description.length, 9000);
});

test('structural violations reject the WHOLE snapshot', () => {
  const bad = [
    ['nope', 'invalid-json'],
    [JSON.stringify([]), 'not-object'],
    [JSON.stringify({ version: 2, ideas: [], savedAt: SAVED_AT }), 'unknown-version'],
    [JSON.stringify({ version: 1, ideas: {}, savedAt: SAVED_AT }), 'ideas-not-array'],
    [JSON.stringify({ version: 1, ideas: [], savedAt: '2026-02-30T00:00:00.000Z' }), 'bad-saved-at'],
    [envelope([idea({ id: '' })]), 'bad-idea-id'],
    [envelope([idea(), idea()]), 'duplicate-idea-id'],
    [envelope([idea({ title: '   ' })]), 'bad-idea-title'],
    [envelope([idea({ title: 7 })]), 'bad-idea-title'],
    [envelope([idea({ description: 7 })]), 'bad-idea-description'],
    [envelope([idea({ category: 'later' })]), 'bad-idea-category'],
    [envelope([idea({ status: 'waiting' })]), 'bad-idea-status'],
    [JSON.stringify({ version: 1, ideas: [{ ...idea(), createdAt: undefined }], savedAt: SAVED_AT }), 'bad-idea-created-at'],
    [JSON.stringify({ version: 1, ideas: [{ ...idea(), updatedAt: undefined }], savedAt: SAVED_AT }), 'bad-idea-updated-at'],
    [envelope([idea({ createdAt: '2026-09-11' })]), 'bad-idea-created-at'],
    [envelope([idea({ updatedAt: '2026-09-11T12:00:00Z' })]), 'bad-idea-updated-at'],
  ];
  for (const [raw, expected] of bad) {
    const parsed = parseSnapshot(raw);
    assert.equal(parsed.ok, false, `${expected} should fail`);
    if (!parsed.ok) assert.equal(parsed.error, expected);
  }
});

test('enum guards and canonical timestamps follow the shared contract', () => {
  assert.equal(isIdeaCategory('someday'), true);
  assert.equal(isIdeaCategory('all'), false);
  assert.equal(isIdeaStatus('archive'), true);
  assert.equal(isIdeaStatus('new'), true);
  assert.equal(isIdeaStatus('donee'), false);
  // Kyiv DST-gap UTC instant is a real moment and stays accepted.
  assert.equal(parseSnapshot(envelope([idea({ createdAt: '2026-03-29T03:30:00.000Z', updatedAt: '2026-03-29T03:30:00.000Z' })])).ok, true);
  // Year 0000 dates are not applicable here, but an impossible date is rejected.
  assert.equal(parseSnapshot(envelope([idea({ createdAt: '2026-02-30T00:00:00.000Z' })])).ok, false);
  assert.equal(IDEAS_STORAGE_KEY, 'workazy-native-ideas-v1');
});
