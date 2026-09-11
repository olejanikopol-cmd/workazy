import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLANNER_YEAR,
  MIN_PLANNER_YEAR,
  formatJournalDate,
  formatJournalFullDate,
  isSupportedRecordsDate,
  localIsoDate,
  todayIso,
} from '../src/features/records/recordsDates.ts';

/** A local date built full-year-safe (the constructor would remap years 0-99). */
function localDate(year, month, day) {
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date;
}

test('the records year contract is 0001-9999', () => {
  assert.equal(MIN_PLANNER_YEAR, 1);
  assert.equal(MAX_PLANNER_YEAR, 9999);
  assert.equal(isSupportedRecordsDate('0000-01-01'), false);
  assert.equal(isSupportedRecordsDate('0001-01-01'), true);
  assert.equal(isSupportedRecordsDate('9999-12-31'), true);
  assert.equal(isSupportedRecordsDate('10000-01-01'), false);
  assert.equal(isSupportedRecordsDate('2026-02-30'), false);
  assert.equal(isSupportedRecordsDate('2026-13-01'), false);
});

test('year 0000 is rejected through EVERY records date helper', () => {
  const yearZero = localDate(0, 1, 1);
  assert.equal(localIsoDate(yearZero), null); // never '0000-01-01'
  assert.equal(todayIso(yearZero), null); // never '0000-01-01'
  assert.equal(formatJournalDate('0000-01-01'), null); // never rendered
  assert.equal(formatJournalFullDate('0000-01-01'), null);
  // Unsupported/invalid strings behave the same way (explicit, not silent).
  assert.equal(formatJournalDate('0000-12-31'), null);
  assert.equal(formatJournalFullDate('not-a-date'), null);
  assert.equal(formatJournalDate('2026-02-30'), null);
});

test('early supported years 0001/0009/0099/0100 work through every helper', () => {
  const cases = [
    ['0001-01-01', 1, 1, 1],
    ['0009-09-09', 9, 9, 9],
    ['0099-12-31', 99, 12, 31],
    ['0100-01-01', 100, 1, 1],
  ];
  for (const [iso, year, month, day] of cases) {
    assert.equal(isSupportedRecordsDate(iso), true, iso);
    // Derivation: the SAME string comes back (4-digit padded, no 1900s remap).
    assert.equal(localIsoDate(localDate(year, month, day)), iso);
    assert.equal(todayIso(localDate(year, month, day)), iso);
    assert.equal('0000-01-01' !== localIsoDate(localDate(year, month, day)), true);
    // Display: a real, non-empty RU date (never the unsupported value).
    const short = formatJournalDate(iso);
    const full = formatJournalFullDate(iso);
    assert.equal(typeof short, 'string');
    assert.equal(typeof full, 'string');
    assert.equal(short.length > 0, true);
    assert.equal(full.length > 0, true);
    assert.equal(short.includes('0000'), false);
    assert.equal(full.includes('0000'), false);
    assert.equal(/г\.|год/.test(short), false); // no year in the short form
  }
  // Exact year-1 rendering proves no 1900s remapping (1901-01-01 was a Tuesday).
  assert.equal(formatJournalFullDate('0001-01-01'), 'Понедельник, 1 января');
  assert.equal(formatJournalDate('0009-09-09'), '9 сентября');
});

test('modern dates keep their existing behavior', () => {
  assert.equal(localIsoDate(localDate(2026, 9, 11)), '2026-09-11');
  assert.equal(todayIso(localDate(2024, 2, 29)), '2024-02-29');
  assert.equal(formatJournalDate('2026-09-11'), '11 сентября');
  assert.equal(formatJournalFullDate('2026-09-11'), 'Пятница, 11 сентября');
  assert.equal(formatJournalDate('2024-02-29'), '29 февраля');
});

test('the upper bound is enforced too (no year above 9999)', () => {
  assert.equal(localIsoDate(localDate(10000, 1, 1)), null);
  assert.equal(todayIso(localDate(10000, 1, 1)), null);
  assert.equal(formatJournalDate('9999-12-31') !== null, true);
  assert.equal(localIsoDate(localDate(9999, 12, 31)), '9999-12-31');
});

test('DST-adjacent local dates still derive the correct local day', () => {
  // 12:00 local is used internally, so DST transitions cannot shift the day.
  assert.equal(localIsoDate(localDate(2026, 3, 29)), '2026-03-29');
  assert.equal(localIsoDate(localDate(2026, 10, 25)), '2026-10-25');
});
