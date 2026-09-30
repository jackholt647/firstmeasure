import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || "", csrfCookie || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-notification-ownership-test-"));
  process.env.NODE_ENV = "test";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Automation Engine Test Co",
    organization_id: `org_engine_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string, userId: data.user?.id as string };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Engine Test Project", address: "1 Engine Way", events: [] },
    metadata: { kind: "platform_project" }
  });
}


async function member(org:string,id:string,personal=true){
 const storage=await import('../platform/storage.js'),{createHmac}=await import('node:crypto'),{env}=await import('../src/config/env.js');
 const identity=await storage.createIdentity({email:`${id}-${org}@example.test`,name:id});
 await storage.addIdentityMembership(String(identity.id),org,id,'viewer');
 const grants={view_projects:true,view_documents:true,manage_own_notifications:personal,manage_notification_defaults:false};
 await storage.upsertDocument(org,'users',{id,data:{identity_id:identity.id,email:identity.email,status:'active',org_permissions:{level:'custom',items:grants},permission_overrides:grants}});
 const session=await storage.createAuthSession({identity_id:identity.id,organization_id:org,user_id:id,role:'viewer'});
 const signature=createHmac('sha256',env.platformSessionSecret).update(session.sessionId).digest('base64url');
 const raw=(method:string,url:string,payload?:unknown)=>app.inject({method,url,payload,headers:{cookie:`fm_platform_session=${session.sessionId}.${signature}`,'x-platform-csrf':String(session.session.csrf_token)}});
 return {raw,request:async(method:string,url:string,payload?:unknown)=>{const response=await raw(method,url,payload);assert.ok(response.statusCode<400,`${method} ${url}: ${response.statusCode} ${response.body}`);return response.json();}};
}

test('organization defaults seed independent personal configurations and private copies of programs',async()=>{
 const owner=createSessionClient(),{orgId,userId}=await register(owner),root=`/v1/platform/organizations/${orgId}`;
 const initialized=await owner.request('POST',root+'/notification-configuration',{});assert.equal(initialized.revision,1);
 const rule=await owner.request('POST',root+'/notification-registrations',{event:'document.signed',title:'Our signatures',methods:['in_app']});
 await owner.request('PATCH',root+'/notification-configuration',{revision:1,definitions:[{key:'tasks',label:'Our tasks'}]});
 await owner.request('PUT',root+'/notification-defaults',{revision:0});
 const alice=await member(orgId,'alice');await alice.request('POST',root+'/notification-configuration',{});
 const {readPersonalConfiguration}=await import('../platform/notifications/defaults.js'),{listRules}=await import('../platform/notifications/store.js');
 const initial=await readPersonalConfiguration(orgId,'alice');assert.equal(initial!.defaults_revision,1);assert.equal(initial!.catalog.flatMap(g=>g.definitions).find(d=>d.key==='tasks')?.label,'Our tasks');
 assert.equal((await listRules(orgId,'alice'))[0]?.source,rule.rule.source);
 await owner.request('PUT',root+'/notification-rules',{...rule.rule,title:'New signatures',source:'return {outputs:{in_app:{decision:"suppress"}}};'});
 await owner.request('PATCH',root+'/notification-configuration',{revision:2,definitions:[{key:'tasks',label:'New tasks'}]});
 await owner.request('PUT',root+'/notification-defaults',{revision:1});
 assert.deepEqual(await readPersonalConfiguration(orgId,'alice'),initial);assert.equal((await listRules(orgId,'alice'))[0]?.title,'Our signatures');
 const bob=await member(orgId,'bob');await bob.request('POST',root+'/notification-configuration',{});
 assert.equal((await readPersonalConfiguration(orgId,'bob'))!.defaults_revision,2);assert.equal((await listRules(orgId,'bob'))[0]?.title,'New signatures');
 await alice.request('PATCH',root+'/notification-configuration',{revision:1,remove_keys:['tasks']});
 assert.equal((await readPersonalConfiguration(orgId,userId))!.catalog.flatMap(g=>g.definitions).find(d=>d.key==='tasks')?.label,'New tasks');
 assert.equal((await alice.raw('PUT',root+'/notification-defaults',{revision:2})).statusCode,403);
});

test('live full locks override direct preference bypass; removal locks allow delivery edits but forbid deletion',async()=>{
 const owner=createSessionClient(),{orgId}=await register(owner),root=`/v1/platform/organizations/${orgId}`;
 await owner.request('POST',root+'/notification-configuration',{});
 const alice=await member(orgId,'lock-user');await alice.request('POST',root+'/notification-configuration',{});
 await owner.request('PATCH',root+'/notification-locks',{revision:0,key:'tasks',mode:'full'});
 assert.equal((await alice.raw('PATCH',root+'/notification-preferences',{email:{tasks:true}})).statusCode,403);
 assert.equal((await alice.raw('PATCH',root+'/notification-configuration',{revision:1,remove_keys:['tasks']})).statusCode,403);
 const storage=await import('../platform/storage.js'),user=await storage.readDocument(orgId,'users','lock-user');
 await storage.upsertDocument(orgId,'users',{id:user.id,data:{...user.data,notification_preferences:{email:{tasks:true}}},metadata:user.metadata,expected_revision:user.revision},{replace:true});
 const {effectivePreferences}=await import('../platform/notifications/configuration.js');
 const effective=await effectivePreferences(orgId,'lock-user','default',{email:{tasks:true}});assert.equal((effective.email as any).tasks,false);
 await owner.request('PATCH',root+'/notification-preferences',{email:{tasks:true}}); // administrator override
 await owner.request('PATCH',root+'/notification-locks',{revision:1,key:'tasks',mode:'removal'});
 await alice.request('PATCH',root+'/notification-preferences',{email:{tasks:true}});
 assert.equal((await alice.raw('PATCH',root+'/notification-configuration',{revision:1,remove_keys:['tasks']})).statusCode,403);
 await owner.request('PATCH',root+'/notification-locks',{revision:2,key:'tasks',mode:'unlocked'});
 await alice.request('PATCH',root+'/notification-configuration',{revision:1,remove_keys:['tasks']});
});

test('personal permission denial blocks API and assistant configuration entry points while allowing reads',async()=>{
 const owner=createSessionClient(),{orgId}=await register(owner),root=`/v1/platform/organizations/${orgId}`;
 const denied=await member(orgId,'denied',false);await denied.request('POST',root+'/notification-configuration',{});
 await denied.request('GET',root+'/notification-rules');
 const attempts:[string,string,unknown][]=[['PATCH','/notification-preferences',{email:{tasks:true}}],['PATCH','/notification-configuration',{revision:1,remove_keys:['tasks']}],['POST','/notification-registrations',{event:'document.signed',methods:['in_app']}],['PATCH','/notification-quiet-hours',{enabled:true,timezone:'UTC',start:'22:00',end:'07:00',methods:['push']}],['PATCH','/notification-locks',{revision:0,key:'tasks',mode:'full'}]];
 for(const [method,suffix,payload] of attempts){const response=await denied.raw(method,root+suffix,payload);assert.equal(response.statusCode,403,`${suffix}: ${response.body}`);}
 const {backgroundAuthContext}=await import('../platform/auth.js'),{configureRule}=await import('../platform/notifications/api.js');
 const auth=await backgroundAuthContext(orgId,'denied');
 await assert.rejects(()=>configureRule(orgId,auth,{id:'assistant-denied',intent:'Should not save',event:'document.signed',source:'return {outputs:{}};',methods:['in_app']}),/cannot change/);
});

test('custom rule locks apply to existing members and preserve editable delivery under removal protection',async()=>{
 const owner=createSessionClient(),{orgId}=await register(owner),root=`/v1/platform/organizations/${orgId}`;
 await owner.request('POST',root+'/notification-configuration',{});
 const alice=await member(orgId,'rule-lock-user');await alice.request('POST',root+'/notification-configuration',{});
 const created=await owner.request('POST',root+'/notification-registrations',{event:'document.signed',title:'Required signature',methods:['in_app']});
 const id=created.rule.id;
 await owner.request('PATCH',root+'/notification-locks',{revision:0,key:'rule:'+id,mode:'full'});
 const shown=await alice.request('GET',root+'/notification-rules');const rule=shown.rules.find((r:any)=>r.id===id);assert.ok(rule);assert.equal(shown.rule_locks[id],'full');
 assert.equal((await alice.raw('PUT',root+'/notification-rules',{...rule,title:'Overridden'})).statusCode,403);
 assert.equal((await alice.raw('DELETE',root+'/notification-rules/'+id,{revision:rule.revision})).statusCode,403);
 const {effectiveRules}=await import('../platform/notifications/configuration.js');assert.equal((await effectiveRules(orgId,'rule-lock-user')).find(r=>r.id===id)?.title,'Required signature');
 await owner.request('PATCH',root+'/notification-locks',{revision:1,key:'rule:'+id,mode:'removal'});
 const key=(await import('../platform/notification_catalog.js')).workflowPreferenceKey('default','personal-notification-rules','rule-lock-user:'+id);
 await alice.request('PATCH',root+'/notification-preferences',{email:{[key]:true}});
 assert.equal((await alice.raw('PUT',root+'/notification-rules',{...rule,enabled:false})).statusCode,403);
 const edited=await alice.request('PUT',root+'/notification-rules',{...rule,quiet_exempt_methods:['in_app']});
 assert.deepEqual(edited.rule.quiet_exempt_methods,['in_app']);
 assert.equal((await alice.raw('DELETE',root+'/notification-rules/'+id,{revision:edited.rule.revision})).statusCode,403);
 await owner.request('DELETE',root+'/notification-rules/'+id,{revision:created.rule.revision});
 const policy=await owner.request('GET',root+'/notification-defaults');assert.ok(policy.locks.some((lock:any)=>lock.key==='rule:'+id));
 await owner.request('PATCH',root+'/notification-locks',{revision:policy.locks_revision,key:'rule:'+id,mode:'unlocked'});
 await alice.request('DELETE',root+'/notification-rules/'+id,{revision:edited.rule.revision});
 const history=await alice.request('GET',root+'/notification-rules');assert.ok(history.history.some((item:any)=>item.reason==='Organization protection updated'));
});
