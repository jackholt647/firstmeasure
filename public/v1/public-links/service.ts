import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { env } from "../src/config/env.js";

export const PUBLIC_LINKS_COLLECTION = "public_links";
const TOKEN_PREFIX = "pl1";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenDocumentId(token: string) {
  return `public_link_${tokenHash(token).slice(0, 32)}`;
}

function encodeOrgHint(orgId: string) {
  return Buffer.from(orgId, "utf8").toString("base64url");
}

function parseToken(token: string) {
  const normalized = cleanText(token);
  const parts = normalized.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !/^[A-Za-z0-9_-]{32,}$/.test(parts[2] || "")) {
    throw notFound("public_link_not_found", "This public link is invalid or no longer available.");
  }
  let orgId = "";
  try {
    orgId = Buffer.from(parts[1] || "", "base64url").toString("utf8");
  } catch { /* handled below */ }
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(orgId)) {
    throw notFound("public_link_not_found", "This public link is invalid or no longer available.");
  }
  return { token: normalized, orgId };
}

function normalizeActions(value: unknown) {
  const actions = Array.isArray(value) ? value : [];
  return [...new Set(actions.map(cleanText).filter((entry) => /^[a-z][a-z0-9_.:-]{0,79}$/i.test(entry)))].slice(0, 32);
}

function normalizeDestination(value: unknown) {
  const path = cleanText(value);
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path) || path.split(/[/?#]/).includes("..")) {
    throw badRequest("invalid_public_link_destination", "destination_path must be a local absolute path beginning with one slash.");
  }
  return path;
}

export function publicLinkUrl(token: string, baseUrl = "") {
  const base = (cleanText(baseUrl) || cleanText(env.publicBaseUrl)).replace(/\/+$/, "");
  if (!base) throw badRequest("public_base_url_missing", "PUBLIC_BASE_URL must be configured before public links can be sent.");
  return `${base}/l/${encodeURIComponent(cleanText(token))}`;
}

export type CreatePublicLinkInput = {
  kind: string;
  resource_type: string;
  resource_id: string;
  destination_path: string;
  allowed_actions?: string[];
  expires_at?: string;
  metadata?: JsonObject;
  created_by?: string;
};

export async function createPublicLink(orgId: string, input: CreatePublicLinkInput) {
  const kind = cleanText(input.kind);
  const resourceType = cleanText(input.resource_type);
  const resourceId = cleanText(input.resource_id);
  if (!kind || !resourceType || !resourceId) {
    throw badRequest("public_link_target_required", "kind, resource_type, and resource_id are required.");
  }
  const expiresAt = cleanText(input.expires_at);
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw badRequest("invalid_public_link_expiry", "expires_at must be an ISO date-time.");
  }
  const token = `${TOKEN_PREFIX}.${encodeOrgHint(orgId)}.${randomBytes(32).toString("base64url")}`;
  const id = tokenDocumentId(token);
  const now = new Date().toISOString();
  const document = await upsertDocument(orgId, PUBLIC_LINKS_COLLECTION, {
    id,
    data: {
      id,
      kind,
      resource_type: resourceType,
      resource_id: resourceId,
      destination_path: normalizeDestination(input.destination_path),
      allowed_actions: normalizeActions(input.allowed_actions),
      token_hash: tokenHash(token),
      token_fingerprint: tokenHash(token).slice(0, 12),
      status: "active",
      expires_at: expiresAt,
      revoked_at: "",
      last_accessed_at: "",
      access_count: 0,
      created_by: cleanText(input.created_by),
      created_at: now,
      updated_at: now
    },
    metadata: { kind: "public_link", ...asObject(input.metadata) }
  });
  return { document, token, url: publicLinkUrl(token) };
}

export async function resolvePublicLink(token: string, options: { kind?: string; action?: string } = {}) {
  const parsed = parseToken(token);
  const document = await readDocument(parsed.orgId, PUBLIC_LINKS_COLLECTION, tokenDocumentId(parsed.token)).catch(() => null);
  if (!document) throw notFound("public_link_not_found", "This public link is invalid or no longer available.");
  const data = asObject(document.data);
  const actual = Buffer.from(tokenHash(parsed.token), "hex");
  const expected = Buffer.from(cleanText(data.token_hash), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw notFound("public_link_not_found", "This public link is invalid or no longer available.");
  }
  if (cleanText(data.status) !== "active" || cleanText(data.revoked_at)) {
    throw forbidden("public_link_revoked", "This public link is no longer available.");
  }
  const expiresAt = cleanText(data.expires_at);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw forbidden("public_link_expired", "This public link has expired.");
  }
  if (options.kind && cleanText(data.kind) !== cleanText(options.kind)) {
    throw forbidden("public_link_kind_mismatch", "This link cannot be used for that experience.");
  }
  const allowed = normalizeActions(data.allowed_actions);
  if (options.action && allowed.length && !allowed.includes(cleanText(options.action))) {
    throw forbidden("public_link_action_forbidden", "This link does not allow that action.");
  }
  return { orgId: parsed.orgId, document, data };
}

export async function recordPublicLinkAccess(token: string, action = "view") {
  const resolved = await resolvePublicLink(token, { action });
  const now = new Date().toISOString();
  const updated = await upsertDocument(resolved.orgId, PUBLIC_LINKS_COLLECTION, {
    id: resolved.document.id,
    data: {
      ...resolved.data,
      last_accessed_at: now,
      access_count: Math.max(0, Number(resolved.data.access_count) || 0) + 1,
      updated_at: now
    },
    metadata: resolved.document.metadata
  }, { replace: true });
  return { ...resolved, document: updated, data: asObject(updated.data) };
}

export async function listPublicLinks(orgId: string) {
  return await listDocuments(orgId, PUBLIC_LINKS_COLLECTION).catch(() => []);
}

export async function revokePublicLink(orgId: string, linkId: string, actor = "") {
  const document = await readDocument(orgId, PUBLIC_LINKS_COLLECTION, cleanText(linkId));
  const data = asObject(document.data);
  const now = new Date().toISOString();
  return await upsertDocument(orgId, PUBLIC_LINKS_COLLECTION, {
    id: document.id,
    data: { ...data, status: "revoked", revoked_at: now, revoked_by: cleanText(actor), updated_at: now },
    metadata: document.metadata
  }, { replace: true });
}

export function publicLinkDestination(data: JsonObject, token: string) {
  return normalizeDestination(data.destination_path).replaceAll("{token}", encodeURIComponent(token));
}
