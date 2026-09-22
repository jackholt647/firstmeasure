import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";
let baseUrl = "";

type Json = Record<string, any>;

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await app.inject({
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
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, cookieHeader: () => cookie };
}

type TestClient = ReturnType<typeof createSessionClient>;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-channels-sse-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, "channels");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const { resetRealtimeForTests } = await import("../platform/realtime.js");
  resetRealtimeForTests();
  const { closeChannelsDatabase } = await import("../channels/storage.js");
  (await closeChannelsDatabase());
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
    email: `sse-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "SSE Owner",
    company: "SSE Test Org",
    organization_id: `org_sse_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return { client, suffix, orgId: String(registered.organization.id), userId: String(registered.user.id) };
}

async function createOrgUser(owner: TestClient, orgId: string, suffix: string, name: string) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}@example.test`;
  const password = `${name} test password`;
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name, status: "active", role: "viewer", send_invite: false }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId: String(created.document.id), client };
}

/** Read the SSE stream until predicate matches or timeout; returns raw frames. */
async function collectStream(
  cookie: string,
  orgId: string,
  options: { until: (frames: string[]) => boolean; timeoutMs?: number; after?: number; lastEventId?: number }
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const frames: string[] = [];
  try {
    const response = await fetch(`${baseUrl}/v1/platform/organizations/${orgId}/events/stream${options.after ? `?after=${options.after}` : ""}`, {
      headers: {
        cookie,
        ...(options.lastEventId ? { "last-event-id": String(options.lastEventId) } : {})
      },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        frames.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\n\n");
      }
      if (options.until(frames)) return frames;
    }
  } catch (error: any) {
    if (error?.name !== "AbortError" && error?.code !== "ABORT_ERR" && !controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return frames;
}

function parseEvents(frames: string[]) {
  return frames
    .filter((frame) => frame.includes("data: "))
    .map((frame) => {
      const idLine = frame.split("\n").find((line) => line.startsWith("id: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))!;
      return { id: idLine ? Number(idLine.slice(4)) : null, data: JSON.parse(dataLine.slice(6)) as Json };
    });
}

test("SSE stream delivers channel messages with ids and replays via Last-Event-ID", async () => {
  const { client: owner, orgId } = await registerOwner();
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  const streaming = collectStream(owner.cookieHeader(), orgId, {
    until: (frames) => frames.filter((frame) => frame.includes("channels.message.created")).length >= 2
  });
  // Give the stream a beat to connect before posting.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "live wire" });
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "second wire" });
  const frames = await streaming;

  const events = parseEvents(frames).filter((event) => event.data.topic === "channels.message.created");
  assert.equal(events.length, 2, `expected two message events, got: ${JSON.stringify(events)}`);
  const [first, second] = events;
  assert.ok(first!.id! > 0 && second!.id! > first!.id!, "SSE events carry sequential ids");
  assert.equal(first!.data.payload.channel_id, general.id);
  assert.equal(first!.data.payload.message.text, "live wire");

  // Reconnect with Last-Event-ID at the first event: the second replays.
  const replayFrames = await collectStream(owner.cookieHeader(), orgId, {
    until: (frames2) => frames2.some((frame) => frame.includes("second wire")),
    lastEventId: first!.id!
  });
  const replayed = parseEvents(replayFrames).find((event) => event.data.payload?.message?.text === "second wire");
  assert.ok(replayed, "expected replayed event");
  assert.equal(replayed!.id, second!.id);
});

test("DM events are not delivered to non-members", async () => {
  const { client: owner, orgId, suffix } = await registerOwner();
  const alice = await createOrgUser(owner, orgId, suffix, "SSE Alice");
  const bob = await createOrgUser(owner, orgId, suffix, "SSE Bob");
  const dm = await alice.client.request("POST", `/v1/channels/organizations/${orgId}/channels`, {
    type: "dm",
    member_user_ids: [bob.userId]
  });

  const ownerStream = collectStream(owner.cookieHeader(), orgId, {
    until: (frames) => frames.some((frame) => frame.includes("dm secret payload")),
    timeoutMs: 2500
  });
  const bobStream = collectStream(bob.client.cookieHeader(), orgId, {
    until: (frames) => frames.some((frame) => frame.includes("dm secret payload")),
    timeoutMs: 8000
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await alice.client.request("POST", `/v1/channels/organizations/${orgId}/channels/${dm.channel.id}/messages`, { text: "dm secret payload" });

  const bobFrames = await bobStream;
  assert.ok(bobFrames.some((frame) => frame.includes("dm secret payload")), "DM member should receive the event");

  const ownerFrames = await ownerStream;
  assert.ok(!ownerFrames.some((frame) => frame.includes("dm secret payload")), "non-member must not receive DM events");
});

test("polling fallback returns the same events with a cursor", async () => {
  const { client: owner, orgId } = await registerOwner();
  const listed = await owner.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const general = listed.channels.find((channel: Json) => channel.name === "general");

  const initial = await owner.request("GET", `/v1/platform/organizations/${orgId}/events/poll`);
  const cursor = initial.next ?? 0;
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${general.id}/messages`, { text: "poll me" });
  const polled = await owner.request("GET", `/v1/platform/organizations/${orgId}/events/poll?after=${cursor}`);
  assert.ok(polled.events.some((event: Json) => event.topic === "channels.message.created" && event.payload?.message?.text === "poll me"));
  assert.ok(polled.next > cursor);
});

test("audience-restricted messages stream as stubs without the body", async () => {
  const { client: owner, orgId } = await registerOwner();
  const project = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects`, {
    data: { title: "SSE Audience Project" }
  });
  const ensured = await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/project/${String(project.document.id)}`);

  const initial = await owner.request("GET", `/v1/platform/organizations/${orgId}/events/poll`);
  await owner.request("POST", `/v1/channels/organizations/${orgId}/channels/${ensured.channel.id}/messages`, {
    text: "office-only budget realities",
    audience: ["office"]
  });
  const polled = await owner.request("GET", `/v1/platform/organizations/${orgId}/events/poll?after=${initial.next ?? 0}`);
  const event = polled.events.find((item: Json) => item.topic === "channels.message.created");
  assert.ok(event, "expected the stub event");
  assert.equal(event.payload.stub, true);
  assert.ok(!JSON.stringify(event.payload).includes("budget realities"), "restricted body must not ride the event bus");
});
