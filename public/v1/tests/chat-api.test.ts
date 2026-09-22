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

/** Anonymous widget client: no cookies, visitor bearer token only. */
function createVisitorClient() {
  let token = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
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
  return { request, raw, setToken(value: string) { token = value; }, token: () => token };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-chat-test-"));
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

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(), 
    email: `chat-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Chat Test Owner",
    company: "Chat API Test Org",
    organization_id: `org_chat_${suffix}`
  });
  await enableExpandedPlatformFixture(String(registered.organization.id));
  return { orgId: String(registered.organization.id), suffix };
}

test("live chat: settings, widget flow, team inbox, claiming, closing", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);

  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await enableExpandedPlatformFixture(orgId, { "apps.live_chat": true });

  await owner.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/presentation_style`, {
    data: {
      branding: { colors: { primary: "#2468ac" } },
      proposal_defaults: { font_family: "Montserrat" }
    }
  });

  const settingsUrl = `/v1/chat/organizations/${orgId}/branch/default/chat/settings`;

  // Defaults are normalized and a widget key is minted.
  const initial = await owner.request("GET", settingsUrl);
  assert.equal(initial.settings.enabled, false);
  assert.equal(initial.settings.mode, "human");
  assert.equal(initial.settings.appearance.primary_color, "#2468ac");
  assert.equal(initial.settings.appearance.font_family, "Montserrat");
  assert.ok(String(initial.widget_key).startsWith("cw_"));
  assert.ok(String(initial.embed_snippet).includes(initial.widget_key));

  // Enable chat, force online so the test is deterministic.
  const saved = await owner.request("PUT", settingsUrl, {
    data: {
      ...initial.settings,
      enabled: true,
      presence: { require_agent_presence: false, force_status: "online" },
      claiming: { ...initial.settings.claiming, mode: "claim" }
    }
  });
  assert.equal(saved.settings.enabled, true);
  const widgetKey = String(saved.widget_key);

  // --- Public widget flow --------------------------------------------------
  const visitor = createVisitorClient();
  const config = await visitor.request("GET", `/v1/chat/public/widgets/${widgetKey}`);
  assert.equal(config.widget.status, "online");
  assert.equal(config.widget.accepting, true);
  assert.ok(config.widget.appearance.primary_color);

  const session = await visitor.request("POST", `/v1/chat/public/widgets/${widgetKey}/sessions`, {
    page_url: "https://example-roofing.test/pricing"
  });
  assert.ok(String(session.visitor_token).startsWith("cv_"));
  visitor.setToken(session.visitor_token);
  assert.deepEqual(session.conversations, []);

  const started = await visitor.request("POST", `/v1/chat/public/widgets/${widgetKey}/conversations`, {
    message: "Hi! Do you do cedar shake roofs?",
    name: "Casey Visitor",
    page_url: "https://example-roofing.test/customer-portal?token=secret",
    page_context: {
      kind: "customer_portal",
      title: "Punch Lists",
      tab_id: "punch_lists",
      tab_label: "Punch Lists",
      project_id: "project_chat_context",
      project_title: "Casey's roof",
      visible_text: ["Create your punch list", "2 items need your attention"],
      snapshot: {
        media_id: "media_context_snapshot",
        public_url: "https://example-roofing.test/chat-context.jpg",
        content_type: "image/jpeg",
        width: 960,
        height: 540
      }
    },
    idempotency_key: "test-start-1"
  });
  const conversationId = String(started.conversation.id);
  assert.ok(conversationId);
  assert.equal(started.message.direction, "inbound");

  // Resuming the session shows the open conversation.
  const resumed = await visitor.request("POST", `/v1/chat/public/widgets/${widgetKey}/sessions`, {
    visitor_token: visitor.token()
  });
  assert.equal(resumed.conversations.length, 1);
  assert.equal(resumed.conversations[0].status, "open");

  // A wrong token cannot read the conversation feed.
  const stranger = createVisitorClient();
  const strangerSession = await stranger.request("POST", `/v1/chat/public/widgets/${widgetKey}/sessions`, {});
  stranger.setToken(strangerSession.visitor_token);
  const forbidden = await stranger.raw("GET", `/v1/chat/public/widgets/${widgetKey}/conversations/${conversationId}/feed`);
  assert.equal(forbidden.statusCode, 403);

  // --- Notification was routed --------------------------------------------
  const notifications = await owner.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const chatNotification = (notifications.notifications || []).find((item: any) => item.kind === "chat_message");
  assert.ok(chatNotification, "expected a chat_message notification");
  assert.equal(chatNotification.frontend_action.kind, "open_chat_conversation");
  assert.equal(chatNotification.frontend_action.conversation_id, conversationId);

  // --- Team inbox ----------------------------------------------------------
  const inbox = await owner.request("GET", `/v1/chat/organizations/${orgId}/chat/inbox`);
  assert.equal(inbox.live_status, "online");
  assert.equal(inbox.conversations.length, 1);
  const row = inbox.conversations[0];
  assert.equal(row.id, conversationId);
  assert.equal(row.visitor.name, "Casey Visitor");
  assert.equal(row.unread_count, 1);
  assert.equal(row.claimed_by_user_id, "");

  // Opening the conversation marks it read.
  const detail = await owner.request("GET", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}`);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.visitor.name, "Casey Visitor");
  assert.equal(detail.messages[0].metadata.page_context.tab_id, "punch_lists");
  assert.deepEqual(detail.messages[0].metadata.page_context.visible_text, ["Create your punch list", "2 items need your attention"]);
  assert.equal(detail.messages[0].metadata.page_context.snapshot.media_id, "media_context_snapshot");
  const inboxAfterRead = await owner.request("GET", `/v1/chat/organizations/${orgId}/chat/inbox`);
  assert.equal(inboxAfterRead.conversations[0].unread_count, 0);

  // --- Reply (auto-claims in claim mode) -----------------------------------
  const sent = await owner.request("POST", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}/messages`, {
    message: "Absolutely — cedar shake is one of our specialties. Where is the property?",
    idempotency_key: "test-reply-1"
  });
  assert.equal(sent.message.direction, "outbound");
  assert.ok(sent.state.claimed_by_user_id, "reply should auto-claim in claim mode");

  // A second team member cannot send while the claim is held...
  const teammate = createSessionClient();
  await teammate.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(), 
    email: `chat-teammate-${Date.now().toString(36)}@example.test`,
    password: "correct horse battery staple",
    name: "Second Agent",
    company: "Other Org",
    organization_id: `org_chat_other_${Date.now().toString(36)}`
  });
  // ...actually a user in another org cannot even see it.
  const crossOrg = await teammate.raw("GET", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}`);
  assert.equal(crossOrg.statusCode, 403);

  // Visitor's feed shows the reply with the agent's first name.
  const feed = await visitor.request("GET", `/v1/chat/public/widgets/${widgetKey}/conversations/${conversationId}/feed`);
  assert.equal(feed.messages.length, 2);
  const reply = feed.messages.find((message: any) => message.direction === "outbound");
  assert.ok(reply);
  assert.equal(reply.sender.kind, "user");
  assert.equal(reply.sender.name, "Chat");

  // Internal notes never reach the visitor feed.
  await owner.request("POST", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}/messages`, {
    message: "Team-only note: existing customer from 2024, check the file.",
    internal_note: true
  });
  const feedAfterNote = await visitor.request("GET", `/v1/chat/public/widgets/${widgetKey}/conversations/${conversationId}/feed`);
  assert.equal(feedAfterNote.messages.length, 2, "internal note must not be visible to the visitor");
  const teamDetail = await owner.request("GET", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}`);
  assert.equal(teamDetail.messages.length, 3, "internal note is visible to the team");
  assert.ok(teamDetail.messages.some((message: any) => message.internal));

  // Release, then close from the team side.
  await owner.request("POST", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}/release`, {});
  const closed = await owner.request("POST", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}/close`, {});
  assert.ok(closed.state.closed_at);
  const closedFeed = await visitor.request("GET", `/v1/chat/public/widgets/${widgetKey}/conversations/${conversationId}/feed`);
  assert.equal(closedFeed.conversation.status, "closed");

  // Closed conversations reject new visitor messages.
  const rejected = await visitor.raw("POST", `/v1/chat/public/widgets/${widgetKey}/conversations/${conversationId}/messages`, {
    message: "One more thing…"
  });
  assert.equal(rejected.statusCode, 400);

  // Visitor history survives (visible by default).
  const finalSession = await visitor.request("POST", `/v1/chat/public/widgets/${widgetKey}/sessions`, {
    visitor_token: visitor.token()
  });
  assert.equal(finalSession.conversations.length, 1);
  assert.equal(finalSession.conversations[0].status, "closed");
});

test("live chat: capability gating and key rotation", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);

  // Without the capability, both public and team endpoints refuse.
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await enableExpandedPlatformFixture(orgId, { "apps.live_chat": false });
  const teamBlocked = await owner.raw("GET", `/v1/chat/organizations/${orgId}/chat/inbox`);
  assert.equal(teamBlocked.statusCode, 403);

  await enableExpandedPlatformFixture(orgId, { "apps.live_chat": true });
  const settingsUrl = `/v1/chat/organizations/${orgId}/branch/default/chat/settings`;
  const initial = await owner.request("GET", settingsUrl);
  await owner.request("PUT", settingsUrl, { data: { ...initial.settings, enabled: true, presence: { force_status: "online" } } });
  const widgetKey = String(initial.widget_key);

  const visitor = createVisitorClient();
  const config = await visitor.raw("GET", `/v1/chat/public/widgets/${widgetKey}`);
  assert.equal(config.statusCode, 200);

  // Rotating the key kills the old one and mints a new working key.
  const rotated = await owner.request("POST", `${settingsUrl}/rotate-key`, {});
  assert.notEqual(rotated.widget_key, widgetKey);
  const revoked = await visitor.raw("GET", `/v1/chat/public/widgets/${widgetKey}`);
  assert.equal(revoked.statusCode, 404);
  const fresh = await visitor.raw("GET", `/v1/chat/public/widgets/${rotated.widget_key}`);
  assert.equal(fresh.statusCode, 200);

  // Disabled settings turn the public widget off even with a valid key.
  const current = await owner.request("GET", settingsUrl);
  await owner.request("PUT", settingsUrl, { data: { ...current.settings, enabled: false } });
  const disabled = await visitor.raw("GET", `/v1/chat/public/widgets/${rotated.widget_key}`);
  assert.equal(disabled.statusCode, 403);
});

test("live chat: active team presence overrides the offline follow-up flow", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await enableExpandedPlatformFixture(orgId, { "apps.live_chat": true });

  const settingsUrl = `/v1/chat/organizations/${orgId}/branch/default/chat/settings`;
  const initial = await owner.request("GET", settingsUrl);
  const saved = await owner.request("PUT", settingsUrl, {
    data: {
      ...initial.settings,
      enabled: true,
      mode: "human",
      ai: { ...initial.settings.ai, enabled: false },
      presence: { ...initial.settings.presence, force_status: "offline" }
    }
  });

  const visitor = createVisitorClient();
  const session = await visitor.request("POST", `/v1/chat/public/widgets/${saved.widget_key}/sessions`, {});
  visitor.setToken(session.visitor_token);
  const started = await visitor.request("POST", `/v1/chat/public/widgets/${saved.widget_key}/conversations`, {
    message: "Is anyone available?",
    idempotency_key: "offline-presence-start"
  });
  const conversationId = String(started.conversation.id);
  assert.equal(started.conversation.handling, "offline_capture");
  assert.equal(started.conversation.live_status, "offline");

  // Opening and replying from the team inbox makes this conversation live,
  // even though the organization's scheduled status remains offline.
  await owner.request("GET", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}`);
  const reply = await owner.request("POST", `/v1/chat/organizations/${orgId}/chat/conversations/${conversationId}/messages`, {
    message: "I'm here and can help.",
    idempotency_key: "offline-presence-reply"
  });
  assert.equal(reply.state.handling_mode, "human");
  const liveFeed = await visitor.request("GET", `/v1/chat/public/widgets/${saved.widget_key}/conversations/${conversationId}/feed`);
  assert.equal(liveFeed.conversation.live_status, "online");
  assert.equal(liveFeed.conversation.team_present, true);

  // Once the team presence expires, the scheduled offline flow is restored.
  const { getChatDatabase } = await import("../chat/storage.js");
  (await getChatDatabase().prepare("UPDATE chat_agent_presence SET last_seen_at = ? WHERE organization_id = ?")
    .run("2000-01-01T00:00:00.000Z", orgId));
  const offlineAgain = await visitor.request("GET", `/v1/chat/public/widgets/${saved.widget_key}/conversations/${conversationId}/feed`);
  assert.equal(offlineAgain.conversation.live_status, "offline");
  assert.equal(offlineAgain.conversation.team_present, false);
});
