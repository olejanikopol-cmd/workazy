/**
 * Slice 6A round-2 review fixes: regressions for all seven findings, exercised
 * through the production store, model, parser, day/form helpers and UI wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FINANCE_STORAGE_KEY,
  createEmptyFinanceSnapshot,
  parseFinanceSnapshot,
  serializeFinanceSnapshot,
} from '../src/storage/financeStorage.ts';
import { createFinanceStore, FINANCE_COMMAND_POLICY } from '../src/features/finance/financeStore.ts';
import * as model from '../src/features/finance/financeModel.ts';
import {
  createFinanceDayController,
  createSheetRegistry,
  resolveSubmittedFinanceDate,
} from '../src/features/finance/financeDay.ts';

const NOW = '2026-09-12T09:00:00.000Z';
const TODAY = '2026-09-12';

const clock = (today = TODAY, nowIso = NOW) => ({ today, nowIso });

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  let failCount = 0;
  return {
    writes,
    current: () => map.get(FINANCE_STORAGE_KEY) ?? null,
    failWrites(times = 1) {
      failCount = times;
    },
    getItem: async (key) => (map.has(key) ? map.get(key) : null),
    async setItem(key, value) {
      if (failCount > 0) {
        failCount -= 1;
        throw new Error('disk full');
      }
      writes.push(value);
      map.set(key, value);
    },
  };
}

function buildStore(storage, now = () => new Date(NOW)) {
  let counter = 0;
  return createFinanceStore({
    storage,
    now,
    createId: (prefix) => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  });
}

const setupInput = (overrides = {}) => ({
  currency: 'UAH',
  balanceMinor: 1_000_000,
  limitMode: 'auto',
  manualLimitMinor: null,
  fallbackEndDate: null,
  clock: clock(),
  ...overrides,
});

/** AUTO horizon of 10 calendar days (today 2026-09-12 -> schedule day 22). */
async function storeWithHorizon({ salaryDay = 22, limitMode = 'auto', manual = null } = {}) {
  const storage = memoryStorage();
  const store = buildStore(storage);
  await store.load();
  await store.setup(setupInput({ limitMode, manualLimitMinor: manual }));
  await store.addSchedule({
    dayOfMonth: salaryDay,
    expectedAmountMinor: 2_000_000,
    title: 'Зарплата',
    active: true,
    expectedRevision: store.getSnapshot().snapshot.revision,
  });
  return { storage, store };
}

/** Hydrates a store from a prepared committed snapshot (no allowance row yet). */
async function hydratingStore(prepare) {
  const base = createEmptyFinanceSnapshot(NOW);
  const snapshot = prepare(base);
  const envelope = serializeFinanceSnapshot(snapshot, NOW);
  const storage = memoryStorage({ [FINANCE_STORAGE_KEY]: envelope });
  const store = buildStore(storage);
  await store.load();
  assert.equal(store.getSnapshot().phase, 'ready');
  return { storage, store };
}

function withSchedule(snapshot, { dayOfMonth = 22, id = 'schedule-1' } = {}) {
  return {
    ...snapshot,
    initialized: true,
    settings: { ...snapshot.settings, limitMode: 'auto' },
    balanceMinor: 1_000_000,
    salarySchedules: [
      {
        id,
        dayOfMonth,
        expectedAmountMinor: 2_000_000,
        title: 'Зарплата',
        active: true,
        createdAt: NOW,
      },
    ],
  };
}
// __APPEND__
// These tests complete the interrupted suite; each command uses the real store.
test('round 2: future settings establish PRE-mutation AUTO in the same write', async () => {
  const {storage,store}=await hydratingStore(base=>withSchedule(base));
  const result=await store.saveLimitSettings({limitMode:'manual',manualLimitMinor:50000,fallbackEndDate:null,applyToday:false,date:TODAY,expectedRevision:0});
  assert.equal(result.ok,true);
  assert.equal(storage.writes.length,1);
  const saved=parseFinanceSnapshot(storage.current()).snapshot;
  assert.equal(saved.settings.limitMode,'manual');
  assert.equal(model.allowanceFor(saved,TODAY).amountMinor,100000);
  assert.equal(model.allowanceFor(saved,TODAY).mode,'auto');
  assert.equal(FINANCE_COMMAND_POLICY.saveLimitSettings,'allowance-first');
});

