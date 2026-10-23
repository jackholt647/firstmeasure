import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { closePlatformFixtureStores, nextTestPhone } from "./helpers/platform-fixture.js";

// Agent access to session replay search (docs/architecture/session-replay-search.md, "Access for coding agents"):
// a platform administrator creates a key, a coding agent uses it over plain HTTP or MCP, and a revoked or expired
// key stops working. Keys reach the search tools only.

let app: any = null;
let storageRoot = "";
type Caller = { email: string; cookie: string; csrf: string };

async function caller(label: string, internal?: Record<string, unknown>): Promise<Caller> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `${label}-${suffix}@example.test`;
  const register = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
    phone: nextTestPhone(), email, password: "correct horse battery staple", name: label, company: `${label} Co`, organization_id: `org_${label.replace(/\W+/g, "_")}_${suffix}`
  } });
  assert.equal(register.statusCode, 201, register.body);
  const cookie = String(register.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "";
  const session = await app.inject({ method: "GET", url: "/v1/platform/auth/session", headers: { cookie } });
  if (internal) await (await import("../internal/storage.js")).saveInternalUser({ email, name: label, status: "active", ...internal });
  return { email, cookie, csrf: String(session.json().csrf_token || "") };
}

const asAdmin = (who: Caller, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/platform${url}`, payload, headers: { cookie: who.cookie, ...(method === "GET" ? {} : { "x-platform-csrf": who.csrf }) } });
const withKey = (key: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/platform${url}`, payload, headers: { authorization: `Bearer ${key}` } });
const mcp = (key: string, message: unknown) => withKey(key, "POST", "/session-replay/mcp", message);

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-replay-agent-access-"));
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
  await (await import("../session-replay/insights/store.js")).closeReplayInsightsDatabase();
  await (await import("../session-replay/storage.js")).closeSessionReplayDatabase();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error: any) { if (!["EBUSY", "EPERM"].includes(error?.code)) throw error; }
});

test("a platform administrator's key opens the search tools over HTTP and MCP, and nothing else", async () => {
  const admin = await caller("replay-admin", { role: "admin" });
  const customer = await caller("customer-owner");

  // Only a signed-in platform administrator manages keys.
  assert.equal((await asAdmin(customer, "POST", "/session-replay/insights/keys", { name: "mine" })).statusCode, 403);
  assert.equal((await asAdmin(admin, "POST", "/session-replay/insights/keys", { name: "" })).statusCode, 400);
  const created = await asAdmin(admin, "POST", "/session-replay/insights/keys", { name: "Jack's Claude Code", days: 30 });
  assert.equal(created.statusCode, 200, created.body);
  const key: string = created.json().key;
  assert.match(key, /^fmrk_[A-Za-z0-9_-]{40,}$/);
  const listed = (await asAdmin(admin, "GET", "/session-replay/insights/keys")).json().keys;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Jack's Claude Code");
  assert.equal(listed[0].active, true);
  assert.ok(!JSON.stringify(listed).includes(key), "the key itself is never listed");
  assert.ok(key.startsWith(listed[0].prefix));

  // The key reaches the tools without a session or CSRF token...
  const manifest = await withKey(key, "GET", "/session-replay/insights/tools");
  assert.equal(manifest.statusCode, 200, manifest.body);
  assert.ok(manifest.json().tools.some((tool: any) => tool.name === "replay_friction"));
  const overview = await withKey(key, "POST", "/session-replay/insights/call", { tool: "replay_overview", input: {} });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(overview.json().result.sessions, 0);

  // ...and nothing else: not key management, not the replay admin routes, not recordings.
  assert.equal((await withKey(key, "GET", "/session-replay/insights/keys")).statusCode, 401);
  assert.equal((await withKey(key, "POST", "/session-replay/insights/keys", { name: "more" })).statusCode, 401);
  assert.equal((await withKey(key, "GET", "/session-replay/admin/sessions")).statusCode, 401);
  assert.equal((await withKey("fmrk_" + "x".repeat(43), "GET", "/session-replay/insights/tools")).statusCode, 401);

  // MCP over Streamable HTTP, JSON only.
  const init = await mcp(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.statusCode, 200, init.body);
  assert.match(String(init.headers["content-type"]), /application\/json/);
  assert.equal(init.json().result.protocolVersion, "2025-06-18");
  assert.ok(init.json().result.capabilities.tools);
  assert.match(init.json().result.instructions, /work top-down/);
  assert.equal((await mcp(key, { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode, 202);
  assert.deepEqual((await mcp(key, { jsonrpc: "2.0", id: 2, method: "ping" })).json(), { jsonrpc: "2.0", id: 2, result: {} });
  const tools = (await mcp(key, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json().result.tools;
  assert.ok(tools.length >= 12 && tools.every((tool: any) => tool.name && tool.description && tool.inputSchema?.type === "object"));
  const called = (await mcp(key, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "replay_screens", arguments: {} } })).json();
  assert.equal(called.result.isError, false);
  assert.deepEqual(JSON.parse(called.result.content[0].text), { screens: [] });
  const invalid = (await mcp(key, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "replay_flows", arguments: {} } })).json();
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /screen_id/);
  assert.equal((await mcp(key, { jsonrpc: "2.0", id: 6, method: "resources/list" })).json().error.code, -32601);
  const batch = (await mcp(key, [{ jsonrpc: "2.0", id: 7, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }])).json();
  assert.deepEqual(batch, [{ jsonrpc: "2.0", id: 7, result: {} }]);
  assert.equal((await withKey(key, "GET", "/session-replay/mcp")).statusCode, 405);
  const anonymous = await app.inject({ method: "POST", url: "/v1/platform/session-replay/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
  assert.equal(anonymous.statusCode, 401);
  assert.match(String(anonymous.headers["www-authenticate"]), /Bearer/);
  assert.equal((await app.inject({ method: "POST", url: "/v1/platform/session-replay/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { cookie: admin.cookie, "x-platform-csrf": admin.csrf } })).statusCode, 401,
    "MCP takes keys only, not browser sessions");

  // A signed-in administrator still calls tools directly (with CSRF).
  assert.equal((await asAdmin(admin, "POST", "/session-replay/insights/call", { tool: "replay_overview", input: {} })).statusCode, 200);

  // Revoked and expired keys stop at once.
  const revoked = await asAdmin(admin, "DELETE", `/session-replay/insights/keys/${listed[0].id}`);
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await mcp(key, { jsonrpc: "2.0", id: 8, method: "ping" })).statusCode, 401);
  assert.equal((await withKey(key, "GET", "/session-replay/insights/tools")).statusCode, 401);
  assert.equal((await asAdmin(admin, "DELETE", `/session-replay/insights/keys/${listed[0].id}`)).statusCode, 404);
  const second = (await asAdmin(admin, "POST", "/session-replay/insights/keys", { name: "Codex", days: 1 })).json();
  const { insightsDb } = await import("../session-replay/insights/store.js");
  await insightsDb().prepare("UPDATE replay_ix_access_keys SET expires_at=? WHERE id=?").run(Date.now() - 1000, second.access_key.id);
  assert.equal((await withKey(second.key, "GET", "/session-replay/insights/tools")).statusCode, 401);
  const after = (await asAdmin(admin, "GET", "/session-replay/insights/keys")).json().keys;
  assert.deepEqual(after.map((k: any) => k.active), [false, false]);
});
