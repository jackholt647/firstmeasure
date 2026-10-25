/**
 * The request security boundary (docs/architecture/request-security.md):
 * every route under a covered prefix declares who may call it, anonymous and
 * spoofed callers are refused, a customer sees only their own organization's
 * projects, and service credentials cannot be forged.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closePlatformFixtureStores } from "./helpers/platform-fixture.js";

const SECRET = "route-access-fixture-session-secret";
const INTERNAL_SECRET = "route-access-fixture-internal-secret";
let app: any = null;
let storageRoot = "";

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-route-access-"));
  Object.assign(process.env, {
    NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1",
    EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error",
    PLATFORM_SESSION_SECRET: SECRET, FIRSTMEASURE_INTERNAL_API_SECRET: INTERNAL_SECRET,
    PUBLIC_BASE_URL: "https://app.example.test", CORS_ALLOWED_ORIGINS: "https://app.example.test",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook")
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  await closePlatformFixtureStores();
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
});

const cookieFor = (sessionId: string) => `fm_platform_session=${sessionId}.${createHmac("sha256", SECRET).update(sessionId).digest("base64url")}`;

async function customer(label: string) {
  const storage = await import("../platform/storage.js");
  const org = await storage.createOrganization({ name: `${label} roofing` });
  const orgId = String(org.id);
  const email = `${label}-${randomUUID()}@example.test`;
  const userId = `${label}_owner`;
  const identity = await storage.createIdentity({ email, name: label, memberships: [{ organization_id: orgId, user_id: userId }] });
  await storage.upsertDocument(orgId, "users", { id: userId, data: { identity_id: identity.id, email, name: label, status: "active", org_permissions: { level: "owner", items: {} } } });
  const session = await storage.createAuthSession({ identity_id: identity.id, organization_id: orgId, user_id: userId, role: "owner" });
  return { orgId, email, cookie: cookieFor(session.sessionId), csrf: String(session.session.csrf_token) };
}

async function staffMember(label: string, role: string, { member = true } = {}) {
  const storage = await import("../platform/storage.js");
  const internal = await import("../internal/storage.js");
  const staffOrg = "legacy_internal";
  await storage.createOrganization({ id: staffOrg, name: "Internal Staff" }).catch(() => undefined);
  const email = `${label}-${randomUUID()}@firstmate.example.test`;
  const userId = `${label}_staff`;
  const identity = await storage.createIdentity({ email, name: label, memberships: member ? [{ organization_id: staffOrg, user_id: userId }] : [] });
  await storage.upsertDocument(staffOrg, "users", { id: userId, data: { identity_id: identity.id, email, name: label, status: "active", org_permissions: { level: "member", items: {} } } });
  await internal.saveInternalUser({ email, name: label, role, status: "active", account_type: "employee" });
  const session = await storage.createAuthSession({ identity_id: identity.id, organization_id: staffOrg, user_id: userId, role: "member" });
  return { email, cookie: cookieFor(session.sessionId) };
}

async function project(orgId: string, address: string) {
  const { createProject } = await import("../firstmeasure/storage.js");
  const created: any = await createProject({ address, organization_id: orgId, organization_ref: { id: orgId }, owner_email: `owner@${orgId}.test`, amount_charged: 12 } as any);
  return String(created.manifest?.id ?? created.id);
}

const inject = (method: string, url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({ method, url, headers: { origin: "https://app.example.test", ...headers }, ...(payload === undefined ? {} : { payload }) });

test("every route under a covered prefix has a valid access declaration", async () => {
  const { declaredRoutes, isCoveredUrl } = await import("../platform/security/route-access.js");
  const routes = declaredRoutes();
  assert.ok(routes.length > 250, `only ${routes.length} declared routes`);
  for (const { route, access } of routes) {
    assert.ok(isCoveredUrl(route.split(" ")[1]!), route);
    if (typeof access === "object" && "public" in access) assert.ok(access.public.length >= 8, route);
  }
});

test("anonymous callers are refused on every non-public covered route", async () => {
  const { declaredRoutes } = await import("../platform/security/route-access.js");
  const allowedWhenRefused = new Set([400, 401, 403, 404, 405, 413, 415]);
  for (const { route, access } of declaredRoutes()) {
    if (typeof access === "object" && "public" in access) continue;
    const [method, pattern] = route.split(" ") as [string, string];
    if (method === "HEAD" || pattern.includes("*")) continue;
    const url = pattern.replace(/:[A-Za-z]+/g, "probe");
    const response = await inject(method, url, {}, ["GET", "DELETE"].includes(method) ? undefined : {});
    assert.ok(allowedWhenRefused.has(response.statusCode), `${route} answered ${response.statusCode} to an anonymous caller: ${response.body.slice(0, 200)}`);
  }
});

test("identity headers and body actors grant nothing", async () => {
  const admin = await staffMember("spoofed-admin", "admin");
  const headers = { "x-internal-user-email": admin.email, "x-internal-user-role": "admin" };
  assert.equal((await inject("GET", "/v1/internal/users", headers)).statusCode, 401);
  assert.equal((await inject("POST", "/v1/internal/users", headers, { email: "new@example.test", role: "admin" })).statusCode, 401);
  assert.equal((await inject("POST", "/v1/firstmeasure/admin/reindex", {}, { actor: { email: admin.email, roles: ["admin"] } })).statusCode, 401);
  assert.equal((await inject("POST", "/v1/firstmeasure/projects/list", {}, { actor: { organization_id: "org_anything" }, limit: 0 })).statusCode, 401);
  assert.equal((await inject("POST", "/v1/communications/gmail/send", {}, { actor_email: admin.email, to: "x@example.test" })).statusCode, 401);
  // A forged in-process token is refused, not ignored.
  assert.equal((await inject("GET", "/v1/internal/users", { "x-fm-process-token": "guess", "x-fm-process-principal": "guess" })).statusCode, 401);
});

test("a customer reaches only their own organization's projects", async () => {
  const a = await customer("alpha");
  const b = await customer("bravo");
  const alphaProject = await project(a.orgId, "1 Alpha Way, Mobile, AL");
  await project(b.orgId, "2 Bravo Road, Mobile, AL");

  assert.equal((await inject("GET", `/v1/firstmeasure/projects/${alphaProject}`, { cookie: a.cookie })).statusCode, 200);
  for (const [method, suffix] of [["GET", ""], ["GET", "/artifacts/report.pdf"], ["GET", "/thumbnail"], ["PATCH", ""], ["POST", "/instant/ensure"]] as const) {
    const response = await inject(method, `/v1/firstmeasure/projects/${alphaProject}${suffix}`, { cookie: b.cookie }, method === "GET" ? undefined : { resident: { name: "x" } });
    assert.equal(response.statusCode, 404, `${method} ${suffix} answered ${response.statusCode}`);
  }

  // Lists are limited in SQL, whatever filter, actor or organization the body names.
  for (const body of [{ filter: "all" }, { filter: "org", actor: { organization_id: a.orgId } }, { organization_id: a.orgId, limit: 0 }, {}]) {
    const listed = await inject("POST", "/v1/firstmeasure/projects/list", { cookie: b.cookie }, body);
    assert.equal(listed.statusCode, 200, listed.body);
    const ids = (listed.json().projects ?? []).map((row: any) => String(row.id ?? row.project?.manifest?.id ?? row.folder ?? ""));
    assert.ok(!ids.includes(alphaProject), `bravo saw alpha's project with ${JSON.stringify(body)}`);
  }
  // Staff-only routes are closed to customers.
  assert.equal((await inject("POST", "/v1/firstmeasure/projects/query", { cookie: b.cookie }, {})).statusCode, 403);
  assert.equal((await inject("GET", "/v1/internal/users", { cookie: b.cookie })).statusCode, 403);
});

test("a customer's project changes are limited to the customer info fields", async () => {
  const a = await customer("charlie");
  const id = await project(a.orgId, "3 Charlie Court, Mobile, AL");
  const patched = await inject("PATCH", `/v1/firstmeasure/projects/${id}`, { cookie: a.cookie }, {
    resident: { name: "Pat Homeowner" }, amount_charged: 1_000_000, status: "completed", issuer: { email: "attacker@example.test" }
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const { readManifest } = await import("../firstmeasure/storage.js");
  const manifest: any = await readManifest(id);
  assert.equal(manifest.resident?.name, "Pat Homeowner");
  assert.notEqual(manifest.amount_charged, 1_000_000);
  assert.notEqual(manifest.status, "completed");
  assert.notEqual(manifest.issuer?.email, "attacker@example.test");
});

test("staff are recognised by staff organization membership and their level", async () => {
  const technician = await staffMember("tech", "technician");
  const admin = await staffMember("boss", "admin");
  const outsider = await staffMember("outsider", "admin", { member: false });
  assert.equal((await inject("GET", "/v1/internal/users", { cookie: technician.cookie })).statusCode, 200);
  assert.equal((await inject("POST", "/v1/firstmeasure/admin/index-status", { cookie: technician.cookie }, {})).statusCode, 403);
  assert.equal((await inject("POST", "/v1/firstmeasure/admin/index-status", { cookie: admin.cookie }, {})).statusCode, 200);
  // An internal user record alone, without the staff organization membership, is not staff.
  assert.equal((await inject("GET", "/v1/internal/users", { cookie: outsider.cookie })).statusCode, 403);
  const me = await inject("GET", "/v1/internal/me", { cookie: outsider.cookie });
  assert.equal(me.json().staff, false);
  // A technician cannot make themselves an admin.
  const promote = await inject("PATCH", `/v1/internal/users/${encodeURIComponent(technician.email)}`, { cookie: technician.cookie }, { role: "admin" });
  assert.equal(promote.statusCode, 403);
});

test("an admin can act as another staff member, and stopping restores them", async () => {
  const admin = await staffMember("acting-admin", "admin");
  const technician = await staffMember("acted-tech", "technician");
  const started = await inject("POST", "/v1/internal/impersonation", { cookie: admin.cookie }, { target_email: technician.email });
  assert.equal(started.statusCode, 200, started.body);
  const me = (await inject("GET", "/v1/internal/me", { cookie: admin.cookie })).json();
  assert.equal(me.user.email, technician.email);
  assert.equal(me.impersonated_by, admin.email);
  // Acting as a technician, admin routes are closed.
  assert.equal((await inject("POST", "/v1/firstmeasure/admin/index-status", { cookie: admin.cookie }, {})).statusCode, 403);
  await inject("DELETE", "/v1/internal/impersonation", { cookie: admin.cookie });
  assert.equal((await inject("GET", "/v1/internal/me", { cookie: admin.cookie })).json().user.email, admin.email);
  // A technician cannot start acting as anyone.
  assert.equal((await inject("POST", "/v1/internal/impersonation", { cookie: technician.cookie }, { target_email: admin.email })).statusCode, 403);
});

test("signed PHP requests: the actor, time, path and body are all bound", async () => {
  const { signServiceRequest } = await import("../platform/security/service.js");
  const technician = await staffMember("php-tech", "technician");
  const url = "/v1/firstmeasure/queue/counts";
  const body = JSON.stringify({ bucket: "all" });
  const signed = signServiceRequest(INTERNAL_SECRET, { method: "POST", url, actor: technician.email, body });
  const headers = { ...signed, "content-type": "application/json" } as Record<string, string>;
  const ok = await app.inject({ method: "POST", url, headers, payload: body });
  assert.notEqual(ok.statusCode, 401, ok.body);
  assert.notEqual(ok.statusCode, 403, ok.body);
  assert.equal((await app.inject({ method: "POST", url, headers, payload: JSON.stringify({ bucket: "other" }) })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: `${url}?x=1`, headers, payload: body })).statusCode, 401);
  const stale = signServiceRequest(INTERNAL_SECRET, { method: "POST", url, actor: technician.email, body, time: Math.floor(Date.now() / 1000) - 600 });
  assert.equal((await app.inject({ method: "POST", url, headers: { ...stale, "content-type": "application/json" }, payload: body })).statusCode, 401);
  const wrongKey = signServiceRequest("not-the-secret", { method: "POST", url, actor: technician.email, body });
  assert.equal((await app.inject({ method: "POST", url, headers: { ...wrongKey, "content-type": "application/json" }, payload: body })).statusCode, 401);
  const notStaff = signServiceRequest(INTERNAL_SECRET, { method: "POST", url, actor: "nobody@example.test", body });
  assert.equal((await app.inject({ method: "POST", url, headers: { ...notStaff, "content-type": "application/json" }, payload: body })).statusCode, 403);
});

test("customer files open with a signed link and not without one", async () => {
  const a = await customer("delta");
  const id = await project(a.orgId, "4 Delta Drive, Mobile, AL");
  const { signedProjectFileQuery } = await import("../firstmeasure/access.js");
  assert.equal((await inject("GET", `/v1/firstmeasure/projects/${id}/thumbnail`)).statusCode, 401);
  const signed = await inject("GET", `/v1/firstmeasure/projects/${id}/thumbnail?${signedProjectFileQuery(id, "thumbnail")}`);
  assert.notEqual(signed.statusCode, 401);
  const otherFile = await inject("GET", `/v1/firstmeasure/projects/${id}/artifacts/report.pdf?${signedProjectFileQuery(id, "thumbnail")}`);
  assert.equal(otherFile.statusCode, 401);
});

test("credentialed CORS and cookie writes are for our own origin only", async () => {
  const a = await customer("echo");
  const foreign = await app.inject({ method: "GET", url: "/v1/firstmeasure/ping", headers: { origin: "https://evil.example" } });
  assert.notEqual(foreign.headers["access-control-allow-credentials"], "true");
  const own = await app.inject({ method: "GET", url: "/v1/firstmeasure/ping", headers: { origin: "https://app.example.test" } });
  assert.equal(own.headers["access-control-allow-credentials"], "true");
  const crossSite = await app.inject({ method: "POST", url: "/v1/firstmeasure/projects/list", headers: { origin: "https://dev.example.test", cookie: a.cookie }, payload: {} });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(foreign.headers["x-content-type-options"], "nosniff");
});
