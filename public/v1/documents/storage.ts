import { createHash, randomUUID } from "node:crypto";

import { conflict, notFound } from "../platform/errors.js";
import {
  listDocuments,
  listOrganizations,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { emitWorkEvent } from "../work/engine.js";
import { DOCUMENT_SCHEMA_VERSION } from "./schemas.js";

/**
 * Collection names live in platform/storage.ts COLLECTIONS (added by the
 * integrator). The platform storage API accepts plain strings and validates
 * at runtime, so no PlatformCollection casting is needed here.
 */
export const DOCUMENT_TEMPLATE_COLLECTION = "document_templates";
export const DOCUMENT_TEMPLATE_VERSION_COLLECTION = "document_template_versions";
export const DOCUMENT_COLLECTION = "documents";
export const DOCUMENT_SNAPSHOT_COLLECTION = "document_snapshots";
export const DOCUMENT_EVENT_COLLECTION = "document_events";
export const DOCUMENT_THEME_COLLECTION = "document_themes";
export const DOCUMENT_THEME_VERSION_COLLECTION = "document_theme_versions";
export const DOCUMENT_WORKFLOW_COLLECTION = "document_workflows";
export const DOCUMENT_WORKFLOW_VERSION_COLLECTION = "document_workflow_versions";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
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

export function definitionChecksum(definition: unknown) {
  return createHash("sha256").update(JSON.stringify(definition ?? null)).digest("hex");
}

function normalizeAssetId(value: unknown, prefix: string) {
  const cleaned = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
  return cleaned || `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function documentData(document: JsonObject) {
  return asObject(document.data);
}

function documentView(document: JsonObject): JsonObject {
  const data = documentData(document);
  return {
    ...data,
    id: cleanText(data.id || document.id),
    revision: Number(document.revision || 0),
    created_at: cleanText(document.created_at || data.created_at),
    updated_at: cleanText(document.updated_at || data.updated_at)
  };
}

// ---------------------------------------------------------------------------
// Versioned assets (templates + themes share one publish flow)
// ---------------------------------------------------------------------------

type VersionedAssetOptions = {
  collection: string;
  versionCollection: string;
  kind: string;
  versionKind: string;
  idPrefix: string;
  notFoundCode: string;
  conflictCode: string;
};

const TEMPLATE_ASSET: VersionedAssetOptions = {
  collection: DOCUMENT_TEMPLATE_COLLECTION,
  versionCollection: DOCUMENT_TEMPLATE_VERSION_COLLECTION,
  kind: "document_template",
  versionKind: "document_template_version",
  idPrefix: "doctpl",
  notFoundCode: "document_template_not_found",
  conflictCode: "document_template_version_conflict"
};

const THEME_ASSET: VersionedAssetOptions = {
  collection: DOCUMENT_THEME_COLLECTION,
  versionCollection: DOCUMENT_THEME_VERSION_COLLECTION,
  kind: "document_theme",
  versionKind: "document_theme_version",
  idPrefix: "docthm",
  notFoundCode: "document_theme_not_found",
  conflictCode: "document_theme_version_conflict"
};

const WORKFLOW_ASSET: VersionedAssetOptions = {
  collection: DOCUMENT_WORKFLOW_COLLECTION,
  versionCollection: DOCUMENT_WORKFLOW_VERSION_COLLECTION,
  kind: "document_workflow",
  versionKind: "document_workflow_version",
  idPrefix: "docwfl",
  notFoundCode: "document_workflow_not_found",
  conflictCode: "document_workflow_version_conflict"
};

function versionRowId(asset: VersionedAssetOptions, orgId: string, assetId: string, version: number) {
  return `${asset.idPrefix}_version_${hashId(`${orgId}:${asset.kind}:${assetId}:${version}`)}`;
}

async function listAssets(orgId: string, asset: VersionedAssetOptions) {
  const docs = await listDocuments(orgId, asset.collection);
  return docs
    .map(documentView)
    .filter((item) => cleanText(asObject(item).kind || asset.kind) === asset.kind)
    .sort((a, b) => cleanText(a.name).localeCompare(cleanText(b.name)));
}

async function readAsset(orgId: string, asset: VersionedAssetOptions, assetId: string) {
  const document = await readDocument(orgId, asset.collection, assetId).catch(() => null);
  if (!document) throw notFound(asset.notFoundCode, "The requested document asset was not found.");
  const view = documentView(document);
  if (cleanText(view.organization_id) && cleanText(view.organization_id) !== orgId) {
    throw notFound(asset.notFoundCode, "The requested document asset was not found.");
  }
  return view;
}

async function readAssetVersion(orgId: string, asset: VersionedAssetOptions, assetId: string, version?: number) {
  if (version) {
    const row = await readDocument(orgId, asset.versionCollection, versionRowId(asset, orgId, assetId, version)).catch(() => null);
    return row ? documentView(row) : null;
  }
  const versions = await listAssetVersions(orgId, asset, assetId);
  return versions[0] || null;
}

async function listAssetVersions(orgId: string, asset: VersionedAssetOptions, assetId: string) {
  const docs = await listDocuments(orgId, asset.versionCollection);
  return docs
    .map(documentView)
    .filter((row) => cleanText(row.kind) === asset.versionKind && cleanText(row.template_id) === assetId)
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
}

async function createAsset(orgId: string, asset: VersionedAssetOptions, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean } = {}) {
  const id = normalizeAssetId(input.id, asset.idPrefix);
  const now = nowIso();
  const definition = asObject(input.definition);
  const hasDefinition = Object.keys(definition).length > 0;
  const data: JsonObject = {
    schema_version: DOCUMENT_SCHEMA_VERSION,
    id,
    kind: asset.kind,
    organization_id: orgId,
    name: cleanText(input.name) || "Untitled",
    ...(asset.kind === "document_template" ? { document_type: cleanText(input.document_type || "generic") || "generic" } : {}),
    description: cleanText(input.description),
    tags: asArray(input.tags).map(cleanText).filter(Boolean),
    status: cleanText(input.status || "draft") || "draft",
    current_version: 0,
    preview_media_ref: asObject(input.preview_media_ref),
    metadata: {
      ...asObject(input.metadata),
      ...(options.systemPreset ? {} : { preset: false })
    },
    created_by_user_id: ctx?.userId || "",
    updated_by_user_id: ctx?.userId || "",
    created_at: now,
    updated_at: now
  };
  await upsertDocument(orgId, asset.collection, {
    id,
    data,
    metadata: { kind: asset.kind, document_type: cleanText(data.document_type), status: cleanText(data.status) }
  }, { replace: true });
  if (hasDefinition) {
    return await publishAsset(orgId, asset, id, { definition, expected_version: 0 }, ctx, options);
  }
  return await readAsset(orgId, asset, id);
}

async function patchAsset(orgId: string, asset: VersionedAssetOptions, assetId: string, patch: JsonObject, ctx: PlatformAuthContext | null) {
  const current = await readAsset(orgId, asset, assetId);
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(current.revision || 0)) {
    throw conflict("document_asset_revision_conflict", "The document asset revision does not match.");
  }
  const data: JsonObject = {
    ...current,
    folder_id: Object.prototype.hasOwnProperty.call(patch, "folder_id") ? cleanText(patch.folder_id) || cleanText(current.folder_id) : current.folder_id,
    name: Object.prototype.hasOwnProperty.call(patch, "name") ? cleanText(patch.name) || cleanText(current.name) : current.name,
    description: Object.prototype.hasOwnProperty.call(patch, "description") ? cleanText(patch.description) : current.description,
    tags: Object.prototype.hasOwnProperty.call(patch, "tags") ? asArray(patch.tags).map(cleanText).filter(Boolean) : current.tags,
    status: Object.prototype.hasOwnProperty.call(patch, "status") ? cleanText(patch.status) || cleanText(current.status) : current.status,
    preview_media_ref: Object.prototype.hasOwnProperty.call(patch, "preview_media_ref") ? asObject(patch.preview_media_ref) : current.preview_media_ref,
    metadata: { ...asObject(current.metadata), ...asObject(patch.metadata) },
    updated_by_user_id: ctx?.userId || cleanText(current.updated_by_user_id),
    updated_at: nowIso()
  };
  delete data.revision;
  await upsertDocument(orgId, asset.collection, {
    id: assetId,
    expected_revision: expectedRevision || undefined,
    data,
    metadata: { kind: asset.kind, document_type: cleanText(data.document_type), status: cleanText(data.status) }
  }, { replace: true });
  return await readAsset(orgId, asset, assetId);
}

async function archiveAsset(orgId: string, asset: VersionedAssetOptions, assetId: string, ctx: PlatformAuthContext | null) {
  return await patchAsset(orgId, asset, assetId, { status: "archived" }, ctx);
}

/**
 * Publish flow: version rows are immutable, carry a sha256 checksum of the
 * definition JSON, and bump the asset's current_version pointer. Passing
 * expected_version guards against concurrent publishes.
 */
async function publishAsset(orgId: string, asset: VersionedAssetOptions, assetId: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean } = {}) {
  const current = await readAsset(orgId, asset, assetId);
  const currentVersion = Number(current.current_version || 0);
  const expectedVersion = Number(input.expected_version ?? NaN);
  if (Number.isFinite(expectedVersion) && expectedVersion !== currentVersion) {
    throw conflict(asset.conflictCode, "The published version does not match the current version.", {
      expected_version: expectedVersion,
      current_version: currentVersion
    });
  }
  const nextVersion = currentVersion + 1;
  const definition = asObject(input.definition);
  const now = nowIso();
  const versionId = versionRowId(asset, orgId, assetId, nextVersion);
  await upsertDocument(orgId, asset.versionCollection, {
    id: versionId,
    data: {
      schema_version: DOCUMENT_SCHEMA_VERSION,
      id: versionId,
      kind: asset.versionKind,
      organization_id: orgId,
      template_id: assetId,
      version: nextVersion,
      definition,
      checksum: definitionChecksum(definition),
      published_at: now,
      published_by: ctx?.userId || "system",
      locked: true
    },
    metadata: { kind: asset.versionKind, template_id: assetId, version: nextVersion }
  }, { replace: true });
  const existingMetadata = asObject(current.metadata);
  const metadata = options.systemPreset
    ? { ...existingMetadata, ...asObject(input.metadata) }
    : {
        ...existingMetadata,
        ...asObject(input.metadata),
        ...(existingMetadata.preset === true ? { preset: false, based_on_preset: cleanText(existingMetadata.preset_id || assetId) } : {})
      };
  await upsertDocument(orgId, asset.collection, {
    id: assetId,
    data: {
      ...current,
      status: cleanText(current.status) === "draft" ? "active" : current.status,
      current_version: nextVersion,
      metadata,
      updated_by_user_id: ctx?.userId || "system",
      updated_at: now,
      revision: undefined
    },
    metadata: { kind: asset.kind, document_type: cleanText(current.document_type), status: cleanText(current.status) === "draft" ? "active" : cleanText(current.status) }
  }, { replace: true });
  return await readAsset(orgId, asset, assetId);
}

// --- template façade ---------------------------------------------------------

export async function listDocumentTemplates(orgId: string, filter: { document_type?: string; status?: string } = {}) {
  const templates = await listAssets(orgId, TEMPLATE_ASSET);
  return templates.filter((template) => {
    if (filter.document_type && cleanText(template.document_type) !== cleanText(filter.document_type)) return false;
    if (filter.status && cleanText(template.status) !== cleanText(filter.status)) return false;
    if (!filter.status && cleanText(template.status) === "archived") return false;
    return true;
  });
}

export async function readDocumentTemplate(orgId: string, templateId: string) {
  return await readAsset(orgId, TEMPLATE_ASSET, templateId);
}

export async function createDocumentTemplate(orgId: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean } = {}) {
  return await createAsset(orgId, TEMPLATE_ASSET, input, ctx, options);
}

export async function patchDocumentTemplate(orgId: string, templateId: string, patch: JsonObject, ctx: PlatformAuthContext | null) {
  return await patchAsset(orgId, TEMPLATE_ASSET, templateId, patch, ctx);
}

export async function archiveDocumentTemplate(orgId: string, templateId: string, ctx: PlatformAuthContext | null) {
  return await archiveAsset(orgId, TEMPLATE_ASSET, templateId, ctx);
}

export async function publishDocumentTemplate(orgId: string, templateId: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean } = {}) {
  return await publishAsset(orgId, TEMPLATE_ASSET, templateId, input, ctx, options);
}

export async function listDocumentTemplateVersions(orgId: string, templateId: string) {
  return await listAssetVersions(orgId, TEMPLATE_ASSET, templateId);
}

export async function readDocumentTemplateVersion(orgId: string, templateId: string, version?: number) {
  return await readAssetVersion(orgId, TEMPLATE_ASSET, templateId, version);
}

// --- theme façade --------------------------------------------------------------

export async function listDocumentThemes(orgId: string, filter: { status?: string } = {}) {
  const themes = await listAssets(orgId, THEME_ASSET);
  return themes.filter((theme) => {
    if (filter.status && cleanText(theme.status) !== cleanText(filter.status)) return false;
    if (!filter.status && cleanText(theme.status) === "archived") return false;
    return true;
  });
}

export async function readDocumentTheme(orgId: string, themeId: string) {
  return await readAsset(orgId, THEME_ASSET, themeId);
}

export async function createDocumentTheme(orgId: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean } = {}) {
  return await createAsset(orgId, THEME_ASSET, input, ctx, options);
}

export async function patchDocumentTheme(orgId: string, themeId: string, patch: JsonObject, ctx: PlatformAuthContext | null) {
  return await patchAsset(orgId, THEME_ASSET, themeId, patch, ctx);
}

export async function archiveDocumentTheme(orgId: string, themeId: string, ctx: PlatformAuthContext | null) {
  return await archiveAsset(orgId, THEME_ASSET, themeId, ctx);
}

export async function publishDocumentTheme(orgId: string, themeId: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean } = {}) {
  return await publishAsset(orgId, THEME_ASSET, themeId, input, ctx, options);
}

export async function listDocumentThemeVersions(orgId: string, themeId: string) {
  return await listAssetVersions(orgId, THEME_ASSET, themeId);
}

export async function readDocumentThemeVersion(orgId: string, themeId: string, version?: number) {
  return await readAssetVersion(orgId, THEME_ASSET, themeId, version);
}

// --- workflow façade (same versioned-asset engine as templates/themes) -------

export async function listDocumentWorkflows(orgId: string, filter: { status?: string } = {}) {
  const workflows = await listAssets(orgId, WORKFLOW_ASSET);
  return workflows.filter((workflow) => {
    if (filter.status && cleanText(workflow.status) !== cleanText(filter.status)) return false;
    if (!filter.status && cleanText(workflow.status) === "archived") return false;
    return true;
  });
}

export async function readDocumentWorkflow(orgId: string, workflowId: string) {
  return await readAsset(orgId, WORKFLOW_ASSET, workflowId);
}

export async function createDocumentWorkflow(orgId: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean } = {}) {
  return await createAsset(orgId, WORKFLOW_ASSET, input, ctx, options);
}

export async function patchDocumentWorkflow(orgId: string, workflowId: string, patch: JsonObject, ctx: PlatformAuthContext | null) {
  return await patchAsset(orgId, WORKFLOW_ASSET, workflowId, patch, ctx);
}

export async function archiveDocumentWorkflow(orgId: string, workflowId: string, ctx: PlatformAuthContext | null) {
  return await archiveAsset(orgId, WORKFLOW_ASSET, workflowId, ctx);
}

export async function publishDocumentWorkflow(orgId: string, workflowId: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean } = {}) {
  return await publishAsset(orgId, WORKFLOW_ASSET, workflowId, input, ctx, options);
}

export async function listDocumentWorkflowVersions(orgId: string, workflowId: string) {
  return await listAssetVersions(orgId, WORKFLOW_ASSET, workflowId);
}

export async function readDocumentWorkflowVersion(orgId: string, workflowId: string, version?: number) {
  return await readAssetVersion(orgId, WORKFLOW_ASSET, workflowId, version);
}

// ---------------------------------------------------------------------------
// Folders (Doc Studio marketing/custom tabs) + folder items — unversioned:
// items autosave their DocModel definition inline; no publish flow.
// ---------------------------------------------------------------------------

export const DOCUMENT_FOLDER_COLLECTION = "document_folders";
export const DOCUMENT_FOLDER_ITEM_COLLECTION = "document_folder_items";
export const DOCUMENT_FOLDER_ITEM_VERSION_COLLECTION = "document_folder_item_versions";

export const MARKETING_FOLDER_ID = "docfld_marketing";
export const FOLDER_ITEM_TYPES = ["media", "file", "document", "visual_document"];

function folderView(document: JsonObject) {
  return documentView(document);
}

/** Idempotently seeds the blessed system folders (currently just Marketing). */
export async function ensureDefaultDocumentFolders(orgId: string) {
  const existing = await readDocument(orgId, DOCUMENT_FOLDER_COLLECTION, MARKETING_FOLDER_ID).catch(() => null);
  if (existing) return;
  const now = nowIso();
  await upsertDocument(orgId, DOCUMENT_FOLDER_COLLECTION, {
    id: MARKETING_FOLDER_ID,
    data: {
      schema_version: DOCUMENT_SCHEMA_VERSION,
      id: MARKETING_FOLDER_ID,
      kind: "document_folder",
      organization_id: orgId,
      key: "marketing",
      label: "Marketing",
      icon: "fa-bullhorn",
      position: 0,
      status: "active",
      system: true,
      metadata: {},
      created_by_user_id: "system",
      updated_by_user_id: "system",
      created_at: now,
      updated_at: now
    },
    metadata: { kind: "document_folder", key: "marketing", status: "active" }
  }, { replace: true });
}

export async function listDocumentFolders(orgId: string, filter: { status?: string } = {}) {
  const docs = await listDocuments(orgId, DOCUMENT_FOLDER_COLLECTION);
  return docs
    .map(folderView)
    .filter((folder) => cleanText(folder.kind) === "document_folder")
    .filter((folder) => {
      if (filter.status) return cleanText(folder.status) === cleanText(filter.status);
      return cleanText(folder.status) !== "archived";
    })
    .sort((a, b) => (Number(a.position || 0) - Number(b.position || 0)) || cleanText(a.label).localeCompare(cleanText(b.label)));
}

export async function readDocumentFolder(orgId: string, folderId: string) {
  const document = await readDocument(orgId, DOCUMENT_FOLDER_COLLECTION, folderId).catch(() => null);
  if (!document) throw notFound("document_folder_not_found", "The requested folder was not found.");
  const view = folderView(document);
  if (cleanText(view.organization_id) && cleanText(view.organization_id) !== orgId) {
    throw notFound("document_folder_not_found", "The requested folder was not found.");
  }
  return view;
}

export async function createDocumentFolder(orgId: string, input: JsonObject, ctx: PlatformAuthContext | null) {
  const id = `docfld_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const now = nowIso();
  const active = await listDocumentFolders(orgId);
  const data: JsonObject = {
    schema_version: DOCUMENT_SCHEMA_VERSION,
    id,
    kind: "document_folder",
    organization_id: orgId,
    key: "",
    label: cleanText(input.label) || "Untitled",
    icon: cleanText(input.icon) || "fa-folder",
    position: Number.isFinite(Number(input.position)) && input.position !== undefined
      ? Number(input.position)
      : active.reduce((max, folder) => Math.max(max, Number(folder.position || 0)), 0) + 1,
    status: "active",
    system: false,
    metadata: asObject(input.metadata),
    created_by_user_id: ctx?.userId || "",
    updated_by_user_id: ctx?.userId || "",
    created_at: now,
    updated_at: now
  };
  await upsertDocument(orgId, DOCUMENT_FOLDER_COLLECTION, {
    id,
    data,
    metadata: { kind: "document_folder", status: "active" }
  }, { replace: true });
  return await readDocumentFolder(orgId, id);
}

export async function patchDocumentFolder(orgId: string, folderId: string, patch: JsonObject, ctx: PlatformAuthContext | null, options: { allowSystem?: boolean } = {}) {
  const current = await readDocumentFolder(orgId, folderId);
  if (current.system === true && !options.allowSystem) {
    throw conflict("document_folder_protected", "Built-in folders cannot be renamed or removed.");
  }
  const data: JsonObject = {
    ...current,
    label: Object.prototype.hasOwnProperty.call(patch, "label") ? cleanText(patch.label) || cleanText(current.label) : current.label,
    icon: Object.prototype.hasOwnProperty.call(patch, "icon") ? cleanText(patch.icon) || cleanText(current.icon) : current.icon,
    position: Object.prototype.hasOwnProperty.call(patch, "position") ? Number(patch.position) || 0 : current.position,
    status: Object.prototype.hasOwnProperty.call(patch, "status") ? cleanText(patch.status) || cleanText(current.status) : current.status,
    metadata: { ...asObject(current.metadata), ...asObject(patch.metadata) },
    updated_by_user_id: ctx?.userId || cleanText(current.updated_by_user_id),
    updated_at: nowIso()
  };
  delete data.revision;
  await upsertDocument(orgId, DOCUMENT_FOLDER_COLLECTION, {
    id: folderId,
    data,
    metadata: { kind: "document_folder", key: cleanText(data.key), status: cleanText(data.status) }
  }, { replace: true });
  return await readDocumentFolder(orgId, folderId);
}

export async function archiveDocumentFolder(orgId: string, folderId: string, ctx: PlatformAuthContext | null) {
  return await patchDocumentFolder(orgId, folderId, { status: "archived" }, ctx);
}

// --- folder items ------------------------------------------------------------

export async function listDocumentFolderItems(orgId: string, folderId: string, filter: { status?: string } = {}) {
  const docs = await listDocuments(orgId, DOCUMENT_FOLDER_ITEM_COLLECTION);
  return docs
    .map(documentView)
    .filter((item) => cleanText(item.kind) === "document_folder_item" && cleanText(item.folder_id) === folderId)
    .filter((item) => {
      if (filter.status) return cleanText(item.status) === cleanText(filter.status);
      return cleanText(item.status) !== "archived";
    })
    .sort((a, b) => cleanText(b.updated_at).localeCompare(cleanText(a.updated_at)))
    // List rows omit the (potentially large) DocModel definition; the detail
    // read supplies it for edit/preview.
    .map(({ definition, ...item }) => ({ ...item, has_definition: !!definition && Object.keys(asObject(definition)).length > 0 }));
}

export async function readDocumentFolderItem(orgId: string, itemId: string) {
  const document = await readDocument(orgId, DOCUMENT_FOLDER_ITEM_COLLECTION, itemId).catch(() => null);
  if (!document) throw notFound("document_folder_item_not_found", "The requested item was not found.");
  const view = documentView(document);
  if (cleanText(view.organization_id) && cleanText(view.organization_id) !== orgId) {
    throw notFound("document_folder_item_not_found", "The requested item was not found.");
  }
  return view;
}

export async function listDocumentFolderItemVersions(orgId: string, itemId: string) {
  const docs = await listDocuments(orgId, DOCUMENT_FOLDER_ITEM_VERSION_COLLECTION);
  return docs.map(documentView)
    .filter((version) => cleanText(version.item_id) === itemId)
    .sort((a, b) => Number(b.source_revision || 0) - Number(a.source_revision || 0));
}

export async function createDocumentFolderItem(orgId: string, folderId: string, input: JsonObject, ctx: PlatformAuthContext | null) {
  await readDocumentFolder(orgId, folderId);
  const id = `docfit_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const now = nowIso();
  const itemType = cleanText(input.item_type);
  const data: JsonObject = {
    schema_version: DOCUMENT_SCHEMA_VERSION,
    id,
    kind: "document_folder_item",
    organization_id: orgId,
    folder_id: folderId,
    item_type: itemType,
    name: cleanText(input.name) || "Untitled",
    media_ref: asObject(input.media_ref),
    definition: asObject(input.definition),
    status: "active",
    metadata: asObject(input.metadata),
    created_by_user_id: ctx?.userId || "",
    updated_by_user_id: ctx?.userId || "",
    created_at: now,
    updated_at: now
  };
  await upsertDocument(orgId, DOCUMENT_FOLDER_ITEM_COLLECTION, {
    id,
    data,
    metadata: { kind: "document_folder_item", folder_id: folderId, item_type: itemType, status: "active" }
  }, { replace: true });
  return await readDocumentFolderItem(orgId, id);
}

export async function patchDocumentFolderItem(orgId: string, itemId: string, patch: JsonObject, ctx: PlatformAuthContext | null) {
  const current = await readDocumentFolderItem(orgId, itemId);
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(current.revision || 0)) {
    throw conflict("document_folder_item_revision_conflict", "The item revision does not match.", {
      expected_revision: expectedRevision,
      current_revision: Number(current.revision || 0)
    });
  }
  const sourceRevision = Number(current.revision || 0);
  await upsertDocument(orgId, DOCUMENT_FOLDER_ITEM_VERSION_COLLECTION, {
    id: `${itemId}_r${sourceRevision}`,
    data: { ...current, item_id: itemId, source_revision: sourceRevision, captured_at: nowIso() },
    metadata: { kind: "document_folder_item_version", item_id: itemId, source_revision: sourceRevision }
  }, { replace: true });
  const data: JsonObject = {
    ...current,
    name: Object.prototype.hasOwnProperty.call(patch, "name") ? cleanText(patch.name) || cleanText(current.name) : current.name,
    media_ref: Object.prototype.hasOwnProperty.call(patch, "media_ref") ? asObject(patch.media_ref) : current.media_ref,
    definition: Object.prototype.hasOwnProperty.call(patch, "definition") ? asObject(patch.definition) : current.definition,
    status: Object.prototype.hasOwnProperty.call(patch, "status") ? cleanText(patch.status) || cleanText(current.status) : current.status,
    metadata: { ...asObject(current.metadata), ...asObject(patch.metadata) },
    updated_by_user_id: ctx?.userId || cleanText(current.updated_by_user_id),
    updated_at: nowIso()
  };
  delete data.revision;
  await upsertDocument(orgId, DOCUMENT_FOLDER_ITEM_COLLECTION, {
    id: itemId,
    expected_revision: expectedRevision || undefined,
    data,
    metadata: { kind: "document_folder_item", folder_id: cleanText(data.folder_id), item_type: cleanText(data.item_type), status: cleanText(data.status) }
  }, { replace: true });
  return await readDocumentFolderItem(orgId, itemId);
}

export async function archiveDocumentFolderItem(orgId: string, itemId: string, ctx: PlatformAuthContext | null) {
  return await patchDocumentFolderItem(orgId, itemId, { status: "archived" }, ctx);
}

// ---------------------------------------------------------------------------
// Document instances
// ---------------------------------------------------------------------------

export function documentInstanceId(input: JsonObject = {}) {
  const explicit = cleanText(input.id);
  if (explicit) return normalizeAssetId(explicit, "doc");
  return `doc_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function readDocumentInstance(orgId: string, documentId: string) {
  const document = await readDocument(orgId, DOCUMENT_COLLECTION, documentId).catch(() => null);
  if (!document) throw notFound("document_not_found", "Document was not found.");
  const view = documentView(document);
  if (cleanText(view.organization_id) && cleanText(view.organization_id) !== orgId) {
    throw notFound("document_not_found", "Document was not found.");
  }
  return view;
}

export async function listProjectDocuments(orgId: string, projectId: string) {
  const docs = await listDocuments(orgId, DOCUMENT_COLLECTION);
  return docs
    .map(documentView)
    .filter((item) => cleanText(item.project_id) === projectId)
    .sort((a, b) => cleanText(b.updated_at).localeCompare(cleanText(a.updated_at)));
}

export async function saveDocumentInstance(orgId: string, documentId: string, data: JsonObject, options: { expectedRevision?: number } = {}) {
  const next = { ...data };
  delete next.revision;
  const saved = await upsertDocument(orgId, DOCUMENT_COLLECTION, {
    id: documentId,
    expected_revision: options.expectedRevision || undefined,
    data: next,
    metadata: {
      kind: "document",
      document_type: cleanText(data.document_type),
      project_id: cleanText(data.project_id),
      status: cleanText(data.status)
    }
  }, { replace: true });
  return documentView(saved);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function listDocumentSnapshots(orgId: string, documentId: string) {
  const docs = await listDocuments(orgId, DOCUMENT_SNAPSHOT_COLLECTION);
  return docs
    .map(documentView)
    .filter((snapshot) => cleanText(snapshot.document_id) === documentId)
    .sort((a, b) => Number(a.snapshot_number || 0) - Number(b.snapshot_number || 0));
}

export async function readDocumentSnapshot(orgId: string, snapshotId: string) {
  const document = await readDocument(orgId, DOCUMENT_SNAPSHOT_COLLECTION, snapshotId).catch(() => null);
  if (!document) throw notFound("document_snapshot_not_found", "Document snapshot was not found.");
  return documentView(document);
}

export async function saveDocumentSnapshot(orgId: string, snapshotId: string, data: JsonObject) {
  const next = { ...data };
  delete next.revision;
  const saved = await upsertDocument(orgId, DOCUMENT_SNAPSHOT_COLLECTION, {
    id: snapshotId,
    data: next,
    metadata: {
      kind: "document_snapshot",
      document_id: cleanText(data.document_id),
      project_id: cleanText(data.project_id),
      ...(cleanText(data.public_token) ? { public_token: cleanText(data.public_token) } : {})
    }
  }, { replace: true });
  return documentView(saved);
}

export async function findPublicDocumentSnapshot(publicToken: string) {
  const token = cleanText(publicToken);
  if (!token) throw notFound("document_snapshot_not_found", "Document snapshot was not found.");
  const orgs = await listOrganizations();
  for (const org of orgs) {
    const orgId = cleanText(asObject(org).id);
    if (!orgId) continue;
    const snapshots = await listDocuments(orgId, DOCUMENT_SNAPSHOT_COLLECTION).catch(() => []);
    for (const doc of snapshots) {
      const snapshot = documentView(doc);
      if (cleanText(snapshot.public_token) === token
        || cleanText(asObject(doc.metadata).public_token) === token) {
        return { orgId, snapshot };
      }
    }
  }
  throw notFound("document_snapshot_not_found", "Document snapshot was not found.");
}

// ---------------------------------------------------------------------------
// Events — append-only audit rows mirrored into the work engine.
// ---------------------------------------------------------------------------

export async function listDocumentEvents(orgId: string, documentId: string) {
  const docs = await listDocuments(orgId, DOCUMENT_EVENT_COLLECTION);
  return docs
    .map(documentView)
    .filter((event) => cleanText(event.document_id) === documentId)
    .sort((a, b) => cleanText(a.created_at).localeCompare(cleanText(b.created_at)));
}

export async function recordDocumentEvent(
  orgId: string,
  documentValue: JsonObject,
  type: string,
  payload: JsonObject = {},
  ctx?: PlatformAuthContext | null,
  options: { emit?: boolean } = {}
) {
  const documentId = cleanText(documentValue.id);
  const now = nowIso();
  const id = `document_event_${hashId(`${documentId}:${type}:${Date.now()}:${randomUUID()}`)}`;
  const templateRef = asObject(documentValue.template_ref);
  const eventPayload: JsonObject = {
    document_id: documentId,
    document_type: cleanText(documentValue.document_type),
    template_id: cleanText(templateRef.template_id),
    project_id: cleanText(documentValue.project_id),
    ...payload
  };
  const data = {
    schema_version: DOCUMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    document_id: documentId,
    type,
    actor_user_id: ctx?.userId || cleanText(payload.actor_user_id),
    payload: eventPayload,
    created_at: now,
    updated_at: now
  };
  await upsertDocument(orgId, DOCUMENT_EVENT_COLLECTION, {
    id,
    data,
    metadata: { kind: "document_event", document_id: documentId, type }
  }, { replace: true });
  if (options.emit !== false) {
    // Emit with organization + project context when present; documents without
    // a project still emit (the work engine handles org-level events), but a
    // failed emission never breaks the document write.
    try {
      await emitWorkEvent({
        organization_id: orgId,
        branch_id: cleanText(documentValue.branch_id || "default") || "default",
        ...(cleanText(documentValue.project_id) ? { project_id: cleanText(documentValue.project_id) } : {}),
        type,
        idempotency_key: `${type}:${documentId}:${cleanText(payload.snapshot_id || payload.output_key || id)}`,
        payload: eventPayload,
        context: { actor_user_id: ctx?.userId || cleanText(payload.actor_user_id) }
      });
    } catch {
      // Work-event emission is best-effort from the document module's side.
    }
  }
  return data;
}
