import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { createSharedDocument, listSharedDocuments, mutateSharedDocument, readSharedDocument } from "../src/database/shared_documents.js";
import { deleteSharedObject, getSharedObject, isSpacesArtifactStorageEnabled, putSharedObject } from "../src/storage/project_artifacts.js";
import { DEFAULT_TEMPLATE_KEY, GLOBAL_MARKET_PRICEBOOK_ID, PRICEBOOK_FILE_NAMES, PRICEBOOK_SCHEMA_VERSION } from "./constants.js";
import { DEFAULT_PRICEBOOK_TEMPLATE } from "./default_template.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { autoAddScopeItems, resolveCatalogItemToScopeItem, validateCatalogGraph } from "./resolver.js";

export type JsonObject = Record<string, unknown>;

export type PricebookManifest = JsonObject & {
  schema_version: number;
  id: string;
  status: string;
  name: string;
  description: string | null;
  currency: string;
  locale: string;
  revision: number;
  template_ref: Record<string, unknown>;
  organization_ref: Record<string, unknown>;
  owner_ref: Record<string, unknown>;
  timestamps: Record<string, unknown>;
  counts: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type CatalogAsset = JsonObject & {
  id: string;
  file_name: string;
  stored_name: string;
  size: number;
  created_at: string;
  updated_at: string;
};

export type PricebookCatalog = JsonObject & {
  taxonomy: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  variation_sets: Array<Record<string, unknown>>;
  assets: CatalogAsset[];
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type OrganizationPricebookOverlay = JsonObject & {
  schema_version: number;
  organization_ref: { id: string };
  global_pricebook_ref: { id: string; revision: number };
  entries: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type FileEntry = {
  name: string;
  size: number;
  updated_at: string;
};

type SharedPricebookRecord = { manifest: PricebookManifest; catalog: PricebookCatalog };

function sharedPricebookKey(pricebookId: string) {
  return { namespace: "pricebook", collection: "pricebooks", id: sanitizePricebookId(pricebookId) };
}

function sharedAssetKey(pricebookId: string, storedName: string) {
  return `pricebooks/${sanitizePricebookId(pricebookId)}/assets/${sanitizeFileName(storedName)}`;
}

async function readSharedPricebook(pricebookId: string) {
  const id = sanitizePricebookId(pricebookId);
  const record = await readSharedDocument<SharedPricebookRecord>(sharedPricebookKey(id));
  if (!record) throw notFound("pricebook_not_found", `Price book '${id}' does not exist.`);
  return { manifest: record.manifest, catalog: normalizeCatalog(record.catalog) };
}

export function resolvePricebookStorageRoot(): string {
  return path.resolve(process.cwd(), env.pricebookStorageRoot);
}

function pricebooksRoot(): string {
  return path.join(resolvePricebookStorageRoot(), "pricebooks");
}

function pricebookAssetsRoot(pricebookId: string) {
  return path.join(pricebookDir(pricebookId), "assets");
}

export async function ensurePricebookStorage() {
  if (isFirstMeasurePostgresEnabled()) return;
  await mkdir(pricebooksRoot(), { recursive: true });
}

export function sanitizePricebookId(pricebookId: string): string {
  const cleaned = pricebookId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!cleaned) {
    throw badRequest("invalid_pricebook_id", "Price book id must contain at least one letter or number.");
  }
  return cleaned;
}

export function pricebookDir(pricebookId: string): string {
  return path.join(pricebooksRoot(), sanitizePricebookId(pricebookId));
}

export function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).trim();
  if (!base || base === "." || base === "..") {
    throw badRequest("invalid_file_name", "File name is required.");
  }
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

export function generatePricebookId() {
  return `pb_${randomBytes(10).toString("hex")}`;
}

function generateAssetId() {
  return `asset_${randomBytes(8).toString("hex")}`;
}

export function listTemplates() {
  return [
    {
      key: DEFAULT_PRICEBOOK_TEMPLATE.key,
      version: DEFAULT_PRICEBOOK_TEMPLATE.version,
      name: DEFAULT_PRICEBOOK_TEMPLATE.name,
      description: DEFAULT_PRICEBOOK_TEMPLATE.description
    }
  ];
}

export function readTemplateCatalog(templateKey: string) {
  if (templateKey !== DEFAULT_TEMPLATE_KEY) {
    throw notFound("template_not_found", `Template '${templateKey}' does not exist.`);
  }
  return clone(DEFAULT_PRICEBOOK_TEMPLATE.catalog);
}

export async function createPricebook(input: JsonObject = {}) {
  const pricebookId = input.id ? sanitizePricebookId(String(input.id)) : generatePricebookId();
  await ensurePricebookStorage();
  const organizationId = String(asRecord(input.organization_ref).id ?? "").trim();
  if (organizationId && pricebookId !== organizationPricebookId(organizationId)) {
    throw conflict(
      "organization_pricebook_is_singleton",
      `Organization '${organizationId}' has one price book. Use its organization price book endpoint instead of creating another.`
    );
  }
  const manifestPath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.manifest);
  if (!isFirstMeasurePostgresEnabled() && await pathExists(manifestPath)) {
    throw conflict("pricebook_already_exists", `Price book '${pricebookId}' already exists.`);
  }

  const templateKey = String(input.template_key ?? DEFAULT_TEMPLATE_KEY);
  const catalog = normalizeCatalog(readTemplateCatalog(templateKey));
  const nowSql = toSqlDate(new Date().toISOString());
  if (!isFirstMeasurePostgresEnabled()) await mkdir(pricebookAssetsRoot(pricebookId), { recursive: true });

  const manifest: PricebookManifest = {
    schema_version: PRICEBOOK_SCHEMA_VERSION,
    id: pricebookId,
    status: "active",
    name: String(input.name ?? "Organization Price Book"),
    description: input.description == null ? null : String(input.description),
    currency: String(input.currency ?? "USD"),
    locale: String(input.locale ?? "en-US"),
    revision: 1,
    template_ref: {
      key: templateKey,
      version: DEFAULT_PRICEBOOK_TEMPLATE.version
    },
    organization_ref: asRecord(input.organization_ref),
    owner_ref: asRecord(input.owner_ref),
    timestamps: {
      created_at: nowSql,
      updated_at: nowSql,
      archived_at: null
    },
    counts: deriveCounts(catalog),
    metadata: asRecord(input.metadata)
  };

  if (isFirstMeasurePostgresEnabled()) {
    const created = await createSharedDocument(sharedPricebookKey(pricebookId), { manifest, catalog });
    if (!created) throw conflict("pricebook_already_exists", `Price book '${pricebookId}' already exists.`);
    return getPricebookDetail(pricebookId);
  }

  await saveManifest(pricebookId, manifest);
  await saveCatalogRaw(pricebookId, catalog);
  return getPricebookDetail(pricebookId);
}

