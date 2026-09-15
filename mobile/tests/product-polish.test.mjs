import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { createOnboardingStore, ONBOARDING_KEY, onboardingVisible } from '../src/features/product/onboardingStore.ts';
import { createSettingsController, permissionLabel } from '../src/features/product/settingsController.ts';
import { onboardingPages, privacyParagraphs, SETTINGS_ROUTE } from '../src/features/product/productContent.ts';
import { createNotificationResponseRouter } from '../src/services/notifications/notificationResponseRouter.ts';
import { createCalendarNotificationNavigation, resolveCalendarTap } from '../src/services/notifications/calendarNotificationNavigation.ts';
const granted={granted:true,provisional:false,canAskAgain:true,status:'granted'};
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function memory(){const values=new Map([['journal','private text'],['finance','balance'],['plans','tasks']]);return {values,writes:[],fail:false,async getItem(k){return values.get(k)??null},async setItem(k,v){if(this.fail)throw Error('disk');this.writes.push(k);values.set(k,v)}}}
test('First launch is empty onboarding preference; no demo or domain writes',async()=>{const storage=memory();const store=createOnboardingStore(storage);await store.load();assert.equal(store.getSnapshot().completed,false);assert.equal(store.getSnapshot().phase,'ready');assert.deepEqual(storage.writes,[]);assert.equal(storage.values.size,3)});
test('Complete persists only onboarding and restart never shows it again',async()=>{const storage=memory();const store=createOnboardingStore(storage);await store.load();await store.finish();assert.deepEqual(storage.writes,[ONBOARDING_KEY]);assert.equal(storage.values.get('finance'),'balance');assert.equal(storage.values.get('journal'),'private text');const restart=createOnboardingStore(storage);await restart.load();assert.equal(restart.getSnapshot().completed,true);assert.equal(restart.getSnapshot().replay,false)});
test('Completion waits for durable write and duplicate taps write once',async()=>{const gate=deferred();let calls=0;const store=createOnboardingStore({getItem:async()=>null,setItem:async()=>{calls++;await gate.promise}});await store.load();const done=store.finish();await store.finish();assert.equal(store.getSnapshot().completed,false);assert.equal(store.getSnapshot().saving,true);gate.resolve();await done;assert.equal(calls,1);assert.equal(store.getSnapshot().completed,true)});
test('Failed onboarding completion preserves first-launch UI and retries',async()=>{const storage=memory();storage.fail=true;const store=createOnboardingStore(storage);await store.load();await store.finish();assert.equal(store.getSnapshot().completed,false);assert.ok(store.getSnapshot().error);storage.fail=false;await store.finish();assert.equal(store.getSnapshot().completed,true);assert.equal(store.getSnapshot().error,null)});
test('Replay closes without any writes or resetting completion/domain data',async()=>{const storage=memory();const store=createOnboardingStore(storage);await store.load();await store.finish();const before=[...storage.values];store.replay();assert.equal(store.getSnapshot().replay,true);await store.finish();assert.equal(store.getSnapshot().replay,false);assert.equal(store.getSnapshot().completed,true);assert.deepEqual([...storage.values],before);assert.equal(storage.writes.length,1)});
for(const raw of ['broken','{"version":2,"completed":true}','{"version":1,"completed":"yes"}','{"version":1,"completed":true,"extra":1}'])test('Bad onboarding preference preserved '+raw,async()=>{const storage=memory();storage.values.set(ONBOARDING_KEY,raw);const store=createOnboardingStore(storage);await store.load();await store.finish();assert.equal(store.getSnapshot().phase,'load-error');assert.equal(storage.values.get(ONBOARDING_KEY),raw);assert.deepEqual(storage.writes,[])});
test('Onboarding read error retries without clearing data',async()=>{const storage=memory();let fail=true;const store=createOnboardingStore({...storage,getItem:async()=>{if(fail)throw Error('disk');return null}});await store.load();assert.equal(store.getSnapshot().phase,'load-error');fail=false;await store.load();assert.equal(store.getSnapshot().phase,'ready')});
test('Settings reads permission without prompting; denied and provisional honest',async()=>{let prompts=0;let permission={...granted,granted:false,canAskAgain:false,status:'denied'};const controller=createSettingsController({read:async()=>permission,request:async()=>{prompts++;return granted},openSettings:async()=>{}});await controller.refresh();assert.equal(prompts,0);assert.match(permissionLabel(controller.getSnapshot().permission),/выключены/);await controller.request();assert.equal(prompts,1);permission={...granted,provisional:true};await controller.refresh();assert.match(permissionLabel(controller.getSnapshot().permission),/тихая/);assert.doesNotMatch(permissionLabel(permission),/запланировано/)});
test('Settings stale read cannot overwrite explicit permission result',async()=>{const gate=deferred();const controller=createSettingsController({read:async()=>{await gate.promise;return {...granted,granted:false}},request:async()=>granted,openSettings:async()=>{}});const old=controller.refresh();await controller.request();gate.resolve();await old;assert.equal(controller.getSnapshot().permission.granted,true)});
test('Settings permission/read and system-settings errors are visible and retryable',async()=>{let fail=true;const controller=createSettingsController({read:async()=>{if(fail)throw Error();return granted},request:async()=>{throw Error()},openSettings:async()=>{throw Error()}});await controller.refresh();assert.ok(controller.getSnapshot().error);assert.equal(controller.getSnapshot().permission,null);fail=false;await controller.refresh();assert.equal(controller.getSnapshot().error,null);await controller.openSettings();assert.match(controller.getSnapshot().error,/настройки/);await controller.request();assert.ok(controller.getSnapshot().error)});
function response(domain,id='legacy:1',kind=domain==='calendar'?'start':'due'){return {actionIdentifier:'default',notification:{date:1,request:{identifier:`workazy.${domain}.v1:${id}:${kind}`,content:{data:{owner:`workazy-${domain}-v1`,kind,[domain==='calendar'?'eventId':'obligationId']:id}}}}}}
for(const exists of [true,false])for(const kind of ['start','advance'])test(`Calendar tap ${kind} hydrated live=${exists}`,async()=>{const gate=deferred(),opened=[];const dispatch=createNotificationResponseRouter({load:async()=>assert.fail('Finance hydration'),getState:()=>assert.fail(),openFinance:()=>assert.fail(),calendar:{load:()=>gate.promise,getState:()=>({phase:'ready',events:exists?[{id:'legacy:1'}]:[]}),open:id=>opened.push(id)}});const r=response('calendar','legacy:1',kind);const run=dispatch(r);assert.deepEqual(opened,[]);gate.resolve();await run;await dispatch(r);assert.deepEqual(opened,[exists?'legacy:1':null]);await dispatch({...r,notification:{...r.notification,date:2}});assert.equal(opened.length,2)});
test('New Finance tap supersedes delayed Calendar hydration and never crosses targets',async()=>{const gate=deferred(),opened=[];const dispatch=createNotificationResponseRouter({load:async()=>{},getState:()=>({phase:'ready',snapshot:{obligations:[{id:'f'}]}}),openFinance:id=>opened.push(['finance',id]),calendar:{load:()=>gate.promise,getState:()=>({phase:'ready',events:[{id:'c'}]}),open:id=>opened.push(['calendar',id])}});const old=dispatch(response('calendar','c'));await dispatch(response('finance','f'));gate.resolve();await old;assert.deepEqual(opened,[['finance','f']])});
test('Malformed/conflicting Calendar identity never hydrates either domain',async()=>{const fail=()=>assert.fail();const dispatch=createNotificationResponseRouter({load:fail,getState:fail,openFinance:fail,calendar:{load:fail,getState:fail,open:fail}});for(const change of [{identifier:'workazy.calendar.v1:wrong:start'},{content:{data:{owner:'foreign',eventId:'legacy:1',kind:'start'}}}]){const r=response('calendar');Object.assign(r.notification.request,change);await dispatch(r)}});
test('Calendar target waits for open draft, rereads deleted/moved entity, protects newer intent',()=>{const nav=createCalendarNotificationNavigation();nav.target('a');const old=nav.getSnapshot();assert.equal(resolveCalendarTap(old,'ready',true,[{id:'a',date:'2026-01-01'}]).consume,false);assert.equal(resolveCalendarTap(old,'load-error',false,[]).consume,false);assert.equal(resolveCalendarTap(old,'ready',false,[]).event,null);assert.equal(resolveCalendarTap(old,'ready',false,[{id:'a',date:'2026-02-01'}]).event.date,'2026-02-01');nav.target('b');nav.clear(old.token);assert.equal(nav.getSnapshot().eventId,'b');nav.clear(nav.getSnapshot().token);assert.equal(nav.getSnapshot(),null)});
function renderModule(path,imports){const source=readFileSync(new URL(path,import.meta.url),'utf8');const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const exports={};vm.runInNewContext(code,{exports,require:name=>{if(name==='react/jsx-runtime')return jsx;assert.ok(name in imports,name);return imports[name]}});return exports.default}
const theme={colors:{},radius:{},spacing:{},touchTarget:44};const native={Pressable:'Pressable',StyleSheet:{create:x=>x,hairlineWidth:1}};
test('Actual Settings icon navigates to stack route with accessible 44pt control',()=>{const routes=[];const Button=renderModule('../src/features/product/SettingsButton.tsx',{'@expo/vector-icons':{Ionicons:'Icon'},'expo-router':{router:{navigate:r=>routes.push(r)}},'react-native':native,'@/theme':theme,'./productContent':{SETTINGS_ROUTE}});const element=Button();assert.equal(element.props.accessibilityLabel,'Настройки');assert.equal(element.props.accessibilityRole,'button');element.props.onPress();assert.deepEqual(routes,['/settings']);assert.equal(element.props.style({pressed:false})[0].minHeight,44)});
test('Actual reusable product action exposes role/disabled state and flexible touch target',()=>{const Button=renderModule('../src/components/ProductButton.tsx',{'react-native':native,'./AppText':{default:'Text'},'@/theme':theme});const element=Button({label:'Продолжить',onPress:()=>{},disabled:true});assert.equal(element.props.accessibilityLabel,'Продолжить');assert.equal(element.props.accessibilityState.disabled,true);assert.equal(element.props.disabled,true);assert.equal(element.props.style({pressed:false})[0].minHeight,44)});
test('Onboarding is four short pages without sample data or unsupported privacy guarantees',()=>{assert.equal(onboardingPages.length,4);assert.ok(onboardingPages.every(p=>p.title.length<40&&p.body.length<220));assert.doesNotMatch(privacyParagraphs.join(' '),/end-to-end|сквозн|никогда не получаем/)});

