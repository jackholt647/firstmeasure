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
  assert.deepEqual(answer.json().sections,{test_run:true,synthetic_data:true,software_layers:true,guided:true,live:true});
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
  // An ordinary organization's owner is not the audience.
  const storage=await import('../platform/storage.js');
  const devConsole=await import('../development/console.js');
  const real=await storage.createOrganization({name:'Not a sandbox'});
  await assert.rejects(devConsole.devConsoleAccess({...ctx,orgId:String(real.id)}),/development tools audience/);
  await assert.rejects(devConsole.devConsoleLive({...ctx,orgId:String(real.id)}),/development tools audience/);
 }finally{await app.close();}
});
