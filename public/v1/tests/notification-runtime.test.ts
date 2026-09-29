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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-automation-engine-test-"));
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

test('tagged event subscription persists recipient decisions, deduplicates replay, and excludes untagged events', async()=>{
 const client=createSessionClient(),{orgId,userId}=await register(client);await createProject(client,orgId,'tag-project');
 const root=`/v1/platform/organizations/${orgId}`;
 const rule={id:'tag-proposals',intent:'Notify me for documents tagged proposal',event:'document.signed',filters:[{path:'payload.document_tags',op:'contains',value:'proposal'}],subscribe:true,methods:['in_app'],source:'return {outputs:{in_app:{decision:"send"}}};',title:'Proposal signed'};
 const saved=await client.request('PUT',root+'/notification-rules',rule);assert.equal(saved.rule.revision,1);
 const {emitWorkEvent}=await import('../work/engine.js');
 const event={organization_id:orgId,project_id:'tag-project',type:'document.signed',idempotency_key:'tagged',payload:{document_id:'doc-a',document_type:'generic',document_tags:['proposal']}};
 await emitWorkEvent(event);await emitWorkEvent(event);
 await emitWorkEvent({...event,idempotency_key:'untagged',payload:{document_id:'doc-b',document_type:'generic',document_tags:[]}});
 const list=await client.request('GET',root+'/notifications');assert.equal(list.notifications.filter((n:any)=>n.title==='Proposal signed').length,1);
 const {notificationStore}=await import('../platform/notifications/store.js');
 const rows=await notificationStore().prepare('SELECT * FROM notification_recipients WHERE organization_id=? AND user_id=?').all(orgId,userId);assert.equal(rows.length,1);assert.equal(rows[0]!.state,'planned');
 const stale=await client.raw('PUT',root+'/notification-rules',rule);assert.ok(stale.statusCode>=400);
});

test('missing required binding cannot be hidden by guest catch and backend failure releases defaults',async()=>{
 const client=createSessionClient(),{orgId,userId}=await register(client);await createProject(client,orgId,'missing-project');
 const {evaluateProgram}=await import('../platform/notifications/program.js');const {ruleSchema}=await import('../platform/notifications/contracts.js');
 const rule=ruleSchema.parse({id:'missing',intent:'Suppress push only when the published total is small',event:'document.signed',subscribe:true,methods:['in_app'],source:'try { await data.require("total"); } catch {} return {outputs:{in_app:{decision:"suppress"}}};',title:'Fallback note'});
 await assert.rejects(evaluateProgram(rule,{organizationId:orgId,userId,event:{},baseline:{in_app:{decision:'send'}},now:new Date().toISOString()}),/Required binding/);
 await client.request('PUT',`/v1/platform/organizations/${orgId}/notification-rules`,rule);
 await (await import('../work/engine.js')).emitWorkEvent({organization_id:orgId,project_id:'missing-project',type:'document.signed',idempotency_key:'missing',payload:{document_type:'generic'}});
 const result=await client.request('GET',`/v1/platform/organizations/${orgId}/notifications`);assert.ok(result.notifications.some((n:any)=>n.title==='Fallback note'));
 const audit=await client.request('GET',`/v1/platform/organizations/${orgId}/notification-rules`);assert.ok(audit.evaluations.some((e:any)=>e.decisions.some((d:any)=>d.status==='default')));
});

test('background tasks deduplicate, time out, retain audit and reject late results',async()=>{
 const client=createSessionClient(),{orgId,userId}=await register(client);
 const {registerBackgroundTask,runBackgroundTask}=await import('../agents/background.js');let calls=0;
 registerBackgroundTask('deadline_test',{inputSchema:{type:'object'},resultSchema:{type:'object'},timeoutMs:50,async execute(_input,ctx){calls++;await new Promise(r=>setTimeout(r,120));ctx.assertActive();return {status:'resolved',value:{unexpected:true}};}});
 const request={organizationId:orgId,userId,key:'same',input:{}};
 const outcomes=await Promise.all([runBackgroundTask('deadline_test',request),runBackgroundTask('deadline_test',request)]);assert.equal(calls,1);assert.ok(outcomes.every(o=>o.status==='use_default'));
 await new Promise(r=>setTimeout(r,150));
 const db=(await import('../agents/storage.js')).getAgentsDatabase();const row=await db.prepare('SELECT state,result_json FROM agent_background_tasks WHERE id=?').get(outcomes[0]!.taskId);assert.equal(row!.state,'fallback');assert.ok(!String(row!.result_json).includes('unexpected'));
});

