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
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
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
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

test("channels API root responds", async () => {
  const response = await app.inject({ method: "GET", url: "/v1/channels/" });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).api, "channels");
});

test("message language detection and personal translation preferences are user-scoped", async () => {
  const { client: owner, orgId } = await registerOwner();
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  const defaults = await owner.request("GET", "/v1/platform/me/preferences");
  assert.deepEqual(defaults.preferences, { language: "en", auto_translate_messages: false, sidebar_width: 250 });

  const posted = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Hola equipo, empezamos el proyecto mañana."
  });
  assert.equal(posted.message.language_code, "es");
  assert.equal(posted.message.translation.available, true);
  assert.equal(posted.message.translation.target_language, "en");

  const saved = await owner.request("PATCH", "/v1/platform/me/preferences", {
    language: "es",
    auto_translate_messages: true,
    sidebar_width: 336
  });
  assert.deepEqual(saved.preferences, { language: "es", auto_translate_messages: true, sidebar_width: 336 });

  const refreshed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`);
  const message = refreshed.messages.find((item: Json) => item.id === posted.message.id);
  assert.equal(message.translation.available, false);
  assert.equal(message.translation.auto_translate, true);

  // Same-language requests are deterministic and require no model call.
  const translation = await owner.request("POST", `/v1/channels/organizations/${orgId}/messages/${message.id}/translation`, {});
  assert.equal(translation.translation.translated_text, message.text);
  assert.equal(translation.translation.cached, true);
});

test("listing channels seeds #general and creating channels enforces permissions", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  assert.ok(listed.channels.some((channel: Json) => channel.name === "general" && channel.type === "public"), "expected #general to be seeded");

  const member = await createOrgUser(owner, orgId, suffix, "Plain Member");
  const denied = await member.client.raw("POST", `/v1/channels/organizations/${orgId}/channels`, { type: "public", name: "off-limits" });
  assert.equal(denied.statusCode, 403, denied.body);

  const created = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels`, {
    type: "public",
    name: "Roof Talk",
    topic: "All things roofing"
  });
  assert.equal(created.channel.name, "roof-talk");
  assert.equal(created.channel.is_member, true);

  const configured = await owner.request("PATCH", `/v1/channels/organizations/${orgId}/channels/${created.channel.id}`, {
    settings: {
      huddle_recording_enabled: false,
      huddle_record_video: false
    }
  });
  assert.equal(configured.channel.settings.huddle_recording_enabled, false);
  assert.equal(configured.channel.settings.huddle_record_video, false);
});

