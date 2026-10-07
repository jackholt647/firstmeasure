import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {PlatformAuthContext} from '../platform/auth.js';
let root:string,storage:typeof import('../platform/storage.js'),calls:typeof import('../comms/calls/storage.js'),service:typeof import('../comms/calls/service.js');
const org='department-communications';
let structure:any;
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'departments-comms-'));
  Object.assign(process.env,{NODE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),MESSAGING_STORAGE_ROOT:path.join(root,'messaging'),WORKFORCE_STORAGE_ROOT:path.join(root,'workforce'),CHANNELS_STORAGE_ROOT:path.join(root,'channels'),PLATFORM_HEARTBEAT_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1'});
  storage=await import('../platform/storage.js');await storage.createOrganization({id:org});
  for(const id of ['salesperson','producer'])await storage.upsertDocument(org,'users',{id,data:{name:id,status:'active'}});
  const {departmentCatalogSchema}=await import('../workforce/department-contracts.js');
  const catalog=departmentCatalogSchema.parse({departments:[{id:'sales',label:'Sales',subject_keys:['organization_user:salesperson']},{id:'production',label:'Production',subject_keys:['organization_user:producer']}],groups:[]});
  await storage.upsertDocument(org,'organization_departments',{id:'catalog',data:catalog});
  structure=await (await import('../workforce/organization-structure.js')).resolveOrganizationStructure(org);
  calls=await import('../comms/calls/storage.js');service=await import('../comms/calls/service.js');
  for(const [id,owner] of [['sales-call','salesperson'],['production-call','producer']])await calls.insertCall({id:id!,organization_id:org,branch_id:'default',owner_user_id:owner,mode:'external',direction:'outbound'});
});
after(async()=>{await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();await rm(root,{recursive:true,force:true});});
function viewer(){return {orgId:org,userId:'manager',role:'member',branchId:'default',permissions:{},organizationStructure:structure,scopedAccessGrants:[{scope:{kind:'department',id:'sales'},permissions:{view_comms:true,manage_communications:true}}],applicationAccess:{management:{enabled:true,permissions:{}}}} as unknown as PlatformAuthContext;}
test('department managers list and mutate only their calls; client internal filters cannot override scope',async()=>{
  const ctx=viewer();
  const filter=service.callListDepartmentFilter(ctx,{_department_ids:['production'],_include_shared:true});
  const result=await calls.listCalls(org,filter);
  assert.equal(result.total,1);assert.deepEqual(result.calls.map(c=>c.id),['sales-call']);
  assert.doesNotThrow(()=>service.requireCallAccess(ctx,result.calls[0]!,true));
  const other=await calls.readCall(org,'production-call');assert.throws(()=>service.requireCallAccess(ctx,other,true));
  assert.throws(()=>service.callListDepartmentFilter(ctx,{department_id:'production'}));
});
test('call attribution is captured rather than following subsequent department membership',async()=>{
  const original=await calls.readCall(org,'sales-call');assert.deepEqual(original.metadata.department_ids,['sales']);
  const doc=await storage.readDocument(org,'organization_departments','catalog');
  const data=structuredClone(doc.data) as any;data.departments[0].subject_keys=[];data.departments[1].subject_keys.push('organization_user:salesperson');
  await storage.upsertDocument(org,'organization_departments',{id:'catalog',data,expected_revision:doc.revision},{replace:true});
  const stored=await calls.readCall(org,'sales-call');assert.deepEqual(stored.metadata.department_ids,['sales']);
  const result=await calls.listCalls(org,{_department_ids:['sales']});assert.deepEqual(result.calls.map(c=>c.id),['sales-call']);
});
test('department mentions respect private channel access and default channels revoke removed members',async()=>{
  const channels=await import('../channels/storage.js'),domain=await import('../channels/service.js');
  const dept=await import('../channels/department-channels.js');
  const ctx={...viewer(),userId:'salesperson',permissions:{view_channels:true,send_channel_messages:true},organizationStructure:await (await import('../workforce/organization-structure.js')).resolveOrganizationStructure(org)};
  const channel=await channels.createChannelRecord({organization_id:org,type:'private',name:'restricted',created_by:'salesperson'});
  await channels.upsertChannelMember({organization_id:org,channel_id:channel.id,user_id:'salesperson',role:'owner'});
  const mentions=await domain.resolveMentionUsers(ctx,[{id:'department:production'}],channel.id);
  assert.deepEqual(mentions.map(m=>m.id),['salesperson']);
  await dept.syncDepartmentChannels(ctx);
  const production=await channels.findChannelByDmKey(org,'department:production');assert.ok(production);
  await domain.requireChannelAccess({...ctx,userId:'producer'},production.id);
  const doc=await storage.readDocument(org,'organization_departments','catalog'),data=structuredClone(doc.data) as any;
  data.departments[1].subject_keys=['organization_user:salesperson'];
  await storage.upsertDocument(org,'organization_departments',{id:'catalog',data,expected_revision:doc.revision},{replace:true});
  // A persisted channel membership is insufficient after department revocation.
  assert.ok(await channels.readChannelMember(production.id,'producer'));
  await assert.rejects(()=>domain.requireChannelAccess({...ctx,userId:'producer'},production.id));
  assert.deepEqual((await dept.effectiveChannelMembers(production)).map(m=>m.user_id),['salesperson']);
});

