/**
 * Customer portal settings — the permission source for every customer-authored
 * action in the portal (uploads, comments, punch items, upsells, completion
 * signoff, messaging, guest sharing).
 *
 * Resolution is org default -> project override, merged per block, project
 * wins. Org defaults live on the `customer_portal` site record
 * (`settings.portal_defaults`); project overrides live on the `customer_portals`
 * record's `settings` object (which already round-trips through
 * ensureCustomerPortalRecord / updateCustomerPortalRecord).
 *
 * Contract: docs/customer-portal-v2-spec.md §5.
 *
 * Two invariants this file exists to enforce:
 *
 * 1. DEFAULT DENY. Every write capability defaults to false. An org that has
 *    never touched portal settings must behave exactly as it did before this
 *    module existed — no new customer-writable surface appears implicitly.
 *
 * 2. HARD CEILINGS. Numeric limits are clamped to the constants below. Org
 *    config can lower a limit but never raise it past the ceiling. The portal
 *    uuid is a bearer capability in a URL (it lands in browser history,
 *    referrer headers, forwarded email), so the blast radius of a leaked link
 *    is bounded here rather than at each call site.
 */

import type { JsonObject } from "./storage.js";

// --- Hard ceilings (org config may lower, never raise) ------------------------

/** Per-file upload ceiling. The checklist-evidence route allows 128 MB, which is
 *  fine for a staff-adjacent flow but not for an open portal surface. */
export const PORTAL_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Files a single portal may upload per rolling day. */
export const PORTAL_MAX_UPLOADS_PER_DAY = 50;
/** Characters in a customer comment. */
export const PORTAL_MAX_COMMENT_CHARS = 2000;
/** Customer-added punch items per project. */
export const PORTAL_MAX_PUNCH_ITEMS = 50;
/** Live guest links per portal. */
export const PORTAL_MAX_GUEST_LINKS = 20;
/** Guest link lifetime ceiling. */
export const PORTAL_MAX_GUEST_EXPIRY_DAYS = 365;
/** Customer writes per portal per minute (token bucket, enforced at the route). */
export const PORTAL_WRITE_RATE_PER_MINUTE = 20;

/** Upload MIME allowlist. Checked against the SNIFFED type, not the declared one. */
export const PORTAL_UPLOAD_MIME_ALLOWLIST = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
  "video/mp4", "video/quicktime", "video/webm",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain", "text/csv"
] as const;

export const PORTAL_SETTINGS_SCHEMA_VERSION = 1;

/**
 * Deterministic document id for a project's portal record.
 *
 * Lives here rather than in api.ts so portal_widgets.ts can read a portal record
 * without importing api.ts (which imports this module — that direction would be
 * a cycle). api.ts imports this one definition; there is no second copy.
 */