export async function clonePricebook(sourceId: string, input: JsonObject = {}) {
  const source = await getPricebookDetail(sourceId);
  const created = await createPricebook({
    ...input,
    currency: input.currency ?? source.manifest.currency,
    locale: input.locale ?? source.manifest.locale,
    template_key: String(asRecord(source.manifest.template_ref).key ?? DEFAULT_TEMPLATE_KEY),
    metadata: {
      ...asRecord(source.manifest.metadata),
      ...asRecord(input.metadata),
      clone_source_pricebook_id: source.manifest.id
    }
  });
  for (const asset of source.catalog.assets) {
    const storedName = String(asset.stored_name ?? "");
    if (!storedName) continue;
    if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) {
      const content = await getSharedObject(sharedAssetKey(source.manifest.id, storedName));
      if (!content) throw notFound("asset_not_found", `Asset '${asset.id}' file is missing for price book '${source.manifest.id}'.`);
      await putSharedObject(sharedAssetKey(created.manifest.id, storedName), content, String(asset.content_type ?? "application/octet-stream"));
    } else {
      await mkdir(pricebookAssetsRoot(created.manifest.id), { recursive: true });
      await copyFile(
        path.join(pricebookAssetsRoot(source.manifest.id), storedName),
        path.join(pricebookAssetsRoot(created.manifest.id), storedName)
      );
    }
  }
  await saveCatalog(created.manifest.id, source.catalog, 1);
  return getPricebookDetail(created.manifest.id);
}

export async function listPricebookManifests() {
  if (isFirstMeasurePostgresEnabled()) {
    const records = await listSharedDocuments<SharedPricebookRecord>({ namespace: "pricebook", collection: "pricebooks" });
    return records.map((record) => record.manifest);
  }
  await ensurePricebookStorage();
  const entries = await readdir(pricebooksRoot(), { withFileTypes: true });
  const manifests: PricebookManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(await readManifest(entry.name));
    } catch {
      continue;
    }
  }
  return manifests;
}

export async function getPricebookDetail(pricebookId: string) {
  const manifest = await readManifest(pricebookId);
  const catalog = await readCatalog(pricebookId);
  return {
    manifest,
    catalog,
    files: await listPricebookFiles(pricebookId)
  };
}

export async function readManifest(pricebookId: string): Promise<PricebookManifest> {
  if (isFirstMeasurePostgresEnabled()) return (await readSharedPricebook(pricebookId)).manifest;
  const filePath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.manifest);
  return readJsonFile<PricebookManifest>(filePath, {
    code: "pricebook_not_found",
    message: `Price book '${pricebookId}' does not exist.`
  });
}

export async function saveManifest(pricebookId: string, manifest: PricebookManifest) {
  if (isFirstMeasurePostgresEnabled()) {
    await mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => ({ ...current, manifest }), {
      create: () => ({ manifest, catalog: normalizeCatalog(DEFAULT_PRICEBOOK_TEMPLATE.catalog) })
    });
    return;
  }
  const directory = pricebookDir(pricebookId);
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, PRICEBOOK_FILE_NAMES.manifest);
  await backupManifestIfPresent(directory, manifestPath);
  await writeJsonAtomic(manifestPath, manifest);
}

export async function patchManifest(pricebookId: string, patch: JsonObject, expectedRevision?: number) {
  if (isFirstMeasurePostgresEnabled()) {
    return mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => {
      const manifest = current.manifest;
      assertExpectedRevision(manifest, expectedRevision);
      const merged = deepMerge(manifest, patch) as PricebookManifest;
      merged.revision = manifest.revision + 1;
      merged.timestamps = { ...asRecord(manifest.timestamps), ...asRecord(merged.timestamps), updated_at: toSqlDate(new Date().toISOString()) };
      (merged.timestamps as JsonObject).archived_at = merged.status === "archived"
        ? asRecord(merged.timestamps).archived_at || toSqlDate(new Date().toISOString())
        : null;
      merged.counts = deriveCounts(normalizeCatalog(current.catalog));
      return { ...current, manifest: merged };
    }, { missing: () => { throw notFound("pricebook_not_found", `Price book '${pricebookId}' does not exist.`); } }).then((record) => record.manifest);
  }
  const manifest = await readManifest(pricebookId);
  assertExpectedRevision(manifest, expectedRevision);
  const merged = deepMerge(manifest, patch) as PricebookManifest;
  merged.revision = manifest.revision + 1;
  merged.timestamps = {
    ...asRecord(manifest.timestamps),
    ...asRecord(merged.timestamps),
    updated_at: toSqlDate(new Date().toISOString())
  };
  if (merged.status === "archived" && !asRecord(merged.timestamps).archived_at) {
    (merged.timestamps as JsonObject).archived_at = toSqlDate(new Date().toISOString());
  }
  if (merged.status !== "archived") {
    (merged.timestamps as JsonObject).archived_at = null;
  }
  merged.counts = deriveCounts(await readCatalog(pricebookId));
  await saveManifest(pricebookId, merged);
  return merged;
}

export async function readCatalog(pricebookId: string): Promise<PricebookCatalog> {
  if (isFirstMeasurePostgresEnabled()) return (await readSharedPricebook(pricebookId)).catalog;
  const filePath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.catalog);
  const raw = await readJsonFile<PricebookCatalog>(filePath, {
    code: "catalog_not_found",
    message: `Catalog for price book '${pricebookId}' does not exist.`
  });
  return normalizeCatalog(raw);
}

export async function getGlobalMarketPricebook() {
  const manifestPath = path.join(pricebookDir(GLOBAL_MARKET_PRICEBOOK_ID), PRICEBOOK_FILE_NAMES.manifest);
  if (!(await pathExists(manifestPath))) {
    await createPricebook({
      id: GLOBAL_MARKET_PRICEBOOK_ID,
      name: "Global Market Price Book",
      description: "Shared market reference catalog for every organization.",
      metadata: { pricebook_layer: "global_market" }
    });
  }
  return getPricebookDetail(GLOBAL_MARKET_PRICEBOOK_ID);
}

