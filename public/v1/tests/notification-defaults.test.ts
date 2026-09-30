import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {NotificationGroup} from '../platform/notification_catalog.js';
let root='';
let defaults:typeof import('../platform/notifications/defaults.js');
let store:typeof import('../platform/notifications/store.js');
let contracts:typeof import('../platform/notifications/contracts.js');
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'notification-defaults-'));process.env.PLATFORM_STORAGE_ROOT=root;
 defaults=await import('../platform/notifications/defaults.js');store=await import('../platform/notifications/store.js');contracts=await import('../platform/notifications/contracts.js');
});
after(async()=>{await(await import('../platform/sql_store.js')).closeSqlStoresForTests();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const definition=(key:string,label=key)=>({key,label,description:'Fixture',category:'tasks',defaults:{in_app:true,push:false},...(key.startsWith('event.')?{event:key.slice(6)}:{})});
const catalog:NotificationGroup[]=[{id:'app',label:'Tasks',kind:'app',definitions:[definition('tasks'),definition('event.document.signed'),definition('event.payment.received')]}];

test('initialization snapshots selected definitions and keeps personal changes independent from updated defaults',async()=>{
 assert.equal(await defaults.readPersonalConfiguration('org','alice','default'),null);
 const alice=await defaults.ensurePersonalConfiguration('org','alice','default',catalog,{in_app:{'event.document.signed':true},email:{tasks:false}});
 assert.deepEqual(alice.catalog.flatMap(g=>g.definitions.map(d=>d.key)),['tasks','event.document.signed']);
 const edited=await defaults.patchPersonalConfiguration('org','alice','default',{revision:alice.revision,definitions:[{key:'tasks',label:'My tasks'}],remove_keys:['event.document.signed']});
 assert.ok(edited.removed_keys.includes('event.document.signed'));
 const rule=contracts.ruleSchema.parse({id:'default-signature',event:'document.signed',intent:'Signatures',source:'return {outputs:{}};',methods:['in_app'],subscribe:true});
 const adminKey='workflow.'+store.identity('default','personal-notification-rules','admin:'+rule.id);
 const seed=await defaults.saveOrganizationDefaults('org','admin',{revision:0,catalog,preferences:{email:{[adminKey]:true,tasks:true},in_app:{'event.document.signed':true}},rules:[rule]});
 const bob=await defaults.ensurePersonalConfiguration('org','bob','default',catalog,{email:{tasks:false}});
 assert.equal(bob.defaults_revision,seed.revision);assert.equal((bob.preferences.email as any).tasks,false);
 const bobKey='workflow.'+store.identity('default','personal-notification-rules','bob:'+rule.id);
 assert.equal((bob.preferences.email as any)[bobKey],true);assert.equal((bob.preferences.email as any)[adminKey],undefined);
 assert.equal((await store.listRules('org','bob'))[0]?.revision,1);
 await defaults.saveOrganizationDefaults('org','admin',{revision:1,catalog,preferences:{email:{tasks:false}},rules:[{...rule,source:'return {outputs:{in_app:{decision:"suppress"}}};'}]});
 assert.deepEqual(await defaults.ensurePersonalConfiguration('org','alice','default',catalog,{}),edited);
 assert.equal((await store.listRules('org','bob'))[0]?.source,rule.source);
 const newer=await defaults.ensurePersonalConfiguration('org','charlie','default',catalog,{});assert.equal(newer.defaults_revision,2);
 assert.notEqual((await store.listRules('org','charlie'))[0]?.source,rule.source);
 const observed=await defaults.addPersonalDefinition('org','alice','default','app','Tasks',definition('event.document.signed'));assert.deepEqual(observed,edited);
 await assert.rejects(()=>defaults.patchPersonalConfiguration('org','alice','default',{revision:1,remove_keys:['tasks']}),/revision conflict/);
 await assert.rejects(()=>defaults.patchPersonalConfiguration('org','alice','default',{revision:edited.revision,definitions:[{key:'unknown',label:'Not mine'}]}),/personal configuration/);
});

test('default rules only clone authorized subscribable events and preserve existing programs and tombstones',async()=>{
 const mk=(id:string,event:string,methods=['in_app'])=>contracts.ruleSchema.parse({id,event,intent:id,source:'return {outputs:{}};',methods,subscribe:true});
 const rules=[mk('allowed','document.signed'),mk('denied','payment.received'),mk('channel','channels.message.posted'),mk('portal','document.signed',['customer_portal']),mk('deleted','document.signed')];
 await defaults.saveOrganizationDefaults('restricted','admin',{revision:0,catalog,preferences:{},rules});
 await store.saveRule('restricted','user',{...rules[0],source:'return {outputs:{in_app:{decision:"suppress"}}};'});
 await store.saveRule('restricted','user',rules[4]);await store.deleteRule('restricted','user','deleted',1);
 const authorized:NotificationGroup[]=[{id:'documents',label:'Documents',kind:'app',definitions:[definition('event.document.signed'),definition('event.channels.message.posted')]}];
 await defaults.ensurePersonalConfiguration('restricted','user','default',authorized,{});
 const saved=await store.listRules('restricted','user');assert.deepEqual(saved.map(rule=>rule.id),['allowed']);assert.match(saved[0]!.source,/suppress/);
});

test('live locks are independently versioned and do not rewrite personal snapshots',async()=>{
 const before=await defaults.readPersonalConfiguration('org','alice','default');
 assert.deepEqual(await defaults.readNotificationLocks('org'),{revision:0,locks:{}});
 const locked=await defaults.saveNotificationLocks('org','admin',{revision:0,locks:{tasks:{mode:'full',definition:definition('tasks'),preferences:{in_app:true}}}});
 assert.equal(locked.revision,1);assert.equal(locked.locks.tasks?.mode,'full');
 assert.deepEqual(await defaults.readPersonalConfiguration('org','alice','default'),before);
 await assert.rejects(()=>defaults.saveNotificationLocks('org','admin',{revision:0,locks:{}}),/revision conflict/);
 const unlocked=await defaults.saveNotificationLocks('org','admin',{revision:1,locks:{}});assert.deepEqual(unlocked.locks,{});
});

test('starting method defaults are materialized once, including newly observed definitions',async()=>{
 const initial=await defaults.ensurePersonalConfiguration('materialized','user','default',catalog,{in_app_sound:{tasks:false}});
 assert.equal((initial.preferences.toast as any)?.tasks,undefined);
 assert.equal((initial.preferences.in_app as any).tasks,true);assert.equal((initial.preferences.push as any).tasks,false);assert.equal((initial.preferences.audio as any).tasks,false);
 const changedCatalog=[{...catalog[0]!,definitions:[{...definition('tasks'),defaults:{in_app:false,push:true}}]}];
 assert.deepEqual(await defaults.ensurePersonalConfiguration('materialized','user','default',changedCatalog,{}),initial);
 const observed=await defaults.addPersonalDefinition('materialized','user','default','observed','Observed',{...definition('new-event'),defaults:{in_app:true,push:true},methods:['email']});
 assert.equal((observed.preferences.email as any)['new-event'],true);assert.equal((observed.preferences.push as any)['new-event'],true);
 const again=await defaults.addPersonalDefinition('materialized','user','default','observed','Observed',{...definition('new-event'),defaults:{in_app:false,push:false}});
 assert.deepEqual(again,observed);
});

test('explicit edits of required removal-locked rules supersede tombstones without admitting stale repair revisions',async()=>{
 const rule=contracts.ruleSchema.parse({id:'required',event:'document.signed',intent:'Required',source:'return {outputs:{}};',methods:['in_app'],subscribe:true});
 const first=await store.saveRule('required-org','user',rule);await store.deleteRule('required-org','user',rule.id,first.revision);
 const policy=await defaults.saveNotificationLocks('required-org','admin',{revision:0,locks:{'rule:required':{mode:'removal',rule:{...rule,revision:1}}}});
 const restored=await store.savePersonalRemovalLockRule('required-org','user',{...rule,revision:1,quiet_exempt_methods:['in_app']},policy.revision);
 assert.equal(restored.revision,3);
 await assert.rejects(()=>store.saveRule('required-org','user',{...rule,revision:1}),/revision conflict/);
 const changed=await store.saveRule('required-org','user',{...restored,title:'My required notification'});assert.equal(changed.revision,4);
 await store.deleteRule('required-org','user',rule.id,changed.revision);
 await defaults.saveNotificationLocks('required-org','admin',{revision:policy.revision,locks:{'rule:required':{mode:'full',rule:{...rule,revision:1}}}});
 await assert.rejects(()=>store.savePersonalRemovalLockRule('required-org','user',{...rule,revision:1},policy.revision),/required notification changed/);
});

test('removed organization defaults stay removed on observation while explicit existing personal selections survive',async()=>{
 await defaults.saveOrganizationDefaults('removed-defaults','admin',{revision:0,catalog:[],preferences:{},rules:[],removed_keys:['tasks']});
 const personal=await defaults.ensurePersonalConfiguration('removed-defaults','new-user','default',catalog,{});
 assert.deepEqual(personal.removed_keys,['tasks']);assert.equal((personal.preferences.in_app as any).tasks,false);
 assert.deepEqual(await defaults.addPersonalDefinition('removed-defaults','new-user','default','app','Tasks',definition('tasks')),personal);
 const existing=await defaults.ensurePersonalConfiguration('removed-defaults','existing-user','default',catalog,{email:{tasks:true}});
 assert.deepEqual(existing.removed_keys,[]);assert.ok(existing.catalog.flatMap(group=>group.definitions).some(d=>d.key==='tasks'));assert.equal((existing.preferences.email as any).tasks,true);
 await defaults.saveOrganizationDefaults('filtered-defaults','admin',{revision:0,catalog,preferences:{in_app:{'event.payment.received':true}},rules:[]});
 const restricted=await defaults.ensurePersonalConfiguration('filtered-defaults','user','default',[{...catalog[0]!,definitions:[definition('tasks')]}],{});
 assert.deepEqual(restricted.catalog.flatMap(group=>group.definitions.map(d=>d.key)),['tasks']);
});
