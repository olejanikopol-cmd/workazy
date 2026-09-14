import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFinanceNotifications } from '../src/services/notifications/financeNotificationPlanner.ts';
import { financeOwnership, financeNotificationId, financePendingMatches } from '../src/services/notifications/financeNotificationContract.ts';
import { reconcileFinanceNotifications } from '../src/services/notifications/financeNotificationReconciler.ts';
import { createFinanceNotificationRegistry, parseFinanceNotificationRegistry, FINANCE_NOTIFICATION_STORAGE_KEY } from '../src/storage/financeNotificationStorage.ts';
import { localNotificationReconcileQueue } from '../src/services/notifications/localNotificationReconcileQueue.ts';
import { runCoordinatedReconcile } from '../src/services/notifications/calendarReconcileCoordinator.ts';
import { createFinanceNotificationController } from '../src/features/finance/financeNotificationController.ts';
import { createFinanceStore } from '../src/features/finance/financeStore.ts';
import { createNotificationPermissionCoordinator } from '../src/services/notifications/notificationPermissionCoordinator.ts';
import { createNotificationResponseRouter } from '../src/services/notifications/notificationResponseRouter.ts';
import { financeReminderLabel } from '../src/features/finance/financeNotificationPresentation.ts';
const NOW = new Date('2026-09-13T00:00:00Z');
const GRANTED = { granted: true, provisional: false, canAskAgain: true, status: 'granted' };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function obligation(patch = {}) { return { id: 'o1', kind: 'payment', title: 'Rent', amountMinor: 10000,
  dueDate: '2026-09-20', reminderTime: '09:00', reminderEnabled: true, completed: false, createdAt: NOW.toISOString(), ...patch }; }
