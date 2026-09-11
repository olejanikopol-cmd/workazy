import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateIso,
  formatEventFullDate,
  isoToLocalDate,
  isValidIsoDate,
  isValidTime,
  localDateToIso,
  monthGrid,
  monthLabel,
  zonedDateTimeToUtc,
  zonedDateTimeToUtcEarlier,
} from '../src/features/calendar/calendarDates.ts';

test('monthGrid is Monday-first with correct leading blanks', () => {
  // 2026-09-01 is a Tuesday (0 for Sunday). Monday-first index = (2+6)%7 = 1.
  const grid = monthGrid(2026, 8);
  assert.deepEqual(grid.weekdays, ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
  assert.equal(grid.leadingBlanks, 1);
  assert.equal(grid.daysInMonth, 30);
  assert.equal(grid.cells[0], null);
  assert.equal(grid.cells[1], 1);
  assert.equal(grid.cells.filter((c) => c !== null).length, 30);
});

test('monthGrid handles leap year and month/year boundaries', () => {
  const leap = monthGrid(2024, 1); // Feb 2024
  assert.equal(leap.daysInMonth, 29);
  const nonLeap = monthGrid(2026, 1); // Feb 2026
  assert.equal(nonLeap.daysInMonth, 28);
  // December 2025 -> January 2026
  const dec = monthGrid(2025, 11);
  assert.equal(dec.daysInMonth, 31);
  const jan = monthGrid(2026, 0);
  assert.equal(jan.daysInMonth, 31);
});

test('dateIso builds local labels across boundaries', () => {
  assert.equal(dateIso(2026, 0, 1), '2026-01-01');
  assert.equal(dateIso(2026, 11, 31), '2026-12-31');
  assert.equal(dateIso(2024, 1, 29), '2024-02-29');
});

test('monthLabel is a RU month + year', () => {
  const label = monthLabel(2026, 8); assert.ok(label.includes('сентябрь') && label.includes('2026'));
});

test('isValidTime accepts 00:00-23:59, rejects out-of-range and malformed', () => {
  assert.equal(isValidTime('00:00'), true);
  assert.equal(isValidTime('23:59'), true);
  assert.equal(isValidTime('09:05'), true);
  assert.equal(isValidTime('24:00'), false);
  assert.equal(isValidTime('23:60'), false);
  assert.equal(isValidTime('9:05'), false);
  assert.equal(isValidTime(''), false);
});

test('zonedDateTimeToUtc rejects the Europe/Kyiv spring-forward gap', () => {
  // 2026-03-29 03:30 local does not exist (clocks 03:00 -> 04:00).
  assert.equal(zonedDateTimeToUtc('2026-03-29', '03:30', 'Europe/Kyiv'), null);
  assert.equal(zonedDateTimeToUtc('2026-03-29', '02:30', 'Europe/Kyiv') === null, false);
  assert.equal(
    zonedDateTimeToUtc('2026-03-29', '04:30', 'Europe/Kyiv')?.toISOString(),
    '2026-03-29T01:30:00.000Z',
  );
});

test('zonedDateTimeToUtc accepts valid instants around the gap boundary', () => {
  // 2026-03-28 23:30 local (UTC+2) -> 21:30Z
  assert.equal(
    zonedDateTimeToUtc('2026-03-28', '23:30', 'Europe/Kyiv')?.toISOString(),
    '2026-03-28T21:30:00.000Z',
  );
  // 2026-03-29 04:30 local (UTC+3) -> 01:30Z
  assert.equal(
    zonedDateTimeToUtc('2026-03-29', '04:30', 'Europe/Kyiv')?.toISOString(),
    '2026-03-29T01:30:00.000Z',
  );
});

test('zonedDateTimeToUtcEarlier prefers the earlier fold occurrence in Europe/Kyiv fall-back', () => {
  // 2026-10-25 03:30 local repeats when clocks go 04:00 -> 03:00.
  const picked = zonedDateTimeToUtcEarlier('2026-10-25', '03:30', 'Europe/Kyiv');
  assert.ok(picked !== null);
  // Earlier occurrence is UTC+2 (03:30 local -> 01:30Z).
  assert.equal(picked.toISOString(), '2026-10-25T00:30:00.000Z');
});

test('zonedDateTimeToUtc crosses the Los_Angeles spring gap and fall fold', () => {
  // LA springs forward 2026-03-08 03:00 local; 02:30 local does not exist.
  assert.equal(zonedDateTimeToUtc('2026-03-08', '02:30', 'America/Los_Angeles'), null);
  assert.equal(
    zonedDateTimeToUtc('2026-03-08', '03:30', 'America/Los_Angeles')?.toISOString(),
    '2026-03-08T10:30:00.000Z',
  );
  // LA falls back 2026-11-01; 01:30 local repeats — earlier occurrence is UTC-7.
  const picked = zonedDateTimeToUtcEarlier('2026-11-01', '01:30', 'America/Los_Angeles');
  assert.equal(picked.toISOString(), '2026-11-01T08:30:00.000Z');
});

test('reminder subtraction across a DST boundary uses wall-clock arithmetic', () => {
  // Event 2026-03-30 00:30 Kyiv (UTC+3) with a 1-hour advance. The advance
  // instant is derived by subtracting minutes from the UTC start, then the
  // wall-clock in Kyiv crosses into the spring-forward change.
  const start = zonedDateTimeToUtc('2026-03-30', '00:30', 'Europe/Kyiv');
  assert.equal(start.toISOString(), '2026-03-29T21:30:00.000Z');
  const advance = new Date(start.getTime() - 60 * 60 * 1000);
  assert.equal(advance.toISOString(), '2026-03-29T20:30:00.000Z');
});

test('local dates near UTC midnight stay tied to the constructor, not toISOString slicing', () => {
  // This test runs under whatever TZ the runner uses; dateIso uses local getters.
  const lateNight = new Date(2026, 8, 10, 23, 59, 59, 0);
  assert.equal(dateIso(lateNight.getFullYear(), lateNight.getMonth(), lateNight.getDate()), '2026-09-10');
  const early = new Date(2026, 8, 11, 0, 0, 1, 0);
  assert.equal(dateIso(early.getFullYear(), early.getMonth(), early.getDate()), '2026-09-11');
});

test('formatEventFullDate is a capitalized Russian date', () => {
  const f = formatEventFullDate('2026-09-10');
  assert.match(f, /^[А-ЯЁ]/);
  assert.ok(f.includes(' ') && f.length > 8);
});


test('dateIso keeps exact years 1..99 (no JS 1900s remap) and pads to 4 digits', () => {
  assert.equal(dateIso(1, 0, 1), '0001-01-01');
  assert.equal(dateIso(9, 8, 9), '0009-09-09');
  assert.equal(dateIso(99, 11, 31), '0099-12-31');
  assert.equal(dateIso(100, 0, 1), '0100-01-01');
  assert.equal(dateIso(1000, 0, 1), '1000-01-01');
  // Normal modern years keep their existing behavior (leap day included).
  assert.equal(dateIso(2026, 8, 10), '2026-09-10');
  assert.equal(dateIso(2024, 1, 29), '2024-02-29');
  assert.equal(dateIso(2026, 11, 31), '2026-12-31');
});

test('zonedDateTimeToUtc resolves years 1..99 without remap (0001-01-01 12:00 UTC)', () => {
  assert.equal(
    zonedDateTimeToUtc('0001-01-01', '12:00', 'UTC')?.toISOString(),
    '0001-01-01T12:00:00.000Z',
  );
  assert.equal(
    zonedDateTimeToUtcEarlier('0001-01-01', '12:00', 'UTC')?.toISOString(),
    '0001-01-01T12:00:00.000Z',
  );
  assert.equal(
    zonedDateTimeToUtc('0009-09-09', '00:00', 'UTC')?.toISOString(),
    '0009-09-09T00:00:00.000Z',
  );
  assert.equal(
    zonedDateTimeToUtc('0099-12-31', '23:59', 'UTC')?.toISOString(),
    '0099-12-31T23:59:00.000Z',
  );
  assert.equal(
    zonedDateTimeToUtc('0100-01-01', '12:00', 'UTC')?.toISOString(),
    '0100-01-01T12:00:00.000Z',
  );
  // A non-UTC zone still resolves correctly for an early year: the result must
  // render back to the requested wall-clock time. (Kyiv in year 1 uses the
  // historical LMT offset, not the modern +02:00, so no fixed offset is asserted.)
  const kyiv = zonedDateTimeToUtc('0001-01-01', '12:00', 'Europe/Kyiv');
  assert.ok(kyiv !== null);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(kyiv);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  assert.equal(Number(value('year')), 1);
  assert.equal(value('month'), '01');
  assert.equal(value('day'), '01');
  assert.equal(value('hour'), '12');
  assert.equal(value('minute'), '00');
});

test('year 1 grid/format helpers do not remap to 1901', () => {
  const grid = monthGrid(1, 0);
  assert.equal(grid.daysInMonth, 31);
  assert.ok(grid.leadingBlanks >= 0 && grid.leadingBlanks <= 6);
  assert.ok(monthLabel(1, 0).includes('1'));
  assert.ok(formatEventFullDate('0001-01-01').length > 0);
});


test('editor picker round-trip preserves exact years (stored -> picker -> stored)', () => {
  const cases = ['0001-01-01', '0009-09-09', '0099-12-31', '0100-01-01', '2026-09-10', '2024-02-29'];
  for (const iso of cases) {
    const pickerValue = isoToLocalDate(iso); // stored value -> picker representation
    assert.equal(localDateToIso(pickerValue), iso); // picker -> save serialization
    assert.equal(isValidIsoDate(iso), true); // save validation accepts it
    assert.equal(localDateToIso(pickerValue).length, 10); // year always 4-digit padded
  }
  // Years < 100 keep their leading zeros (never '1-01-01', never 1901).
  assert.equal(localDateToIso(isoToLocalDate('0001-01-01')), '0001-01-01');
  assert.equal(isoToLocalDate('0001-01-01').getFullYear(), 1);
  assert.equal(isoToLocalDate('0099-12-31').getFullYear(), 99);
});

test('year 0000 is rejected consistently (validation + zoned conversion)', () => {
  // Chosen contract: the planner domain is 0001-9999; year 0000 (1 BC) is not a
  // meaningful event date, so it is rejected rather than supported.
  assert.equal(isValidIsoDate('0000-01-01'), false);
  assert.equal(zonedDateTimeToUtc('0000-01-01', '12:00', 'UTC'), null);
  assert.equal(zonedDateTimeToUtcEarlier('0000-01-01', '12:00', 'UTC'), null);
  // 0001 stays valid and exact, so the rejection is not over-broad.
  assert.equal(isValidIsoDate('0001-01-01'), true);
  assert.equal(
    zonedDateTimeToUtc('0001-01-01', '12:00', 'UTC')?.toISOString(),
    '0001-01-01T12:00:00.000Z',
  );
});