test('quiet hours are independent per method, with an explicit exception and DST-safe release',async()=>{
 const {applyQuiet}=await import('../platform/notifications/delivery.js');const {quietUntil}=await import('../platform/notifications/contracts.js');
 const q={enabled:true,timezone:'America/Los_Angeles',start:'22:00',end:'08:00',methods:['push' as const,'sms' as const]};
 const now=new Date('2026-11-01T06:30:00Z');assert.equal(quietUntil(q,now),'2026-11-01T16:00:00.000Z');
 const result=applyQuiet({in_app:{decision:'send'},push:{decision:'send',bypass_quiet:true},sms:{decision:'send'}},{quiet_hours:q},now);
 assert.equal(result.in_app!.decision,'send');assert.equal(result.push!.decision,'send');assert.equal(result.sms!.decision,'defer');
});

test('new notifications do not broadcast accidentally; client presentation claims are recipient scoped',async()=>{
 const client=createSessionClient(),{orgId,userId}=await register(client);const {createPlatformNotification}=await import('../platform/api.js');
 await createPlatformNotification(orgId,{id:'no-audience',title:'Nobody',push:false});
 await createPlatformNotification(orgId,{id:'explicit-audience',title:'Only owner',target_user_ids:[userId],delivery_methods:['toast']});
 const result=await client.request('GET',`/v1/platform/organizations/${orgId}/notifications`);assert.ok(!result.notifications.some((n:any)=>n.id==='no-audience'));
 const note=result.notifications.find((n:any)=>n.id==='explicit-audience');assert.ok(note);
 const {acknowledgeDelivery}=await import('../platform/notifications/delivery.js');const id=note.deliveries.methods.toast.id;
 assert.equal(await acknowledgeDelivery(orgId,'other-user',id),false);
 const claimed=await Promise.all([acknowledgeDelivery(orgId,userId,id),acknowledgeDelivery(orgId,userId,id)]);assert.equal(claimed.filter(Boolean).length,1);
});

test('canonical signing events retain legacy subscription compatibility without double dispatch',async()=>{
 const {matchesWorkEvent}=await import('../work/engine.js');
 const {listWorkEventDefinitions}=await import('../work/events.js');
 assert.ok(!listWorkEventDefinitions().some(e=>e.name==='proposal.signed'));
 assert.equal(matchesWorkEvent('proposal.signed',{type:'document.signed',payload:{document_source:'proposals'}}),true);
 assert.equal(matchesWorkEvent('proposal.signed',{type:'document.signed',payload:{document_type:'generic'}}),false);
});

