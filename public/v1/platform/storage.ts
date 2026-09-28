
import { formatIdentityPhone, identifierLooksLikeEmail, normalizeIdentityPhone } from "./identity_phone.js";

function registrationLockRoot() {
  return path.join(authIndexRoot(), "registration_locks");
}

function identityLockRoot() {
  return path.join(authIndexRoot(), "identity_locks");
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
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { isSpacesArtifactStorageEnabled } from "../src/storage/project_artifacts.js";
import { badRequest, conflict, notFound } from "./errors.js";

export type JsonObject = Record<string, unknown>;
export type PlatformCollection = "organization_custom_fields" | "notification_devices" | "publication_executions" | "project_datasets" | "project_dataset_revisions" | "document_modules" | "document_module_versions" | "document_module_instances" | "document_module_executions" | "publication_bindings" | "publication_snapshots" | "users" | "projects" | "customers" | "branch" | "notifications" | "attention_banners" | "action_items" | "activity" | "customer_portals" | "public_links" | "calendar_events" | "onboarding_events" | "proposals" | "proposal_snapshots" | "proposal_events" | "material_lists" | "material_list_versions" | "material_orders" | "material_deliveries" | "material_events" | "recurrence_series" | "recurrence_occurrences" | "payment_schedules" | "payment_obligations" | "payment_transactions" | "payment_allocations" | "payment_intents" | "payment_payables" | "payment_disbursements" | "payment_ledger_events" | "payment_events" | "payment_expense_items" | "payment_expense_overrides" | "payment_receipts" | "payment_invoices" | "payment_merchant_config" | "payment_provider_events" | "payment_provider_mock" | "payment_payouts" | "payment_disputes" | "payment_saved_methods" | "payment_autopay" | "feedback_requests" | "document_templates" | "document_template_versions" | "documents" | "document_snapshots" | "document_events" | "document_themes" | "document_theme_versions" | "document_workflows" | "document_workflow_versions" | "document_folders" | "document_folder_items" | "document_folder_item_versions" | "contact_imports" | "websites" | "website_pages" | "website_page_versions" | "website_events" | "domain_quotes" | "domain_registrations" | "domain_events";

const COLLECTIONS: PlatformCollection[] = ["organization_custom_fields","notification_devices","publication_executions","project_datasets","project_dataset_revisions","document_modules","document_module_versions","document_module_instances","document_module_executions","publication_bindings","publication_snapshots","users", "projects", "customers", "branch", "notifications", "attention_banners", "action_items", "activity", "customer_portals", "public_links", "calendar_events", "onboarding_events", "proposals", "proposal_snapshots", "proposal_events", "material_lists", "material_list_versions", "material_orders", "material_deliveries", "material_events", "recurrence_series", "recurrence_occurrences", "payment_schedules", "payment_obligations", "payment_transactions", "payment_allocations", "payment_intents", "payment_payables", "payment_disbursements", "payment_ledger_events", "payment_events", "payment_expense_items", "payment_expense_overrides", "payment_receipts", "payment_invoices", "payment_merchant_config", "payment_provider_events", "payment_provider_mock", "payment_payouts", "payment_disputes", "payment_saved_methods", "payment_autopay", "feedback_requests", "document_templates", "document_template_versions", "documents", "document_snapshots", "document_events", "document_themes", "document_theme_versions", "document_workflows", "document_workflow_versions", "document_folders", "document_folder_items", "document_folder_item_versions", "contact_imports", "websites", "website_pages", "website_page_versions", "website_events", "domain_quotes", "domain_registrations", "domain_events"];
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

function accountDevicesRoot() {
  return path.join(sessionsRoot(), "account_devices");
}

function emailIndexRoot() {
  return path.join(authIndexRoot(), "email");
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
  if (collection === "attention_banners") return "attention";
  if (collection === "action_items") return "action_item";
  if (collection === "activity") return "activity";
  if (collection === "customer_portals") return "customer_portal";
  if (collection === "public_links") return "public_link";
  if (collection === "calendar_events") return "calendar_event";
  if (collection === "onboarding_events") return "onboarding_event";
  if (collection === "proposals") return "proposal";
  if (collection === "proposal_snapshots") return "proposal_snapshot";
  if (collection === "proposal_events") return "proposal_event";
  if (collection === "material_lists") return "material_list";
  if (collection === "material_list_versions") return "material_version";
  if (collection === "material_orders") return "material_order";
  if (collection === "material_deliveries") return "material_delivery";
  if (collection === "material_events") return "material_event";
  if (collection === "recurrence_series") return "recurrence_series";
  if (collection === "recurrence_occurrences") return "recurrence_occurrence";
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

function markupNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function markupUnit(value: unknown) {
  return Math.max(0, Math.min(1, markupNumber(value)));
}

function markupXml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function markupColor(value: unknown, fallback = "#111111") {
  const color = String(value ?? "").trim();
  return /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(color) ? color : fallback;
}

function markupArrowParts(item: JsonObject) {
  const x1 = markupUnit(item.x1);
  const y1 = markupUnit(item.y1);
  const x2 = markupUnit(item.x2);
  const y2 = markupUnit(item.y2);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const length = 0.035;
  const spread = Math.PI / 7;
  return [
    { x1, y1, x2, y2 },
    { x1: x2, y1: y2, x2: x2 - Math.cos(angle - spread) * length, y2: y2 - Math.sin(angle - spread) * length },
    { x1: x2, y1: y2, x2: x2 - Math.cos(angle + spread) * length, y2: y2 - Math.sin(angle + spread) * length }
  ];
}

function wrapMarkupThumbnailText(value: unknown, maxWidth: number, fontSize: number) {
  const maxChars = Math.max(1, Math.floor(maxWidth / Math.max(1, fontSize * 0.58)));
  const output: string[] = [];
  String(value ?? "").replace(/\r/g, "").split("\n").forEach((sourceLine) => {
    const words = sourceLine.split(/\s+/).filter(Boolean);
    if (!words.length) {
      output.push(" ");
      return;
    }
    let line = "";
    words.forEach((word) => {
      const next = line ? `${line} ${word}` : word;
      if (line && next.length > maxChars) {
        output.push(line);
        line = word;
      } else {
        line = next;
      }
    });
    output.push(line || " ");
  });
  return output.length ? output : [" "];
}

function markupThumbnailSvg(data: JsonObject, width: number, height: number) {
  const items = Array.isArray(data.items) ? data.items.map((entry) => asObject(entry)) : [];
  if (!items.length) return "";
  const strokeScale = Math.max(1, Math.sqrt(width * height) / 100);
  const elements: string[] = [];
  items.forEach((item) => {
    const color = markupColor(item.color);
    if (item.type === "stroke") {
      const points = Array.isArray(item.points) ? item.points.map((entry) => asObject(entry)) : [];
      if (!points.length) return;
      const pathData = points.map((point, index) => `${index ? "L" : "M"}${(markupUnit(point.x) * width).toFixed(2)} ${(markupUnit(point.y) * height).toFixed(2)}`).join(" ");
      const strokeWidth = Math.max(1, markupNumber(item.size, 2.2) * strokeScale);
      elements.push(`<path d="${pathData}" fill="none" stroke="${markupXml(color)}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
      return;
    }
    if (item.type === "arrow") {
      const strokeWidth = Math.max(1, markupNumber(item.size, 2.8) * strokeScale);
      markupArrowParts(item).forEach((part) => {
        elements.push(`<line x1="${(part.x1 * width).toFixed(2)}" y1="${(part.y1 * height).toFixed(2)}" x2="${(part.x2 * width).toFixed(2)}" y2="${(part.y2 * height).toFixed(2)}" stroke="${markupXml(color)}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linecap="round"/>`);
      });
      return;
    }
    if (item.type !== "text") return;
    const x = markupUnit(item.x) * width;
    const y = markupUnit(item.y) * height;
    const boxWidth = Math.max(1, markupNumber(item.width, 0.24) * width);
    const boxHeight = Math.max(1, markupNumber(item.height, 0.07) * height);
    const explicitLines = String(item.text ?? "").split("\n").length || 1;
    const fontSize = Math.max(8, (boxHeight - 8) / Math.max(1, explicitLines * 1.14));
    const lines = wrapMarkupThumbnailText(item.text, Math.max(20, boxWidth - 10), fontSize);
    elements.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${boxWidth.toFixed(2)}" height="${boxHeight.toFixed(2)}" rx="${Math.max(1, fontSize * 0.18).toFixed(2)}" fill="white" fill-opacity="0.72"/>`);
    const tspans = lines.map((line, index) => `<tspan x="${(x + 5).toFixed(2)}" y="${(y + 4 + index * fontSize * 1.14).toFixed(2)}">${markupXml(line)}</tspan>`).join("");
    elements.push(`<text fill="${markupXml(color)}" font-family="Arial, sans-serif" font-size="${fontSize.toFixed(2)}" font-weight="700" dominant-baseline="text-before-edge">${tspans}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join("")}</svg>`;
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

const documentMutationTails = new Map<string, Promise<void>>();

async function withDocumentMutationLock<T>(filePath: string, work: () => Promise<T>) {
  const previous = documentMutationTails.get(filePath) || Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  documentMutationTails.set(filePath, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (documentMutationTails.get(filePath) === tail) documentMutationTails.delete(filePath);
  }
}

async function writeFileAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, content);
    // Windows: rename-over-existing races with concurrent readers/writers of
    // the same record (e.g. parallel requests touching one session file) and
    // surfaces as EPERM/EACCES. Retry briefly before giving up.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rename(tempPath, filePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EPERM", "EEXIST", "EACCES"].includes(String(code))) throw error;
        lastError = error;
        await rm(filePath, { force: true }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
      }
    }
    throw lastError;
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function withIdentityRegistrationLock<T>(emailValue: string, operation: () => Promise<T>): Promise<T> {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).withIdentityRegistrationLock(emailValue, operation);
  const email = normalizeEmail(emailValue);
  return await withFileLock(path.join(registrationLockRoot(), `${hashId(email)}.lock`), operation);
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function accountDevicePath(deviceId: string) {
  return path.join(accountDevicesRoot(), `${hashId(deviceId)}.json`);
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

function projectContactText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedContactTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of raw) {
    const tag = projectContactText(entry).replace(/\s+/g, " ").slice(0, 80);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, 64);
}

function normalizedProjectContact(value: unknown) {
  const contact = asObject(value);
  const id = projectContactText(contact.id || contact.contact_id);
  return {
    id,
    contact_id: id,
    name: projectContactText(contact.name || contact.full_name || contact.display_name),
    email: projectContactText(contact.email || contact.email_address).toLowerCase(),
    phone: projectContactText(contact.phone || contact.phone_number || contact.mobile),
    address: projectContactText(contact.address || contact.default_address),
    default_address: projectContactText(contact.default_address || contact.address),
    role: projectContactText(contact.role),
    company: projectContactText(contact.company || contact.organization),
    notes: projectContactText(contact.notes),
    birthday: projectContactText(contact.birthday),
    tags: normalizedContactTags(contact.tags),
    custom_field_values: asObject(contact.custom_field_values || contact.contact_custom_field_values),
    imported_at: projectContactText(contact.imported_at),
    import_id: projectContactText(contact.import_id),
    import_source: projectContactText(contact.import_source),
    primary: contact.primary === true
  };
}

function projectContactHasIdentity(contact: ReturnType<typeof normalizedProjectContact>) {
  return !!(contact.id || contact.name || contact.email || contact.phone || contact.address);
}

function projectContactSemanticKey(contact: ReturnType<typeof normalizedProjectContact>) {
  if (contact.email) return `email:${contact.email}`;
  const phone = contact.phone.replace(/\D+/g, "");
  if (phone.length >= 7) return `phone:${phone}`;
  const name = contact.name.toLowerCase().replace(/\s+/g, " ").trim();
  return name ? `name:${name}` : "";
}

function mergeProjectContacts(
  current: ReturnType<typeof normalizedProjectContact>,
  incoming: ReturnType<typeof normalizedProjectContact>
) {
  const id = incoming.id || current.id;
  return {
    id,
    contact_id: id,
    name: incoming.name || current.name,
    email: incoming.email || current.email,
    phone: incoming.phone || current.phone,
    address: incoming.address || current.address,
    default_address: incoming.default_address || current.default_address || incoming.address || current.address,
    role: incoming.role || current.role,
    company: incoming.company || current.company,
    notes: incoming.notes || current.notes,
    birthday: incoming.birthday || current.birthday,
    tags: normalizedContactTags([...current.tags, ...incoming.tags]),
    custom_field_values: { ...current.custom_field_values, ...incoming.custom_field_values },
    imported_at: current.imported_at || incoming.imported_at,
    import_id: current.import_id || incoming.import_id,
    import_source: current.import_source || incoming.import_source,
    primary: current.primary || incoming.primary
  };
}

function stableProjectContactId(projectId: string, index: number) {
  return `contact_${hashId(`${projectId}:contact:${index}`).slice(0, 16)}`;
}

function normalizeProjectDataContacts(projectId: string, data: JsonObject, previousData: JsonObject = {}): JsonObject {
  const incoming = (Array.isArray(data.contacts) ? data.contacts : [])
    .map(normalizedProjectContact)
    .filter(projectContactHasIdentity);
  const previous = (Array.isArray(previousData.contacts) ? previousData.contacts : [])
    .map(normalizedProjectContact)
    .filter(projectContactHasIdentity);
  const topLevelId = projectContactText(data.contact_id || data.primary_contact_id);
  const alias = normalizedProjectContact({
    id: topLevelId,
    name: data.customer_name || data.customerName || data.primary_contact_name || data.resident_name || data.residentName || (typeof data.resident === "string" ? data.resident : ""),
    email: data.customer_email || data.customerEmail || data.primary_contact_email || data.resident_email || data.residentEmail,
    phone: data.customer_phone || data.customerPhone || data.primary_contact_phone || data.resident_phone || data.residentPhone,
    address: data.contact_address || data.customer_address || data.primary_contact_address,
    primary: true
  });

  if (projectContactHasIdentity(alias)) {
    const aliasSemanticKey = projectContactSemanticKey(alias);
    let aliasIndex = incoming.findIndex((contact) => alias.id && contact.id === alias.id);
    if (aliasIndex < 0 && aliasSemanticKey) {
      aliasIndex = incoming.findIndex((contact) => projectContactSemanticKey(contact) === aliasSemanticKey && (!contact.id || !alias.id));
    }
    if (aliasIndex < 0 && alias.id) aliasIndex = incoming.findIndex((contact) => !contact.id && contact.primary);
    if (aliasIndex < 0 && alias.id) aliasIndex = incoming.findIndex((contact) => !contact.id);
    if (aliasIndex >= 0) incoming[aliasIndex] = mergeProjectContacts(alias, incoming[aliasIndex]!);
    else if (alias.id || !incoming.length) incoming.unshift(alias);
  }

  const merged: ReturnType<typeof normalizedProjectContact>[] = [];
  for (const contact of incoming) {
    const semanticKey = projectContactSemanticKey(contact);
    const existingIndex = merged.findIndex((candidate) => (
      !!(candidate.id && contact.id && candidate.id === contact.id)
      || !!(semanticKey && semanticKey === projectContactSemanticKey(candidate) && (!candidate.id || !contact.id))
    ));
    if (existingIndex >= 0) merged[existingIndex] = mergeProjectContacts(merged[existingIndex]!, contact);
    else merged.push(contact);
  }

  const usedPreviousIds = new Set<string>();
  const contacts = merged.map((contact, index) => {
    let id = contact.id;
    if (!id) {
      const semanticKey = projectContactSemanticKey(contact);
      let previousMatch = semanticKey
        ? previous.find((candidate) => candidate.id && !usedPreviousIds.has(candidate.id) && projectContactSemanticKey(candidate) === semanticKey)
        : undefined;
      if (!previousMatch && previous[index]?.id && !usedPreviousIds.has(previous[index].id)) previousMatch = previous[index];
      id = previousMatch?.id || (index === 0 ? topLevelId : "") || stableProjectContactId(projectId, index);
    }
    usedPreviousIds.add(id);
    return { ...contact, id, contact_id: id };
  });

  if (!contacts.length) return { ...data, contacts: [] };
  let primaryIndex = contacts.findIndex((contact) => topLevelId && contact.id === topLevelId);
  if (primaryIndex < 0) primaryIndex = contacts.findIndex((contact) => contact.primary);
  if (primaryIndex < 0) primaryIndex = 0;
  contacts.forEach((contact, index) => { contact.primary = index === primaryIndex; });
  const primary = contacts[primaryIndex]!;
  const contactIds = Array.from(new Set(contacts.map((contact) => contact.id).filter(Boolean)));
  return {
    ...data,
    contacts,
    contact_id: primary.id,
    primary_contact_id: primary.id,
    contact_ids: contactIds,
    customer_name: primary.name || projectContactText(data.customer_name),
    primary_contact_name: primary.name || projectContactText(data.primary_contact_name),
    customer_email: primary.email || projectContactText(data.customer_email),
    primary_contact_email: primary.email || projectContactText(data.primary_contact_email),
    customer_phone: primary.phone || projectContactText(data.customer_phone),
    primary_contact_phone: primary.phone || projectContactText(data.primary_contact_phone)
  };
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
  await mkdir(accountDevicesRoot(), { recursive: true });
  await mkdir(emailIndexRoot(), { recursive: true });
}

/**
 * A browser-owned account bundle. The opaque device id is the only value placed
 * in a cookie; the referenced session ids remain server-side.
 */
export async function createAccountDevice(input: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).createAccountDevice(input);
  await ensurePlatformStorage();
  const now = nowIso();
  const deviceId = randomBytes(32).toString("base64url");
  const record = {
    schema_version: PLATFORM_SCHEMA_VERSION,
    id_hash: hashId(deviceId),
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    accounts: Array.isArray(input.accounts) ? input.accounts : [],
    metadata: asObject(input.metadata)
  };
  await writeJsonAtomic(accountDevicePath(deviceId), record);
  return { deviceId, record };
}

export async function readAccountDevice(deviceId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readAccountDevice(deviceId);
  await ensurePlatformStorage();
  return await readJsonFile<JsonObject>(accountDevicePath(deviceId));
}

export async function saveAccountDevice(deviceId: string, input: JsonObject) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).saveAccountDevice(deviceId, input);
  await ensurePlatformStorage();
  const existing = await readAccountDevice(deviceId).catch(() => null);
  if (!existing) throw notFound("account_device_not_found", "The remembered account device was not found.");
  const now = nowIso();
  const next = {
    ...existing,
    ...input,
    id_hash: hashId(deviceId),
    created_at: String(existing.created_at || now),
    updated_at: now,
    last_seen_at: now,
    accounts: Array.isArray(input.accounts) ? input.accounts : (Array.isArray(existing.accounts) ? existing.accounts : []),
    metadata: { ...asObject(existing.metadata), ...asObject(input.metadata) }
  };
  await writeJsonAtomic(accountDevicePath(deviceId), next);
  return next;
}

