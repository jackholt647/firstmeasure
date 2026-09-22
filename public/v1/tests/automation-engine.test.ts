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

test("organization automation rules run on every event with conditions over project state", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const rules = await client.request("GET", `/v1/work/organizations/${orgId}/branches/default/automation-rules`);
  assert.ok(rules.rules.some((rule: any) => rule.id === "platform_ensure_receivables_on_signature"), "default rules are present");

  await client.request("PUT", `/v1/work/organizations/${orgId}/branches/default/automation-rules`, {
    rules: [
      {
        id: "custom_event_notification",
        event: "test.org_rule",
        conditions: { "payload.flavor": "matching" },
        automation: "notification.create.v1",
        input: { id: "notification_org_rule_hit", title: "Org rule", body: "{{project.title}}" }
      },
      {
        id: "custom_event_notification_blocked",
        event: "test.org_rule",
        conditions: { "project.lifecycle.status": "completed" },
        automation: "notification.create.v1",
        input: { id: "notification_org_rule_blocked", title: "Should not fire", body: "no" }
      }
    ]
  });

  const projectId = "project_org_rules";
  await createProject(client, orgId, projectId);
  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, {
    event: "test.org_rule",
    project_id: projectId,
    payload: { flavor: "matching" }
  });

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.ok(notifications.notifications.some((item: any) => item.id === "notification_org_rule_hit"));
  assert.ok(!notifications.notifications.some((item: any) => item.id === "notification_org_rule_blocked"));
});

test("organization email automations use the tenant-aware communications capture path", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_email_automation";
  await createProject(client, orgId, projectId);
  await client.request("PUT", `/v1/work/organizations/${orgId}/branches/default/automation-rules`, {
    rules: [{
      id: "customer_email_probe",
      event: "test.customer_email",
      automation: "communications.sendEmail.v1",
      input: {
        to: "automation-recipient@example.test",
        subject: "Automation capture probe",
        text: "Project {{project.title}}"
      }
    }]
  });
  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, {
    event: "test.customer_email",
    project_id: projectId,
    payload: {}
  });

  const { listMessageRecords, listDeliveryRecords } = await import("../messaging/communications_storage.js");
  const message = (await listMessageRecords(orgId, { channel: "email", project_id: projectId }))[0];
  assert.ok(message, "email automation created a communications message");
  assert.equal(message.status, "sent");
  assert.equal((message.source as any).automation_id, "communications.sendEmail.v1");
  assert.equal((message.metadata as any).transport_mode, "capture");
  const deliveries = (await listDeliveryRecords(orgId, String(message.id)));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.provider, "firstmate_mail_mock");
  assert.equal(deliveries[0]?.transport_mode, "capture");
});

test("project claims coordinate parallel bindings and conditions gate on claim state", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_claims";
  await createProject(client, orgId, projectId);

  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_claims",
    title: "Claims",
    source_key: "test:claims",
    metadata: { hide_from_boards: true },
    root_nodes: [{
      id: "claims_phase",
      title: "Claims",
      terminology_key: "work.phase",
      completion_mode: "all_children",
      children: [
        {
          id: "claimer_one",
          title: "Claimer one",
          terminology_key: "work.task",
          actionable: true,
          automation_bindings: {
            onReady: [
              { id: "claim_one", automation: "project.claim.v1", input: { key: "welcome_call", holder: "claimer_one" } },
              {
                id: "notify_if_won_one",
                automation: "notification.create.v1",
                conditions: { "project.claims.welcome_call.holder": "claimer_one" },
                input: { id: "notification_claim_one", title: "One won", body: "one" }
              }
            ]
          }
        },
        {
          id: "claimer_two",
          title: "Claimer two",
          terminology_key: "work.task",
          actionable: true,
          automation_bindings: {
            onReady: [
              { id: "claim_two", automation: "project.claim.v1", input: { key: "welcome_call", holder: "claimer_two" } },
              {
                id: "notify_if_won_two",
                automation: "notification.create.v1",
                conditions: { "project.claims.welcome_call.holder": "claimer_two" },
                input: { id: "notification_claim_two", title: "Two won", body: "two" }
              }
            ]
          }
        }
      ]
    }]
  });

  const project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const claim = project.document.data.claims?.welcome_call;
  assert.ok(claim, "a claim was recorded");
  assert.ok(["claimer_one", "claimer_two"].includes(claim.holder));

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const winners = notifications.notifications.filter((item: any) => ["notification_claim_one", "notification_claim_two"].includes(item.id));
  assert.equal(winners.length, 1, "exactly one claim-conditioned binding fired");
});

