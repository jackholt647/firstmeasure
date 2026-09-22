import { routeNeedsExpandedPlatform } from "./rollout_routes.js";

import { findIdentityByIdentifier, readAuthSession } from "./storage.js";

type VerifiedLoginInput = {
  identity: JsonObject;
  organizationId?: string;
  ttlSeconds?: number;
  metadata?: JsonObject;
};

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
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../src/config/env.js";
import "./capability_defs.js";
import { capabilityDefinition, effectiveCapabilities, type CapabilityResolution } from "./capabilities.js";
import { forbidden, unauthorized } from "./errors.js";
import {
  MANAGEMENT_APPLICATION_ID,
  organizationUserProfileView,
  type ApplicationAccess
} from "./user_profile.js";
import { resolveAccessProfile, type ResolvedAccessProfile } from "../workforce/access.js";
import {
  createAuthSession,
  createAccountDevice,
  deleteAccountDevice,
  deleteAuthSession,
  findIdentityByEmail,
  listIdentityMemberships,
  patchIdentity,
  readAccountDevice,
  readDocument,
  readIdentity,
  readOrganization,
  touchAuthSession,
  rotateAuthSessionCsrf,
  saveAccountDevice,
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
  applicationAccess: ApplicationAccess;
  accessProfile?: ResolvedAccessProfile;
  appEntitlements?: ResolvedAccessProfile["app_entitlements"];
  csrfToken: string;
  capabilities?: CapabilityResolution;
};

type LoginInput = {
  identifier?: string;
  email?: string;
  password: string;
  organizationId?: string;
  ttlSeconds?: number;
  metadata?: JsonObject;
};

const CSRF_COOKIE_NAME = `${env.platformSessionCookieName}_csrf`;
const ACCOUNT_DEVICE_COOKIE_NAME = `${env.platformSessionCookieName}_accounts`;
const MAX_REMEMBERED_ACCOUNTS = 10;

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

