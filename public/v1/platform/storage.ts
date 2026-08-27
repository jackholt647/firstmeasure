import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { isSpacesArtifactStorageEnabled } from "../src/storage/project_artifacts.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { formatIdentityPhone, identifierLooksLikeEmail, normalizeIdentityPhone } from "./identity_phone.js";

export type JsonObject = Record<string, unknown>;
export type PlatformCollection = "users" | "projects" | "customers" | "branch" | "notifications" | "action_items" | "activity" | "customer_portals" | "onboarding_events" | "proposals" | "proposal_snapshots" | "proposal_events" | "material_lists" | "material_list_versions" | "material_orders" | "material_deliveries" | "material_events" | "payment_schedules" | "payment_obligations" | "payment_transactions" | "payment_allocations" | "payment_intents" | "payment_payables" | "payment_disbursements" | "payment_ledger_events" | "payment_events";

const COLLECTIONS: PlatformCollection[] = ["users", "projects", "customers", "branch", "notifications", "action_items", "activity", "customer_portals", "onboarding_events", "proposals", "proposal_snapshots", "proposal_events", "material_lists", "material_list_versions", "material_orders", "material_deliveries", "material_events", "payment_schedules", "payment_obligations", "payment_transactions", "payment_allocations", "payment_intents", "payment_payables", "payment_disbursements", "payment_ledger_events", "payment_events"];
const PLATFORM_SCHEMA_VERSION = 1;

let postgresStoragePromise: Promise<typeof import("./storage_postgres.js")> | null = null;
function postgresStorage() {
  postgresStoragePromise ??= import("./storage_postgres.js");
  return postgresStoragePromise;
}

type StoredDocument = JsonObject & {
  schema_version: number;
  id: string;
  organization_id: string;
  collection: PlatformCollection | "global";
  data: JsonObject;
  metadata: JsonObject;
  revision: number;
  created_at: string;
  updated_at: string;
};

type BranchModuleDocument = JsonObject & {
  schema_version: number;
  id: string;
  organization_id: string;
  branch_id: string;
  module: string;
  data: JsonObject;
  metadata: JsonObject;
  revision: number;
  created_at: string;
  updated_at: string;
};

type MediaVariant = JsonObject & {
  path: string;
  content_type: string;
  file_name: string;
  size_bytes: number;
  width?: number | null;
  height?: number | null;
};

type MediaUploadOptions = {
  id?: string;
  ownerType?: string;
  ownerId?: string;
  slot?: string;
  collection?: string;
  scope?: string;
  fileName?: string;
  contentType?: string;
  bytes: Buffer;
  replaceSlot?: boolean;
  thumbnails?: unknown;
  compression?: unknown;
  markup?: unknown;
  metadata?: JsonObject;
};

type MediaProcessingSettings = {
  thumbnails: {
    enabled: boolean;
    sizes: number[];
    quality: number;
    format: "webp" | "jpeg" | "png";
    largeOnly: boolean;
    largeThreshold: number;
  };
  compression: {
    enabled: boolean;
    maxWidth: number;
    quality: number;
    format: "webp" | "jpeg" | "png";
    variant: string;
  };
};

function storageRoot() {
  return path.resolve(process.cwd(), env.platformStorageRoot);
}

function organizationsRoot() {
  return path.join(storageRoot(), "organizations");
}

function identitiesRoot() {
  return path.join(storageRoot(), "identities");
}

function authIndexRoot() {
  return path.join(storageRoot(), "auth_index");
}

function sessionsRoot() {
  return path.join(storageRoot(), "sessions");
}

function emailIndexRoot() {
  return path.join(authIndexRoot(), "email");
}

function registrationLockRoot() {
  return path.join(authIndexRoot(), "registration_locks");
}

function identityLockRoot() {
  return path.join(authIndexRoot(), "identity_locks");
}

function sanitizeId(value: string, label = "id") {
  const cleaned = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!cleaned) throw badRequest(`invalid_${label}`, `${label} must contain at least one letter or number.`);
  return cleaned;
}

function generateId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function generatedDocumentPrefix(collection: PlatformCollection) {
  if (collection === "users") return "user";
  if (collection === "projects") return "project";
  if (collection === "customers") return "customer";
  if (collection === "branch") return "branch";
  if (collection === "notifications") return "notification";
  if (collection === "action_items") return "action_item";
  if (collection === "activity") return "activity";
  if (collection === "customer_portals") return "customer_portal";
  if (collection === "onboarding_events") return "onboarding_event";
  if (collection === "proposals") return "proposal";
  if (collection === "proposal_snapshots") return "proposal_snapshot";
  if (collection === "proposal_events") return "proposal_event";
  if (collection === "material_lists") return "material_list";
  if (collection === "material_list_versions") return "material_version";
  if (collection === "material_orders") return "material_order";
  if (collection === "material_deliveries") return "material_delivery";
  if (collection === "material_events") return "material_event";
  if (collection === "payment_schedules") return "payment_schedule";
  if (collection === "payment_obligations") return "payment_obligation";
  if (collection === "payment_transactions") return "payment";
  if (collection === "payment_allocations") return "payment_allocation";
  if (collection === "payment_intents") return "payment_intent";
  if (collection === "payment_payables") return "payment_payable";
  if (collection === "payment_disbursements") return "payment_disbursement";
  if (collection === "payment_ledger_events") return "payment_ledger";
  if (collection === "payment_events") return "payment_event";
  return "doc";
}

function hashId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeFileName(value: unknown, fallback = "upload") {
  const raw = String(value ?? "").trim().replace(/\\/g, "/").split("/").pop() || fallback;
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function extensionForMedia(contentType: string, fileName = "") {
  const nameExt = path.extname(fileName).replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]{2,6}$/.test(nameExt)) return nameExt;
  const normalized = contentType.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/webm") return "webm";
  return "bin";
}

function mediaKind(contentType: string) {
  const normalized = contentType.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  return "file";
}

function contentTypeForFormat(format: string) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/webp";
}

function extensionForFormat(format: string) {
  if (format === "jpeg") return "jpg";
  if (format === "png") return "png";
  return "webp";
}

