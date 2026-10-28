import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('instant full sandbox defaults hide optional reports, Training, Training Studio, and Canvassing while allowing development reports',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'fm-sandbox-reports-'));
 Object.assign(process.env,{FIRSTMATE_ENV:'development',FIRSTMEASURE_DATA_ENVIRONMENT:'development',FIRSTMEASURE_DATABASE_MODE:'sqlite',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),SIGNUP_SANDBOX_STORAGE_ROOT:path.join(root,'sandbox'),PLATFORM_SESSION_SECRET:'isolated-sandbox-report-defaults-test-secret'});
 await import('../platform/capability_defs.js');
 const {sandboxStore}=await import('../signup-sandbox/storage.js');
 const service=await import('../signup-sandbox/service.js');
 const storage=await import('../platform/storage.js');
 const {developmentReportsAllowed}=await import('../firstmeasure/development_reports.js');
 // Load repository-relative widget assets before entering the isolated data directory.
 await import('../platform/widgets/catalog.js');
 process.chdir(root);
 await service.ensureSeedData();
 let workflow=await sandboxStore.readWorkflow('swf_instant_full_org');
 const flags=()=>((workflow!.defaults as any).app_flags);
 // Every on/off capability starts on (the configuration's base), with these named off.
 assert.equal((workflow as any).app_flags_base,'all_on');
 assert.equal(flags()['firstmeasure.weather_reports'],false);assert.equal(flags()['firstmeasure.instant_reports'],false);
 for(const key of ['apps.training','training.studio','canvassing.app']) assert.equal(flags()[key],false);
 // A copy edited in the sandbox is kept as edited; reset puts it back to the library configuration.
 await service.updateWorkflow('swf_instant_full_org',{defaults:{...(workflow!.defaults as any),app_flags:{...flags(),'firstmeasure.weather_reports':true,'apps.training':true,'platform.new_button_mode':'off','apps.equipment':false}}});
 await service.ensureSeedData();workflow=await sandboxStore.readWorkflow('swf_instant_full_org');
 assert.equal(flags()['firstmeasure.weather_reports'],true);assert.equal(flags()['apps.equipment'],false);assert.equal(flags()['platform.new_button_mode'],'off');
 await service.resetWorkflowToLibrary('swf_instant_full_org');workflow=await sandboxStore.readWorkflow('swf_instant_full_org');
 assert.equal(flags()['firstmeasure.weather_reports'],false);assert.equal(flags()['apps.equipment'],undefined);assert.equal(flags()['platform.new_button_mode'],'selector');
 for(const key of ['apps.training','training.studio','canvassing.app']) assert.equal(flags()[key],false);
 const instance=await service.createTestInstance('swf_instant_full_org',{label:'Report defaults fixture'});
 const global=await storage.readGlobal(String(instance.testOrg.org_id));const reports=(global.data as any).app_flags.firstmeasure;
 assert.equal(reports.weather_reports,false);assert.equal(reports.instant_reports,false);assert.equal(reports.exteriors,true);
 const appFlags=(global.data as any).app_flags;
 assert.equal(appFlags.apps.training,false);assert.equal(appFlags.training.studio,false);assert.equal(appFlags.canvassing.app,false);
 assert.equal(appFlags.apps.equipment,true,'the base turns on what the configuration does not name');
 // What createTestInstance used to add for this workflow by its id is configuration data now.
 assert.equal((global.data as any).roofing_setup?.completed,true);
 assert.equal(await developmentReportsAllowed(instance.authContext),true);
 assert.equal(await developmentReportsAllowed({...instance.authContext,session:{}}),false);
});
