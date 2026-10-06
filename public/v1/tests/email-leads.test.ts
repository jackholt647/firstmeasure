import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";
let originalFetch: typeof globalThis.fetch;

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
        "x-email-webhook-token":"email-test-token",
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
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

async function seedAppFlagDefaults(platformRoot: string) {
  const configDir = path.join(platformRoot, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "app_flag_defaults.json"), JSON.stringify({
    data: {
      app_flags: {
        platform: { lead_import: true, website_embed_import: true, scheduling: true },
        email: { inbound_lead_import: true },
        lead_forms: { appointment_form: true, instant_estimate: true }
      }
    }
  }));
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-email-test-"));
  process.env.NODE_ENV = "test";
  process.env.FIRSTMEASURE_JOB_WORKERS="0";
  process.env.EMAIL_INBOUND_WEBHOOK_TOKEN="email-test-token";
  if(process.env.TEST_POSTGRES_URL)Object.assign(process.env,{FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"postgres",DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_AUTO_MIGRATE:"true",FIRSTMEASURE_ARTIFACT_STORAGE:"local"});
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.EMAIL_LEAD_AI_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  await seedAppFlagDefaults(process.env.PLATFORM_STORAGE_ROOT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://maps.googleapis.com/") || url.startsWith("https://solar.googleapis.com/")) {
      throw new TypeError("fetch failed");
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (app) await app.close();
  await closePlatformFixtureStores();
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
    company: "Email Lead Test Org",
    organization_id: `org_email_${suffix}`,
    global: {
      app_flags: {
        platform: { lead_import: true, website_embed_import: true, scheduling: true },
        email: { inbound_lead_import: true },
        lead_forms: { appointment_form: true, instant_estimate: true }
      }
    }
  });
  await enableExpandedPlatformFixture(data.organization.id,{"apps.notifications":true,"platform.lead_import":true,"email.inbound_lead_import":true});
  return { orgId: data.organization.id as string };
}

test("FirstMate Mail inbound lead email creates project contacts and notification", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const { saveBranchModule } = await import("../platform/storage.js");
  const legacyInboundEmail = "leads-default-legacy@1m8.ai";
  await saveBranchModule(orgId, "default", "lead_import", {
    data: { enabled: true, inbound_email: legacyInboundEmail }
  }, { replace: true });
  const settings = await client.request("GET", `/v1/email/organizations/${orgId}/branch/default/lead-import`);
  const inboundEmail = settings.settings.inbound_email;
  assert.match(inboundEmail, /@firstmatemail\.com$/);
  assert.deepEqual(settings.settings.legacy_inbound_emails, [legacyInboundEmail]);

  const inbound = await client.request("POST", "/v1/email/inbound/events", {
    provider: "ses",
    provider_event_id: "ses-lead-test-message-1",
    from: { address: "leads@example-provider.test", name: "Example Provider" },
    to: [{ address: inboundEmail, name: "Inbound Leads" }],
    subject: "New roofing lead - Jane Homeowner",
    text: [
      "Name: Jane Homeowner",
      "Phone: (555) 222-3333",
      "Email: jane@example.test",
      "Address: 123 Cedar Street, Boise, ID 83702"
    ].join("\n"),
    headers: { message_id: "ses-lead-test-message-1" }
  });

  assert.equal(inbound.accepted, true);
  assert.equal(inbound.project.data.work_projection.active_instances[0].template_id, "sales_pipeline");
  assert.equal(inbound.project.data.work_projection.active_instances[0].stage_id, "new_lead_stage");
  assert.equal(inbound.project.data.address, "123 Cedar Street, Boise, ID 83702");
  assert.equal(inbound.project.data.contacts[0].email, "jane@example.test");
  assert.equal(inbound.contacts[0].email, "jane@example.test");

  const projects = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  assert.equal(projects.documents.length, 1);
  assert.equal(projects.documents[0].data.source, "email_lead");

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(notifications.notifications.length, 1);
  assert.equal(notifications.notifications[0].context.project_id, inbound.project.id);
});

test("App flags gate the email lead inbox", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        email: { inbound_lead_import: false },
        platform: { expanded_access: true, lead_import: false, website_embed_import: false }
      }
    }
  }, { replace: false });

  const flags = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(flags.enabled.email.includes("inbound_lead_import"), false);
  assert.equal(flags.enabled.platform.includes("website_embed_import"), false);

  const settings = await client.raw("GET", `/v1/email/organizations/${orgId}/branch/default/lead-import`);
  assert.equal(settings.statusCode, 403, settings.body);
  assert.match(settings.body, /app_flag_disabled/);

  const patch = await client.raw("PATCH", `/v1/email/organizations/${orgId}/branch/default/lead-import`, { enabled: true });
  assert.equal(patch.statusCode, 403, patch.body);
  assert.match(patch.body, /app_flag_disabled/);
});

