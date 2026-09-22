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

test("send timing covers morning-of, offset, and previous-afternoon rules", async () => {
  const { computeSendAt, zonedParts } = await import("../appointments/service.js");
  const timezone = "America/Chicago";
  // 2pm local on a Wednesday.
  const startAt = new Date("2026-03-04T20:00:00.000Z");

  const morningOf = computeSendAt(startAt, { mode: "morning_of", time_of_day: "09:00" }, timezone);
  const morningParts = zonedParts(morningOf, timezone);
  assert.equal(morningParts.hour, 9);
  assert.equal(morningParts.day, 4, "morning-of stays on the appointment's own day");

  const hourBefore = computeSendAt(startAt, { mode: "before_offset", offset_minutes: 60 }, timezone);
  assert.equal(hourBefore.toISOString(), "2026-03-04T19:00:00.000Z");

  const previousAfternoon = computeSendAt(
    startAt,
    { mode: "days_before", days_before: 1, time_of_day: "16:00" },
    timezone
  );
  const previousParts = zonedParts(previousAfternoon, timezone);
  assert.equal(previousParts.day, 3, "one day before");
  assert.equal(previousParts.hour, 16);

  // A 6am fixed time is pulled forward to the earliest allowed hour rather than
  // waking the customer up.
  const tooEarly = computeSendAt(startAt, { mode: "morning_of", time_of_day: "05:00", earliest_hour: 8 }, timezone);
  assert.equal(zonedParts(tooEarly, timezone).hour, 8);

  // A send time that would land after the appointment is pulled back before it.
  const late = computeSendAt(startAt, { mode: "morning_of", time_of_day: "18:00", latest_hour: 20 }, timezone);
  assert.ok(late.getTime() < startAt.getTime());
});

test("reply interpretation reads yes/no and refuses to guess", async () => {
  const { interpretResponse } = await import("../appointments/service.js");
  assert.equal(interpretResponse("Yes"), "confirmed");
  assert.equal(interpretResponse("yep, see you then!"), "confirmed");
  assert.equal(interpretResponse("C"), "unclear", "a bare initial is not a confirmation");
  assert.equal(interpretResponse("confirmed, thanks"), "confirmed");
  assert.equal(interpretResponse("No"), "declined");
  assert.equal(interpretResponse("I need to reschedule"), "declined");
  assert.equal(interpretResponse("can't make it sorry"), "declined");
  // Decline wins ties so a hedged reply is never read as a yes.
  assert.equal(interpretResponse("yes but can we move it to Friday?"), "declined");
  assert.equal(interpretResponse("what's the address again?"), "unclear");
  assert.equal(interpretResponse(""), "unclear");
});

// ── End-to-end through the API ──────────────────────────────────────────────

test("appointment confirmations: schedule, queue, send, and confirm by reply", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const settingsUrl = `/v1/appointments/organizations/${orgId}/branches/default/confirmation-settings`;

  const initial = await owner.request("GET", settingsUrl);
  assert.equal(initial.settings.enabled, false, "confirmations are off until a company turns them on");
  assert.equal(initial.settings.schedule.mode, "morning_of");

  await owner.request("PUT", settingsUrl, {
    ...initial.settings,
    enabled: true,
    default_required: true,
    channels: { email: true, sms: true },
    schedule: { mode: "days_before", days_before: 1, time_of_day: "16:00" },
    timezone: "America/Chicago"
  });

  await createProject(orgId, "proj_appt_confirm", "Dana Reyes", {
    email: "dana.reyes@example.test",
    phone: "+12065551234"
  });

  // Schedule an appointment a week out; the confirmation is planned automatically.
  const startAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const scheduled = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_appt_confirm/events`, {
    branch_id: "default",
    event: {
      id: "event_appt_1",
      event_type_default_id: "sales_appointment",
      title: "Roof Estimate",
      start_at: startAt,
      duration_minutes: 60
    }
  });
  assert.equal(scheduled.event.confirmation.required, true);
  assert.equal(scheduled.event.confirmation.status, "pending", "unconfirmed until the customer answers");
  assert.ok(scheduled.event.confirmation.scheduled_send_at, "a send time was computed");

  const queued = await owner.request("GET", `/v1/appointments/organizations/${orgId}/projects/proj_appt_confirm/confirmations`);
  assert.equal(queued.visible, true);
  assert.equal(queued.confirmations.length, 1);
  assert.equal(queued.confirmations[0].status, "pending");

  // A second appointment for the same customer on the same day shares the queue
  // group, so one message covers both rather than two arriving back to back.
  const sameDayStart = new Date(new Date(startAt).getTime() + 3 * 3_600_000).toISOString();
  await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_appt_confirm/events`, {
    branch_id: "default",
    event: {
      id: "event_appt_2",
      event_type_default_id: "sales_appointment",
      title: "Gutter Walkthrough",
      start_at: sameDayStart,
      duration_minutes: 30
    }
  });
  const { listConfirmationRows } = await import("../appointments/storage.js");
  const rows = (await listConfirmationRows({ organization_id: orgId, project_id: "proj_appt_confirm" }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.group_key, rows[1]!.group_key, "same customer + same day = one group");
  assert.equal(rows[0]!.token, rows[1]!.token, "one reply answers both appointments");

  // Send now rather than waiting for the tick.
  const sent = await owner.request(
    "POST",
    `/v1/appointments/organizations/${orgId}/projects/proj_appt_confirm/events/event_appt_1/confirmation/send`
  );
  assert.equal(sent.ok, true);
  assert.ok(sent.channels.includes("sms"), "SMS went out through the shared comms sender");
  assert.ok(sent.channels.includes("email"), "email went out through the tenant-aware shared comms sender");
  assert.ok(sent.confirm_link.includes("/v1/appointments/public/"));

  // The outbound message is in the project comms feed, same as a manual send.
  const feed = await owner.request("GET", `/v1/comms/organizations/${orgId}/projects/proj_appt_confirm/feed`);
  const outbound = (feed.messages || feed.feed || []).filter((message: any) => message.direction === "outbound");
  assert.ok(outbound.length >= 1, "confirmation send appears in the comms tab");
  assert.ok(outbound.some((message: any) => message.channel === "email" && message.test_mode === true), "captured appointment email is visible in project comms");

  // The customer texts back "yes" — the inbound listener confirms both.
  const simulated = await owner.request("POST", `/v1/comms/organizations/${orgId}/projects/proj_appt_confirm/simulate-inbound`, {
    channel: "sms",
    text: "Yes that works, see you then"
  });
  assert.ok(simulated);

  const afterReply = await owner.request("GET", `/v1/appointments/organizations/${orgId}/projects/proj_appt_confirm/confirmations`);
  assert.equal(afterReply.confirmations.length, 2);
  for (const confirmation of afterReply.confirmations) {
    assert.equal(confirmation.status, "confirmed", "a single reply confirmed the whole day");
    assert.equal(confirmation.response_channel, "sms");
  }

  // The appointments themselves carry the answer — this is what the schedule renders.
  const project = await owner.request("GET", `/v1/platform/organizations/${orgId}/projects/proj_appt_confirm`);
  const events = (project.document?.data?.events || project.project?.events || []) as any[];
  for (const event of events) {
    assert.equal(event.confirmation.status, "confirmed");
    assert.ok(event.confirmation.confirmed_at);
  }
});

