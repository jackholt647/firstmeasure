import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
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
  const raw = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}),
        ...headers
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
  const request = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await raw(method, url, payload, headers);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-comms-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.EMAIL_INBOUND_WEBHOOK_TOKEN = "";
  process.env.COMMUNICATIONS_DELIVERY_MODE = "capture";
  process.env.EMAIL_DELIVERY_MODE = "capture";
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
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkDatabase } = await import("../work/storage.js");
  (await closeWorkDatabase());
  const { closeCommunicationsDatabase } = await import("../messaging/communications_storage.js");
  (await closeCommunicationsDatabase());
  await closeSqlStoresForTests();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner() {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(), 
    email: `comms-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Comms Test Owner",
    company: "Comms Roofing Co",
    organization_id: `org_comms_${suffix}`
  });
  await enableExpandedPlatformFixture(String(registered.organization.id));
  return { client, orgId: String(registered.organization.id), suffix };
}

async function createProject(client: TestClient, orgId: string, suffix: string) {
  const project = await client.request("POST", `/v1/platform/organizations/${orgId}/projects`, {
    data: {
      title: "Maple Street Reroof",
      contacts: [{
        id: "contact_primary",
        name: "Casey Customer",
        email: `casey-${suffix}@example.test`,
        phone: "+12065551234",
        primary: true
      }, {
        id: "contact_secondary",
        name: "Jordan Customer",
        email: `jordan-${suffix}@example.test`,
        phone: "+12065559876"
      }, {
        id: "contact_no_details",
        name: "Taylor Customer"
      }]
    }
  });
  return {
    projectId: String(project.document.id),
    contactEmail: `casey-${suffix}@example.test`,
    contactPhone: "+12065551234",
    secondaryEmail: `jordan-${suffix}@example.test`,
    secondaryPhone: "+12065559876"
  };
}

test("comms: message templates seed, filter, and support the full settings CRUD flow", async () => {
  const { client, orgId } = await registerOwner();

  const seeded = await client.request("GET", `/v1/comms/organizations/${orgId}/templates?channel=sms&active=true`);
  assert.equal(seeded.templates.length, 3);
  assert.ok(seeded.templates.some((item: any) => item.seed_key === "sms_missed_call"));
  assert.deepEqual(
    seeded.templates.find((item: any) => item.seed_key === "sms_missed_call").variables,
    ["first_name", "sender_name", "company_name", "project_name"]
  );

  const created = await client.request("POST", `/v1/comms/organizations/${orgId}/templates`, {
    name: "Crew arrival",
    channel: "sms",
    category: "Production",
    body: "Hi {{first_name}}, the crew is on the way.",
    variables: ["first_name"],
    active: true
  });
  assert.equal(created.template.name, "Crew arrival");
  assert.equal(created.template.channel, "sms");
  assert.equal(created.template.active, true);

  const updated = await client.request(
    "PUT",
    `/v1/comms/organizations/${orgId}/templates/${created.template.id}`,
    { name: "Crew is on the way", active: false }
  );
  assert.equal(updated.template.name, "Crew is on the way");
  assert.equal(updated.template.active, false);

  const active = await client.request("GET", `/v1/comms/organizations/${orgId}/templates?channel=sms&active=true`);
  assert.ok(!active.templates.some((item: any) => item.id === created.template.id));

  const starterId = seeded.templates.find((item: any) => item.seed_key === "sms_appointment").id;
  const removedStarter = await client.raw("DELETE", `/v1/comms/organizations/${orgId}/templates/${starterId}`);
  assert.equal(removedStarter.statusCode, 204);

  const removed = await client.raw("DELETE", `/v1/comms/organizations/${orgId}/templates/${created.template.id}`);
  assert.equal(removed.statusCode, 204);
  const afterDelete = await client.request("GET", `/v1/comms/organizations/${orgId}/templates`);
  assert.ok(!afterDelete.templates.some((item: any) => item.id === created.template.id));
  assert.ok(!afterDelete.templates.some((item: any) => item.id === starterId), "deleted starter templates must not be reseeded");
});

test("comms: org inbox provisioning is idempotent and slugged from the org name", async () => {
  const { client, orgId } = await registerOwner();
  const first = await client.request("GET", `/v1/email/organizations/${orgId}/inbox`);
  assert.match(String(first.inbox.address), /^commsroofingco\d*@firstmatemail\.com$/);
  assert.equal(first.inbox.delivery_mode, "capture");
  const second = await client.request("GET", `/v1/email/organizations/${orgId}/inbox`);
  assert.equal(first.inbox.address, second.inbox.address);
});

test("comms: outbound email is captured with a test flag, threads, and inbound replies land on the same thread with notifications", async () => {
  const { client, orgId, suffix } = await registerOwner();
  const { projectId, contactEmail } = await createProject(client, orgId, suffix);

  // Send an email from the project.
  const sent = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/send`, {
    subject: "Your roof inspection report",
    text: "Hi Casey, your inspection report is attached. Let us know if you have questions!"
  });
  assert.equal(sent.message.channel, "email");
  assert.equal(sent.message.status, "sent");
  const conversationId = String(sent.message.conversation_id);
  assert.ok(conversationId, "email send should create a conversation");
  const initialThread = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/threads/${conversationId}`);
  assert.equal(initialThread.thread.subject, "Your roof inspection report");

  // The feed shows it with test_mode (capture) set.
  const feed = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/feed`);
  assert.equal(feed.messages.length, 1);
  assert.equal(feed.messages[0].test_mode, true);
  assert.equal(feed.messages[0].direction, "outbound");

  // A reply into the same thread reuses the conversation.
  const reply = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/send`, {
    subject: "Re: Your roof inspection report",
    text: "One more thing — the crew arrives at 8am.",
    conversation_id: conversationId
  });
  assert.equal(String(reply.message.conversation_id), conversationId);

  // Simulate the customer replying by email: it should land on the SAME
  // conversation (open-thread match by sender address) and create a
  // notification routed to the default targets.
  const inbound = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/simulate-inbound`, {
    channel: "email",
    text: "Thanks! Can we move the start to Thursday instead?",
    subject: "Re: Your roof inspection report"
  });
  assert.equal(inbound.message.direction, "inbound");
  assert.equal(String(inbound.message.conversation_id), conversationId);
  assert.equal(inbound.message.project_id, projectId);

  const thread = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/threads/${conversationId}`);
  assert.equal(thread.thread.messages.length, 3);
  assert.equal(thread.thread.messages[2].direction, "inbound");

  // A new compose to the same recipient starts a distinct subject thread;
  // only a reply with conversation_id reuses the original thread.
  const separate = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/send`, {
    subject: "A separate project update",
    text: "This is a new email conversation."
  });
  assert.notEqual(String(separate.message.conversation_id), conversationId);
  const separateThread = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/threads/${separate.message.conversation_id}`);
  assert.equal(separateThread.thread.subject, "A separate project update");

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const commsNotification = (notifications.notifications || notifications.documents || []).find(
    (item: any) => String(item.kind || item.data?.kind) === "comms_message"
  );
  assert.ok(commsNotification, `expected a comms_message notification: ${JSON.stringify(notifications).slice(0, 400)}`);
  const action = commsNotification.frontend_action || commsNotification.data?.frontend_action || {};
  assert.equal(String(action.kind), "open_project_comms");
  assert.equal(String(action.project_id), projectId);

  // Inbound email from a sender with a contact match routes to the project
  // even via the raw provider webhook (no auth).
  const inboxInfo = await client.request("GET", `/v1/email/organizations/${orgId}/inbox`);
  const webhook = await client.raw("POST", "/v1/email/inbound/events", {
    provider: "test_provider",
    provider_event_id: `evt_${suffix}_1`,
    from: { address: contactEmail, name: "Casey Customer" },
    to: [{ address: inboxInfo.inbox.address }],
    subject: "Gate code",
    text: "The gate code is 4321."
  });
  assert.equal(webhook.statusCode, 200, webhook.body);
  assert.equal(webhook.data.accepted, true);
  // Duplicate provider event is deduped.
  const duplicate = await client.raw("POST", "/v1/email/inbound/events", {
    provider: "test_provider",
    provider_event_id: `evt_${suffix}_1`,
    from: { address: contactEmail },
    to: [{ address: inboxInfo.inbox.address }],
    subject: "Gate code",
    text: "The gate code is 4321."
  });
  assert.equal(duplicate.data.created, false);

  // Unroutable inbound mail gets a 202, not an error (providers must not retry).
  const unroutable = await client.raw("POST", "/v1/email/inbound/events", {
    from: { address: "stranger@example.test" },
    to: [{ address: "nobody@firstmatemail.com" }],
    subject: "Hello",
    text: "Hi"
  });
  assert.equal(unroutable.statusCode, 202, unroutable.body);
  assert.equal(unroutable.data.accepted, false);
});

test("comms: SMS send + simulated inbound share a project conversation and cross-channel search finds both channels", async () => {
  const { client, orgId, suffix } = await registerOwner();
  const { projectId } = await createProject(client, orgId, suffix);

  const sent = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/sms/send`, {
    text: "Your crew arrives tomorrow between 8 and 9am. Reply here with any questions!"
  });
  assert.equal(sent.message.channel, "sms");
  assert.equal(sent.message.status, "sent");

  const inbound = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/simulate-inbound`, {
    channel: "sms",
    text: "Great, the gate code is 9876 for the crew."
  });
  assert.equal(inbound.message.direction, "inbound");
  assert.equal(inbound.message.test_mode, true);

  const conversation = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/sms`);
  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.messages[0].direction, "outbound");
  assert.equal(conversation.messages[1].direction, "inbound");

  // Also send an email so search spans channels.
  await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/send`, {
    subject: "Gate code confirmation",
    text: "Confirming the gate code you texted us."
  });

  const results = await client.request("GET", `/v1/comms/organizations/${orgId}/search?q=gate+code&project_id=${projectId}`);
  const channels = new Set(results.results.map((hit: any) => hit.channel));
  assert.ok(channels.has("sms"), `expected sms hit: ${JSON.stringify(results).slice(0, 300)}`);
  assert.ok(channels.has("email"), `expected email hit: ${JSON.stringify(results).slice(0, 300)}`);

  const overview = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/overview`);
  assert.equal(overview.overview.channels.sms.total, 2);
  assert.equal(overview.overview.channels.sms.inbound, 1);
  assert.equal(overview.overview.channels.email.total, 1);
  assert.ok(overview.overview.org_inbox_address.includes("@firstmatemail.com"));
});

