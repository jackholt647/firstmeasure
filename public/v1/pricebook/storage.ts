import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { env } from "../src/config/env.js";
import { DEFAULT_TEMPLATE_KEY, PRICEBOOK_FILE_NAMES, PRICEBOOK_SCHEMA_VERSION } from "./constants.js";
import { DEFAULT_PRICEBOOK_TEMPLATE } from "./default_template.js";
import { badRequest, conflict, notFound } from "./errors.js";

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
  assets: CatalogAsset[];
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type FileEntry = {
  name: string;
  size: number;
  updated_at: string;
};

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
  await ensurePricebookStorage();
  const pricebookId = input.id ? sanitizePricebookId(String(input.id)) : generatePricebookId();
  const manifestPath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.manifest);
  if (await pathExists(manifestPath)) {
    throw conflict("pricebook_already_exists", `Price book '${pricebookId}' already exists.`);
  }

  const templateKey = String(input.template_key ?? DEFAULT_TEMPLATE_KEY);
  const catalog = normalizeCatalog(readTemplateCatalog(templateKey));
  const nowSql = toSqlDate(new Date().toISOString());
  await mkdir(pricebookAssetsRoot(pricebookId), { recursive: true });

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
  await saveCatalog(created.manifest.id, source.catalog, 1);
  return getPricebookDetail(created.manifest.id);
}

export async function listPricebookManifests() {
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
  const filePath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.manifest);
  return readJsonFile<PricebookManifest>(filePath, {
    code: "pricebook_not_found",
    message: `Price book '${pricebookId}' does not exist.`
  });
}

export async function saveManifest(pricebookId: string, manifest: PricebookManifest) {
  const directory = pricebookDir(pricebookId);
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, PRICEBOOK_FILE_NAMES.manifest);
  await backupManifestIfPresent(directory, manifestPath);
  await writeJsonAtomic(manifestPath, manifest);
}

export async function patchManifest(pricebookId: string, patch: JsonObject, expectedRevision?: number) {
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
  const filePath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.catalog);
  const raw = await readJsonFile<PricebookCatalog>(filePath, {
    code: "catalog_not_found",
    message: `Catalog for price book '${pricebookId}' does not exist.`
  });
  return normalizeCatalog(raw);
}

async function saveCatalogRaw(pricebookId: string, catalog: PricebookCatalog) {
  const filePath = path.join(pricebookDir(pricebookId), PRICEBOOK_FILE_NAMES.catalog);
  await writeJsonAtomic(filePath, catalog);
}

export async function saveCatalog(pricebookId: string, catalogInput: unknown, expectedRevision?: number) {
  const manifest = await readManifest(pricebookId);
  assertExpectedRevision(manifest, expectedRevision);
  const catalog = normalizeCatalog(catalogInput);
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

export async function createItem(pricebookId: string, itemInput: Record<string, unknown>, expectedRevision?: number) {
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

function normalizeCatalog(value: unknown): PricebookCatalog {
  const source = asRecord(value);
  return {
    taxonomy: isRecord(source.taxonomy) ? source.taxonomy : clone(DEFAULT_PRICEBOOK_TEMPLATE.catalog.taxonomy),
    items: Array.isArray(source.items) ? source.items.map((item, index) => normalizeItem(asRecord(item), index)).sort(compareItems) : [],
    assets: Array.isArray(source.assets) ? source.assets.map((asset) => normalizeAsset(asRecord(asset))) : [],
    settings: isRecord(source.settings) ? source.settings : {},
    metadata: isRecord(source.metadata) ? source.metadata : {}
  };
}

function normalizeItem(value: Record<string, unknown>, index: number) {
  const unitPrice = Number(value.unitPrice ?? 0);
  return {
    ...value,
    id: String(value.id ?? "").trim() || `item_${index + 1}`,
    name: String(value.name ?? "").trim() || "New Pricebook Item",
    code: value.code == null ? undefined : String(value.code),
    category: String(value.category ?? "shingle_roofs"),
    manufacturer: String(value.manufacturer ?? "generic"),
    segment: String(value.segment ?? "all"),
    unit: String(value.unit ?? "ea"),
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
    formulaConfig: normalizeFormulaConfig(asRecord(value.formulaConfig)),
    autoAdd: Boolean(value.autoAdd ?? false),
    description: value.description == null ? "" : String(value.description),
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
  return { items: catalog.items.length, assets: catalog.assets.length };
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