export async function getOrganizationPricebook(organizationIdValue: string) {
  const organizationId = cleanRequiredId(organizationIdValue, "organization_id");
  const global = await getGlobalMarketPricebook();
  const pricebookId = organizationPricebookId(organizationId);
  const manifestPath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.manifest);

  if (!(await pathExists(manifestPath))) {
    await createPricebook({
      id: pricebookId,
      name: "Organization Price Book",
      description: "Organization catalog linked to the global market price book.",
      organization_ref: { id: organizationId },
      metadata: { pricebook_layer: "organization", singleton: true }
    });
    const overlay = initialOrganizationOverlay(organizationId, global);
    await saveOrganizationOverlayRaw(pricebookId, overlay);
    await saveCatalogRaw(pricebookId, materializeOrganizationCatalog(global.catalog, overlay));
  }

  const manifest = await readManifest(pricebookId);
  const overlay = await readOrganizationOverlay(pricebookId, organizationId, global);
  const catalog = materializeOrganizationCatalog(global.catalog, overlay);
  return {
    manifest: {
      ...manifest,
      global_pricebook_ref: { id: GLOBAL_MARKET_PRICEBOOK_ID, revision: global.manifest.revision }
    },
    catalog,
    overlay,
    global: { manifest: global.manifest }
  };
}

export async function saveOrganizationCatalog(organizationIdValue: string, catalogInput: unknown, expectedRevision?: number) {
  const organizationId = cleanRequiredId(organizationIdValue, "organization_id");
  const current = await getOrganizationPricebook(organizationId);
  const pricebookId = String(current.manifest.id);
  const manifest = await readManifest(pricebookId);
  assertExpectedRevision(manifest, expectedRevision);
  const global = await getGlobalMarketPricebook();
  const catalog = normalizeCatalog(catalogInput);
  const overlay = buildOrganizationOverlay(organizationId, global, catalog, current.overlay);
  const effectiveCatalog = materializeOrganizationCatalog(global.catalog, overlay);
  validateCatalogGraph(effectiveCatalog);
  await saveOrganizationOverlayRaw(pricebookId, overlay);
  await saveCatalogRaw(pricebookId, effectiveCatalog);
  manifest.revision += 1;
  manifest.timestamps = {
    ...asRecord(manifest.timestamps),
    updated_at: toSqlDate(new Date().toISOString())
  };
  manifest.counts = deriveCounts(effectiveCatalog);
  await saveManifest(pricebookId, manifest);
  return {
    manifest: {
      ...manifest,
      global_pricebook_ref: { id: GLOBAL_MARKET_PRICEBOOK_ID, revision: global.manifest.revision }
    },
    catalog: effectiveCatalog,
    overlay
  };
}

async function saveCatalogRaw(pricebookId: string, catalog: PricebookCatalog) {
  if (isFirstMeasurePostgresEnabled()) {
    await mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => ({ ...current, catalog }), {
      missing: () => { throw notFound("pricebook_not_found", `Price book '${pricebookId}' does not exist.`); }
    });
    return;
  }
  const filePath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.catalog);
  await writeJsonAtomic(filePath, catalog);
}

export async function saveCatalog(pricebookId: string, catalogInput: unknown, expectedRevision?: number) {
  if (isFirstMeasurePostgresEnabled()) {
    return mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => {
      assertExpectedRevision(current.manifest, expectedRevision);
      const catalog = normalizeCatalog(catalogInput);
      const manifest = {
        ...current.manifest,
        revision: current.manifest.revision + 1,
        timestamps: { ...asRecord(current.manifest.timestamps), updated_at: toSqlDate(new Date().toISOString()) },
        counts: deriveCounts(catalog)
      };
      return { manifest, catalog };
    }, { missing: () => { throw notFound("pricebook_not_found", `Price book '${pricebookId}' does not exist.`); } });
  }
  const manifest = await readManifest(pricebookId);
  assertExpectedRevision(manifest, expectedRevision);
  const catalog = normalizeCatalog(catalogInput);
  validateCatalogGraph(catalog);
  await saveCatalogRaw(pricebookId, catalog);
  manifest.revision += 1;
  manifest.timestamps = {
    ...asRecord(manifest.timestamps),
    updated_at: toSqlDate(new Date().toISOString())
  };
  manifest.counts = deriveCounts(catalog);
  await saveManifest(pricebookId, manifest);
  return { manifest, catalog };
}

export async function resolveItem(pricebookId: string, itemId: string, overrides: JsonObject = {}) {
  const catalog = await readCatalog(pricebookId);
  return resolveCatalogItemToScopeItem(catalog, itemId, overrides);
}

export async function resolveAutoAddItems(pricebookId: string) {
  const catalog = await readCatalog(pricebookId);
  return autoAddScopeItems(catalog);
}

export async function createItem(pricebookId: string, itemInput: Record<string, unknown>, expectedRevision?: number) {
  if (isFirstMeasurePostgresEnabled()) {
    return mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => {
      assertExpectedRevision(current.manifest, expectedRevision);
      const catalog = normalizeCatalog(current.catalog);
      const itemId = String(itemInput.id ?? "").trim();
      if (catalog.items.some((item) => String(item.id ?? "") === itemId)) throw conflict("item_already_exists", `Item '${itemId}' already exists in price book '${pricebookId}'.`);
      catalog.items = [...catalog.items, normalizeItem(itemInput, catalog.items.length)].sort(compareItems);
      return nextCatalogRecord(current, catalog);
    }, { missing: () => { throw notFound("pricebook_not_found", `Price book '${pricebookId}' does not exist.`); } });
  }
  const catalog = await readCatalog(pricebookId);
  const itemId = String(itemInput.id ?? "").trim();
  if (catalog.items.some((item) => String(item.id ?? "") === itemId)) {
    throw conflict("item_already_exists", `Item '${itemId}' already exists in price book '${pricebookId}'.`);
  }
  catalog.items = [...catalog.items, normalizeItem(itemInput, catalog.items.length)];
  catalog.items.sort(compareItems);
  return saveCatalog(pricebookId, catalog, expectedRevision);
}

