import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=await mkdtemp(path.join(os.tmpdir(),'priority-fields-'));
Object.assign(process.env,{PLATFORM_STORAGE_ROOT:path.join(root,'platform'),PLATFORM_ACTIONS_DB_PATH:path.join(root,'actions.sqlite'),NODE_ENV:'test'});
if(process.env.TEST_POSTGRES_URL)Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'postgres',DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_POOL_MAX:'1',POSTGRES_AUTO_MIGRATE:'false',FIRSTMEASURE_ARTIFACT_STORAGE:'local'});
const {normalizeCalculation,evaluateCalculation}=await import('../custom_fields/calculations.js');
const {configuredPriorityFields,customPriorityField,normalizePriorityFields,builtinPriorityField}=await import('../priority_fields/contracts.js');

test('priority configuration migrates without mutation and explicit lists stay exact',()=>{
  const config={project_header_pills:['stage','dollar_value']};
  const custom=[{path:'rep',label:'Representative',ui:{project_tag:true}}];
  assert.deepEqual(configuredPriorityFields(config,custom).map(f=>f.id),['stage','dollar_value','custom_field:rep','project_type']);
  assert.deepEqual(config,{project_header_pills:['stage','dollar_value']});
  assert.deepEqual(configuredPriorityFields({priority_fields:[]},custom),[]);
  assert.deepEqual(configuredPriorityFields({priority_fields:[builtinPriorityField('stage')]},custom).map(f=>f.id),['stage']);
  assert.throws(()=>normalizePriorityFields([{...builtinPriorityField('stage'),calculation:{op:'sum',inputs:[]}}]));
  assert.throws(()=>normalizePriorityFields([builtinPriorityField('stage'),builtinPriorityField('stage')]));
  assert.throws(()=>normalizeCalculation({op:'source',source:{provider:'x',export:'y',target:{scope:'project'},private_context:true}}));
});

test('arithmetic preserves zero, absence, strict types and invalid results',async()=>{
  const ctx={organizationId:'x'} as any,evidence:any[]=[],target={scope:'project',projectId:'p'} as any;
  const literal=(value:any)=>({op:'literal',value});
  const evaluate=(v:any)=>evaluateCalculation(normalizeCalculation(v),ctx,target,evidence);
  assert.equal(await evaluate({op:'first',inputs:[literal(null),literal(0),literal(9)]}),0);
  assert.equal(await evaluate({op:'sum',inputs:[literal(0),literal(2)]}),2);
  assert.equal(await evaluate({op:'sum',inputs:[literal(null),literal(2)]}),undefined);
  assert.equal(await evaluate({op:'sum',missing:'skip',inputs:[literal(null),literal(2)]}),2);
  assert.equal(await evaluate({op:'product',inputs:[literal(3),literal(4)]}),12);
  await assert.rejects(()=>evaluate({op:'quotient',inputs:[literal(3),literal(0)]}));
  await assert.rejects(()=>evaluate({op:'sum',inputs:[literal('2'),literal(2)]}));
});

test('compatibility fields preserve project scope and pure stored proposal pricing',async()=>{
  const {projectSummaryDetails,projectSummaryValue}=await import('../priority_fields/publication.js');
  assert.equal(projectSummaryDetails({scope_set_name:'Roof replacement',project_type:'multifamily'}).scope_type,'Roof replacement');
  assert.equal(await projectSummaryValue({contract_value:0},[{total:999}]),0);
  assert.equal(await projectSummaryValue({},[{status:'draft',total:100},{status:'signed',total:200}]),200);
  assert.equal(await projectSummaryValue({},[{pages:[{kind:'pricing',lineItems:[{amount:100},{amount:50}]},{kind:'signature',taxAmount:15}]}]),165);
  assert.equal(await projectSummaryValue({}),null);
});