function numberInRange(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function stringChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.includes(normalized as T) ? normalized as T : fallback;
}

function normalizeProcessingSettings(thumbnails: unknown, compression: unknown): MediaProcessingSettings {
  const thumbnailInput = thumbnails === false ? { enabled: false } : asObject(thumbnails);
  const compressionInput = compression === false ? { enabled: false } : asObject(compression);
  const rawSizes = Array.isArray(thumbnailInput.sizes) ? thumbnailInput.sizes : [160, 320, 640];
  const sizes = [...new Set(rawSizes.map((size) => numberInRange(size, 0, 32, 2400)).filter(Boolean))]
    .sort((a, b) => a - b);
  return {
    thumbnails: {
      enabled: thumbnailInput.enabled !== false,
      sizes: sizes.length ? sizes : [160, 320, 640],
      quality: numberInRange(thumbnailInput.quality, 78, 35, 95),
      format: stringChoice(thumbnailInput.format, ["webp", "jpeg", "png"] as const, "webp"),
      largeOnly: thumbnailInput.large_only !== false && thumbnailInput.largeOnly !== false,
      largeThreshold: numberInRange(thumbnailInput.large_threshold ?? thumbnailInput.largeThreshold, 1024, 128, 8000)
    },
    compression: {
      enabled: compressionInput.enabled !== false,
      maxWidth: numberInRange(compressionInput.max_width ?? compressionInput.maxWidth, 2400, 320, 12000),
      quality: numberInRange(compressionInput.quality, 82, 35, 98),
      format: stringChoice(compressionInput.format, ["webp", "jpeg", "png"] as const, "webp"),
      variant: String(compressionInput.variant || "").trim()
        ? sanitizeId(String(compressionInput.variant), "variant")
        : ""
    }
  };
}

function normalizeEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw badRequest("invalid_email", "A valid email address is required.");
  }
  return email;
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function writeFileAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, content);
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) throw error;
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonExclusive(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 120_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw conflict("registration_in_progress", "Account registration is already in progress. Please try again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function withIdentityRegistrationLock<T>(emailValue: string, operation: () => Promise<T>): Promise<T> {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).withIdentityRegistrationLock(emailValue, operation);
  const email = normalizeEmail(emailValue);
  return await withFileLock(path.join(registrationLockRoot(), `${hashId(email)}.lock`), operation);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw notFound("not_found", "The requested platform record was not found.");
    }
    throw error;
  }
}

function identityPath(identityId: string) {
  return path.join(identitiesRoot(), `${sanitizeId(identityId, "identity_id")}.json`);
}

function sessionPath(sessionId: string) {
  return path.join(sessionsRoot(), `${hashId(sessionId)}.json`);
}

function emailIndexPath(email: string) {
  return path.join(emailIndexRoot(), `${hashId(normalizeEmail(email))}.json`);
}

function orgDir(orgId: string) {
  return path.join(organizationsRoot(), sanitizeId(orgId, "organization_id"));
}

function orgManifestPath(orgId: string) {
  return path.join(orgDir(orgId), "manifest.json");
}

function collectionDir(orgId: string, collection: PlatformCollection) {
  return path.join(orgDir(orgId), collection);
}

function documentPath(orgId: string, collection: PlatformCollection, documentId: string) {
  return path.join(collectionDir(orgId, collection), `${sanitizeId(documentId, "document_id")}.json`);
}

function globalPath(orgId: string) {
  return path.join(orgDir(orgId), "global.json");
}

function mediaDir(orgId: string, mediaId: string) {
  return path.join(orgDir(orgId), "media", sanitizeId(mediaId, "media_id"));
}

function mediaMetadataPath(orgId: string, mediaId: string) {
  return path.join(mediaDir(orgId, mediaId), "metadata.json");
}

function mediaMarkupPath(orgId: string, mediaId: string, layerId: string) {
  return path.join(mediaDir(orgId, mediaId), "markup", `${sanitizeId(layerId, "markup_layer_id")}.json`);
}

function branchDataDir(orgId: string, branchId: string) {
  return path.join(orgDir(orgId), "branch_data", sanitizeId(branchId, "branch_id"));
}

function branchModulePath(orgId: string, branchId: string, moduleId: string) {
  return path.join(branchDataDir(orgId, branchId), `${sanitizeId(moduleId, "module_id")}.json`);
}

function branchModuleReferencePath(branchId: string, moduleId: string) {
  return `branch_data/${sanitizeId(branchId, "branch_id")}/${sanitizeId(moduleId, "module_id")}.json`;
}

function nowIso() {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function assertCollection(value: string): PlatformCollection {
  if (COLLECTIONS.includes(value as PlatformCollection)) return value as PlatformCollection;
  throw badRequest("invalid_collection", "Collection must be one of the registered platform collections.");
}

function deriveBranchModuleSummary(moduleId: string, data: JsonObject) {
  if (moduleId === "pricebook") {
    const items = Array.isArray(data.items) ? data.items : [];
    const categories = new Set(
      items
        .map((item) => asObject(item).category)
        .filter((category) => typeof category === "string" && category)
    );
    return { item_count: items.length, category_count: categories.size };
  }

  if (moduleId === "presentation_style") {
    const pages = Array.isArray(data.marketing_pages) ? data.marketing_pages : [];
    return {
      default_theme: String(data.default_theme || "margin"),
      marketing_page_count: pages.length
    };
  }

  return {};
}

export async function ensurePlatformStorage() {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).ensurePostgresPlatformStorage();
  await mkdir(organizationsRoot(), { recursive: true });
  await mkdir(identitiesRoot(), { recursive: true });
  await mkdir(sessionsRoot(), { recursive: true });
  await mkdir(emailIndexRoot(), { recursive: true });
  await mkdir(registrationLockRoot(), { recursive: true });
  await mkdir(identityLockRoot(), { recursive: true });
}

