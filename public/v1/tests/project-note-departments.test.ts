import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {PlatformAuthContext} from '../platform/auth.js';
let root:string,store:typeof import('../channels/storage.js'),domain:typeof import('../channels/service.js'),structure:any,channel:any;
const org='project-note-departments';
before(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'note-departments-'));
 Object.assign(process.env,{NODE_ENV:'test',FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'sqlite',FIRSTMEASURE_ARTIFACT_STORAGE:'local',LOG_LEVEL:'error',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),CHANNELS_STORAGE_ROOT:path.join(root,'channels'),WORKFORCE_STORAGE_ROOT:path.join(root,'workforce'),MESSAGING_STORAGE_ROOT:path.join(root,'messaging'),CALLS_STORAGE_ROOT:path.join(root,'calls'),PLATFORM_HEARTBEAT_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1',FIRSTMEASURE_STORAGE_ROOT:path.join(root,'firstmeasure'),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'firstmeasure','index.sqlite'),INTERNAL_STORAGE_ROOT:path.join(root,'internal'),PRICEBOOK_STORAGE_ROOT:path.join(root,'pricebook')});
 const platform=await import('../platform/storage.js');await platform.createOrganization({id:org});
 for(const id of ['owner','sales','crew','office'])await platform.upsertDocument(org,'users',{id,data:{name:id,status:'active'}});
 const {departmentCatalogSchema}=await import('../workforce/department-contracts.js');
 const catalog=departmentCatalogSchema.parse({departments:['sales','crew','office'].map(id=>({id:'dept-'+id,label:id,subject_keys:['organization_user:'+id]})),groups:[]});
 await platform.upsertDocument(org,'organization_departments',{id:'catalog',data:catalog});structure=await (await import('../workforce/organization-structure.js')).resolveOrganizationStructure(org);
 store=await import('../channels/storage.js');domain=await import('../channels/service.js');channel=await store.createChannelRecord({organization_id:org,type:'project',name:'Project notes',project_id:'project',created_by:'owner'});
});
after(async()=>{await store.closeChannelsDatabase();await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
function ctx(id:string){return {orgId:org,userId:id,branchId:'default',identity:{preferences:{}},organization:{},role:id==='owner'?'owner':'member',user:{},permissions:{view_projects:true,send_channel_messages:true,...(id==='owner'?{manage_company_settings:true}:{})},organizationStructure:structure,scopedAccessGrants:[],applicationAccess:{management:{enabled:true,permissions:{}},field:{enabled:false,permissions:{}}}} as unknown as PlatformAuthContext;}
test('note department selections reject unknown, foreign, unavailable and non-note targets',()=>{
 assert.deepEqual(domain.projectNoteDepartmentVisibility(ctx('owner'),'project',true,['dept-crew','dept-sales','dept-sales']),{department_ids:['dept-crew','dept-sales'],note_audience_crew:false,department_access:'restricted'});
 for(const id of ['dept-office','other-org','missing'])assert.throws(()=>domain.projectNoteDepartmentVisibility(ctx('sales'),'project',true,[id]));
 assert.throws(()=>domain.projectNoteDepartmentVisibility(ctx('owner'),'public',true,['dept-sales']));assert.throws(()=>domain.projectNoteDepartmentVisibility(ctx('owner'),'project',false,['dept-sales']));
 assert.equal(domain.projectNoteDepartmentVisibility(ctx('owner'),'project',true,undefined),undefined);
});
test('department notes and replies remain private across reads, mentions and realtime',async()=>{
 const posted=await domain.postMessage(ctx('owner'),channel.id,{text:'Crew and sales only',project_note:true,department_ids:['dept-crew','dept-sales'],mention_users:[{id:'office',name:'office'}]});const id=String(posted.message!.id);
 for(const person of ['sales','crew'])assert.ok((await domain.listMessages(ctx(person),channel.id,{view:'notes'})).messages.some(m=>m.id===id));
 assert.ok(!(await domain.listMessages(ctx('office'),channel.id,{view:'notes'})).messages.some(m=>m.id===id));await assert.rejects(()=>domain.listThread(ctx('office'),id,{}));
 const reply=await domain.postMessage(ctx('crew'),channel.id,{text:'Restricted reply',parent_id:id,metadata:{department_access:'shared',department_ids:[]}});
 assert.equal((reply.message!.metadata as any).department_access,'restricted');assert.deepEqual((reply.message!.metadata as any).department_ids,['dept-crew','dept-sales']);
 const realtime=await import('../platform/realtime.js');const events=await realtime.pollRealtimeEvents(org,'office',0);
 const created=events.events.find((e:any)=>e.topic==='channels.message.created' && e.payload.message_id===id);assert.ok(created);assert.equal(created.payload.stub,true);assert.equal(created.payload.message,undefined);
 await domain.editMessage(ctx('owner'),id,{text:'Crew only',department_ids:['dept-crew']});assert.ok(!(await domain.listMessages(ctx('sales'),channel.id,{view:'notes'})).messages.some(m=>m.id===id));
 assert.deepEqual((await store.readMessageRecord(org,String(reply.message!.id)))?.metadata.department_ids,['dept-crew']);await assert.rejects(()=>domain.listThread(ctx('sales'),id,{}));assert.equal((await domain.listThread(ctx('crew'),id,{})).replies.length,1);
 await domain.editMessage(ctx('owner'),id,{text:'Shared with everyone',department_ids:[]});assert.ok((await domain.listMessages(ctx('office'),channel.id,{view:'notes'})).messages.some(m=>m.id===id));assert.equal((await store.readMessageRecord(org,String(reply.message!.id)))?.metadata.department_access,'shared');
});
test('text-only edits preserve legacy audiences and department metadata; non-authors cannot edit',async()=>{
 const posted=await domain.postMessage(ctx('owner'),channel.id,{text:'Original',project_note:true,audience:['crew'],department_ids:['dept-crew']});const id=String(posted.message!.id);
 await assert.rejects(()=>domain.editMessage(ctx('crew'),id,{text:'Not mine',department_ids:[]}));await domain.editMessage(ctx('owner'),id,{text:'Changed'});
 const saved=await store.readMessageRecord(org,id);assert.deepEqual(saved?.audience,['crew']);assert.deepEqual(saved?.metadata.department_ids,['dept-crew']);assert.equal(saved?.metadata.department_access,'restricted');
});


test('crew is a field-user audience independent of department membership, combined by union',async()=>{
 const crewCtx=ctx('office');crewCtx.applicationAccess.field!.enabled=true;
 const posted=await domain.postMessage(ctx('owner'),channel.id,{text:'Sales or field crew',project_note:true,department_ids:['dept-sales'],include_crew:true});const id=String(posted.message!.id);
 assert.ok((await domain.listMessages(ctx('sales'),channel.id,{view:'notes'})).messages.some(m=>m.id===id));
 assert.ok((await domain.listMessages(crewCtx,channel.id,{view:'notes'})).messages.some(m=>m.id===id));
 assert.ok(!(await domain.listMessages(ctx('office'),channel.id,{view:'notes'})).messages.some(m=>m.id===id));
 const reply=await domain.postMessage(crewCtx,channel.id,{text:'Field reply',parent_id:id});assert.equal((reply.message!.metadata as any).note_audience_crew,true);
 await domain.updateMessageVisibility(ctx('owner'),id,{department_ids:[],include_crew:true,audience:[]});
 assert.ok(!(await domain.listMessages(ctx('sales'),channel.id,{view:'notes'})).messages.some(m=>m.id===id));
 assert.ok((await domain.listMessages(crewCtx,channel.id,{view:'notes'})).messages.some(m=>m.id===id));
});
test('visibility-only updates preserve the latest text, edit timestamp and text revision history',async()=>{
 const posted=await domain.postMessage(ctx('owner'),channel.id,{text:'Original',project_note:true,department_ids:[]});const id=String(posted.message!.id);
 await domain.updateMessageVisibility(ctx('owner'),id,{department_ids:['dept-sales'],include_crew:false,audience:[]});
 assert.equal((await store.readMessageRecord(org,id))?.edited_at,null);assert.equal((await store.listMessageRevisions(id)).length,0);
 await domain.editMessage(ctx('owner'),id,{text:'Changed on another screen'});const before=(await store.readMessageRecord(org,id))!;
 await domain.updateMessageVisibility(ctx('owner'),id,{department_ids:['dept-crew'],include_crew:false,audience:[]});const after=(await store.readMessageRecord(org,id))!;
 assert.equal(after.text,before.text);assert.equal(after.edited_at,before.edited_at);assert.equal((await store.listMessageRevisions(id)).length,1);
 await assert.rejects(()=>domain.updateMessageVisibility(ctx('crew'),id,{department_ids:[]}));
 const reply=await domain.postMessage(ctx('crew'),channel.id,{text:'Legacy reply',parent_id:id});await store.getChannelsDatabase().prepare('UPDATE messages SET audience_json = ? WHERE organization_id = ? AND id = ?').run(JSON.stringify(['crew']),org,String(reply.message!.id));
 await domain.updateMessageVisibility(ctx('owner'),id,{department_ids:['dept-sales'],include_crew:false,audience:[]});assert.deepEqual((await store.readMessageRecord(org,String(reply.message!.id)))?.audience,[]);assert.equal((await domain.listThread(ctx('sales'),id,{})).replies.length,1);
});
test('authorized readers can see archived note text; ordinary deleted messages remain tombstones',async()=>{
 const posted=await domain.postMessage(ctx('owner'),channel.id,{text:'Retained archive text',project_note:true,department_ids:['dept-sales']});const id=String(posted.message!.id);
 await domain.deleteMessage(ctx('owner'),id);
 const readable=(await domain.listMessages(ctx('sales'),channel.id,{view:'notes'})).messages.find(m=>m.id===id)!;assert.equal(readable.text,'Retained archive text');assert.equal((readable.metadata as any).project_note,true);assert.ok(readable.deleted_at);
 assert.ok(!(await domain.listMessages(ctx('office'),channel.id,{view:'notes'})).messages.some(m=>m.id===id));
 const row=(await store.readMessageRecord(org,id))!;assert.equal((await domain.hydrateMessages(ctx('office'),channel,[row]))[0]?.text,'');
 const ordinary=await domain.postMessage(ctx('owner'),channel.id,{text:'Deleted channel message'});const plainId=String(ordinary.message!.id);await domain.deleteMessage(ctx('owner'),plainId);
 assert.equal((await domain.hydrateMessages(ctx('owner'),channel,[(await store.readMessageRecord(org,plainId))!]))[0]?.text,'');
 await assert.rejects(()=>domain.updateMessageVisibility(ctx('owner'),id,{department_ids:[]}));
});

test('note reply counts exclude archives and correct historical counts without a migration',async()=>{
 const posted=await domain.postMessage(ctx('owner'),channel.id,{text:'Count replies',project_note:true,department_ids:['dept-sales']});const id=String(posted.message!.id);
 const a=await domain.postMessage(ctx('sales'),channel.id,{text:'First',parent_id:id}),b=await domain.postMessage(ctx('sales'),channel.id,{text:'Second',parent_id:id});
 assert.equal((await domain.listThread(ctx('sales'),id,{})).root!.reply_count,2);
 await domain.deleteMessage(ctx('sales'),String(a.message!.id));await store.getChannelsDatabase().prepare('UPDATE messages SET reply_count = 999 WHERE organization_id = ? AND id = ?').run(org,id);
 assert.equal((await domain.listMessages(ctx('sales'),channel.id,{view:'notes'})).messages.find(m=>m.id===id)?.reply_count,1);assert.equal((await domain.listThread(ctx('sales'),id,{})).root!.reply_count,1);
 await domain.restoreMessage(ctx('sales'),String(a.message!.id));assert.equal((await domain.listThread(ctx('sales'),id,{})).root!.reply_count,2);
 await domain.deleteMessage(ctx('sales'),String(a.message!.id));await domain.deleteMessage(ctx('sales'),String(b.message!.id));assert.equal((await domain.listThread(ctx('sales'),id,{})).root!.reply_count,0);
});