export async function patchItem(pricebookId: string, itemId: string, patch: Record<string, unknown>, expectedRevision?: number) {
  if (isFirstMeasurePostgresEnabled()) {
    return mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => {
      assertExpectedRevision(current.manifest, expectedRevision);
      const catalog = normalizeCatalog(current.catalog);
      const index = catalog.items.findIndex((item) => String(item.id ?? "") === itemId);
      if (index < 0) throw notFound("item_not_found", `Item '${itemId}' was not found in price book '${pricebookId}'.`);
      catalog.items[index] = normalizeItem({ ...catalog.items[index], ...patch, id: itemId }, index);
      catalog.items.sort(compareItems);
      return nextCatalogRecord(current, catalog);
    }, { missing: () => { throw notFound("pricebook_not_found", `Price book '${pricebookId}' does not exist.`); } });
  }
  const catalog = await readCatalog(pricebookId);
  const index = catalog.items.findIndex((item) => String(item.id ?? "") === itemId);
  if (index < 0) {
    throw notFound("item_not_found", `Item '${itemId}' was not found in price book '${pricebookId}'.`);
  }
  catalog.items[index] = normalizeItem({ ...catalog.items[index], ...patch, id: itemId }, index);
  catalog.items.sort(compareItems);
  return saveCatalog(pricebookId, catalog, expectedRevision);
}

export async function deleteItem(pricebookId: string, itemId: string, expectedRevision?: number) {
  if (isFirstMeasurePostgresEnabled()) {
    return mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => {
      assertExpectedRevision(current.manifest, expectedRevision);
      const catalog = normalizeCatalog(current.catalog);
      const nextItems = catalog.items.filter((item) => String(item.id ?? "") !== itemId);
      if (nextItems.length === catalog.items.length) throw notFound("item_not_found", `Item '${itemId}' was not found in price book '${pricebookId}'.`);
      catalog.items = nextItems;
      return nextCatalogRecord(current, catalog);
    }, { missing: () => { throw notFound("pricebook_not_found", `Price book '${pricebookId}' does not exist.`); } });
  }
  const catalog = await readCatalog(pricebookId);
  const nextItems = catalog.items.filter((item) => String(item.id ?? "") !== itemId);
  if (nextItems.length === catalog.items.length) {
    throw notFound("item_not_found", `Item '${itemId}' was not found in price book '${pricebookId}'.`);
  }
  catalog.items = nextItems;
  return saveCatalog(pricebookId, catalog, expectedRevision);
}

export async function listAssetEntries(pricebookId: string) {
  const catalog = await readCatalog(pricebookId);
  return catalog.assets;
}

export async function saveAsset(pricebookId: string, input: {
  fileName: string;
  content: Uint8Array | string;
  contentType?: string;
  label?: string | null;
  altText?: string | null;
  kind?: string | null;
  metadata?: Record<string, unknown>;
  expectedRevision?: number;
}) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) {
    const safeName = sanitizeFileName(input.fileName);
    const assetId = generateAssetId();
    const storedName = `${assetId}_${safeName}`;
    const bytes = typeof input.content === "string" ? Buffer.from(input.content) : Buffer.from(input.content);
    await putSharedObject(sharedAssetKey(pricebookId, storedName), bytes, input.contentType ?? "application/octet-stream");
    const nowIso = new Date().toISOString();
    const asset: CatalogAsset = { id: assetId, file_name: safeName, stored_name: storedName, content_type: input.contentType ?? null, size: bytes.length, kind: input.kind ?? inferAssetKind(safeName, input.contentType), label: input.label ?? null, alt_text: input.altText ?? null, created_at: nowIso, updated_at: nowIso, metadata: input.metadata ?? {} };
    try {
      const result = await mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => {
        assertExpectedRevision(current.manifest, input.expectedRevision);
        const catalog = normalizeCatalog(current.catalog);
        catalog.assets = [...catalog.assets, asset];
        return nextCatalogRecord(current, catalog);
      }, { missing: () => { throw notFound("pricebook_not_found", `Price book '${pricebookId}' does not exist.`); } });
      return { ...result, asset };
    } catch (error) {
      await deleteSharedObject(sharedAssetKey(pricebookId, storedName)).catch(() => undefined);
      throw error;
    }
  }
  const catalog = await readCatalog(pricebookId);
  const safeName = sanitizeFileName(input.fileName);
  const assetId = generateAssetId();
  const storedName = `${assetId}_${safeName}`;
  const assetPath = path.join(pricebookAssetsRoot(pricebookId), storedName);
  await mkdir(pricebookAssetsRoot(pricebookId), { recursive: true });
  await writeFileAtomic(assetPath, input.content);
  const fileStat = await stat(assetPath);
  const nowIso = new Date().toISOString();
  const asset: CatalogAsset = {
    id: assetId,
    file_name: safeName,
    stored_name: storedName,
    content_type: input.contentType ?? null,
    size: fileStat.size,
    kind: input.kind ?? inferAssetKind(safeName, input.contentType),
    label: input.label ?? null,
    alt_text: input.altText ?? null,
    created_at: nowIso,
    updated_at: nowIso,
    metadata: input.metadata ?? {}
  };
  catalog.assets = [...catalog.assets, asset];
  const result = await saveCatalog(pricebookId, catalog, input.expectedRevision);
  return { ...result, asset };
}

export async function readAsset(pricebookId: string, assetId: string) {
  const catalog = await readCatalog(pricebookId);
  const asset = catalog.assets.find((entry) => entry.id === assetId);
  if (!asset) {
    throw notFound("asset_not_found", `Asset '${assetId}' was not found in price book '${pricebookId}'.`);
  }
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) {
    const content = await getSharedObject(sharedAssetKey(pricebookId, String(asset.stored_name)));
    if (!content) throw notFound("asset_not_found", `Asset '${assetId}' file is missing for price book '${pricebookId}'.`);
    return { asset, path: `spaces://${sharedAssetKey(pricebookId, String(asset.stored_name))}`, content };
  }
  const assetPath = path.join(pricebookAssetsRoot(pricebookId), String(asset.stored_name));
  const content = await readFile(assetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw notFound("asset_not_found", `Asset '${assetId}' file is missing for price book '${pricebookId}'.`);
    }
    throw error;
  });
  return { asset, path: assetPath, content };
}