export async function deleteAccountDevice(deviceId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).deleteAccountDevice(deviceId);
  await ensurePlatformStorage();
  await rm(accountDevicePath(deviceId), { force: true });
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

export async function rotateAuthSessionCsrf(sessionId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).rotateAuthSessionCsrf(sessionId);
  const session = await readAuthSession(sessionId);
  const next = {
    ...session,
    csrf_token: randomBytes(24).toString("base64url"),
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

/** Consume a phone sign-in ticket once, including across web workers. */
export async function consumeMobileAuthSession(sessionId: string, challenge: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).consumeMobileAuthSession(sessionId, challenge);
  return withFileLock(sessionPath(sessionId) + ".consume-lock", async () => {
    const session = await readAuthSession(sessionId);
    if (asObject(session.metadata).mobile_pkce !== challenge) throw notFound("handoff_invalid", "This app sign-in has expired or is invalid.");
    await deleteAuthSession(sessionId);
    return session;
  });
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
  // Dynamic import: work/engine imports this module, so a static import would
  // be a cycle. Never let event emission break organization creation.
  try {
    const { emitWorkEvent } = await import("../work/engine.js");
    await emitWorkEvent({
      organization_id: id,
      type: "organization.created",
      idempotency_key: `organization.created:${id}`,
      payload: { organization_id: id, name: organization.name }
    });
  } catch {
    // Event emission must not abort organization creation.
  }
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
  return documents
    .map((document) => collection === "projects"
      ? { ...document, data: normalizeProjectDataContacts(document.id, asObject(document.data)) }
      : document)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function readDocument(orgId: string, collectionValue: string, documentId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readDocument(orgId, collectionValue, documentId) as Promise<StoredDocument>;
  const collection = assertCollection(collectionValue);
  await readOrganization(orgId);
  const document = await readJsonFile<StoredDocument>(documentPath(orgId, collection, documentId));
  return collection === "projects"
    ? { ...document, data: normalizeProjectDataContacts(document.id, asObject(document.data)) }
    : document;
}

export async function upsertDocument(orgId: string, collectionValue: string, input: JsonObject = {}, options: { replace?: boolean; createOnly?: boolean } = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).upsertDocument(orgId, collectionValue, input, options) as Promise<StoredDocument>;
  const collection = assertCollection(collectionValue);
  await readOrganization(orgId);
  const id = input.id ? sanitizeId(String(input.id), "document_id") : generateId(generatedDocumentPrefix(collection));
  const filePath = documentPath(orgId, collection, id);
  return await withDocumentMutationLock(filePath, async () => {
    const exists = await pathExists(filePath);
    const now = nowIso();
    let data = asObject(input.data);
    const metadata = asObject(input.metadata);
    const expectedRevision = Number(input.expected_revision ?? 0);

    if (exists && options.createOnly) throw conflict("document_exists", "This immutable record already exists.");
    if (!exists && expectedRevision) throw conflict("revision_conflict", "The expected document no longer exists.");

    if (["projects", "customers", "organization_custom_fields"].includes(collection)) {
      const previous = exists ? asObject((await readJsonFile<StoredDocument>(filePath)).data) : {};
      const fields = await import("../custom_fields/records.js");
      data = await fields.prepareStoredFields(orgId, collection, data, previous);
      await fields.validateStoredFields(orgId, collection, data, previous, options.replace);
    }
    if (!exists) {
      const created: StoredDocument = {
        schema_version: PLATFORM_SCHEMA_VERSION,
        id,
        organization_id: sanitizeId(orgId, "organization_id"),
        collection,
        data: collection === "projects" ? normalizeProjectDataContacts(id, data) : data,
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
    const nextData = options.replace ? data : { ...asObject(current.data), ...data };
    const next: StoredDocument = {
      ...current,
      data: collection === "projects" ? normalizeProjectDataContacts(id, nextData, asObject(current.data)) : nextData,
      metadata: options.replace ? metadata : { ...asObject(current.metadata), ...metadata },
      revision: current.revision + 1,
      updated_at: now
    };
    await writeJsonAtomic(filePath, next);
    return next;
  });
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

// The callback is synchronous and must contain no provider calls or queries.
// Compute read/modify/write values under the same lock instead of saving a
// balance/ledger that was derived from a stale readGlobal snapshot.
export async function mutateGlobal(orgId: string, mutation: (current: JsonObject) => JsonObject) {
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).mutateGlobal(orgId, mutation) as Promise<StoredDocument>;
  const normalizedId = sanitizeId(orgId, "organization_id");
  const lockPath = path.join(path.dirname(globalPath(normalizedId)), ".global-mutation.lock");
  return withFileLock(lockPath, async () => {
    const current = await readGlobal(normalizedId);
    const patch = mutation(current);
    return saveGlobal(normalizedId, { ...patch, expected_revision: current.revision });
  });
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
  if(moduleId==='variable_mappings' && input.data!==undefined){
    const {terminologyMappingsSchema}=await import('./localization/terminology-schema.js');
    input={...input,data:terminologyMappingsSchema.parse(input.data)};
  }
  if (moduleId === "custom_fields" && Array.isArray(asObject(input.data).fields)) {
    const fields = (await import("../custom_fields/contracts.js")).normalizeDefinitions(asObject(input.data).fields);
    if (branchId !== "default" && fields.some(f => f.entity === "organization")) throw badRequest("custom_field_organization_branch", "Organization definitions belong to the default branch.");
    const previous = await (await import("../custom_fields/records.js")).optional(() => readBranchModule(orgId, branchId || "default", moduleId));
    const prior = asObject(previous?.data);
    const identity = (f:JsonObject) => `${String(f.entity || "project")}:${String(f.path || f.key)}`;
    const active = new Set(fields.map(identity));
    const retired = new Map<string,JsonObject>();
    for (const raw of [...(Array.isArray(prior.retired_fields) ? prior.retired_fields : []), ...(Array.isArray(prior.fields) ? prior.fields : [])]) {
      const field = asObject(raw);
      if (!active.has(identity(field))) retired.set(identity(field),{...field,enabled:false,read_only:true,retired:true});
    }
    input = { ...input, data:{ ...asObject(input.data), fields, retired_fields:[...retired.values()] } };
  }
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

export function normalizeMediaTags(value: unknown) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(values
    .map((entry) => String(entry ?? "")
      .trim()
      .replace(/^#+/, "")
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_-]/g, "")
      .replace(/^[_-]+|[_-]+$/g, "")
      .slice(0, 64))
    .filter(Boolean))]
    .slice(0, 50);
}

