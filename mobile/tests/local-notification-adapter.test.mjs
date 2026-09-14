import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as contract from '../src/services/notifications/localNotificationContract.ts';
import {createNotificationPermissionCoordinator} from '../src/services/notifications/notificationPermissionCoordinator.ts';
// Execute the actual adapter/facade with injected Expo calls, not a reimplementation.
function moduleFromFile(file, imports) {
  const source=readFileSync(new URL(`../src/services/notifications/${file}`,import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};vm.runInNewContext(compiled,{exports,require:(name)=>{assert.ok(name in imports,name);return imports[name]},Date,Promise,Set});return exports;
}
test('Single production Expo adapter preserves Calendar payload and carries Finance metadata through native readback',async()=>{
  const pending=[];let prompts=0;
  const expo={IosAuthorizationStatus:{AUTHORIZED:1,PROVISIONAL:2,EPHEMERAL:3,DENIED:4},SchedulableTriggerInputTypes:{DATE:'date'},
    getPermissionsAsync:async()=>({ios:{status:1}}),requestPermissionsAsync:async()=>{prompts++;return {ios:{status:1}}},
    getAllScheduledNotificationsAsync:async()=>pending,
    scheduleNotificationAsync:async r=>{pending.push({...r,trigger:{type:'date',timestamp:r.trigger.date.getTime()}});return r.identifier},
    cancelScheduledNotificationAsync:async id=>{pending.splice(pending.findIndex(p=>p.identifier===id),1)},
    setNotificationHandler:()=>{},addNotificationResponseReceivedListener:()=>{},getLastNotificationResponseAsync:async()=>null,clearLastNotificationResponseAsync:async()=>{}};
  const adapter=moduleFromFile('expoLocalNotifications.ts',{'expo-notifications':expo,'./localNotificationContract':contract,'./notificationPermissionCoordinator':{createNotificationPermissionCoordinator}});
  const calendar=moduleFromFile('expoCalendarNotifications.ts',{'./expoLocalNotifications':adapter,'./calendarNotificationContract':{NOTIFICATION_OWNER:'workazy-calendar-v1'}}).expoCalendarNotifications;
  const triggerAt=new Date('2026-10-01T10:00:00Z').getTime();
  await calendar.schedule({id:'workazy.calendar.v1:c:start',eventId:'c',kind:'start',fingerprint:'legacy',triggerAt,title:'Workazy',body:'Calendar'});
  const p=(await calendar.listPending())[0];assert.equal(p.identifier,'workazy.calendar.v1:c:start');assert.equal(p.data.owner,'workazy-calendar-v1');assert.equal(p.data.eventId,'c');assert.equal(p.data.kind,'start');assert.equal(p.data.fingerprint,'legacy');assert.equal(p.data.targetTriggerAt,triggerAt);assert.equal(p.triggerAt,triggerAt);assert.equal(typeof p.data.scheduledAt,'number');
  await adapter.expoLocalNotifications.schedule({id:'workazy.finance.v1:f:due',triggerAt,title:'Workazy',body:'Финансовое напоминание · Rent',data:{owner:'workazy-finance-v1',obligationId:'f',kind:'due',fingerprint:'finance',targetTriggerAt:triggerAt}});
  const f=(await adapter.expoLocalNotifications.listPending())[1];assert.equal(f.data.obligationId,'f');assert.equal(f.data.eventId,undefined);assert.equal(typeof f.data.scheduledAt,'number');
  await Promise.all([calendar.requestPermissions(),adapter.expoLocalNotifications.requestPermissions()]);assert.equal(prompts,1);
});
