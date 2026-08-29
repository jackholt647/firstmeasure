import { createHmac, timingSafeEqual } from "node:crypto";

import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../src/config/env.js";
import { forbidden, unauthorized } from "./errors.js";
import {
  createAuthSession,
  deleteAuthSession,
  findIdentityByIdentifier,
  listIdentityMemberships,
  patchIdentity,
  readAuthSession,
  readDocument,
  readIdentity,
  readOrganization,
  touchAuthSession,
  upsertDocument,
  type JsonObject
} from "./storage.js";

export type PlatformAuthContext = {
  sessionId: string;
  session: JsonObject;
  identity: JsonObject;
  organization: JsonObject;
  user: JsonObject;
  userDocument: JsonObject;
  orgId: string;
  userId: string;
  identityId: string;
  role: string;
  branchId: string;
  permissions: JsonObject;
  csrfToken: string;
};

type LoginInput = {
  identifier?: string;
  email?: string;
  password: string;
  organizationId?: string;
  ttlSeconds?: number;
  metadata?: JsonObject;
};

type VerifiedLoginInput = {
  identity: JsonObject;
  organizationId?: string;
  ttlSeconds?: number;
  metadata?: JsonObject;
};

const CSRF_COOKIE_NAME = `${env.platformSessionCookieName}_csrf`;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedIdentityStatus(identity: JsonObject) {
  return cleanText(identity.status || "active").toLowerCase();
}

function identityStatusBlocksLogin(identity: JsonObject) {
  return ["disabled", "inactive", "deleted", "suspended"].includes(normalizedIdentityStatus(identity));
}

function identityStatusShouldRepairOnLogin(identity: JsonObject) {
  return ["invited", "pending"].includes(normalizedIdentityStatus(identity));
}

function sign(value: string) {
  return createHmac("sha256", env.platformSessionSecret).update(value).digest("base64url");
}

function signedCookieValue(sessionId: string) {
  return `${sessionId}.${sign(sessionId)}`;
}

function verifySignedCookie(value: string) {
  const [sessionId, signature] = String(value || "").split(".");
  if (!sessionId || !signature) return null;
  const expected = sign(sessionId);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return sessionId;
}

function parseCookies(header: unknown) {
  const cookies: Record<string, string> = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = decodeURIComponent(part.slice(0, index).trim());
    const value = decodeURIComponent(part.slice(index + 1).trim());
    cookies[key] = value;
  }
  return cookies;
}

function cookieValues(header: unknown, cookieName: string) {
  const values: string[] = [];
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = decodeURIComponent(part.slice(0, index).trim());
    if (key !== cookieName) continue;
    values.push(decodeURIComponent(part.slice(index + 1).trim()));
  }
  return values;
}

export function platformSessionIdsFromRequest(request: FastifyRequest) {
  const sessionIds: string[] = [];
  // A browser may send both a host-only development cookie and an older
  // parent-domain production cookie with the same name. Cookie headers allow
  // duplicate names and do not define which one an application should keep.
  for (const value of cookieValues(request.headers.cookie, env.platformSessionCookieName)) {
    const sessionId = verifySignedCookie(value);
    if (sessionId && !sessionIds.includes(sessionId)) sessionIds.push(sessionId);
  }
  return sessionIds;
}

export function platformSessionIdFromRequest(request: FastifyRequest) {
  return platformSessionIdsFromRequest(request)[0] ?? null;
}

export function selectNewestPlatformSessionCandidate<T extends { sessionId: string; session: JsonObject }>(candidates: T[]) {
  let selected: T | null = null;
  let selectedCreatedAt = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const createdAt = Date.parse(String(candidate.session.created_at ?? ""));
    const comparableCreatedAt = Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
    if (!selected || comparableCreatedAt > selectedCreatedAt) {
      selected = candidate;
      selectedCreatedAt = comparableCreatedAt;
    }
  }
  return selected;
}

function isHttpsRequest(request: FastifyRequest) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").toLowerCase();
  return forwardedProto === "https" || (request.socket as { encrypted?: boolean }).encrypted === true;
}

