import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type TestClient = ReturnType<typeof createSessionClient>;

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
  const raw = async (method: string, url: string, payload?: unknown, omitCsrf = false) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(!omitCsrf && csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
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
    let data: any = null;
    try {
      data = response.body ? JSON.parse(response.body) : null;
    } catch {
      data = null;
    }
    return { statusCode: response.statusCode, body: response.body, data };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-apptconf-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.APPOINTMENT_CONFIRMATIONS_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkDatabase } = await import("../work/storage.js");
  const { closeAppointmentsDatabase } = await import("../appointments/storage.js");
  (await closeWorkDatabase());
  (await closeAppointmentsDatabase());
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  await closeSqlStoresForTests();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    email: `appt-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Appointment Test Owner",
    phone: nextTestPhone(),
    company: "Appointment Confirmation Test Org",
    organization_id: `org_apptconf_${suffix}`
  });
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(String(registered.organization.id), { "platform.expanded_access": true });
  return { orgId: String(registered.organization.id), suffix };
}

async function createProject(orgId: string, projectId: string, name: string, contact: { email: string; phone: string }) {
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: {
      id: projectId,
      title: `${name} Roof Replacement`,
      branch_id: "default",
      status: "open",
      address: "1200 Example Ave",
      contacts: [{ id: `contact_${projectId}`, name, email: contact.email, phone: contact.phone, primary: true }]
    }
  });
}

// ── Pure timing / parsing units ─────────────────────────────────────────────


test('staff booking validates authority, rechecks availability, and retries without duplication', async () => {
  const client = createSessionClient();
  const {orgId} = await registerOwner(client);
  const {saveBranchModule, upsertDocument, readDocument} = await import('../platform/storage.js');
  const {saveCapabilityValues} = await import('../platform/capabilities.js');
  await saveCapabilityValues(orgId, {'platform.scheduling':true,'scheduling.appointment_slots':true});
  await saveBranchModule(orgId, 'default', 'scheduling', {data:{
    self_service:{default_policy:{min_notice_minutes:0}},
    event_types:{sales_appointment:{duration_minutes:60,slot_minutes:30,assignment_policy:{allow_unassigned:true,rules:[]}}}
  }}, {replace:true});
  await createProject(orgId, 'booking_project', 'Customer', {email:'',phone:''});
  const day = new Date(Date.now()+48*3600000).toISOString().slice(0,10);
  const availability = await client.request('GET', `/v1/appointments/organizations/${orgId}/availability?project_id=booking_project&start_date=${day}&end_date=${day}`);
  const slot = availability.slots.find((row:any) => row.available);
  assert.ok(slot);
  const url = `/v1/appointments/organizations/${orgId}/book`;
  const body = {project_id:'booking_project',event_id:'appointment_0123456789abcdef',start_at:slot.start_at};
  const anonymous = await app.inject({method:'POST',url,payload:body});
  assert.equal(anonymous.statusCode,401);
  assert.equal((await client.raw('POST',url,body,true)).statusCode,403);
  assert.equal((await client.raw('POST',url,{...body,assigned_user_id:'arbitrary'})).statusCode,400);
  const booked = await client.request('POST',url,body);
  assert.equal(booked.event.start_at,slot.start_at);
  const again = await client.request('POST',url,body);
  assert.equal(again.event.id,booked.event.id);
  const stored = await readDocument(orgId,'projects','booking_project');
  assert.equal((stored.data.events as any[]).length,1);
  const invalid = await client.raw('POST',url,{...body,event_id:'appointment_1123456789abcdef',start_at:'2020-01-01T00:00:00.000Z'});
  assert.equal(invalid.statusCode,409);
  await upsertDocument(orgId,'projects',{id:'other_branch',data:{branch_id:'other',title:'Other'}});
  assert.equal((await client.raw('POST',url,{...body,project_id:'other_branch'})).statusCode,403);
  await saveCapabilityValues(orgId, {'scheduling.appointment_slots':false});
  assert.equal((await client.raw('POST',url,body)).statusCode,403);
});
