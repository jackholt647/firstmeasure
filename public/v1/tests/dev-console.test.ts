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
  // An ordinary organization's owner is not the audience.
  const storage=await import('../platform/storage.js');
  const devConsole=await import('../development/console.js');
  const real=await storage.createOrganization({name:'Not a sandbox'});
  await assert.rejects(devConsole.devConsoleAccess({...ctx,orgId:String(real.id)}),/development tools audience/);
  await assert.rejects(devConsole.devConsoleLive({...ctx,orgId:String(real.id)}),/development tools audience/);
  await assert.rejects(devConsole.devConsoleSetup({...ctx,orgId:String(real.id)}),/development tools audience/);
 }finally{await app.close();}
});