test("comms: explicit email recipients and recipient-combination SMS threads support project contacts and arbitrary addresses", async () => {
  const { client, orgId, suffix } = await registerOwner();
  const { projectId, contactEmail, secondaryEmail, contactPhone, secondaryPhone } = await createProject(client, orgId, suffix);

  const overview = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/overview`);
  assert.equal(overview.overview.contacts.length, 3);
  assert.equal(overview.overview.contacts[0].primary, true);
  assert.equal(overview.overview.contacts[2].email, "");
  assert.equal(overview.overview.contacts[2].phone, "");

  const email = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/send`, {
    to: [secondaryEmail, "outside@example.test"],
    cc: [contactEmail],
    bcc: ["private@example.test"],
    subject: "Recipient controls",
    text: "This message exercises To, CC, and BCC."
  });
  assert.deepEqual(
    email.message.recipients.map((recipient: any) => [recipient.address, recipient.type]),
    [
      [secondaryEmail, "to"],
      ["outside@example.test", "to"],
      [contactEmail, "cc"],
      ["private@example.test", "bcc"]
    ]
  );

  const single = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/sms/send`, {
    to: secondaryPhone,
    text: "A separate thread for Jordan."
  });
  const group = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/sms/send`, {
    to: [contactPhone, secondaryPhone, "+12065550000"],
    text: "A project group text."
  });
  assert.notEqual(single.message.conversation_id, group.message.conversation_id);
  assert.equal(group.message.recipients.length, 3);

  const inbox = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/sms?conversation_id=${group.message.conversation_id}`);
  assert.equal(inbox.conversations.length, 2);
  assert.equal(inbox.conversation.id, group.message.conversation_id);
  assert.equal(inbox.conversation.participants.length, 3);
  assert.equal(inbox.messages.length, 1);

  const reply = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/sms/send`, {
    conversation_id: group.message.conversation_id,
    text: "Replying to the same group."
  });
  assert.equal(reply.message.conversation_id, group.message.conversation_id);
  assert.equal(reply.message.recipients.length, 3);
});

