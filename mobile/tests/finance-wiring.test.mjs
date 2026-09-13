/**
 * Finance UI wiring inspection: the tests above exercise the production model,
 * store and storage; this file checks that the screens/forms are wired to them and
 * that Slice 6A did NOT add OS notification scheduling (deferred to Slice 6B).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../src/features/finance/${name}`, import.meta.url), 'utf8');

test('the screen is wired to the store commands with revision guards', () => {
  const screen = read('FinanceScreen.tsx');
  assert.match(screen, /from '\.\/useFinanceStore'/);
  assert.match(screen, /financeStore\.load\(\)/);
  assert.match(screen, /financeStore\.ensureDay\(today\)/);
  assert.match(screen, /expectedRevision: revision/);
  // All three internal sections exist in one tab (no extra navigation).
  assert.match(screen, /Обзор/);
  assert.match(screen, /Операции/);
  assert.match(screen, /Обязательства/);
  assert.match(screen, /FinanceCalendar/);
});

test('the store singleton is the only AsyncStorage/Crypto importer in the feature', () => {
  const files = readdirSync(new URL('../src/features/finance/', import.meta.url)).filter((name) =>
    name.endsWith('.ts') || name.endsWith('.tsx'),
  );
  const importers = files.filter((name) => {
    const source = read(name);
    return source.includes("from '@react-native-async-storage/async-storage'") ||
      source.includes("from 'expo-crypto'");
  });
  assert.deepEqual(importers, ['useFinanceStore.ts']);
});

test('Slice 6A does not schedule OS notifications for Finance (Slice 6B)', () => {
  const files = readdirSync(new URL('../src/features/finance/', import.meta.url)).filter((name) =>
    name.endsWith('.ts') || name.endsWith('.tsx'),
  );
  for (const name of files) {
    const source = read(name);
    assert.equal(source.includes('expo-notifications'), false, `${name} must not use notifications`);
    assert.equal(source.includes('scheduleNotification'), false, `${name} must not schedule`);
  }
  // Reminder INTENT is stored, and the UI says the scheduling is not active yet.
  const sheets = read('FinanceSheets.tsx');
  assert.match(sheets, /reminderEnabled/);
  assert.match(sheets, /Slice 6B/);
});

test('no Finance file talks to the network, browser storage or the web API', () => {
  const files = readdirSync(new URL('../src/features/finance/', import.meta.url)).filter((name) =>
    name.endsWith('.ts') || name.endsWith('.tsx'),
  );
  for (const name of files) {
    const source = read(name);
    for (const banned of ['fetch(', 'XMLHttpRequest', 'localStorage', 'planner-finance-state', 'telegram']) {
      assert.equal(source.includes(banned), false, `${name} must not contain ${banned}`);
    }
  }
  const storage = readFileSync(
    new URL('../src/storage/financeStorage.ts', import.meta.url),
    'utf8',
  );
  assert.match(storage, /workazy-native-finance-v1/);
  assert.equal(storage.includes('localStorage'), false);
});

test('the legacy adapter is pure code with no runtime call site', () => {
  const adapter = read('financeLegacyAdapter.ts');
  assert.match(adapter, /export function transferLegacyFinance/);
  assert.equal(adapter.includes('AsyncStorage'), false);
  assert.equal(adapter.includes('expo-'), false);
  // Nothing in the feature or the screen imports it: the transfer is not wired.
  const files = readdirSync(new URL('../src/features/finance/', import.meta.url)).filter(
    (name) => name !== 'financeLegacyAdapter.ts',
  );
  for (const name of files) {
    assert.equal(
      read(name).includes('financeLegacyAdapter'),
      false,
      `${name} must not import the legacy adapter (no import UI in 6A)`,
    );
  }
});