test('round 2: failed correction persists neither balance nor first allowance', async () => {
  const {storage,store}=await hydratingStore(base=>withSchedule(base));
  const before=store.getSnapshot().snapshot;
  storage.failWrites();
  assert.deepEqual(await store.correctBalance({balanceMinor:900000,expectedRevision:0}),{ok:false,reason:'storage'});
  assert.equal(store.getSnapshot().snapshot,before);
  assert.equal(storage.writes.length,0);
  assert.equal((await store.correctBalance({balanceMinor:900000,expectedRevision:0})).ok,true);
  assert.equal(storage.writes.length,1);
  assert.equal(model.allowanceFor(store.getSnapshot().snapshot,TODAY).amountMinor,100000);
  assert.equal(store.getSnapshot().snapshot.balanceMinor,900000);
});

test('round 2: no-horizon settings and new expectation establish allowance atomically', async () => {
  for(const kind of ['settings','expectation']) {
    const storage=memoryStorage();const store=buildStore(storage);await store.load();await store.setup(setupInput());
    const before=storage.writes.length,revision=store.getSnapshot().snapshot.revision;
    const result=kind==='settings'
      ? await store.saveLimitSettings({limitMode:'manual',manualLimitMinor:50000,fallbackEndDate:null,applyToday:true,date:TODAY,expectedRevision:revision})
      : await store.addExpectation({date:'2026-09-22',title:'Expected',amountMinor:100,expectedRevision:revision});
    assert.equal(result.ok,true);
    assert.equal(result.horizonMissing,false);
    assert.equal(storage.writes.length,before+1);
    const restarted=buildStore(storage);await restarted.load();
    assert.equal(model.allowanceFor(restarted.getSnapshot().snapshot,TODAY).amountMinor,kind==='settings'?50000:100000);
  }
});

test('round 2: monthly today, overdue and skipped entries stay actionable', () => {
  let snapshot=withSchedule(createEmptyFinanceSnapshot(NOW),{dayOfMonth:12});
  let rows=model.actionableMonthlyOccurrences(snapshot,TODAY);
  assert.deepEqual(rows.map(x=>[x.bucket,x.date]),[['today',TODAY],['future','2026-10-12']]);
  const skipped=model.skipMonthlyOccurrence(snapshot,{scheduleId:'schedule-1',date:TODAY,clock:clock()});
  assert.equal(skipped.ok,true);snapshot=skipped.snapshot;
  rows=model.actionableMonthlyOccurrences(snapshot,TODAY);
  assert.equal(rows.find(x=>x.date===TODAY).resolved.resolution,'skipped');
  assert.equal(model.actionableMonthlyOccurrences(snapshot,'2026-09-13').find(x=>x.date===TODAY).resolved.resolution,'skipped');
  const reopened=model.reopenMonthlyOccurrence(snapshot,{scheduleId:'schedule-1',date:TODAY,clock:clock()});
  assert.equal(reopened.ok,true);
  assert.equal(model.actionableMonthlyOccurrences(reopened.snapshot,'2026-09-13').find(x=>x.date===TODAY).bucket,'overdue');
});

test('round 2: two monthly schedules on the same date resolve independently', async () => {
  const {store}=await hydratingStore(base=>{
    const value=withSchedule(base,{dayOfMonth:12});
    return {...value,salarySchedules:[...value.salarySchedules,{...value.salarySchedules[0],id:'second'}]};
  });
  assert.equal((await store.receiveMonthlyOccurrence({scheduleId:'schedule-1',date:TODAY,amountMinor:10000,incomeDate:TODAY,expectedRevision:0})).ok,true);
  let snapshot=store.getSnapshot().snapshot;
  assert.equal(model.unresolvedMonthlyOccurrencesOn(snapshot,TODAY).length,1);
  assert.equal(model.unresolvedMonthlyOccurrencesOn(snapshot,TODAY)[0].scheduleId,'second');
  const income=snapshot.incomes[0];
  await store.deleteSchedule({id:'schedule-1',expectedRevision:snapshot.revision});
  snapshot=store.getSnapshot().snapshot;
  assert.equal(snapshot.incomes[0].id,income.id);
  assert.equal(snapshot.occurrenceResolutions[0].scheduleId,'schedule-1');
});