test("moving a confirmed appointment makes it unconfirmed again", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const settingsUrl = `/v1/appointments/organizations/${orgId}/branches/default/confirmation-settings`;
  const initial = await owner.request("GET", settingsUrl);
  await owner.request("PUT", settingsUrl, { ...initial.settings, enabled: true, default_required: true });

  await createProject(orgId, "proj_appt_move", "Ellis Ward", {
    email: "ellis.ward@example.test",
    phone: "+12065559876"
  });
  const startAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const eventsUrl = `/v1/platform/organizations/${orgId}/projects/proj_appt_move/events`;
  await owner.request("POST", eventsUrl, {
    branch_id: "default",
    event: { id: "event_move_1", event_type_default_id: "sales_appointment", title: "Estimate", start_at: startAt, duration_minutes: 60 }
  });

  // Staff marks it confirmed by hand (the customer called).
  const manual = await owner.request(
    "POST",
    `/v1/appointments/organizations/${orgId}/projects/proj_appt_move/events/event_move_1/confirmation`,
    { outcome: "confirmed" }
  );
  assert.equal(manual.status, "confirmed");

  // Rescheduling invalidates that answer: the customer agreed to a time that is gone.
  const moved = await owner.request("POST", eventsUrl, {
    branch_id: "default",
    event: {
      id: "event_move_1",
      event_type_default_id: "sales_appointment",
      title: "Estimate",
      start_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      duration_minutes: 60
    }
  });
  assert.equal(moved.event.confirmation.status, "pending", "a moved appointment is unconfirmed again");
  assert.equal(moved.event.confirmation.confirmed_at, "");
});

test("visibility setting hides confirmation state from users without the permission", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const { canViewConfirmations, readConfirmationSettings } = await import("../appointments/service.js");
  const settingsUrl = `/v1/appointments/organizations/${orgId}/branches/default/confirmation-settings`;
  const initial = await owner.request("GET", settingsUrl);
  await owner.request("PUT", settingsUrl, {
    ...initial.settings,
    enabled: true,
    visibility: { mode: "permission", role_ids: ["role_ops"] }
  });
  const { settings } = await readConfirmationSettings(orgId, "default");

  assert.equal(canViewConfirmations(settings, { permissions: { view_appointment_confirmation: true } }), true);
  assert.equal(canViewConfirmations(settings, { permissions: {}, roleIds: ["role_ops"] }), true, "listed roles always see it");
  assert.equal(canViewConfirmations(settings, { permissions: { view_projects: true }, roleIds: ["role_sales"] }), false);
  assert.equal(canViewConfirmations(settings, { permissions: { "*": true } }), true);

  // The default mode shows it to everyone who can see the schedule.
  const everyone = { ...settings, visibility: { mode: "everyone", role_ids: [], hide_style: "none" } };
  assert.equal(canViewConfirmations(everyone as any, { permissions: {}, roleIds: ["role_sales"] }), true);
});
