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
 assert.deepEqual(domain.projectNoteDepartmentVisibility(ctx('owner'),'project',true,['dept-crew','dept-sales','dept-sales']),{department_ids:['dept-crew','dept-sales'],department_access:'restricted'});
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