test('round 2: submit-time date survives midnight and explicit history stays explicit', async () => {
  let now=new Date(2026,8,12,23,59,59);
  const controller=createFinanceDayController({now:()=>now});
  const original=controller.current();
  now=new Date(2026,8,13,0,0,1);
  const today=controller.sample().today;
  assert.equal(today,'2026-09-13');
  for(const operation of ['addExpense','addIncome']) {
    for(const touched of [false,true]) {
      const storage=memoryStorage();const store=buildStore(storage,()=>now);await store.load();
      await store.setup(setupInput({limitMode:'manual',manualLimitMinor:50000}));
      const date=resolveSubmittedFinanceDate({originalDefaultDate:original,currentDraftDate:original,wasDateTouched:touched,nowLocalDate:today});
      assert.equal(date,touched?original:today);
      const result=await store[operation]({date,amountMinor:100,expectedRevision:store.getSnapshot().snapshot.revision});
      assert.equal(result.ok,true);
      assert.notEqual(model.allowanceFor(store.getSnapshot().snapshot,today),null);
      assert.equal(store.getSnapshot().snapshot[operation==='addExpense'?'expenses':'incomes'][0].date,date);
    }
  }
  const sheets=readFileSync(new URL('../src/features/finance/FinanceSheets.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(sheets,/parsedDate.date > today/);
  assert.match(sheets,/parsedDate.date > submittedToday/);
});

test('round 2: every sheet submit uses the captured revision and A cannot close B', async () => {
  const {store}=await storeWithHorizon();const registry=createSheetRegistry();
  const first=registry.open('expense',store.getSnapshot().snapshot.revision);
  await store.correctBalance({balanceMinor:300000,expectedRevision:first.revision});
  assert.deepEqual(await store.addExpense({date:TODAY,amountMinor:100,expectedRevision:first.revision}),{ok:false,reason:'stale'});
  registry.closeCurrent();const second=registry.open(null,store.getSnapshot().snapshot.revision);
  assert.equal(registry.close(first.instanceId),false);
  assert.equal(registry.current(),second);
  const screen=readFileSync(new URL('../src/features/finance/FinanceScreen.tsx',import.meta.url),'utf8');
  const sheets=screen.slice(screen.indexOf("{sheet.kind === 'expense-create'"));
  assert.doesNotMatch(sheets,/expectedRevision: revision/);
  assert.match(sheets,/expectedRevision: activeRevision/);
  assert.match(screen,/sheet.kind !== 'none'/);
});

test('round 2: malformed timestamp arrays are load-error, including before any write',async()=>{
  const snapshot=createEmptyFinanceSnapshot(NOW);snapshot.balanceUpdatedAt=[NOW];
  const raw=JSON.stringify(snapshot);
  assert.equal(parseFinanceSnapshot(raw).ok,false);
  const storage=memoryStorage({[FINANCE_STORAGE_KEY]:raw});const store=buildStore(storage);
  assert.equal(Object.isFrozen(store.getSnapshot()),true);
  assert.throws(()=>{store.getSnapshot().phase='ready';},TypeError);
  await store.load();assert.equal(store.getSnapshot().phase,'load-error');
  assert.equal(Object.isFrozen(store.getSnapshot()),true);
  assert.deepEqual(await store.correctBalance({balanceMinor:1,expectedRevision:0}),{ok:false,reason:'load-error'});
  assert.equal(storage.current(),raw);assert.equal(storage.writes.length,0);
});

test('round 2: form helpers preserve legacy text and untouched optional presence',async()=>{
  const {submittedText,submittedOptionalText}=await import('../src/features/finance/financeDay.ts');
  const {transferLegacyFinance}=await import('../src/features/finance/financeLegacyAdapter.ts');
  const note='  '+ 'n'.repeat(4100)+'  ',title='  '+ 't'.repeat(500)+'  ';
  const transferred=transferLegacyFinance({balance:10000,salarySchedules:[{id:'s',dayOfMonth:22,amount:100,title,createdAt:NOW}],expenses:[{id:'e',date:TODAY,amount:10,note,createdAt:NOW}],obligations:[{id:'o',kind:'debt',title,amount:100,note,completed:false,createdAt:NOW}]},{target:createEmptyFinanceSnapshot(NOW),source:'finance-state',transferId:'legacy-long',nowIso:NOW});
  assert.equal(transferred.ok,true);
  const storage=memoryStorage({[FINANCE_STORAGE_KEY]:serializeFinanceSnapshot(transferred.snapshot,NOW)});const store=buildStore(storage);await store.load();
  assert.equal(store.getSnapshot().phase,'ready');const revision=()=>store.getSnapshot().snapshot.revision;
  assert.equal((await store.editExpense({id:'e',date:TODAY,amountMinor:2000,note:submittedOptionalText(note,false,note),expectedRevision:revision()})).ok,true);
  assert.equal((await store.editSchedule({id:'s',dayOfMonth:22,expectedAmountMinor:20000,title:submittedText(title,false),active:true,expectedRevision:revision()})).ok,true);
  assert.equal((await store.editObligation({id:'o',kind:'debt',title:submittedText(title,false),amountMinor:20000,note:submittedOptionalText(note,false,note),reminderEnabled:false,expectedRevision:revision()})).ok,true);
  const reopened=buildStore(storage);await reopened.load();const saved=reopened.getSnapshot().snapshot;
  assert.equal(saved.expenses[0].note,note);assert.equal(saved.salarySchedules[0].title,title);assert.equal(saved.obligations[0].note,note);assert.equal(saved.obligations[0].title,title);
  assert.equal(submittedOptionalText('',false),undefined);assert.equal(submittedOptionalText('',false,''),'');
  const result=await store.editExpense({id:'e',date:TODAY,amountMinor:2000,note:submittedOptionalText(note+'changed',true,note),expectedRevision:revision()});assert.deepEqual(result,{ok:false,reason:'validation'});
});

// Execute the actual TSX form functions with host components and hooks mocked.
// Domain parsers/helpers remain production imports; this catches submit wiring,
// unlike testing the date helper with a hand-selected correct date alone.
async function formHarness(name, props) {
  const ts=(await import('typescript')).default;
  const money=await import('../src/features/finance/financeMoney.ts');
  const dates=await import('../src/features/finance/financeDates.ts');
  const day=await import('../src/features/finance/financeDay.ts');
  const types=await import('../src/types/finance.ts');
  const state=[];let cursor=0;
  const jsx=(type,props)=>({type,props});
  const tokens=new Proxy({}, {get:()=>1});
  const modules={
    react:{useState(initial){const index=cursor++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];}},
    'react/jsx-runtime':{jsx,jsxs:jsx},
    'react-native':{Pressable:'Pressable',View:'View',TextInput:'TextInput',ScrollView:'ScrollView',Modal:'Modal',KeyboardAvoidingView:'KeyboardAvoidingView',Platform:{OS:'ios'},StyleSheet:{create:x=>x}},
    'react-native-safe-area-context':{SafeAreaView:'SafeAreaView'},
    '@/components/AppText':{default:'AppText'},
    '@/theme':{colors:tokens,radius:tokens,spacing:tokens,touchTarget:44},
    '@/types/finance':types,'./financeMoney':money,'./financeDates':dates,'./financeDay':day,
  };
  function load(id){
    if(id in modules)return modules[id];
    assert.ok(['./FinanceForms','./FinanceSheets'].includes(id),id);
    const source=readFileSync(new URL(`../src/features/finance/${id.slice(2)}.tsx`,import.meta.url),'utf8');
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};new Function('require','exports',compiled)(load,exports);modules[id]=exports;return exports;
  }
  const component=load('./FinanceSheets')[name];
  return ()=>{cursor=0;return component(props);};
}

