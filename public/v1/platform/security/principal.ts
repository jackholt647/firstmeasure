/**
 * Who is calling (docs/architecture/request-security.md#principals).
 *
 * Resolved once per request from verified credentials only: the platform
 * session cookie, the in-process service token, or a signed PHP request.
 * Body, query and `X-Internal-User-*` identity fields are never read here.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { env } from "../../src/config/env.js";
import { authContextFromRequest, type PlatformAuthContext } from "../auth.js";
import { forbidden, unauthorized } from "../errors.js";
import { identityIsStaffMember, internalStaffOrgId, staffActorRoles, staffAuthority, staffMeets, type StaffAuthority, type StaffLevel } from "./staff.js";
import { presentsProcessToken, presentsServiceSignature, processPrincipal, serviceSecrets, verifyServiceSignature } from "./service.js";
import { activeImpersonation } from "./impersonation.js";

export type Principal =
  | { kind: "anonymous" }
  | { kind: "customer"; auth: PlatformAuthContext }
  | { kind: "staff"; auth: PlatformAuthContext | null; staff: StaffAuthority; impersonator?: StaffAuthority; via: "session" | "php" | "service" }
  | { kind: "system"; via: "process" | "php"; reason?: string };

const SYSTEM: Principal = { kind: "system", via: "process" };
const ANONYMOUS: Principal = { kind: "anonymous" };
const resolved = new WeakMap<FastifyRequest, Promise<Principal>>();

/** A staff member that background work runs for (the data agent's runs), checked again now. */
export async function staffPrincipalFor(email: string): Promise<Principal | null> {
  const staff = staffAuthority(await readStaffUser(email.trim().toLowerCase()));
  return staff ? { kind: "staff", auth: null, staff, via: "service" } : null;
}

/** For unattended in-process work (workers, schedulers). */
export function systemPrincipal(reason?: string): Principal {
  return reason ? { kind: "system", via: "process", reason } : SYSTEM;
}

async function readStaffUser(email: string) {
  const { readInternalUser } = await import("../../internal/storage.js");
  return email ? await readInternalUser(email).catch(() => null) : null;
}

async function staffFromSession(auth: PlatformAuthContext): Promise<Principal | null> {
  if (!identityIsStaffMember(auth.identity)) return null;
  const email = String(auth.identity.email ?? "").trim().toLowerCase();
  const staff = staffAuthority(await readStaffUser(email));
  if (!staff) return null;
  if (staff.admin && auth.sessionId) {
    const target = await activeImpersonation(auth.sessionId, staff.email);
    if (target) {
      const acting = staffAuthority(await readStaffUser(target));
      if (acting) return { kind: "staff", auth, staff: acting, impersonator: staff, via: "session" };
    }
  }
  return { kind: "staff", auth, staff, via: "session" };
}

/**
 * The Full House PHP proxy's older signature (x-full-house-user/-time/-signature,
 * firstmeasure/full_house.ts): an HMAC of the staff email and time with the
 * internal secret. Accepted while PHP moves to the request-bound signature in
 * service.ts; remove once every PHP host sends that one.
 */
function legacyFullHouseActor(request: FastifyRequest) {
  const email = String(request.headers["x-full-house-user"] ?? "").trim().toLowerCase();
  const time = String(request.headers["x-full-house-time"] ?? "");
  const signature = String(request.headers["x-full-house-signature"] ?? "").toLowerCase();
  const secrets = serviceSecrets(env.firstMeasureInternalApiSecret);
  if (!email || !secrets.length || !/^\d{10}$/.test(time) || Math.abs(Date.now() / 1000 - Number(time)) > 180 || !/^[a-f0-9]{64}$/.test(signature)) return null;
  return secrets.some((secret) => timingSafeEqual(Buffer.from(signature), Buffer.from(createHmac("sha256", secret).update(`${email}\n${time}`).digest("hex")))) ? email : null;
}