function cookieOptions(request: FastifyRequest, maxAgeSeconds: number) {
  const secure = isHttpsRequest(request);
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function readableCookieOptions(request: FastifyRequest, maxAgeSeconds: number) {
  const secure = isHttpsRequest(request);
  return [
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

export function clearPlatformAuthCookies(request: FastifyRequest, reply: FastifyReply) {
  reply.header("Set-Cookie", [
    `${env.platformSessionCookieName}=; ${cookieOptions(request, 0)}`,
    `${CSRF_COOKIE_NAME}=; ${readableCookieOptions(request, 0)}`
  ]);
}

export function setPlatformAuthCookies(request: FastifyRequest, reply: FastifyReply, sessionId: string, csrfToken: string, ttlSeconds = env.platformSessionTtlSeconds) {
  reply.header("Set-Cookie", [
    `${env.platformSessionCookieName}=${encodeURIComponent(signedCookieValue(sessionId))}; ${cookieOptions(request, ttlSeconds)}`,
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; ${readableCookieOptions(request, ttlSeconds)}`
  ]);
}

export async function verifyPassword(password: string, passwordHash: string) {
  const hash = cleanText(passwordHash);
  if (!hash || !password) return false;
  if (hash.startsWith("$2y$")) {
    return bcrypt.compare(password, `$2b$${hash.slice(4)}`);
  }
  return bcrypt.compare(password, hash);
}

export async function hashPassword(password: string) {
  return await bcrypt.hash(password, 12);
}

function publicIdentity(identity: JsonObject) {
  const value = { ...identity };
  delete value.password_hash;
  delete value.password_reset;
  delete value.otp;
  const metadata = asObject(value.metadata);
  const signupVerification = asObject(metadata.signup_email_verification);
  if (Object.keys(signupVerification).length) {
    const safeVerification = { ...signupVerification };
    delete safeVerification.code_hash;
    delete safeVerification.expires_at;
    value.metadata = { ...metadata, signup_email_verification: safeVerification };
  }
  return value;
}

function orgUserPermissionState(user: JsonObject) {
  const orgPermissions = asObject(user.org_permissions);
  const level = cleanText(orgPermissions.level || user.org_permission_level || user.permission_level || user.role || "viewer").toLowerCase() || "viewer";
  const items = asObject(orgPermissions.items ?? user.permissions);
  const presets: Record<string, JsonObject> = {
    viewer: { view_reports: true },
    manager: { order_reports: true, view_reports: true },
    admin: {
      order_reports: true,
      view_reports: true,
      manage_billing: true,
      manage_company_settings: true,
      manage_report_settings: true,
      manage_company_users: true
    },
    owner: { "*": true },
    super_admin: {
      "*": true,
      order_reports: true,
      view_reports: true,
      manage_billing: true,
      manage_company_settings: true,
      manage_report_settings: true,
      manage_company_users: true,
      manage_company_user_permissions: true
    }
  };
  if (level === "custom") return { level, items, permissions: items };
  if (presets[level]) return { level, items, permissions: { ...presets[level], ...items } };
  return {
    level,
    items,
    permissions: Object.keys(items).length ? items : presets.viewer
  };
}

function sanitizeUser(userDoc: JsonObject) {
  const data = asObject(userDoc.data);
  const permissionState = orgUserPermissionState(data);
  return {
    id: userDoc.id,
    ...data,
    permissions: permissionState.permissions,
    org_permissions: {
      level: permissionState.level,
      items: permissionState.items
    },
    effective_permissions: permissionState.permissions,
    disabled: String(data.status || "active") === "disabled"
  };
}

export function publicAuthContext(ctx: PlatformAuthContext) {
  const metadata = asObject(ctx.session.metadata);
  const impersonatedByEmail = cleanText(metadata.impersonated_by_email);
  return {
    authenticated: true,
    identity: publicIdentity(ctx.identity),
    organization: ctx.organization,
    user: sanitizeUser(ctx.userDocument),
    membership: {
      organization_id: ctx.orgId,
      user_id: ctx.userId,
      role: ctx.role,
      branch_id: ctx.branchId,
      permissions: ctx.permissions
    },
    impersonation: impersonatedByEmail ? {
      active: true,
      admin_email: impersonatedByEmail,
      admin_name: cleanText(metadata.impersonated_by_name || impersonatedByEmail),
      started_at: cleanText(metadata.impersonated_at),
      source: cleanText(metadata.source)
    } : { active: false },
    csrf_token: ctx.csrfToken
  };
}

function membershipMatchesOrg(entry: unknown, orgId?: string) {
  const membership = asObject(entry);
  if (!orgId) return true;
  return String(asObject(membership.organization).id || membership.organization_id || "") === orgId;
}

export async function loginPlatformIdentity(input: LoginInput) {
  const identifier = cleanText(input.identifier || input.email);
  const password = String(input.password || "");
  const identity = await findIdentityByIdentifier(identifier);
  if (identityStatusBlocksLogin(identity)) {
    throw unauthorized("identity_inactive", "This account is not active.");
  }
  if (!(await verifyPassword(password, String(identity.password_hash || "")))) {
    throw unauthorized("invalid_credentials", "Invalid email/phone or password.");
  }

  return await loginPlatformVerifiedIdentity({
    identity,
    organizationId: input.organizationId,
    ttlSeconds: input.ttlSeconds,
    metadata: input.metadata
  });
}

export async function loginPlatformVerifiedIdentity(input: VerifiedLoginInput) {
  const identity = input.identity;
  if (identityStatusBlocksLogin(identity)) {
    throw unauthorized("identity_inactive", "This account is not active.");
  }
  const memberships = await listIdentityMemberships(String(identity.id || ""));
  const selected = memberships.find((entry) => membershipMatchesOrg(entry, input.organizationId)) || memberships[0];
  if (!selected) throw forbidden("membership_required", "This user is not assigned to an organization.");
  const organization = asObject((selected as JsonObject).organization);
  const userDocument = asObject((selected as JsonObject).user);
  const user = asObject(userDocument.data);
  if (String(user.status || "active") === "disabled") {
    throw forbidden("user_disabled", "This organization user is disabled.");
  }

  const permissionState = orgUserPermissionState(user);
  const role = permissionState.level;
  const permissions = permissionState.permissions;
  const branchId = String(user.branch_id || "default");
  const { sessionId, session } = await createAuthSession({
    identity_id: identity.id,
    organization_id: organization.id,
    user_id: userDocument.id,
    role,
    permissions_snapshot: permissions,
    branch_id: branchId,
    ttl_seconds: input.ttlSeconds,
    metadata: input.metadata || {}
  });
  // Login audit/repair fields are best-effort. Authentication must never be
  // rejected because unrelated legacy profile data (such as phone) cannot be
  // normalized or because this secondary write fails.
  await patchIdentity(String(identity.id || ""), {
    last_login_at: new Date().toISOString(),
    ...(identityStatusShouldRepairOnLogin(identity) ? { status: "active" } : {})
  }).catch(() => null);
  await upsertDocument(String(organization.id || ""), "users", {
    id: String(userDocument.id || ""),
    data: {
      last_login_at: new Date().toISOString(),
      status: String(user.status || "") === "disabled" ? "disabled" : "active"
    },
    metadata: { login_touched_at: new Date().toISOString() }
  }, { replace: false }).catch(() => null);
  return await buildAuthContext(sessionId, session);
}

export async function buildAuthContext(sessionId: string, session: JsonObject): Promise<PlatformAuthContext> {
  const identityId = String(session.identity_id || "");
  const orgId = String(session.organization_id || "");
  const userId = String(session.user_id || "");
  const [identity, organization, userDocument] = await Promise.all([
    readIdentity(identityId),
    readOrganization(orgId),
    readDocument(orgId, "users", userId)
  ]);
  const user = asObject(userDocument.data);
  if (identityStatusBlocksLogin(identity)) throw unauthorized("identity_inactive", "This account is not active.");
  if (String(user.status || "active") === "disabled") throw forbidden("user_disabled", "This organization user is disabled.");
  const permissionState = orgUserPermissionState(user);
  return {
    sessionId,
    session,
    identity,
    organization,
    user,
    userDocument,
    orgId,
    userId,
    identityId,
    role: permissionState.level || String(session.role || "member"),
    branchId: String(user.branch_id || session.branch_id || "default"),
    permissions: permissionState.permissions || asObject(session.permissions_snapshot),
    csrfToken: String(session.csrf_token || "")
  };
}

export async function authContextFromRequest(request: FastifyRequest) {
  const candidates: Array<{ sessionId: string; session: JsonObject }> = [];
  for (const sessionId of platformSessionIdsFromRequest(request)) {
    try {
      candidates.push({ sessionId, session: await readAuthSession(sessionId) });
    } catch {
      // Another cookie with the same name may still contain an active session.
    }
  }
  const selected = selectNewestPlatformSessionCandidate(candidates);
  if (!selected) return null;
  const session = await touchAuthSession(selected.sessionId);
  return await buildAuthContext(selected.sessionId, session);
}

export function hasPermission(ctx: PlatformAuthContext, permission?: string) {
  if (!permission) return true;
  if (["owner", "admin", "super_admin"].includes(ctx.role)) return true;
  const permissions = ctx.permissions || {};
  if (permissions["*"] === true) return true;
  return String(permission).split("|").some((key) => permissions[key.trim()] === true);
}

export async function requirePlatformAuth(
  request: FastifyRequest,
  options: { orgId?: string; permission?: string; csrf?: boolean } = {}
) {
  const ctx = await authContextFromRequest(request);
  if (!ctx) throw unauthorized("authentication_required", "Authentication required.");
  if (options.orgId && options.orgId !== ctx.orgId) {
    throw forbidden("organization_forbidden", "This session cannot access the requested organization.");
  }
  if (!hasPermission(ctx, options.permission)) {
    throw forbidden("permission_denied", "This session does not have permission to perform this action.");
  }
  if (options.csrf) {
    const header = cleanText(request.headers["x-platform-csrf"] || request.headers["x-csrf-token"]);
    if (!ctx.csrfToken || header !== ctx.csrfToken) {
      throw forbidden("csrf_required", "A valid CSRF token is required.");
    }
  }
  return ctx;
}

export async function logoutPlatformSession(request: FastifyRequest, reply: FastifyReply) {
  const sessionId = platformSessionIdFromRequest(request);
  if (sessionId) await deleteAuthSession(sessionId);
  clearPlatformAuthCookies(request, reply);
}

export function platformAuthCookieNames() {
  return {
    session: env.platformSessionCookieName,
    csrf: CSRF_COOKIE_NAME
  };
}