export async function createAuthSession(input: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).createAuthSession(input);
  await ensurePlatformStorage();
  const now = nowIso();
  const sessionId = randomBytes(32).toString("base64url");
  const ttlSeconds = Math.max(60, Number(input.ttl_seconds ?? env.platformSessionTtlSeconds));
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const session = {
    schema_version: PLATFORM_SCHEMA_VERSION,
    id_hash: hashId(sessionId),
    identity_id: sanitizeId(String(input.identity_id || ""), "identity_id"),
    organization_id: sanitizeId(String(input.organization_id || ""), "organization_id"),
    user_id: sanitizeId(String(input.user_id || ""), "user_id"),
    role: String(input.role || "member"),
    permissions_snapshot: asObject(input.permissions_snapshot),
    branch_id: String(input.branch_id || "default"),
    csrf_token: String(input.csrf_token || randomBytes(24).toString("base64url")),
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    metadata: asObject(input.metadata)
  };
  await writeJsonAtomic(sessionPath(sessionId), session);
  return { sessionId, session };
}

export async function readAuthSession(sessionId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readAuthSession(sessionId);
  await ensurePlatformStorage();
  const session = await readJsonFile<JsonObject>(sessionPath(sessionId));
  if (session.revoked_at) {
    throw notFound("session_revoked", "The platform session has been revoked.");
  }
  const expiresAt = Date.parse(String(session.expires_at || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await deleteAuthSession(sessionId);
    throw notFound("session_expired", "The platform session has expired.");
  }
  return session;
}

export async function touchAuthSession(sessionId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).touchAuthSession(sessionId);
  const session = await readAuthSession(sessionId);
  const next = {
    ...session,
    updated_at: nowIso(),
    last_seen_at: nowIso()
  };
  await writeJsonAtomic(sessionPath(sessionId), next);
  return next;
}

export async function deleteAuthSession(sessionId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).deleteAuthSession(sessionId);
  await ensurePlatformStorage();
  await rm(sessionPath(sessionId), { force: true });
}

export async function deleteIdentitySessions(identityId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).deleteIdentitySessions(identityId);
  await ensurePlatformStorage();
  const normalizedIdentityId = sanitizeId(identityId, "identity_id");
  const entries = await readdir(sessionsRoot(), { withFileTypes: true });
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(sessionsRoot(), entry.name);
    const session = await readJsonFile<JsonObject>(filePath).catch(() => null);
    if (String(session?.identity_id || "") !== normalizedIdentityId) continue;
    await rm(filePath, { force: true });
    deleted += 1;
  }
  return deleted;
}

export async function createIdentity(input: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).createIdentity(input);
  await ensurePlatformStorage();
  const email = normalizeEmail(input.email);
  const id = input.id ? sanitizeId(String(input.id), "identity_id") : `identity_${hashId(email).slice(0, 16)}`;
  const filePath = identityPath(id);
  const indexPath = emailIndexPath(email);
  if (await pathExists(indexPath)) throw conflict("identity_email_exists", `Identity for '${email}' already exists.`);
  if (await pathExists(filePath)) throw conflict("identity_exists", `Identity '${id}' already exists.`);
  const requestedPhone = String(input.phone ?? "").trim();
  const phoneNormalized = requestedPhone ? normalizeIdentityPhone(requestedPhone) : "";
  if (requestedPhone && !phoneNormalized) throw badRequest("invalid_phone_number", "A valid mobile phone number is required.");
  const phone = formatIdentityPhone(requestedPhone);
  if (phoneNormalized) await assertIdentityPhoneAvailable(phoneNormalized);
  const now = nowIso();
  const identity = {
    schema_version: PLATFORM_SCHEMA_VERSION,
    id,
    email,
    email_normalized: email,
    password_hash: String(input.password_hash ?? ""),
    password_algo: String(input.password_algo ?? "php-password-hash"),
    name: String(input.name ?? ""),
    phone,
    phone_normalized: phoneNormalized,
    status: String(input.status ?? "active"),
    memberships: Array.isArray(input.memberships) ? input.memberships : [],
    metadata: asObject(input.metadata),
    revision: 1,
    created_at: String(input.created_at ?? now),
    updated_at: now,
    last_login_at: input.last_login_at ? String(input.last_login_at) : null
  };
  try {
    await writeJsonExclusive(filePath, identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw conflict("identity_exists", `Identity '${id}' already exists.`);
    }
    throw error;
  }
  try {
    await writeJsonExclusive(indexPath, {
      schema_version: PLATFORM_SCHEMA_VERSION,
      email,
      identity_id: id,
      created_at: now,
      updated_at: now
    });
  } catch (error) {
    await rm(filePath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw conflict("identity_email_exists", `Identity for '${email}' already exists.`);
    }
    throw error;
  }
  return identity;
}

export async function readIdentity(identityId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readIdentity(identityId);
  await ensurePlatformStorage();
  return await readJsonFile<JsonObject>(identityPath(identityId));
}

export async function findIdentityByEmail(emailValue: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).findIdentityByEmail(emailValue);
  await ensurePlatformStorage();
  const email = normalizeEmail(emailValue);
  const index = await readJsonFile<JsonObject>(emailIndexPath(email));
  return await readIdentity(String(index.identity_id ?? ""));
}

export async function identityEmailExists(emailValue: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).identityEmailExists(emailValue);
  await ensurePlatformStorage();
  const email = normalizeEmail(emailValue);
  const identityId = `identity_${hashId(email).slice(0, 16)}`;
  return await pathExists(emailIndexPath(email)) || await pathExists(identityPath(identityId));
}

export async function deleteIdentity(identityId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).deleteIdentity(identityId);
  await ensurePlatformStorage();
  const identity = await readIdentity(identityId).catch(() => null);
  if (identity) {
    const email = normalizeEmail(identity.email);
    const indexPath = emailIndexPath(email);
    const index = await readJsonFile<JsonObject>(indexPath).catch(() => null);
    if (String(index?.identity_id || "") === String(identity.id || identityId)) {
      await rm(indexPath, { force: true });
    }
  }
  await rm(identityPath(identityId), { force: true });
}

export async function listIdentitiesByPhone(phoneValue: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).listIdentitiesByPhone(phoneValue);
  await ensurePlatformStorage();
  const phone = normalizeIdentityPhone(phoneValue);
  if (!phone) throw badRequest("invalid_phone_number", "A valid mobile phone number is required.");
  const entries = await readdir(identitiesRoot(), { withFileTypes: true });
  const matches: JsonObject[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const identity = await readJsonFile<JsonObject>(path.join(identitiesRoot(), entry.name));
    if (normalizeIdentityPhone(identity.phone_normalized || identity.phone) === phone) matches.push(identity);
  }
  return matches;
}