async function resolve(request: FastifyRequest): Promise<Principal> {
  if (presentsProcessToken(request)) {
    const principal = processPrincipal(request);
    if (!principal) throw unauthorized("service_credential_invalid", "The service credential is not valid.");
    return principal;
  }
  if (presentsServiceSignature(request)) {
    const actor = verifyServiceSignature(request, serviceSecrets(env.firstMeasureInternalApiSecret));
    if (!actor) throw unauthorized("service_signature_invalid", "The service signature is not valid.");
    if (actor === "system") return { kind: "system", via: "php" };
    const staff = staffAuthority(await readStaffUser(actor));
    if (!staff) throw forbidden("service_actor_not_staff", "The signed actor is not an active staff member.");
    return { kind: "staff", auth: null, staff, via: "php" };
  }
  const legacyFullHouse = legacyFullHouseActor(request);
  if (legacyFullHouse) {
    const staff = staffAuthority(await readStaffUser(legacyFullHouse));
    if (!staff) throw forbidden("service_actor_not_staff", "The signed actor is not an active staff member.");
    return { kind: "staff", auth: null, staff, via: "php" };
  }
  const auth = await authContextFromRequest(request).catch((error: unknown) => {
    // A disabled user or inactive identity is simply not signed in; anything
    // else (the store is down) must fail the request, not downgrade it.
    const status = Number((error as { statusCode?: number })?.statusCode);
    if (status === 401 || status === 403 || status === 404) return null;
    throw error;
  });
  if (!auth) return ANONYMOUS;
  return (await staffFromSession(auth)) ?? { kind: "customer", auth };
}

const settled = new WeakMap<FastifyRequest, Principal>();

export function requestPrincipal(request: FastifyRequest): Promise<Principal> {
  let principal = resolved.get(request);
  if (!principal) {
    principal = resolve(request).then((value) => {
      settled.set(request, value);
      return value;
    });
    resolved.set(request, principal);
  }
  return principal;
}

/**
 * The principal the route gate already resolved, for synchronous code inside
 * handlers. Anonymous when nothing resolved it (a public route).
 */
export function knownPrincipal(request: FastifyRequest): Principal {
  return settled.get(request) ?? ANONYMOUS;
}

export type PrincipalActor = {
  email: string;
  name: string;
  role: string;
  roles: string[];
  department: string;
  team_id: string;
  organization_id: string;
};

/**
 * The actor legacy handlers read (`body.actor`, `actorFromRequest`), built
 * from the verified principal. Null for the system principal: trusted
 * service code may then name the actor it works for in the body.
 */
export function principalActor(principal: Principal): PrincipalActor | null {
  if (principal.kind === "system") return null;
  if (principal.kind === "staff") {
    return {
      email: principal.staff.email,
      name: principal.staff.name,
      role: principal.staff.role,
      roles: staffActorRoles(principal.staff),
      department: principal.staff.department,
      team_id: principal.staff.team_id,
      organization_id: principal.auth?.orgId ?? internalStaffOrgId()
    };
  }
  if (principal.kind === "customer") {
    const auth = principal.auth;
    return {
      email: String(auth.identity.email ?? "").trim().toLowerCase(),
      name: String(auth.user.name ?? auth.identity.name ?? auth.identity.email ?? "").trim(),
      role: auth.role,
      roles: [],
      department: String(auth.user.department ?? ""),
      team_id: String(auth.user.team_id || auth.branchId || ""),
      organization_id: auth.orgId
    };
  }
  return { email: "", name: "", role: "", roles: [], department: "", team_id: "", organization_id: "" };
}

export function isStaffOrSystem(principal: Principal, level: StaffLevel = "any") {
  return principal.kind === "system" || (principal.kind === "staff" && staffMeets(principal.staff, level));
}

export async function requireStaff(request: FastifyRequest, level: StaffLevel = "any") {
  const principal = await requestPrincipal(request);
  if (principal.kind === "anonymous") throw unauthorized("authentication_required", "Authentication required.");
  if (principal.kind !== "staff" || !staffMeets(principal.staff, level)) {
    throw forbidden("staff_required", level === "any" ? "Internal staff access is required." : `Internal ${level} access is required.`);
  }
  return principal;
}

/** The email that writes and audit records attribute work to. */
export function principalEmail(principal: Principal) {
  if (principal.kind === "staff") return principal.staff.email;
  if (principal.kind === "customer") return String(principal.auth.identity.email ?? "").trim().toLowerCase();
  return "";
}

export function principalName(principal: Principal) {
  if (principal.kind === "staff") return principal.staff.name;
  if (principal.kind === "customer") return String(principal.auth.identity.name ?? principal.auth.identity.email ?? "").trim();
  return "";
}

/** A short description for logs and audit entries. */
export function describePrincipal(principal: Principal) {
  switch (principal.kind) {
    case "anonymous": return "anonymous";
    case "customer": return `customer:${principal.auth.orgId}:${principalEmail(principal)}`;
    case "staff": return `staff:${principal.staff.email}${principal.impersonator ? `(as by ${principal.impersonator.email})` : ""}:${principal.via}`;
    case "system": return `system:${principal.via}${principal.reason ? `:${principal.reason}` : ""}`;
  }
}
