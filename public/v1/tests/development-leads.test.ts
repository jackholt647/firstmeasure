import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The dev console's Leads section (FM-552): made-up leads arrive through receiveLead, as real ones do.
test('synthetic leads arrive through receiveLead with only the chosen fields, in sandbox organizations only',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dev-leads-'));
 Object.assign(process.env,Object.fromEntries(['PLATFORM','PRICEBOOK','SIGNUP_SANDBOX','MESSAGING','CHANNELS','CALLS','CRM'].map(key=>[key+'_STORAGE_ROOT',path.join(root,key.toLowerCase())])));
 Object.assign(process.env,{FIRSTMATE_ENV:'test',NODE_ENV:'test',FIRSTMEASURE_DATA_ENVIRONMENT:'development',PLATFORM_HEARTBEAT_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1',EMAIL_OUTBOUND_DISABLED:'1',PLATFORM_SESSION_SECRET:'development-leads-test-secret'});
 const signup=await import('../signup-sandbox/service.js');await signup.ensureSeedData();
 const {authContext:ctx}=await signup.createTestInstance('swf_instant_full_org');
 const leads=await import('../development/synthetic-leads.js');
 const storage=await import('../platform/storage.js');
 const {listEventRecords}=await import('../work/storage.js');
 const all=(on:boolean)=>Object.fromEntries(leads.LEAD_FIELDS.map(f=>[f.id,on]));

 // The route: signed in, CSRF, and the sandbox gate.
 const {default:Fastify}=await import('fastify');const app=Fastify();
 const {registerSignupSandboxApi}=await import('../signup-sandbox/api.js');await app.register(registerSignupSandboxApi,{prefix:'/v1/signup-sandbox'});
 const {setPlatformAuthCookies}=await import('../platform/auth.js');let cookies:string[]=[];
 setPlatformAuthCookies({headers:{host:'localhost'},protocol:'http',socket:{encrypted:false}} as any,{header:(_name:string,value:string[])=>{cookies=value;}} as any,ctx.sessionId,ctx.csrfToken);
 const cookie=cookies.map(c=>c.split(';')[0]).join('; ');
 const url='/v1/signup-sandbox/development/synthetic-leads';
 assert.equal((await app.inject({method:'GET',url})).statusCode,401);
 const options=(await app.inject({method:'GET',url,headers:{cookie}})).json();
 assert.deepEqual(options.fields.map((f:any)=>f.id),['name','phone','email','address','source','note']);
 assert.equal((await app.inject({method:'POST',url,headers:{cookie},payload:{count:1}})).statusCode,403,'a write needs the CSRF token');
 const posted=await app.inject({method:'POST',url,headers:{cookie,'x-platform-csrf':ctx.csrfToken},payload:{count:2}});
 assert.equal(posted.statusCode,200,posted.body);
 const first=posted.json();
 assert.equal(first.created,2);
 for(const lead of first.leads){
  assert.match(lead.phone,/^\(\d{3}\) 555-01\d\d$/,'phones are reserved fictional numbers');
  assert.match(lead.email,/@example\.com$/);
  assert.ok(lead.name&&lead.address&&lead.source,JSON.stringify(lead));
  assert.ok(lead.routed||lead.new_lead,'the result says where routing put it');
  const project=await storage.readDocument(ctx.orgId,'projects',lead.project_id);
  assert.equal((project.data.lead_source as any).synthetic,true);
  assert.equal((project.data.contacts as any[]).length,1);
  assert.equal((await listEventRecords(ctx.orgId,{project_id:lead.project_id,type:'lead.received'})).length,1,'lead.received rules run');
 }
 await app.close();

 // Only the chosen fields; no source is a lead typed in by hand.
 const phoneOnly=await leads.generateSyntheticLeads(ctx,{fields:{...all(false),phone:true}});
 const lead=phoneOnly.leads[0] as any;
 assert.deepEqual([lead.name,lead.email,lead.address,lead.source],['','','','']);
 const project=await storage.readDocument(ctx.orgId,'projects',lead.project_id);
 assert.equal((project.data.lead_source as any).kind,'manual_lead');
 assert.equal(project.data.address,'');
 await assert.rejects(leads.generateSyntheticLeads(ctx,{fields:{...all(false),source:true}}),/at least/);
 await assert.rejects(leads.generateSyntheticLeads(ctx,{count:0}),/Choose/);
 await assert.rejects(leads.generateSyntheticLeads(ctx,{count:leads.MAX_LEADS+1}),/Choose/);

 // A catalog source can be chosen; a retried request makes only the missing leads.
 const {saveSourceCatalog}=await import('../crm/sources.js');
 await saveSourceCatalog(ctx.orgId,{sources:[{id:'google',label:'Google Ads',channel:'paid'},{id:'yard_signs',label:'Yard signs',channel:'other'}]});
 const request_id=crypto.randomUUID();
 const chosen=await leads.generateSyntheticLeads(ctx,{count:3,source_id:'google',request_id});
 assert.equal(chosen.created,3);
 for(const l of chosen.leads as any[]) assert.equal(((await storage.readDocument(ctx.orgId,'projects',l.project_id)).data.lead_source as any).source_id,'google');
 const retried=await leads.generateSyntheticLeads(ctx,{count:3,source_id:'google',request_id});
 assert.deepEqual([retried.created,retried.skipped],[0,3]);
 await assert.rejects(leads.generateSyntheticLeads(ctx,{source_id:'nowhere'}),/catalog/);

 // Sandbox organizations with project rights only.
 await assert.rejects(leads.generateSyntheticLeads({...ctx,permissions:{...ctx.permissions,manage_projects:false}} as any,{}),/manage_projects/);
 const real=await storage.createOrganization({name:'Not a sandbox'});
 await assert.rejects(leads.generateSyntheticLeads({...ctx,orgId:String(real.id)},{}),/sandbox/);
 const access=await (await import('../development/console.js')).devConsoleAccess(ctx);
 assert.equal(access.sections.synthetic_leads,true);
});
