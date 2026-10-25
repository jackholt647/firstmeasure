import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";

// The customer action endpoint (POST /v1/platform/portal-action) once let any
// member of an organization run every action, trusted amounts in the body and
// fetched any URL. docs/architecture/request-security.md
test("portal actions check the member's permissions, the organization and the server's own records", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portal-action-security-"));
  const url = process.env.TEST_POSTGRES_URL;
  const secret = "isolated-portal-action-fixture-secret";
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root,
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "",
    POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false", PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_SESSION_SECRET: secret, EMAIL_OUTBOUND_DISABLED: "1",
    STRIPE_SECRET_KEY: "sk_test_portal_fixture", STRIPE_TEST_MODE: "1" });
  const storage = await import("../platform/storage.js");
  const { registerPlatformApi } = await import("../platform/api.js");
  const { requestPrincipal } = await import("../platform/security/principal.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { closePostgresPools } = await import("../src/database/postgres.js");

  // A stand-in for FirstMeasure that records who each in-process call came as.
  // It answers every list with every organization's rows, so the platform's
  // own filtering is what is tested.
  const manifests = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; url: string; kind: string; orgId?: string; body?: unknown }> = [];
  const app = Fastify({ logger: false });
  await app.register(async (fm) => {
    fm.addHook("preHandler", async (request) => {
      const principal = await requestPrincipal(request);
      calls.push({ method: request.method, url: request.url, kind: principal.kind, orgId: principal.kind === "customer" ? principal.auth.orgId : undefined, body: request.body });
      if (principal.kind === "anonymous") throw Object.assign(new Error("Authentication required."), { statusCode: 401 });
    });
    const visible = async (request: any) => {
      const principal = await requestPrincipal(request);
      const manifest = manifests.get(String(request.params.id));
      if (!manifest) return null;
      if (principal.kind === "customer" && (manifest.organization_ref as any)?.id !== principal.auth.orgId) return null;
      return manifest;
    };
    fm.get("/projects/:id", async (request, reply) => {
      const manifest = await visible(request);
      if (!manifest) return reply.code(404).send({ ok: false, error: "project_not_found" });
      return { ok: true, project: { manifest } };
    });
    fm.post("/projects/list", async () => ({ ok: true, projects: [...manifests.values()].map((manifest) => ({ id: manifest.id, project: { manifest } })) }));
    fm.post("/projects/:id/instant/refund", async (request) => {
      const manifest = manifests.get(String((request.params as any).id))!;
      Object.assign(manifest, request.body as object);
      return { ok: true, manifest };
    });
  }, { prefix: "/v1/firstmeasure" });
  await app.register(registerPlatformApi, { prefix: "/v1/platform" });
  await app.ready();

  const realFetch = globalThis.fetch;
  const stripeSessions = new Map<string, Record<string, unknown>>();
  globalThis.fetch = (async (input: any, init?: any) => {
    const target = String(input?.url ?? input);
    const match = target.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/([^?]+)/);
    if (match) {
      const session = stripeSessions.get(decodeURIComponent(match[1]!));
      return new Response(JSON.stringify(session ?? { error: { message: "No such session" } }), { status: session ? 200 : 404, headers: { "content-type": "application/json" } });
    }
    if (target.startsWith("https://api.stripe.com/")) return new Response(JSON.stringify({ error: { message: "not in fixture" } }), { status: 400 });
    return realFetch(input, init);
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = realFetch;
    await app.close(); await closeSqlStoresForTests(); await closePostgresPools(); await rm(root, { recursive: true, force: true });
  });

  const register = async (label: string, phone: string) => {
    const registered = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
      email: `${label}-${randomUUID()}@example.test`, phone, name: `${label} owner`, password: "local-fixture-password"
    } });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookies = String(registered.headers["set-cookie"]);
    return {
      orgId: String(registered.json().organization.id),
      userId: String(registered.json().user?.id ?? ""),
      cookie: cookies.match(/fm_platform_session=[^;,]+/)![0],
      csrf: decodeURIComponent(cookies.match(/fm_platform_session_csrf=([^;,]+)/)![1]!)
    };
  };
  const own = await register("own", "2025550181");
  const other = await register("other", "2025550182");

  const makeMember = async (id: string, level: string, items: Record<string, boolean> = {}) => {
    const email = `${id}-${randomUUID()}@example.test`;
    const identity = await storage.createIdentity({ email, name: id, memberships: [{ organization_id: own.orgId, user_id: id }] });
    await storage.upsertDocument(own.orgId, "users", { id, data: { identity_id: identity.id, email, name: id, status: "active", role: level, org_permissions: { level, items } } });
    const session = await storage.createAuthSession({ identity_id: identity.id, organization_id: own.orgId, user_id: id, role: "member" });
    return {
      email,
      cookie: `fm_platform_session=${session.sessionId}.${createHmac("sha256", secret).update(session.sessionId).digest("base64url")}`,
      csrf: String(session.session.csrf_token)
    };
  };
  const manager = await makeMember("ordering-manager", "manager");
  const userManager = await makeMember("user-manager", "custom", { manage_company_users: true, view_reports: true });
  const admin = await makeMember("org-admin", "admin");

  const action = (caller: { cookie: string; csrf: string }, name: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/v1/platform/portal-action", headers: { cookie: caller.cookie, "x-platform-csrf": caller.csrf }, payload: { action: name, ...payload } });
  const users = async () => (await storage.listDocuments(own.orgId, "users")).map((doc: any) => doc.data);

  await t.test("adding people needs user management, and only an owner makes an owner", async () => {
    const asManager = await action(manager, "org_users_add_my", { email: `planted-${randomUUID()}@example.test`, perm_level: "owner" });
    assert.equal(asManager.statusCode, 403, asManager.body);
    const ownerByUserManager = await action(userManager, "org_users_add_my", { email: `planted-${randomUUID()}@example.test`, perm_level: "owner" });
    assert.equal(ownerByUserManager.statusCode, 403, ownerByUserManager.body);
    const flagsByUserManager = await action(userManager, "org_users_add_my", { email: `planted-${randomUUID()}@example.test`, perm_level: "viewer", perm_items_json: JSON.stringify({ manage_billing: true }) });
    assert.equal(flagsByUserManager.statusCode, 403, flagsByUserManager.body);
    const ownerByAdmin = await action(admin, "org_users_add_my", { email: `planted-${randomUUID()}@example.test`, perm_level: "owner" });
    assert.equal(ownerByAdmin.statusCode, 403, ownerByAdmin.body);
    assert.equal((await users()).filter((user: any) => String(user.email).startsWith("planted-")).length, 0);

    const viewerEmail = `viewer-${randomUUID()}@example.test`;
    const added = await action(userManager, "org_users_add_my", { email: viewerEmail, perm_level: "viewer" });
    assert.equal(added.statusCode, 200, added.body);
    // Adding an existing member never overwrites them (here, demoting the owner).
    const ownerEmail = String((await users()).find((user: any) => user.role === "owner")?.email);
    const demote = await action(admin, "org_users_add_my", { email: ownerEmail, perm_level: "viewer" });
    assert.equal(demote.statusCode, 409, demote.body);
    const madeOwner = await action(own, "org_users_add_my", { email: `co-owner-${randomUUID()}@example.test`, perm_level: "owner" });
    assert.equal(madeOwner.statusCode, 200, madeOwner.body);
    // A user manager cannot change another person's sign-in email.
    const viewerId = String(added.json().user.id);
    const takeover = await action(userManager, "org_users_update_my", { user_id: viewerId, email: userManager.email });
    assert.equal(takeover.statusCode, 403, takeover.body);
    const byOrdinary = await action(manager, "org_users_update_my", { user_id: viewerId, name: "Renamed" });
    assert.equal(byOrdinary.statusCode, 403, byOrdinary.body);
  });

  await t.test("billing settings accept only the auto top-up fields, from billing managers", async () => {
    const denied = await action(manager, "org_update_my_billing", { billing_json: JSON.stringify({ auto_topup: { enabled: true } }) });
    assert.equal(denied.statusCode, 403, denied.body);
    const saved = await action(own, "org_update_my_billing", { billing_json: JSON.stringify({
      auto_topup: { enabled: true, threshold_dollars: 60, topup_dollars: 120, status: "ok" },
      stripe: { customer_id: "cus_planted", payment_method_id: "pm_planted", has_payment_method: true }
    }) });
    assert.equal(saved.statusCode, 200, saved.body);
    const billing = (await storage.readGlobal(own.orgId) as any).data.billing;
    assert.equal(billing.auto_topup.enabled, true);
    assert.equal(billing.auto_topup.topup_dollars, 120);
    assert.equal(billing.auto_topup.status, "idle");
    assert.notEqual(billing.stripe?.customer_id, "cus_planted");
    assert.notEqual(billing.stripe?.payment_method_id, "pm_planted");
  });

  await t.test("an instant refund is the project's amount, once, whatever the body says", async () => {
    const projectId = `instant_${randomUUID().slice(0, 8)}`;
    manifests.set(projectId, { id: projectId, organization_ref: { id: own.orgId }, status: "rejected_no_coverage", report_mode: "instant",
      amount_charged: 12, refund_pending: true, refund_issued: false, refund_amount: 12, refund_reason: "instant_no_coverage" });
    const balance = async () => Number(((await storage.readGlobal(own.orgId)) as any).data.credits_balance ?? 0);
    const before = await balance();
    const first = await action(manager, "refund_instant_rejection", { project_id: projectId, refund_amount: 5000 });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().refund_amount, 12);
    assert.equal(await balance(), before + 12);
    assert.equal(manifests.get(projectId)!.refund_issued, true);
    const refundCall = calls.filter((call) => call.url.endsWith("/instant/refund")).at(-1)!;
    assert.equal(refundCall.kind, "system");
    // Again, and again with the project put back to pending (a failed mark): still once.
    assert.equal((await action(manager, "refund_instant_rejection", { project_id: projectId, refund_amount: 5000 })).statusCode, 200);
    Object.assign(manifests.get(projectId)!, { refund_pending: true, refund_issued: false });
    assert.equal((await action(manager, "refund_instant_rejection", { project_id: projectId })).statusCode, 200);
    assert.equal(await balance(), before + 12);
    // Not pending: nothing to refund. Another organization's project: not found.
    const unpaid = `instant_${randomUUID().slice(0, 8)}`;
    manifests.set(unpaid, { id: unpaid, organization_ref: { id: own.orgId }, status: "completed", amount_charged: 12, refund_pending: false });
    assert.equal((await action(manager, "refund_instant_rejection", { project_id: unpaid, refund_amount: 12 })).statusCode, 400);
    const foreign = `instant_${randomUUID().slice(0, 8)}`;
    manifests.set(foreign, { id: foreign, organization_ref: { id: other.orgId }, status: "rejected_no_coverage", amount_charged: 12, refund_pending: true, refund_amount: 12, refund_reason: "instant_no_coverage" });
    assert.equal((await action(manager, "refund_instant_rejection", { project_id: foreign })).statusCode, 404);
    assert.equal(await balance(), before + 12);
    // A member who cannot order reports cannot ask.
    const viewer = await makeMember(`viewer-${randomUUID().slice(0, 6)}`, "viewer");
    assert.equal((await action(viewer, "refund_instant_rejection", { project_id: projectId })).statusCode, 403);
  });

  await t.test("a customer cannot fulfil another organization's checkout session", async () => {
    const sessionId = `cs_test_${randomUUID().slice(0, 12)}`;
    stripeSessions.set(sessionId, { id: sessionId, mode: "payment", livemode: false, payment_status: "paid", currency: "usd", amount_total: 50000,
      metadata: { org_id: other.orgId, user_email: "other@example.test", credit_dollars: "500", paid_dollars: "500", credit_currency: "USD", paid_minor: "50000" } });
    const before = Number(((await storage.readGlobal(own.orgId)) as any).data.credits_balance ?? 0);
    const otherBefore = Number(((await storage.readGlobal(other.orgId)) as any).data.credits_balance ?? 0);
    const response = await action(own, "stripe_fulfill_session", { session_id: sessionId });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(Number(((await storage.readGlobal(own.orgId)) as any).data.credits_balance ?? 0), before);
    assert.equal(Number(((await storage.readGlobal(other.orgId)) as any).data.credits_balance ?? 0), otherBefore);
    const setup = await action(own, "billing_autotopup_setup_finish", { session_id: sessionId });
    assert.equal(setup.statusCode, 403, setup.body);
    assert.equal((await action(manager, "stripe_fulfill_session", { session_id: sessionId })).statusCode, 403);
  });

  await t.test("fetch_image refuses private and metadata addresses", async () => {
    for (const target of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/logo.png", "http://[::1]/logo.png", "http://10.0.0.5/logo.png", "http://localhost/logo.png"]) {
      const response = await action(manager, "fetch_image", { url: target });
      assert.equal(response.json().success, false, target);
      assert.equal(response.json().data_url, undefined, target);
    }
    assert.equal((await action(manager, "fetch_image", { url: "data:text/html;base64,PHNjcmlwdD4=" })).json().success, false);
    assert.equal((await action(own, "scrape_logos", { url: "http://169.254.169.254/" })).json().success, false);
  });

  await t.test("pj_search reads as the customer and returns only their organization's projects", async () => {
    const mine = `mine_${randomUUID().slice(0, 8)}`;
    const theirs = `theirs_${randomUUID().slice(0, 8)}`;
    manifests.set(mine, { id: mine, organization_ref: { id: own.orgId }, status: "completed" });
    manifests.set(theirs, { id: theirs, organization_ref: { id: other.orgId }, status: "completed" });
    const response = await action(manager, "pj_search", { limit: 50, organization_id: other.orgId, actor: { organization_id: other.orgId } });
    // A body naming another organization is refused outright.
    assert.equal(response.statusCode, 403, response.body);
    const listed = await action(manager, "pj_search", { limit: 50 });
    assert.equal(listed.statusCode, 200, listed.body);
    const orgs = new Set(listed.json().projects.map((row: any) => row.project.manifest.organization_ref.id));
    assert.deepEqual([...orgs], [own.orgId]);
    const listCall = calls.filter((call) => call.url === "/v1/firstmeasure/projects/list").at(-1)!;
    assert.equal(listCall.kind, "customer");
    assert.equal(listCall.orgId, own.orgId);
  });

  await t.test("the bonus test mode is not reachable through forwarded or spoofed local headers", async () => {
    const { isLoopbackDevelopmentRequest } = await import("../platform/portal_action_access.js");
    const fake = (headers: Record<string, string>, remoteAddress: string) => ({ headers, socket: { remoteAddress } }) as any;
    assert.equal(isLoopbackDevelopmentRequest(fake({ host: "localhost", origin: "http://localhost" }, "203.0.113.9")), false);
    assert.equal(isLoopbackDevelopmentRequest(fake({ "x-forwarded-for": "127.0.0.1" }, "127.0.0.1")), false);
    assert.equal(isLoopbackDevelopmentRequest(fake({}, "127.0.0.1")), true);
  });
});