test('round 2: actual expense/income/receipt forms accept untouched new day before render refresh',async()=>{
  for(const name of ['FinanceExpenseSheet','FinanceIncomeSheet','FinanceReceiveSheet']) {
    let submitted=null;
    const render=await formHarness(name,{mode:'create',currency:'UAH',today:'2026-09-12',initial:{amountText:'10'},expectedText:'10',title:'Salary',busy:false,onCancel(){},async onSubmit(draft){submitted=draft;return {ok:true};}});
    const nativeDate=globalThis.Date;
    class FixedDate extends nativeDate {constructor(...args){super(...(args.length?args:[2026,8,13,0,0,1]));}}
    globalThis.Date=FixedDate;
    try {render().props.onPrimary();await new Promise(resolve=>setImmediate(resolve));}
    finally {globalThis.Date=nativeDate;}
    assert.equal(submitted?.date,'2026-09-13',name);
  }
});

test('round 2: actual obligation form preserves untouched long title/note',async()=>{
  const title='  '+ 't'.repeat(501)+'  ',note='  '+ 'n'.repeat(4101)+'  ';
  let submitted;
  const render=await formHarness('FinanceObligationSheet',{mode:'edit',currency:'UAH',initial:{kind:'debt',title,note,amountText:'20',reminderEnabled:false},busy:false,onCancel(){},async onSubmit(draft){submitted=draft;return {ok:true};}});
  render().props.onPrimary();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(submitted.title,title);assert.equal(submitted.note,note);
});