export async function deleteAsset(pricebookId: string, assetId: string, expectedRevision?: number) {
  if (isFirstMeasurePostgresEnabled() && isSpacesArtifactStorageEnabled()) {
    let deletedStoredName = "";
    const result = await mutateSharedDocument<SharedPricebookRecord>(sharedPricebookKey(pricebookId), (current) => {
      assertExpectedRevision(current.manifest, expectedRevision);
      const catalog = normalizeCatalog(current.catalog);
      const asset = catalog.assets.find((entry) => entry.id === assetId);
      if (!asset) throw notFound("asset_not_found", `Asset '${assetId}' was not found in price book '${pricebookId}'.`);
      deletedStoredName = String(asset.stored_name);
      catalog.assets = catalog.assets.filter((entry) => entry.id !== assetId);
      catalog.items = catalog.items.map((item) => ({ ...item, images: Array.isArray(item.images) ? item.images.filter((image) => String(asRecord(image).asset_id ?? "") !== assetId) : [] }));
      return nextCatalogRecord(current, catalog);
    }, { missing: () => { throw notFound("pricebook_not_found", `Price book '${pricebookId}' does not exist.`); } });
    if (deletedStoredName) {
      await deleteSharedObject(sharedAssetKey(pricebookId, deletedStoredName)).catch(() => undefined);
    }
    return { ...result, deleted_asset_id: assetId };
  }
  const catalog = await readCatalog(pricebookId);
  const asset = catalog.assets.find((entry) => entry.id === assetId);
  if (!asset) {
    throw notFound("asset_not_found", `Asset '${assetId}' was not found in price book '${pricebookId}'.`);
  }
  await unlink(path.join(pricebookAssetsRoot(pricebookId), String(asset.stored_name))).catch(() => undefined);
  catalog.assets = catalog.assets.filter((entry) => entry.id !== assetId);
  catalog.items = catalog.items.map((item) => ({
    ...item,
    images: Array.isArray(item.images)
      ? item.images.filter((image) => String(asRecord(image).asset_id ?? "") !== assetId)
      : []
  }));
  const result = await saveCatalog(pricebookId, catalog, expectedRevision);
  return { ...result, deleted_asset_id: assetId };
}

export async function listPricebookFiles(pricebookId: string): Promise<FileEntry[]> {
  if (isFirstMeasurePostgresEnabled()) {
    const record = await readSharedPricebook(pricebookId);
    const updatedAt = String(asRecord(record.manifest.timestamps).updated_at || new Date(0).toISOString());
    return [
      { name: PRICEBOOK_FILE_NAMES.manifest, size: Buffer.byteLength(JSON.stringify(record.manifest)), updated_at: updatedAt },
      { name: PRICEBOOK_FILE_NAMES.catalog, size: Buffer.byteLength(JSON.stringify(record.catalog)), updated_at: updatedAt },
      ...record.catalog.assets.map((asset) => ({ name: `assets/${asset.stored_name}`, size: Number(asset.size || 0), updated_at: asset.updated_at }))
    ].sort((a, b) => a.name.localeCompare(b.name));
  }
  await readManifest(pricebookId);
  const files: FileEntry[] = [];
  const rootEntries = await readdir(pricebookDir(pricebookId), { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(pricebookDir(pricebookId), entry.name);
    const fileStat = await stat(filePath);
    files.push({ name: entry.name, size: fileStat.size, updated_at: fileStat.mtime.toISOString() });
  }
  const assetEntries = await readdir(pricebookAssetsRoot(pricebookId), { withFileTypes: true }).catch(() => []);
  for (const entry of assetEntries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(pricebookAssetsRoot(pricebookId), entry.name);
    const fileStat = await stat(filePath);
    files.push({ name: `assets/${entry.name}`, size: fileStat.size, updated_at: fileStat.mtime.toISOString() });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function organizationPricebookId(organizationId: string) {
  const readable = sanitizePricebookId(organizationId).slice(0, 48);
  const digest = createHash("sha256").update(organizationId).digest("hex").slice(0, 12);
  return `org_${readable}_${digest}`;
}

function organizationOverlayPath(pricebookId: string) {
  return path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.organizationOverlay);
}

function cleanRequiredId(value: string, field: string) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) throw badRequest(`missing_${field}`, `${field} is required.`);
  return cleaned;
}

function initialOrganizationOverlay(organizationId: string, global: Awaited<ReturnType<typeof getPricebookDetail>>): OrganizationPricebookOverlay {
  return {
    schema_version: PRICEBOOK_SCHEMA_VERSION,
    organization_ref: { id: organizationId },
    global_pricebook_ref: { id: GLOBAL_MARKET_PRICEBOOK_ID, revision: Number(global.manifest.revision || 1) },
    entries: global.catalog.items.map((item) => ({
      id: String(item.id),
      global_item_ref: { pricebook_id: GLOBAL_MARKET_PRICEBOOK_ID, item_id: String(item.id) },
      link_mode: "live",
      overrides: {}
    })),
    settings: clone(global.catalog.settings || {}),
    metadata: { storage_model: "global_references_with_sparse_overrides" }
  };
}

async function readOrganizationOverlay(
  pricebookId: string,
  organizationId: string,
  global: Awaited<ReturnType<typeof getPricebookDetail>>
): Promise<OrganizationPricebookOverlay> {
  const filePath = organizationOverlayPath(pricebookId);
  if (!(await pathExists(filePath))) {
    const legacyCatalog = await readCatalog(pricebookId);
    const overlay = buildOrganizationOverlay(organizationId, global, legacyCatalog);
    await saveOrganizationOverlayRaw(pricebookId, overlay);
    return overlay;
  }
  const raw = await readJsonFile<OrganizationPricebookOverlay>(filePath, {
    code: "organization_pricebook_overlay_not_found",
    message: `Organization overlay for price book '${pricebookId}' does not exist.`
  });
  return {
    ...asRecord(raw),
    schema_version: PRICEBOOK_SCHEMA_VERSION,
    organization_ref: { id: organizationId },
    global_pricebook_ref: {
      id: GLOBAL_MARKET_PRICEBOOK_ID,
      revision: Number(asRecord(raw.global_pricebook_ref).revision || global.manifest.revision || 1)
    },
    entries: Array.isArray(raw.entries) ? raw.entries.map(asRecord) : [],
    settings: asRecord(raw.settings),
    metadata: asRecord(raw.metadata)
  } as OrganizationPricebookOverlay;
}

async function saveOrganizationOverlayRaw(pricebookId: string, overlay: OrganizationPricebookOverlay) {
  await writeJsonAtomic(organizationOverlayPath(pricebookId), overlay);
}

