import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type Json = Record<string, any>;

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
  const request = async (method: string, url: string, payload?: unknown) => {
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
      cookie = [sessionCookie || "", csrfCookie || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request };
}
type TestClient = ReturnType<typeof createSessionClient>;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-channels-inbox-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, "channels");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.OPENAI_API_KEY = "test-openai-key";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { stopChannelAgentScheduler } = await import("../channels/agent.js");
  stopChannelAgentScheduler();
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
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const client = createSessionClient();
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Olive Owner",
    company: "Inbox Test Co",
    organization_id: `org_inbox_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return {
    client,
    suffix,
    orgId: data.organization.id as string,
    userId: String(data.user?.id || data.membership?.user_id || "")
  };
}

async function createOrgUser(owner: TestClient, orgId: string, suffix: string, name: string) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}@example.test`;
  const password = `${name} test password`;
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name, status: "active", role: "admin", send_invite: false }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId: String(created.document.id), client };
}

test("personal inbox: mentions, DMs, replies, and reactions surface; plain channel chatter does not", async () => {
  const { client: owner, orgId, userId: ownerId, suffix } = await registerOwner();
  const { client: colleague, userId: colleagueId } = await createOrgUser(owner, orgId, suffix, "Carl Colleague");

  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");
  assert.ok(general, "general channel exists");

  // Plain chatter (no mention) must NOT reach the owner's inbox — channel
  // notifications default to mention-driven.
  await colleague.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Just thinking out loud here."
  });
  let inbox = await owner.request("GET", `/v1/channels/organizations/${orgId}/inbox`);
  assert.equal(inbox.entries.length, 0, "no inbox noise from plain channel chatter");
  assert.equal(inbox.unread_total, 0);

  // A mention lands in the inbox.
  await colleague.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "@Olive Owner can you look at this?",
    mention_users: [{ id: ownerId, name: "Olive Owner" }]
  });
  // A reply under the owner's message lands in the inbox.
  const rootMessage = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Root message from the owner."
  });
  await colleague.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, {
    text: "Replying to your root message.",
    parent_id: rootMessage.message.id
  });
  // A reaction on the owner's message lands in the inbox.
  await colleague.request("PUT", `/v1/channels/organizations/${orgId}/messages/${rootMessage.message.id}/reactions`, {
    emoji: "🔥"
  });
  // A DM to the owner lands in the inbox.
  const dm = await colleague.request("POST", `/v1/channels/organizations/${orgId}/channels`, {
    type: "dm", name: "", topic: "", member_user_ids: [ownerId]
  });
  await colleague.request("POST", `/v1/channels/organizations/${orgId}/channels/${dm.channel.id}/messages`, {
    text: "Direct ping for you."
  });

  inbox = await owner.request("GET", `/v1/channels/organizations/${orgId}/inbox`);
  const kinds = inbox.entries.map((entry: Json) => entry.kind).sort();
  assert.deepEqual(kinds, ["dm", "mention", "reaction", "reply"]);
  assert.ok(inbox.entries.every((entry: Json) => entry.unread === true));
  assert.equal(inbox.unread_total, 4);
  const mention = inbox.entries.find((entry: Json) => entry.kind === "mention");
  assert.equal(mention.channel_name, "#general");
  assert.equal(mention.author.name, "Carl Colleague");
  const reaction = inbox.entries.find((entry: Json) => entry.kind === "reaction");
  assert.equal(reaction.emoji, "🔥");

  // Opening the dropdown acknowledges replies/reactions but not mentions/DMs.
  await owner.request("POST", `/v1/channels/organizations/${orgId}/inbox/seen`, {});
  inbox = await owner.request("GET", `/v1/channels/organizations/${orgId}/inbox`);
  const unreadKinds = inbox.entries.filter((entry: Json) => entry.unread).map((entry: Json) => entry.kind).sort();
  assert.deepEqual(unreadKinds, ["dm", "mention"]);
  assert.equal(inbox.unread_total, 2);

  // Reading the channel clears the mention; reading the DM clears the DM.
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/read`, { last_read_seq: 9999 });
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${dm.channel.id}/read`, { last_read_seq: 9999 });
  inbox = await owner.request("GET", `/v1/channels/organizations/${orgId}/inbox`);
  assert.equal(inbox.unread_total, 0);
  assert.ok(!inbox.entries.some((entry: Json) => entry.kind === "mention"), "read mentions drop out");
});

test("subscribing to a channel (notify all) surfaces its unread chatter; default stays quiet", async () => {
  const { client: owner, orgId, userId: ownerId, suffix } = await registerOwner();
  const { client: colleague } = await createOrgUser(owner, orgId, suffix, "Nina Noisy");

  const created = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels`, {
    type: "public", name: "installs", topic: "", member_user_ids: []
  });
  const channelId = created.channel.id as string;
  // Owner joins by posting (Slack-style), then opts into everything. Their
  // own message never counts as unread, so no read-marking is needed.
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${channelId}/messages`, { text: "Kicking this off." });
  await owner.request("PATCH", `/v1/channels/organizations/${orgId}/channels/${channelId}/members/${ownerId}`, { notify_level: "all" });

  await colleague.request("POST", `/v1/channels/organizations/${orgId}/channels/${channelId}/messages`, { text: "Plain update, no mention." });
  const inbox = await owner.request("GET", `/v1/channels/organizations/${orgId}/inbox`);
  const channelEntry = inbox.entries.find((entry: Json) => entry.kind === "channel");
  assert.ok(channelEntry, "subscribed channel chatter appears");
  assert.equal(channelEntry.channel_name, "#installs");
  assert.equal(channelEntry.count, 1);
  assert.ok(inbox.unread_total >= 1);
});