test("call removal is host-only and blocks rejoin, media changes, and signaling", async () => {
  const { client:owner, orgId, userId, suffix } = await registerOwner();
  const teammate = await createOrgUser(owner, orgId, suffix, "Call Guest");
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel:Json) => channel.name === "general");
  const created = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/huddles`, {});
  const base = `/v1/channels/organizations/${orgId}/huddles/${created.huddle.id}`;
  await owner.request("POST", `${base}/join`, {});
  await teammate.client.request("POST", `${base}/join`, {});
  assert.equal((await teammate.client.raw("DELETE", `${base}/participants/${userId}`)).statusCode, 403);
  const removed = await owner.request("DELETE", `${base}/participants/${teammate.userId}`);
  assert.equal(removed.huddle.participants.find((person:Json) => person.user_id === teammate.userId).role, "removed");
  assert.equal((await teammate.client.raw("POST", `${base}/join`, {})).statusCode, 403);
  assert.ok((await teammate.client.raw("PATCH", `${base}/media-state`, {camera_enabled:true})).statusCode >= 400);
  assert.equal((await teammate.client.raw("GET", `${base}/signals?peer_id=guest&after=0`)).statusCode, 403);
  assert.equal((await teammate.client.raw("POST", `${base}/signals`, {sender_peer_id:"guest", kind:"hello", payload:{}})).statusCode, 403);
  await owner.request("POST", `${base}/end`, {});
});

test("separate assistant conversations have independent history and preserve the default DM", async () => {
  const { client:owner, orgId } = await registerOwner();
  const base = `/v1/channels/organizations/${orgId}`;
  const listed = await owner.request("GET", `${base}/channels`);
  const assistantDm = listed.channels.find((channel:Json) => channel.type === "dm" && channel.members.some((member:Json) => member.id.startsWith("agent_") && member.agent_id === "assistant"))
    || listed.channels.find((channel:Json) => channel.type === "dm" && channel.members.some((member:Json) => member.id.includes("assistant")));
  assert.ok(assistantDm, "default assistant conversation exists");
  const agent = assistantDm.members.find((member:Json) => member.id.startsWith("agent_"));
  const create = (name:string) => owner.request("POST", `${base}/channels`, {type:"dm", member_user_ids:[agent.id], new_conversation:true, name});
  const first = await create("Planning"); const second = await create("Research");
  assert.notEqual(first.channel.id, second.channel.id);
  assert.notEqual(first.channel.id, assistantDm.id);
  assert.equal(first.channel.display_name, "Planning");
  assert.deepEqual((await owner.request("GET", `${base}/channels/${first.channel.id}/messages`)).messages, []);
  assert.deepEqual((await owner.request("GET", `${base}/channels/${second.channel.id}/messages`)).messages, []);
  const defaultDm = await owner.request("POST", `${base}/channels`, {type:"dm", member_user_ids:[agent.id]});
  assert.equal(defaultDm.channel.id, assistantDm.id);
});

test("message lifecycle: post, dedupe, edit history, non-author 403s, soft delete and restore", async () => {
  const { client: owner, orgId, suffix, userId: ownerId } = await registerOwner();
  const member = await createOrgUser(owner, orgId, suffix, "Second Member");
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  const posted = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Original wording",
    client_msg_id: "cmid-1"
  });
  assert.equal(posted.deduplicated, false);
  const messageId = posted.message.id;
  assert.equal(posted.message.author.id, ownerId);

  const duplicate = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Original wording",
    client_msg_id: "cmid-1"
  });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.message.id, messageId);

  // Non-author cannot edit — even though this user could post.
  const editDenied = await member.client.raw("PATCH", `/v1/channels/organizations/${orgId}/messages/${messageId}`, { text: "hijacked" });
  assert.equal(editDenied.statusCode, 403, editDenied.body);

  const edited = await owner.request("PATCH", `/v1/channels/organizations/${orgId}/messages/${messageId}`, { text: "Second wording" });
  assert.equal(edited.message.text, "Second wording");
  assert.ok(edited.message.edited_at, "expected edited_at marker");
  await owner.request("PATCH", `/v1/channels/organizations/${orgId}/messages/${messageId}`, { text: "Third wording" });

  const revisions = await owner.request("GET", `/v1/channels/organizations/${orgId}/messages/${messageId}/revisions`);
  assert.equal(revisions.current.text, "Third wording");
  assert.deepEqual(revisions.revisions.map((revision: Json) => revision.text), ["Second wording", "Original wording"]);

  // Non-author, non-manager cannot delete.
  const deleteDenied = await member.client.raw("DELETE", `/v1/channels/organizations/${orgId}/messages/${messageId}`);
  assert.equal(deleteDenied.statusCode, 403, deleteDenied.body);

  const deleted = await owner.request("DELETE", `/v1/channels/organizations/${orgId}/messages/${messageId}`);
  assert.ok(deleted.message.deleted_at, "expected soft delete");
  assert.equal(deleted.message.can_restore, true);

  // Deleted messages appear as tombstones with no text for other members.
  const memberView = await member.client.request("GET", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`);
  const tombstone = memberView.messages.find((message: Json) => message.id === messageId);
  assert.ok(tombstone, "tombstone should still be listed");
  assert.equal(tombstone.text, "");
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.can_restore, false);

  const restoreDenied = await member.client.raw("POST", `/v1/channels/organizations/${orgId}/messages/${messageId}/restore`);
  assert.equal(restoreDenied.statusCode, 403, restoreDenied.body);

  const restored = await owner.request("POST", `/v1/channels/organizations/${orgId}/messages/${messageId}/restore`);
  assert.equal(restored.message.deleted_at, null);
  assert.equal(restored.message.text, "Third wording");
});