function buildOrganizationOverlay(
  organizationId: string,
  global: Awaited<ReturnType<typeof getPricebookDetail>>,
  organizationCatalog: PricebookCatalog,
  previous?: OrganizationPricebookOverlay
): OrganizationPricebookOverlay {
  const globalItems = new Map(global.catalog.items.map((item) => [String(item.id), item]));
  const previousEntries = new Map((previous?.entries || []).map((entry) => [String(entry.id), entry]));
  const entries = organizationCatalog.items.map((item) => {
    const id = String(item.id);
    const globalItem = globalItems.get(id);
    if (!globalItem || item.global_link_mode === "local") {
      return { id, link_mode: "local", item: stripOrganizationMetadata(item) };
    }
    const oldEntry = previousEntries.get(id);
    const requestedMode = String(item.global_link_mode || oldEntry?.link_mode || "live");
    const linkMode = requestedMode === "snapshot" ? "snapshot" : "live";
    const sourceSnapshot = linkMode === "snapshot"
      ? clone(asRecord(oldEntry?.source_snapshot && oldEntry?.link_mode === "snapshot" ? oldEntry.source_snapshot : globalItem))
      : undefined;
    const base = linkMode === "snapshot" ? sourceSnapshot! : globalItem;
    return {
      id,
      global_item_ref: { pricebook_id: GLOBAL_MARKET_PRICEBOOK_ID, item_id: id },
      link_mode: linkMode,
      ...(sourceSnapshot ? { source_snapshot: sourceSnapshot } : {}),
      overrides: sparseDifference(base, stripOrganizationMetadata(item))
    };
  });
  return {
    schema_version: PRICEBOOK_SCHEMA_VERSION,
    organization_ref: { id: organizationId },
    global_pricebook_ref: { id: GLOBAL_MARKET_PRICEBOOK_ID, revision: Number(global.manifest.revision || 1) },
    entries,
    settings: clone(organizationCatalog.settings || {}),
    metadata: {
      ...asRecord(previous?.metadata),
      storage_model: "global_references_with_sparse_overrides"
    }
  };
}

function materializeOrganizationCatalog(globalCatalog: PricebookCatalog, overlay: OrganizationPricebookOverlay): PricebookCatalog {
  const globalItems = new Map(globalCatalog.items.map((item) => [String(item.id), item]));
  const items = overlay.entries.map((entry): JsonObject | null => {
    const id = String(entry.id || asRecord(entry.global_item_ref).item_id || "");
    if (entry.link_mode === "local") {
      return {
        ...asRecord(entry.item),
        id,
        global_link_mode: "local"
      };
    }
    const currentGlobal = globalItems.get(id);
    const base = entry.link_mode === "snapshot" ? asRecord(entry.source_snapshot) : asRecord(currentGlobal);
    if (!Object.keys(base).length) return null;
    const overrides = asRecord(entry.overrides);
    return {
      ...(deepMerge(base, overrides) as JsonObject),
      id,
      global_item_ref: { pricebook_id: GLOBAL_MARKET_PRICEBOOK_ID, item_id: id },
      global_link_mode: entry.link_mode === "snapshot" ? "snapshot" : "live",
      global_overrides: clone(overrides),
      global_market_snapshot: clone(currentGlobal || base)
    };
  }).filter((item): item is JsonObject => item !== null);
  return normalizeCatalog({
    taxonomy: globalCatalog.taxonomy,
    items,
    variation_sets: globalCatalog.variation_sets,
    assets: globalCatalog.assets,
    settings: overlay.settings,
    metadata: {
      ...asRecord(globalCatalog.metadata),
      ...asRecord(overlay.metadata),
      pricebook_layer: "organization",
      global_pricebook_ref: overlay.global_pricebook_ref
    }
  });
}

function stripOrganizationMetadata(value: Record<string, unknown>) {
  const result = clone(value);
  ["global_item_ref", "global_link_mode", "global_overrides", "global_market_snapshot"].forEach((key) => delete result[key]);
  return result;
}

function sparseDifference(baseValue: unknown, nextValue: unknown): unknown {
  if (Array.isArray(baseValue) || Array.isArray(nextValue)) {
    return JSON.stringify(baseValue ?? null) === JSON.stringify(nextValue ?? null) ? undefined : clone(nextValue);
  }
  if (isRecord(baseValue) && isRecord(nextValue)) {
    const output: JsonObject = {};
    for (const [key, value] of Object.entries(nextValue)) {
      const difference = sparseDifference(baseValue[key], value);
      if (difference !== undefined) output[key] = difference;
    }
    return Object.keys(output).length ? output : undefined;
  }
  return Object.is(baseValue, nextValue) ? undefined : clone(nextValue);
}

function normalizeCatalog(value: unknown): PricebookCatalog {
  const source = asRecord(value);
  const variationSets = source.variation_sets ?? source.variationSets;
  const catalog = {
    taxonomy: isRecord(source.taxonomy) ? source.taxonomy : clone(DEFAULT_PRICEBOOK_TEMPLATE.catalog.taxonomy),
    items: Array.isArray(source.items) ? source.items.map((item, index) => normalizeItem(asRecord(item), index)).sort(compareItems) : [],
    variation_sets: Array.isArray(variationSets)
      ? variationSets.map((set, index) => normalizeVariationSet(asRecord(set), index))
      : [],
    assets: Array.isArray(source.assets) ? source.assets.map((asset) => normalizeAsset(asRecord(asset))) : [],
    settings: isRecord(source.settings) ? source.settings : {},
    metadata: isRecord(source.metadata) ? source.metadata : {}
  };
  validateCatalogGraph(catalog);
  return catalog;
}

