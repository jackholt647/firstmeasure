import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();

test("platform state and sessions are shared between stateless web nodes", { skip: !databaseUrl }, async (t) => {
  const reset = new pg.Client({ connectionString: databaseUrl });
  await reset.connect();
  await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
  await reset.query("CREATE SCHEMA public");
  await reset.end();

  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = databaseUrl;
  // Production defaults to one connection per Node worker, so registration
  // locks must never pin that only connection while nested writes run.
  process.env.POSTGRES_POOL_MAX = "1";
  process.env.POSTGRES_AUTO_MIGRATE = "false";
  process.env.PLATFORM_SESSION_SECRET = "cluster-test-shared-session-secret";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";

  const [{ registerPlatformApi }, storage, database] = await Promise.all([
    import("../platform/api.js"),
    import("../platform/storage.js"),
    import("../src/database/postgres.js")
  ]);

  const nodeA = Fastify({ logger: false });
  const nodeB = Fastify({ logger: false });
  await nodeA.register(registerPlatformApi, { prefix: "/v1/platform" });
  await nodeB.register(registerPlatformApi, { prefix: "/v1/platform" });
  await Promise.all([nodeA.ready(), nodeB.ready()]);
  t.after(async () => {
    await Promise.all([nodeA.close(), nodeB.close()]);
    await database.closePostgresPools();
  });

  const registered = await nodeA.inject({
    method: "POST",
    url: "/v1/platform/auth/register",
    payload: {
      email: "cluster.owner@example.test",
      password: "correct-horse-battery-staple",
      name: "Cluster Owner",
      phone: "+1 555 111 2222"
    }
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = String(registered.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] ?? "";
  assert.ok(cookie);

  const sessionThroughB = await nodeB.inject({ method: "GET", url: "/v1/platform/auth/session", headers: { cookie } });
  assert.equal(sessionThroughB.statusCode, 200, sessionThroughB.body);
  assert.equal(sessionThroughB.json().authenticated, true);
  assert.equal(sessionThroughB.json().identity.email, "cluster.owner@example.test");

  const phoneRace = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => storage.createIdentity({
    email: `phone-race-${index}@example.test`,
    phone: "+1 555 222 3333",
    name: `Phone Race ${index}`
  })));
  assert.equal(phoneRace.filter((result) => result.status === "fulfilled").length, 1, "phone uniqueness must be atomic across nodes");

  const orgId = String(registered.json().organization.id);
  const created = await storage.upsertDocument(orgId, "projects", { id: "cross-node-project", data: { value: 1 } });
  const updated = await storage.upsertDocument(orgId, "projects", { id: "cross-node-project", expected_revision: created.revision, data: { value: 2 } });
  assert.equal(updated.revision, 2);
  assert.equal((await storage.readDocument(orgId, "projects", "cross-node-project")).data.value, 2);

  const concurrent = await Promise.allSettled(Array.from({ length: 20 }, () => storage.upsertDocument(
    orgId,
    "projects",
    { id: "cross-node-project", expected_revision: 2, data: { touched: true } }
  )));
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1, "revision check must be atomic across nodes");


  const csrf = String(sessionThroughB.json().csrf_token);
  const flags = await nodeB.inject({ method: "GET", url: `/v1/platform/organizations/${orgId}/app-flags`, headers: { cookie } });
  assert.equal(flags.statusCode, 200, flags.body);
  assert.equal(flags.json().test_admin, false);
  assert.equal(flags.json().effective.platform.expanded_access, false);
  assert.equal(flags.json().effective.platform.more_apps, false);
  for (const [suffix, payload] of [
    ["app-flags", { flags: { platform: { expanded_access: true } } }],
    ["capabilities", { values: { "platform.expanded_access": true } }],
    ["capabilities/signup-preset", { preset_id: "full_platform" }]
  ] as const) {
    const denied = await nodeA.inject({ method: "PUT", url: `/v1/platform/organizations/${orgId}/${suffix}`, headers: { cookie, "x-platform-csrf": csrf }, payload });
    assert.equal(denied.statusCode, 403, `${suffix}: ${denied.body}`);
    assert.equal(denied.json().error, "app_flags_operator_only");
  }
  const { deviceId } = await storage.createAccountDevice({ accounts: [{ account_id: "one" }] });
  assert.equal(((await storage.readAccountDevice(deviceId)).accounts as unknown[]).length, 1);
  await storage.saveAccountDevice(deviceId, { accounts: [{ account_id: "one" }, { account_id: "two" }] });
  assert.equal(((await storage.readAccountDevice(deviceId)).accounts as unknown[]).length, 2);
  await storage.deleteAccountDevice(deviceId);
  await assert.rejects(storage.readAccountDevice(deviceId));
  await Promise.all(Array.from({ length: 20 }, () => storage.mutatePlatformConfiguration("integration_counter", current => ({ value: Number(current?.value || 0) + 1 }))));
  assert.equal((await storage.readPlatformConfiguration("integration_counter"))?.value, 20);
  for (const collection of ["documents", "payment_receipts", "calendar_events", "websites"] as const) {
    const item = await storage.upsertDocument(orgId, collection, { data: { integration: true } });
    assert.equal((await storage.readDocument(orgId, collection, String(item.id))).data.integration, true);
  }
  const extra = await storage.createAuthSession({ identity_id: registered.json().identity.id, organization_id: orgId, user_id: registered.json().user.id });
  const rotated = await storage.rotateAuthSessionCsrf(extra.sessionId);
  assert.notEqual(rotated.csrf_token, extra.session.csrf_token);
  assert.equal((await storage.readAuthSession(extra.sessionId)).csrf_token, rotated.csrf_token);
  await storage.deleteAuthSession(extra.sessionId);
  await assert.rejects(storage.rotateAuthSessionCsrf(extra.sessionId));

  const sessionRows = await database.queryPostgres<{ count: string }>("SELECT COUNT(*)::text AS count FROM platform_sessions");
  assert.equal(Number(sessionRows.rows[0]?.count ?? 0), 1);
});
