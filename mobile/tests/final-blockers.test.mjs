import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { createGoalStore } from '../src/features/goals/goalStore.ts';
import { goalDefaultDeadline } from '../src/features/goals/goalDates.ts';
import { createPlanStore } from '../src/features/plans/planStore.ts';
import * as dates from '../src/features/plans/planDates.ts';
import * as model from '../src/features/plans/planModel.ts';
import { isoToLocalDate, localDateToIso } from '../src/features/calendar/calendarDates.ts';

// Execute the actual TSX and hooks; replace only React/native rendering and IO.
function hooks() {
  let cursor = 0;
  const cells = [];
  const effects = [];
  const cleanups = [];
  return {
    react: {
      useState(initial) {
        const i = cursor++;
        if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
        return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; }];
      },
      useRef(initial) {
        const i = cursor++;
        return cells[i] ?? (cells[i] = { current: initial });
      },
      useCallback: (fn) => fn,
      useEffect(fn) {
        const i = cursor++;
        if (!(i in cells)) { cells[i] = true; effects.push(fn); }
      },
    },
    render(fn) {
      cursor = 0;
      const result = fn();
      while (effects.length) cleanups.push(effects.shift()());
      return result;
    },
    unmount() { cleanups.forEach((fn) => fn?.()); },
  };
}
const theme = { colors: {}, radius: {}, spacing: {}, touchTarget: 44 };
const native = {
  StyleSheet: { create: (x) => x, hairlineWidth: 1 }, Platform: { OS: 'ios' },
  ...Object.fromEntries(['View', 'TextInput', 'Pressable', 'Modal', 'ScrollView', 'KeyboardAvoidingView', 'FlatList', 'ActivityIndicator'].map((name) => [name, name])),
};
function load(path, imports, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, ...globals,
    require(name) {
      if (name === 'react/jsx-runtime') return jsx;
      assert.ok(name in imports, `Missing test boundary ${name}`);
      const value = imports[name];
      return 'default' in value ? { ...value, __esModule: true } : value;
    },
  });
  return exports;
}
function find(node, predicate) {
  if (!node) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, predicate); if (found) return found; }
  } else if (node.props) {
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }
}
const labelled = (tree, label) => {
  const result = find(tree, (node) => node.props.accessibilityLabel === label || node.props.label === label);
  assert.ok(result, label);
  return result;
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function memory() {
  const values = new Map();
  return {
    values, writes: 0, gate: null, fail: false,
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) {
      this.writes++;
      if (this.gate) await this.gate.promise;
      if (this.fail) throw Error('disk');
      values.set(key, value);
    },
  };
}
const now = () => isoToLocalDate('2026-09-15');
async function goalHarness({ existing = false } = {}) {
  const storage = memory();
  let sequence = 0;
  const store = createGoalStore({ storage, now, createId: () => `g${++sequence}` });
  await store.load();
  if (existing) await store.add({ title: 'Existing', period: 'week', deadline: '2026-09-20', progress: 0, expectedRevision: 0 });
  const h = hooks();
  const events = { closed: [], current: 'A', intents: 0, alert: null };
  const Sheet = load('../src/features/goals/GoalSheet.tsx', {
    react: h.react, 'react-native': { ...native, Alert: { alert: (_t, _b, actions) => { events.alert = actions; } } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@/components/AppText': { default: 'Text' }, '@/components/SegmentedControl': { default: 'Segments' },
    '@/theme': theme, './goalDates': { goalDefaultDeadline },
  }).default;
  const props = {
    sheetKey: 'A', mode: existing ? 'read' : 'add', goalId: existing ? 'g1' : undefined,
    expectedRevision: store.getSnapshot().revision, period: 'week', today: '2026-09-15',
    isCurrent: () => events.current === 'A', onClose: () => events.closed.push('A'),
    onComplete: (key) => events.closed.push(key),
    onAdd: (input, expectedRevision) => { events.intents++; return store.add({ ...input, expectedRevision }); },
    onEdit: (id, input, expectedRevision) => { events.intents++; return store.edit(id, { ...input, expectedRevision }); },
    onDelete: (id, expectedRevision) => store.remove(id, expectedRevision),
  };
  const render = () => h.render(() => Sheet({ ...props, goals: store.getSnapshot().goals,
    saving: store.getSnapshot().saving, storeError: store.getSnapshot().error }));
  if (existing) {
    find(render(), (n) => n.type === 'Pressable' && n.props.children?.props?.children === 'Изменить').props.onPress();
  }
  return { storage, store, h, events, render };
}

test('Goal production sheet preserves queued newer draft and next Save edits the newly created row', async () => {
  const h = await goalHarness();
  labelled(h.render(), 'Название цели').props.onChangeText('Before save');
  const tree = h.render();
  h.storage.gate = deferred();
  labelled(tree, 'Сохранить цель').props.onPress();
  labelled(tree, 'Название цели').props.onChangeText('Queued newer draft');
  assert.equal(labelled(h.render(), 'Название цели').props.value, 'Queued newer draft');
  h.storage.gate.resolve(); await flush();
  assert.equal(h.store.getSnapshot().goals[0].title, 'Before save');
  assert.deepEqual(h.events.closed, []);
  const retained = h.render();
  assert.equal(labelled(retained, 'Название цели').props.value, 'Queued newer draft');
  assert.equal(labelled(retained, 'Название цели').props.editable, true);
  labelled(retained, 'Сохранить цель').props.onPress(); await flush();
  assert.equal(h.store.getSnapshot().goals.length, 1);
  assert.equal(h.store.getSnapshot().goals[0].title, 'Queued newer draft');
  assert.equal(h.store.getSnapshot().revision, 2);
  assert.deepEqual(h.events.closed, ['A']);
});
test('Goal rapid double Save acquires the synchronous guard before rendering', async () => {
  const h = await goalHarness();
  labelled(h.render(), 'Название цели').props.onChangeText('Once');
  const save = labelled(h.render(), 'Сохранить цель').props.onPress;
  h.storage.gate = deferred(); save(); save();
  assert.equal(h.events.intents, 1);
  assert.equal(h.storage.writes, 1);
  h.storage.gate.resolve(); await flush();
});
test('Goal completion from unmounted A never closes replacement sheet B', async () => {
  const h = await goalHarness();
  labelled(h.render(), 'Название цели').props.onChangeText('A');
  h.storage.gate = deferred();
  labelled(h.render(), 'Сохранить цель').props.onPress();
  h.events.current = 'B'; h.h.unmount();
  h.storage.gate.resolve(); await flush();
  assert.deepEqual(h.events.closed, []);
  assert.equal(h.store.getSnapshot().goals[0].title, 'A');
});
test('Goal failed Save keeps exact draft, unlocks and retries', async () => {
  const h = await goalHarness();
  labelled(h.render(), 'Название цели').props.onChangeText('  My draft\n');
  h.storage.fail = true;
  labelled(h.render(), 'Сохранить цель').props.onPress(); await flush();
  assert.equal(labelled(h.render(), 'Название цели').props.value, '  My draft\n');
  assert.equal(labelled(h.render(), 'Сохранить цель').props.disabled, false);
  assert.deepEqual(h.store.getSnapshot().goals, []);
  assert.deepEqual(h.events.closed, []);
  h.storage.fail = false;
  labelled(h.render(), 'Сохранить цель').props.onPress(); await flush();
  assert.equal(h.store.getSnapshot().goals[0].title, 'My draft');
});
test('Goal stale edit preserves newer committed entity and exact user draft', async () => {
  const h = await goalHarness({ existing: true });
  labelled(h.render(), 'Название цели').props.onChangeText('Unsaved edit');
  await h.store.setProgress('g1', 40, 1);
  labelled(h.render(), 'Сохранить цель').props.onPress(); await flush();
  assert.equal(labelled(h.render(), 'Название цели').props.value, 'Unsaved edit');
  assert.equal(h.store.getSnapshot().goals[0].title, 'Existing');
  assert.equal(h.store.getSnapshot().goals[0].progress, 40);
  assert.deepEqual(h.events.closed, []);
  assert.ok(find(h.render(), (n) => n.props.children === 'Цель изменилась. Закройте форму и откройте её снова.'));
});
test('Goal queued edit after an edit-save retains the correct revision for explicit resave', async () => {
  const h = await goalHarness({ existing: true });
  labelled(h.render(), 'Название цели').props.onChangeText('Before save');
  const tree = h.render(); h.storage.gate = deferred();
  labelled(tree, 'Сохранить цель').props.onPress();
  labelled(tree, 'Описание цели').props.onChangeText('New description');
  h.storage.gate.resolve(); await flush();
  assert.deepEqual(h.events.closed, []);
  labelled(h.render(), 'Сохранить цель').props.onPress(); await flush();
  assert.equal(h.store.getSnapshot().goals[0].description, 'New description');
  assert.equal(h.store.getSnapshot().revision, 3);
});

test('Goal stale delete confirmation cannot remove a changed entity', async () => {
  const h = await goalHarness({ existing: true });
  find(h.render(), (n) => n.type === 'Pressable' && n.props.children?.props?.children === 'Отмена').props.onPress();
  labelled(h.render(), 'Удалить цель').props.onPress();
  await h.store.setProgress('g1', 60, 1);
  await h.events.alert[1].onPress();
  assert.equal(h.store.getSnapshot().goals[0].progress, 60);
  assert.deepEqual(h.events.closed, []);
});
test('Goal late delete confirmation from A never mutates after B replaces it', async () => {
  const h = await goalHarness({ existing: true });
  find(h.render(), (n) => n.type === 'Pressable' && n.props.children?.props?.children === 'Отмена').props.onPress();
  labelled(h.render(), 'Удалить цель').props.onPress();
  h.events.current = 'B'; h.h.unmount();
  await h.events.alert[1].onPress();
  assert.equal(h.store.getSnapshot().goals.length, 1);
  assert.deepEqual(h.events.closed, []);
});

function dayHarness(initial = '2026-09-15') {
  const h = hooks(); let clock = isoToLocalDate(initial); let foreground; let tick;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock.getTime()])); } }
  const hook = load('../src/features/plans/usePlanDay.ts', {
    react: h.react, 'expo-router': { useFocusEffect: () => {} },
    'react-native': { AppState: { addEventListener: (_name, fn) => { foreground = fn; return { remove() {} }; } } },
    './planDates': dates,
  }, { Date: Clock, setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {} }).usePlanDay;
  return { render: () => h.render(hook), setClock: (value) => { clock = value; },
    foreground: () => foreground('active'), tick: () => tick() };
}
test('Plan production selected-date hook and store: yesterday persists, today stays isolated, restart restores', async () => {
  const h = dayHarness(); const storage = memory();
  const store = createPlanStore({ storage, now, createId: () => 'p1' }); await store.load();
  assert.equal(h.render().selectDate('2026-09-14'), true);
  assert.equal(h.render().date, '2026-09-14');
  await store.add('Yesterday\nLong plan text', h.render().date);
  assert.equal(model.tasksForDate(store.getSnapshot().tasks, h.render().date)[0].title, 'Yesterday\nLong plan text');
  h.render().setMode('today');
  assert.equal(model.tasksForDate(store.getSnapshot().tasks, h.render().date).length, 0);
  h.render().selectDate('2026-09-14');
  const restored = createPlanStore({ storage, now, createId: () => 'unused' }); await restored.load();
  assert.equal(model.tasksForDate(restored.getSnapshot().tasks, h.render().date).length, 1);
  await restored.edit('p1', 'Edited past'); await restored.toggle('p1');
  assert.equal(restored.getSnapshot().tasks[0].date, '2026-09-14');
  assert.equal(restored.getSnapshot().tasks[0].completed, true);
  await restored.remove('p1'); assert.equal(restored.getSnapshot().tasks.length, 0);
});
test('Plan arbitrary future, Today/Tomorrow shortcuts and invalid date rejection', () => {
  const h = dayHarness(); h.render().selectDate('2032-02-29');
  assert.equal(h.render().date, '2032-02-29');
  assert.equal(h.render().selectDate('2032-02-30'), false);
  assert.equal(h.render().date, '2032-02-29');
  h.render().setMode('today'); assert.equal(h.render().date, '2026-09-15');
  h.render().setMode('tomorrow'); assert.equal(h.render().date, '2026-09-16');
});
test('Plan midnight/foreground updates relative days but never shifts explicit selected date', () => {
  const h = dayHarness('2026-12-31'); h.render();
  h.setClock(isoToLocalDate('2027-01-01')); h.foreground();
  assert.equal(h.render().date, '2027-01-01');
  h.render().selectDate('2026-12-20');
  h.setClock(isoToLocalDate('2027-01-02')); h.tick();
  assert.equal(h.render().today, '2027-01-02');
  assert.equal(h.render().date, '2026-12-20');
  h.render().setMode('tomorrow'); assert.equal(h.render().date, '2027-01-03');
});
test('Plan full-year-safe date selection and next-day arithmetic never remap years 1–99', () => {
  for (const value of ['0001-01-01', '0009-12-31', '0099-02-28', '9999-12-31']) {
    const h = dayHarness(); h.render().selectDate(value); assert.equal(h.render().date, value);
    assert.equal(dates.localDateIso(isoToLocalDate(value)), value);
  }
  assert.deepEqual(dates.getPlanDates(isoToLocalDate('0009-12-31')), { today: '0009-12-31', tomorrow: '0010-01-01' });
});
test('Plan local day and DST boundaries use calendar getters in each test timezone', () => {
  const instant = new Date('2026-03-29T00:30:00Z');
  const h = dayHarness(); h.render(); h.setClock(instant); h.foreground();
  assert.equal(h.render().today, dates.localDateIso(instant));
  for (const day of ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01']) {
    const next = isoToLocalDate(day); next.setDate(next.getDate() + 1);
    assert.equal(dates.getPlanDates(isoToLocalDate(day)).tomorrow, localDateToIso(next));
  }
});
test('Actual Plan date sheet accepts early years exactly and rejects impossible dates', () => {
  const h = hooks(); const selected = [];
  const Sheet = load('../src/features/plans/PlanDateSheet.tsx', {
    react: h.react, 'react-native': native,
    '@react-native-community/datetimepicker': { default: 'DateTimePicker' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@/components/AppText': { default: 'Text' }, '@/components/ProductButton': { default: 'Button' },
    '@/features/calendar/calendarDates': { isoToLocalDate, localDateToIso }, '@/theme': theme, './planDates': dates,
  }).default;
  const render = () => h.render(() => Sheet({ initialDate: '2026-09-15', onSelect: (date) => selected.push(date), onClose() {} }));
  labelled(render(), 'Открыть календарь').props.onPress();
  const picker = find(render(), (n) => n.type === 'DateTimePicker');
  picker.props.onChange({ type: 'set' }, isoToLocalDate('2026-09-12'));
  assert.equal(labelled(render(), 'Дата плана').props.value, '2026-09-12');
  picker.props.onChange({ type: 'dismissed' }, isoToLocalDate('2026-10-20'));
  assert.equal(labelled(render(), 'Дата плана').props.value, '2026-09-12');
  labelled(render(), 'Дата плана').props.onChangeText('0009-01-02');
  assert.equal(find(render(), (n) => n.type === 'DateTimePicker'), undefined);
  labelled(render(), 'Показать день').props.onPress(); assert.deepEqual(selected, ['0009-01-02']);
  labelled(render(), 'Дата плана').props.onChangeText('2026-02-30');
  labelled(render(), 'Показать день').props.onPress(); assert.equal(selected.length, 1);
  assert.ok(find(render(), (n) => n.props.accessibilityRole === 'alert'));
});
test('Actual PlanDayView wires Date action and selected-date items to existing Plan store', async () => {
  const h = hooks(); const day = dayHarness(); const storage = memory();
  const store = createPlanStore({ storage, now, createId: () => 'past' }); await store.load();
  await store.add('Past item', '2026-09-14');
  const View = load('../src/features/plans/PlanDayView.tsx', {
    react: h.react, 'react-native': native, '@expo/vector-icons': { Ionicons: 'Icon' },
    '@/components/AppText': { default: 'Text' }, '@/components/SegmentedControl': { default: 'Segments' }, '@/theme': theme,
    './PlanItemRow': { default: 'PlanItemRow' }, './PlanItemSheet': { default: 'PlanItemSheet' },
    './PlanDateSheet': { default: 'PlanDateSheet' }, './planModel': model, './planDates': dates,
    './planSheetGuard': { closeSheetIfSame: (value, key) => value?.key === key ? null : value },
    './usePlanStore': { planStore: store, usePlanStore: store.getSnapshot },
  }).default;
  const render = () => h.render(() => View({ day: day.render() }));
  const list = find(render(), (n) => n.type === 'FlatList');
  const segments = find(list.props.ListHeaderComponent, (n) => n.type === 'Segments');
  assert.equal(segments.props.items.map((i) => i.label).join('|'), 'Сегодня|Завтра|Дата');
  segments.props.onChange('selected');
  const picker = find(render(), (n) => n.type === 'PlanDateSheet');
  picker.props.onSelect('2026-09-14');
  assert.equal(find(render(), (n) => n.type === 'FlatList').props.data[0].title, 'Past item');
  labelled(find(render(), (n) => n.type === 'FlatList').props.ListHeaderComponent, 'Добавить пункт').props.onPress();
  assert.equal(find(render(), (n) => n.type === 'PlanItemSheet').props.targetDate, '2026-09-14');
});