function normalizeItem(value: Record<string, unknown>, index: number) {
  const unitPrice = Number(value.unit_price ?? value.unitPrice ?? value.base_price ?? value.basePrice ?? 0);
  const mediaRefs = value.media_refs ?? value.mediaRefs;
  const variationSetRefs = value.variation_set_refs ?? value.variationSetRefs;
  const selectionGroups = value.selection_groups ?? value.selectionGroups;
  return {
    ...value,
    id: String(value.id ?? "").trim() || `item_${index + 1}`,
    kind: String(value.kind ?? (Array.isArray(value.components) && value.components.length ? "assembly" : "atomic")),
    name: String(value.name ?? "").trim() || "New Pricebook Item",
    code: value.code == null ? undefined : String(value.code),
    type: String(value.type ?? value.product_type ?? value.category ?? "Item"),
    category: String(value.category ?? "shingle_roofs"),
    manufacturer: value.manufacturer == null ? "" : String(value.manufacturer),
    segment: String(value.segment ?? "all"),
    unit: String(value.unit ?? "ea"),
    unit_price: Number.isFinite(unitPrice) ? unitPrice : 0,
    base_price: Number.isFinite(Number(value.base_price ?? value.basePrice)) ? Number(value.base_price ?? value.basePrice) : (Number.isFinite(unitPrice) ? unitPrice : 0),
    internal_cost: Number.isFinite(Number(value.internal_cost ?? value.internalCost)) ? Number(value.internal_cost ?? value.internalCost) : 0,
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
    formulaConfig: normalizeFormulaConfig(asRecord(value.formulaConfig || value.formula_config)),
    formula_config: isRecord(value.formula_config) ? value.formula_config : normalizeFormulaConfig(asRecord(value.formulaConfig)),
    autoAdd: Boolean(value.autoAdd ?? false),
    auto_add: Boolean(value.auto_add ?? value.autoAdd ?? false),
    description: value.description == null ? "" : String(value.description),
    internal_description: value.internal_description == null ? String(value.internalDescription ?? "") : String(value.internal_description),
    external_description: value.external_description == null ? String(value.externalDescription ?? value.description ?? "") : String(value.external_description),
    variables: isRecord(value.variables) ? value.variables : {},
    measurements: isRecord(value.measurements) ? value.measurements : {},
    media_refs: Array.isArray(mediaRefs)
      ? mediaRefs.map(asRecord)
      : [],
    variation_set_refs: Array.isArray(variationSetRefs)
      ? variationSetRefs.map((entry) => String(entry)).filter(Boolean)
      : [],
    variation_overrides: isRecord(value.variation_overrides || value.variationOverrides) ? asRecord(value.variation_overrides || value.variationOverrides) : {},
    variations: Array.isArray(value.variations) ? value.variations.map((variation, variationIndex) => normalizeVariation(asRecord(variation), variationIndex)) : [],
    variant_dimensions: Array.isArray(value.variant_dimensions || value.variantDimensions)
      ? ((value.variant_dimensions || value.variantDimensions) as unknown[]).map((dimension, dimensionIndex) => normalizeVariantDimension(asRecord(dimension), dimensionIndex))
      : [],
    variant_overrides: isRecord(value.variant_overrides || value.variantOverrides) ? asRecord(value.variant_overrides || value.variantOverrides) : {},
    default_variant_selection: isRecord(value.default_variant_selection || value.defaultVariantSelection) ? asRecord(value.default_variant_selection || value.defaultVariantSelection) : {},
    default_pricing_update_rule: normalizePriceUpdateRule(asRecord(value.default_pricing_update_rule || value.defaultPricingUpdateRule)),
    selection: isRecord(value.selection) ? value.selection : {},
    selection_groups: Array.isArray(selectionGroups)
      ? selectionGroups.map(asRecord)
      : [],
    components: Array.isArray(value.components) ? value.components.map((component, componentIndex) => normalizeComponent(asRecord(component), componentIndex)) : [],
    images: Array.isArray(value.images)
      ? value.images.map((image) => ({
        asset_id: String(asRecord(image).asset_id ?? ""),
        role: asRecord(image).role == null ? undefined : String(asRecord(image).role),
        alt: asRecord(image).alt == null ? undefined : String(asRecord(image).alt)
      })).filter((image) => image.asset_id)
      : [],
    options: Array.isArray(value.options) ? value.options.map((option) => normalizeOption(asRecord(option))) : [],
    sort_order: Number.isFinite(Number(value.sort_order)) ? Number(value.sort_order) : (index + 1) * 10,
    status: String(value.status ?? "active"),
    metadata: isRecord(value.metadata) ? value.metadata : {}
  };
}

function normalizeVariantDimension(value: Record<string, unknown>, index: number) {
  const kind = ["color", "option", "pricing_policy"].includes(String(value.kind)) ? String(value.kind) : "option";
  return {
    ...value,
    id: String(value.id ?? `dimension_${index + 1}`).trim(),
    label: String(value.label ?? value.name ?? `Dimension ${index + 1}`),
    kind,
    affects_sku: kind === "pricing_policy" ? false : value.affects_sku !== false,
    values: Array.isArray(value.values) ? value.values.map((entry, valueIndex) => normalizeVariantDimensionValue(asRecord(entry), valueIndex)) : [],
    metadata: isRecord(value.metadata) ? value.metadata : {}
  };
}

function normalizeVariantDimensionValue(value: Record<string, unknown>, index: number) {
  return {
    ...value,
    id: String(value.id ?? value.value ?? `value_${index + 1}`).trim(),
    label: String(value.label ?? value.name ?? value.id ?? `Value ${index + 1}`),
    hex: value.hex == null ? null : String(value.hex),
    image: value.image == null ? null : String(value.image),
    adjustment: isRecord(value.adjustment) ? value.adjustment : { operation: "none", value: 0, target: "sell_price" },
    pricing_update_rule: normalizePriceUpdateRule(asRecord(value.pricing_update_rule || value.pricingUpdateRule)),
    metadata: isRecord(value.metadata) ? value.metadata : {}
  };
}

function normalizePriceUpdateRule(value: Record<string, unknown>) {
  const mode = ["fixed", "live", "conditional"].includes(String(value.mode)) ? String(value.mode) : "fixed";
  return {
    ...value,
    id: String(value.id ?? (mode === "fixed" ? "fixed_forever" : mode)),
    label: String(value.label ?? (mode === "fixed" ? "Fixed forever" : mode === "live" ? "Live price" : "Conditional price")),
    mode,
    source: String(value.source ?? "organization_pricebook"),
    lock_on: Array.isArray(value.lock_on) ? value.lock_on.map(String) : [],
    formula: value.formula == null ? null : String(value.formula)
  };
}

function normalizeComponent(value: Record<string, unknown>, index: number) {
  return {
    ...value,
    id: String(value.id ?? `component_${index + 1}`),
    item_ref: String(value.item_ref ?? value.itemRef ?? value.item_id ?? value.itemId ?? "").trim(),
    included: Boolean(value.included ?? false),
    price_driving: value.price_driving !== false && value.priceDriving !== false,
    selection: isRecord(value.selection) ? value.selection : {},
    variation_selection: isRecord(value.variation_selection || value.variationSelection) ? asRecord(value.variation_selection || value.variationSelection) : {},
    variables: isRecord(value.variables) ? value.variables : {},
    measurements: isRecord(value.measurements) ? value.measurements : {},
    overrides: isRecord(value.overrides) ? value.overrides : {}
  };
}