export async function findIdentityByPhone(phoneValue: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).findIdentityByPhone(phoneValue);
  const matches = await listIdentitiesByPhone(phoneValue);
  if (!matches.length) throw notFound("identity_phone_not_found", "No account was found for that phone number.");
  if (matches.length > 1) {
    throw conflict(
      "identity_phone_ambiguous",
      "This phone number is connected to multiple accounts. Sign in with email or contact support."
    );
  }
  return matches[0] as JsonObject;
}

export async function findIdentityByIdentifier(identifierValue: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).findIdentityByIdentifier(identifierValue);
  const identifier = String(identifierValue || "").trim();
  if (!identifier) throw badRequest("missing_login_identifier", "Enter an email address or phone number.");
  return identifierLooksLikeEmail(identifier)
    ? await findIdentityByEmail(identifier)
    : await findIdentityByPhone(identifier);
}

async function assertIdentityPhoneAvailable(phoneValue: string, excludeIdentityId = "") {
  const matches = await listIdentitiesByPhone(phoneValue);
  const conflictMatch = matches.find((identity) => String(identity.id || "") !== excludeIdentityId);
  if (conflictMatch) {
    throw conflict("identity_phone_exists", "That phone number is already connected to an account.");
  }
}

async function patchIdentityUnlocked(identityId: string, patch: JsonObject) {
  await ensurePlatformStorage();
  const current = await readIdentity(identityId);
  const expectedRevision = Number(patch.expected_revision ?? 0);
  if (expectedRevision && expectedRevision !== Number(current.revision ?? 0)) {
    throw conflict("revision_conflict", "Identity revision does not match.");
  }
  const currentEmail = normalizeEmail(current.email);
  const requestedEmail = Object.prototype.hasOwnProperty.call(patch, "email") ? normalizeEmail(patch.email) : currentEmail;
  if (requestedEmail !== currentEmail) {
    const nextIndexPath = emailIndexPath(requestedEmail);
    if (await pathExists(nextIndexPath)) throw conflict("identity_email_exists", `Identity for '${requestedEmail}' already exists.`);
  }
  const phoneWasPatched = Object.prototype.hasOwnProperty.call(patch, "phone");
  let requestedPhone = String(current.phone ?? "");
  let requestedPhoneNormalized = String(current.phone_normalized ?? "");
  if (phoneWasPatched) {
    const rawRequestedPhone = String(patch.phone ?? "").trim();
    requestedPhoneNormalized = rawRequestedPhone ? normalizeIdentityPhone(rawRequestedPhone) : "";
    if (rawRequestedPhone && !requestedPhoneNormalized) {
      throw badRequest("invalid_phone_number", "A valid mobile phone number is required.");
    }
    requestedPhone = formatIdentityPhone(rawRequestedPhone);
    if (requestedPhoneNormalized) {
      await assertIdentityPhoneAvailable(requestedPhoneNormalized, String(current.id || identityId));
    }
  }
  const next = {
    ...current,
    ...asObject(patch),
    id: current.id,
    email: requestedEmail,
    email_normalized: requestedEmail,
    ...(phoneWasPatched ? { phone: requestedPhone, phone_normalized: requestedPhoneNormalized } : {}),
    schema_version: current.schema_version ?? PLATFORM_SCHEMA_VERSION,
    metadata: { ...asObject(current.metadata), ...asObject(patch.metadata) },
    revision: Number(current.revision ?? 0) + 1,
    updated_at: nowIso()
  };
  delete (next as JsonObject).expected_revision;
  await writeJsonAtomic(identityPath(identityId), next);
  if (requestedEmail !== currentEmail) {
    const now = nowIso();
    await rm(emailIndexPath(currentEmail), { force: true });
    await writeJsonAtomic(emailIndexPath(requestedEmail), {
      schema_version: PLATFORM_SCHEMA_VERSION,
      email: requestedEmail,
      identity_id: current.id,
      created_at: now,
      updated_at: now
    });
  }
  return next;
}

export async function patchIdentity(identityId: string, patch: JsonObject) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).patchIdentity(identityId, patch);
  const normalizedIdentityId = sanitizeId(identityId, "identity_id");
  return await withFileLock(
    path.join(identityLockRoot(), `${normalizedIdentityId}.lock`),
    async () => await patchIdentityUnlocked(normalizedIdentityId, patch)
  );
}

export async function listIdentityMemberships(identityId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).listIdentityMemberships(identityId);
  const identity = await readIdentity(identityId);
  const configured = Array.isArray(identity.memberships) ? identity.memberships : [];
  const memberships = [];
  for (const entry of configured) {
    const membership = asObject(entry);
    const orgId = String(membership.organization_id ?? "");
    const userId = String(membership.user_id ?? "");
    if (!orgId || !userId) continue;
    try {
      memberships.push({
        organization: await readOrganization(orgId),
        user: await readDocument(orgId, "users", userId)
      });
    } catch (error) {
      // Keep login resilient if a stale membership points at a removed org/user.
    }
  }
  return memberships;
}

export async function addIdentityMembership(identityId: string, orgId: string, userId: string, role = "member") {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).addIdentityMembership(identityId, orgId, userId, role);
  const normalizedIdentityId = sanitizeId(identityId, "identity_id");
  return await withFileLock(path.join(identityLockRoot(), `${normalizedIdentityId}.lock`), async () => {
    const identity = await readIdentity(normalizedIdentityId);
    const memberships = Array.isArray(identity.memberships) ? [...identity.memberships] : [];
    const normalizedOrgId = sanitizeId(orgId, "organization_id");
    const normalizedUserId = sanitizeId(userId, "user_id");
    const exists = memberships.some((entry) => {
      const item = asObject(entry);
      return String(item.organization_id ?? "") === normalizedOrgId && String(item.user_id ?? "") === normalizedUserId;
    });
    if (!exists) {
      memberships.push({
        organization_id: normalizedOrgId,
        user_id: normalizedUserId,
        role,
        status: "active",
        added_at: nowIso()
      });
    }
    return await patchIdentityUnlocked(normalizedIdentityId, { memberships });
  });
}