function memory(raw = null) {
  const map = new Map(raw === null ? [] : [[FINANCE_NOTIFICATION_STORAGE_KEY, raw]]);
  return { map, writes: 0, failAt: Infinity,
    async getItem(k) { return map.get(k) ?? null; },
    async setItem(k, v) { this.writes++; if (this.writes === this.failAt) throw Error('disk'); map.set(k, v); } };
}
function fakeOS({ count = 0 } = {}) {
  const foreign = Array.from({length:count}, (_,i) => ({ identifier:`foreign-${i}`, triggerAt:NOW.getTime()+86400000,
    triggerShape:'absolute',contentTitle:'foreign',contentBody:'keep',data:null }));
  return { pending:structuredClone(foreign), foreign, permission:GRANTED, calls:[], cancels:[], max:count,
    failure:null, gate:null, reached:null, trace:[], promptCalls:0,
    async getPermissions() { if(this.failure==='permission')throw Error('permission');return this.permission; },
    async requestPermissions() { this.promptCalls++;this.permission=GRANTED;return GRANTED; },
    async listPending() { this.trace.push('list'); if(this.failure==='list')throw Error('list');return structuredClone(this.pending); },
    async schedule(r) {
      this.calls.push(r.id);this.trace.push('schedule');
      this.reached?.resolve(); if(this.gate)await this.gate.promise;
      if(this.failure==='before')throw Error('before');
      const data = r.data ?? { owner:'workazy-calendar-v1',eventId:r.eventId,kind:r.kind,fingerprint:r.fingerprint,targetTriggerAt:r.triggerAt };
      this.pending.push({identifier:r.id,triggerAt:r.triggerAt,triggerShape:'absolute',contentTitle:r.title,
        contentBody:r.body,data:{...data,scheduledAt:NOW.getTime()}});
      this.max=Math.max(this.max,this.pending.length);
      if(this.failure==='readback')this.failure='list';
      if(this.failure==='after')throw Error('after');
      return r.id;
    },
    async cancel(id) { this.cancels.push(id);if(this.failure==='cancel')throw Error('cancel');
      this.pending=this.pending.filter((p)=>p.identifier!==id); },
  };
}
async function harness(options={}) {
  const os=options.os??fakeOS();const storage=options.storage??memory();
  const registry=createFinanceNotificationRegistry(storage,()=>NOW);await registry.load();
  const h={os,storage,registry,rows:options.rows??[obligation()],zone:'UTC',now:NOW,abort:false};
  h.run=()=>localNotificationReconcileQueue.run(()=>reconcileFinanceNotifications({obligations:h.rows,
    records:registry.getState().records,os,clock:()=>h.now,timeZone:h.zone,shouldAbort:()=>h.abort,persist:registry.persist}));
  return h;
}
for(const kind of ['payment','debt','receivable','purchase']) test(`Finance ${kind}: one future reminder, no sensitive fields, idempotent`,async()=>{
  const h=await harness({rows:[obligation({kind,note:'private'})]});
  assert.equal((await h.run()).status,'ok');assert.equal((await h.run()).status,'ok');
  assert.deepEqual(h.os.calls,[financeNotificationId('o1')]);
  const p=h.os.pending[0];assert.equal(p.contentBody,'Финансовое напоминание · Rent');
  assert.equal(p.data.amountMinor,undefined);assert.equal(p.data.note,undefined);assert.equal(p.data.eventId,undefined);
  assert.equal(h.registry.getState().records[0].status,'scheduled');
});
for(const patch of [{title:'Changed'},{reminderTime:'11:00'},{dueDate:'2026-09-22'}]) test(`Finance edit ${Object.keys(patch)[0]} replaces and verifies`,async()=>{
  const h=await harness();await h.run();const before=h.os.pending[0];h.rows=[obligation(patch)];
  assert.equal((await h.run()).status,'ok');assert.deepEqual(h.os.cancels,[financeNotificationId('o1')]);
  assert.equal(h.os.pending.length,1);assert.notEqual(h.os.pending[0].data.fingerprint,before.data.fingerprint);
});
for(const mode of ['disabled','completed','deleted','dateless']) test(`Finance ${mode} cancels only own reminder`,async()=>{
  const h=await harness();await h.run();h.rows=mode==='deleted'?[]:[obligation(mode==='completed'?{completed:true}:mode==='disabled'?{reminderEnabled:false}:{dueDate:undefined,reminderEnabled:false,reminderTime:undefined})];
  assert.equal((await h.run()).status,'ok');assert.equal(h.os.pending.length,0);
});
test('Finance planner: off, missing time, past, gap and fold/travel follow Calendar',()=>{
  assert.equal(planFinanceNotifications([obligation({reminderEnabled:false})],NOW,'UTC').requests.length,0);
  assert.equal(planFinanceNotifications([obligation({reminderTime:undefined})],NOW,'UTC').rows.o1.status,'unschedulable');
  assert.equal(planFinanceNotifications([obligation({dueDate:'2026-09-01'})],NOW,'UTC').rows.o1.status,'past');
  const march=new Date('2026-03-01T00:00:00Z');
  assert.equal(planFinanceNotifications([obligation({dueDate:'2026-03-29',reminderTime:'03:30'})],march,'Europe/Kyiv').rows.o1.status,'unschedulable');
  const fold=planFinanceNotifications([obligation({dueDate:'2026-10-25',reminderTime:'03:30'})],NOW,'Europe/Kyiv').requests[0];
  assert.equal(new Date(fold.triggerAt).toISOString(),'2026-10-25T00:30:00.000Z');
  assert.notEqual(fold.triggerAt,planFinanceNotifications([obligation({dueDate:'2026-10-25',reminderTime:'03:30'})],NOW,'UTC').requests[0].triggerAt);
});
test('Timezone travel replaces UTC instant; gap cancels old target and recovery restores',async()=>{
  const h=await harness({rows:[obligation({dueDate:'2026-03-29',reminderTime:'03:30'})]});h.now=new Date('2026-03-01T00:00:00Z');
  await h.run();h.zone='Europe/Kyiv';assert.equal((await h.run()).rows.o1.status,'unschedulable');assert.equal(h.os.pending.length,0);
  h.zone='UTC';assert.equal((await h.run()).rows.o1.status,'scheduled');
});
test('Denied permission keeps obligation intent; Settings return schedules, provisional stays quiet',async()=>{
  const h=await harness();const original=JSON.stringify(h.rows);h.os.permission={granted:false,provisional:false,canAskAgain:false,status:'denied'};
  assert.equal((await h.run()).rows.o1.status,'permission');assert.equal(JSON.stringify(h.rows),original);assert.equal(h.os.calls.length,0);
  h.os.permission={...GRANTED,provisional:true,status:'provisional'};
  const result=await h.run();assert.equal(result.rows.o1.status,'scheduled');assert.equal(result.permission.provisional,true);
});
test('Native missing with scheduled registry is recreated; registry missing adopts without duplicate',async()=>{
  const h=await harness();await h.run();h.os.pending=[];await h.run();assert.equal(h.os.calls.length,2);
  const fresh=await harness({os:h.os});await fresh.run();assert.equal(h.os.calls.length,2);assert.equal(fresh.registry.getState().records.length,1);
});
test('Registry write fails after native success: domain remains independent and restart adopts',async()=>{
  const storage=memory();storage.failAt=2;const h=await harness({storage});const before=JSON.stringify(h.rows);
  assert.equal((await h.run()).error,'registry-write');assert.equal(h.os.pending.length,1);assert.equal(JSON.stringify(h.rows),before);
  const restart=await harness({os:h.os,storage});assert.equal((await restart.run()).status,'ok');assert.equal(h.os.calls.length,1);
});
for(const failure of ['after','readback','before','permission','cancel']) test(`Finance ${failure} error remains retryable without money rollback`,async()=>{
  const h=await harness();if(failure==='cancel'){await h.run();h.rows=[];}h.os.failure=failure;
  const original=JSON.stringify(h.rows);const result=await h.run();assert.equal(result.status,'error');assert.equal(JSON.stringify(h.rows),original);
  h.os.failure=null;assert.equal((await h.run()).status,'ok');assert.ok(h.os.pending.length<=1);
});
test('48 foreign requests yield capacity; foreground after vacancy schedules',async()=>{
  const h=await harness({os:fakeOS({count:48})});assert.equal((await h.run()).rows.o1.status,'capacity');assert.equal(h.os.calls.length,0);
  h.os.pending.pop();assert.equal((await h.run()).rows.o1.status,'scheduled');assert.equal(h.os.max,48);assert.deepEqual(h.os.cancels,[]);
});
for(const financeFirst of [false,true]) test(`Shared queue: 47 foreign + Calendar + Finance, Finance first=${financeFirst}`,async()=>{
  const h=await harness({os:fakeOS({count:47})});h.os.gate=deferred();h.os.reached=deferred();
  const calendar=()=>runCoordinatedReconcile({getState:()=>({phase:'ready',events:[{id:'c',title:'Calendar',date:'2026-09-20',time:'10:00'}],registry:[]}),getRevision:()=>1,now:NOW,clock:()=>NOW,timeZone:()=> 'UTC',os:h.os,persistRegistry:async()=>{}});
  const first=financeFirst?h.run():calendar();await h.os.reached.promise;const trace=[...h.os.trace];
  const second=financeFirst?calendar():h.run();await new Promise((r)=>setImmediate(r));assert.deepEqual(h.os.trace,trace);
  h.os.gate.resolve();await Promise.all([first,second]);assert.equal(h.os.max,48);assert.equal(h.os.pending.length,48);
  assert.deepEqual(h.os.cancels,[]);assert.deepEqual(h.os.pending.slice(0,47),h.os.foreign);
});
test('Calendar and Finance cancel only their own requests when inventory contains both',async()=>{
  const h=await harness();await h.run();
  const calendar=()=>runCoordinatedReconcile({getState:()=>({phase:'ready',events:[],registry:[]}),getRevision:()=>1,now:NOW,clock:()=>NOW,timeZone:()=> 'UTC',os:h.os,persistRegistry:async()=>{}});
  await calendar();assert.equal(h.os.pending.length,1);assert.deepEqual(h.os.cancels,[]);
  h.os.pending.push({identifier:'workazy.calendar.v1:c:start',data:{owner:'workazy-calendar-v1'},contentTitle:'Calendar',contentBody:'',triggerAt:1,triggerShape:'absolute'});
  h.rows=[];await h.run();assert.equal(h.os.pending[0].identifier,'workazy.calendar.v1:c:start');
});
test('Strict Finance ownership rejects lookalikes, conflicting owner and Calendar; colons in valid IDs survive',()=>{
  const valid={identifier:financeNotificationId('legacy:colon'),data:{owner:'workazy-finance-v1',obligationId:'legacy:colon',kind:'due'}};
  assert.equal(financeOwnership(valid),'legacy:colon');
  for(const p of [{...valid,identifier:'workazy.calendar.v1:c:start'},{...valid,identifier:valid.identifier+'bad'},{...valid,data:{...valid.data,owner:'foreign'}},{...valid,data:null},{...valid,data:{...valid.data,kind:'start'}}])assert.equal(financeOwnership(p),null);
});
test('Finance native matcher rejects metadata/content/trigger mismatch and repetition',()=>{
  const r=planFinanceNotifications([obligation()],NOW,'UTC').requests[0];
  const p={identifier:r.id,data:{...r.data,scheduledAt:NOW.getTime()},triggerAt:r.triggerAt,triggerShape:'absolute',contentTitle:r.title,contentBody:r.body};
  assert.equal(financePendingMatches(p,r),true);
  for(const patch of [{identifier:'foreign'},{contentBody:'wrong'},{contentTitle:'wrong'},{triggerAt:r.triggerAt+3000},{triggerShape:'unknown'},{repeats:true},{data:{...p.data,targetTriggerAt:0}},{data:{...p.data,fingerprint:'wrong'}},{data:{...p.data,scheduledAt:NaN}}])assert.equal(financePendingMatches({...p,...patch},r),false);
});
test('Registry parser refuses corrupt/future/invalid fields; corrupt bytes persist and writes block',async()=>{
  for(const raw of ['broken','{}','{"version":2,"records":[],"savedAt":"2026-09-13T00:00:00.000Z"}']) {
    const storage=memory(raw);const registry=createFinanceNotificationRegistry(storage,()=>NOW);await registry.load();
    assert.equal(registry.getState().phase,'load-error');await assert.rejects(registry.persist([]));assert.equal(storage.map.get(FINANCE_NOTIFICATION_STORAGE_KEY),raw);
  }
  const h=await harness();await h.run();const raw=h.storage.map.get(FINANCE_NOTIFICATION_STORAGE_KEY);assert.ok(parseFinanceNotificationRegistry(raw));
  for(const patch of [{status:['scheduled']},{targetTriggerAt:null},{scheduledAt:'123'},{kind:'start'},{id:'foreign'},{extra:1}]) {
    const envelope=JSON.parse(raw);Object.assign(envelope.records[0],patch);assert.equal(parseFinanceNotificationRegistry(JSON.stringify(envelope)),null);
  }
});
async function realController({storage=memory(),os=fakeOS(), registryStorage=memory()}={}) {
  let id=0;const store=createFinanceStore({storage,now:()=>NOW,createId:(prefix)=>`${prefix}-${++id}`});await store.load();
  await store.setup({currency:'UAH',balanceMinor:100000,limitMode:'manual',manualLimitMinor:50000,fallbackEndDate:null,clock:{nowIso:NOW.toISOString(),today:'2026-09-13'}});
  const registry=createFinanceNotificationRegistry(registryStorage,()=>NOW);await registry.load();
  const controller=createFinanceNotificationController({getState:store.getSnapshot,subscribe:store.subscribe,load:store.load,registry,os,clock:()=>NOW,timeZone:()=> 'UTC'});
  return {store,registry,controller,os};
}
async function add(h,patch={}) { const row=obligation(patch);const {id,completed,createdAt,...draft}=row;void id;void completed;void createdAt;
  assert.equal((await h.store.addObligation({...draft,expectedRevision:h.store.getSnapshot().snapshot.revision})).ok,true);return h.store.getSnapshot().snapshot.obligations.at(-1).id; }