test("threads accumulate reply counts and replies never nest", async () => {
  const { client: owner, orgId } = await registerOwner();
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  const root = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "Thread root" });
  const reply = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "First reply",
    parent_id: root.message.id
  });
  // Replying to a reply attaches to the root.
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Nested attempt",
    parent_id: reply.message.id
  });

  const thread = await owner.request("GET", `/v1/channels/organizations/${orgId}/messages/${root.message.id}/thread`);
  assert.equal(thread.root.reply_count, 2);
  assert.deepEqual(thread.replies.map((message: Json) => message.text), ["First reply", "Nested attempt"]);

  // Thread replies do not appear in the top-level channel listing.
  const channelMessages = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`);
  assert.ok(!channelMessages.messages.some((message: Json) => message.parent_id));
});

test("reactions toggle on and off", async () => {
  const { client: owner, orgId, userId } = await registerOwner();
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");
  const posted = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "React to me" });

  const reacted = await owner.request("PUT", `/v1/channels/organizations/${orgId}/messages/${posted.message.id}/reactions`, { emoji: "🔥", on: true });
  assert.deepEqual(reacted.message.reactions, [{ emoji: "🔥", count: 1, user_ids: [userId], reacted: true }]);

  const removed = await owner.request("PUT", `/v1/channels/organizations/${orgId}/messages/${posted.message.id}/reactions`, { emoji: "🔥", on: false });
  assert.deepEqual(removed.message.reactions, []);
});

test("DMs are member-only: even the org owner cannot read someone else's DM", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const alice = await createOrgUser(owner, orgId, suffix, "Alice Member");
  const bob = await createOrgUser(owner, orgId, suffix, "Bob Member");

  const dm = await alice.client.request("POST", `/v1/channels/organizations/${orgId}/channels`, {
    type: "dm",
    member_user_ids: [bob.userId]
  });
  assert.equal(dm.channel.type, "dm");

  await alice.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${dm.channel.id}/messages`, { text: "psst — secret" });

  const bobView = await bob.client.request("GET", `/v1/channels/organizations/${orgId}/channels/${dm.channel.id}/messages`);
  assert.equal(bobView.messages.length, 1);

  const ownerDenied = await owner.raw("GET", `/v1/channels/organizations/${orgId}/channels/${dm.channel.id}/messages`);
  assert.equal(ownerDenied.statusCode, 403, ownerDenied.body);

  // Same pair creating the "same" DM converges on the existing channel.
  const again = await bob.client.request("POST", `/v1/channels/organizations/${orgId}/channels`, {
    type: "dm",
    member_user_ids: [alice.userId]
  });
  assert.equal(again.channel.id, dm.channel.id);
});

test("private channels 403 for non-members", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const outsider = await createOrgUser(owner, orgId, suffix, "Outsider Member");
  const created = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels`, {
    type: "private",
    name: "leadership"
  });
  const denied = await outsider.client.raw("GET", `/v1/channels/organizations/${orgId}/channels/${created.channel.id}/messages`);
  assert.equal(denied.statusCode, 403, denied.body);
});

test("project channels: ensure is idempotent and audience filtering hides office-only messages from crew", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const project = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects`, {
    data: { title: "Maple Street Reroof" }
  });
  const projectId = String(project.document.id);

  const ensured = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/project/${projectId}`);
  const ensuredAgain = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/project/${projectId}`);
  assert.equal(ensured.channel.id, ensuredAgain.channel.id);
  assert.equal(ensured.channel.type, "project");
  assert.equal(ensured.channel.name, "Maple Street Reroof");

  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${ensured.channel.id}/messages`, {
    text: "Office eyes only: margin details",
    audience: ["office"]
  });
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${ensured.channel.id}/messages`, {
    text: "Crew: tear-off starts at 7am",
    audience: ["crew"]
  });
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${ensured.channel.id}/messages`, {
    text: "Everyone can read this"
  });

  const crew = await createOrgUser(owner, orgId, suffix, "Crew Member", { field: true });
  const crewView = await crew.client.request("GET", `/v1/channels/organizations/${orgId}/channels/${ensured.channel.id}/messages`);
  const crewTexts = crewView.messages.map((message: Json) => message.text);
  assert.ok(crewTexts.includes("Crew: tear-off starts at 7am"));
  assert.ok(crewTexts.includes("Everyone can read this"));
  assert.ok(!crewTexts.includes("Office eyes only: margin details"), "crew must not see office-only messages");

  // The owner (all audiences) sees everything.
  const ownerView = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels/${ensured.channel.id}/messages`);
  assert.equal(ownerView.messages.length, 3);
});

