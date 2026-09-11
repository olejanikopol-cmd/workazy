import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEvent,
  agendaForDate,
  editEvent,
  eventsForDate,
  parseReminderMinutes,
  reminderLabel,
  removeEvent,
  validateEventInput,
} from '../src/features/calendar/calendarModel.ts';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const D1 = '2026-09-10';
const D2 = '2026-09-11';

function ev(id, title, date, time, note, reminder, createdAt) {
  const e = { id, title, date, completed: false, createdAt, updatedAt: undefined };
  e.completed = false;
  if (time !== undefined) e.time = time;
  if (note !== undefined) e.note = note;
  if (reminder !== undefined) e.reminder = reminder;
  delete e.completed;
  if (!createdAt) delete e.createdAt;
  else e.createdAt = createdAt;
  delete e.updatedAt;
  return e;
}

test('addEvent trims, keeps newlines, captures date/time/note/reminder and appends', () => {
  const base = [ev('e1', 'Утренний кофе', D1, '08:00', undefined, 'За 10 минут')];
  const res = addEvent(base, {
    id: 'e2',
    now: NOW,
    title: '  Звонок\nс новыми\nстроками  ',
    date: D2,
    time: '18:30',
    note: '  Заметка  ',
    reminder: 'За 30 минут',
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.event.title, 'Звонок\nс новыми\nстроками');
  assert.equal(res.event.date, D2);
  assert.equal(res.event.time, '18:30');
  assert.equal(res.event.note, 'Заметка');
  assert.equal(res.event.reminder, 'За 30 минут');
  assert.equal(res.event.createdAt, NOW.toISOString());
  assert.equal(res.event.updatedAt, NOW.toISOString());
  assert.equal(res.tasks === undefined, true); // no PlanTask semantics
  assert.deepEqual(res.events.map((e) => e.id), ['e1', 'e2']);
});

test('addEvent rejects blank/overlong/missing date and preserves the input array', () => {
  const base = [ev('e1', 'A', D1)];
  assert.deepEqual(addEvent(base, { id: 'x', now: NOW, title: '   ', date: D1 }), {
    ok: false,
    reason: 'validation',
  });
  assert.deepEqual(
    addEvent(base, { id: 'x', now: NOW, title: 'а'.repeat(301), date: D1 }),
    { ok: false, reason: 'validation' },
  );
  assert.deepEqual(addEvent(base, { id: 'x', now: NOW, title: 'B', date: '' }), {
    ok: false,
    reason: 'validation',
  });
  assert.deepEqual(addEvent(base, { id: 'x', now: NOW, title: 'B', date: D1, time: '25:00' }), {
    ok: false,
    reason: 'validation',
  });
  assert.equal(base.length, 1);
});

test('editEvent preserves id/createdAt/array position and updates only content fields', () => {
  const base = [
    ev('e1', 'Один', D1, '09:00', 'Заметка', 'За 10 минут', '2026-09-01T00:00:00.000Z'),
    ev('e2', 'Два', D1, '10:00'),
    ev('e3', 'Три', D2),
  ];
  const res = editEvent(base, 'e1', { title: 'Один (новое)', date: D2, time: '12:00', note: '', reminder: 'Только в момент события' }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.events.map((e) => e.id), ['e1', 'e2', 'e3']); // position preserved
  const edited = res.events[0];
  assert.equal(edited.title, 'Один (новое)');
  assert.equal(edited.date, D2); // date moved
  assert.equal(edited.time, '12:00');
  assert.equal(edited.reminder, 'Только в момент события');
  assert.equal('note' in edited, false); // cleared on explicit empty
  assert.equal(edited.id, 'e1');
  assert.equal(edited.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(edited.updatedAt, NOW.toISOString());
  assert.equal(res.events[1].createdAt, undefined);
});

test('agenda sorts timed ascending, untimed last, equal times in stored order', () => {
  const all = [
    ev('a', 'Без времени', D1, undefined),
    ev('b', '18:00 #2', D1, '18:00'),
    ev('c', 'Untimed 2', D1, undefined),
    ev('d', '09:00', D1, '09:00'),
    ev('e', '18:00 #1', D1, '18:00'),
    ev('f', 'Другой день', D2, '08:00'),
  ];
  const agenda = agendaForDate(all, D1);
  assert.deepEqual(agenda.map((e) => e.id), ['d', 'b', 'e', 'a', 'c']);
  // equal times 18:00 keep stored order b before e
  assert.deepEqual(eventsForDate(all, D1).map((e) => e.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(agendaForDate(all, D2).map((e) => e.id), ['f']);
});

test('removeEvent removes exactly one id', () => {
  const base = [ev('a', 'A', D1), ev('b', 'B', D1)];
  const res = removeEvent(base, 'a');
  assert.equal(res.ok, true);
  assert.deepEqual(res.events.map((e) => e.id), ['b']);
  assert.deepEqual(removeEvent(base, 'nope'), { ok: false, reason: 'missing' });
});

test('reminder parsing matches the web scheduler mapping', () => {
  assert.equal(parseReminderMinutes(undefined), null);
  assert.equal(parseReminderMinutes(''), null);
  assert.equal(parseReminderMinutes('Не напоминать'), null);
  assert.equal(parseReminderMinutes('чепуха'), null);
  assert.equal(parseReminderMinutes('В момент события'), 0);
  assert.deepEqual(parseReminderMinutes('За 10 минут'), 10);
  assert.deepEqual(parseReminderMinutes('За 30 минут'), 30);
  assert.deepEqual(parseReminderMinutes('За 1 час'), 60);
  assert.deepEqual(parseReminderMinutes('за 2 часа'), 120);
  assert.deepEqual(parseReminderMinutes('за 2 дня'), 2880);
  assert.equal(parseReminderMinutes('за 8 дней'), 7 * 24 * 60); // capped at 10080
  assert.equal(parseReminderMinutes('зА 45 мИн'), 45);
});

test('reminderLabel shows human-readable choices and start-only fallback', () => {
  assert.equal(reminderLabel(undefined), 'В момент события');
  assert.equal(reminderLabel('Не напоминать'), 'В момент события');
  assert.equal(reminderLabel('За 10 минут'), 'За 10 минут');
  assert.equal(reminderLabel('За 30 минут'), 'За 30 минут');
  assert.equal(reminderLabel('За 1 час'), 'За 1 час');
  assert.equal(reminderLabel('В момент события'), 'В момент события');
  assert.equal(reminderLabel('за 2 часа'), 'За 120 минут');
});

test('validateEventInput normalizes fields and rejects invalid time/date', () => {
  const ok = validateEventInput({ title: '  Т  ', date: D1, time: '', note: '  ' });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.input.title, 'Т');
    assert.equal(ok.input.time, undefined); // empty string -> untimed
    assert.equal(ok.input.note, undefined);
  }
  assert.equal(validateEventInput({ title: 'Т', date: '2026-02-30' }).ok, false);
  assert.equal(validateEventInput({ title: 'Т', date: D1, time: '11:99' }).ok, false);
});


test('editEvent preserves an ABSENT reminder exactly (never converts to default)', () => {
  const base = [ev('e1', 'Без напоминания', D1, '10:00', undefined, undefined, '2026-09-01T00:00:00.000Z')];
  // Editing with NO reminder in the input keeps the event reminder-less.
  const res = editEvent(base, 'e1', { title: 'Без напоминания (новое)', date: D1, time: '10:00' }, NOW);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal('reminder' in res.events[0], false);
  assert.equal(res.events[0].reminder, undefined);
  // A legacy stored string is preserved too when the edit does not touch it.
  const legacy = [ev('e2', 'Старое', D1, '11:00', undefined, 'за 2 дня', '2026-09-01T00:00:00.000Z')];
  // The Sheet passes the stored value through when the user did not change it.
  const res2 = editEvent(legacy, 'e2', { title: 'Старое', date: D1, time: '11:00', reminder: 'за 2 дня' }, NOW);
  assert.equal(res2.ok, true);
  if (!res2.ok) return;
  assert.equal(res2.events[0].reminder, 'за 2 дня');
});



test('save validation follows the planner year contract (0001 kept, 0000 rejected)', () => {
  const base = { title: 'Событие', time: '12:00' };
  assert.equal(validateEventInput({ ...base, date: '0001-01-01' }).ok, true);
  assert.equal(validateEventInput({ ...base, date: '0009-09-09' }).ok, true);
  assert.equal(validateEventInput({ ...base, date: '0099-12-31' }).ok, true);
  assert.equal(validateEventInput({ ...base, date: '0100-01-01' }).ok, true);
  assert.equal(validateEventInput({ ...base, date: '2026-09-10' }).ok, true);
  // Year 0000 is rejected by the same validation path the editor uses.
  assert.equal(validateEventInput({ ...base, date: '0000-01-01' }).ok, false);
});