test('round 2: explicit first allowance starts at revision one, replacement advances it',async()=>{
  const {store,storage}=await hydratingStore(base=>withSchedule(base));
  const save=()=>store.saveLimitSettings({limitMode:'manual',manualLimitMinor:50000,fallbackEndDate:null,applyToday:true,date:TODAY,expectedRevision:store.getSnapshot().snapshot.revision});
  assert.equal((await save()).allowanceCreated,true);
  assert.equal(model.allowanceFor(store.getSnapshot().snapshot,TODAY).revision,1);
  assert.equal(storage.writes.length,1);
  assert.equal((await save()).allowanceCreated,false);
  assert.equal(model.allowanceFor(store.getSnapshot().snapshot,TODAY).revision,2);
});

test('final fixes: large safe expense and income replacement edits validate final totals',async()=>{
  for(const collection of ['expenses','incomes']) {
    const {store,storage}=await hydratingStore(base=>({...base,initialized:true,[collection]:Array.from({length:9},(_,i)=>({id:`row${i}`,date:TODAY,amountMinor:1e15,createdAt:NOW,...(collection==='expenses'?{balancePolicy:'applied'}:{})}))}));
    const command=collection==='expenses'?'editExpense':'editIncome';
    for(const metadata of [{note:'updated'},collection==='expenses'?{category:'food'}:{source:'salary'}]) {
      const before=store.getSnapshot().snapshot;
      const result=await store[command]({id:'row0',date:TODAY,amountMinor:1e15,...metadata,expectedRevision:before.revision});
      assert.equal(result.ok,true);
      assert.equal(store.getSnapshot().snapshot.balanceMinor,before.balanceMinor);
      assert.equal(collection==='expenses'?model.spentOn(store.getSnapshot().snapshot,TODAY):model.incomeOn(store.getSnapshot().snapshot,TODAY),9e15);
    }
    const before=storage.writes.length;
    assert.equal((await store[command]({id:'row0',date:'2026-09-11',amountMinor:1e15,expectedRevision:store.getSnapshot().snapshot.revision})).ok,true);
    const snapshot=store.getSnapshot().snapshot;
    const total=collection==='expenses'?model.spentOn:model.incomeOn;
    assert.equal(total(snapshot,TODAY),8e15);assert.equal(total(snapshot,'2026-09-11'),1e15);
    assert.equal(storage.writes.length,before+1);
  }
});

test('final fixes: genuinely unsafe replacement fails without write or publication',async()=>{
  for(const collection of ['expenses','incomes']) {
    const {store,storage}=await hydratingStore(base=>({...base,initialized:true,[collection]:Array.from({length:10},(_,i)=>({id:`row${i}`,date:TODAY,amountMinor:i===9?1:1e15,createdAt:NOW,...(collection==='expenses'?{balancePolicy:'applied'}:{})}))}));
    const before=store.getSnapshot(),count=storage.writes.length;
    const result=await store[collection==='expenses'?'editExpense':'editIncome']({id:'row9',date:TODAY,amountMinor:1e14,expectedRevision:before.snapshot.revision});
    assert.deepEqual(result,{ok:false,reason:'overflow'});assert.equal(store.getSnapshot(),before);assert.equal(storage.writes.length,count);
  }
});

test('final fixes: legacy text boundaries always produce valid V1 or contextual blockers',async()=>{
  const {PERSISTED_TEXT_LIMIT}=await import('../src/storage/financeStorage.ts');
  const {transferLegacyFinance}=await import('../src/features/finance/financeLegacyAdapter.ts');
  for(const [collection,field] of [['expenses','note'],['salarySchedules','title'],['obligations','title'],['obligations','note']]) {
    for(const excess of [0,1]) {
      const text=' '.padEnd(PERSISTED_TEXT_LIMIT+excess-1,'x')+' ';
      const source={balance:10,expenses:[{id:'e',date:TODAY,amount:1,createdAt:NOW}],salarySchedules:[{id:'s',title:'Salary',amount:0,dayOfMonth:12,createdAt:NOW}],obligations:[{id:'o',title:'Debt',amount:1,kind:'debt',completed:false,createdAt:NOW}]};
      source[collection][0][field]=text;
      const result=transferLegacyFinance(source,{target:createEmptyFinanceSnapshot(NOW),source:'finance-state',transferId:'limits',nowIso:NOW});
      if(excess) {
        assert.equal(result.ok,false);assert.equal('snapshot' in result,false);
        assert.ok(result.blockers.some(x=>x.includes('incompatible-persisted-text')&&x.includes(collection)&&x.includes(field)));
      } else {
        assert.equal(result.ok,true,JSON.stringify(result));
        const parsed=parseFinanceSnapshot(serializeFinanceSnapshot(result.snapshot,NOW));assert.equal(parsed.ok,true);
        assert.equal(parsed.snapshot[collection][0][field],text);
      }
      assert.equal(source[collection][0][field],text);
    }
  }
});

