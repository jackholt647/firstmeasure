import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { closePlatformFixtureStores, nextTestPhone } from "./helpers/platform-fixture.js";

// Session replay routes (docs/architecture/session-replay.md): off by default, switched
// on per organization by a platform administrator, chunks stored once per sequence
// number, blobs checked against their content address, and replays readable only by
// platform administrators.

let app: any = null;
let storageRoot = "";
type Caller = { email: string; cookie: string; csrf: string; orgId: string };

async function caller(label: string, internal?: Record<string, unknown>): Promise<Caller> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `${label}-${suffix}@example.test`;
  const register = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
    phone: nextTestPhone(), email, password: "correct horse battery staple", name: label, company: `${label} Co`, organization_id: `org_${label.replace(/\W+/g, "_")}_${suffix}`
  } });
  assert.equal(register.statusCode, 201, register.body);
  const cookie = String(register.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "";
  const session = await app.inject({ method: "GET", url: "/v1/platform/auth/session", headers: { cookie } });
  if (internal) {
    const { saveInternalUser } = await import("../internal/storage.js");
    await saveInternalUser({ email, name: label, status: "active", ...internal });
  }
  return { email, cookie, csrf: String(session.json().csrf_token || ""), orgId: register.json().organization.id };
}

async function call(who: Caller | null, method: string, url: string, payload?: unknown) {
  const headers: Record<string, string> = {};
  if (who) { headers.cookie = who.cookie; if (method !== "GET") headers["x-platform-csrf"] = who.csrf; }
  return app.inject({ method, url: `/v1/platform${url}`, payload, headers });
}

function chunk(sessionId: string, seq: number, body: object, extra: Record<string, unknown> = {}) {
  const json = JSON.stringify(body);
  return {
    session_id: sessionId, page_id: "page0001", seq, page_started_at: 1_790_000_000_000, t_start: 1_790_000_000_000 + seq * 5000,
    t_end: 1_790_000_004_000 + seq * 5000, events: 3, raw_bytes: json.length, encoding: "gzip", data: gzipSync(Buffer.from(json)).toString("base64"),
    meta: seq === 0 ? { url: "https://dev.1m8.ai/portal/", title: "Portal", user_agent: "Test Browser", recorder: "test" } : null,
    ...extra
  };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-session-replay-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"), PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await (await import("../session-replay/storage.js")).closeSessionReplayDatabase();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error: any) { if (!["EBUSY", "EPERM"].includes(error?.code)) throw error; }
});

test("the content address matches the browser codec", async () => {
  const codec = createRequire(import.meta.url)("../../libraries/session-replay/session-replay-codec.js");
  const { replayBlobKey } = await import("../session-replay/hash.js");
  for (const sample of ["", "a", "body { color: red }".repeat(300), "üñíçødé ✓ — 漢字 🚀".repeat(200)]) {
    assert.equal(replayBlobKey(sample), codec.blobKey(sample));
  }
});