test("authenticated Cloudflare delivery imports other trades and deduplicates concurrent retries",async()=>{
 const client=createSessionClient(),{orgId}=await register(client);
 const settings=await client.request("GET",`/v1/email/organizations/${orgId}/branch/default/lead-import`);
 const payload={provider:"cloudflare_email",provider_event_id:"windows-1",from:{address:"provider@example.test"},to:[{address:settings.settings.inbound_email}],subject:"Please replace my windows",text:"Name: Jane Doe\nPhone: (555) 222-3333\nEmail: jane@example.test\nAddress: 123 Cedar Street, Boise, ID 83702\nI need six new windows.",headers:{message_id:"windows-1"}};
 const send=(token?:string)=>app.inject({method:"POST",url:"/v1/email/inbound/events",payload,headers:token?{authorization:`Bearer ${token}`}:{}});
 assert.equal((await send()).statusCode,401);
 assert.equal((await send("wrong")).statusCode,401);
 const first=await send("email-test-token");assert.equal(first.statusCode,200,first.body);assert.equal(first.json().accepted,true);
 const repeats=await Promise.all(Array.from({length:5},()=>send("email-test-token")));
 for(const r of repeats){assert.equal(r.statusCode,200,r.body);assert.equal(r.json().duplicate,true);assert.equal(r.json().project.id,first.json().project.id);}
 const projects=await client.request("GET",`/v1/platform/organizations/${orgId}/projects`);assert.equal(projects.documents.length,1);
 const history=await client.request("GET",`/v1/email/organizations/${orgId}/branch/default/lead-import/deliveries`);assert.equal(history.items.length,1);assert.equal(history.items[0].attempts,6);
 const rejected=await app.inject({method:"POST",url:"/v1/email/inbound/events",headers:{authorization:"Bearer email-test-token"},payload:{...payload,headers:{message_id:"newsletter-1"},subject:"Monthly newsletter",text:"Unsubscribe from our newsletter."}});
 assert.equal(rejected.statusCode,202);assert.equal(rejected.json().reason,"not_a_lead");
});

test("intake serializes first delivery, scopes identities and requires review after an interrupted dispatch",async()=>{
 const client=createSessionClient(),{orgId}=await register(client);
 const service=await import("../leads/intake.js");
 const input={source_id:"test-provider",external_id:"same-id",contacts:[{name:"Contact-only lead",email:"customer@example.test"}],provider:"Test source",provider_fields:{campaign:"campaign-1"}};
 const results=await Promise.allSettled(Array.from({length:5},()=>service.importLead(orgId,input)));
 const fulfilled=results.filter((r):r is PromiseFulfilledResult<any>=>r.status==="fulfilled");assert.ok(fulfilled.length>=1);
 const first=fulfilled.find(r=>!r.value.duplicate)!.value;
 const second=await service.importLead(orgId,input);assert.equal(second.project!.id,first.project.id);
 assert.equal(first.project.data.address,"");assert.equal(first.project.data.lead_source.external_id,"same-id");assert.equal(first.project.data.lead_source.provider_fields.campaign,"campaign-1");
 const different=await service.importLead(orgId,{...input,source_id:"other-provider"});assert.notEqual(different.project!.id,first.project.id);
 await service.leadStore().prepare("UPDATE lead_deliveries SET state='processing',updated_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z",first.delivery_id);
 const uncertain=await service.importLead(orgId,input);assert.equal(uncertain.state,"uncertain");assert.equal(uncertain.accepted,false);
 await service.reviewLeadDelivery(orgId,first.delivery_id,"test-reviewer",{decision:"imported",note:"Verified project and pipeline."});
 assert.equal((await service.importLead(orgId,input)).duplicate,true);
 const otherClient=createSessionClient(),other=await register(otherClient);
 await assert.rejects(service.reviewLeadDelivery(other.orgId,first.delivery_id,"other",{decision:"dismissed",note:"wrong tenant"}),{code:"lead_delivery_missing"});
 const page=await service.leadDeliveries(orgId,{limit:1});assert.ok(page.next);assert.equal((await service.leadDeliveries(orgId,{limit:1,after:page.next!})).items.length,1);
});

test("published intake has durable action receipts and fresh permissions; inbox regeneration revokes aliases",async()=>{
 const client=createSessionClient(),{orgId}=await register(client);
 const settings=await client.request("GET",`/v1/email/organizations/${orgId}/branch/default/lead-import`);
 const regenerated=await client.request("PATCH",`/v1/email/organizations/${orgId}/branch/default/lead-import`,{regenerate:true});
 assert.notEqual(regenerated.settings.inbound_email,settings.settings.inbound_email);
 assert.deepEqual(regenerated.settings.legacy_inbound_emails,[]);
 const old=await client.raw("POST","/v1/email/inbound/events",{from:{address:"provider@example.test"},to:[{address:settings.settings.inbound_email}],subject:"Window replacement request",text:"Name: Customer\nEmail: customer@example.test"});
 assert.equal(old.statusCode,202,old.body);assert.equal(old.json().accepted,false);
 const payload={action:"leads.import",target:{scope:"organization",organizationId:orgId},idempotencyKey:"published-lead-1",input:{source_id:"custom-feed",external_id:"provider-1",contacts:[{name:"Customer",email:"customer@example.test"}]}};
 const url=`/v1/publication/organizations/${orgId}/actions/invoke`;
 const first=await client.request("POST",url,payload),replay=await client.request("POST",url,payload);
 assert.equal(first.receipt.status,"succeeded");assert.equal(replay.receipt.replayed,true);
 const storage=await import("../platform/storage.js"),owner=(await storage.listDocuments(orgId,"users"))[0]!;
 await storage.upsertDocument(orgId,"users",{id:owner.id,data:{permission_overrides:{manage_projects:false}}});
 const denied=await client.raw("POST",url,{...payload,idempotencyKey:"denied-lead",input:{...payload.input,external_id:"provider-2"}});assert.equal(denied.statusCode,403,denied.body);
 const projects=await storage.listDocuments(orgId,"projects");assert.equal(projects.length,1);
});
