import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

type Json = Record<string, any>;

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await app.inject({
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
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

type TestClient = ReturnType<typeof createSessionClient>;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-channels-test-"));
  process.env.NODE_ENV = "test";
  process.env.OPENAI_API_KEY = "test-key-no-network";
  process.env.AGENTS_STORAGE_ROOT = path.join(storageRoot,"agents");
  process.env.WORK_STORAGE_ROOT = path.join(storageRoot,"work");
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, "channels");
  process.env.CALLS_STORAGE_ROOT = path.join(storageRoot, "calls");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeChannelsDatabase } = await import("../channels/storage.js");
  const { closeCallsDatabase } = await import("../calls/storage.js");
  (await closeChannelsDatabase());
  (await closeCallsDatabase());
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await Promise.race([rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), new Promise(resolve => setTimeout(resolve,5000))]);
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner() {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `channels-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Channels Owner",
    company: "Channels Test Org",
    organization_id: `org_channels_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return { client, suffix, orgId: String(registered.organization.id), userId: String(registered.user.id) };
}

async function createOrgUser(
  owner: TestClient,
  orgId: string,
  suffix: string,
  name: string,
  options: { role?: string; permissions?: Json; field?: boolean } = {}
) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}@example.test`;
  const password = `${name} test password`;
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email,
      password,
      name,
      status: "active",
      role: options.role ?? "viewer",
      ...(options.permissions ? { org_permissions: { level: "custom", items: options.permissions } } : {}),
      send_invite: false
    }
  });
  const userId = String(created.document.id);
  if (options.field) {
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
      access_role_ids: ["crew_member"],
      application_access: {
        management: { enabled: false, role_id: "viewer", permissions: {} },
        field: { enabled: true, role_id: "crew_member", permissions: {} }
      }
    });
  }
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId, client, email };
}


test("project note designation, atomic pinning, sharing, edits and flag reversal reuse Channels", async () => {
  const {client,orgId,userId} = await registerOwner();
  const {saveCapabilityValues} = await import('../platform/capabilities.js');
  const project = (await client.request('POST',`/v1/platform/organizations/${orgId}/projects`,{data:{title:'Tray project'}})).document;
  const base = `/v1/channels/organizations/${orgId}`;
  const channel = (await client.request('POST',`${base}/channels/project/${project.id}`)).channel;
  const messages = `${base}/channels/${channel.id}/messages`;
  const plain = (await client.request('POST',messages,{text:'Ordinary channel message'})).message;
  const note = (await client.request('POST',messages,{text:'Scope needs review',project_note:true,pin:true,client_msg_id:'note-1'})).message;
  assert.equal(note.metadata.project_note,true);
  assert.ok(note.pinned_at);
  assert.equal((await client.request('GET',messages)).messages.length,2);
  await saveCapabilityValues(orgId,{'channels.separate_project_notes':true});
  const split = await client.request('GET',messages+'?limit=1');
  assert.equal(split.channel.separate_notes,true);
  assert.deepEqual(split.messages.map((row:any)=>row.id),[plain.id], 'SQL filtering happens before pagination');
  assert.deepEqual((await client.request('GET',messages+'?view=notes')).messages.map((row:any)=>row.id),[note.id]);
  assert.equal((await client.request('GET',`${base}/channels/${channel.id}/pins`)).messages.length,0);
  assert.equal((await client.request('GET',`${base}/channels/${channel.id}/pins?view=notes`)).messages[0].id,note.id);
  const hidden = (await client.request('POST',messages,{text:'New private note',project_note:true})).message;
  assert.equal((await client.request('GET',messages)).messages.length,1);
  const {backgroundAuthContext}=await import('../platform/auth.js');
  const {userPublicationContext}=await import('../platform/publication/context.js');
  const {invokeAction}=await import('../platform/publication/actions.js');
  const principal=await backgroundAuthContext(orgId,userId);
  const ctx=userPublicationContext(principal,{mode:"command",executionKind:"module",projectId:project.id});
  const action={action:"channels.note.share",target:{scope:"organization" as const,organizationId:orgId,id:hidden.id}};
  const published=await invokeAction(ctx,action,{}, {idempotencyKey:"share-one"});
  const shared=published.value as any;
  const replay=await invokeAction(ctx,action,{}, {idempotencyKey:"share-one"});
  assert.equal(replay.receipt.replayed,true);
  const wrong=userPublicationContext(principal,{mode:"command",executionKind:"module",projectId:"another-project"});
  await assert.rejects(invokeAction(wrong,action,{}, {idempotencyKey:"share-one"}),{code:"publication_project_denied"});
  assert.equal(shared.note.metadata.note_shared.message_id,shared.message.id);
  assert.match(shared.message.text,/shared a note/);
  assert.equal(shared.message.metadata.forwarded.text,'New private note');
  const again = await client.request('POST',`${base}/messages/${hidden.id}/share-note`,{});
  assert.equal(again.already_shared,true);assert.equal(again.message.id,shared.message.id);
  assert.equal((await client.request('GET',messages)).messages.length,2);
  await client.request('PATCH',`${base}/messages/${hidden.id}`,{text:'Edited project note'});
  assert.equal((await client.request('GET',`${base}/messages/${hidden.id}/revisions`)).revisions.length,1);
  await client.request('DELETE',`${base}/messages/${hidden.id}`);
  await client.request('POST',`${base}/messages/${hidden.id}/restore`,{});
  const activity = await client.request('GET',`/v1/work/organizations/${orgId}/projects/${project.id}/activity`);
  assert.ok(activity.events.some((event:any)=>event.type==='project.note.created'));
  assert.ok(activity.events.some((event:any)=>event.type==='project.note.shared'));
  assert.ok(activity.events.some((event:any)=>event.type==='project.note.edited'));
  assert.ok(activity.events.every((event:any)=>!event.type.startsWith('channels.message.')));
  await saveCapabilityValues(orgId,{'channels.separate_project_notes':false});
  assert.equal((await client.request('GET',messages)).messages.length,4);
  assert.equal((await client.request('GET',messages)).channel.separate_notes,false);
  const publicChannel=(await client.request('POST',`${base}/channels`,{type:'public',name:'Other channel'})).channel;
  assert.equal((await client.raw('POST',`${base}/channels/${publicChannel.id}/messages`,{text:'Not a project',project_note:true})).statusCode,400);
  const crew=await createOrgUser(client,orgId,'restricted','Crew Reader',{field:true});
  const restricted=(await client.request('POST',messages,{text:'Office only',project_note:true,audience:['office']})).message;
  assert.equal((await crew.client.raw('POST',`${base}/messages/${restricted.id}/share-note`,{})).statusCode,404);
  assert.equal((await crew.client.raw('POST',`${base}/messages/${restricted.id}/pin`,{})).statusCode,404);
});

test("project assistant uses the global agent with personal durable threads and fresh authorization", async () => {
  const {client,orgId,suffix} = await registerOwner();
  const project = (await client.request('POST',`/v1/platform/organizations/${orgId}/projects`,{data:{title:'Scope focused project'}})).document;
  const base=`/v1/assistant/organizations/${orgId}`;
  const [first,second]=await Promise.all([client.request('POST',`${base}/projects/${project.id}/conversation`,{}),client.request('POST',`${base}/projects/${project.id}/conversation`,{})]);
  assert.equal(first.thread.id,second.thread.id);
  assert.equal(first.thread.agent_id,'assistant');
  assert.equal(first.thread.subject_id,`project:${project.id}`);
  const other=await createOrgUser(client,orgId,suffix,'Project Reader',{permissions:{view_projects:true,use_assistant:true}});
  const theirs=await other.client.request('POST',`${base}/projects/${project.id}/conversation`,{});
  assert.notEqual(first.thread.id,theirs.thread.id);
  assert.equal((await other.client.raw('GET',`${base}/threads/${first.thread.id}`)).statusCode,404);
  const calls:any[]=[];const original=globalThis.fetch;
  globalThis.fetch=(async (_url:any,options:any)=>{
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'Review the current scope.'}]}]}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  try {
    await client.request('POST',`${base}/threads/${first.thread.id}/messages`,{message:'What needs attention?'});
    assert.match(JSON.stringify(calls[0]),/private project conversation/);
    assert.match(JSON.stringify(calls[0]),/Scope focused project/);
    assert.match(JSON.stringify(calls[0]),/get_project/);
    const {saveCapabilityValues}=await import('../platform/capabilities.js');
    await saveCapabilityValues(orgId,{'apps.assistant':false});
    const count=calls.length;
    assert.equal((await client.raw('POST',`${base}/threads/${first.thread.id}/messages`,{message:'Read project'})).statusCode,403);
    assert.equal((await client.raw('POST',`/v1/agents/organizations/${orgId}/agents/assistant/threads/${first.thread.id}/messages`,{message:'Bypass project context',subject_id:'unscoped'})).statusCode,403);
    assert.equal(calls.length,count);
  } finally {globalThis.fetch=original;}
});