test("session replay is off by default, switched on by a platform administrator, and readable only by one", async () => {
  const owner = await caller("replay-owner");
  const admin = await caller("replay-admin", { role: "admin" });

  const signedOut = await call(null, "GET", "/session-replay/config");
  assert.deepEqual({ enabled: signedOut.json().enabled, reason: signedOut.json().reason }, { enabled: false, reason: "signed_out" });
  assert.deepEqual((await call(owner, "GET", "/session-replay/config")).json(), { ok: true, enabled: false, reason: "off" });
  assert.equal((await call(owner, "POST", "/session-replay/chunks", chunk("sessionowner0001", 0, { s: [], e: [] }))).statusCode, 403);

  // Owners and admins of a customer organization cannot read or switch replays.
  assert.equal((await call(owner, "GET", "/session-replay/admin/me")).statusCode, 403);
  assert.equal((await call(owner, "PUT", `/session-replay/admin/organizations/${owner.orgId}`, { enabled: true })).statusCode, 403);
  assert.equal((await call(owner, "GET", "/session-replay/admin/sessions")).statusCode, 403);

  const me = await call(admin, "GET", "/session-replay/admin/me");
  assert.equal(me.statusCode, 200, me.body);
  assert.equal((await call(admin, "PUT", `/session-replay/admin/organizations/${owner.orgId}`, { enabled: true })).json().enabled, true);
  const listed = (await call(admin, "GET", "/session-replay/admin/organizations")).json().organizations;
  assert.equal(listed.find((org: any) => org.organization_id === owner.orgId)?.enabled, true);

  const config = (await call(owner, "GET", "/session-replay/config")).json();
  assert.equal(config.enabled, true);
  assert.equal(config.org_id, owner.orgId);
  assert.match(config.csrf_cookie, /_csrf$/);

  // Chunks: stored once per (session, page, seq); a retry changes nothing.
  const first = { v: 1, t: 1_790_000_000_000, s: ["html"], e: [[0, 0, 0]], m: [] };
  const firstResult = await call(owner, "POST", "/session-replay/chunks", chunk("sessionowner0001", 0, first));
  assert.equal(firstResult.statusCode, 200, firstResult.body);
  assert.equal(firstResult.json().stored, true);
  assert.equal((await call(owner, "POST", "/session-replay/chunks", chunk("sessionowner0001", 0, first))).json().stored, false);
  const beacon = { session_id: "sessionowner0001", page_id: "page0001", seq: 1, page_started_at: 1_790_000_000_000, t_start: 1_790_000_005_000,
    t_end: 1_790_000_009_000, events: 1, raw_bytes: 10, encoding: "json", json: JSON.stringify({ v: 1, t: 1_790_000_005_000, s: [], e: [[0, 17]], m: [] }) };
  assert.equal((await call(owner, "POST", "/session-replay/chunks", beacon)).json().stored, true);
  assert.equal((await call(owner, "POST", "/session-replay/chunks", { ...chunk("sessionowner0001", 2, first), data: Buffer.from("not gzip at all").toString("base64") })).statusCode, 400);
  assert.equal((await call(owner, "POST", "/session-replay/chunks", { ...chunk("sessionowner0001", 3, first), csrf: "x" })).statusCode, 400);
  const noCsrf = await app.inject({ method: "POST", url: "/v1/platform/session-replay/chunks", payload: chunk("sessionowner0001", 4, first), headers: { cookie: owner.cookie } });
  assert.equal(noCsrf.statusCode, 403);

  // Another person cannot write into this session.
  await call(admin, "PUT", `/session-replay/admin/organizations/${admin.orgId}`, { enabled: true });
  assert.equal((await call(admin, "POST", "/session-replay/chunks", chunk("sessionowner0001", 9, first))).statusCode, 409);

  // Blobs are stored under their own content address only.
  const codec = createRequire(import.meta.url)("../../libraries/session-replay/session-replay-codec.js");
  const css = ".a { color: red }\n".repeat(400);
  const key = codec.blobKey(css);
  assert.deepEqual((await call(owner, "POST", "/session-replay/blobs/missing", { keys: [key] })).json().missing, [key]);
  const wrong = await call(owner, "POST", "/session-replay/blobs", { key, raw_bytes: 5, encoding: "gzip", data: gzipSync(Buffer.from("other")).toString("base64") });
  assert.equal(wrong.statusCode, 400);
  assert.equal((await call(owner, "POST", "/session-replay/blobs", { key, raw_bytes: css.length, encoding: "gzip", data: gzipSync(Buffer.from(css)).toString("base64") })).json().stored, true);
  assert.deepEqual((await call(owner, "POST", "/session-replay/blobs/missing", { keys: [key] })).json().missing, []);

  // Reading back.
  const sessions = (await call(admin, "GET", `/session-replay/admin/sessions?org_id=${owner.orgId}`)).json().sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].chunks, 2);
  assert.equal(sessions[0].pages, 1);
  assert.equal(sessions[0].user_email, owner.email);
  assert.equal(sessions[0].first_url, "https://dev.1m8.ai/portal/");
  const detail = (await call(admin, "GET", "/session-replay/admin/sessions/sessionowner0001")).json();
  assert.equal(detail.pages[0].max_seq, 1);
  assert.equal(detail.chunk_sizes.length, 2);
  const chunks = (await call(admin, "GET", "/session-replay/admin/sessions/sessionowner0001/chunks?page_id=page0001&after_seq=-1")).json().chunks;
  assert.deepEqual(chunks.map((c: any) => c.seq), [0, 1]);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(chunks[0].data, "base64")).toString()), first);
  assert.equal(JSON.parse(gunzipSync(Buffer.from(chunks[1].data, "base64")).toString()).e[0][1], 17);
  const blobs = (await call(admin, "GET", `/session-replay/admin/blobs?org_id=${owner.orgId}&keys=${key}`)).json().blobs;
  assert.equal(gunzipSync(Buffer.from(blobs[key], "base64")).toString(), css);
  const stats = (await call(admin, "GET", "/session-replay/admin/stats")).json().organizations.find((o: any) => o.organization_id === owner.orgId);
  assert.equal(stats.sessions, 1);
  assert.equal(stats.blobs, 1);

  // Switching off stops recording; deleting removes the recording.
  await call(admin, "PUT", `/session-replay/admin/organizations/${owner.orgId}`, { enabled: false });
  assert.equal((await call(owner, "GET", "/session-replay/config")).json().enabled, false);
  assert.equal((await call(owner, "POST", "/session-replay/chunks", chunk("sessionowner0001", 5, first))).statusCode, 403);
  assert.equal((await call(admin, "DELETE", "/session-replay/admin/sessions/sessionowner0001")).json().deleted, true);
  assert.equal((await call(admin, "GET", "/session-replay/admin/sessions/sessionowner0001")).statusCode, 404);
});

