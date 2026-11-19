import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// The dev console endpoint (development/console.ts): who sees the tray, its sections, and the live layer's owners.
test('the dev console answers the development tools audience with its sections and the live layer, and nobody else',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dev-console-'));
 Object.assign(process.env,Object.fromEntries(['PLATFORM','PRICEBOOK','SIGNUP_SANDBOX','MESSAGING','CHANNELS','CALLS'].map(key=>[key+'_STORAGE_ROOT',path.join(root,key.toLowerCase())])));
 Object.assign(process.env,{FIRSTMATE_ENV:'test',NODE_ENV:'test',FIRSTMEASURE_DATA_ENVIRONMENT:'development',PLATFORM_HEARTBEAT_DISABLED:'1',EMAIL_OUTBOUND_DISABLED:'1',PLATFORM_SESSION_SECRET:'dev-console-test-secret',FIRSTMEASURE_LIVE_ASSETS_DIR:path.join(root,'live'),FIRSTMEASURE_DEV_PUSH_STATUS:path.join(root,'dev-push','status.json')});
 const signup=await import('../signup-sandbox/service.js');await signup.ensureSeedData();
 const {authContext:ctx}=await signup.createTestInstance('swf_instant_full_org');
 const {default:Fastify}=await import('fastify');const app=Fastify();
 const {registerSignupSandboxApi}=await import('../signup-sandbox/api.js');await app.register(registerSignupSandboxApi,{prefix:'/v1/signup-sandbox'});
 const {setPlatformAuthCookies}=await import('../platform/auth.js');let cookies:string[]=[];
 setPlatformAuthCookies({headers:{host:'localhost'},protocol:'http',socket:{encrypted:false}} as any,{header:(_name:string,value:string[])=>{cookies=value;}} as any,ctx.sessionId,ctx.csrfToken);
 const cookie=cookies.map(c=>c.split(';')[0]).join('; ');
 try{
  assert.equal((await app.inject({method:'GET',url:'/v1/signup-sandbox/development/console'})).statusCode,401);
  const answer=await app.inject({method:'GET',url:'/v1/signup-sandbox/development/console',headers:{cookie}});
  assert.equal(answer.statusCode,200,answer.body);
  assert.deepEqual(answer.json().sections,{setup:true,test_run:true,synthetic_data:true,synthetic_leads:true,software_layers:true,guided:true,live:true});
  assert.equal(answer.json().organization.sandbox,true);
  // The live layer as the receiver's manifest has it: each file with the checkout that put it there.
  const {mkdir}=await import('node:fs/promises');await mkdir(path.join(root,'live'),{recursive:true});
  assert.deepEqual((await app.inject({method:'GET',url:'/v1/signup-sandbox/development/console/live',headers:{cookie}})).json().files,[],'no manifest, nothing live');
  await writeFile(path.join(root,'live','manifest.json'),JSON.stringify({gen:7,at:'2026-10-27T12:00:00Z',files:{'libraries/x.js':{sha:'abc',base:'def',source:'Laptop:C:/code',at:1761566400}},retired:{'libraries/y.css':{reason:'released',gen:6}}}));
  const live=(await app.inject({method:'GET',url:'/v1/signup-sandbox/development/console/live',headers:{cookie}})).json();
  assert.deepEqual([live.gen,live.files,live.retired],[7,[{path:'libraries/x.js',sha:'abc',source:'Laptop:C:/code',at:1761566400}],[{path:'libraries/y.css',reason:'released',gen:6}]]);
  // The dev push router's status on the platform stream: the document once, then each rewrite.
  const {mkdir:makeDir,rename}=await import('node:fs/promises');await makeDir(path.join(root,'dev-push'),{recursive:true});
  await writeFile(path.join(root,'dev-push','status.json'),JSON.stringify({v:1,router:{paused:true},lanes:{},submissions:[],releases:[]}));
  const realtime=await import('../platform/realtime.js');
  (await import('../development/dev-push-status.js')).registerDevPushChannel();
  const streamUrl=`/v1/platform/organizations/${ctx.orgId}/events/stream`,stream={url:streamUrl,routeOptions:{url:'/v1/platform/organizations/:orgId/events/stream'},params:{orgId:ctx.orgId},protocol:'http',socket:{encrypted:false}};
  const request={...stream,headers:{cookie,host:'localhost'}} as any;
  const [channel]=await realtime.resolveRealtimeChannels(request,ctx.orgId,['dev-push'],{});
  assert.ok(channel?.open,JSON.stringify(channel));
  const sent:any[]=[];const stop=await channel.open!((event,data)=>sent.push([event,data]),()=>{});
  assert.deepEqual(sent,[['status',{v:1,router:{paused:true},lanes:{},submissions:[],releases:[]}]]);
  await writeFile(path.join(root,'dev-push','status.tmp'),JSON.stringify({v:1,router:{paused:false},lanes:{platform:{state:'testing'}},submissions:[],releases:[]}));
  await rename(path.join(root,'dev-push','status.tmp'),path.join(root,'dev-push','status.json'));
  for(let i=0;i<40&&sent.length<2;i++)await new Promise(r=>setTimeout(r,100));
  assert.deepEqual(sent.at(-1),['status',{v:1,router:{paused:false},lanes:{platform:{state:'testing'}},submissions:[],releases:[]}]);
  stop();
  const outsider={...stream,headers:{host:'localhost'}} as any;
  assert.ok((await realtime.resolveRealtimeChannels(outsider,ctx.orgId,['dev-push'],{}))[0]!.error,'signed out: refused');
  // Setup (FM-571): every setup step and guided setup, how far this organization got and where each was done.
  const setupState=async()=>{const r=await app.inject({method:'GET',url:'/v1/signup-sandbox/development/console/setup',headers:{cookie}});assert.equal(r.statusCode,200,r.body);return r.json();};
  const stepOf=(state:any,id:string)=>state.steps.find((s:any)=>s.id===id),guideOf=(state:any,id:string)=>state.guides.find((g:any)=>g.id===id);
  let state=await setupState();
  assert.ok(stepOf(state,'company.type'),'the company type question is listed');
  assert.equal(stepOf(state,'company.type').status,'not_started');
  assert.equal(stepOf(state,'company.type').last,null);
  assert.ok(stepOf(state,'company.services').asked_by.includes('Set up Operations'),'a step lists the setups that ask it, through what it requires');
  assert.deepEqual([guideOf(state,'operations.setup').group,guideOf(state,'operations.setup').status],['setup','not_started']);
  assert.equal(guideOf(state,'docs.tab_tutorial').group,'tour');
  assert.ok(!state.guides.some((g:any)=>g.id.startsWith('setup_step.')),'a step played on its own is listed as the step, not as a setup');
  const service=await import('../guided-experiences/service.js');
  (await import('../guided-experiences/registry.js')).registerExperienceForTests({id:'test.fm571_setup',version:1,kind:'modal',scope:'organization',title:{key:'gx_test_fm571',text:'Test setup'},variants:[{id:'a',weight:1}],triggers:[{kind:'manual'}],requires:['company.type','company.services'],steps:[]});
  await service.recordGuidedEvent(ctx,'test.fm571_setup',{type:'start'});
  await service.recordGuidedEvent(ctx,'test.fm571_setup',{type:'step_view',step_id:'company.type'});
  state=await setupState();
  assert.equal(stepOf(state,'company.type').status,'started','asked, not answered');
  assert.deepEqual([stepOf(state,'company.type').last.experience_title,stepOf(state,'company.type').last_type],['Test setup','step_view']);
  assert.deepEqual([guideOf(state,'test.fm571_setup').status,guideOf(state,'test.fm571_setup').step.title],['started','What kind of company are you?']);
  const {invokeAction}=await import('../platform/publication/actions.js'),{userPublicationContext}=await import('../platform/publication/context.js');
  await invokeAction(userPublicationContext(ctx,{mode:'command'}),{action:'company-profile.save',target:{scope:'organization',organizationId:ctx.orgId}},{company_type:'roofing_contractor'},{idempotencyKey:'fm571-type'});
  await service.recordGuidedEvent(ctx,'test.fm571_setup',{type:'step_done',step_id:'company.type'});
  await service.recordGuidedEvent(ctx,'test.fm571_setup',{type:'step_skip',step_id:'company.services'});
  state=await setupState();
  assert.equal(stepOf(state,'company.type').status,'done');
  assert.deepEqual([stepOf(state,'company.type').answered_in.experience_id,stepOf(state,'company.type').answered_in.experience_title],['test.fm571_setup','Test setup'],'where it was answered');
  assert.ok(stepOf(state,'company.type').answered_in.by,'and by whom');
  assert.equal(stepOf(state,'company.services').status,'skipped');
  // An answer no guided setup saved (Settings, signup, an agent) is done with nowhere to point at.
  await invokeAction(userPublicationContext(ctx,{mode:'command'}),{action:'company-profile.save',target:{scope:'organization',organizationId:ctx.orgId}},{services:['gutters']},{idempotencyKey:'fm571-services'});
  state=await setupState();
  assert.deepEqual([stepOf(state,'company.services').status,stepOf(state,'company.services').answered_in,stepOf(state,'company.services').last_type],['done',null,'step_skip']);
  await service.recordGuidedEvent(ctx,'test.fm571_setup',{type:'dismiss',step_id:'company.services'});
  assert.equal(guideOf(await setupState(),'test.fm571_setup').status,'skipped');
  // Setup tests: a step is asked again even when answered, saved for real, and rolled back to before the first test.
  const post=async(url:string)=>{const r=await app.inject({method:'POST',url,headers:{cookie,'x-platform-csrf':ctx.csrfToken},payload:{}});assert.equal(r.statusCode,200,r.body);return r.json();};
  const profile=async()=>(await import('../company-profile/profile.js')).readCompanyProfile(ctx.orgId);
  const steps='/v1/signup-sandbox/development/console/setup/steps';
  assert.equal((await profile()).company_type,'roofing_contractor');
  const started=await post(`${steps}/company.type/test`);
  assert.deepEqual(started.experience.steps.map((s:any)=>s.id),['company.type'],'answered, and still asked');
  assert.equal(started.experience.steps[0].setup_step.id,'company.type');
  assert.equal(started.test.status,'open');
  await invokeAction(userPublicationContext(ctx,{mode:'command'}),{action:'company-profile.save',target:{scope:'organization',organizationId:ctx.orgId}},{company_type:'other',company_type_other:'Chimney sweep'},{idempotencyKey:'fm571-test-1'});
  await service.recordGuidedEvent(ctx,'setup_step.company.type',{type:'step_done',step_id:'company.type'});
  const ended=await post(`${steps}/company.type/test/end`);
  assert.deepEqual(ended.test.changes.filter((c:any)=>c.module==='company_profile').map((c:any)=>c.key).sort(),['company_type','company_type_other']);
  state=await setupState();
  assert.equal(stepOf(state,'company.type').answered_in.on_its_own,true,'a test answers the step on its own');
  assert.equal(stepOf(state,'company.type').test.tests,1);
  // A second test keeps the value from before the first.
  await post(`${steps}/company.type/test`);
  await invokeAction(userPublicationContext(ctx,{mode:'command'}),{action:'company-profile.save',target:{scope:'organization',organizationId:ctx.orgId}},{company_type:'gutter_contractor'},{idempotencyKey:'fm571-test-2'});
  const rolled=await post(`${steps}/company.type/rollback`);
  assert.ok(rolled.restored.includes('company_profile.company_type'));
  assert.ok(rolled.events>=1,'the test\'s events are forgotten');
  assert.deepEqual([(await profile()).company_type,(await profile()).company_type_other],['roofing_contractor',null],'back to before the first test');
  state=await setupState();
  assert.equal(stepOf(state,'company.type').test,null);
  assert.equal(stepOf(state,'company.type').answered_in.experience_id,'test.fm571_setup','where it was answered before the test');
  // A step nobody answered: a test answers it, roll back leaves it unanswered again.
  (await import('../guided-experiences/setup-steps.js')).registerSetupStepForTests({id:'test.fm571_workforce',version:1,title:{key:'gx_test_fm571_w',text:'Who works?'},description:{key:'gx_test_fm571_wd',text:'W'},ui:{widget:'brand-cards'},satisfied:{provider:'company-profile',export:'profile',path:'/answered/workforce'},writes:{action:'company-profile.save'}});
  assert.equal(stepOf(await setupState(),'test.fm571_workforce').status,'not_started');
  assert.deepEqual((await post(`${steps}/test.fm571_workforce/test`)).experience.steps.map((s:any)=>s.id),['test.fm571_workforce']);
  await invokeAction(userPublicationContext(ctx,{mode:'command'}),{action:'company-profile.save',target:{scope:'organization',organizationId:ctx.orgId}},{workforce:'crews'},{idempotencyKey:'fm571-test-3'});
  assert.equal(stepOf(await setupState(),'test.fm571_workforce').status,'done');
  await post(`${steps}/test.fm571_workforce/rollback`);
  assert.equal((await profile()).answered.workforce,false,'as if it was never answered');
  assert.equal(stepOf(await setupState(),'test.fm571_workforce').status,'not_started');
  assert.equal((await app.inject({method:'POST',url:`${steps}/company.type/rollback`,headers:{cookie,'x-platform-csrf':ctx.csrfToken},payload:{}})).statusCode,404,'nothing to roll back');
  assert.equal((await app.inject({method:'POST',url:`${steps}/company.type/test`,headers:{cookie},payload:{}})).statusCode,403,'writes need the CSRF token');
  // What drives what (GP-16): every setup and question, evaluated for a company type picked in the console.
  (await import('../guided-experiences/registry.js')).registerExperienceForTests({id:'test.gp16_setup',version:1,kind:'modal',scope:'organization',title:{key:'gx_test_gp16',text:'Trade setup'},
   eligibility:{when:{field:'organization.industry_sets',operator:'not_contains',value:'nothing_here'}},triggers:[{kind:'tab_opened',tab:'project.materials'}],requires:['company.type'],
   variants:[{id:'roofing',weight:1,when:{field:'organization.industry_sets',operator:'contains',value:'roofing_exteriors'},steps:['ask']},{id:'other',weight:1,when:{field:'organization.industry_sets',operator:'not_contains',value:'roofing_exteriors'}}],
   steps:[{id:'ask',widget:'brand-cards',title:{key:'gx_test_gp16_ask',text:'Ask'},requires:['company.services'],next:{branches:[{when:{field:'selections.kind',operator:'equals',value:'x'},to:'more'}],otherwise:'more'}},{id:'more',widget:'brand-cards',title:{key:'gx_test_gp16_more',text:'More'}}],
   completion:{screen:'none',then:[{play:'docs.tab_tutorial'}]}});
  const drivers=async(type='')=>{const r=await app.inject({method:'GET',url:`/v1/signup-sandbox/development/console/setup/drivers${type?`?company_type=${type}`:''}`,headers:{cookie}});assert.equal(r.statusCode,200,r.body);return r.json();};
  const setupIn=(graph:any)=>graph.setups.find((s:any)=>s.id==='test.gp16_setup');
  let graph=await drivers();
  assert.deepEqual([graph.company.shown,graph.company.actual.company_type,graph.company.actual.industry,graph.company.actual.industry_sets],['actual','roofing_contractor','roofing',['roofing_exteriors']],'this organization as it is: a roofer');
  assert.deepEqual(setupIn(graph).variants.filter((v:any)=>v.chosen).map((v:any)=>v.id),['roofing'],'a roofer gets the roofing variant');
  assert.deepEqual(setupIn(graph).variants.find((v:any)=>v.id==='roofing').steps,['ask']);
  assert.deepEqual(setupIn(graph).variants.find((v:any)=>v.id==='roofing').when.rules[0],{field:'organization.industry_sets',operator:'contains',expected:'roofing_exteriors',actual:['roofing_exteriors'],matched:true});
  assert.deepEqual([setupIn(graph).requires,setupIn(graph).pages[0].requires,setupIn(graph).then,setupIn(graph).triggers[0].on],[['company.type'],['company.services'],['docs.tab_tutorial'],'project.materials']);
  assert.deepEqual(setupIn(graph).pages[0].branches.map((b:any)=>b.to),['more','more']);
  const typeQuestion=graph.questions.find((q:any)=>q.id==='company.type'),servicesQuestion=graph.questions.find((q:any)=>q.id==='company.services');
  assert.deepEqual([typeQuestion.depth,servicesQuestion.depth,servicesQuestion.requires],[0,1,['company.type']]);
  assert.ok(typeQuestion.sets.includes('organization.industry_sets')&&servicesQuestion.sets.includes('organization.services'),'which company facts each question sets');
  graph=await drivers('plumbing_contractor');
  assert.deepEqual([graph.company.shown,graph.company.as_shown.industry,graph.company.as_shown.industry_sets,graph.company.actual.company_type],['plumbing_contractor','plumbing',[],'roofing_contractor'],'only the shown company changes');
  assert.deepEqual(setupIn(graph).variants.filter((v:any)=>v.chosen).map((v:any)=>v.id),['other'],'a plumber gets the other variant');
  assert.equal((await drivers('space_station')).company.shown,'actual','an unknown type shows this organization');
  const column=(key:string)=>graph.matrix.columns.findIndex((c:any)=>c.key===key),row=graph.matrix.rows.find((r:any)=>r.id==='test.gp16_setup');
  assert.deepEqual([row.cells[column('exterior_remodeler')].variants,row.cells[column('hvac_contractor')].variants,row.cells[column('none')].variants,row.cells[column('other')].offered],[['roofing'],['other'],['other'],true],'every company type at once');
  const catalog=await import('../company-profile/catalog.js');
  assert.deepEqual([catalog.industrySetsFor('exteriors'),catalog.industrySetsFor('roofing_and_exteriors'),catalog.industrySetsFor('hvac'),catalog.industrySetsFor('')],[['roofing_exteriors'],['roofing_exteriors'],[],[]]);
  // A condition naming a set, type or service the catalog does not have is refused when saved.
  const {catalogConditionErrors}=await import('../guided-experiences/library-checks.js');
  assert.deepEqual(catalogConditionErrors({variants:[{when:{match:'any',rules:[{field:'organization.industry_sets',operator:'contains',value:'roofing_exterior'},{field:'organization.company_type',operator:'in',value:['roofing_contractor','other','roofer']}]}}],eligibility:{when:{'organization.services':['gutters','gutterz']}}}).length,3);
  assert.deepEqual(catalogConditionErrors({when:{field:'organization.industry_sets',operator:'contains',value:'roofing_exteriors'}}),[]);
  // An ordinary organization's owner is not the audience.
  const storage=await import('../platform/storage.js');
  const devConsole=await import('../development/console.js');
  const real=await storage.createOrganization({name:'Not a sandbox'});
  await assert.rejects(devConsole.devConsoleAccess({...ctx,orgId:String(real.id)}),/development tools audience/);
  await assert.rejects(devConsole.devConsoleLive({...ctx,orgId:String(real.id)}),/development tools audience/);
  await assert.rejects(devConsole.devConsoleSetup({...ctx,orgId:String(real.id)}),/development tools audience/);
  await assert.rejects(devConsole.devConsoleSetupTest({...ctx,orgId:String(real.id)},'company.type','start'),/development tools audience/);
  await assert.rejects(devConsole.devConsoleSetupDrivers({...ctx,orgId:String(real.id)},''),/development tools audience/);
 }finally{await app.close();}
});
