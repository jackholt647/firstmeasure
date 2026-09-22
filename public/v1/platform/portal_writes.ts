/**
 * Customer-authored writes from the customer portal.
 *
 * Contract: docs/customer-portal-v2-spec.md §5.2–5.4.
 *
 * THREAT MODEL (§5.4). The portal uuid is a bearer capability in a URL. It
 * lands in browser history, referrer headers, and forwarded email. Everything
 * here is written on the assumption that whoever holds the link is *probably*
 * the customer but might not be. Therefore:
 *
 *   - Every write is ADDITIVE and REVERSIBLE. Nothing in this module deletes
 *     project data, alters a price, or modifies anything the business authored.
 *   - "Removing" a customer upload or comment WITHDRAWS it from view
 *     (`withdrawn_at`); the bytes and the audit row survive. A bearer token
 *     must never be able to destroy evidence.
 *   - Uploads are validated on their SNIFFED type, never the declared one.
 *   - Every entry point is rate limited per portal.
 *
 * All customer-authored content lives on the `customer_portals` record rather
 * than on media metadata or the project, so it stays adjacent to the settings
 * that authorize it and can never be mistaken for business-authored content.
 */

import { badRequest, forbidden, notFound } from "./errors.js";
import {
  normalizePortalSettings,
  PORTAL_MAX_COMMENT_CHARS,
  PORTAL_WRITE_RATE_PER_MINUTE,
  type PortalSettings
} from "./portal_settings.js";
import type { JsonObject } from "./storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * In-process token bucket keyed by portal uuid. Deliberately simple: this is an
 * abuse ceiling, not a billing meter, and a per-process bucket is the right
 * amount of machinery for "one leaked link cannot upload ten thousand files".
 */
const buckets = new Map<string, { tokens: number; refilledAt: number }>();

export function consumePortalWriteToken(portalUuid: string, cost = 1) {
  const key = cleanText(portalUuid);
  if (!key) return false;
  const now = Date.now();
  const bucket = buckets.get(key) || { tokens: PORTAL_WRITE_RATE_PER_MINUTE, refilledAt: now };
  const elapsedMinutes = (now - bucket.refilledAt) / 60_000;
  if (elapsedMinutes > 0) {
    bucket.tokens = Math.min(PORTAL_WRITE_RATE_PER_MINUTE, bucket.tokens + elapsedMinutes * PORTAL_WRITE_RATE_PER_MINUTE);
    bucket.refilledAt = now;
  }
  if (bucket.tokens < cost) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= cost;
  buckets.set(key, bucket);
  return true;
}

