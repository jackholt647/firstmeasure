/**
 * Who may do what through the customer portal action endpoint
 * (`POST /v1/platform/portal-action`; docs/architecture/request-security.md).
 *
 * The endpoint authenticates the session; these rules then decide, per action,
 * whether this member may act. They read FirstMeasure's seven permissions
 * through `hasPermission`, so an owner or administrator without expanded
 * access keeps holding all of them, as before.
 */
import type { FastifyRequest } from "fastify";
import { env } from "../src/config/env.js";
import { hasPermission, type PlatformAuthContext } from "./auth.js";
import { badRequest, forbidden } from "./errors.js";

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function requirePortalPermission(auth: PlatformAuthContext, permission: string) {
  if (!hasPermission(auth, permission)) {
    throw forbidden("permission_denied", "This session does not have permission to perform this action.");
  }
}

/** The permission each portal action needs; actions not listed need only a signed-in member. */
export const PORTAL_ACTION_PERMISSIONS: Record<string, string> = {
  get_credits: "order_reports|manage_billing",
  org_update_my_report_settings: "manage_report_settings",
  org_update_my_billing: "manage_billing",
  org_billing_history_my: "manage_billing",
  org_monthly_statement: "manage_billing",
  stripe_create_checkout: "manage_billing",
  stripe_fulfill_session: "manage_billing",
  billing_autotopup_setup_start: "manage_billing",
  billing_autotopup_setup_finish: "manage_billing",
  org_upload_logo_my: "manage_company_settings",
  org_users_add_my: "manage_company_users",
  org_users_set_disabled_my: "manage_company_users",
  org_users_delete_my: "manage_company_users",
  org_users_set_perms_my: "manage_company_user_permissions",
  scrape_logos: "manage_company_settings",
  queue: "order_reports",
  expedite_queued_report: "order_reports",
  cancel_queued_report: "order_reports",
  submit_report_rework_request: "order_reports",
  refund_instant_rejection: "order_reports",
  pj_search: "view_reports|order_reports"
};

const OWNER_LEVELS = new Set(["owner", "super_admin"]);
const KNOWN_LEVELS = new Set(["viewer", "manager", "admin", "owner", "super_admin", "custom"]);
/** Levels a user manager may give without managing permissions. */
const ORDINARY_LEVELS = new Set(["viewer", "manager"]);

export function portalLevelOf(userData: Json) {
  const permissions = object(userData.org_permissions);
  return text(permissions.level || userData.org_permission_level || userData.permission_level || userData.role || "viewer").toLowerCase() || "viewer";
}

export function callerIsOwner(auth: PlatformAuthContext) {
  return OWNER_LEVELS.has(text(auth.role).toLowerCase());
}

/** Only an owner may change, disable or remove an owner. */
export function assertMayManageUser(auth: PlatformAuthContext, targetData: Json) {
  if (OWNER_LEVELS.has(portalLevelOf(targetData)) && !callerIsOwner(auth)) {
    throw forbidden("owner_protected", "Only an owner can change an owner's account.");
  }
}

function trueKeys(value: Json) {
  return Object.entries(value).filter(([, granted]) => granted === true).map(([key]) => key);
}

/**
 * Whether this caller may give `level` plus `items` (as `effective` grants).
 * Giving anything beyond an ordinary level, or any individual flag, needs
 * `manage_company_user_permissions`; nobody gives a permission they do not
 * hold, and only an owner makes an owner or grants everything (`*`).
 */
export function assertMayGrantPortalAccess(auth: PlatformAuthContext, levelValue: unknown, items: Json, effective: Json) {
  const level = text(levelValue).toLowerCase() || "viewer";
  if (!KNOWN_LEVELS.has(level)) throw badRequest("invalid_permission_level", "Choose a valid permission level.");
  const flags = trueKeys(items);
  if (!ORDINARY_LEVELS.has(level) || flags.length) requirePortalPermission(auth, "manage_company_user_permissions");
  const callerLevel = text(auth.role).toLowerCase();
  if (level === "super_admin" && callerLevel !== "super_admin") throw forbidden("permission_level_forbidden", "You cannot grant a level above your own.");
  if ((OWNER_LEVELS.has(level) || effective["*"] === true) && !callerIsOwner(auth)) {
    throw forbidden("permission_level_forbidden", "Only an owner can make another owner.");
  }
  for (const key of trueKeys(effective)) {
    if (key === "*") continue;
    if (!hasPermission(auth, key)) throw forbidden("permission_level_forbidden", "You cannot grant a permission you do not hold.");
  }
}

