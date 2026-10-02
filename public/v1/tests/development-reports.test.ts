import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';

test('development copies require a developer, matching signed selection and completed artifacts',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fm-development-reports-'));
  Object.assign(process.env,{FIRSTMATE_ENV:'development',FIRSTMEASURE_DATA_ENVIRONMENT:'development',FIRSTMEASURE_DATABASE_MODE:'sqlite',FIRSTMEASURE_STORAGE_ROOT:path.join(root,'reports'),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite'),PLATFORM_STORAGE_ROOT:path.join(root,'platform'),FIRSTMEASURE_DEVELOPER_EMAILS:'developer@example.test',PLATFORM_SESSION_SECRET:'test-development-report-secret-not-a-real-key'});
  const service=await import('../firstmeasure/development_reports.js');
  const storage=await import('../firstmeasure/storage.js');
  const {env}=await import('../src/config/env.js');
  await (await import('../platform/storage.js')).createOrganization({id:'dev-org',name:'Development test'});
  const auth={userId:'developer',orgId:'dev-org',identity:{email:'developer@example.test'},role:'owner'} as any;
  const ordinary={...auth,identity:{email:'customer@example.test'}};
  assert.equal(await service.developmentReportsAllowed(auth),true);
  assert.equal(await service.developmentReportsAllowed(ordinary),false);
  const sandbox={...ordinary,organization:{id:ordinary.orgId,metadata:{sandbox_test_org:true,sandbox_instance_id:'sbi_test'}},session:{metadata:{source:'signup_sandbox_instance',sandbox_instance_id:'sbi_test'}}};
  assert.equal(await service.developmentReportsAllowed(sandbox),true);
  assert.equal(await service.developmentReportsAllowed({...sandbox,session:{metadata:{source:'signup_sandbox_admin_jump',sandbox_instance_id:'sbi_test'}}}),true);
  assert.equal(await service.developmentReportsAllowed({...sandbox,session:{metadata:{source:'signup_sandbox_instance',sandbox_instance_id:'sbi_other'}}}),false);
  assert.equal(await service.developmentReportsAllowed({...sandbox,role:'member'}),false);
  assert.equal(await service.developmentReportsAllowed({...sandbox,session:{}}),false);

  await assert.rejects(service.copyDevelopmentReport(ordinary,{}),/developer access/);
  assert.throws(()=>service.developmentCriteria({project_type:'invalid'}));
  for(const project_type of ['commercial','multifamily']) {
    assert.throws(()=>service.developmentCriteria({project_type,measurement_scope:'full_house'}),/residential/);
    const {requireExteriorAccess}=await import('../firstmeasure/exteriors.js');
    await assert.rejects(requireExteriorAccess('dev-org',project_type),/not enabled/);
  }
  assert.deepEqual(service.developmentCriteria({project_type:'residential',measurement_scope:'full_house'}),{type:'residential',scope:'full_house'});
  Object.assign(env,{isDevelopment:false});assert.equal(await service.developmentReportsAllowed(auth),false);assert.equal(await service.developmentReportsAllowed(sandbox),false);Object.assign(env,{isDevelopment:true});
  Object.assign(env,{dataEnvironment:'production'});assert.equal(await service.developmentReportsAllowed(auth),false);Object.assign(env,{dataEnvironment:'development'});
  const source='development-source';
  await storage.saveManifest(source,{id:source,status:'completed',schema_version:1,project_type:'residential',address:'10 Test Street',lat:40,lng:-90,pins:[{lat:40,lng:-90}],timestamps:{},organization_ref:{id:'source-org'},resident:{email:'private@example.test'}} as any);
  for(const name of ['Report.pdf','Summary.pdf','model_data.xml','google.png'])await storage.saveArtifact(source,name,Buffer.from(name));
  await storage.saveArtifact(source,'private-notes.json','{"secret":"not copied"}');
  assert.equal((await service.pickDevelopmentReport(auth,{project_type:'commercial'})).sample,null);
  assert.equal((await service.pickDevelopmentReport(auth,{project_type:'residential',measurement_scope:'full_house'})).sample,null);
  const picked=await service.pickDevelopmentReport(auth,{project_type:'residential'});
  assert.equal(picked.sample?.id,source);assert.ok(picked.sample?.selection_token);

  await storage.saveManifest('development-source-2',{...await storage.readManifest(source),id:'development-source-2',address:'20 Test Street'});
  for(const name of ['Report.pdf','Summary.pdf','model_data.xml'])await storage.saveArtifact('development-source-2',name,Buffer.from(name));
  assert.equal((await service.pickDevelopmentReport(auth,{project_type:'residential',exclude_id:source})).sample?.id,'development-source-2');
  const makeToken=(changes={})=>{const text=Buffer.from(JSON.stringify({id:source,type:'residential',scope:'roof',user:auth.userId,org:auth.orgId,expires:Date.now()+60000,...changes})).toString('base64url');return text+'.'+createHmac('sha256',env.platformSessionSecret).update('development-report:'+text).digest('base64url');};
  const body={project_type:'residential',measurement_scope:'roof',address:'10 Test Street',development_selection_token:makeToken()};
  await assert.rejects(service.copyDevelopmentReport(auth,{...body,address:'Changed address'}),/no longer a matching/);
  await assert.rejects(service.copyDevelopmentReport(auth,{...body,project_type:'commercial'}),/matching development address/);
  await assert.rejects(service.copyDevelopmentReport(auth,{...body,development_selection_token:makeToken({org:'other'})}),/matching development address/);
  await assert.rejects(service.copyDevelopmentReport(auth,{...body,development_selection_token:makeToken({expires:0})}),/matching development address/);
  await assert.rejects(service.copyDevelopmentReport(auth,{...body,development_selection_token:body.development_selection_token+'x'}),/development address/);
  const result=await service.copyDevelopmentReport(auth,body);
  assert.equal(result.success,true);assert.notEqual(result.folder,source);assert.equal(result.manifest.status,'completed');assert.equal(result.project.status,'completed');assert.equal(result.project.amount_charged,0);
  assert.equal((result.manifest.organization_ref as any).id,'dev-org');
  assert.notEqual((result.manifest.resident as any)?.email,'private@example.test');
  assert.equal((await storage.readManifest(source)).status,'completed');
  assert.equal((await storage.readArtifact(result.folder,'Report.pdf')).content.toString(),'Report.pdf');
  await assert.rejects(storage.readArtifact(result.folder,'private-notes.json'));
  await (await import('../firstmeasure/project_index.js')).closeFirstMeasureProjectIndex();
});
