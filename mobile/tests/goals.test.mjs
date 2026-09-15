import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalLocalDate, goalPeriodKey, goalDefaultDeadline, isGoalPeriodKey } from '../src/features/goals/goalDates.ts';
import { createGoal, editGoal, setGoalCompleted, removeGoal, goalsForPeriod } from '../src/features/goals/goalModel.ts';
import { createGoalStore } from '../src/features/goals/goalStore.ts';
import { GOALS_STORAGE_KEY, parseGoalSnapshot, serializeGoalSnapshot } from '../src/storage/goalStorage.ts';
import { planSegments } from '../src/features/plans/plansProduct.ts';
const NOW = new Date(0);
NOW.setHours(12, 0, 0, 0);
NOW.setFullYear(2026, 8, 14);
const ISO = new Date('2026-09-14T10:00:00.000Z');
const draft = (period = 'week', patch = {}) => ({ title: 'Важная цель', description: 'Подробное описание', period, deadline: goalDefaultDeadline(period, NOW), progress: 0, ...patch });
function memory(raw = null) { const values = new Map(raw === null ? [] : [[GOALS_STORAGE_KEY, raw]]); return { values, writes: 0, fail: false, gate: null, async getItem(k) { return values.get(k) ?? null; }, async setItem(k, v) { this.writes++; if (this.fail)
        throw Error('disk'); if (this.gate)
        await this.gate; values.set(k, v); } }; }
function harness({ storage = memory(), ids = ['g1', 'g2'], now = ISO } = {}) { let i = 0; return { storage, store: createGoalStore({ storage, now: () => now, createId: () => ids[i++] ?? `g${i}` }) }; }
async function ready(options) { const h = harness(options); await h.store.load(); return h; }
test('native Plans product is exactly Plan + Goals', () => assert.deepEqual(planSegments, [{ value: 'plan', label: 'План' }, { value: 'goals', label: 'Цели' }]));
test('empty first start writes no data and seeds no goals', async () => { const h = await ready(); assert.equal(h.store.getSnapshot().phase, 'ready'); assert.deepEqual(h.store.getSnapshot().goals, []); assert.equal(h.storage.writes, 0); });
for (const [period, key, deadline] of [['week', '2026-09-14', '2026-09-20'], ['month', '2026-09', '2026-09-30'], ['year', '2026', '2026-12-31']])
    test(`create ${period} goal with stable local identity`, async () => { const h = await ready(); const result = await h.store.add({ ...draft(period), expectedRevision: 0 }); assert.equal(result.ok, true); const goal = h.store.getSnapshot().goals[0]; assert.equal(goal.periodKey, key); assert.equal(goal.deadline, deadline); assert.equal(goal.completed, false); assert.equal(goal.progress, 0); assert.equal(Object.isFrozen(goal), true); });