async function mutateMediaMetadata(orgId: string, mediaId: string, mutate: (media: JsonObject) => JsonObject) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) return (await postgresStorage()).mutateMediaMetadata(orgId, mediaId, mutate);
  const file = mediaMetadataPath(orgId, mediaId);
  return withDocumentMutationLock(file, async () => {
    const next = mutate(await readMediaMetadata(orgId, mediaId));
    await writeJsonAtomic(file, next);
    return next;
  });
}

export async function updateMediaTags(orgId: string, mediaId: string, tagsValue: unknown) {
  const normalizedOrgId = sanitizeId(orgId, "organization_id");
  const normalizedMediaId = sanitizeId(mediaId, "media_id");
  return await mutateMediaMetadata(normalizedOrgId, normalizedMediaId, (media) => {
    const tags = normalizeMediaTags(tagsValue);
    const next = {
      ...media,
      tags,
      metadata: {
        ...asObject(media.metadata),
        tags
      },
      updated_at: nowIso()
    };
    return next;
  });
}

/* Renames a media item for display. The stored file path is derived from the
 * media id, so only the human-facing name changes; the extension is preserved
 * from the existing file name so downloads keep opening in the right app. */
export async function renameMedia(orgId: string, mediaId: string, nameValue: unknown) {
  const normalizedOrgId = sanitizeId(orgId, "organization_id");
  const normalizedMediaId = sanitizeId(mediaId, "media_id");
  const requested = String(nameValue ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\-\s]+/, "")
    .trim()
    .slice(0, 160);
  if (!requested) throw badRequest("media_name_required", "A media name is required.");
  return await mutateMediaMetadata(normalizedOrgId, normalizedMediaId, (media) => {
    const previousName = String(media.file_name || "");
    const previousExt = /\.([a-z0-9]{1,8})$/i.exec(previousName)?.[1] || "";
    const hasExt = previousExt && new RegExp(`\\.${previousExt}$`, "i").test(requested);
    const fileName = previousExt && !hasExt ? `${requested}.${previousExt}` : requested;
    const base = fileName.replace(/\.[a-z0-9]{1,8}$/i, "") || requested;
    // Downloads read the variant's own file_name first, so rename those too,
    // each keeping its own extension (thumbnails may differ from the original).
    const variants = asObject(media.variants);
    const renamedVariants: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(variants)) {
      const entry = asObject(value);
      const entryName = String(entry.file_name || "");
      const entryExt = /\.([a-z0-9]{1,8})$/i.exec(entryName)?.[1] || previousExt;
      renamedVariants[key] = entryName
        ? { ...entry, file_name: entryExt ? `${base}.${entryExt}` : base }
        : entry;
    }
    const next = {
      ...media,
      file_name: fileName,
      label: requested,
      variants: renamedVariants,
      metadata: {
        ...asObject(media.metadata),
        file_name: fileName,
        label: requested
      },
      updated_at: nowIso()
    };
    return next;
  });
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
  const pendingWrites: {path:string;bytes:Buffer}[] = [{path:path.join(originalDir, storedOriginalName),bytes:input.bytes}];

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
        pendingWrites.push({path:path.join(renditionsDir, fileName),bytes:generated.bytes});
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
          pendingWrites.push({path:path.join(renditionsDir, fileName),bytes:generated.bytes});
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

  const { withStorageAllowance } = await import("../platform-billing/storage-allowance.js");
  return withStorageAllowance(orgId, mediaId, Object.values(variants).reduce((sum,v)=>sum+Number(v.size_bytes||0),0), async()=>{
  for(const file of pendingWrites)await writeFile(file.path,file.bytes);
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
    metadata: {
      ...asObject(input.metadata),
      ...(normalizeMediaTags(asObject(input.metadata).tags).length
        ? { tags: normalizeMediaTags(asObject(input.metadata).tags) }
        : {})
    },
    created_at: now,
    updated_at: now
  };

  await writeJsonAtomic(mediaMetadataPath(normalizedOrgId, mediaId), metadata);
  return metadata;
  });
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