function accountIdFor(session: JsonObject) {
  const value = [session.identity_id, session.organization_id, session.user_id].map((item) => cleanText(item)).join(":");
  return `account_${createHash("sha256").update(value).digest("base64url").slice(0, 24)}`;
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

export function platformAccountDeviceIdFromRequest(request: FastifyRequest) {
  const cookies = parseCookies(request.headers.cookie);
  return verifySignedCookie(cookies[ACCOUNT_DEVICE_COOKIE_NAME] || "");
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

function appendSetCookie(reply: FastifyReply, value: string) {
  const current = reply.getHeader("Set-Cookie");
  const values = Array.isArray(current) ? current.map(String) : current ? [String(current)] : [];
  reply.header("Set-Cookie", [...values, value]);
}

function setAccountDeviceCookie(request: FastifyRequest, reply: FastifyReply, deviceId: string, ttlSeconds = env.platformSessionTtlSeconds) {
  appendSetCookie(reply, `${ACCOUNT_DEVICE_COOKIE_NAME}=${encodeURIComponent(signedCookieValue(deviceId))}; ${cookieOptions(request, ttlSeconds)}`);
}

export function clearPlatformAccountDeviceCookie(request: FastifyRequest, reply: FastifyReply) {
  appendSetCookie(reply, `${ACCOUNT_DEVICE_COOKIE_NAME}=; ${cookieOptions(request, 0)}`);
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

function sanitizeUser(userDoc: JsonObject, accessProfile?: ResolvedAccessProfile) {
  const data = asObject(userDoc.data);
  const publicData = { ...data };
  delete publicData.user_type_ids;
  delete publicData.user_types;
  delete publicData.classification_ids;
  const permissionState = orgUserPermissionState(data);
  const effectivePermissions = accessProfile?.effective_permissions || permissionState.permissions;
  return {
    id: userDoc.id,
    ...publicData,
    ...organizationUserProfileView(data),
    permissions: effectivePermissions,
    org_permissions: {
      level: permissionState.level,
      items: permissionState.items
    },
    effective_permissions: effectivePermissions,
    disabled: String(data.status || "active") === "disabled"
  };
}

export function publicAuthContext(ctx: PlatformAuthContext) {
  const metadata = asObject(ctx.session.metadata);
  const impersonatedByEmail = cleanText(metadata.impersonated_by_email);
  const accessProfile = ctx.accessProfile;
  const appEntitlements = ctx.appEntitlements || accessProfile?.app_entitlements;
  return {
    authenticated: true,
    platform_expanded_access: ctx.capabilities?.effectiveByKey["platform.expanded_access"] === true,
    identity: publicIdentity(ctx.identity),
    organization: ctx.organization,
    user: sanitizeUser(ctx.userDocument, ctx.accessProfile),
    membership: {
      organization_id: ctx.orgId,
      user_id: ctx.userId,
      role: ctx.role,
      branch_id: ctx.branchId,
      permissions: ctx.permissions,
      application_access: ctx.applicationAccess,
      access_role_ids: accessProfile?.access_role_ids || [],
      app_entitlements: appEntitlements
    },
    access_profile: accessProfile,
    app_entitlements: appEntitlements,
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

function accountEntries(value: unknown) {
  return Array.isArray(value) ? value.map(asObject).filter((entry) => (
    cleanText(entry.account_id) && cleanText(entry.session_id)
  )) : [];
}

function rememberedAccount(ctx: PlatformAuthContext) {
  return {
    account_id: accountIdFor(ctx.session),
    session_id: ctx.sessionId,
    identity_id: ctx.identityId,
    organization_id: ctx.orgId,
    user_id: ctx.userId,
    email: cleanText(ctx.identity.email || ctx.user.email).toLowerCase(),
    name: cleanText(ctx.identity.name || ctx.user.name || ctx.identity.email),
    organization_name: cleanText(ctx.organization.name),
    added_at: new Date().toISOString(),
    last_used_at: new Date().toISOString()
  };
}

function refreshRememberedAccount(entry: JsonObject, ctx: PlatformAuthContext) {
  const live = rememberedAccount(ctx);
  return {
    ...entry,
    account_id: live.account_id,
    session_id: live.session_id,
    identity_id: live.identity_id,
    organization_id: live.organization_id,
    user_id: live.user_id,
    email: live.email,
    name: live.name,
    organization_name: live.organization_name,
    added_at: cleanText(entry.added_at) || live.added_at,
    last_used_at: cleanText(entry.last_used_at) || live.last_used_at
  };
}

function rememberedAccountProfileChanged(before: JsonObject, after: JsonObject) {
  return ["identity_id", "organization_id", "user_id", "email", "name", "organization_name"]
    .some((key) => cleanText(before[key]) !== cleanText(after[key]));
}

/** Remember the current authenticated account for this browser without exposing its session id to client code. */
export async function rememberPlatformAccount(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: PlatformAuthContext,
  preferredDeviceId?: string
) {
  let deviceId = cleanText(preferredDeviceId) || platformAccountDeviceIdFromRequest(request);
  let device = deviceId ? await readAccountDevice(deviceId).catch(() => null) : null;
  if (!device || !deviceId) {
    const created = await createAccountDevice({
      metadata: { user_agent: String(request.headers["user-agent"] || "") }
    });
    deviceId = created.deviceId;
    device = created.record;
    setAccountDeviceCookie(request, reply, deviceId);
  }

  const current = rememberedAccount(ctx);
  const currentAccountId = cleanText(current.account_id);
  // Keep expired entries. They are a useful account picker and deliberately
  // lead to the normal sign-in flow instead of disappearing from this browser.
  const existing = accountEntries(device.accounts);
  const replaced = existing.filter((entry) => cleanText(entry.account_id) === currentAccountId && cleanText(entry.session_id) !== ctx.sessionId);
  await Promise.all(replaced.map((entry) => deleteAuthSession(cleanText(entry.session_id)).catch(() => null)));
  const accounts = [
    current,
    ...existing.filter((entry) => cleanText(entry.account_id) !== currentAccountId)
  ].slice(0, MAX_REMEMBERED_ACCOUNTS);
  await saveAccountDevice(deviceId, { accounts });
  return { deviceId, accounts };
}

export async function listRememberedPlatformAccounts(request: FastifyRequest, ctx: PlatformAuthContext) {
  const deviceId = platformAccountDeviceIdFromRequest(request);
  if (!deviceId) return [];
  const device = await readAccountDevice(deviceId).catch(() => null);
  if (!device) return [];
  const activeId = accountIdFor(ctx.session);
  const accounts = accountEntries(device.accounts);
  let profileChanged = false;
  const refreshedAccounts = accounts.map((entry) => {
    if (cleanText(entry.account_id) !== activeId) return entry;
    const refreshed = refreshRememberedAccount(entry, ctx);
    profileChanged = profileChanged || rememberedAccountProfileChanged(entry, refreshed);
    return refreshed;
  });
  if (profileChanged) await saveAccountDevice(deviceId, { accounts: refreshedAccounts });
  return refreshedAccounts.map((entry) => ({
    account_id: cleanText(entry.account_id),
    email: cleanText(entry.email),
    name: cleanText(entry.name),
    organization_name: cleanText(entry.organization_name),
    active: cleanText(entry.account_id) === activeId,
    // Session liveness is verified only when the user actually switches. This
    // keeps the picker a single lightweight record read and preserves expired
    // accounts as sign-in-again choices.
    session_state: "unknown",
    last_used_at: cleanText(entry.last_used_at)
  }));
}

export async function switchRememberedPlatformAccount(request: FastifyRequest, reply: FastifyReply, accountId: string) {
  const deviceId = platformAccountDeviceIdFromRequest(request);
  if (!deviceId) throw unauthorized("account_device_required", "No remembered accounts are available in this browser.");
  const device = await readAccountDevice(deviceId).catch(() => null);
  if (!device) throw unauthorized("account_device_required", "No remembered accounts are available in this browser.");
  const accounts = accountEntries(device.accounts);
  const selected = accounts.find((entry) => cleanText(entry.account_id) === cleanText(accountId));
  if (!selected) {
    throw unauthorized("remembered_account_unavailable", "That remembered account is no longer available.");
  }
  const sessionId = cleanText(selected.session_id);
  let session: JsonObject;
  try {
    session = await rotateAuthSessionCsrf(sessionId);
  } catch {
    throw unauthorized("remembered_account_expired", "Please sign in again to continue with this account.");
  }
  const ctx = await buildAuthContext(sessionId, session);
  const now = new Date().toISOString();
  const nextAccounts = accounts.map((entry) => cleanText(entry.account_id) === cleanText(accountId)
    ? { ...refreshRememberedAccount(entry, ctx), last_used_at: now }
    : entry);
  await saveAccountDevice(deviceId, { accounts: nextAccounts });
  setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
  return ctx;
}

export async function removeRememberedPlatformAccount(request: FastifyRequest, reply: FastifyReply, accountId: string) {
  const deviceId = platformAccountDeviceIdFromRequest(request);
  if (!deviceId) throw unauthorized("account_device_required", "No remembered accounts are available in this browser.");
  const device = await readAccountDevice(deviceId).catch(() => null);
  if (!device) throw unauthorized("account_device_required", "No remembered accounts are available in this browser.");
  const accounts = accountEntries(device.accounts);
  const selected = accounts.find((entry) => cleanText(entry.account_id) === cleanText(accountId));
  if (!selected) throw unauthorized("remembered_account_unavailable", "That remembered account is no longer available.");
  await deleteAuthSession(cleanText(selected.session_id));
  await saveAccountDevice(deviceId, { accounts: accounts.filter((entry) => entry !== selected) });
  if (cleanText(selected.session_id) === platformSessionIdFromRequest(request)) clearPlatformAuthCookies(request, reply);
}

export async function logoutAllRememberedPlatformAccounts(request: FastifyRequest, reply: FastifyReply) {
  const currentSessionId = platformSessionIdFromRequest(request);
  const deviceId = platformAccountDeviceIdFromRequest(request);
  const device = deviceId ? await readAccountDevice(deviceId).catch(() => null) : null;
  const sessionIds = new Set(accountEntries(device?.accounts).map((entry) => cleanText(entry.session_id)).filter(Boolean));
  if (currentSessionId) sessionIds.add(currentSessionId);
  await Promise.all([...sessionIds].map((sessionId) => deleteAuthSession(sessionId).catch(() => null)));
  if (deviceId) await deleteAccountDevice(deviceId);
  clearPlatformAuthCookies(request, reply);
  clearPlatformAccountDeviceCookie(request, reply);
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
  const capabilities = await effectiveCapabilities(orgId, userId);
  const accessProfile = capabilities.effectiveByKey["platform.expanded_access"] === true
    ? (await resolveAccessProfile(orgId, { ...userDocument, data: user }))
    : undefined;
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
    permissions: accessProfile?.effective_permissions || permissionState.permissions || asObject(session.permissions_snapshot),
    applicationAccess: accessProfile?.application_access || { management: { enabled: true, role_id: permissionState.level, permissions: permissionState.permissions || {} }, field: { enabled: false, role_id: "", permissions: {} } },
    accessProfile,
    capabilities,
    appEntitlements: accessProfile?.app_entitlements,
    csrfToken: String(session.csrf_token || "")
  };
}

/** Durable jobs retain their author, but recheck today's membership and permissions. */
export async function backgroundAuthContext(orgId: string, userId: string) {
  const user = await readDocument(orgId, "users", userId);
  const identityId = cleanText(asObject(user.data).identity_id);
  if (!identityId) throw forbidden("background_author_unavailable", "The task author has no active account.");
  const identity = await readIdentity(identityId);
  const memberships = Array.isArray(identity.memberships) ? identity.memberships : [];
  if (!memberships.some(value => {
    const member = asObject(value);
    return member.organization_id === orgId && member.user_id === userId && !["disabled", "removed", "inactive"].includes(cleanText(member.status));
  })) throw forbidden("background_author_unavailable", "The task author no longer belongs to this organization.");
  return buildAuthContext("", { identity_id: identityId, organization_id: orgId, user_id: userId });
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

/**
 * The unified gate. Evaluates a capability-registry key against the org's
 * effective capability values and, for permission nodes, the user's effective
 * permissions. One call answers "is this feature on for this org AND may this
 * user act on it" — new code should prefer this over pairing
 * isAppFlagEnabled() with hasPermission() by hand.
 */
export async function can(ctx: PlatformAuthContext, capabilityKey: string) {
  const node = capabilityDefinition(capabilityKey);
  if (!node) return false;
  const resolution = ctx.capabilities || await effectiveCapabilities(ctx.orgId, ctx.userId);
  if (resolution.effectiveByKey[node.key] !== true) return false;
  if (node.kind === "permission") return hasPermission(ctx, node.permission_key);
  return true;
}

export async function requireCapability(ctx: PlatformAuthContext, capabilityKey: string) {
  if (!(await can(ctx, capabilityKey))) {
    throw forbidden("capability_denied", `The "${capabilityKey}" capability is not available to this user.`);
  }
  return ctx;
}

function canonicalApplicationId(value: unknown) {
  const id = cleanText(value).toLowerCase();
  if (["main", "portal"].includes(id)) return MANAGEMENT_APPLICATION_ID;
  if (["crew", "workforce"].includes(id)) return "field";
  return id;
}

function contextHasApplicationAccess(ctx: PlatformAuthContext, applicationIdValue: string, permission?: string) {
  const applicationId = canonicalApplicationId(applicationIdValue);
  const entry = ctx.applicationAccess[applicationId];
  if (!entry?.enabled) return false;
  if (!permission) return true;
  return cleanText(permission).split("|").some((key) => {
    const item = key.trim();
    return entry.permissions[item] === true || (entry.permissions[item] !== false && entry.permissions["*"] === true);
  });
}

export async function requirePlatformAuth(
  request: FastifyRequest,
  options: {
    orgId?: string;
    permission?: string;
    csrf?: boolean;
    application?: false | string | string[];
    applicationPermission?: string;
    /** Capability-registry key; enforced via can() after permission checks. */
    capability?: string;
  } = {}
) {
  const ctx = await authContextFromRequest(request);
  if (!ctx) throw unauthorized("authentication_required", "Authentication required.");
  if (options.orgId && options.orgId !== ctx.orgId) {
    throw forbidden("organization_forbidden", "This session cannot access the requested organization.");
  }
  const requestedApplications = options.application === false
    ? []
    : Array.isArray(options.application)
      ? options.application
      : [options.application || MANAGEMENT_APPLICATION_ID];
  if (requestedApplications.length && !requestedApplications.some((applicationId) => (
    contextHasApplicationAccess(ctx, applicationId, options.applicationPermission)
  ))) {
    throw forbidden("application_access_denied", "This user does not have access to the requested application.");
  }
  if (!hasPermission(ctx, options.permission)) {
    throw forbidden("permission_denied", "This session does not have permission to perform this action.");
  }
  if (routeNeedsExpandedPlatform(request.routeOptions.url || request.url.split("?")[0] || "", request.params)) {
    await requireCapability(ctx, "platform.expanded_access");
  }
  if (options.capability) await requireCapability(ctx, options.capability);
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
    csrf: CSRF_COOKIE_NAME,
    account_device: ACCOUNT_DEVICE_COOKIE_NAME
  };
}