export async function createOrganization(input: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).createOrganization(input);
  await ensurePlatformStorage();
  const id = input.id ? sanitizeId(String(input.id), "organization_id") : generateId("org");
  const filePath = orgManifestPath(id);
  if (await pathExists(filePath)) throw conflict("organization_exists", `Organization '${id}' already exists.`);
  const now = nowIso();
  const organization = {
    schema_version: PLATFORM_SCHEMA_VERSION,
    id,
    name: String(input.name ?? "Untitled Organization"),
    status: String(input.status ?? "active"),
    metadata: asObject(input.metadata),
    revision: 1,
    created_at: now,
    updated_at: now
  };
  await mkdir(orgDir(id), { recursive: true });
  for (const collection of COLLECTIONS) await mkdir(collectionDir(id, collection), { recursive: true });
  await writeJsonAtomic(filePath, organization);
  await writeJsonAtomic(globalPath(id), {
    schema_version: PLATFORM_SCHEMA_VERSION,
    id: "global",
    organization_id: id,
    collection: "global",
    data: asObject(input.global),
    metadata: {},
    revision: 1,
    created_at: now,
    updated_at: now
  });
  return organization;
}

export async function deleteOrganization(orgId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).deleteOrganization(orgId);
  await ensurePlatformStorage();
  await rm(orgDir(orgId), { recursive: true, force: true });
}

export async function listOrganizations() {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).listOrganizations();
  await ensurePlatformStorage();
  const entries = await readdir(organizationsRoot(), { withFileTypes: true });
  const organizations = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      organizations.push(await readJsonFile<JsonObject>(orgManifestPath(entry.name)));
    } catch (error) {
      // Ignore incomplete directories so one damaged org does not hide every org.
    }
  }
  return organizations.sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
}

export async function readOrganization(orgId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readOrganization(orgId);
  return await readJsonFile<JsonObject>(orgManifestPath(orgId));
}

export async function patchOrganization(orgId: string, patch: JsonObject) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).patchOrganization(orgId, patch);
  const current = await readOrganization(orgId);
  const expectedRevision = Number(patch.expected_revision ?? 0);
  if (expectedRevision && expectedRevision !== Number(current.revision ?? 0)) {
    throw conflict("revision_conflict", "Organization revision does not match.");
  }
  const next = {
    ...current,
    ...asObject(patch),
    id: current.id,
    schema_version: current.schema_version ?? PLATFORM_SCHEMA_VERSION,
    metadata: { ...asObject(current.metadata), ...asObject(patch.metadata) },
    revision: Number(current.revision ?? 0) + 1,
    updated_at: nowIso()
  };
  delete (next as JsonObject).expected_revision;
  await writeJsonAtomic(orgManifestPath(orgId), next);
  return next;
}

export async function listDocuments(orgId: string, collectionValue: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).listDocuments(orgId, collectionValue) as Promise<StoredDocument[]>;
  const collection = assertCollection(collectionValue);
  await readOrganization(orgId);
  await mkdir(collectionDir(orgId, collection), { recursive: true });
  const directory = collectionDir(orgId, collection);
  const entries = await readdir(directory, { withFileTypes: true });
  const fileEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const documents = await mapWithConcurrency(fileEntries, 32, (entry) => (
    readJsonFile<StoredDocument>(path.join(directory, entry.name))
  ));
  return documents.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function readDocument(orgId: string, collectionValue: string, documentId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readDocument(orgId, collectionValue, documentId) as Promise<StoredDocument>;
  const collection = assertCollection(collectionValue);
  await readOrganization(orgId);
  return await readJsonFile<StoredDocument>(documentPath(orgId, collection, documentId));
}

export async function upsertDocument(orgId: string, collectionValue: string, input: JsonObject = {}, options: { replace?: boolean } = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).upsertDocument(orgId, collectionValue, input, options) as Promise<StoredDocument>;
  const collection = assertCollection(collectionValue);
  await readOrganization(orgId);
  const id = input.id ? sanitizeId(String(input.id), "document_id") : generateId(generatedDocumentPrefix(collection));
  const filePath = documentPath(orgId, collection, id);
  const exists = await pathExists(filePath);
  const now = nowIso();
  const data = asObject(input.data);
  const metadata = asObject(input.metadata);
  const expectedRevision = Number(input.expected_revision ?? 0);

  if (!exists) {
    const created: StoredDocument = {
      schema_version: PLATFORM_SCHEMA_VERSION,
      id,
      organization_id: sanitizeId(orgId, "organization_id"),
      collection,
      data,
      metadata,
      revision: 1,
      created_at: now,
      updated_at: now
    };
    await writeJsonAtomic(filePath, created);
    return created;
  }

  const current = await readJsonFile<StoredDocument>(filePath);
  if (expectedRevision && expectedRevision !== current.revision) {
    throw conflict("revision_conflict", "Document revision does not match.");
  }
  const next: StoredDocument = {
    ...current,
    data: options.replace ? data : { ...asObject(current.data), ...data },
    metadata: options.replace ? metadata : { ...asObject(current.metadata), ...metadata },
    revision: current.revision + 1,
    updated_at: now
  };
  await writeJsonAtomic(filePath, next);
  return next;
}

export async function deleteDocument(orgId: string, collectionValue: string, documentId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).deleteDocument(orgId, collectionValue, documentId);
  const collection = assertCollection(collectionValue);
  await readOrganization(orgId);
  const existing = await readDocument(orgId, collection, documentId);
  await rm(documentPath(orgId, collection, documentId), { force: true });
  return existing;
}

export async function readGlobal(orgId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readGlobal(orgId) as Promise<StoredDocument>;
  await readOrganization(orgId);
  if (!(await pathExists(globalPath(orgId)))) {
    const now = nowIso();
    const globalDoc: StoredDocument = {
      schema_version: PLATFORM_SCHEMA_VERSION,
      id: "global",
      organization_id: sanitizeId(orgId, "organization_id"),
      collection: "global",
      data: {},
      metadata: {},
      revision: 1,
      created_at: now,
      updated_at: now
    };
    await writeJsonAtomic(globalPath(orgId), globalDoc);
    return globalDoc;
  }
  return await readJsonFile<StoredDocument>(globalPath(orgId));
}