export function customerPortalDocumentId(projectId: string) {
  const id = String(projectId ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return id ? `customer_portal_${id}` : "";
}

// --- Local helpers (module-private; mirrors recurrence.ts conventions) --------

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * Tri-state boolean read. Returns undefined when the key is absent so a project
 * override of `false` is distinguishable from "not specified" — without this,
 * a project could never turn OFF something the org turned on.
 */
function optionalBool(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  const text = cleanText(value).toLowerCase();
  if (text === "true" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "no" || text === "off") return false;
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Layered boolean: project override wins, then org default, then `fallback`. */
function layeredBool(override: unknown, orgDefault: unknown, fallback: boolean) {
  const projectValue = optionalBool(override);
  if (projectValue !== undefined) return projectValue;
  const orgValue = optionalBool(orgDefault);
  if (orgValue !== undefined) return orgValue;
  return fallback;
}

/** Layered integer, clamped into [min, ceiling]. Ceiling is never exceeded. */
function layeredInt(override: unknown, orgDefault: unknown, fallback: number, min: number, ceiling: number) {
  const raw = optionalNumber(override) ?? optionalNumber(orgDefault) ?? fallback;
  return Math.max(min, Math.min(ceiling, Math.round(raw)));
}

function layeredEnum<T extends string>(override: unknown, orgDefault: unknown, allowed: readonly T[], fallback: T): T {
  const candidates = [cleanText(override).toLowerCase(), cleanText(orgDefault).toLowerCase()];
  for (const candidate of candidates) {
    if (candidate && (allowed as readonly string[]).includes(candidate)) return candidate as T;
  }
  return fallback;
}

// --- Resolved shape ----------------------------------------------------------

export type PortalSettings = {
  schema_version: number;
  uploads: {
    photos: boolean;
    documents: boolean;
    max_files: number;
    max_bytes: number;
    require_caption: boolean;
  };
  comments: { photos: boolean; documents: boolean };
  punch_list: {
    enabled: boolean;
    customer_can_add: boolean;
    max_items: number;
    require_photo: boolean;
    require_comment: boolean;
    require_signoff: boolean;
  };
  upsells: { enabled: boolean; require_signature: boolean; auto_accept_under_cents: number };
  completion: { signature_required: boolean; release_docs_on_signoff: boolean };
  messaging: { enabled: boolean; channel: "auto" | "chat" | "thread" };
  sharing: { enabled: boolean; max_guests: number; default_expires_days: number };
  social: { consent_requested: boolean };
  scheduling: { enabled: boolean; reschedule: boolean };
};

/**
 * Resolve effective portal settings.
 *
 * @param orgDefaults  customer_portal site `settings.portal_defaults`
 * @param projectOverride  `customer_portals` record `settings`
 */
export function normalizePortalSettings(orgDefaults: unknown, projectOverride: unknown): PortalSettings {
  const org = asObject(orgDefaults);
  const project = asObject(projectOverride);

  const orgUploads = asObject(org.uploads);
  const projectUploads = asObject(project.uploads);
  const orgComments = asObject(org.comments);
  const projectComments = asObject(project.comments);
  const orgPunch = asObject(org.punch_list);
  const projectPunch = asObject(project.punch_list);
  const orgUpsells = asObject(org.upsells);
  const projectUpsells = asObject(project.upsells);
  const orgCompletion = asObject(org.completion);
  const projectCompletion = asObject(project.completion);
  const orgMessaging = asObject(org.messaging);
  const projectMessaging = asObject(project.messaging);
  const orgSharing = asObject(org.sharing);
  const projectSharing = asObject(project.sharing);
  const orgSocial = asObject(org.social);
  const projectSocial = asObject(project.social);
  const orgScheduling = asObject(org.scheduling);
  const projectScheduling = asObject(project.scheduling);

  const punchEnabled = layeredBool(projectPunch.enabled, orgPunch.enabled, false);
  const sharingEnabled = layeredBool(projectSharing.enabled, orgSharing.enabled, false);
  const upsellsEnabled = layeredBool(projectUpsells.enabled, orgUpsells.enabled, false);

  return {
    schema_version: PORTAL_SETTINGS_SCHEMA_VERSION,
    uploads: {
      photos: layeredBool(projectUploads.photos, orgUploads.photos, false),
      documents: layeredBool(projectUploads.documents, orgUploads.documents, false),
      max_files: layeredInt(projectUploads.max_files, orgUploads.max_files, PORTAL_MAX_UPLOADS_PER_DAY, 1, PORTAL_MAX_UPLOADS_PER_DAY),
      max_bytes: layeredInt(projectUploads.max_bytes, orgUploads.max_bytes, PORTAL_MAX_UPLOAD_BYTES, 1024, PORTAL_MAX_UPLOAD_BYTES),
      require_caption: layeredBool(projectUploads.require_caption, orgUploads.require_caption, false)
    },
    comments: {
      photos: layeredBool(projectComments.photos, orgComments.photos, false),
      documents: layeredBool(projectComments.documents, orgComments.documents, false)
    },
    punch_list: {
      enabled: punchEnabled,
      // Sub-flags collapse to false when the parent is off so a caller can read
      // one field instead of remembering to && the parent every time.
      customer_can_add: punchEnabled && layeredBool(projectPunch.customer_can_add, orgPunch.customer_can_add, false),
      max_items: layeredInt(projectPunch.max_items, orgPunch.max_items, 10, 1, PORTAL_MAX_PUNCH_ITEMS),
      require_photo: punchEnabled && layeredBool(projectPunch.require_photo, orgPunch.require_photo, false),
      require_comment: punchEnabled && layeredBool(projectPunch.require_comment, orgPunch.require_comment, false),
      require_signoff: punchEnabled && layeredBool(projectPunch.require_signoff, orgPunch.require_signoff, false)
    },
    upsells: {
      enabled: upsellsEnabled,
      require_signature: upsellsEnabled && layeredBool(projectUpsells.require_signature, orgUpsells.require_signature, false),
      // 0 = never auto-accept. Clamped so a typo can't authorize a large change
      // without an explicit customer action.
      auto_accept_under_cents: upsellsEnabled
        ? layeredInt(projectUpsells.auto_accept_under_cents, orgUpsells.auto_accept_under_cents, 0, 0, 100_000)
        : 0
    },
    completion: {
      signature_required: layeredBool(projectCompletion.signature_required, orgCompletion.signature_required, true),
      release_docs_on_signoff: layeredBool(projectCompletion.release_docs_on_signoff, orgCompletion.release_docs_on_signoff, false)
    },
    messaging: {
      enabled: layeredBool(projectMessaging.enabled, orgMessaging.enabled, false),
      channel: layeredEnum(projectMessaging.channel, orgMessaging.channel, ["auto", "chat", "thread"] as const, "auto")
    },
    sharing: {
      enabled: sharingEnabled,
      max_guests: layeredInt(projectSharing.max_guests, orgSharing.max_guests, 5, 1, PORTAL_MAX_GUEST_LINKS),
      default_expires_days: layeredInt(projectSharing.default_expires_days, orgSharing.default_expires_days, 30, 1, PORTAL_MAX_GUEST_EXPIRY_DAYS)
    },
    social: {
      consent_requested: layeredBool(projectSocial.consent_requested, orgSocial.consent_requested, false)
    },
    scheduling: {
      enabled: layeredBool(projectScheduling.enabled, orgScheduling.enabled, false),
      reschedule: layeredBool(projectScheduling.reschedule, orgScheduling.reschedule, false)
    }
  };
}

/**
 * Whether any customer-write surface is on. Used to decide if the portal
 * payload needs to carry the write-action affordances at all.
 */
export function portalHasCustomerWrites(settings: PortalSettings) {
  return settings.uploads.photos
    || settings.uploads.documents
    || settings.comments.photos
    || settings.comments.documents
    || settings.punch_list.enabled
    || settings.upsells.enabled
    || settings.messaging.enabled
    || settings.sharing.enabled
    || settings.scheduling.enabled;
}

/**
 * Client-safe projection. The portal client needs to know which affordances to
 * render; it must never be the thing that decides whether a write is allowed —
 * every route re-checks the resolved settings server-side.
 */
export function publicPortalSettings(settings: PortalSettings): JsonObject {
  return {
    uploads: {
      photos: settings.uploads.photos,
      documents: settings.uploads.documents,
      max_files: settings.uploads.max_files,
      max_bytes: settings.uploads.max_bytes,
      require_caption: settings.uploads.require_caption
    },
    comments: { ...settings.comments },
    punch_list: { ...settings.punch_list },
    upsells: {
      enabled: settings.upsells.enabled,
      require_signature: settings.upsells.require_signature
    },
    completion: { ...settings.completion },
    messaging: { ...settings.messaging },
    sharing: {
      enabled: settings.sharing.enabled,
      max_guests: settings.sharing.max_guests,
      default_expires_days: settings.sharing.default_expires_days
    },
    social: { ...settings.social },
    scheduling: { ...settings.scheduling }
  };
}