test('published fields select documents, resolve priorities, retain provenance and enforce revocation and cycles',async()=>{
  const storage=await import('../platform/storage.js');
  const {registerBuiltinDataProviders}=await import('../platform/publication/provider-adapters.js');
  const {registerCustomFieldPublication}=await import('../custom_fields/publication.js');
  const {registerPriorityFieldsPublication}=await import('../priority_fields/publication.js');
  const {registerDataProvider,readPublishedData,authorizeSourceSnapshot}=await import('../platform/publication/providers.js');
  const {systemPublicationContext}=await import('../platform/publication/context.js');
  registerBuiltinDataProviders();registerCustomFieldPublication();registerPriorityFieldsPublication();
  let reads=0;
  registerDataProvider({id:'priority-test',version:'1',apps:['projects'],exports:{values:{description:'Fixture',schema:{type:'object',additionalProperties:true},schemaVersion:'1',access:{scopes:['project'],permissions:['view_projects'],systemKinds:['module']},read:async()=>({value:{a:2,b:3},revision:String(++reads)})},secret:{description:'Restricted fixture',schema:{type:'number'},schemaVersion:'1',access:{scopes:['project'],permissions:['manage_company_settings'],systemKinds:['module']},read:async()=>({value:99})}}});
  const org='priority_test_org_'+Date.now().toString(36),target={scope:'project' as const,organizationId:org,projectId:'p'};
  const ctx=systemPublicationContext({kind:'module',organizationId:org,projectId:'p',mode:'evaluate',operations:['priority-fields.contract','priority-fields.values','project-summary.details','custom-fields-project.contract','custom-fields-project.values','documents.params','priority-test.values']});
  const source=(provider:string,exportName:string,fieldPath:string,id?:string,args?:any)=>({op:'source',source:{provider,export:exportName,target:{scope:'project',organizationId:'$organization',projectId:'$project',...(id?{id}:{})},path:fieldPath,...(args?{args}:{})}});
  const fieldSource=(field:string)=>source('custom-fields-project','values','/'+field,undefined,{field});
  const documentSource=(template:string,pick='first')=>({...source('documents','params','/total'),select:{where:{template_id:template,status:'signed'},orderBy:'created_at',direction:'desc',pick}});
  const fields=[
    {path:'contract_value',label:'Contract value',type:'currency',calculation:{op:'first',inputs:[documentSource('absent'),documentSource('estimate')]}},
    {path:'combined',label:'Combined',type:'currency',calculation:{op:'sum',inputs:[documentSource('estimate','all')]}},
    {path:'coherent',type:'number',calculation:{op:'sum',inputs:[source('priority-test','values','/a'),source('priority-test','values','/b')]}},
    {path:'restricted',type:'number',calculation:{op:'first',inputs:[source('priority-test','secret',''),{op:'literal',value:7}]}},
    {path:'cycle_a',type:'number',calculation:fieldSource('cycle_b')},{path:'cycle_b',type:'number',calculation:fieldSource('cycle_a')}
  ];
  try{
    await storage.createOrganization({id:org,name:'Priority fixture'});
    await storage.saveBranchModule(org,'default','custom_fields',{data:{fields}},{replace:true});
    await storage.upsertDocument(org,'projects',{id:'p',data:{project_type:'residential',branch_id:'default',custom_field_values:{}}});
    for(const [id,template,status,total,created]of [['one','estimate','signed',10,'2026-01-01'],['two','estimate','signed',0,'2026-02-01'],['draft','estimate','draft',1000,'2026-03-01'],['other','other','signed',999,'2026-04-01']])await storage.upsertDocument(org,'documents',{id:String(id),data:{project_id:'p',template_id:template,status,created_at:created,publication:{params:['total']},params:{total}}});
    await storage.upsertDocument(org,'projects',{id:'foreign',data:{branch_id:'default'}});
    await storage.upsertDocument(org,'documents',{id:'foreign_doc',data:{project_id:'foreign',template_id:'estimate',status:'signed',created_at:'2026-05-01',publication:{params:['total']},params:{total:5000}}});
    const priorities=[customPriorityField(fields[0]!),customPriorityField(fields[1]!),customPriorityField(fields[2]!)];
    await storage.saveBranchModule(org,'default','project_configuration',{data:{priority_fields:priorities}},{replace:true});
    const result=await readPublishedData(ctx,{provider:'priority-fields',export:'values',target});
    assert.equal(result.status,'ready');if(result.status!=='ready')throw Error(JSON.stringify(result));
    const items=(result.value as any).items;assert.deepEqual(items.map((i:any)=>i.result.value),[0,10,5],JSON.stringify(items.map((i:any)=>i.result)));assert.equal(reads,1);
    assert.equal(items[0].result.provenance.sourceEvidence[0].source.target.id,'two');
    const customRef={provider:'custom-fields-project',export:'values',target,args:{field:'contract_value'},path:'/contract_value'};
    const captured=await readPublishedData(ctx,customRef);assert.equal(captured.status,'ready');
    const privateResult=await readPublishedData(ctx,{...customRef,args:{field:'restricted'},path:'/restricted'});assert.equal(privateResult.status,'denied');
    const cycle=await readPublishedData(ctx,{...customRef,args:{field:'cycle_a'},path:'/cycle_a'});assert.equal(cycle.status,'error');assert.match(cycle.code,/cycle/);
    const foreign=await readPublishedData(ctx,{...customRef,target:{...target,organizationId:'foreign'}});assert.equal(foreign.status,'denied');
    await assert.rejects(()=>storage.saveBranchModule(org,'default','project_configuration',{data:{priority_fields:[{...priorities[0],calculation:{op:'sum'}}]}}));
    const {assertFieldWrite}=await import('../custom_fields/records.js');assert.throws(()=>assertFieldWrite(ctx,fields[0]!));
    await storage.upsertDocument(org,'documents',{id:'two',data:{publication:{params:[]}}});
    if(captured.status==='ready')await assert.rejects(()=>authorizeSourceSnapshot(ctx,customRef,captured),/no longer published/);
    await assert.rejects(()=>authorizeSourceSnapshot(ctx,{provider:'priority-fields',export:'values',target},result),/no longer published/);
    await storage.saveBranchModule(org,'default','project_configuration',{data:{priority_fields:[]}},{replace:true});
    const empty=await readPublishedData(ctx,{provider:'priority-fields',export:'values',target});assert.equal(empty.status,'ready');if(empty.status==='ready')assert.deepEqual((empty.value as any).items,[]);
    const record=await storage.readDocument(org,'projects','p');assert.equal(record.revision,1,'Reading fields never mutates records');
  }finally{await rm(root,{recursive:true,force:true});}
});