test('Controller: real Finance commit, complete/off reopen, configured future/past reopen never touch money',async()=>{
  const h=await realController();const id=await add(h);const money=()=>JSON.stringify([h.store.getSnapshot().snapshot.balanceMinor,h.store.getSnapshot().snapshot.allowances,h.store.getSnapshot().snapshot.expenses,h.store.getSnapshot().snapshot.incomes]);const before=money();
  await h.controller.request();assert.equal(h.os.pending.length,1);
  const complete=async(completed)=>h.store.setObligationCompleted({id,completed,expectedRevision:h.store.getSnapshot().snapshot.revision});
  await complete(true);await h.controller.request();assert.equal(h.os.pending.length,0);
  await complete(false);await h.controller.request();assert.equal(h.os.pending.length,0);
  for(const dueDate of ['2026-09-20','2026-09-01']) {
    await complete(true);const row=h.store.getSnapshot().snapshot.obligations[0];
    const {createdAt,completed,completedAt,updatedAt,...draft}=row;void createdAt;void completed;void completedAt;void updatedAt;
    await h.store.editObligation({...draft,dueDate,reminderEnabled:true,reminderTime:'09:00',expectedRevision:h.store.getSnapshot().snapshot.revision});
    await complete(false);await h.controller.request();assert.equal(h.os.pending.length,dueDate==='2026-09-20'?1:0);
  }
  assert.equal(money(),before);
});
for(const mutation of ['delete','edit']) test(`Controller: ${mutation} while scheduling is paused reruns latest committed state`,async()=>{
  const h=await realController();const id=await add(h);h.os.gate=deferred();h.os.reached=deferred();const run=h.controller.request();await h.os.reached.promise;
  if(mutation==='delete')await h.store.deleteObligation({id,expectedRevision:h.store.getSnapshot().snapshot.revision});
  else {const row=obligation({id,title:'Latest'});await h.store.editObligation({...row,expectedRevision:h.store.getSnapshot().snapshot.revision});}
  h.os.gate.resolve();await run;
  assert.equal(h.controller.getSnapshot().status,'ok');assert.equal(h.os.pending.length,mutation==='delete'?0:1);
  if(mutation==='edit')assert.equal(h.os.pending[0].contentBody,'Финансовое напоминание · Latest');
});
test('Controller: corrupt registry blocks OS mutations while real Finance remains editable',async()=>{
  const h=await realController({registryStorage:memory('broken')});await add(h);await h.controller.request();
  assert.equal(h.controller.getSnapshot().error,'registry-read');assert.equal(h.os.calls.length,0);assert.equal(h.os.cancels.length,0);assert.equal(h.store.getSnapshot().snapshot.obligations.length,1);
});
test('Controller startup subscribes to committed CRUD without opening Finance tab or prompting',async()=>{
  const h=await realController();const stop=h.controller.start();await h.controller.request();await add(h);await h.controller.request();
  assert.equal(h.os.pending.length,1);assert.equal(h.os.promptCalls,0);stop();
});
test('Shared permission single-flight and delayed read cannot overwrite completed prompt',async()=>{
  const readGate=deferred(),promptGate=deferred();let prompts=0;
  const permission=createNotificationPermissionCoordinator({read:async()=>{await readGate.promise;return {...GRANTED,granted:false,status:'undetermined'}},request:async()=>{prompts++;await promptGate.promise;return GRANTED}});
  const old=permission.read();const first=permission.request();const second=permission.request();assert.equal(first,second);
  promptGate.resolve();await first;readGate.resolve();assert.equal((await old).granted,true);assert.equal(prompts,1);
});
for(const present of [true,false]) test(`Finance tap routes live=${present} after hydration, deduplicates same delivery`,async()=>{
  const gate=deferred();const opened=[];const dispatch=createNotificationResponseRouter({load:()=>gate.promise,getState:()=>({phase:'ready',snapshot:{obligations:present?[obligation()]:[]}}),openFinance:(id)=>opened.push(id)});
  const response={actionIdentifier:'default',notification:{date:1,request:{identifier:financeNotificationId('o1'),content:{data:{owner:'workazy-finance-v1',kind:'due',obligationId:'o1'}}}}};
  const run=dispatch(response);assert.deepEqual(opened,[]);gate.resolve();await run;await dispatch(response);assert.deepEqual(opened,[present?'o1':null]);
  await dispatch({...response,notification:{...response.notification,date:2}});assert.equal(opened.length,2);
});
test('Calendar/foreign taps never enter Finance or hydrate it',async()=>{
  const dispatch=createNotificationResponseRouter({load:async()=>assert.fail('unexpected hydration'),getState:()=>assert.fail(),openFinance:()=>assert.fail()});
  for(const owner of ['workazy-calendar-v1','foreign'])await dispatch({actionIdentifier:'default',notification:{date:1,request:{identifier:'workazy.calendar.v1:c:start',content:{data:{owner,eventId:'c'}}}}});
});
test('UI never claims scheduled from intent, stale revision or provisional permission alone',()=>{
  const row=obligation();const state={status:'ok',error:null,permission:{...GRANTED,provisional:true},rows:{o1:{status:'scheduled'}},revision:2,running:false};
  assert.match(financeReminderLabel(row,2,state),/тихая доставка/);
  assert.doesNotMatch(financeReminderLabel(row,3,state),/Запланировано/);
  assert.doesNotMatch(financeReminderLabel(row,2,{...state,running:true}),/Запланировано/);
});