export async function saveGlobal(orgId: string, input: JsonObject = {}, options: { replace?: boolean } = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).saveGlobal(orgId, input, options) as Promise<StoredDocument>;
  const current = await readGlobal(orgId);
  const expectedRevision = Number(input.expected_revision ?? 0);
  if (expectedRevision && expectedRevision !== current.revision) {
    throw conflict("revision_conflict", "Global revision does not match.");
  }
  const next: StoredDocument = {
    ...current,
    data: options.replace ? asObject(input.data) : { ...asObject(current.data), ...asObject(input.data) },
    metadata: options.replace ? asObject(input.metadata) : { ...asObject(current.metadata), ...asObject(input.metadata) },
    revision: current.revision + 1,
    updated_at: nowIso()
  };
  await writeJsonAtomic(globalPath(orgId), next);
  return next;
}

export async function listBranchModules(orgId: string, branchId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).listBranchModules(orgId, branchId) as Promise<BranchModuleDocument[]>;
  await readOrganization(orgId);
  const normalizedBranchId = sanitizeId(branchId || "default", "branch_id");
  const root = branchDataDir(orgId, normalizedBranchId);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const modules = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      modules.push(await readJsonFile<BranchModuleDocument>(path.join(root, entry.name)));
    } catch (error) {
      // Ignore incomplete branch module files.
    }
  }
  return modules.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export async function readBranchModule(orgId: string, branchId: string, moduleId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readBranchModule(orgId, branchId, moduleId) as Promise<BranchModuleDocument>;
  await readOrganization(orgId);
  return await readJsonFile<BranchModuleDocument>(branchModulePath(orgId, branchId || "default", moduleId));
}

export async function saveBranchModule(orgId: string, branchId: string, moduleId: string, input: JsonObject = {}, options: { replace?: boolean } = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).saveBranchModule(orgId, branchId, moduleId, input, options) as Promise<BranchModuleDocument>;
  await readOrganization(orgId);
  const normalizedOrgId = sanitizeId(orgId, "organization_id");
  const normalizedBranchId = sanitizeId(branchId || "default", "branch_id");
  const normalizedModuleId = sanitizeId(moduleId, "module_id");
  const filePath = branchModulePath(normalizedOrgId, normalizedBranchId, normalizedModuleId);
  const exists = await pathExists(filePath);
  const now = nowIso();
  const expectedRevision = Number(input.expected_revision ?? 0);
  const inputData = asObject(input.data);
  const inputMetadata = asObject(input.metadata);

  const current = exists ? await readJsonFile<BranchModuleDocument>(filePath) : null;
  if (current && expectedRevision && expectedRevision !== Number(current.revision ?? 0)) {
    throw conflict("revision_conflict", "Branch module revision does not match.");
  }

  const next: BranchModuleDocument = current
    ? {
        ...current,
        data: options.replace ? inputData : { ...asObject(current.data), ...inputData },
        metadata: options.replace ? inputMetadata : { ...asObject(current.metadata), ...inputMetadata },
        revision: Number(current.revision ?? 0) + 1,
        updated_at: now
      }
    : {
        schema_version: PLATFORM_SCHEMA_VERSION,
        id: normalizedModuleId,
        organization_id: normalizedOrgId,
        branch_id: normalizedBranchId,
        module: normalizedModuleId,
        data: inputData,
        metadata: inputMetadata,
        revision: 1,
        created_at: now,
        updated_at: now
      };

  next.metadata = {
    ...asObject(next.metadata),
    kind: "branch_module",
    summary: {
      ...deriveBranchModuleSummary(normalizedModuleId, next.data),
      ...asObject(asObject(next.metadata).summary)
    }
  };

  await writeJsonAtomic(filePath, next);
  await upsertBranchModuleReference(normalizedOrgId, normalizedBranchId, normalizedModuleId, next);
  return next;
}

async function upsertBranchModuleReference(orgId: string, branchId: string, moduleId: string, moduleDoc: BranchModuleDocument) {
  let branch: StoredDocument | null = null;
  try {
    branch = await readDocument(orgId, "branch", branchId);
  } catch (error) {
    branch = null;
  }

  const branchData = asObject(branch?.data);
  const modules = asObject(branchData.modules);
  modules[moduleId] = {
    module_id: moduleId,
    document: branchModuleReferencePath(branchId, moduleId),
    revision: moduleDoc.revision,
    updated_at: moduleDoc.updated_at,
    summary: asObject(moduleDoc.metadata).summary || {}
  };

  await upsertDocument(
    orgId,
    "branch",
    {
      id: branchId,
      data: {
        name: String(branchData.name || (branchId === "default" ? "Default Branch" : branchId)),
        ...branchData,
        modules
      },
      metadata: {
        ...asObject(branch?.metadata),
        kind: "branch"
      }
    },
    { replace: !!branch }
  );
}

export async function readMediaMetadata(orgId: string, mediaId: string) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) return (await postgresStorage()).readMediaMetadata(orgId, mediaId);
  await readOrganization(orgId);
  return await readJsonFile<JsonObject>(mediaMetadataPath(orgId, mediaId));
}

