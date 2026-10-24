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

 // A saved copy from an older configuration revision is replaced by the configuration file.
 await sandboxStore.saveWorkflow({...workflow,configuration_revision:1,defaults:{...(workflow!.defaults as any),app_flags:{...(workflow!.defaults as any).app_flags,'platform.top_bar':false}}});
 await service.ensureSeedData();
 assert.equal(((await sandboxStore.readWorkflow('swf_mvp_platform'))!.defaults as any).app_flags['platform.top_bar'],true);
 // An edited workflow at the current revision is kept: the seed never overwrites it.
 const edited={...(workflow!.defaults as any),app_flags:{...(workflow!.defaults as any).app_flags,'platform.scheduling':true}};
 await sandboxStore.saveWorkflow({...workflow,defaults:edited});
 await service.ensureSeedData();
 assert.equal(((await sandboxStore.readWorkflow('swf_mvp_platform'))!.defaults as any).app_flags['platform.scheduling'],true);
 await sandboxStore.saveWorkflow(workflow!);
 // A capability added after the seed reaches the saved workflow, off; one already set is left as it is.
 const withoutTray={...(workflow!.defaults as any).app_flags};delete withoutTray['channels.project_messages_tray'];
 await sandboxStore.saveWorkflow({...workflow,defaults:{...(workflow!.defaults as any),app_flags:withoutTray}});
 await service.ensureSeedData();
 assert.equal(((await sandboxStore.readWorkflow('swf_mvp_platform'))!.defaults as any).app_flags['channels.project_messages_tray'],false);
 await sandboxStore.saveWorkflow(workflow!);

 const instance=await service.createTestInstance('swf_mvp_platform',{label:'MVP platform fixture'});
 const orgId=String(instance.testOrg.org_id);
 const {effectiveByKey}=await capabilities.effectiveCapabilities(orgId);
 const on=['platform.more_apps','platform.advanced_app_menu','firstmeasure.exteriors','platform.top_bar','topbar.global_search','topbar.notifications','platform.expanded_access','apps.projects','apps.project_map','platform.project_stages_view','platform.contacts','platform.photos_feed','platform.project_photos','platform.customer_portal','platform.materials','platform.documents','apps.firstmeasure','firstmeasure.report_orders','apps.assistant','channels.project_notes'];
 for(const key of on) assert.equal(effectiveByKey[key],true,key);
 const off=['topbar.todos','channels.project_messages_tray','platform.scheduling','scheduling.gantt','equipment.scheduling','apps.crm','apps.stats','apps.payroll','apps.training','apps.crew','apps.sales','platform.money','apps.comms','apps.checklists','apps.equipment'];
 for(const key of off) assert.notEqual(effectiveByKey[key],true,key);
 const global=await storage.readGlobal(orgId);
 assert.deepEqual((global.data as any).app_placements,{'portal.channels':'hidden','portal.assistant':'hidden'});
 // The configuration's setup script: Generic Roofing installed, every new project starts it, other presets off.
 const router=await import('../scopes/router.js');const scopes=await import('../scopes/storage.js');const creation=await import('../projects/create.js');
 const routing=await router.readIntakeRouting(orgId);
 assert.equal(routing.manual_template_id,'generic_roofing');assert.equal(routing.default_template_id,'generic_roofing');
 const enabled=(await scopes.listScopeTemplates(orgId)).map(template=>String(template.id));
 assert.deepEqual(enabled,['generic_roofing']);
 const roofing=await scopes.readScopeTemplate(orgId,'default','generic_roofing');
 assert.deepEqual((roofing as any).definition?.measurement_schema_ids ?? (roofing as any).measurement_schema_ids,['roofing']);
 assert.equal(String((await creation.creationScopeTemplate(orgId,'default')).id),'generic_roofing');
 assert.equal((workflow as any).dev_bar,false);assert.equal((workflow as any).configuration_revision,6);
 const resolved=(await capabilities.effectiveCapabilities(orgId)).values as any;
 assert.equal(resolved['platform.new_button_mode'],'selector');assert.equal(resolved['platform.new_button_items'],'report,project,contact');
 // Turned on as configuration even where this checkout's registry does not define it (dev's does).
 assert.equal((workflow!.defaults as any).app_flags['firstmeasure.roof_model_viewer'],true);
 assert.equal((workflow as any).sample_data,true);assert.deepEqual((workflow as any).setup_scripts,['mvp-platform']);
 // MVP test orgs take the development sample projects and customers (the project map needs projects).
 const {addTestOrgSampleData}=await import('../signup-sandbox/sample-data.js');
 await addTestOrgSampleData(String(instance.testOrg.id),{projects:true,customers:true});
 assert.ok((await storage.listDocuments(orgId,'projects')).length>0);
});