async function refreshMarkupThumbnailVariants(orgId: string, mediaId: string, media: JsonObject, layer: JsonObject) {
  const contentType = String(media.content_type || "").toLowerCase();
  if (String(media.kind || mediaKind(contentType)) !== "image" || contentType === "image/svg+xml") return media;
  const variants = { ...asObject(media.variants) };
  const original = asObject(variants.original);
  const originalPath = String(original.path || "");
  if (!originalPath || originalPath.includes("..") || path.isAbsolute(originalPath)) return media;

  const processing = asObject(media.processing);
  const thumbnailSettings = asObject(processing.thumbnails);
  const configuredSizes = Array.isArray(thumbnailSettings.sizes) ? thumbnailSettings.sizes : [];
  const existingSizes = Object.keys(variants)
    .map((variant) => variant.match(/^thumb_(\d+)$/)?.[1])
    .filter(Boolean);
  const sizes = [...new Set([...configuredSizes, ...existingSizes, 320]
    .map((value) => numberInRange(value, 0, 32, 2400))
    .filter(Boolean))]
    .sort((a, b) => a - b);
  const originalBytes = await readFile(path.join(mediaDir(orgId, mediaId), originalPath));
  const sharp = (await import("sharp")).default;
  const data = asObject(layer.data);
  const generatedVariants: string[] = [];

  for (const size of sizes) {
    const base = await sharp(originalBytes, { failOn: "none" })
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const overlay = markupThumbnailSvg(data, base.info.width, base.info.height);
    const generated = overlay
      ? await sharp(base.data)
        .composite([{ input: Buffer.from(overlay) }])
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true })
      : base;
    const variantName = `thumb_${size}_markup`;
    const fileName = `${variantName}.webp`;
    await writeFile(path.join(mediaDir(orgId, mediaId), "renditions", fileName), generated.data);
    variants[variantName] = {
      path: `renditions/${fileName}`,
      content_type: "image/webp",
      file_name: fileName,
      size_bytes: generated.data.length,
      width: generated.info.width,
      height: generated.info.height,
      updated_at: String(layer.updated_at || nowIso()),
      markup_revision: Number(layer.revision || 0)
    };
    generatedVariants.push(variantName);
  }

  return {
    ...media,
    variants,
    renditions: Object.entries(variants)
      .filter(([key]) => key !== "original")
      .map(([key, value]) => ({ variant: key, ...asObject(value) })),
    markup_thumbnail: {
      layer_id: String(layer.id || "photo_markup"),
      revision: Number(layer.revision || 0),
      updated_at: String(layer.updated_at || nowIso()),
      variants: generatedVariants
    }
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
  const metadataPath = mediaMetadataPath(normalizedOrgId, normalizedMediaId);
  return await withDocumentMutationLock(metadataPath, async () => {
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
    if (normalizedLayerId === "photo_markup" || normalizedLayerId === "markup_photo_markup") {
      media = await refreshMarkupThumbnailVariants(normalizedOrgId, normalizedMediaId, media, layer);
    }
    await writeJsonAtomic(metadataPath, media);
    return { media, layer };
  });
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
  const markupThumbnailSize = variant.match(/^thumb_(\d+)_markup$/)?.[1] || "";
  const requestedEntry = asObject(variants[variant]);
  const fallbackEntry = markupThumbnailSize
    ? asObject(variants[`thumb_${markupThumbnailSize}`] || variants.original)
    : {};
  const entry = Object.keys(requestedEntry).length ? requestedEntry : fallbackEntry;
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

function platformConfigurationPath(name: string) {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(name)) throw badRequest("invalid_configuration_name", "Invalid configuration name.");
  return path.join(storageRoot(), "config", `${name}.json`);
}
export async function readPlatformConfiguration(name: string): Promise<JsonObject | null> {
  const file = platformConfigurationPath(name);
  if (isFirstMeasurePostgresEnabled()) return (await postgresStorage()).readControlDocument("configuration", name);
  try { return await readJsonFile<JsonObject>(file); }
  catch (error) { if ((error as { code?: string; statusCode?: number }).code === "ENOENT" || (error as { statusCode?: number }).statusCode === 404) return null; throw error; }
}
export async function mutatePlatformConfiguration(name: string, mutate: (current: JsonObject | null) => JsonObject): Promise<JsonObject> {
  const file = platformConfigurationPath(name);
  if (isFirstMeasurePostgresEnabled()) return (await (await postgresStorage()).mutateControlDocument("configuration", name, mutate))!;
  return withDocumentMutationLock(file, async () => {
    const next = mutate(await readPlatformConfiguration(name));
    await writeJsonAtomic(file, next);
    return next;
  });
}