export async function storeMediaUpload(orgId: string, input: MediaUploadOptions) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) return (await postgresStorage()).storeMediaUpload(orgId, input);
  await readOrganization(orgId);
  if (!Buffer.isBuffer(input.bytes) || !input.bytes.length) {
    throw badRequest("empty_media_upload", "The uploaded media file is empty.");
  }

  const normalizedOrgId = sanitizeId(orgId, "organization_id");
  const ownerType = sanitizeId(input.ownerType || "organization", "owner_type");
  const ownerId = sanitizeId(input.ownerId || normalizedOrgId, "owner_id");
  const slot = sanitizeId(input.slot || "media", "slot");
  const mediaId = input.id
    ? sanitizeId(input.id, "media_id")
    : input.replaceSlot
      ? sanitizeId(`${ownerType}_${ownerId}_${slot}`, "media_id")
      : generateId("media");
  const originalFileName = sanitizeFileName(input.fileName, "upload");
  const contentType = String(input.contentType || "application/octet-stream").toLowerCase();
  const ext = extensionForMedia(contentType, originalFileName);
  const mediaRoot = mediaDir(normalizedOrgId, mediaId);
  const originalDir = path.join(mediaRoot, "original");
  const renditionsDir = path.join(mediaRoot, "renditions");
  const markupDir = path.join(mediaRoot, "markup");
  await mkdir(originalDir, { recursive: true });
  await mkdir(renditionsDir, { recursive: true });
  await mkdir(markupDir, { recursive: true });

  const storedOriginalName = `original.${ext}`;
  const originalRelativePath = `original/${storedOriginalName}`;
  await writeFile(path.join(originalDir, storedOriginalName), input.bytes);

  const variants: Record<string, MediaVariant> = {};
  variants.original = {
    path: originalRelativePath,
    content_type: contentType,
    file_name: originalFileName,
    size_bytes: input.bytes.length
  };

  const settings = normalizeProcessingSettings(input.thumbnails, input.compression);
  const kind = mediaKind(contentType);
  let imageWidth: number | null = null;
  let imageHeight: number | null = null;
  const processingWarnings: string[] = [];

  if (kind === "image" && contentType !== "image/svg+xml" && contentType !== "image/gif") {
    try {
      const sharp = (await import("sharp")).default;
      const base = sharp(input.bytes, { failOn: "none" });
      const info = await base.metadata();
      imageWidth = typeof info.width === "number" ? info.width : null;
      imageHeight = typeof info.height === "number" ? info.height : null;
      variants.original.width = imageWidth;
      variants.original.height = imageHeight;
      const largestDimension = Math.max(imageWidth || 0, imageHeight || 0);
      const isLargeImage = largestDimension >= settings.thumbnails.largeThreshold;

      if (settings.compression.enabled && largestDimension > settings.compression.maxWidth) {
        const format = settings.compression.format;
        const variantName = settings.compression.variant || `display_${settings.compression.maxWidth}`;
        const fileName = `${variantName}.${extensionForFormat(format)}`;
        const generated = await renderImageVariant(sharp, input.bytes, {
          width: settings.compression.maxWidth,
          format,
          quality: settings.compression.quality
        });
        await writeFile(path.join(renditionsDir, fileName), generated.bytes);
        variants[variantName] = {
          path: `renditions/${fileName}`,
          content_type: contentTypeForFormat(format),
          file_name: fileName,
          size_bytes: generated.bytes.length,
          width: generated.width,
          height: generated.height
        };
      }

      if (settings.thumbnails.enabled && (!settings.thumbnails.largeOnly || isLargeImage)) {
        for (const size of settings.thumbnails.sizes) {
          const variantName = `thumb_${size}`;
          const format = settings.thumbnails.format;
          const fileName = `${variantName}.${extensionForFormat(format)}`;
          const generated = await renderImageVariant(sharp, input.bytes, {
            width: size,
            height: size,
            fit: "inside",
            format,
            quality: settings.thumbnails.quality
          });
          await writeFile(path.join(renditionsDir, fileName), generated.bytes);
          variants[variantName] = {
            path: `renditions/${fileName}`,
            content_type: contentTypeForFormat(format),
            file_name: fileName,
            size_bytes: generated.bytes.length,
            width: generated.width,
            height: generated.height
          };
        }
      }
    } catch (error) {
      processingWarnings.push(error instanceof Error ? error.message : "Image processing failed.");
    }
  }

  const now = nowIso();
  const markup = await writeInitialMarkup(normalizedOrgId, mediaId, input.markup);
  const metadata = {
    schema_version: PLATFORM_SCHEMA_VERSION,
    id: mediaId,
    organization_id: normalizedOrgId,
    scope: String(input.scope || input.collection || ownerType),
    collection: String(input.collection || ""),
    owner: {
      type: ownerType,
      id: ownerId,
      slot
    },
    kind,
    content_type: contentType,
    file_name: originalFileName,
    size_bytes: input.bytes.length,
    width: imageWidth,
    height: imageHeight,
    variants,
    renditions: Object.entries(variants)
      .filter(([key]) => key !== "original")
      .map(([key, value]) => ({ variant: key, ...value })),
    markup,
    processing: {
      thumbnails: settings.thumbnails,
      compression: settings.compression,
      warnings: processingWarnings
    },
    metadata: asObject(input.metadata),
    created_at: now,
    updated_at: now
  };

  await writeJsonAtomic(mediaMetadataPath(normalizedOrgId, mediaId), metadata);
  return metadata;
}

async function renderImageVariant(
  sharp: unknown,
  bytes: Buffer,
  options: { width: number; height?: number; fit?: "inside" | "cover"; format: "webp" | "jpeg" | "png"; quality: number }
) {
  const factory = sharp as (input: Buffer, options?: JsonObject) => {
    rotate: () => {
      resize: (options: JsonObject) => {
        webp: (options: JsonObject) => { toBuffer: (options?: JsonObject) => Promise<{ data: Buffer; info: { width?: number; height?: number } }> };
        jpeg: (options: JsonObject) => { toBuffer: (options?: JsonObject) => Promise<{ data: Buffer; info: { width?: number; height?: number } }> };
        png: (options: JsonObject) => { toBuffer: (options?: JsonObject) => Promise<{ data: Buffer; info: { width?: number; height?: number } }> };
      };
    };
  };
  const pipeline = factory(bytes, { failOn: "none" }).rotate().resize({
    width: options.width,
    height: options.height,
    fit: options.fit || "inside",
    withoutEnlargement: true
  });
  const output = options.format === "jpeg"
    ? pipeline.jpeg({ quality: options.quality, mozjpeg: true })
    : options.format === "png"
      ? pipeline.png({ compressionLevel: 9 })
      : pipeline.webp({ quality: options.quality });
  const result = await output.toBuffer({ resolveWithObject: true });
  return {
    bytes: result.data,
    width: typeof result.info.width === "number" ? result.info.width : null,
    height: typeof result.info.height === "number" ? result.info.height : null
  };
}

