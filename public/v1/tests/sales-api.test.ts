import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type Json = Record<string, any>;
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
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-sales-api-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const [{ closeWorkforceDatabase }, { closeWorkDatabase }] = await Promise.all([
    import("../workforce/storage.js"),
    import("../work/storage.js")
  ]);
  (await closeWorkforceDatabase());
  (await closeWorkDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

function todayKey(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `sales-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Sales Test Owner",
    company: "Sales API Test Org",
    organization_id: `org_sales_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return { orgId: String(registered.organization.id), suffix, userId: String(registered.user.id) };
}

async function createSalesperson(owner: TestClient, orgId: string, suffix: string) {
  const email = `salesperson-${suffix}@example.test`;
  const password = "salesperson password";
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name: "Sunny Seller", status: "active", role: "viewer", send_invite: false }
  });
  const userId = String(created.document.id);
  await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
    access_role_ids: ["salesperson"],
    application_access: {
      management: { enabled: false, role_id: "viewer", permissions: {} },
      field: { enabled: true, role_id: "salesperson", permissions: {} }
    }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId, client };
}

async function seedAppointmentProject(orgId: string, id: string, title: string, events: Json[]) {
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id,
    data: {
      branch_id: "default",
      title,
      address: `${title} Address`,
      contacts: [{ id: `${id}_customer`, name: `${title} Customer`, phone: "555-0142", primary: true }],
      events
    },
    metadata: { kind: "platform_project", branch_id: "default", source: "sales_api_test" }
  }, { replace: true });
}

function salesAppointment(id: string, userId: string, date: string, overrides: Json = {}) {
  return {
    id,
    kind: "appointment",
    event_type_default_id: "sales_appointment",
    status: "scheduled",
    assigned_user_ids: [userId],
    start_at: `${date}T15:00:00.000Z`,
    end_at: `${date}T16:00:00.000Z`,
    all_day: false,
    schedule_granularity: "time",
    duration_minutes: 60,
    ...overrides
  };
}

