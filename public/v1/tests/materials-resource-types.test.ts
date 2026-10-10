import {closePlatformFixtureStores,enableExpandedPlatformFixture} from './helpers/platform-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {PlatformAuthContext} from '../platform/auth.js';
test('organization resource types persist, enforce write permission and validate list foreign keys',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'material-types-'));Object.assign(process.env,{NODE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),FIRSTMEASURE_STORAGE_ROOT:path.join(root,'reports'),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite')});
 const storage=await import('../platform/storage.js'),types=await import('../materials/resource-types.js'),lists=await import('../materials/storage.js'),schema=await import('../materials/schemas.js');
 try{await storage.createOrganization({id:'org_types',name:'Resource types'});await storage.createOrganization({id:'org_other',name:'Other'});await storage.saveGlobal('org_types',{data:{app_flags:{platform:{expanded_access:true,materials:true}}}},{replace:false});await enableExpandedPlatformFixture('org_types',{'platform.materials':true,'platform.pricebook':true});await storage.upsertDocument('org_types','projects',{id:'project',data:{title:'Roof'}});
 const auth={orgId:'org_types',userId:'owner',role:'owner',permissions:{}} as PlatformAuthContext;
 assert.deepEqual((await types.listResourceTypes('org_types')).map(row=>row.id),['material','labor','equipment']);assert.equal((await storage.listDocuments('org_types',types.RESOURCE_TYPE_COLLECTION)).length,0,'Reads do not seed records');
 const created=await types.saveResourceType('org_types',{id:'resource_disposal',name:'',icon:'fa-truck',color:'#125634'},auth,true);assert.equal(created.name,'');assert.equal((await types.listResourceTypes('org_types')).length,4);assert.equal(await types.requireResourceType('org_types','resource_disposal'),'resource_disposal');
 await assert.rejects(()=>types.saveResourceType('org_types',{id:'resource_disposal',name:'Disposal',icon:'fa-truck',color:'#125634'},{...auth,orgId:'org_other'}),/management access/);await assert.rejects(()=>types.saveResourceType('org_types',{id:'resource_disposal',name:'Disposal',icon:'fa-truck',color:'#125634'},{...auth,role:'member',permissions:{manage_projects:false}}),/management access/);
 const updated=await types.saveResourceType('org_types',{id:'resource_disposal',name:'Disposal',icon:'fa-truck',color:'#125634',expected_revision:Number(created.revision)},auth);await assert.rejects(()=>types.saveResourceType('org_types',{id:'resource_disposal',name:'Stale',icon:'fa-truck',color:'#125634',expected_revision:Number(created.revision)},auth),/revision/i);assert.equal(updated.name,'Disposal');await assert.rejects(()=>types.requireResourceType('org_types','unregistered'),/registered/);
 assert.ok(schema.createMaterialListSchema.safeParse({resource_type:'resource_disposal'}).success);assert.equal(schema.createMaterialListSchema.safeParse({resource_type:'<script>'}).success,false);
 const list=await lists.createMaterialList('org_types','project',{title:'',resource_type:'resource_disposal',items:[],metadata:{placeholder_title:true}},auth);assert.equal(list.resource_type,'resource_disposal');assert.equal(list.title,'');const renamed=await lists.patchMaterialList('org_types',String(list.id),{title:'Dumpster',expected_revision:list.revision},auth);assert.equal(renamed.title,'Dumpster');await assert.rejects(()=>lists.createMaterialList('org_types','project',{resource_type:'unregistered'},auth),/registered/);
 }finally{await closePlatformFixtureStores();try{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){if(!['EBUSY','EPERM'].includes((error as NodeJS.ErrnoException).code||''))throw error;}}
});