function normalizeVariationSet(value: Record<string, unknown>, index: number) {
  return {
    ...value,
    id: String(value.id ?? `variation_set_${index + 1}`).trim(),
    label: String(value.label ?? value.name ?? value.id ?? `Variation Set ${index + 1}`),
    variable_key: String(value.variable_key ?? value.variableKey ?? value.id ?? `variation_${index + 1}`),
    values: Array.isArray(value.values) ? value.values.map((entry, valueIndex) => normalizeVariationValue(asRecord(entry), valueIndex)) : []
  };
}

function normalizeVariationValue(value: Record<string, unknown>, index: number) {
  const mediaRefs = value.media_refs ?? value.mediaRefs;
  return {
    ...value,
    id: String(value.id ?? value.value ?? `value_${index + 1}`).trim(),
    label: String(value.label ?? value.name ?? value.id ?? `Value ${index + 1}`),
    media_refs: Array.isArray(mediaRefs) ? mediaRefs.map(asRecord) : [],
    overrides: isRecord(value.overrides) ? value.overrides : {}
  };
}

function normalizeVariation(value: Record<string, unknown>, index: number) {
  return {
    ...value,
    id: String(value.id ?? `variation_${index + 1}`).trim(),
    label: String(value.label ?? value.name ?? value.id ?? `Variation ${index + 1}`),
    overrides: isRecord(value.overrides) ? value.overrides : {}
  };
}

function normalizeFormulaConfig(value: Record<string, unknown>) {
  return {
    tokens: Array.isArray(value.tokens)
      ? value.tokens.map((token) => ({
        type: String(asRecord(token).type ?? "number"),
        value: String(asRecord(token).value ?? "")
      })).filter((token) => token.value)
      : [{ type: "number", value: "1" }],
    includeWaste: Boolean(value.includeWaste ?? false)
  };
}

function normalizeOption(value: Record<string, unknown>) {
  return {
    ...value,
    id: String(value.id ?? randomBytes(4).toString("hex")),
    label: String(value.label ?? "Option"),
    input_type: String(value.input_type ?? "single_select"),
    required: Boolean(value.required ?? false),
    values: Array.isArray(value.values) ? value.values.map((entry) => normalizeOptionValue(asRecord(entry))) : [],
    metadata: isRecord(value.metadata) ? value.metadata : {}
  };
}

function normalizeOptionValue(value: Record<string, unknown>) {
  return {
    ...value,
    id: String(value.id ?? randomBytes(4).toString("hex")),
    label: String(value.label ?? "Value"),
    description: value.description == null ? null : String(value.description),
    is_default: Boolean(value.is_default ?? false),
    metadata: isRecord(value.metadata) ? value.metadata : {}
  };
}

function normalizeAsset(value: Record<string, unknown>): CatalogAsset {
  return {
    id: String(value.id ?? generateAssetId()),
    file_name: String(value.file_name ?? "asset.bin"),
    stored_name: String(value.stored_name ?? sanitizeFileName(String(value.file_name ?? "asset.bin"))),
    content_type: value.content_type == null ? null : String(value.content_type),
    size: Number.isFinite(Number(value.size)) ? Number(value.size) : 0,
    kind: value.kind == null ? "file" : String(value.kind),
    label: value.label == null ? null : String(value.label),
    alt_text: value.alt_text == null ? null : String(value.alt_text),
    created_at: String(value.created_at ?? new Date().toISOString()),
    updated_at: String(value.updated_at ?? new Date().toISOString()),
    metadata: isRecord(value.metadata) ? value.metadata : {}
  };
}

function deriveCounts(catalog: PricebookCatalog) {
  return { items: catalog.items.length, variation_sets: catalog.variation_sets.length, assets: catalog.assets.length };
}

function nextCatalogRecord(current: SharedPricebookRecord, catalog: PricebookCatalog): SharedPricebookRecord {
  return {
    catalog,
    manifest: {
      ...current.manifest,
      revision: current.manifest.revision + 1,
      timestamps: { ...asRecord(current.manifest.timestamps), updated_at: toSqlDate(new Date().toISOString()) },
      counts: deriveCounts(catalog)
    }
  };
}

function compareItems(a: Record<string, unknown>, b: Record<string, unknown>) {
  return Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)
    || String(a.name ?? "").localeCompare(String(b.name ?? ""));
}

function assertExpectedRevision(manifest: PricebookManifest, expectedRevision?: number) {
  if (expectedRevision == null) return;
  if (manifest.revision !== expectedRevision) {
    throw conflict(
      "revision_conflict",
      `Expected revision ${expectedRevision}, but price book '${manifest.id}' is at revision ${manifest.revision}.`,
      { expected_revision: expectedRevision, actual_revision: manifest.revision }
    );
  }
}

async function backupManifestIfPresent(directory: string, manifestPath: string) {
  try {
    const existing = await readFile(manifestPath);
    const backupDirectory = path.join(directory, "manifest_backups");
    await mkdir(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFileAtomic(path.join(backupDirectory, `manifest_${stamp}.json`), existing);
  } catch {
    return;
  }
}

async function writeFileAtomic(filePath: string, content: string | Uint8Array) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pricebook-"));
  const tempPath = path.join(tempDir, path.basename(filePath));
  await writeFile(tempPath, content);
  await rename(tempPath, filePath);
  await rm(tempDir, { recursive: true, force: true });
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

async function readJsonFile<T>(filePath: string, missing?: { code: string; message: string }): Promise<T> {
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && missing) {
      throw notFound(missing.code, missing.message);
    }
    throw error;
  });
  return JSON.parse(raw) as T;
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(patch)) {
    return patch;
  }
  if (isRecord(base) && isRecord(patch)) {
    const output: JsonObject = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      output[key] = key in output ? deepMerge(output[key], value) : value;
    }
    return output;
  }
  return patch;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function toSqlDate(isoString: string) {
  return isoString.slice(0, 19).replace("T", " ");
}

function inferAssetKind(fileName: string, contentType?: string) {
  if ((contentType ?? "").startsWith("image/")) return "image";
  const ext = path.extname(fileName).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext) ? "image" : "file";
}
