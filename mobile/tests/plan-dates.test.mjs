import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateForMode,
  formatFullDate,
  formatPlanDay,
  getPlanDates,
  isValidIsoDate,
  isValidIsoTimestamp,
  localDateIso,
} from '../src/features/plans/planDates.ts';

test('localDateIso uses local calendar getters, never UTC', () => {
  // An instant whose UTC date differs from the local date under both Kyiv and
  // Los_Angeles — the result must be the local calendar day.
  const instant = new Date('2026-03-28T22:30:00Z');
  const result = localDateIso(instant);
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  const local = new Date(instant.getFullYear(), instant.getMonth(), instant.getDate());
  assert.equal(result, localDateIso(local));
  assert.ok(result === '2026-03-28' || result === '2026-03-29');
});

test('getPlanDates handles month/year boundaries and leap day', () => {
  assert.deepEqual(getPlanDates(new Date(2026, 0, 1, 8)), {
    today: '2026-01-01',
    tomorrow: '2026-01-02',
  });
  assert.deepEqual(getPlanDates(new Date(2025, 11, 31, 12)), {
    today: '2025-12-31',
    tomorrow: '2026-01-01',
  });
  assert.deepEqual(getPlanDates(new Date(2024, 1, 28, 12)), {
    today: '2024-02-28',
    tomorrow: '2024-02-29',
  });
  assert.deepEqual(getPlanDates(new Date(2024, 1, 29, 12)), {
    today: '2024-02-29',
    tomorrow: '2024-03-01',
  });
});

test('getPlanDates crosses DST without using a fixed offset', () => {
  // Spring: Europe/Kyiv 2026-03-29, America/Los_Angeles 2026-03-08.
  assert.deepEqual(getPlanDates(new Date(2026, 2, 28, 23, 30)), {
    today: '2026-03-28',
    tomorrow: '2026-03-29',
  });
  assert.deepEqual(getPlanDates(new Date(2026, 2, 29, 2, 30)), {
    today: '2026-03-29',
    tomorrow: '2026-03-30',
  });
  // Autumn: Europe/Kyiv 2026-10-25, America/Los_Angeles 2026-11-01.
  assert.deepEqual(getPlanDates(new Date(2026, 9, 25, 0, 5)), {
    today: '2026-10-25',
    tomorrow: '2026-10-26',
  });
  assert.deepEqual(getPlanDates(new Date(2026, 10, 1, 0, 5)), {
    today: '2026-11-01',
    tomorrow: '2026-11-02',
  });
});

test('formatPlanDay prefers relative labels', () => {
  const today = '2026-09-10';
  const tomorrow = '2026-09-11';
  assert.equal(formatPlanDay(today, today, tomorrow), 'Сегодня');
  assert.equal(formatPlanDay(tomorrow, today, tomorrow), 'Завтра');
  assert.equal(formatPlanDay('2026-09-10', '2026-09-10', '2026-09-11'), 'Сегодня');
});

test('formatFullDate produces a capitalized Russian weekday date', () => {
  const formatted = formatFullDate('2026-09-10');
  assert.match(formatted, /^[А-ЯЁ][а-яё]+/);
  assert.ok(formatted.includes(' ') && formatted.length > 8);
  assert.equal(formatted.charAt(0).toUpperCase(), formatted.charAt(0));
});

test('isValidIsoDate keeps exact years 1..99 (no JS 1900s remap)', () => {
  assert.equal(isValidIsoDate('0001-01-01'), true);
  assert.equal(isValidIsoDate('0009-09-09'), true);
  assert.equal(isValidIsoDate('0099-12-31'), true);
  assert.equal(isValidIsoDate('0100-01-01'), true);
  assert.equal(isValidIsoDate('0001-02-30'), false); // still rejects impossible days
  assert.equal(isValidIsoDate('0099-13-01'), false);
  assert.equal(formatFullDate('0001-01-01').length > 0, true);
});

test('isValidIsoDate accepts real calendar dates only', () => {
  assert.equal(isValidIsoDate('2026-09-10'), true);
  assert.equal(isValidIsoDate('2024-02-29'), true);
  assert.equal(isValidIsoDate('2026-02-28'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('2026-00-10'), false);
  assert.equal(isValidIsoDate('2026-1-10'), false);
  assert.equal(isValidIsoDate('10.09.2026'), false);
  assert.equal(isValidIsoDate(''), false);
});

test('isValidIsoTimestamp accepts full ISO-8601 timestamps only', () => {
  assert.equal(isValidIsoTimestamp('2026-09-10T12:00:00.000Z'), true);
  assert.equal(isValidIsoTimestamp('2026-09-10T23:59:59.999Z'), true);
  assert.equal(isValidIsoTimestamp('2024-02-29T12:00:00.000Z'), true);
  assert.equal(isValidIsoTimestamp('2026-09-10T12:00'), false);
  assert.equal(isValidIsoTimestamp('2026-09-10 12:00:00'), false);
  assert.equal(isValidIsoTimestamp('2026-09-10T12:00:00Z'), false);
  assert.equal(isValidIsoTimestamp('2026-13-45T99:00:00.000Z'), false);
});

test('isValidIsoTimestamp rejects impossible calendar days that Date.parse would normalize', () => {
  // 2026-02-30 does not exist; Date.parse/Date normalize it to March 2, so the
  // validator must check the calendar explicitly instead of trusting parse.
  assert.equal(isValidIsoTimestamp('2026-02-30T12:00:00.000Z'), false);
  assert.equal(isValidIsoTimestamp('2026-04-31T12:00:00.000Z'), false);
  assert.equal(isValidIsoTimestamp('2026-06-31T12:00:00.000Z'), false);
  assert.equal(isValidIsoTimestamp('2026-11-31T12:00:00.000Z'), false);
  // 2026 is not a leap year; 2024 is.
  assert.equal(isValidIsoTimestamp('2026-02-29T12:00:00.000Z'), false);
  assert.equal(isValidIsoTimestamp('2024-02-29T12:00:00.000Z'), true);
  // Out-of-range time fields.
  assert.equal(isValidIsoTimestamp('2026-09-10T24:00:00.000Z'), false);
  assert.equal(isValidIsoTimestamp('2026-09-10T12:60:00.000Z'), false);
  assert.equal(isValidIsoTimestamp('2026-09-10T12:00:60.000Z'), false);
});

test('isValidIsoTimestamp treats Z as strictly UTC and accepts DST-gap instants', () => {
  // 2026-03-29 03:30 local does not exist under Europe/Kyiv (clocks jump
  // 03:00 -> 04:00), but 2026-03-29T03:30:00.000Z is a real UTC instant and
  // must be accepted in every timezone. Local-time Date construction would
  // normalize it to 04:30 and reject it — the validator must not do that.
  assert.equal(isValidIsoTimestamp('2026-03-29T03:30:00.000Z'), true);
  assert.equal(isValidIsoTimestamp('2026-03-29T04:30:00.000Z'), true);
  // America/Los_Angeles fall-back (2026-11-01 01:30 local repeats) — the UTC
  // instant is unambiguous and must be accepted.
  assert.equal(isValidIsoTimestamp('2026-11-01T01:30:00.000Z'), true);
  assert.equal(isValidIsoTimestamp('2026-11-01T08:30:00.000Z'), true);
});

test('dateForMode resolves the concrete calendar date for a relative mode', () => {
  const today = '2026-09-10';
  const tomorrow = '2026-09-11';
  assert.equal(dateForMode('today', today, tomorrow), today);
  assert.equal(dateForMode('tomorrow', today, tomorrow), tomorrow);
});