test("read state, unread counts, and mention badges clear on read", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const reader = await createOrgUser(owner, orgId, suffix, "Reader Member");
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "one" });
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "hey @reader",
    mention_users: [{ id: reader.userId, name: "Reader Member" }]
  });

  const unreads = await reader.client.request("GET", `/v1/channels/organizations/${orgId}/unreads`);
  const generalUnread = unreads.channels[general.id];
  assert.equal(generalUnread.unread_count, 2);
  assert.equal(generalUnread.mention_count, 1);
  assert.ok(unreads.total_mentions >= 1);

  const messages = await reader.client.request("GET", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`);
  const maxSeq = Math.max(...messages.messages.map((message: Json) => message.seq));
  await reader.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/read`, { last_read_seq: maxSeq });

  const cleared = await reader.client.request("GET", `/v1/channels/organizations/${orgId}/unreads`);
  assert.equal(cleared.channels[general.id].unread_count, 0);
  assert.equal(cleared.channels[general.id].mention_count, 0);
});

test("mentions create platform notifications with channel deep-link actions", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const target = await createOrgUser(owner, orgId, suffix, "Mention Target");
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "ping @Mention Target",
    mention_users: [{ id: target.userId, name: "Mention Target" }]
  });

  const notifications = await target.client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const mention = (notifications.notifications ?? []).find((notification: Json) => notification.kind === "mention");
  assert.ok(mention, "expected a mention notification");
  assert.equal(mention.frontend_action.kind, "open_channel_message");
  assert.equal(mention.frontend_action.channel_id, general.id);
});