test("automation inputs resolve platform data through context providers", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_providers";
  await createProject(client, orgId, projectId);

  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_providers",
    title: "Providers",
    source_key: "test:providers",
    metadata: { hide_from_boards: true },
    root_nodes: [{
      id: "provider_task",
      title: "Provider task",
      terminology_key: "work.task",
      actionable: true,
      automation_bindings: {
        onReady: [{
          id: "notify_with_org_data",
          automation: "notification.create.v1",
          input: {
            id: "notification_provider_data",
            title: "{{organization.name}}",
            body: "users:{{users.count}} scopes:{{scopes.list.0.id}}"
          }
        }]
      }
    }]
  });

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const notification = notifications.notifications.find((item: any) => item.id === "notification_provider_data");
  assert.ok(notification, "provider-driven notification exists");
  assert.equal(notification.title, "Automation Engine Test Co");
  assert.match(notification.body, /users:1 scopes:[a-z_]+/);
});

test("node timers fire through the scheduler and run onTimer bindings", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_timers";
  await createProject(client, orgId, projectId);

  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_timers",
    title: "Timers",
    source_key: "test:timers",
    metadata: { hide_from_boards: true },
    root_nodes: [{
      id: "timed_task",
      title: "Timed task",
      terminology_key: "work.task",
      actionable: true,
      timers: [{ id: "nudge", anchor: "ready", offset_minutes: 0 }],
      automation_bindings: {
        onTimer: [{
          id: "timer_notification",
          automation: "notification.create.v1",
          conditions: { "payload.timer_id": "nudge" },
          input: { id: "notification_timer_fired", title: "Timer", body: "{{event.payload.timer_id}}" }
        }]
      }
    }]
  });

  const { runWorkSchedulerTick } = await import("../work/scheduler.js");
  await runWorkSchedulerTick();

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const notification = notifications.notifications.find((item: any) => item.id === "notification_timer_fired");
  assert.ok(notification, "timer notification exists");
  assert.equal(notification.body, "nudge");

  // One-shot: another tick must not duplicate the execution.
  await runWorkSchedulerTick();
  const again = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(again.notifications.filter((item: any) => item.id === "notification_timer_fired").length, 1);
});

test("cron automation rules fire org-scoped time.cron events", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PUT", `/v1/work/organizations/${orgId}/branches/default/automation-rules`, {
    rules: [{
      id: "every_minute_rule",
      schedule: { cron: "* * * * *" },
      automation: "notification.create.v1",
      input: { id: "notification_cron_fired", title: "Cron", body: "tick {{event.payload.rule_id}}" }
    }]
  });

  const { runWorkSchedulerTick } = await import("../work/scheduler.js");
  await runWorkSchedulerTick({ cron: true });

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const notification = notifications.notifications.find((item: any) => item.id === "notification_cron_fired");
  assert.ok(notification, "cron rule fired a notification");
  assert.equal(notification.body, "tick every_minute_rule");

  // Same minute: firing again must dedupe via cron state + idempotency.
  await runWorkSchedulerTick({ cron: true });
  const again = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(again.notifications.filter((item: any) => item.id === "notification_cron_fired").length, 1);
});

test("the activity feed separates human-relevant events from machinery", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_activity";
  await createProject(client, orgId, projectId);
  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, {
    event: "test.activity_probe",
    project_id: projectId,
    payload: { anything: true }
  });
  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_activity",
    title: "Activity",
    source_key: "test:activity",
    metadata: { hide_from_boards: true },
    root_nodes: [{ id: "activity_task", title: "Task", terminology_key: "work.task", actionable: true }]
  });

  const activity = await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/activity`);
  assert.ok(activity.events.some((event: any) => event.type === "test.activity_probe"), "unregistered non-work events default to activity visibility");
  assert.ok(!activity.events.some((event: any) => event.type === "work.node.status_changed"), "system machinery stays out of the activity feed");

  const everything = await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/activity?visibility=all`);
  assert.ok(everything.events.some((event: any) => event.type === "work.node.status_changed"), "visibility=all exposes system events");

  const catalog = await client.request("GET", `/v1/work/organizations/${orgId}/event-catalog`);
  assert.ok(catalog.events.some((event: any) => event.name === "proposal.signed" && event.visibility === "activity"));
  assert.ok(catalog.events.some((event: any) => event.name === "work.node.status_changed" && event.visibility === "system"));
});
