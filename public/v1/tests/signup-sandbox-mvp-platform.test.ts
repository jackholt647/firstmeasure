import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('the MVP platform workflow is FirstMeasure plus projects, contacts, feed and the project tabs and trays, without scheduling',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'fm-sandbox-mvp-'));
 Object.assign(process.env,{FIRSTMATE_ENV:'development',FIRSTMEASURE_DATA_ENVIRONMENT:'development',FIRSTMEASURE_DATABASE_MODE:'sqlite',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),SIGNUP_SANDBOX_STORAGE_ROOT:path.join(root,'sandbox'),PLATFORM_SESSION_SECRET:'isolated-sandbox-mvp-platform-test-secret'});
 await import('../platform/capability_defs.js');
 for(const module of ['assistant','comms','chat']) await import(`../${module}/capabilities.js`);
 const {sandboxStore}=await import('../signup-sandbox/storage.js');
 const service=await import('../signup-sandbox/service.js');
 const storage=await import('../platform/storage.js');
 const capabilities=await import('../platform/capabilities.js');
 await import('../platform/widgets/catalog.js');
 process.chdir(root);
 await service.ensureSeedData();
 const workflow=await sandboxStore.readWorkflow('swf_mvp_platform');
 assert.ok(workflow);
 assert.deepEqual((workflow!.stages as any[]).map(stage=>stage.page_id),['spg_firstmate_landing','spg_firstmate_signup','spg_firstmate_branding','spg_firstmate_users','spg_firstmate_account_load']);

 // An edited workflow is kept: the seed never overwrites it.
 const edited={...(workflow!.defaults as any),app_flags:{...(workflow!.defaults as any).app_flags,'platform.scheduling':true}};
 await sandboxStore.saveWorkflow({...workflow,defaults:edited});
 await service.ensureSeedData();
 assert.equal(((await sandboxStore.readWorkflow('swf_mvp_platform'))!.defaults as any).app_flags['platform.scheduling'],true);
 await sandboxStore.saveWorkflow(workflow!);

 const instance=await service.createTestInstance('swf_mvp_platform',{label:'MVP platform fixture'});
 const orgId=String(instance.testOrg.org_id);
 const {effectiveByKey}=await capabilities.effectiveCapabilities(orgId);
 const on=['platform.expanded_access','apps.projects','apps.project_map','platform.project_stages_view','platform.contacts','platform.photos_feed','platform.project_photos','platform.customer_portal','platform.materials','platform.documents','apps.firstmeasure','firstmeasure.report_orders','apps.assistant','channels.project_notes'];
 for(const key of on) assert.equal(effectiveByKey[key],true,key);
 const off=['platform.scheduling','scheduling.gantt','equipment.scheduling','apps.crm','apps.stats','apps.payroll','apps.training','apps.crew','apps.sales','platform.money','apps.comms','apps.checklists','apps.equipment'];
 for(const key of off) assert.notEqual(effectiveByKey[key],true,key);
 const global=await storage.readGlobal(orgId);
 assert.deepEqual((global.data as any).app_placements,{'portal.channels':'hidden','portal.assistant':'hidden'});
});
