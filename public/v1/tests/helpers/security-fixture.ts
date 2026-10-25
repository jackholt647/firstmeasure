/**
 * Real credentials for tests of covered routes
 * (docs/architecture/request-security.md). Identity headers and body actors
 * no longer authenticate anyone; tests sign in the way production callers do.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

function sessionSecret() {
  return process.env.PLATFORM_SESSION_SECRET ?? process.env.DEV_CONSOLE_SESSION_SECRET ?? process.env.DEV_CONSOLE_PASSWORD ?? "firstmate-local-dev-session-secret";
}

function cookieFor(sessionId: string) {
  const name = process.env.PLATFORM_SESSION_COOKIE_NAME ?? "fm_platform_session";
  return `${name}=${sessionId}.${createHmac("sha256", sessionSecret()).update(sessionId).digest("base64url")}`;
}

/**
 * For tests that build their own Fastify app instead of `buildApp`: install
 * the route gate before registering any covered plugin.
 */
export async function installRequestSecurityForTests(app: FastifyInstance) {
  await import("../../platform/security/route-access-tables.js");
  const { installRouteAccess } = await import("../../platform/security/route-access.js");
  const { setServiceApp } = await import("../../platform/security/service.js");
  installRouteAccess(app);
  setServiceApp(app);
}

export type StaffFixture = { email: string; cookie: string; headers: Record<string, string>; csrf: string };

/**
 * A staff member with an internal user record (any fields of it in `user`)
 * and a staff-organization session. Reuses the internal user when `email`
 * already exists.
 */
export async function staffFixture(user: Record<string, unknown> & { email?: string; role?: string } = {}): Promise<StaffFixture> {
  const storage = await import("../../platform/storage.js");
  const internal = await import("../../internal/storage.js");
  const staffOrg = String(process.env.INTERNAL_PLATFORM_ORG_ID || process.env.STAFF_PLATFORM_ORG_ID || "legacy_internal").toLowerCase();
  await storage.createOrganization({ id: staffOrg, name: "Internal Staff" }).catch(() => undefined);
  const email = String(user.email ?? `staff-${randomUUID()}@firstmate.example.test`).toLowerCase();
  const existing = await internal.readInternalUser(email).catch(() => null);
  await internal.saveInternalUser({ name: email, account_type: "employee", status: "active", ...(existing ?? {}), ...user, email });
  const userId = `staff_${createHmac("sha256", "fixture").update(email).digest("hex").slice(0, 16)}`;
  let identity = await storage.findIdentityByEmail(email).catch(() => null);
  if (!identity) identity = await storage.createIdentity({ email, name: email, memberships: [{ organization_id: staffOrg, user_id: userId }] });
  else await storage.addIdentityMembership(String(identity.id), staffOrg, userId, "member").catch(() => undefined);
  await storage.upsertDocument(staffOrg, "users", { id: userId, data: { identity_id: identity.id, email, name: email, status: "active", org_permissions: { level: "member", items: {} } } });
  const session = await storage.createAuthSession({ identity_id: identity.id, organization_id: staffOrg, user_id: userId, role: "member" });
  const cookie = cookieFor(session.sessionId);
  const csrf = String(session.session.csrf_token ?? "");
  return { email, cookie, csrf, headers: { cookie, "x-platform-csrf": csrf } };
}

type InjectLike = { inject: (options: any) => Promise<any> };

function roleFromActor(actor: Record<string, unknown>) {
  const roles = (Array.isArray(actor.roles) ? actor.roles : []).map((role) => String(role).toLowerCase());
  for (const role of ["admin", "manager", "qa", "technician"]) if (roles.includes(role)) return role;
  return typeof actor.role === "string" && actor.role ? actor.role : "";
}

/**
 * `app.inject` for tests written around a body `actor`: each request is sent
 * with the staff session of the person it names (`as`, else `payload.actor`,
 * else `payload.actor_email`, else the fallback person), the way that person's
 * browser would send it. The actor stays in the body, where the server ignores
 * it. `people` gives a person's internal user fields (role, team_id, ...);
 * anyone else gets the actor's role, or `fallback`.
 */
