import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";

// Platform routes that once let any signed-in member reach past their own
// organization: the platform-wide organization list, identity creation and the
// raw global document.
test("an ordinary member cannot list other organizations, create identities or read the raw global document", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-org-boundary-"));
  const url = process.env.TEST_POSTGRES_URL;
  const secret = "isolated-org-boundary-fixture-secret";
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root,
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "",
    POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false", PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_SESSION_SECRET: secret, EMAIL_OUTBOUND_DISABLED: "1" });
  const storage = await import("../platform/storage.js");
  const { registerPlatformApi } = await import("../platform/api.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { closePostgresPools } = await import("../src/database/postgres.js");
  const app = Fastify({ logger: false });
  await app.register(registerPlatformApi, { prefix: "/v1/platform" });
  await app.ready();
  t.after(async () => { await app.close(); await closeSqlStoresForTests(); await closePostgresPools(); await rm(root, { recursive: true, force: true }); });

  const register = async (label: string, phone: string) => {
    const registered = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
      email: `${label}-${randomUUID()}@example.test`, phone, name: `${label} owner`, password: "local-fixture-password"
    } });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookies = String(registered.headers["set-cookie"]);
    return {
      orgId: String(registered.json().organization.id),
      cookie: cookies.match(/fm_platform_session=[^;,]+/)![0],
      csrf: decodeURIComponent(cookies.match(/fm_platform_session_csrf=([^;,]+)/)![1]!)
    };
  };
  const own = await register("own", "2025550191");
  const other = await register("other", "2025550192");
  assert.notEqual(own.orgId, other.orgId);

  const memberId = "ordinary-member";
  const memberEmail = `member-${randomUUID()}@example.test`;
  const identity = await storage.createIdentity({ email: memberEmail, name: "Member", memberships: [{ organization_id: own.orgId, user_id: memberId }] });
  await storage.upsertDocument(own.orgId, "users", { id: memberId, data: { identity_id: identity.id, email: memberEmail, name: "Member", status: "active", org_permissions: { level: "manager", items: {} } } });
  const session = await storage.createAuthSession({ identity_id: identity.id, organization_id: own.orgId, user_id: memberId, role: "member" });
  const member = {
    cookie: `fm_platform_session=${session.sessionId}.${createHmac("sha256", secret).update(session.sessionId).digest("base64url")}`,
    csrf: String(session.session.csrf_token)
  };
  const request = (method: any, route: string, caller: { cookie: string; csrf: string }, payload?: any) =>
    app.inject({ method, url: route, headers: { cookie: caller.cookie, "x-platform-csrf": caller.csrf }, payload });

  // The organization list holds only the caller's own memberships.
  const listed = await request("GET", "/v1/platform/organizations", member);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().organizations.map((org: any) => org.id), [own.orgId]);
  const ownerListed = await request("GET", "/v1/platform/organizations", own);
  assert.deepEqual(ownerListed.json().organizations.map((org: any) => org.id), [own.orgId]);

  // Identities are created only by the routes that add a person to an
  // organization; a bare identity with chosen memberships cannot be made.
  for (const caller of [member, own]) {
    const created = await request("POST", "/v1/platform/identities", caller, {
      email: `planted-${randomUUID()}@example.test`, password_hash: "x", memberships: [{ organization_id: other.orgId, user_id: "planted" }]
    });
    assert.equal(created.statusCode, 404, created.body);
  }

  // The raw global document (billing, payment method, credits ledger) needs
  // billing management; members keep the safe views.
  const ownGlobal = `/v1/platform/organizations/${own.orgId}/global`;
  assert.equal((await request("GET", ownGlobal, member)).statusCode, 403);
  assert.equal((await request("PATCH", ownGlobal, member, { data: { billing: { auto_topup: { enabled: true } } } })).statusCode, 403);
  assert.equal((await request("GET", `/v1/platform/organizations/${own.orgId}/portal-state`, member)).statusCode, 200);
  assert.equal((await request("GET", ownGlobal, own)).statusCode, 200);
  assert.equal((await request("PATCH", ownGlobal, own, { data: { billing: { auto_topup: { enabled: false } } } })).statusCode, 200);
  assert.equal((await request("GET", `/v1/platform/organizations/${other.orgId}/global`, own)).statusCode, 403);
});