/** Fields of a user record that grant access; only a permissions manager sets them, and never on themselves. */
export const USER_ACCESS_FIELDS = ["access_role_ids", "access_roles", "permission_overrides", "app_access_overrides", "app_entitlement_overrides"];

export function assertMayChangeUserAccessFields(auth: PlatformAuthContext, body: Json, self: boolean) {
  const touched = USER_ACCESS_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (!touched.length) return;
  if (self) throw forbidden("self_permission_change_forbidden", "You cannot change your own organization permissions.");
  requirePortalPermission(auth, "manage_company_user_permissions");
  const overrides = object(typeof body.permission_overrides === "string" ? safeJson(body.permission_overrides) : body.permission_overrides);
  for (const key of trueKeys(overrides)) {
    if (key === "*" ? !callerIsOwner(auth) : !hasPermission(auth, key)) {
      throw forbidden("permission_level_forbidden", "You cannot grant a permission you do not hold.");
    }
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function moneyField(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 50_000) throw badRequest("invalid_billing_amount", "Enter an amount between 0 and 50,000.");
  return Math.round(amount * 100) / 100;
}

/**
 * The billing settings a customer may change: the auto top-up switch and its
 * two amounts. Stripe customer and payment-method ids, status and events are
 * written only by the Stripe flows.
 */
export function customerBillingPatch(raw: unknown) {
  const input = object(raw);
  const autoTopup = object(input.auto_topup);
  const patch: Json = {};
  if ("enabled" in autoTopup) patch.enabled = autoTopup.enabled === true || /^(1|true|yes|on)$/i.test(text(autoTopup.enabled));
  if ("threshold_dollars" in autoTopup) patch.threshold_dollars = moneyField(autoTopup.threshold_dollars);
  if ("topup_dollars" in autoTopup) patch.topup_dollars = moneyField(autoTopup.topup_dollars);
  return Object.keys(patch).length ? { auto_topup: patch } : {};
}

/**
 * Keys of a report order that only the platform writes. An order's body is
 * otherwise passed to FirstMeasure as the customer sent it, under the system
 * principal, so these never come from the client.
 */
const SERVER_OWNED_ORDER_KEYS = new Set([
  "actor", "actor_email", "actor_name", "actor_org_id", "actor_role", "actor_team_id", "user_email", "user_name",
  "organization", "organization_id", "org_id", "organization_ref", "owner_email",
  "id", "folder", "project_id", "measurement_project_id",
  "status", "instant_status", "instant_rejection_reason", "workflow", "timestamps", "history",
  "amount_charged", "report_original_amount", "report_discount_amount", "report_expedite_coupon_applied", "report_currency",
  "charge_token", "billing", "credits", "is_vip", "process_async", "instant_url",
  "report_change_requests", "latest_report_change_request", "cancellation", "assigned_to", "assigned_at", "reserved_to", "reserved_at",
  "created_at", "updated_at", "completed_at", "delivered_at", "deleted", "archived"
]);
const SERVER_OWNED_ORDER_PREFIXES = ["refund_", "cancellation_", "cancelled_", "expedite_upgrade", "qa_", "payout", "delivery_", "rework_", "__"];

export function customerOrderInput(body: Json) {
  const result: Json = {};
  for (const [key, value] of Object.entries(body)) {
    const lower = key.toLowerCase();
    if (SERVER_OWNED_ORDER_KEYS.has(lower)) continue;
    if (SERVER_OWNED_ORDER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    result[key] = value;
  }
  return result;
}

function header(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return text(Array.isArray(value) ? value[0] : value);
}

/**
 * A request made on this machine to a non-production server: the socket is
 * loopback and no proxy forwarded it. Host, Origin, Referer and forwarded
 * headers are chosen by the client and prove nothing.
 */
export function isLoopbackDevelopmentRequest(request?: FastifyRequest) {
  if (!request || env.isProduction) return false;
  if (header(request, "x-forwarded-for") || header(request, "forwarded") || header(request, "x-real-ip")) return false;
  const address = text(request.socket?.remoteAddress).toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