test('47 foreign + ambiguous Finance insertion consumes final slot and retry never duplicates',async()=>{
  const h=await harness({os:fakeOS({count:47}),rows:[obligation(),obligation({id:'o2'})]});h.os.failure='after';
  assert.equal((await h.run()).status,'error');assert.equal(h.os.calls.length,1);assert.equal(h.os.max,48);
  assert.deepEqual(h.os.pending.slice(0,47),h.os.foreign);h.os.failure=null;
  const result=await h.run();assert.equal(result.rows.o1.status,'scheduled');assert.equal(result.rows.o2.status,'capacity');assert.equal(h.os.calls.length,1);
});
test('Finance storage prewrite rejection prevents native scheduling and keeps prior registry',async()=>{
  const storage=memory();storage.failAt=1;const h=await harness({storage});assert.equal((await h.run()).error,'registry-write');
  assert.equal(h.os.calls.length,0);assert.deepEqual(h.registry.getState().records,[]);
});
test('Malformed Finance-lookalike pending is foreign occupancy and never cancelled',async()=>{
  const h=await harness();const foreign={identifier:'workazy.finance.v1:o1:due-extra',data:{owner:'workazy-finance-v1',kind:'due',obligationId:'o1'}};
  h.os.pending.push(foreign);await h.run();assert.ok(h.os.pending.some((p)=>p.identifier===foreign.identifier));assert.deepEqual(h.os.cancels,[]);
});
for(const phase of ['list','cancel','verification']) test(`Controller observes newer Finance revision during ${phase}`,async()=>{
  const h=await realController();const id=await add(h);if(phase==='cancel') { await h.controller.request();await h.store.deleteObligation({id,expectedRevision:h.store.getSnapshot().snapshot.revision}); }
  const reached=deferred(),release=deferred();let gated=false;
  if(phase==='cancel') {
    const cancel=h.os.cancel.bind(h.os);h.os.cancel=async key=>{if(!gated){gated=true;reached.resolve();await release.promise;}return cancel(key)};
  } else {
    const list=h.os.listPending.bind(h.os);h.os.listPending=async()=>{if(!gated&&(phase==='list'||h.os.calls.length)){gated=true;reached.resolve();await release.promise;}return list()};
  }
  const run=h.controller.request();await reached.promise;
  if(phase==='cancel')await add(h,{title:'New obligation'});
  else await h.store.deleteObligation({id,expectedRevision:h.store.getSnapshot().snapshot.revision});
  release.resolve();await run;assert.equal(h.controller.getSnapshot().status,'ok');
  assert.equal(h.os.pending.length,phase==='cancel'?1:0);
  if(phase==='cancel')assert.equal(h.os.pending[0].contentBody,'Финансовое напоминание · New obligation');
});
test('Finance controller explicit permission denial/Settings refresh never changes domain bytes',async()=>{
  const h=await realController();await add(h);const bytes=JSON.stringify(h.store.getSnapshot().snapshot);
  h.os.permission={granted:false,provisional:false,canAskAgain:false,status:'denied'};await h.controller.request();assert.equal(h.os.pending.length,0);
  h.os.permission=GRANTED;await h.controller.request();assert.equal(h.os.pending.length,1);assert.equal(JSON.stringify(h.store.getSnapshot().snapshot),bytes);
});
test('DST fold earlier occurrence already past never chooses later occurrence or immediate trigger',()=>{
  const now=new Date('2026-10-25T01:00:00Z');const result=planFinanceNotifications([obligation({dueDate:'2026-10-25',reminderTime:'03:30'})],now,'Europe/Kyiv');
  assert.equal(result.requests.length,0);assert.equal(result.rows.o1.status,'past');
});
test('Finance native interval verification keeps existing Calendar tolerances',()=>{
  const r=planFinanceNotifications([obligation()],NOW,'UTC').requests[0];
  const p={identifier:r.id,data:{...r.data,scheduledAt:NOW.getTime()},triggerAt:r.triggerAt-25000,triggerShape:'interval',contentTitle:r.title,contentBody:r.body};
  assert.equal(financePendingMatches(p,r),true);assert.equal(financePendingMatches({...p,triggerShape:'absolute'},r),false);
});

test('Owned orphan with corrupt target metadata persists unknown-target tombstone and converges safely',async()=>{
  const h=await harness();const r=planFinanceNotifications(h.rows,NOW,'UTC').requests[0];
  h.os.pending=[{identifier:r.id,data:{...r.data,targetTriggerAt:null},triggerAt:null,triggerShape:'unknown',contentTitle:r.title,contentBody:r.body}];
  assert.equal((await h.run()).status,'ok');assert.deepEqual(h.os.cancels,[r.id]);assert.equal(h.os.pending.length,1);assert.equal(h.registry.getState().records[0].status,'scheduled');
});