test("pins and saved messages round-trip", async () => {
  const { client: owner, orgId } = await registerOwner();
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");
  const posted = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "Pin-worthy" });

  const pinned = await owner.request("POST", `/v1/channels/organizations/${orgId}/messages/${posted.message.id}/pin`);
  assert.ok(pinned.message.pinned_at);
  const pins = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels/${general.id}/pins`);
  assert.equal(pins.messages.length, 1);

  await owner.request("PUT", `/v1/channels/organizations/${orgId}/saved/${posted.message.id}`);
  const saved = await owner.request("GET", `/v1/channels/organizations/${orgId}/saved`);
  assert.ok(saved.messages.some((message: Json) => message.id === posted.message.id));
  await owner.request("DELETE", `/v1/channels/organizations/${orgId}/saved/${posted.message.id}`);
  const cleared = await owner.request("GET", `/v1/channels/organizations/${orgId}/saved`);
  assert.equal(cleared.messages.length, 0);
});

test("search finds messages, excludes deleted ones, and respects private membership", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const outsider = await createOrgUser(owner, orgId, suffix, "Search Outsider");
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  const keeper = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "The zanzibar shipment arrived" });
  const goner = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "zanzibar duplicate to remove" });
  await owner.request("DELETE", `/v1/channels/organizations/${orgId}/messages/${goner.message.id}`);

  const secret = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels`, { type: "private", name: "search-secrets" });
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${secret.channel.id}/messages`, { text: "zanzibar classified intel" });

  const ownerResults = await owner.request("GET", `/v1/channels/organizations/${orgId}/search?q=zanzibar`);
  const ownerTexts = ownerResults.messages.map((message: Json) => message.text);
  assert.ok(ownerTexts.includes("The zanzibar shipment arrived"));
  assert.ok(ownerTexts.includes("zanzibar classified intel"));
  assert.ok(!ownerTexts.includes("zanzibar duplicate to remove"), "deleted messages must not match search");
  assert.equal(keeper.message.id, ownerResults.messages.find((m: Json) => m.text === "The zanzibar shipment arrived").id);

  const outsiderResults = await outsider.client.request("GET", `/v1/channels/organizations/${orgId}/search?q=zanzibar`);
  const outsiderTexts = outsiderResults.messages.map((message: Json) => message.text);
  assert.ok(outsiderTexts.includes("The zanzibar shipment arrived"));
  assert.ok(!outsiderTexts.includes("zanzibar classified intel"), "private channel content must not leak into search");
});

test("manage_channels users can delete and restore other people's messages", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const author = await createOrgUser(owner, orgId, suffix, "Message Author");
  const moderator = await createOrgUser(owner, orgId, suffix, "Channel Moderator", {
    role: "custom",
    permissions: { manage_channels: true }
  });
  const listed = await author.client.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  const posted = await author.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "moderate me" });

  // Moderators still may not EDIT someone else's message.
  const editDenied = await moderator.client.raw("PATCH", `/v1/channels/organizations/${orgId}/messages/${posted.message.id}`, { text: "rewritten" });
  assert.equal(editDenied.statusCode, 403, editDenied.body);

  const deleted = await moderator.client.request("DELETE", `/v1/channels/organizations/${orgId}/messages/${posted.message.id}`);
  assert.ok(deleted.message.deleted_at);
  const restored = await moderator.client.request("POST", `/v1/channels/organizations/${orgId}/messages/${posted.message.id}/restore`);
  assert.equal(restored.message.deleted_at, null);
});

test("archived channels reject new messages", async () => {
  const { client: owner, orgId } = await registerOwner();
  const created = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels`, { type: "public", name: "sunset" });
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${created.channel.id}/archive`);
  const denied = await owner.raw("POST", `/v1/channels/organizations/${orgId}/channels/${created.channel.id}/messages`, { text: "too late" });
  assert.equal(denied.statusCode, 400, denied.body);
});

test("reusable calls API owns room lifecycle and media state outside channels", async () => {
  const { client: owner, orgId, userId } = await registerOwner();
  const created = await owner.request("POST", `/v1/calls/organizations/${orgId}/rooms`, {
    context_type: "project",
    context_id: "project_calls_test",
    title: "Project kickoff",
    allow_video: true,
    recording_mode: "off"
  });
  assert.equal(created.room.context_type, "project");
  assert.equal(created.room.provider, "browser-peer");

  const joined = await owner.request("POST", `/v1/calls/organizations/${orgId}/rooms/${created.room.id}/join`, {});
  assert.equal(joined.room.connection.mode, "browser-peer");
  assert.ok(joined.room.participants.some((participant: Json) => participant.user_id === userId && !participant.left_at));

  const media = await owner.request("PATCH", `/v1/calls/organizations/${orgId}/rooms/${created.room.id}/media-state`, {
    microphone_enabled: false,
    camera_enabled: true
  });
  const participant = media.room.participants.find((item: Json) => item.user_id === userId);
  assert.equal(participant.microphone_enabled, false);
  assert.equal(participant.camera_enabled, true);

  const ended = await owner.request("POST", `/v1/calls/organizations/${orgId}/rooms/${created.room.id}/end`, {});
  assert.equal(ended.room.state, "ended");
  const events = await owner.request("GET", `/v1/calls/organizations/${orgId}/events?room_id=${created.room.id}`);
  assert.ok(events.events.some((event: Json) => event.kind === "call_started"));
  assert.ok(events.events.some((event: Json) => event.kind === "call_ended"));
});

test("collaboration attention, manual unread, followed threads, drafts, tabs, folders, and resources round-trip", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const teammate = await createOrgUser(owner, orgId, suffix, "Collaboration Teammate");
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  const root = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Please review this work",
    mention_users: [{ id: teammate.userId, name: "Collaboration Teammate" }]
  });
  const reply = await teammate.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Reviewing now",
    parent_id: root.message.id
  });

  const activity = await teammate.client.request("GET", `/v1/channels/organizations/${orgId}/activity`);
  assert.ok(activity.items.some((item: Json) => item.message_id === root.message.id && item.kind === "mention"));
  const ownerActivity = await owner.request("GET", `/v1/channels/organizations/${orgId}/activity`);
  assert.ok(ownerActivity.items.some((item: Json) => item.message_id === reply.message.id && item.kind === "thread_reply"));

  await teammate.client.request("PUT", `/v1/channels/organizations/${orgId}/threads/${root.message.id}/subscription`, {
    following: true,
    notify_level: "all"
  });
  const threads = await teammate.client.request("GET", `/v1/channels/organizations/${orgId}/threads`);
  assert.ok(threads.threads.some((thread: Json) => thread.root.id === root.message.id));

  await teammate.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/read`, {
    last_read_seq: reply.message.seq
  });
  await teammate.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/unread`, {
    seq: root.message.seq
  });
  const unreads = await teammate.client.request("GET", `/v1/channels/organizations/${orgId}/unreads`);
  assert.equal(unreads.channels[general.id].manual_unread_seq, root.message.seq);
  assert.ok(unreads.channels[general.id].unread_count >= 1);

  await teammate.client.request("PUT", `/v1/channels/organizations/${orgId}/drafts/channel-test`, {
    channel_id: general.id,
    text: "Saved on another device"
  });
  const draft = await teammate.client.request("GET", `/v1/channels/organizations/${orgId}/drafts/channel-test`);
  assert.equal(draft.draft.text, "Saved on another device");

  const tabs = await teammate.client.request("GET", `/v1/channels/organizations/${orgId}/channels/${general.id}/tabs`);
  assert.ok(tabs.tabs.some((tab: Json) => tab.kind === "documents"));
  const folder = await teammate.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/folders`, {
    label: "Launch assets"
  });
  const resource = await teammate.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/resources`, {
    resource_type: "link",
    resource_id: "https://example.test/launch",
    folder_id: folder.folder.id,
    display_note: "Launch plan"
  });
  const resources = await teammate.client.request("GET", `/v1/channels/organizations/${orgId}/channels/${general.id}/resources`);
  assert.ok(resources.resources.some((item: Json) => item.id === resource.resource.id));
});

test("message-to-To-Do and huddle lifecycle keep channel context", async () => {
  const { client: owner, orgId, userId } = await registerOwner();
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "channels.recording": true }
  });
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");
  const posted = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Confirm the installation date"
  });

  const todo = await owner.request("POST", `/v1/channels/organizations/${orgId}/messages/${posted.message.id}/action-items`, {
    title: "Confirm installation date",
    priority: "high",
    client_operation_id: "todo-test"
  });
  assert.equal(todo.action_item.title, "Confirm installation date");
  assert.equal(todo.resource_ref.source_message_id, posted.message.id);

  const reminder = await owner.request("POST", `/v1/channels/organizations/${orgId}/messages/${posted.message.id}/reminders`, {
    remind_at: new Date(Date.now() + 60_000).toISOString()
  });
  const reminders = await owner.request("GET", `/v1/channels/organizations/${orgId}/reminders`);
  assert.equal(reminders.reminders[0].id, reminder.reminder.id);
  assert.equal(reminders.reminders[0].message.id, posted.message.id);

  const started = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/huddles`, {
    audio: true,
    video: false,
    recording_enabled: true
  });
  assert.equal(started.huddle.state, "active");
  assert.equal(started.huddle.channel_id, general.id);
  const joined = await owner.request("POST", `/v1/channels/organizations/${orgId}/huddles/${started.huddle.id}/join`, {});
  assert.ok(joined.huddle.signaling.room);
  const left = await owner.request("POST", `/v1/channels/organizations/${orgId}/huddles/${started.huddle.id}/leave`, {});
  assert.ok(left.huddle.participants.some((participant: Json) => participant.left_at), "leaving marks the participant inactive");
  const rejoined = await owner.request("POST", `/v1/channels/organizations/${orgId}/huddles/${started.huddle.id}/join`, {});
  assert.ok(rejoined.huddle.participants.some((participant: Json) => !participant.left_at), "joining again clears the prior leave state");
  const signal = await owner.request("POST", `/v1/channels/organizations/${orgId}/huddles/${started.huddle.id}/signals`, {
    sender_peer_id: "browser-a",
    target_peer_id: "browser-b",
    kind: "offer",
    payload: { description: { type: "offer", sdp: "test-sdp" } }
  });
  const signals = await owner.request("GET", `/v1/channels/organizations/${orgId}/huddles/${started.huddle.id}/signals?peer_id=browser-b&after=0`);
  assert.equal(signals.signals[0].id, signal.signal.id);
  assert.equal(signals.signals[0].payload.description.sdp, "test-sdp");
  const { createAttachmentRecord } = await import("../channels/storage.js");
  const recordingAttachment = (await createAttachmentRecord({
    organization_id: orgId,
    channel_id: general.id,
    media_id: "media_huddle_recording_test",
    file_name: "Huddle recording.webm",
    content_type: "audio/webm",
    size_bytes: 128,
    uploaded_by: userId
  }));
  const recording = await owner.request("POST", `/v1/channels/organizations/${orgId}/huddles/${started.huddle.id}/recording`, {
    attachment_id: recordingAttachment.id
  });
  assert.equal(recording.huddle.recording_media_id, "media_huddle_recording_test");
  assert.equal(recording.message.parent_id, started.huddle.root_message_id);
  assert.equal(recording.message.metadata.event, "huddle_recording");
  assert.equal(recording.message.attachments[0].media_id, "media_huddle_recording_test");
  const ended = await owner.request("POST", `/v1/channels/organizations/${orgId}/huddles/${started.huddle.id}/end`, {});
  assert.equal(ended.huddle.state, "ended");
  const activity = await owner.request("GET", `/v1/channels/organizations/${orgId}/activity`);
  assert.ok(activity.items.some((item: Json) => item.kind === "huddle_started" && item.message_id === started.huddle.root_message_id));
  assert.ok(activity.items.some((item: Json) => item.kind === "huddle_ended"));
});