export function staffInjector(app: InjectLike, people: Record<string, Record<string, unknown>> = {}, fallback: Record<string, unknown> & { email?: string } = { role: "technician" }) {
  const sessions = new Map<string, Promise<StaffFixture>>();
  const fallbackEmail = String(fallback.email ?? "staff-caller@firstmate.example.test").toLowerCase();
  const sessionFor = (email: string, actor: Record<string, unknown> = {}) => {
    const key = email.toLowerCase();
    let session = sessions.get(key);
    if (!session) {
      session = (async () => {
        // A person the test already saved as an internal user keeps that record.
        const { readInternalUser } = await import("../../internal/storage.js");
        const existing = await readInternalUser(key).catch(() => null);
        const fields = people[key] ?? people[email] ?? (roleFromActor(actor) ? { role: roleFromActor(actor) } : existing ? {} : { ...fallback });
        return await staffFixture({ ...(existing ? {} : { name: String(actor.name ?? email) }), ...fields, email: key });
      })();
      sessions.set(key, session);
    }
    return session;
  };
  const inject = async (options: Record<string, any> & { as?: string }) => {
    const { as, ...rest } = options;
    const payload = rest.payload && typeof rest.payload === "object" && !Buffer.isBuffer(rest.payload) ? rest.payload as Record<string, unknown> : {};
    const actor = payload.actor && typeof payload.actor === "object" ? payload.actor as Record<string, unknown> : {};
    const email = String(as ?? actor.email ?? payload.actor_email ?? fallbackEmail);
    const staff = await sessionFor(email, actor);
    return await app.inject({ ...rest, headers: { ...staff.headers, ...(rest.headers ?? {}) } });
  };
  return Object.assign(inject, { sessionFor });
}

export type CustomerFixture ={ orgId: string; userId: string; email: string; cookie: string; csrf: string; headers: Record<string, string> };

/** An organization owner (or the given legacy level) with a session. */
export async function customerFixture(options: { orgId?: string; level?: string; items?: Record<string, boolean>; email?: string } = {}): Promise<CustomerFixture> {
  const storage = await import("../../platform/storage.js");
  const orgId = options.orgId ?? String((await storage.createOrganization({ name: `Fixture ${randomUUID().slice(0, 8)}` })).id);
  const email = (options.email ?? `customer-${randomUUID()}@example.test`).toLowerCase();
  const userId = `user_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const identity = await storage.createIdentity({ email, name: email, memberships: [{ organization_id: orgId, user_id: userId }] });
  await storage.upsertDocument(orgId, "users", { id: userId, data: { identity_id: identity.id, email, name: email, status: "active", org_permissions: { level: options.level ?? "owner", items: options.items ?? {} } } });
  const session = await storage.createAuthSession({ identity_id: identity.id, organization_id: orgId, user_id: userId, role: options.level ?? "owner" });
  const cookie = cookieFor(session.sessionId);
  const csrf = String(session.session.csrf_token ?? "");
  return { orgId, userId, email, cookie, csrf, headers: { cookie, "x-platform-csrf": csrf } };
}

/**
 * Gives the server an internal secret when the test environment has none, so
 * signed service requests can be made (env.ts reads the secret once, at import,
 * which may already have happened).
 */
export async function ensureServiceSecretForTests(secret = "firstmate-test-internal-api-secret") {
  const { env } = await import("../../src/config/env.js");
  const mutable = env as unknown as { firstMeasureInternalApiSecret: string };
  if (!mutable.firstMeasureInternalApiSecret) mutable.firstMeasureInternalApiSecret = process.env.FIRSTMEASURE_INTERNAL_API_SECRET || secret;
  process.env.FIRSTMEASURE_INTERNAL_API_SECRET ||= mutable.firstMeasureInternalApiSecret;
  return mutable.firstMeasureInternalApiSecret;
}

/** Headers for a request signed the way PHP signs (platform/security/service.ts). */
export async function signedServiceHeaders(method: string, url: string, actor: string, body?: unknown) {
  const { signServiceRequest } = await import("../../platform/security/service.js");
  // The secret the server verifies with (env.ts reads it once, at import).
  const { env } = await import("../../src/config/env.js");
  const secret = env.firstMeasureInternalApiSecret || process.env.FIRSTMEASURE_INTERNAL_API_SECRET || "";
  if (!secret) throw new Error("Set FIRSTMEASURE_INTERNAL_API_SECRET before signing service requests in a test.");
  const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return { ...signServiceRequest(secret, { method, url, actor, body: payload }), ...(body === undefined ? {} : { "content-type": "application/json" }) } as Record<string, string>;
}
