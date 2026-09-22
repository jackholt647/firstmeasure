import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { domainToASCII } from "node:url";

import { env } from "../src/config/env.js";
import { conflict, notFound } from "../platform/errors.js";
import {
  deleteDocument,
  listDocuments,
  readDocument,
  upsertDocument,
  writeJsonAtomic,
  type JsonObject
} from "../platform/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { emitWorkEvent } from "../work/engine.js";
import { WEBSITE_SCHEMA_VERSION } from "./schemas.js";

/**
 * Collection names live in platform/storage.ts COLLECTIONS. The platform
 * storage API accepts plain strings and validates at runtime.
 */
export const WEBSITE_COLLECTION = "websites";
export const WEBSITE_PAGE_COLLECTION = "website_pages";
export const WEBSITE_PAGE_VERSION_COLLECTION = "website_page_versions";
export const WEBSITE_EVENT_COLLECTION = "website_events";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function hashId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function generateSiteId() {
  return `site_${randomBytes(10).toString("hex")}`;
}

export function generatePageId() {
  return `page_${randomBytes(10).toString("hex")}`;
}

/** Compact public URL key: "s" + 10 hex, unique platform-wide (host registry). */
export function generateSiteKey() {
  return `s${randomBytes(5).toString("hex")}`;
}