test('division call grants include descendant branch records without crossing siblings',async()=>{
  const context=viewer();
  context.organizationStructure=structuredClone(structure);
  context.organizationStructure!.catalog.divisions=[{id:'east',label:'East',kind:'Region',parent_id:'',branch_id:'',status:'active',subject_keys:[]},{id:'scranton',label:'Scranton',kind:'Branch',parent_id:'east',branch_id:'scranton',status:'active',subject_keys:[]},{id:'west',label:'West',kind:'Branch',parent_id:'',branch_id:'west',status:'active',subject_keys:[]}] as any;
  context.scopedAccessGrants=[{scope:{kind:'division',id:'east'},permissions:{view_comms:true,manage_communications:true}}];
  for(const branch of ['scranton','west'])await calls.insertCall({id:`branch-${branch}`,organization_id:org,branch_id:branch,mode:'external',direction:'outbound',metadata:{department_ids:[]}});
  const result=await calls.listCalls(org,service.callListDepartmentFilter(context,{_scoped_branch_ids:['west'],_allowed_branch_ids:['west']}));
  assert.deepEqual(result.calls.map(c=>c.id),['branch-scranton']);
  assert.doesNotThrow(()=>service.requireCallAccess(context,result.calls[0]!,true));
  assert.throws(()=>service.requireCallAccess(context,{...result.calls[0]!,branch_id:'west'}));
});

test('department denials override division call grants before count and pagination',async()=>{
  const context=viewer();context.organizationStructure=structuredClone(structure);
  context.organizationStructure!.catalog.divisions=[{id:'east',label:'East',parent_id:'',branch_id:'scranton',status:'active'}] as any;
  context.scopedAccessGrants=[{scope:{kind:'division',id:'east'},permissions:{view_comms:true}},{scope:{kind:'department',id:'sales'},permissions:{view_comms:false}}];
  await calls.insertCall({id:'denied-branch-sales',organization_id:org,branch_id:'scranton',mode:'external',direction:'outbound',metadata:{department_ids:['sales','production']}});
  const result=await calls.listCalls(org,service.callListDepartmentFilter(context,{},'view_comms'));
  assert.deepEqual(result.calls.map(c=>c.id),['branch-scranton']);assert.equal(result.total,1);
  context.permissions={view_comms:true};
  const global=await calls.listCalls(org,service.callListDepartmentFilter(context,{},'view_comms'));
  assert.ok(!global.calls.some(c=>c.id==='denied-branch-sales'||c.id==='sales-call'));
});
