/**
 * Finance money/date/allocator tests: the real production modules, no copies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMinor,
  divideMinorFloor,
  formatMoneyMinor,
  parseMoneyToMinor,
  splitMinor,
  sumMinor,
  wallClockMinutes,
} from '../src/features/finance/financeMoney.ts';
import {
  addCalendarDays,
  calendarDayDiff,
  clampDayOfMonth,
  dateInMonth,
  daysInMonth,
  isValidIsoDate,
  isValidWallClockTime,
  monthKeyOf,
  monthRange,
  shiftMonthKey,
} from '../src/features/finance/financeDates.ts';

test('integer money parsing accepts comma/dot and pads to minor units', () => {
  assert.deepEqual(parseMoneyToMinor('1234'), { ok: true, amountMinor: 123_400 });
  assert.deepEqual(parseMoneyToMinor('1234,5'), { ok: true, amountMinor: 123_450 });
  assert.deepEqual(parseMoneyToMinor('1 234.56'), { ok: true, amountMinor: 123_456 });
  assert.deepEqual(parseMoneyToMinor('0,05'), { ok: true, amountMinor: 5 });
  assert.deepEqual(parseMoneyToMinor('-50'), { ok: true, amountMinor: -5_000 });
  assert.deepEqual(parseMoneyToMinor('−50'), { ok: false, error: 'format' });
});

test('money parsing rejects precision, format and unsafe magnitudes', () => {
  assert.deepEqual(parseMoneyToMinor('1,005'), { ok: false, error: 'precision' });
  assert.deepEqual(parseMoneyToMinor(''), { ok: false, error: 'empty' });
  assert.deepEqual(parseMoneyToMinor('-'), { ok: false, error: 'format' });
  assert.deepEqual(parseMoneyToMinor('1e3'), { ok: false, error: 'format' });
  assert.deepEqual(parseMoneyToMinor('10 00 0,00,0'), { ok: false, error: 'format' });
  const huge = parseMoneyToMinor('99999999999999999999');
  assert.deepEqual(huge, { ok: false, error: 'too-large' });
});

test('money formatting is string-based (no float drift) with explicit minus', () => {
  assert.equal(formatMoneyMinor(1_280_000, 'UAH'), '12 800,00 ₴');
  assert.equal(formatMoneyMinor(-12_000, 'UAH'), '−120,00 ₴');
  assert.equal(formatMoneyMinor(10_00, 'EUR'), '10,00 €');
  assert.deepEqual(splitMinor(333), { whole: '3', cents: '33' });
  assert.equal(divideMinorFloor(1_000, 3), 333); // 10.00 / 3 = 3.33, never 3.34
  assert.equal(divideMinorFloor(-500, 3), 0); // negative balance => limit 0
  assert.equal(divideMinorFloor(1_000, 0), 0);
});

test('integer sums stay safe', () => {
  assert.equal(addMinor(1, 2), 3);
  assert.equal(addMinor(Number.MAX_SAFE_INTEGER, 1), null);
  assert.equal(sumMinor([1, 2, 3]), 6);
  assert.equal(sumMinor([Number.MAX_SAFE_INTEGER, 1]), null);
});

test('wall-clock validation', () => {
  assert.equal(wallClockMinutes('09:05'), 545);
  assert.equal(wallClockMinutes('24:00'), null);
  assert.equal(isValidWallClockTime('23:59'), true);
  assert.equal(isValidWallClockTime('9:05'), false);
});

test('calendar day difference is Gregorian, not elapsed milliseconds', () => {
  assert.equal(calendarDayDiff('2026-03-28', '2026-03-30'), 2); // across a DST gap
  assert.equal(calendarDayDiff('2026-09-12', '2026-09-12'), 0);
  assert.equal(calendarDayDiff('2026-09-12', '2026-09-11'), -1);
  assert.equal(calendarDayDiff('2024-02-28', '2024-03-01'), 2); // leap year
  assert.equal(calendarDayDiff('нope', '2026-01-01'), null);
});

test('day arithmetic and month-end clamps handle years 1-9999 and leap years', () => {
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addCalendarDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addCalendarDays('0001-01-01', 1), '0001-01-02');
  assert.equal(addCalendarDays('9999-12-31', 1), null); // range edge
  assert.equal(isValidIsoDate('0099-01-01'), true); // no 1900s remap
  assert.equal(isValidIsoDate('0000-01-01'), false);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(clampDayOfMonth(2026, 2, 31), 28);
  assert.equal(clampDayOfMonth(2026, 4, 31), 30);
  assert.equal(dateInMonth(2026, 2, 31), '2026-02-28');
  assert.equal(dateInMonth(2026, 2, 0), null);
});

test('month keys shift and clamp inside the supported range', () => {
  assert.equal(monthKeyOf('2026-09-12'), '2026-09');
  assert.equal(shiftMonthKey('2026-12', 1), '2027-01');
  assert.equal(shiftMonthKey('2026-01', -1), '2025-12');
  assert.equal(shiftMonthKey('0001-01', -1), null);
  assert.deepEqual(monthRange('2024-02'), { first: '2024-02-01', last: '2024-02-29' });
});