function documentView(document: JsonObject): JsonObject {
  const data = asObject(document.data);
  return {
    ...data,
    id: cleanText(data.id || document.id),
    revision: Number(document.revision || 0),
    created_at: cleanText(document.created_at || data.created_at),
    updated_at: cleanText(document.updated_at || data.updated_at)
  };
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export async function listSites(orgId: string) {
  const docs = await listDocuments(orgId, WEBSITE_COLLECTION);
  return docs
    .map(documentView)
    .filter((site) => cleanText(site.kind || "website") === "website")
    .sort((a, b) => cleanText(a.name).localeCompare(cleanText(b.name)));
}

export async function readSite(orgId: string, siteId: string) {
  const document = await readDocument(orgId, WEBSITE_COLLECTION, siteId).catch(() => null);
  if (!document) throw notFound("website_not_found", "The requested website was not found.");
  return documentView(document);
}

export async function saveSite(orgId: string, siteId: string, data: JsonObject, options: { expectedRevision?: number } = {}) {
  const next = { ...data };
  delete next.revision;
  let saved: JsonObject;
  try {
    saved = await upsertDocument(orgId, WEBSITE_COLLECTION, {
      id: siteId,
      expected_revision: options.expectedRevision || undefined,
      data: next,
      metadata: {
        kind: "website",
        site_kind: cleanText(data.site_kind),
        site_key: cleanText(data.site_key),
        status: cleanText(data.status)
      }
    }, { replace: true });
  } catch (error) {
    if ((error as { code?: string }).code === "revision_conflict") {
      throw conflict("website_revision_conflict", "The website revision does not match.");
    }
    throw error;
  }
  return documentView(saved);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export async function listSitePages(orgId: string, websiteId: string) {
  const docs = await listDocuments(orgId, WEBSITE_PAGE_COLLECTION);
  return docs
    .map(documentView)
    .filter((page) => cleanText(page.website_id) === websiteId)
    .sort((a, b) => cleanText(a.created_at).localeCompare(cleanText(b.created_at)));
}

export async function readPage(orgId: string, pageId: string) {
  const document = await readDocument(orgId, WEBSITE_PAGE_COLLECTION, pageId).catch(() => null);
  if (!document) throw notFound("website_page_not_found", "The requested website page was not found.");
  return documentView(document);
}

export async function savePage(orgId: string, pageId: string, data: JsonObject, options: { expectedRevision?: number } = {}) {
  const next = { ...data };
  delete next.revision;
  let saved: JsonObject;
  try {
    saved = await upsertDocument(orgId, WEBSITE_PAGE_COLLECTION, {
      id: pageId,
      expected_revision: options.expectedRevision || undefined,
      data: next,
      metadata: {
        kind: "website_page",
        website_id: cleanText(data.website_id),
        role: cleanText(data.role),
        slug: cleanText(data.slug)
      }
    }, { replace: true });
  } catch (error) {
    if ((error as { code?: string }).code === "revision_conflict") {
      throw conflict("website_revision_conflict", "The website page revision does not match.");
    }
    throw error;
  }
  return documentView(saved);
}

export async function deletePageRecord(orgId: string, pageId: string) {
  await deleteDocument(orgId, WEBSITE_PAGE_COLLECTION, pageId).catch(() => null);
}

// ---------------------------------------------------------------------------
// Page versions — immutable rows with deterministic ids (O(1) reads, no scan).
// Mirrors the documents versioned-asset engine (documents/storage.ts:83-288).
// ---------------------------------------------------------------------------

export function pageVersionRowId(orgId: string, pageId: string, version: number) {
  return `page_version_${hashId(`${orgId}:website_page:${pageId}:${version}`)}`;
}

export async function readPageVersion(orgId: string, pageId: string, version: number) {
  if (!Number.isFinite(version) || version <= 0) return null;
  const row = await readDocument(orgId, WEBSITE_PAGE_VERSION_COLLECTION, pageVersionRowId(orgId, pageId, version)).catch(() => null);
  return row ? documentView(row) : null;
}

export async function listPageVersions(orgId: string, pageId: string) {
  const docs = await listDocuments(orgId, WEBSITE_PAGE_VERSION_COLLECTION);
  return docs
    .map(documentView)
    .filter((row) => cleanText(row.kind) === "website_page_version" && cleanText(row.page_id) === pageId)
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
}

export async function createPageVersion(
  orgId: string,
  input: { websiteId: string; pageId: string; version: number; definition: JsonObject; checksum: string },
  ctx: PlatformAuthContext | null
) {
  const id = pageVersionRowId(orgId, input.pageId, input.version);
  const now = nowIso();
  const saved = await upsertDocument(orgId, WEBSITE_PAGE_VERSION_COLLECTION, {
    id,
    data: {
      schema_version: WEBSITE_SCHEMA_VERSION,
      id,
      kind: "website_page_version",
      organization_id: orgId,
      website_id: input.websiteId,
      page_id: input.pageId,
      version: input.version,
      definition: input.definition,
      checksum: input.checksum,
      published_at: now,
      published_by_user_id: ctx?.userId || "system",
      locked: true
    },
    metadata: { kind: "website_page_version", page_id: input.pageId, version: input.version }
  }, { replace: true });
  return documentView(saved);
}

export async function deletePageVersions(orgId: string, pageId: string) {
  const versions = await listPageVersions(orgId, pageId);
  for (const version of versions) {
    await deleteDocument(orgId, WEBSITE_PAGE_VERSION_COLLECTION, cleanText(version.id)).catch(() => null);
  }
}

// ---------------------------------------------------------------------------
// Host registry — {platformStorageRoot}/config/website_hosts.json. The
// cross-org lookup index for public serving by site key or custom hostname.
// Atomic read/modify/write with an mtime cache plus a filesystem lock so
// multiple V1 worker processes cannot overwrite one another's registrations.
// ---------------------------------------------------------------------------

export type HostRegistryEntry = { org_id: string; site_id: string };
type HostRegistry = {
  schema_version: number;
  site_keys: Record<string, HostRegistryEntry>;
  domains: Record<string, HostRegistryEntry>;
};

function hostRegistryPath() {
  return path.join(path.resolve(process.cwd(), env.platformStorageRoot), "config", "website_hosts.json");
}

let hostRegistryCache: { registry: HostRegistry; mtimeMs: number; path: string } | null = null;
let hostRegistryMutationQueue: Promise<unknown> = Promise.resolve();

export function normalizeWebsiteHostname(value: unknown) {
  const raw = cleanText(value).toLowerCase().replace(/\.+$/, "");
  if (!raw || raw.includes(":") || raw.includes("/") || raw.includes("@")) return "";
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii.length > 253) return "";
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(ascii) ? ascii : "";
}

export function websiteHostnameAliases(value: unknown) {
  const hostname = normalizeWebsiteHostname(value);
  if (!hostname) return [];
  return hostname.startsWith("www.") ? [hostname] : [hostname, `www.${hostname}`];
}

function emptyHostRegistry(): HostRegistry {
  return { schema_version: 1, site_keys: {}, domains: {} };
}

function normalizeHostRegistry(raw: unknown): HostRegistry {
  const value = asObject(raw);
  const normalizeMap = (input: unknown) => {
    const out: Record<string, HostRegistryEntry> = {};
    for (const [key, entry] of Object.entries(asObject(input))) {
      const item = asObject(entry);
      const orgId = cleanText(item.org_id);
      const siteId = cleanText(item.site_id);
      const normalizedKey = cleanText(key).startsWith("s") && !cleanText(key).includes(".")
        ? cleanText(key)
        : normalizeWebsiteHostname(key);
      if (normalizedKey && orgId && siteId) out[normalizedKey] = { org_id: orgId, site_id: siteId };
    }
    return out;
  };
  return {
    schema_version: Number(value.schema_version || 1) || 1,
    site_keys: normalizeMap(value.site_keys),
    domains: normalizeMap(value.domains)
  };
}

export async function readHostRegistry(): Promise<HostRegistry> {
  const filePath = hostRegistryPath();
  let mtimeMs = -1;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    hostRegistryCache = null;
    return emptyHostRegistry();
  }
  if (hostRegistryCache && hostRegistryCache.path === filePath && hostRegistryCache.mtimeMs === mtimeMs) {
    return hostRegistryCache.registry;
  }
  const { readFile } = await import("node:fs/promises");
  let registry = emptyHostRegistry();
  try {
    registry = normalizeHostRegistry(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    registry = emptyHostRegistry();
  }
  hostRegistryCache = { registry, mtimeMs, path: filePath };
  return registry;
}

async function writeHostRegistry(registry: HostRegistry) {
  const filePath = hostRegistryPath();
  await writeJsonAtomic(filePath, registry);
  let mtimeMs = -1;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  hostRegistryCache = { registry, mtimeMs, path: filePath };
}

async function acquireHostRegistryLock() {
  const lockPath = `${hostRegistryPath()}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      return async () => { await rm(lockPath, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw conflict("website_host_registry_busy", "Website hostname registration is busy. Try again.");
}

function mutateHostRegistry<T>(mutation: (registry: HostRegistry) => T | Promise<T>) {
  const operation = hostRegistryMutationQueue.then(async () => {
    const release = await acquireHostRegistryLock();
    try {
      hostRegistryCache = null;
      const registry = await readHostRegistry();
      const result = await mutation(registry);
      await writeHostRegistry(registry);
      return result;
    } finally {
      await release();
    }
  });
  hostRegistryMutationQueue = operation.catch(() => undefined);
  return operation;
}

export async function registerSiteKey(siteKey: string, orgId: string, siteId: string) {
  await mutateHostRegistry((registry) => {
    registry.site_keys[cleanText(siteKey)] = { org_id: cleanText(orgId), site_id: cleanText(siteId) };
  });
}

export async function unregisterSiteKey(siteKey: string) {
  await mutateHostRegistry((registry) => {
    delete registry.site_keys[cleanText(siteKey)];
  });
}

/** O(1) public resolution: site_key -> { org_id, site_id } | null. */
export async function resolveSiteKey(siteKey: string): Promise<HostRegistryEntry | null> {
  const key = cleanText(siteKey);
  if (!key) return null;
  const registry = await readHostRegistry();
  return registry.site_keys[key] || null;
}

export async function syncSiteDomainHosts(domains: unknown[], orgId: string, siteId: string) {
  const owner = { org_id: cleanText(orgId), site_id: cleanText(siteId) };
  const desired = [...new Set(domains.flatMap(websiteHostnameAliases))];
  await mutateHostRegistry((registry) => {
    for (const hostname of desired) {
      const existing = registry.domains[hostname];
      if (existing && (existing.org_id !== owner.org_id || existing.site_id !== owner.site_id)) {
        throw conflict("website_domain_in_use", `${hostname} is already connected to another website.`);
      }
    }
    for (const [hostname, existing] of Object.entries(registry.domains)) {
      if (existing.org_id === owner.org_id && existing.site_id === owner.site_id && !desired.includes(hostname)) {
        delete registry.domains[hostname];
      }
    }
    for (const hostname of desired) registry.domains[hostname] = owner;
  });
  return desired;
}

export async function rebuildDomainHostRegistry(entries: Array<{ domains: unknown[]; org_id: string; site_id: string }>) {
  const rebuilt: Record<string, HostRegistryEntry> = {};
  for (const entry of entries) {
    const owner = { org_id: cleanText(entry.org_id), site_id: cleanText(entry.site_id) };
    if (!owner.org_id || !owner.site_id) continue;
    for (const hostname of [...new Set(entry.domains.flatMap(websiteHostnameAliases))]) {
      const existing = rebuilt[hostname];
      if (existing && (existing.org_id !== owner.org_id || existing.site_id !== owner.site_id)) {
        throw conflict("website_domain_in_use", `${hostname} is connected to more than one active website.`);
      }
      rebuilt[hostname] = owner;
    }
  }
  await mutateHostRegistry((registry) => {
    registry.domains = rebuilt;
  });
  return Object.keys(rebuilt).length;
}

export async function resolveDomainHost(hostname: unknown): Promise<HostRegistryEntry | null> {
  const normalized = normalizeWebsiteHostname(hostname);
  if (!normalized) return null;
  const registry = await readHostRegistry();
  return registry.domains[normalized] || null;
}

/** A platform-unique site key (collision-checked against the registry). */
export async function mintSiteKey() {
  const registry = await readHostRegistry();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const key = generateSiteKey();
    if (!registry.site_keys[key]) return key;
  }
  return `s${randomBytes(8).toString("hex").slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Events — append-only audit rows mirrored into the work engine.
// ---------------------------------------------------------------------------

export async function listWebsiteEvents(orgId: string, websiteId: string) {
  const docs = await listDocuments(orgId, WEBSITE_EVENT_COLLECTION);
  return docs
    .map(documentView)
    .filter((event) => cleanText(event.website_id) === websiteId)
    .sort((a, b) => cleanText(a.created_at).localeCompare(cleanText(b.created_at)));
}

export async function recordWebsiteEvent(
  orgId: string,
  siteValue: JsonObject,
  pageValue: JsonObject | null,
  type: string,
  payload: JsonObject = {},
  ctx?: PlatformAuthContext | null
) {
  const websiteId = cleanText(siteValue.id);
  const pageId = cleanText(asObject(pageValue).id);
  const now = nowIso();
  const id = `website_event_${hashId(`${websiteId}:${pageId}:${type}:${Date.now()}:${randomUUID()}`)}`;
  const eventPayload: JsonObject = {
    website_id: websiteId,
    site_kind: cleanText(siteValue.site_kind),
    site_key: cleanText(siteValue.site_key),
    ...(pageId ? { page_id: pageId, page_role: cleanText(asObject(pageValue).role), page_slug: cleanText(asObject(pageValue).slug) } : {}),
    ...payload
  };
  const data = {
    schema_version: WEBSITE_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    website_id: websiteId,
    page_id: pageId,
    type,
    actor_user_id: ctx?.userId || cleanText(payload.actor_user_id),
    payload: eventPayload,
    created_at: now,
    updated_at: now
  };
  await upsertDocument(orgId, WEBSITE_EVENT_COLLECTION, {
    id,
    data,
    metadata: { kind: "website_event", website_id: websiteId, type }
  }, { replace: true });
  try {
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: "default",
      type,
      idempotency_key: `${type}:${websiteId}:${pageId || "site"}:${cleanText(payload.version || id)}`,
      payload: eventPayload,
      context: { actor_user_id: ctx?.userId || cleanText(payload.actor_user_id) }
    });
  } catch {
    // Work-event emission is best-effort from the websites module's side.
  }
  return data;
}