test('a successful model repair is versioned and reused without another model call',async()=>{
 const client=createSessionClient(),{orgId}=await register(client);await createProject(client,orgId,'repair-project');
 const {env}=await import('../src/config/env.js');const previousKey=env.openaiApiKey,originalFetch=globalThis.fetch;let calls=0;
 Object.assign(env,{openaiApiKey:'test-only-mocked-key'});
 globalThis.fetch=(async(input:any,init:any)=>{
  if(String(input)!=='https://api.openai.com/v1/responses')return originalFetch(input,init);
  calls++;return new Response(JSON.stringify({output:calls===1?[{type:'function_call',name:'submit_background_result',call_id:'repair-result',arguments:JSON.stringify({status:'resolved',source:'return {outputs:{in_app:{decision:"send"}}};',bindings:{},reason:'Remove an accidental unused required read; the intent requests ordinary in-app delivery.'})}]:[{type:'message',content:[{type:'output_text',text:'Repair proposed.'}]}],usage:{input_tokens:10,output_tokens:10}}),{status:200,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 try{
  await client.request('PUT',`/v1/platform/organizations/${orgId}/notification-rules`,{id:'repair',intent:'Send an in-app notification whenever a document is signed',event:'document.signed',subscribe:true,methods:['in_app'],source:'await data.require("accidental");return {outputs:{}};',title:'Repaired'});
  const {emitWorkEvent}=await import('../work/engine.js');
  await emitWorkEvent({organization_id:orgId,project_id:'repair-project',type:'document.signed',idempotency_key:'repair-first',payload:{document_type:'generic'}});
  const rules=await client.request('GET',`/v1/platform/organizations/${orgId}/notification-rules`);assert.equal(rules.rules[0].revision,2);assert.ok(rules.history.some((h:any)=>h.reason.includes('Background repair')));assert.equal(calls,2);
  await emitWorkEvent({organization_id:orgId,project_id:'repair-project',type:'document.signed',idempotency_key:'repair-second',payload:{document_type:'generic'}});assert.equal(calls,2);
 }finally{globalThis.fetch=originalFetch;Object.assign(env,{openaiApiKey:previousKey});}
});

test('document instances inherit multiple template tags and retain their own snapshot of labels',async()=>{
 const client=createSessionClient(),{orgId}=await register(client);await createProject(client,orgId,'document-tags');
 await enableExpandedPlatformFixture(orgId,{'platform.documents':true,'documents.templates_studio':true,'documents.advanced_definition_editing':true});
 const {FMDocModel}=await import('../documents/schemas.js');
 await client.request('POST',`/v1/documents/organizations/${orgId}/templates`,{id:'tag-template',name:'Roofing one page',document_type:'generic',tags:['Proposal','Estimate'],definition:FMDocModel.createDocument({first_page_role:'body'})});
 const created=await client.request('POST',`/v1/documents/organizations/${orgId}/projects/document-tags/documents`,{document_type:'generic',template_id:'tag-template',tags:['insurance']});
 assert.deepEqual(created.document.tags,['proposal','estimate','insurance']);
 await client.request('PATCH',`/v1/documents/organizations/${orgId}/templates/tag-template`,{tags:['changed']});
 const {readDocumentInstance}=await import('../documents/storage.js');assert.deepEqual((await readDocumentInstance(orgId,created.document.id)).tags,['proposal','estimate','insurance']);
});



test('missing nested required fields cannot silently turn a comparison into false',async()=>{
 const client=createSessionClient(),{orgId,userId}=await register(client);
 const {ruleSchema}=await import('../platform/notifications/contracts.js');const {evaluateProgram}=await import('../platform/notifications/program.js');
 const source={provider:'example',export:'value',target:{scope:'organization' as const}};
 const rule=ruleSchema.parse({id:'nested',intent:'Use the signed total',event:'document.signed',methods:['push'],bindings:{doc:{source,type:'object'}},source:'try { const doc=await data.require("doc"); return {outputs:{push:{decision:doc.total>100000?"send":"suppress"}}}; } catch { return {outputs:{push:{decision:"suppress"}}}; }'});
 await assert.rejects(evaluateProgram(rule,{organizationId:orgId,userId,event:{},baseline:{},now:new Date().toISOString()},{[JSON.stringify(source)]:{unrelated:5}},true),/Required.*missing/);
 const success=await evaluateProgram(rule,{organizationId:orgId,userId,event:{},baseline:{},now:new Date().toISOString()},{[JSON.stringify(source)]:{total:150000}},true);assert.equal(success.push?.decision,'send');
});

test('durable occurrence recovery uses the original audience and separates customer copy',async()=>{
 const client=createSessionClient(),{orgId,userId}=await register(client);
 const {persistNotificationOccurrence,drainNotifications,portalNotifications}=await import('../platform/notifications/delivery.js');
 const {upsertDocument,readDocument}=await import('../platform/storage.js');const {notificationStore}=await import('../platform/notifications/store.js');
 await upsertDocument(orgId,'customer_portals',{id:'customer',data:{status:'active'}});
 const note={id:'recover',title:'Internal pricing details',body:'Private information',branch_id:'default',broadcast:true,target_portal_ids:['customer'],customer_copy:{title:'Your document is ready',body:'Thank you'},delivery_version:2};
 await persistNotificationOccurrence(orgId,note,{});
 await upsertDocument(orgId,'users',{id:'late-user',data:{role:'owner'}});
 await drainNotifications();
 assert.ok(await readDocument(orgId,'notifications','recover'));
 const recipients=await notificationStore().prepare('SELECT user_id FROM notification_recipients WHERE organization_id=? AND notification_id=?').all(orgId,'recover');
 assert.deepEqual(recipients.map(r=>r.user_id).sort(),[userId,'portal:customer'].sort());
 assert.deepEqual(await portalNotifications(orgId,'customer'),[{id:'recover',title:'Your document is ready',body:'Thank you'}]);
 await drainNotifications();assert.equal((await notificationStore().prepare('SELECT id FROM notification_recipients WHERE organization_id=?').all(orgId)).length,2);
});

test('published notification variables remain owner scoped and revoke with their declaration',async()=>{
 const client=createSessionClient(),{orgId,userId}=await register(client);await createProject(client,orgId,'exports-project');
 const root=`/v1/platform/organizations/${orgId}`;
 const configured=await client.request('PUT',root+'/notification-rules',{id:'exports',intent:'Publish a count after signing',event:'document.signed',subscribe:true,methods:['in_app'],exports:{count:'number'},source:'return {outputs:{variables:{count:1}}};'});
 await (await import('../work/engine.js')).emitWorkEvent({organization_id:orgId,project_id:'exports-project',type:'document.signed',idempotency_key:'exports',payload:{}});
 const {backgroundAuthContext}=await import('../platform/auth.js');const {userPublicationContext}=await import('../platform/publication/context.js');
 const {readPublishedData}=await import('../platform/publication/providers.js');const context=userPublicationContext(await backgroundAuthContext(orgId,userId));
 const source={provider:'notification-rules',export:'value',target:{scope:'organization' as const,organizationId:orgId},args:{ruleId:'exports'}};
 const result=await readPublishedData(context,source);assert.equal(result.status,'ready');if(result.status==='ready')assert.deepEqual(result.value,{count:1});
 await client.request('PUT',root+'/notification-rules',{...configured.rule,exports:{}});
 const denied=await readPublishedData(context,source);assert.notEqual(denied.status,'ready');
});


test('grouping keeps in-app members but only dispatches the first interrupt',async()=>{
 const client=createSessionClient(),{orgId,userId}=await register(client);await createProject(client,orgId,'group-project');
 const root=`/v1/platform/organizations/${orgId}`;
 await client.request('PUT',root+'/notification-rules',{id:'grouped',intent:'Group proposal updates by project',event:'document.signed',subscribe:true,methods:['in_app','toast'],source:'return {outputs:{}};',group:{path:'project_id',alert:'first',window_seconds:86400}});
 const {emitWorkEvent}=await import('../work/engine.js');
 for(const id of ['first','second'])await emitWorkEvent({organization_id:orgId,project_id:'group-project',type:'document.signed',idempotency_key:id,payload:{}});
 const {notificationStore}=await import('../platform/notifications/store.js');
 const rows=await notificationStore().prepare('SELECT d.method,d.state FROM notification_deliveries d JOIN notification_recipients r ON d.recipient_id=r.id WHERE r.organization_id=? AND r.user_id=?').all(orgId,userId);
 assert.equal(rows.filter(r=>r.method==='in_app'&&r.state==='available').length,2);
 assert.equal(rows.filter(r=>r.method==='toast'&&r.state==='available').length,1);
 assert.equal(rows.filter(r=>r.method==='toast'&&r.state==='suppressed').length,1);
});