test('restart restores exact committed goals and revision', async () => { const storage = memory(); const a = await ready({ storage }); await a.store.add({ ...draft('month'), expectedRevision: 0 }); const before = JSON.stringify(a.store.getSnapshot().goals); const b = await ready({ storage }); assert.equal(JSON.stringify(b.store.getSnapshot().goals), before); assert.equal(b.store.getSnapshot().revision, 1); });
test('edit title and same period preserves period identity', async () => { const h = await ready(); await h.store.add({ ...draft(), expectedRevision: 0 }); const before = h.store.getSnapshot().goals[0]; const result = await h.store.edit(before.id, { ...draft('week', { title: 'Новое длинное название', progress: 40 }), expectedRevision: 1 }); assert.equal(result.ok, true); const after = h.store.getSnapshot().goals[0]; assert.equal(after.title, 'Новое длинное название'); assert.equal(after.periodKey, before.periodKey); assert.equal(after.createdAt, before.createdAt); assert.equal(after.progress, 40); });
test('changing period assigns current identity without corrupting progress', async () => { const h = await ready(); await h.store.add({ ...draft('week', { progress: 30 }), expectedRevision: 0 }); const id = h.store.getSnapshot().goals[0].id; await h.store.edit(id, { ...draft('year', { progress: 30 }), expectedRevision: 1 }); const goal = h.store.getSnapshot().goals[0]; assert.equal(goal.period, 'year'); assert.equal(goal.periodKey, '2026'); assert.equal(goal.progress, 30); });
test('explicit safe integer progress and complete/reopen semantics', async () => { const h = await ready(); await h.store.add({ ...draft(), expectedRevision: 0 }); const id = h.store.getSnapshot().goals[0].id; for (const value of [-1, 101, 1.5, Number.NaN])
    assert.equal((await h.store.setProgress(id, value, 1)).reason, 'progress'); assert.equal((await h.store.setProgress(id, 70, 1)).ok, true); assert.equal(h.store.getSnapshot().goals[0].completed, false); assert.equal((await h.store.setCompleted(id, true, 2)).ok, true); assert.deepEqual([h.store.getSnapshot().goals[0].progress, h.store.getSnapshot().goals[0].completed], [100, true]); assert.equal((await h.store.setCompleted(id, false, 3)).ok, true); assert.deepEqual([h.store.getSnapshot().goals[0].progress, h.store.getSnapshot().goals[0].completed], [0, false]); assert.equal((await h.store.setProgress(id, 100, 4)).ok, true); assert.equal(h.store.getSnapshot().goals[0].completed, true); });
test('delete persists and restart stays deleted', async () => { const storage = memory(); const h = await ready({ storage }); await h.store.add({ ...draft(), expectedRevision: 0 }); const id = h.store.getSnapshot().goals[0].id; assert.equal((await h.store.remove(id, 1)).ok, true); assert.deepEqual(h.store.getSnapshot().goals, []); const restarted = await ready({ storage }); assert.deepEqual(restarted.store.getSnapshot().goals, []); });
test('stale edit and delete cannot touch newer entity', async () => { const h = await ready(); await h.store.add({ ...draft(), expectedRevision: 0 }); const id = h.store.getSnapshot().goals[0].id; await h.store.edit(id, { ...draft('week', { title: 'Latest' }), expectedRevision: 1 }); const before = h.store.getSnapshot(); assert.equal((await h.store.edit(id, { ...draft('week', { title: 'Stale' }), expectedRevision: 1 })).reason, 'stale'); assert.equal((await h.store.remove(id, 1)).reason, 'stale'); assert.equal(h.store.getSnapshot(), before); });
test('storage failure preserves committed state and leaves retry possible', async () => { const h = await ready(); await h.store.add({ ...draft(), expectedRevision: 0 }); const before = h.store.getSnapshot().goals; h.storage.fail = true; const result = await h.store.edit('g1', { ...draft('week', { title: 'Unsaved' }), expectedRevision: 1 }); assert.equal(result.reason, 'storage'); assert.equal(h.store.getSnapshot().goals, before); assert.equal(h.store.getSnapshot().revision, 1); assert.ok(h.store.getSnapshot().error); h.storage.fail = false; assert.equal((await h.store.edit('g1', { ...draft('week', { title: 'Saved' }), expectedRevision: 1 })).ok, true); });
test('concurrent save returns busy and never publishes pending bytes', async () => { let release; const gate = new Promise(r => { release = r; }); const storage = memory(); storage.gate = gate; const h = await ready({ storage }); const first = h.store.add({ ...draft(), expectedRevision: 0 }); assert.equal(h.store.getSnapshot().goals.length, 0); assert.equal((await h.store.add({ ...draft('month'), expectedRevision: 0 })).reason, 'busy'); release(); await first; assert.equal(h.store.getSnapshot().goals.length, 1); });
for (const raw of ['broken', '{}', '{"version":2,"revision":0,"goals":[],"savedAt":"2026-09-14T10:00:00.000Z"}'])
    test('corrupt goal bytes block as load-error and remain unchanged', async () => { const storage = memory(raw); const h = await ready({ storage }); assert.equal(h.store.getSnapshot().phase, 'load-error'); assert.deepEqual(h.store.getSnapshot().goals, []); assert.equal(storage.values.get(GOALS_STORAGE_KEY), raw); assert.equal((await h.store.add({ ...draft(), expectedRevision: 0 })).reason, 'not-ready'); assert.equal(storage.writes, 0); });