test("comms: settings resolve branch defaults with project overrides", async () => {
  const { client, orgId, suffix } = await registerOwner();
  const { projectId } = await createProject(client, orgId, suffix);

  const saved = await client.request("PUT", `/v1/comms/organizations/${orgId}/settings`, {
    settings: {
      notifications: { enabled: true, target_role_ids: ["office", "operations"] },
      agent: { agent_name: "Roofline AI", custom_instructions: "Always be brief.", auto_response: { enabled: true, mode: "draft" } }
    }
  });
  assert.deepEqual(saved.settings.notifications.target_role_ids, ["office", "operations"]);
  assert.equal(saved.settings.agent.agent_name, "Roofline AI");
  assert.equal(saved.settings.agent.auto_response.enabled, true);

  const overrides = await client.request("PUT", `/v1/comms/organizations/${orgId}/projects/${projectId}/settings`, {
    overrides: {
      notifications: { inherit: false, target_role_ids: ["sales"] },
      agent_instructions: "This customer prefers texts.",
      auto_response: "off"
    }
  });
  assert.equal(overrides.overrides.auto_response, "off");
  assert.deepEqual(overrides.overrides.notifications.target_role_ids, ["sales"]);

  const loaded = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/settings`);
  assert.equal(loaded.overrides.agent_instructions, "This customer prefers texts.");

  // With auto-response forced off for the project (and no OpenAI key anyway),
  // simulated inbound must not create an auto-reply but still notifies.
  await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/simulate-inbound`, {
    channel: "sms",
    text: "Are you coming today?"
  });
  const autoReplies = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/auto-replies`);
  assert.equal(autoReplies.auto_replies.length, 0);
});

test("comms: agent instruction registry assembles app-published sections", async () => {
  const { orgId } = await registerOwner();
  const { buildAgentInstructions, listAgentInstructionSections } = await import("../platform/agent_instructions.js");
  const ids = listAgentInstructionSections().map((section) => section.id);
  assert.ok(ids.includes("work.scheduling"), `registered sections: ${ids.join(", ")}`);
  assert.ok(ids.includes("messaging.sms"));
  assert.ok(ids.includes("email.engine"));
  assert.ok(ids.includes("comms.hub"));
  const text = await buildAgentInstructions(orgId, "default");
  assert.ok(text.includes("Scheduling project events"));
  assert.ok(text.includes("TEST MODE"), "capture-mode note should be published to agents");
  assert.ok(text.includes("Project communications"));
});

test("comms: agent thread CRUD is per-user and turns fail cleanly without an OpenAI key", async () => {
  const { client, orgId, suffix } = await registerOwner();
  const { projectId } = await createProject(client, orgId, suffix);

  const created = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/agent/threads`);
  const threadId = String(created.thread.id);
  assert.ok(threadId);

  const listed = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/agent/threads`);
  assert.equal(listed.threads.length, 1);

  // No OpenAI key: the turn should complete with a failure message rather
  // than a 500, and the thread should return to idle.
  const turn = await client.request("POST", `/v1/comms/organizations/${orgId}/projects/${projectId}/agent/threads/${threadId}/messages`, {
    message: "What did the customer last say?"
  });
  assert.equal(turn.status, "failed");
  assert.ok(String(turn.assistant_message.content).length > 0);
  const detail = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/agent/threads/${threadId}`);
  assert.equal(detail.thread.status, "idle");
  assert.equal(detail.messages.length, 2);
});