/** Test seam — the bucket is process-global and would otherwise leak between cases. */
export function resetPortalWriteLimits() {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------

/**
 * Sniff a file's real type from its leading bytes.
 *
 * A client-declared Content-Type is attacker-controlled: an .html payload
 * announced as image/png would otherwise be stored and later served back. We
 * only accept types we can positively identify from magic bytes.
 *
 * Returns "" when the type cannot be identified, which callers treat as reject.
 */
export function sniffUploadMime(bytes: Buffer): string {
  if (!bytes || bytes.length < 12) return "";
  const hex = bytes.subarray(0, 12).toString("hex").toLowerCase();
  const ascii = bytes.subarray(0, 12).toString("latin1");

  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (hex.startsWith("47494638")) return "image/gif";
  if (ascii.startsWith("RIFF") && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (hex.startsWith("25504446")) return "application/pdf";

  // ISO-BMFF family: 4-byte size, then "ftyp", then a brand.
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1").toLowerCase();
    if (brand.startsWith("qt")) return "video/quicktime";
    if (brand.startsWith("heic") || brand.startsWith("heif") || brand.startsWith("mif1")) return "image/heic";
    return "video/mp4";
  }
  // Matroska / WebM.
  if (hex.startsWith("1a45dfa3")) return "video/webm";
  // ZIP container — the transport for modern Office documents.
  if (hex.startsWith("504b0304") || hex.startsWith("504b0506") || hex.startsWith("504b0708")) return "application/zip";
  // Legacy OLE compound file (.doc/.xls).
  if (hex.startsWith("d0cf11e0a1b11ae1")) return "application/x-ole-storage";
  return "";
}

const SNIFFED_KIND: Record<string, "photo" | "video" | "document"> = {
  "image/jpeg": "photo",
  "image/png": "photo",
  "image/gif": "photo",
  "image/webp": "photo",
  "image/heic": "photo",
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "application/pdf": "document",
  "application/zip": "document",
  "application/x-ole-storage": "document"
};

export type ValidatedUpload = { contentType: string; kind: "photo" | "video" | "document" };

/**
 * Validate an upload against the resolved settings. Throws a PlatformError with
 * a specific code on every rejection path so the client can explain itself.
 */
export function validatePortalUpload(bytes: Buffer, settings: PortalSettings): ValidatedUpload {
  if (!bytes || !bytes.length) throw badRequest("portal_upload_empty", "Choose a file to upload.");
  if (bytes.length > settings.uploads.max_bytes) {
    const megabytes = Math.floor(settings.uploads.max_bytes / (1024 * 1024));
    throw badRequest("portal_upload_too_large", `Uploads cannot exceed ${megabytes} MB.`);
  }
  const contentType = sniffUploadMime(bytes);
  if (!contentType) {
    throw badRequest("portal_upload_unsupported", "That file type is not supported.");
  }
  const kind = SNIFFED_KIND[contentType];
  if (!kind) throw badRequest("portal_upload_unsupported", "That file type is not supported.");

  // Photos/videos and documents are separately permissioned: an org that wants
  // job photos from customers has not thereby agreed to accept arbitrary files.
  if ((kind === "photo" || kind === "video") && !settings.uploads.photos) {
    throw forbidden("portal_uploads_disabled", "Photo uploads are not enabled for this portal.");
  }
  if (kind === "document" && !settings.uploads.documents) {
    throw forbidden("portal_uploads_disabled", "Document uploads are not enabled for this portal.");
  }
  return { contentType, kind };
}

// ---------------------------------------------------------------------------
// Portal record shapes
// ---------------------------------------------------------------------------

export type PortalUploadEntry = {
  media_id: string;
  kind: string;
  caption: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string;
  withdrawn_at: string;
};

export type PortalCommentEntry = {
  id: string;
  media_id: string;
  body: string;
  author: string;
  created_at: string;
  withdrawn_at: string;
};

export function normalizePortalUploads(value: unknown): PortalUploadEntry[] {
  return asArray(value).map((entry) => {
    const upload = asObject(entry);
    return {
      media_id: cleanText(upload.media_id),
      kind: cleanText(upload.kind) || "document",
      caption: cleanText(upload.caption).slice(0, 500),
      file_name: cleanText(upload.file_name),
      content_type: cleanText(upload.content_type),
      size_bytes: Number(upload.size_bytes) || 0,
      uploaded_at: cleanText(upload.uploaded_at),
      uploaded_by: cleanText(upload.uploaded_by) || "customer_portal",
      withdrawn_at: cleanText(upload.withdrawn_at)
    };
  }).filter((upload) => upload.media_id);
}

export function normalizePortalComments(value: unknown): PortalCommentEntry[] {
  return asArray(value).map((entry) => {
    const comment = asObject(entry);
    return {
      id: cleanText(comment.id),
      media_id: cleanText(comment.media_id),
      body: cleanText(comment.body).slice(0, PORTAL_MAX_COMMENT_CHARS),
      author: cleanText(comment.author),
      created_at: cleanText(comment.created_at),
      withdrawn_at: cleanText(comment.withdrawn_at)
    };
  }).filter((comment) => comment.id && comment.media_id);
}

/** Uploads the customer has not withdrawn, newest first. */
export function visiblePortalUploads(portalData: JsonObject) {
  return normalizePortalUploads(portalData.customer_uploads)
    .filter((upload) => !upload.withdrawn_at)
    .sort((left, right) => right.uploaded_at.localeCompare(left.uploaded_at));
}

/** Comments the customer has not withdrawn, oldest first (reading order). */
export function visiblePortalComments(portalData: JsonObject, mediaId = "") {
  const target = cleanText(mediaId);
  return normalizePortalComments(portalData.media_comments)
    .filter((comment) => !comment.withdrawn_at)
    .filter((comment) => !target || comment.media_id === target)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

/**
 * Daily upload quota check. Counts non-withdrawn uploads in the trailing 24h —
 * withdrawing an upload must not refund quota, or the limit is trivially
 * bypassed by upload-withdraw-repeat.
 */
export function assertUploadQuota(portalData: JsonObject, settings: PortalSettings) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = normalizePortalUploads(portalData.customer_uploads)
    .filter((upload) => Date.parse(upload.uploaded_at) >= since);
  if (recent.length >= settings.uploads.max_files) {
    throw forbidden("portal_upload_quota", "You have reached today's upload limit. Please try again tomorrow.");
  }
}

export function assertCommentBody(body: unknown) {
  const text = cleanText(body);
  if (!text) throw badRequest("portal_comment_empty", "Write a comment first.");
  if (text.length > PORTAL_MAX_COMMENT_CHARS) {
    throw badRequest("portal_comment_too_long", `Comments cannot exceed ${PORTAL_MAX_COMMENT_CHARS} characters.`);
  }
  return text;
}

/**
 * The media a customer is allowed to comment on: business-shared media plus
 * their own non-withdrawn uploads. Commenting on an arbitrary media id would
 * let a link holder probe for (and annotate) media from other projects.
 */
export function assertCommentableMedia(portalData: JsonObject, mediaId: string) {
  const target = cleanText(mediaId);
  if (!target) throw badRequest("portal_comment_media_required", "A photo is required.");
  const shared = asArray(portalData.shared_items)
    .map((item) => asObject(item))
    .filter((item) => cleanText(item.type || "media") === "media")
    .map((item) => cleanText(item.item_id || item.media_id));
  if (shared.includes(target)) return target;
  if (visiblePortalUploads(portalData).some((upload) => upload.media_id === target)) return target;
  throw notFound("portal_media_not_found", "That photo is not part of this portal.");
}

/** Resolve the settings for a portal record against its org defaults. */
export function portalSettingsFor(orgDefaults: unknown, portalData: JsonObject) {
  return normalizePortalSettings(orgDefaults, portalData.settings);
}
