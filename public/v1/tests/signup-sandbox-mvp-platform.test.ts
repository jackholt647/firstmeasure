import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('the MVP platform workflow is FirstMeasure plus projects, contacts, feed and the project tabs and trays, without scheduling',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'fm-sandbox-mvp-'));
 Object.assign(process.env,{FIRSTMATE_ENV:'development',FIRSTMEASURE_DATA_ENVIRONMENT:'development',FIRSTMEASURE_DATABASE_MODE:'sqlite',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),SIGNUP_SANDBOX_STORAGE_ROOT:path.join(root,'sandbox'),PLATFORM_SESSION_SECRET:'isolated-sandbox-mvp-platform-test-secret',FIRSTMEASURE_STORAGE_ROOT:path.join(root,'firstmeasure'),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'firstmeasure-index.sqlite')});
 await import('../platform/capability_defs.js');
 for(const module of ['assistant','comms','chat']) await import(`../${module}/capabilities.js`);
 const {sandboxStore}=await import('../signup-sandbox/storage.js');
 const service=await import('../signup-sandbox/service.js');
 const storage=await import('../platform/storage.js');
 const capabilities=await import('../platform/capabilities.js');
 await import('../platform/widgets/catalog.js');
 const home=process.cwd();
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
 const off=['customer_portal.guest_links','platform.project_assignments','topbar.todos','channels.project_messages_tray','platform.scheduling','scheduling.gantt','equipment.scheduling','apps.crm','apps.stats','apps.payroll','apps.training','apps.crew','apps.sales','platform.money','apps.comms','apps.checklists','apps.equipment'];
 for(const key of off) assert.notEqual(effectiveByKey[key],true,key);
 const global=await storage.readGlobal(orgId);
 assert.deepEqual((global.data as any).app_placements,{'portal.channels':'hidden','portal.assistant':'hidden'});
 // Project tabs: Overview, Reports, Photos, Docs, Project (called Materials) and Customer Portal; Photos and Docs are New.
 const projectTabs={order:['project.map','project.measurements','project.photos','project.docs','project.materials','project.customer_portal'],pills:{'project.photos':'new','project.docs':'new','project.materials':'new','project.customer_portal':'new'}};
 assert.deepEqual((global.data as any).project_tabs,projectTabs);
 const {appFlagState}=await import('../platform/app_flags.js');
 assert.deepEqual((await appFlagState(orgId)).project_tabs,projectTabs);
 const {readTerminologyMappings}=await import('../platform/localization/terminology-settings.js');
 assert.equal((await readTerminologyMappings(orgId,'default') as any).labels.scope.project_tab,'Materials');
 // The configuration's setup script: Generic Roofing installed, every new project starts it, other presets off.
 const router=await import('../scopes/router.js');const scopes=await import('../scopes/storage.js');const creation=await import('../projects/create.js');
 const routing=await router.readIntakeRouting(orgId);
 assert.equal(routing.manual_template_id,'generic_roofing');assert.equal(routing.default_template_id,'generic_roofing');
 const enabled=(await scopes.listScopeTemplates(orgId)).map(template=>String(template.id));
 assert.deepEqual(enabled,['generic_roofing']);
 const roofing=await scopes.readScopeTemplate(orgId,'default','generic_roofing');
 assert.deepEqual((roofing as any).definition?.measurement_schema_ids ?? (roofing as any).measurement_schema_ids,['roofing']);
 assert.equal(String((await creation.creationScopeTemplate(orgId,'default')).id),'generic_roofing');
 assert.equal((workflow as any).dev_bar,false);assert.equal((workflow as any).configuration_revision,12);
 const resolved=(await capabilities.effectiveCapabilities(orgId)).values as any;
 assert.equal(resolved['platform.new_button_mode'],'selector');assert.equal(resolved['platform.new_button_items'],'report,project,contact');
 // Turned on as configuration even where this checkout's registry does not define it (dev's does).
 assert.equal((workflow!.defaults as any).app_flags['firstmeasure.roof_model_viewer'],true);
 assert.equal((workflow as any).sample_data,true);assert.deepEqual((workflow as any).setup_scripts,['mvp-platform']);
 // Generic Roofing's board follows the report and the documents: five stages, in order.
 const definition=(roofing as any).definition;
 assert.deepEqual(definition.work_plan.root_nodes[0].children.map((stage:any)=>stage.title),['New project','Measurements ordered','Measurements received','Proposal created','Materials created']);
 // Dry run: each milestone moves the board one stage; one that comes early skips ahead, and one that comes late never moves it back.
 const {dryRunAutomations}=await import('../scopes/dry-run.js');
 const stageAfter=async(steps:any[])=>{const run:any=await dryRunAutomations(orgId,'default',{template_id:'generic_roofing',include_organization_rules:false,steps});assert.deepEqual(run.errors,[]);return run.final.current_stage?.id;};
 assert.equal(await stageAfter([]),'new_project');
 assert.equal(await stageAfter([{event:'measurement.report.ordered'}]),'report_ordered');
 assert.equal(await stageAfter([{event:'measurement.report.ordered'},{event:'measurement.report.completed'}]),'report_delivered');
 assert.equal(await stageAfter([{event:'measurement.report.ordered'},{event:'measurement.report.completed'},{event:'document.created',payload:{document_type:'invoice'}}]),'report_delivered');
 assert.equal(await stageAfter([{event:'document.created',payload:{document_type:'proposal'}}]),'proposal_created');
 assert.equal(await stageAfter([{event:'material.lines.created'},{event:'measurement.report.ordered'}]),'materials_created');
 // The real writers move a real project: the board stage is read from the project's work projection.
 process.env.NODE_ENV='test';
 const platformApi=await import('../platform/api.js');const fm=await import('../firstmeasure/storage.js');const work=await import('../work/service.js');
 const boardStage=async(projectId:string)=>String((await work.projectWorkProjection(orgId,projectId)).instances.find((entry:any)=>entry.template_id==='generic_roofing')?.stage_id);
 const flow='project_stage_flow';
 const made:any=await platformApi.upsertProjectDocumentPreservingEvents(orgId,flow,{id:flow,data:{title:'12 Stage Street',address:'12 Stage Street'}},true);
 assert.equal(await boardStage(flow),'new_project');
 // Ordering a report: the report is made, then the order flow saves the project with its link.
 await fm.createProject({id:'report_stage_flow',address:'12 Stage Street',organization_ref:{id:orgId}});
 await platformApi.upsertProjectDocumentPreservingEvents(orgId,flow,{id:flow,data:{...made.data,measurement_project:{id:'report_stage_flow',status:'queued'}}},true);
 assert.equal(await boardStage(flow),'report_ordered');
 await fm.updateStatus('report_stage_flow','completed');
 assert.equal(await boardStage(flow),'report_delivered');
 const documents=await import('../documents/service.js');
 await documents.createDocumentInstance(orgId,flow,{document_type:'proposal'},instance.authContext as any);
 assert.equal(await boardStage(flow),'proposal_created');
 const calculus=await import('../materials/calculus.js');const {userPublicationContext}=await import('../platform/publication/context.js');
 const materialsCtx=userPublicationContext(instance.authContext as any,{projectId:flow,executionKind:'api'});
 const materials=async(operation:string,input:any)=>calculus.materialsCommand(materialsCtx,flow,{key:crypto.randomUUID(),expected_revision:(await calculus.readMaterialsLedger(materialsCtx,flow)).revision,operation,input});
 const set=String((await materials('create',{definition:{type:'materials_calculus',key:'roof',title:'Roof',bindings:{},inputSchema:{type:'object',properties:{},additionalProperties:false},defaults:{},source:"return {outputs:{lines:[{key:'shingles',product_id:'hdz',name:'HDZ',quantity:30,unit:'bundle',explanation:'Roof'}],warnings:[]}};"}})).result.set_id);
 assert.equal(await boardStage(flow),'proposal_created');
 // The calculation runs in the module sandbox, which loads from the package directory.
 process.chdir(home);
 const evaluated=await materials('evaluate',{set_id:set,values:{}});
 process.chdir(root);
 await materials('apply',{set_id:set,evaluation_id:evaluated.result.evaluation_id});
 assert.equal(await boardStage(flow),'materials_created');
 // A stage set by hand stays until the project's own milestones reach it.
 const manual='project_stage_manual';
 const manualMade:any=await platformApi.upsertProjectDocumentPreservingEvents(orgId,manual,{id:manual,data:{title:'14 Stage Street'}},true);
 const plan=(await work.projectWorkProjection(orgId,manual)).plans.find((entry:any)=>entry.template_id==='generic_roofing') as any;
 await work.setManualPlanStage(orgId,String(plan.id),'proposal_created');
 await fm.createProject({id:'report_stage_manual',address:'14 Stage Street',organization_ref:{id:orgId}});
 await platformApi.upsertProjectDocumentPreservingEvents(orgId,manual,{id:manual,data:{...manualMade.data,measurement_project:{id:'report_stage_manual',status:'queued'}}},true);
 assert.equal(await boardStage(manual),'proposal_created');
 await (await import('../firstmeasure/project_index.js')).closeFirstMeasureProjectIndex();
 // Every active role opens My Projects on the map.
 const access=await import('../workforce/access.js');
 const roles=(await access.listAccessRoles(orgId)).filter((role:any)=>role.status!=='archived');
 assert.ok(roles.length>0);
 for(const role of roles as any[]) assert.equal(role.app_defaults?.['portal.viewer']?.options?.map_first,true,String(role.id));
 // MVP test orgs take the development sample projects and customers (the project map needs projects).
 const {addTestOrgSampleData}=await import('../signup-sandbox/sample-data.js');
 await addTestOrgSampleData(String(instance.testOrg.id),{projects:true,customers:true});
 assert.ok((await storage.listDocuments(orgId,'projects')).length>0);
});