test("sales facade scopes appointments and follow-ups to the salesperson", async (t) => {
  const owner = createSessionClient();
  const { orgId, suffix } = await registerOwner(owner);
  const seller = await createSalesperson(owner, orgId, suffix);
  const salesBase = `/v1/workforce/organizations/${orgId}/sales`;

  await t.test("salesperson entitlements expose the sales tabs and only those", async () => {
    const session = await seller.client.request("GET", "/v1/platform/auth/session");
    assert.deepEqual(session.membership.access_role_ids, ["salesperson"]);
    assert.deepEqual(session.access_profile.allowed_app_ids, [
      "project.crew_payments",
      "project.crew_checklists",
      "project.field_customer",
      "project.crew_signatures",
      "portal.sales_overview",
      "portal.sales_schedule",
      "portal.sales_earnings",
      "project.sales_overview"
    ]);
  });

  await seedAppointmentProject(orgId, "sales_today", "Maple Street Roof", [
    salesAppointment("appt_today", seller.userId, todayKey(0))
  ]);
  await seedAppointmentProject(orgId, "sales_past", "Oak Avenue Siding", [
    salesAppointment("appt_past", seller.userId, todayKey(-7))
  ]);
  await seedAppointmentProject(orgId, "sales_upcoming", "Pine Court Windows", [
    salesAppointment("appt_next", seller.userId, todayKey(3))
  ]);
  await seedAppointmentProject(orgId, "sales_other", "Not Mine", [
    salesAppointment("appt_other", "someone_else", todayKey(0)),
    salesAppointment("appt_canceled", seller.userId, todayKey(0), { id: "appt_canceled", status: "canceled" })
  ]);

  await t.test("dashboard returns today's assigned appointments and pulse", async () => {
    const dashboard = await seller.client.request("GET", `${salesBase}/me/dashboard`);
    assert.equal(dashboard.pulse.appointments_today, 1);
    assert.deepEqual(dashboard.appointments.map((entry: Json) => entry.id), ["appt_today"]);
    assert.equal(dashboard.appointments[0].customer_name, "Maple Street Roof Customer");
    assert.equal(dashboard.appointments[0].customer_phone, "555-0142");
    assert.deepEqual(dashboard.upcoming.map((entry: Json) => entry.id), ["appt_next"]);
  });

  await t.test("appointments list covers past and future, excludes others and canceled", async () => {
    const listed = await seller.client.request("GET", `${salesBase}/me/appointments`);
    assert.deepEqual(
      listed.appointments.map((entry: Json) => entry.id).sort(),
      ["appt_next", "appt_past", "appt_today"]
    );
    const ranged = await seller.client.request("GET", `${salesBase}/me/appointments?from=${todayKey(-1)}&to=${todayKey(1)}`);
    assert.deepEqual(ranged.appointments.map((entry: Json) => entry.id), ["appt_today"]);
    const searched = await seller.client.request("GET", `${salesBase}/me/appointments?search=oak`);
    assert.deepEqual(searched.appointments.map((entry: Json) => entry.id), ["appt_past"]);
  });

  await t.test("sales project view returns summary + appointments and enforces assignment", async () => {
    const view = await seller.client.request("GET", `${salesBase}/me/projects/sales_today`);
    assert.equal(view.project.title, "Maple Street Roof");
    assert.equal(view.project.customer_name, "Maple Street Roof Customer");
    assert.deepEqual(view.appointments.map((entry: Json) => entry.id), ["appt_today"]);
    assert.ok(Array.isArray(view.followups));
    const denied = await seller.client.raw("GET", `${salesBase}/me/projects/sales_other`);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.data?.error, "sales_project_forbidden");
  });

  await t.test("follow-ups: create self-assigned, claim role-assigned, resolve outcomes", async () => {
    const created = await seller.client.request("POST", `${salesBase}/me/followups`, {
      title: "Call Maple Street back",
      due_at: todayKey(1),
      channel: "call",
      project_id: "sales_today"
    });
    assert.equal(created.follow_up.mine, true);
    assert.deepEqual(created.follow_up.assigned_user_ids, [seller.userId]);

    const { createFollowUpTodo } = await import("../work/followups.js");
    const roleAssigned = await createFollowUpTodo(orgId, {
      title: "Unclaimed lead call",
      project_id: "sales_past",
      assigned_role_ids: ["salesperson"]
    });
    const roleNodeId = String(roleAssigned.node.id);

    const dashboard = await seller.client.request("GET", `${salesBase}/me/dashboard`);
    assert.ok(dashboard.followups.mine.some((item: Json) => item.title === "Call Maple Street back"));
    assert.ok(dashboard.followups.unclaimed.some((item: Json) => item.id === roleNodeId));
    assert.equal(dashboard.pulse.followups_unclaimed >= 1, true);

    const claimed = await seller.client.request("POST", `${salesBase}/me/followups/${roleNodeId}/claim`);
    assert.equal(claimed.follow_up.mine, true);
    assert.ok(claimed.follow_up.assigned_user_ids.includes(seller.userId));
    const afterClaim = await seller.client.request("GET", `${salesBase}/me/dashboard`);
    assert.ok(afterClaim.followups.mine.some((item: Json) => item.id === roleNodeId));
    assert.equal(afterClaim.followups.unclaimed.some((item: Json) => item.id === roleNodeId), false);

    const rescheduled = await seller.client.request("POST", `${salesBase}/me/followups/${roleNodeId}/outcome`, {
      outcome_id: "reschedule",
      due_at: todayKey(2)
    });
    assert.equal(rescheduled.completed.status, "completed");
    assert.ok(rescheduled.successor);
    assert.ok(rescheduled.successor.assigned_user_ids.includes(seller.userId));
  });

  await t.test("users without sales permissions are denied", async () => {
    const anonymous = createSessionClient();
    const denied = await anonymous.raw("GET", `${salesBase}/me/dashboard`);
    assert.ok(denied.statusCode === 401 || denied.statusCode === 403);

    const email = `sales-crew-${suffix}@example.test`;
    const password = "crew member password";
    const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
      data: { email, password, name: "Casey Crew", status: "active", role: "viewer", send_invite: false }
    });
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${created.document.id}/profile`, {
      access_role_ids: ["crew_member"],
      application_access: {
        management: { enabled: false, role_id: "viewer", permissions: {} },
        field: { enabled: true, role_id: "crew_member", permissions: {} }
      }
    });
    const crew = createSessionClient();
    await crew.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
    const forbidden = await crew.raw("GET", `${salesBase}/me/dashboard`);
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.data.error, "sales_permission_denied");
  });
});