test('one owner catalog resolves independent contact and user priorities, including embedded contacts, with owner authorization',async()=>{
  const storage=await import('../platform/storage.js');
  const {readPublishedData,authorizeSourceSnapshot}=await import('../platform/publication/providers.js');
  const {systemPublicationContext}=await import('../platform/publication/context.js');
  const {customPriorityField}=await import('../priority_fields/contracts.js');
  const org='priority_owners_'+Date.now().toString(36),target={scope:'organization' as const,organizationId:org,id:'c'};
  const contact={entity:'contact',path:'tier',label:'Relationship tier',type:'text'};
  const user={entity:'user',path:'availability',label:'Availability',type:'text',calculation:{op:'first',inputs:[{op:'literal',value:''},{op:'literal',value:'Available'}]}};
  const contactCtx=systemPublicationContext({kind:'module',organizationId:org,mode:'evaluate',operations:['priority-fields.contact-contract','priority-fields.contact-values','custom-fields-contact.values']});
  const userCtx=systemPublicationContext({kind:'module',organizationId:org,mode:'evaluate',operations:['priority-fields.user-contract','priority-fields.user-values','custom-fields-user.values']});
  try{
    await storage.createOrganization({id:org,name:'Owners fixture'});
    await storage.saveBranchModule(org,'default','custom_fields',{data:{fields:[contact,user]}},{replace:true});
    await storage.upsertDocument(org,'customers',{id:'c',data:{branch_id:'default',custom_field_values:{tier:'Partner'}}});
    await storage.upsertDocument(org,'users',{id:'u',data:{custom_field_values:{}}});
    await storage.upsertDocument(org,'projects',{id:'embedded',data:{branch_id:'default',contacts:[{id:'embedded_c',custom_field_values:{tier:'Embedded partner'}}]}});
    const empty=await readPublishedData(contactCtx,{provider:'priority-fields',export:'contact-values',target});assert.equal(empty.status,'ready');if(empty.status==='ready')assert.deepEqual((empty.value as any).items,[]);
    await storage.saveBranchModule(org,'default','priority_fields',{data:{entities:{contact:[customPriorityField(contact)],user:[customPriorityField(user)]}}},{replace:true});
    const result=await readPublishedData(contactCtx,{provider:'priority-fields',export:'contact-values',target});assert.equal(result.status,'ready');if(result.status!=='ready')throw Error(JSON.stringify(result));assert.equal((result.value as any).items[0].result.value,'Partner');
    const embedded=await readPublishedData(contactCtx,{provider:'priority-fields',export:'contact-values',target:{scope:'project',organizationId:org,projectId:'embedded',id:'embedded_c'}});assert.equal(embedded.status,'ready');if(embedded.status==='ready')assert.equal((embedded.value as any).items[0].result.value,'Embedded partner');
    const users=await readPublishedData(userCtx,{provider:'priority-fields',export:'user-values',target:{...target,id:'u'}});assert.equal(users.status,'ready');if(users.status==='ready')assert.equal((users.value as any).items[0].result.value,'Available');
    assert.equal((await readPublishedData(contactCtx,{provider:'priority-fields',export:'user-values',target:{...target,id:'u'}})).status,'denied');
    assert.equal((await readPublishedData(contactCtx,{provider:'priority-fields',export:'contact-values',target:{...target,organizationId:'other'}})).status,'denied');
    const wrong=await readPublishedData(contactCtx,{provider:'priority-fields',export:'contact-values',target:{scope:'project',organizationId:org,projectId:'embedded',id:'c'}});assert.equal(wrong.status,'denied');
    await assert.rejects(()=>storage.saveBranchModule(org,'default','priority_fields',{data:{entities:{unknown:[]}}}));
    await storage.saveBranchModule(org,'default','custom_fields',{data:{fields:[{...contact,private:true},user]}},{replace:true});
    await assert.rejects(()=>authorizeSourceSnapshot(contactCtx,{provider:'priority-fields',export:'contact-values',target},result));
    assert.equal((await storage.readDocument(org,'customers','c')).revision,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