async function writeInitialMarkup(orgId: string, mediaId: string, input: unknown) {
  const markup = asObject(input);
  const rawLayers = Array.isArray(markup.layers) ? markup.layers : [];
  const layers = [];
  for (const rawLayer of rawLayers) {
    const layer = asObject(rawLayer);
    const layerId = sanitizeId(String(layer.id || layer.layer_id || `layer_${layers.length + 1}`), "markup_layer_id");
    const saved = await writeMediaMarkupLayerFile(orgId, mediaId, layerId, asObject(layer.data ?? layer.markup ?? layer), {
      name: String(layer.name || layerId),
      source: String(layer.source || "upload")
    });
    layers.push({
      id: layerId,
      path: `markup/${layerId}.json`,
      revision: saved.revision,
      updated_at: saved.updated_at,
      name: String(layer.name || layerId),
      source: String(layer.source || "upload")
    });
  }
  return {
    layers,
    current_layer_id: String(markup.current_layer_id || markup.currentLayerId || layers[0]?.id || "") || null
  };
}

export async function readMediaMarkupLayer(orgId: string, mediaId: string, layerId: string) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) return (await postgresStorage()).readMediaMarkupLayer(orgId, mediaId, layerId);
  await readMediaMetadata(orgId, mediaId);
  return await readJsonFile<JsonObject>(mediaMarkupPath(orgId, mediaId, layerId));
}

export async function saveMediaMarkupLayer(orgId: string, mediaId: string, layerId: string, data: JsonObject = {}, metadata: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) return (await postgresStorage()).saveMediaMarkupLayer(orgId, mediaId, layerId, data, metadata);
  const normalizedOrgId = sanitizeId(orgId, "organization_id");
  const normalizedMediaId = sanitizeId(mediaId, "media_id");
  const normalizedLayerId = sanitizeId(layerId, "markup_layer_id");
  const layer = await writeMediaMarkupLayerFile(normalizedOrgId, normalizedMediaId, normalizedLayerId, data, metadata);

  let media = await readMediaMetadata(normalizedOrgId, normalizedMediaId);
  const markup = asObject(media.markup);
  const layers = Array.isArray(markup.layers) ? markup.layers.map((entry) => asObject(entry)) : [];
  const reference = {
    id: normalizedLayerId,
    path: `markup/${normalizedLayerId}.json`,
    revision: layer.revision,
    updated_at: layer.updated_at,
    ...asObject(metadata)
  };
  const index = layers.findIndex((entry) => String(entry.id || entry.layer_id) === normalizedLayerId);
  if (index >= 0) layers[index] = { ...layers[index], ...reference };
  else layers.push(reference);
  media = {
    ...media,
    markup: {
      ...markup,
      layers,
      current_layer_id: markup.current_layer_id || normalizedLayerId
    },
    updated_at: nowIso()
  };
  await writeJsonAtomic(mediaMetadataPath(normalizedOrgId, normalizedMediaId), media);
  return { media, layer };
}

async function writeMediaMarkupLayerFile(orgId: string, mediaId: string, layerId: string, data: JsonObject = {}, metadata: JsonObject = {}) {
  await readOrganization(orgId);
  const normalizedOrgId = sanitizeId(orgId, "organization_id");
  const normalizedMediaId = sanitizeId(mediaId, "media_id");
  const normalizedLayerId = sanitizeId(layerId, "markup_layer_id");
  const now = nowIso();
  const filePath = mediaMarkupPath(normalizedOrgId, normalizedMediaId, normalizedLayerId);
  let existing: JsonObject | null = null;
  try {
    existing = await readJsonFile<JsonObject>(filePath);
  } catch (error) {
    existing = null;
  }
  const layer = {
    schema_version: PLATFORM_SCHEMA_VERSION,
    id: normalizedLayerId,
    media_id: normalizedMediaId,
    organization_id: normalizedOrgId,
    data: asObject(data),
    metadata: { ...asObject(existing?.metadata), ...asObject(metadata) },
    revision: Number(existing?.revision ?? 0) + 1,
    created_at: String(existing?.created_at || now),
    updated_at: now
  };
  await writeJsonAtomic(filePath, layer);
  return layer;
}

export async function listMedia(orgId: string) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) return (await postgresStorage()).listMedia(orgId);
  await readOrganization(orgId);
  const root = path.join(orgDir(orgId), "media");
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const media = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      media.push(await readJsonFile<JsonObject>(mediaMetadataPath(orgId, entry.name)));
    } catch (error) {
      // Ignore incomplete media folders.
    }
  }
  return media.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function mediaStorageUsage(orgId: string) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) return (await postgresStorage()).mediaStorageUsage(orgId);
  const media = await listMedia(orgId);
  const usedBytes = media.reduce<number>((total, item) => {
    const variants = asObject(item.variants);
    const variantBytes = Object.values(variants).reduce<number>((sum, variant) => {
      const entry = asObject(variant);
      return sum + Math.max(0, Number(entry.size_bytes || 0));
    }, 0);
    return total + (variantBytes || Math.max(0, Number(item.size_bytes || 0)));
  }, 0);
  return {
    organization_id: sanitizeId(orgId, "organization_id"),
    used_bytes: usedBytes,
    media_count: media.length,
    updated_at: nowIso()
  };
}

export async function readMediaFile(orgId: string, mediaId: string, variantValue = "original") {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) return (await postgresStorage()).readMediaFile(orgId, mediaId, variantValue);
  const metadata = await readMediaMetadata(orgId, mediaId);
  const variant = sanitizeId(variantValue || "original", "variant");
  const variants = asObject(metadata.variants);
  const entry = asObject(variants[variant]);
  const relativePath = String(entry.path || "");
  if (!relativePath || relativePath.includes("..") || path.isAbsolute(relativePath)) {
    throw notFound("media_variant_not_found", "The requested media variant was not found.");
  }
  const filePath = path.join(mediaDir(orgId, mediaId), relativePath);
  return {
    metadata,
    variant,
    contentType: String(entry.content_type || metadata.content_type || "application/octet-stream"),
    fileName: String(entry.file_name || metadata.file_name || `${mediaId}`),
    bytes: await readFile(filePath)
  };
}
