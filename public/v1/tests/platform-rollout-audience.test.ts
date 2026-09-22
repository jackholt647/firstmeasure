import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";

test("operator user targeting keeps FirstMeasure defaults and blocks direct platform APIs", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-audience-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root,
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "",
    POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false", PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_SESSION_SECRET: "isolated-rollout-fixture-secret", EMAIL_OUTBOUND_DISABLED: "1" });
  const storage = await import("../platform/storage.js");
  const { registerPlatformApi } = await import("../platform/api.js");
  const { registerDocumentsApi } = await import("../documents/api.js");
  const { requirePlatformAuth } = await import("../platform/auth.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { closePostgresPools } = await import("../src/database/postgres.js");
  const app = Fastify({ logger: false });
  await app.register(registerPlatformApi, { prefix: "/v1/platform" });
  await app.register(registerDocumentsApi, { prefix: "/v1/documents" });
  const namespaces = ["audio-notes", "agents", "appointments", "assistant", "calls", "channels", "chat", "comms", "connections", "domains", "equipment", "feedback", "financials", "messaging", "payroll", "scopes", "signup-sandbox", "stats", "training", "websites", "work", "workforce"];
  for (const namespace of namespaces) app.get(`/v1/${namespace}/organizations/:orgId/integration-probe`, async request => {
    await requirePlatformAuth(request, { orgId: (request.params as any).orgId });
    return { ok: true };
  });
  await app.ready();
  t.after(async () => { await app.close(); await closeSqlStoresForTests(); await closePostgresPools(); await rm(root, { recursive: true, force: true }); });
  const registered = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
    email: `rollout-${randomUUID()}@example.test`, phone: "2025550188", name: "FirstMeasure Owner", password: "local-fixture-password"
  }});
  assert.equal(registered.statusCode, 201, registered.body);
  const orgId = registered.json().organization.id;
  const ownerId = registered.json().user.id;
  const ownerCookie = String(registered.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)![0];
  const ownerCsrf = decodeURIComponent(String(registered.headers["set-cookie"]).match(/fm_platform_session_csrf=([^;,]+)/)![1]!);
  const makeUser = async (email: string, id: string) => {
    const identity = await storage.createIdentity({ email, name: id, memberships: [{ organization_id: orgId, user_id: id }] });
    await storage.upsertDocument(orgId, "users", { id, data: { identity_id: identity.id, email, name: id, status: "active", org_permissions: { level: "owner", items: {} } } });
    const auth = await storage.createAuthSession({ identity_id: identity.id, organization_id: orgId, user_id: id, role: "owner" });
    const signature = createHmac("sha256", "isolated-rollout-fixture-secret").update(auth.sessionId).digest("base64url");
    return { cookie: `fm_platform_session=${auth.sessionId}.${signature}`, csrf: String(auth.session.csrf_token) };
  };
  const operator = await makeUser("notifications@1m8.ai", "operator");
  const pilot = await makeUser(`pilot-${randomUUID()}@example.test`, "pilot");
  const api = `/v1/platform/organizations/${orgId}`;
  const request = (method: any, route: string, cookie: string, csrf = "", payload?: any) => app.inject({ method, url: route, headers: { cookie, "x-platform-csrf": csrf }, payload });
  // The independent FirstMeasure UI uses these same core user APIs with expansion off.
  const usersPath = `${api}/users`;
  const createdUser = await request("POST", usersPath, ownerCookie, ownerCsrf, { data: {
    email: `fm-user-${randomUUID()}@example.test`, name: "FM User", role: "viewer", status: "invited", account_type: "customer"
  } });
  assert.equal(createdUser.statusCode, 201, createdUser.body);
  const managedId = createdUser.json().document.id;
  const updatedUser = await request("PATCH", `${usersPath}/${managedId}`, ownerCookie, ownerCsrf, { data: {
    name: "Renamed FM User", role: "custom", org_permissions: { level: "custom", items: { view_reports:true, order_reports:true } }, permissions: { view_reports:true, order_reports:true }
  } });
  assert.equal(updatedUser.statusCode, 200, updatedUser.body);
  assert.equal(updatedUser.json().document.data.name, "Renamed FM User");
  assert.equal(updatedUser.json().document.data.org_permissions.level, "custom");
  for (const status of ["disabled", "active"]) {
    const changed = await request("PATCH", `${usersPath}/${managedId}`, ownerCookie, ownerCsrf, { data: { status } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().document.data.status, status);
  }
  assert.equal((await request("GET", usersPath, ownerCookie)).statusCode, 200);
  const removed = await request("DELETE", `${usersPath}/${managedId}`, ownerCookie, ownerCsrf);
  assert.equal(removed.statusCode, 200, removed.body);
  const rollout = { mode: "selected", user_ids: ["pilot"] };
  const previousTestOrgs = process.env.PLATFORM_TEST_ORG_IDS;
  t.after(() => { if (previousTestOrgs === undefined) delete process.env.PLATFORM_TEST_ORG_IDS; else process.env.PLATFORM_TEST_ORG_IDS = previousTestOrgs; });
  delete process.env.PLATFORM_TEST_ORG_IDS;
  assert.equal((await request("GET", `${api}/app-flags`, operator.cookie)).json().test_admin, false);
  assert.equal((await request("PUT", `${api}/platform-rollout`, operator.cookie, operator.csrf, rollout)).statusCode, 403);
  assert.equal((await request("PUT", `${api}/capabilities`, operator.cookie, operator.csrf, { values: { "platform.expanded_access": true } })).statusCode, 403);
  process.env.PLATFORM_TEST_ORG_IDS = orgId;
  assert.equal((await request("GET", `${api}/app-flags`, operator.cookie)).json().test_admin, true);
  assert.equal((await request("GET", `${api}/app-flags`, ownerCookie)).json().test_admin, false);

  assert.equal((await request("PUT", `${api}/platform-rollout`, ownerCookie, ownerCsrf, rollout)).statusCode, 403);
  assert.equal((await request("PUT", `${api}/platform-rollout`, operator.cookie, "", rollout)).statusCode, 403);
  assert.equal((await request("PUT", `${api}/platform-rollout`, operator.cookie, operator.csrf, rollout)).statusCode, 200);
  const flags = { values: { "platform.expanded_access": true, "platform.more_apps": true, "platform.new_button_mode": "project", "platform.people_access": true } };
  const enabled = await request("PUT", `${api}/capabilities`, operator.cookie, operator.csrf, flags);
  assert.equal(enabled.statusCode, 200, enabled.body);
  // Older partial writes and presets must leave the separate release decision intact.
  const partial = await request("PUT", `${api}/app-flags`, operator.cookie, operator.csrf, { app_flags: { platform: { project_photos: true } } });
  assert.equal(partial.statusCode, 200, partial.body);
  assert.equal(partial.json().raw.platform.expanded_access, true);
  assert.equal(partial.json().raw.platform.more_apps, true);
  const { saveCapabilityValues, rawCapabilityValues } = await import("../platform/capabilities.js");
  await Promise.all([saveCapabilityValues(orgId, { "platform.project_photos": false }), saveCapabilityValues(orgId, { "platform.scheduling": false })]);
  const persisted = await rawCapabilityValues(orgId);
  assert.equal(persisted["platform.project_photos"], false);
  assert.equal(persisted["platform.scheduling"], false);
  assert.equal(persisted["platform.expanded_access"], true);
  const ownerFlags = (await request("GET", `${api}/app-flags`, ownerCookie)).json().effective;
  assert.equal(ownerFlags.platform.expanded_access, false);
  assert.equal(ownerFlags.platform.more_apps, false);
  assert.equal(ownerFlags.platform.people_access, false);
  assert.equal(ownerFlags.platform.new_button_mode, "report");
  assert.equal(ownerFlags.firstmeasure.report_orders, true);
  assert.equal((await request("GET", "/v1/platform/auth/session", ownerCookie)).json().platform_expanded_access, false);
  assert.equal((await request("GET", "/v1/platform/auth/session", pilot.cookie)).json().platform_expanded_access, true);
  const pilotFlags = (await request("GET", `${api}/app-flags`, pilot.cookie)).json().effective;
  assert.equal(pilotFlags.platform.expanded_access, true);
  assert.equal(pilotFlags.platform.more_apps, true);
  assert.equal(pilotFlags.platform.people_access, true);
  assert.equal(pilotFlags.platform.new_button_mode, "project");
  assert.equal((await request("GET", `${api}/capabilities`, ownerCookie)).json().effective_by_key["apps.channels"], false);
  assert.equal((await request("GET", "/v1/platform/statsig/bootstrap", ownerCookie)).json().app_flags?.platform?.expanded_access ?? ownerFlags.platform.expanded_access, false);
  for (const namespace of namespaces) {
    assert.equal((await request("GET", `/v1/${namespace}/organizations/${orgId}/integration-probe`, ownerCookie)).statusCode, 403, namespace);
    assert.equal((await request("GET", `/v1/${namespace}/organizations/${orgId}/integration-probe`, pilot.cookie)).statusCode, 200, namespace);
  }
  assert.equal((await request("GET", `${api}/projects`, ownerCookie)).statusCode, 200);
  assert.equal((await request("GET", `${api}/global`, ownerCookie)).statusCode, 200);
  assert.equal((await request("GET", `/v1/documents/organizations/${orgId}/templates`, ownerCookie)).statusCode, 403);
  // Ordinary profile fields cannot grant rollout access.
  await storage.upsertDocument(orgId, "users", { id: ownerId, data: { platform_rollout: true, expanded_access: true, app_flags: { platform: { expanded_access: true } } } });
  assert.equal((await request("GET", `${api}/app-flags`, ownerCookie)).json().effective.platform.expanded_access, false);
  // Even historical global defaults and a full-platform signup preset cannot enroll new customers.
  const { setSignupCapabilityPreset, newOrganizationCapabilityValues } = await import("../platform/capabilities.js");
  const { newOrganizationAppFlagDefaults } = await import("../platform/app_flags.js");
  await setSignupCapabilityPreset("full_platform");
  assert.equal((await newOrganizationCapabilityValues())["platform.expanded_access"], false);
  await storage.mutatePlatformConfiguration("app_flag_defaults", () => ({ app_flags: { platform: { expanded_access: true, more_apps: true } } }));
  assert.equal((await newOrganizationAppFlagDefaults()).platform?.expanded_access, false);
  assert.equal((await newOrganizationAppFlagDefaults()).platform?.more_apps, false);
  await request("PUT", `${api}/capabilities`, operator.cookie, operator.csrf, { values: { "platform.expanded_access": false } });
  assert.equal((await request("GET", `${api}/app-flags`, pilot.cookie)).json().effective.platform.expanded_access, false);
  assert.equal((await request("GET", `/v1/channels/organizations/${orgId}/integration-probe`, pilot.cookie)).statusCode, 403);
});