test("directory exposes shared profile details without private account fields", async () => {
  const { client, orgId, suffix } = await registerOwner();
  const created = await client.request("POST", `/v1/platform/organizations/${orgId}/users`, { data: {
    name:"Profile Teammate", email:`profile-${suffix}@example.test`, password:"profile test password", status:"active", role:"viewer", send_invite:false,
    job_title:"Project manager", department:"Operations", pronouns:"they/them", work_phone:"+1 555 0100", time_zone:"America/Los_Angeles", bio:"Project coordination", location:"Seattle", private_notes:"Do not expose"
  }});
  // Seed shared profile fields on the stored member, as imported profiles do.
  // Account creation deliberately accepts a smaller set of account fields.
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "users", { id:created.document.id, data:{
    job_title:"Project manager", department:"Operations", pronouns:"they/them", work_phone:"+1 555 0100", time_zone:"America/Los_Angeles", bio:"Project coordination", location:"Seattle", private_notes:"Do not expose"
  }});
  const result = await client.request("GET", `/v1/channels/organizations/${orgId}/directory`);
  const person = result.users.find((user: Json) => user.id === created.document.id);
  assert.equal(person.title, "Project manager");
  assert.equal(person.department, "Operations");
  assert.equal(person.pronouns, "they/them");
  assert.equal(person.phone, "+1 555 0100");
  assert.equal(person.bio, "Project coordination");
  assert.equal(person.time_zone, "America/Los_Angeles");
  assert.equal(person.password, undefined);
  assert.equal(person.private_notes, undefined);
});