test('final fixes: successful legacy conversion enforces the entire V1 contract',async()=>{
  const {transferLegacyFinance}=await import('../src/features/finance/financeLegacyAdapter.ts');
  const source={balance:0,expenses:[],salarySchedules:[]};
  for(const transferId of ['valid','x'.repeat(121)]) {
    const result=transferLegacyFinance(source,{target:createEmptyFinanceSnapshot(NOW),source:'finance-state',transferId,nowIso:NOW});
    if(transferId==='valid') {assert.equal(result.ok,true);assert.equal(parseFinanceSnapshot(serializeFinanceSnapshot(result.snapshot,NOW)).ok,true);}
    else {assert.equal(result.ok,false);assert.match(result.blockers.join(','),/incompatible-v1/);}
  }
});

test('final fixes: actual zero legacy schedule form permits metadata edits but validates touched amount',async()=>{
  function find(node,predicate){if(!node)return null;if(Array.isArray(node)){for(const child of node){const hit=find(child,predicate);if(hit)return hit;}return null;}if(typeof node!=='object')return null;if(predicate(node))return node;return find(node.props?.children,predicate);}
  for(const change of ['title','active','day','zero','negative','positive']) {
    const {store}=await hydratingStore(base=>{const snapshot=withSchedule(base);return {...snapshot,salarySchedules:[{...snapshot.salarySchedules[0],expectedAmountMinor:0}]};});
    let submitted;
    const render=await formHarness('FinanceExpectationSheet',{mode:'edit',initialKind:'monthly',currency:'UAH',today:TODAY,initial:{title:'Salary',amountText:'0',dayOfMonth:22,active:true},busy:false,onCancel(){},async onSubmit(input){submitted=input;return await store.editSchedule({id:'schedule-1',...input.draft,expectedRevision:0});}});
    let tree=render();
    if(change==='title') find(tree,x=>x.props?.label==='Название').props.onChange('Renamed');
    else if(change==='active') find(tree,x=>x.props?.accessibilityRole==='switch').props.onPress();
    else if(change==='day') find(tree,x=>x.props?.label==='День месяца (1–31)').props.onChange('23');
    else find(tree,x=>x.props?.label==='Ожидаемая сумма').props.onChange(change==='zero'?'0':change==='negative'?'-1':'10');
    tree=render();tree.props.onPrimary();await new Promise(resolve=>setImmediate(resolve));
    if(change==='zero'||change==='negative') {assert.equal(submitted,undefined);assert.ok(render().props.errorText);continue;}
    assert.ok(submitted);const snapshot=store.getSnapshot().snapshot,schedule=snapshot.salarySchedules[0];
    assert.equal(schedule.expectedAmountMinor,change==='positive'?1000:0);
    if(change==='title')assert.equal(schedule.title,'Renamed');if(change==='active')assert.equal(schedule.active,false);if(change==='day')assert.equal(schedule.dayOfMonth,23);
    if(change!=='positive')assert.equal(model.nextExpectedIncomeDate(snapshot,TODAY),null);
    assert.equal(snapshot.balanceMinor,1_000_000);
  }
});

test('final fixes: domain rejects actively edited zero while preserving legacy zero',async()=>{
  const {store}=await hydratingStore(base=>{const snapshot=withSchedule(base);return {...snapshot,salarySchedules:[{...snapshot.salarySchedules[0],expectedAmountMinor:0}]};});
  const draft={id:'schedule-1',dayOfMonth:22,expectedAmountMinor:0,title:'Renamed',active:false,expectedRevision:0};
  assert.deepEqual(await store.editSchedule({...draft,amountChanged:true}),{ok:false,reason:'validation'});
  assert.equal((await store.editSchedule({...draft,amountChanged:false})).ok,true);
  assert.equal(store.getSnapshot().snapshot.salarySchedules[0].expectedAmountMinor,0);
});
