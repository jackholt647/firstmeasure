import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {PlatformAuthContext} from '../platform/auth.js';
let root:string,store:typeof import('../channels/storage.js'),domain:typeof import('../channels/service.js'),structure:any,channel:any;
const org='photo-comments';
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

async function media(id:string,metadata:Record<string,unknown>={}){
 const platform=await import('../platform/storage.js');
 await platform.storeMediaUpload(org,{id,ownerType:'project',ownerId:'project',fileName:id+'.jpg',contentType:'image/jpeg',bytes:Buffer.from('fixture'),metadata});
 return platform;
}
test('photo discussions import historical comments exactly once and isolate each photo from project notes',async()=>{
 const platform=await media('photo-a');await media('photo-b');
 await platform.saveMediaMarkupLayer(org,'photo-a','photo_comments',{comments:[{id:'old-1',text:'Earlier comment',author_name:'Former photographer',author_email:'former@example.com',created_at:'2026-09-01T00:00:00Z'},{id:'old-2',text:'Owner comment',author_id:'owner',created_at:'2026-09-02T00:00:00Z'}]});
 const photos=await import('../channels/photo-comments.js');
 const [a,repeated]=await Promise.all([photos.ensurePhotoDiscussion(ctx('owner'),'photo-a'),photos.ensurePhotoDiscussion(ctx('owner'),'photo-a')]);assert.equal(a.id,repeated.id);
 const b=await photos.ensurePhotoDiscussion(ctx('owner'),'photo-b');assert.notEqual(a.id,b.id);assert.notEqual(a.id,channel.id);
 let rows=(await domain.listMessages(ctx('owner'),String(a.id),{view:'all'})).messages;
 assert.equal(rows.length,2);assert.equal((rows[0]!.author as any).name,'Former photographer');assert.equal(rows[0]!.created_at,'2026-09-01T00:00:00Z');assert.equal(rows[0]!.can_edit,false);assert.equal(rows[1]!.can_edit,true);
 await photos.ensurePhotoDiscussion(ctx('crew'),'photo-a');assert.equal((await domain.listMessages(ctx('crew'),String(a.id),{view:'all'})).messages.length,2);
 assert.equal((await domain.listMessages(ctx('owner'),String(b.id),{view:'all'})).messages.length,0);assert.equal((await domain.listMessages(ctx('owner'),channel.id,{view:'notes'})).messages.length,0);
 assert.equal(((await platform.readMediaMarkupLayer(org,'photo-a','photo_comments'))!.data as any).comments instanceof Array,true);
 assert.ok(!(await domain.listChannelsForUser(ctx('owner'),{initialize:false})).some(row=>row.id===a.id));
 await assert.rejects(()=>photos.ensurePhotoDiscussion({...ctx('owner'),orgId:'other-org'},'photo-a'));
});
test('comments reuse Notes edits, audiences, replies, pins, archive counts and restoration',async()=>{
 const photos=await import('../channels/photo-comments.js');const a=await photos.ensurePhotoDiscussion(ctx('owner'),'photo-a');
 const posted=await domain.postMessage(ctx('owner'),String(a.id),{text:'**Rich comment**',project_note:true,department_ids:['dept-sales'],pin:true});const id=String(posted.message!.id);
 assert.ok(!(await domain.listMessages(ctx('office'),String(a.id),{view:'all'})).messages.some(row=>row.id===id));await assert.rejects(()=>domain.listThread(ctx('office'),id,{}));
 const reply=await domain.postMessage(ctx('sales'),String(a.id),{text:'Reply',parent_id:id});const rid=String(reply.message!.id);
 await assert.rejects(()=>domain.editMessage(ctx('sales'),id,{text:'Unauthorized edit'}));await domain.editMessage(ctx('owner'),id,{text:'Updated comment'});
 assert.equal((await store.listMessageRevisions(id)).length,1);assert.equal((await domain.pinnedMessages(ctx('owner'),String(a.id),'all')).some(row=>row.id===id),true);
 await domain.deleteMessage(ctx('sales'),rid);assert.equal((await domain.listMessages(ctx('owner'),String(a.id),{view:'all'})).messages.find(row=>row.id===id)!.reply_count,0);
 await domain.restoreMessage(ctx('sales'),rid);assert.equal((await domain.listMessages(ctx('owner'),String(a.id),{view:'all'})).messages.find(row=>row.id===id)!.reply_count,1);
 await domain.deleteMessage(ctx('owner'),id);assert.equal((await domain.listMessages(ctx('owner'),String(a.id),{view:'all'})).messages.find(row=>row.id===id)!.text,'Updated comment');await domain.restoreMessage(ctx('owner'),id);
 await domain.updateMessageVisibility(ctx('owner'),id,{department_ids:[],include_crew:false,audience:[]});assert.equal((await domain.listThread(ctx('office'),id,{})).replies.length,1);
 const shared=await domain.shareProjectNote(ctx('owner'),id);assert.equal(shared.message!.metadata && (shared.message!.metadata as any).project_note,true);assert.equal((await domain.listMessages(ctx('owner'),String(a.id),{view:'all'})).messages.some(row=>row.id===shared.message!.id),true);
 const realtime=await import('../platform/realtime.js');const events=await realtime.pollRealtimeEvents(org,'office',0);const event=events.events.find((row:any)=>row.topic==='channels.message.created'&&row.payload.message_id===id);assert.ok(event);assert.equal(event.payload.stub,true);assert.equal(event.payload.message,undefined);
});
test('media permissions are rechecked for existing discussions and cannot be swapped by channel managers',async()=>{
 const photos=await import('../channels/photo-comments.js');await media('private-photo',{department_access:'restricted',department_ids:['dept-sales']});
 const a=await photos.ensurePhotoDiscussion(ctx('sales'),'private-photo');await assert.rejects(()=>photos.ensurePhotoDiscussion(ctx('office'),'private-photo'));await assert.rejects(()=>domain.listMessages(ctx('office'),String(a.id),{view:'all'}));await assert.rejects(()=>domain.postMessage(ctx('office'),String(a.id),{text:'Denied',project_note:true}));
 const manager={...ctx('sales'),permissions:{...ctx('sales').permissions,manage_channels:true}};await assert.rejects(()=>domain.updateChannel(manager,String(a.id),{settings:{photo_media_id:'photo-a'}}));
 await assert.rejects(()=>domain.updateChannel({...ctx('owner'),permissions:{...ctx('owner').permissions,manage_channels:true}},channel.id,{settings:{photo_media_id:'photo-a'}}));
 await media('receipt',{source:'expense_receipt_upload',uploaded_by_user_id:'sales'});const receipt=await photos.ensurePhotoDiscussion(ctx('sales'),'receipt');await assert.rejects(()=>domain.postMessage(ctx('office'),String(receipt.id),{text:'Cannot edit another person receipt',project_note:true}));
});