test('strict parser rejects unknown keys, duplicate IDs, inconsistent completion and invalid period identity', () => { const created = createGoal([], { ...draft(), id: 'g', now: ISO }); assert.equal(created.ok, true); const raw = serializeGoalSnapshot(created.goals, 1, ISO.toISOString()); assert.equal(parseGoalSnapshot(raw).ok, true); for (const mutate of [x => x.extra = 1, x => x.goals[0].extra = 1, x => x.goals.push({ ...x.goals[0] }), x => x.goals[0].id = ' ', x => x.goals[0].completed = true, x => x.goals[0].periodKey = '2026-09-15', x => x.revision = -1]) {
    const value = JSON.parse(raw);
    mutate(value);
    assert.equal(parseGoalSnapshot(JSON.stringify(value)).ok, false);
} });
test('current period and completed filters do not move stored previous goals', () => { const current = createGoal([], { ...draft('week'), id: 'a', now: ISO }); const previous = createGoal(current.goals, { ...draft('week'), id: 'b', now: new Date('2026-09-07T10:00:00Z') }); const done = setGoalCompleted(previous.goals, 'a', true, ISO); assert.equal(goalsForPeriod(done.goals, 'week', '2026-09-14', false).length, 0); assert.deepEqual(goalsForPeriod(done.goals, 'week', '2026-09-14', true).map(g => g.id), ['a']); assert.equal(done.goals.find(g => g.id === 'b').periodKey, '2026-09-07'); });
test('week/month/year boundaries use local calendar and avoid year 0–99 remapping', () => { const jan = new Date(0); jan.setHours(12, 0, 0, 0); jan.setFullYear(2021, 0, 1); assert.equal(goalPeriodKey('week', jan), '2020-12-28'); assert.equal(goalPeriodKey('month', jan), '2021-01'); const nine = new Date(0); nine.setHours(12, 0, 0, 0); nine.setFullYear(9, 0, 1); assert.equal(goalLocalDate(nine), '0009-01-01'); assert.equal(goalPeriodKey('year', nine), '0009'); assert.equal(isGoalPeriodKey('year', '0009'), true); assert.equal(goalDefaultDeadline('year', nine), '0009-12-31'); });
test('invalid date and malformed direct model input are rejected deliberately', () => { assert.equal(goalPeriodKey('week', new Date(Number.NaN)), null); assert.equal(createGoal([], { ...draft(), id: 'x', now: ISO, progress: 101 }).reason, 'progress'); assert.equal(editGoal([], 'missing', { ...draft(), now: ISO }).reason, 'missing'); assert.equal(removeGoal([], 'missing').reason, 'missing'); });
test('published state, array and rows are immutable', async () => {
    const h = await ready();
    await h.store.add({ ...draft(), expectedRevision: 0 });
    const state = h.store.getSnapshot();
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.goals), true);
    assert.equal(Object.isFrozen(state.goals[0]), true);
});
test('invalid generated IDs and a failing commit clock never write or publish', async () => {
    const blankStorage = memory();
    const blank = createGoalStore({ storage: blankStorage, now: () => ISO, createId: () => ' ' });
    await blank.load();
    assert.equal((await blank.add({ ...draft(), expectedRevision: 0 })).reason, 'duplicate-id');
    assert.equal(blankStorage.writes, 0);
    let clockRead = 0;
    const clockStorage = memory();
    const clock = createGoalStore({
        storage: clockStorage,
        now: () => clockRead++ === 0 ? ISO : new Date(Number.NaN),
        createId: () => 'g1',
    });
    await clock.load();
    assert.equal((await clock.add({ ...draft(), expectedRevision: 0 })).reason, 'invalid-snapshot');
    assert.equal(clockStorage.writes, 0);
    assert.deepEqual(clock.getSnapshot().goals, []);
    assert.equal(clock.getSnapshot().saving, false);
});