function frame(header: object, payload: Buffer) {
  const head = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  return Buffer.concat([length, head, payload]);
}

async function upload(who: Caller, url: string, body: Buffer) {
  return app.inject({ method: "POST", url: `/v1/platform${url}`, payload: body,
    headers: { cookie: who.cookie, "x-platform-csrf": who.csrf, "content-type": "application/vnd.firstmate.replay-frame" } });
}

test("recorders upload binary frames, and upload often only while someone follows live", async () => {
  const owner = await caller("replay-frames");
  const admin = await caller("replay-frames-admin", { role: "admin" });
  await call(admin, "PUT", `/session-replay/admin/organizations/${owner.orgId}`, { enabled: true });
  const userId = (await call(owner, "GET", "/session-replay/config")).json().user_id;
  const now = Date.now();
  const json = Buffer.from(JSON.stringify({ v: 1, t: now, s: [], e: [[0, 17]], m: [] }));
  const header = (seq: number, pageId: string, extra: Record<string, unknown> = {}) => ({
    session_id: "sessionframes001", page_id: pageId, seq, page_started_at: now, t_start: now + seq * 1000, t_end: now + seq * 1000 + 500,
    events: 2, raw_bytes: json.length, encoding: "gzip", meta: seq === 0 ? { url: "https://dev.1m8.ai/portal/", title: "Portal" } : null, ...extra
  });

  const first = await upload(owner, "/session-replay/chunks", frame(header(0, "page0001"), gzipSync(json)));
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { ok: true, stored: true, next_ms: 20_000 });
  assert.equal((await upload(owner, "/session-replay/chunks", frame(header(0, "page0001"), gzipSync(json)))).json().stored, false);
  // A page leaving before it compressed sends its JSON text.
  assert.equal((await upload(owner, "/session-replay/chunks", frame(header(1, "page0001", { encoding: "identity" }), json))).json().stored, true);
  assert.equal((await upload(owner, "/session-replay/chunks", frame(header(0, "page0002"), gzipSync(json)))).json().stored, true);
  assert.equal((await upload(owner, "/session-replay/chunks", Buffer.from([0, 0, 0, 200, 1, 2]))).statusCode, 400);
  assert.equal((await upload(owner, "/session-replay/chunks", frame(header(3, "page0001", { data: "x" }), gzipSync(json)))).statusCode, 400);
  assert.equal((await upload(owner, "/session-replay/chunks", frame(header(3, "page0001"), Buffer.from("not gzip at all")))).statusCode, 400);
  await call(admin, "PUT", `/session-replay/admin/organizations/${admin.orgId}`, { enabled: true });
  assert.equal((await upload(admin, "/session-replay/chunks", frame(header(4, "page0001"), gzipSync(json)))).statusCode, 409);

  // The page and session totals are kept by upserts.
  const detail = (await call(admin, "GET", "/session-replay/admin/sessions/sessionframes001")).json();
  assert.deepEqual({ pages: detail.session.pages, chunks: detail.session.chunks, events: detail.session.events, started_at: detail.session.started_at,
    last_at: detail.session.last_at, first_url: detail.session.first_url, last_url: detail.session.last_url },
    { pages: 2, chunks: 3, events: 6, started_at: now, last_at: now + 1500, first_url: "https://dev.1m8.ai/portal/", last_url: "https://dev.1m8.ai/portal/" });
  const page = detail.pages.find((p: any) => p.page_id === "page0001");
  assert.deepEqual({ chunks: page.chunks, max_seq: page.max_seq, events: page.events, url: page.url, title: page.title },
    { chunks: 2, max_seq: 1, events: 4, url: "https://dev.1m8.ai/portal/", title: "Portal" });
  assert.equal(detail.session.bytes_stored, gzipSync(json).length * 3);
  const chunks = (await call(admin, "GET", "/session-replay/admin/sessions/sessionframes001/chunks?page_id=page0001&after_seq=-1")).json().chunks;
  assert.deepEqual(chunks.map((c: any) => gunzipSync(Buffer.from(c.data, "base64")).toString()), [json.toString(), json.toString()]);

  // Opening it live in the viewer: the page is told once, and its next reply asks for a chunk every 2 seconds.
  const { pollRealtimeEvents } = await import("../platform/realtime.js");
  const watchEvents = async () => (await pollRealtimeEvents(owner.orgId, userId, 0)).events.filter((event) => event.topic === "session_replay.watch");
  assert.equal((await watchEvents()).length, 0);
  assert.equal((await call(admin, "GET", "/session-replay/admin/sessions/sessionframes001?watch=1")).statusCode, 200);
  assert.equal((await call(admin, "GET", "/session-replay/admin/sessions/sessionframes001?watch=1")).statusCode, 200);
  const events = await watchEvents();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { session_id: "sessionframes001", interval_ms: 2000 });
  assert.equal((await upload(owner, "/session-replay/chunks", frame(header(2, "page0001"), gzipSync(json)))).json().next_ms, 2000);

  // Blobs as frames, checked against their content address.
  const codec = createRequire(import.meta.url)("../../libraries/session-replay/session-replay-codec.js");
  const css = ".frames { color: blue }\n".repeat(400);
  const key = codec.blobKey(css);
  assert.equal((await upload(owner, "/session-replay/blobs", frame({ key, raw_bytes: 5, encoding: "gzip" }, gzipSync(Buffer.from("other"))))).statusCode, 400);
  assert.equal((await upload(owner, "/session-replay/blobs", frame({ key, raw_bytes: css.length, encoding: "gzip" }, gzipSync(Buffer.from(css))))).json().stored, true);
  assert.deepEqual((await call(owner, "POST", "/session-replay/blobs/missing", { keys: [key] })).json().missing, []);
});

test("no capability preset ever turns session replay on", async () => {
  const { builtinCapabilityPresets, firstMeasureSignupValues, capabilityDefinition } = await import("../platform/capabilities.js");
  assert.equal(capabilityDefinition("platform.session_replay")?.default, false);
  for (const preset of builtinCapabilityPresets()) assert.notEqual(preset.values["platform.session_replay"], true, preset.id);
  assert.equal(firstMeasureSignupValues({ "platform.session_replay": true })["platform.session_replay"], false);
});