test('Corrupt onboarding cannot lock the user out of their data; session bypass and replay never overwrite bytes',async()=>{
  const storage=memory();storage.values.set(ONBOARDING_KEY,'broken');const store=createOnboardingStore(storage);
  assert.equal(onboardingVisible(store.getSnapshot()),true);await store.load();store.dismissError();assert.equal(onboardingVisible(store.getSnapshot()),false);
  store.replay();assert.equal(onboardingVisible(store.getSnapshot()),true);await store.finish();assert.equal(onboardingVisible(store.getSnapshot()),false);
  assert.equal(storage.values.get(ONBOARDING_KEY),'broken');assert.deepEqual(storage.writes,[]);
  const restart=createOnboardingStore(storage);await restart.load();assert.equal(onboardingVisible(restart.getSnapshot()),true);
});

test('Actual root lifecycle defers cold tap through onboarding then handles warm Calendar tap',async()=>{
  const source=readFileSync(new URL('../src/services/notifications/useLocalNotificationLifecycle.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  let onboard={phase:'ready',completed:false,dismissed:false,replay:false,saving:false,error:null};
  let cursor=0;const refs=[];let effects=[];let receive;let starts=0;let prompts=0;const routes=[],targets=[];
  const cold=deferred();const calendarNav=createCalendarNotificationNavigation();
  const imports={
    react:{useCallback:fn=>fn,useRef:value=>{const i=cursor++;return refs[i]??(refs[i]={current:value})},useEffect:fn=>effects.push(fn),useSyncExternalStore:(_s,get)=>get()},
    '@/features/product/onboardingStore':{onboardingVisible},
    '@/features/product/productRuntime':{onboardingStore:{subscribe:()=>()=>{},getSnapshot:()=>onboard}},
    'react-native':{AppState:{currentState:'active',addEventListener:()=>({remove(){}})}},
    'expo-router':{router:{navigate:route=>routes.push(route)},useRootNavigationState:()=>({key:'root'})},
    '@/features/calendar/useCalendarLifecycle':{calendarNotificationController:{setAppState(){},start(){},refreshPermission(){},requestReconcile(){},handlePeriodicTick(){}}},
    '@/features/calendar/useCalendarStore':{calendarStore:{load:async()=>{},getSnapshot:()=>({phase:'ready',events:[{id:'c'}]})}},
    '@/features/finance/useFinanceStore':{financeStore:{load:async()=>{},getSnapshot:()=>({phase:'ready',snapshot:{obligations:[{id:'f'}]}})}},
    './financeNotificationRuntime':{financeNotificationController:{start:()=>{starts++;return ()=>{}},request(){}}},
    './expoLocalNotifications':{registerForegroundNotificationHandler(){},notificationPermissions:{subscribe:()=>()=>{},request:()=>{prompts++}},notificationResponses:{subscribe:fn=>{receive=fn;return {remove(){}}},last:()=>cold.promise,clear:async()=>{}}},
    './notificationResponseRouter':{createNotificationResponseRouter},
    './financeNotificationNavigation':{financeNotificationNavigation:{target:id=>targets.push(id)}},
    './calendarNotificationNavigation':{calendarNotificationNavigation:calendarNav},
  };
  const exports={};vm.runInNewContext(code,{exports,require:name=>{assert.ok(name in imports,name);return imports[name]},setInterval:()=>1,clearInterval(){}});
  exports.useLocalNotificationLifecycle();effects[0]();const cleanup=effects[1]();
  cold.resolve(response('finance','f'));await new Promise(r=>setImmediate(r));assert.deepEqual(routes,[]);
  onboard={...onboard,completed:true};cursor=0;effects=[];exports.useLocalNotificationLifecycle();effects[0]();
  assert.deepEqual(routes,['/(tabs)/finance']);assert.deepEqual(targets,['f']);
  receive(response('calendar','c'));await new Promise(r=>setImmediate(r));
  assert.deepEqual(routes,['/(tabs)/finance','/(tabs)/calendar']);assert.equal(calendarNav.getSnapshot().eventId,'c');
  assert.equal(starts,1);assert.equal(prompts,0);cleanup();
});

test('Actual Finance delete control requires explicit confirmation and runs captured action once',()=>{
  let actions,calls=0;
  const Button=renderModule('../src/components/ConfirmDeleteButton.tsx',{'react-native':{...native,Alert:{alert:(_title,_body,buttons)=>{actions=buttons}}},'./AppText':{default:'Text'},'@/theme':theme});
  const element=Button({description:'Удалить обязательство',onConfirm:()=>{calls++}});
  assert.equal(element.props.accessibilityLabel,'Удалить');assert.equal(element.props.style.minHeight,44);
  element.props.onPress();assert.equal(calls,0);assert.equal(actions[0].style,'cancel');assert.equal(actions[0].onPress,undefined);
  assert.equal(actions[1].style,'destructive');actions[1].onPress();actions[1].onPress();assert.equal(calls,1);
});
