import { createHash, randomUUID } from "node:crypto";

import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import {
  listDocuments,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { DEFAULT_PRICEBOOK_TEMPLATE } from "../pricebook/default_template.js";
import { listPricebookManifests, readCatalog, readManifest } from "../pricebook/storage.js";
import { enrichedProposalScopePieces, normalizeScopeItem, resolveScopeItemVariation, scopeItemSelected } from "../proposals/scope.js";
import { readScopeTemplate, readScopeTemplateVersion } from "../scopes/storage.js";
import { emitWorkEvent } from "../work/engine.js";
import {
  MATERIALS_SCHEMA_VERSION,
  MATERIAL_DELIVERY_SCHEMA_VERSION,
  MATERIAL_LIST_VERSION_SCHEMA_VERSION,
  MATERIAL_ORDER_SCHEMA_VERSION,
  type MaterialDeliveryStatus,
  type MaterialListStatus
} from "./schemas.js";

export const MATERIAL_LIST_COLLECTION = "material_lists";
export const MATERIAL_VERSION_COLLECTION = "material_list_versions";
export const MATERIAL_ORDER_COLLECTION = "material_orders";
export const MATERIAL_DELIVERY_COLLECTION = "material_deliveries";
export const MATERIAL_EVENT_COLLECTION = "material_events";

const ORDERED_STATUSES = new Set(["ordered", "partially_delivered", "delivered"]);

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function hashId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function normalizeId(value: unknown, fallbackPrefix: string) {
  const cleaned = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
  return cleaned || `${fallbackPrefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function materialListId(input: JsonObject = {}) {
  const explicit = cleanText(input.id);
  if (explicit) return normalizeId(explicit, "material_list");
  return `material_list_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function materialVersionId(listId: string, versionNumber: number) {
  return `material_version_${hashId(`${listId}:${versionNumber}:${randomUUID()}`)}`;
}

function materialOrderId(input: JsonObject = {}, listId = "") {
  const explicit = cleanText(input.id);
  if (explicit) return normalizeId(explicit, "material_order");
  return `material_order_${hashId(`${listId}:${Date.now()}:${randomUUID()}`)}`;
}

function materialDeliveryId(input: JsonObject = {}, orderId = "") {
  const explicit = cleanText(input.id);
  if (explicit) return normalizeId(explicit, "material_delivery");
  return `material_delivery_${hashId(`${orderId}:${Date.now()}:${randomUUID()}`)}`;
}

function materialEventId(subjectId: string, type: string) {
  return `material_event_${hashId(`${subjectId}:${type}:${Date.now()}:${randomUUID()}`)}`;
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

function listStatus(value: unknown): MaterialListStatus {
  const normalized = cleanText(value).toLowerCase();
  if (["ordered", "partially_delivered", "delivered", "cancelled", "archived"].includes(normalized)) {
    return normalized as MaterialListStatus;
  }
  return "planning";
}

function deliveryStatus(value: unknown): MaterialDeliveryStatus {
  const normalized = cleanText(value).toLowerCase();
  if (["scheduled", "delivering", "partially_delivered", "delivered", "delayed", "cancelled"].includes(normalized)) {
    return normalized as MaterialDeliveryStatus;
  }
  return "unscheduled";
}

function moneySnapshot(value: unknown, fallbackCurrency = "") {
  const source = asObject(value);
  const amount = Number(source.amount);
  return {
    ...source,
    ...(Number.isFinite(amount) ? { amount } : {}),
    currency: cleanText(source.currency || fallbackCurrency)
  };
}

function normalizeSections(value: unknown) {
  return (Array.isArray(value) ? value : []).map((entry, index) => {
    const section = asObject(entry);
    const key = cleanText(section.key || section.id || `section_${index + 1}`);
    return {
      ...section,
      id: cleanText(section.id || key) || `section_${index + 1}`,
      key,
      title: cleanText(section.title || key.replace(/[_-]+/g, " ")) || `Section ${index + 1}`,
      structure_id: cleanText(section.structure_id || section.structureId)
    };
  });
}

function normalizeStringArray(value: unknown) {
  return (Array.isArray(value) ? value : []).map((entry) => cleanText(entry)).filter(Boolean);
}

function semanticStoredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticStoredValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject)
      .filter(([key]) => !["revision", "updated_at"].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, semanticStoredValue(entry)]));
  }
  return value;
}

function semanticallyEqualStored(a: unknown, b: unknown) {
  return JSON.stringify(semanticStoredValue(a)) === JSON.stringify(semanticStoredValue(b));
}

function normalizeOrderSources(value: unknown) {
  return (Array.isArray(value) ? value : []).map(asObject).map((source) => ({
    ...source,
    id: cleanText(source.id),
    name: cleanText(source.name || source.title || source.id),
    kind: cleanText(source.kind || (source.provider ? "integration" : "manual")) || "manual",
    status: cleanText(source.status || "active") || "active",
    provider: cleanText(source.provider)
  })).filter((source) => source.id);
}

function systemMaterialContext(orgId: string, branchId = "default"): PlatformAuthContext {
  return {
    sessionId: "system",
    session: {},
    identity: { email: "system@firstmate.local" },
    organization: { id: orgId },
    user: { id: "system" },
    userDocument: {},
    orgId,
    userId: "system",
    identityId: "system",
    role: "system",
    branchId: branchId || "default",
    permissions: { "*": true },
    applicationAccess: {
      management: { enabled: true, role_id: "system", permissions: { "*": true } },
      field: { enabled: false, role_id: "", permissions: {} }
    },
    csrfToken: ""
  };
}

function eventScheduleStatus(value: JsonObject) {
  return cleanText(value.status).toLowerCase() !== "unscheduled" && !!cleanText(value.start_at)
    ? "scheduled"
    : "unscheduled";
}

function maybeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function calculatedTotal(quantity: unknown, unitPrice: unknown, explicit: unknown): number | undefined {
  const direct = maybeNumber(explicit);
  if (direct !== undefined) return direct;
  const qty = maybeNumber(quantity);
  const price = maybeNumber(unitPrice);
  if (qty === undefined || price === undefined) return undefined;
  return Number((qty * price).toFixed(4));
}

async function requireMaterialsFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "materials"))) {
    throw forbidden("app_flag_disabled", "Materials are not enabled for this organization.");
  }
}

async function projectData(orgId: string, projectId: string) {
  const project = await readDocument(orgId, "projects", projectId);
  return { document: project, data: documentData(project) };
}

async function patchProjectMaterialRefs(orgId: string, projectId: string, listId: string) {
  const project = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!project) return;
  const data = documentData(project);
  const materialListIds = normalizeStringArray(data.material_list_ids);
  if (!materialListIds.includes(listId)) materialListIds.push(listId);
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: {
      material_list_ids: materialListIds,
      active_material_list_id: cleanText(data.active_material_list_id) || listId
    },
    metadata: {
      kind: "platform_project",
      material_ref_source: "materials_api"
    }
  }, { replace: false });
}

async function resolveDefaultPricebookId(orgId: string) {
  const manifests = await listPricebookManifests().catch(() => []);
  const activeForOrg = manifests.find((manifest) => {
    const organizationRef = asObject(manifest.organization_ref);
    return cleanText(organizationRef.id) === orgId && cleanText(manifest.status || "active") === "active";
  });
  return cleanText(activeForOrg?.id);
}

async function snapshotPricebookItem(orgId: string, refInput: unknown) {
  const ref = asObject(refInput);
  const itemId = cleanText(ref.item_id || ref.itemId || ref.id);
  if (!itemId) return { ref: Object.keys(ref).length ? ref : {}, snapshot: {} };
  const pricebookId = cleanText(ref.pricebook_id || ref.pricebookId) || await resolveDefaultPricebookId(orgId);
  if (!pricebookId) throw badRequest("missing_pricebook_id", "A pricebook_id is required to snapshot this material item.");
  const [manifest, catalog] = await Promise.all([readManifest(pricebookId), readCatalog(pricebookId)]);
  const item = catalog.items.find((entry) => cleanText(entry.id) === itemId);
  if (!item) throw notFound("pricebook_item_not_found", `Price book item '${itemId}' was not found.`);
  return {
    ref: {
      ...ref,
      pricebook_id: pricebookId,
      item_id: itemId,
      item_type_id: cleanText(ref.item_type_id || item.itemTypeId),
      variant_id: cleanText(ref.variant_id || item.variantId),
      variant_group_id: cleanText(ref.variant_group_id || item.variantGroupId),
      selected_options: asObject(ref.selected_options || item.defaultOptions),
      ...(Number(manifest.revision || 0) > 0 ? { catalog_revision: Number(manifest.revision) } : {})
    },
    snapshot: {
      pricebook_id: pricebookId,
      pricebook_revision: Number(manifest.revision || 0),
      captured_at: nowIso(),
      item: cloneJson(item),
      item_type: {
        id: cleanText(item.itemTypeId),
        name: cleanText(item.itemTypeName),
        default_variant_item_id: item.isDefaultVariant ? itemId : ""
      },
      variant: {
        id: cleanText(item.variantId),
        name: cleanText(item.variantName),
        role: cleanText(item.variantRole),
        group_id: cleanText(item.variantGroupId),
        group_name: cleanText(item.variantGroupName),
        item_id: itemId,
        is_default: item.isDefaultVariant === true
      },
      option_definitions: Array.isArray(item.optionDefinitions) ? cloneJson(item.optionDefinitions) : [],
      selected_options: asObject(ref.selected_options || item.defaultOptions),
      currency: cleanText(manifest.currency || "USD"),
      locale: cleanText(manifest.locale || "en-US")
    }
  };
}

function normalizeOrderPackaging(value: unknown): JsonObject | null {
  const raw = asObject(value);
  const orderUnit = cleanText(raw.order_unit || raw.orderUnit);
  const unitsPerPackage = Number(raw.units_per_package ?? raw.unitsPerPackage ?? 0) || 0;
  const packagesPerUnit = Number(raw.packages_per_unit ?? raw.packagesPerUnit ?? 0) || 0;
  if (!orderUnit || (unitsPerPackage <= 0 && packagesPerUnit <= 0)) return null;
  return {
    order_unit: orderUnit,
    order_unit_plural: cleanText(raw.order_unit_plural || raw.orderUnitPlural) || `${orderUnit}s`,
    units_per_package: unitsPerPackage > 0 ? unitsPerPackage : 0,
    packages_per_unit: packagesPerUnit > 0 ? packagesPerUnit : 0,
    description: cleanText(raw.description)
  };
}

// packages_per_unit takes precedence so exact integer ratios (3 bundles per square)
// never pick up float error from a stored reciprocal; order quantities always round up.
function deriveOrderFields(packagingValue: unknown, quantityValue: unknown): JsonObject {
  const packaging = normalizeOrderPackaging(packagingValue);
  if (!packaging) return {};
  const measured = Math.max(0, Number(quantityValue) || 0);
  const packagesPerUnit = Number(packaging.packages_per_unit) || 0;
  const unitsPerPackage = Number(packaging.units_per_package) || 0;
  const factor = packagesPerUnit > 0 ? packagesPerUnit : 1 / unitsPerPackage;
  const orderQuantity = measured > 0 ? Math.ceil((measured * factor) - 1e-6) : 0;
  const covered = packagesPerUnit > 0 ? orderQuantity / packagesPerUnit : orderQuantity * unitsPerPackage;
  return {
    order_packaging: packaging,
    order_quantity: orderQuantity,
    order_unit: orderQuantity === 1 ? String(packaging.order_unit) : String(packaging.order_unit_plural),
    order_covered_quantity: Math.round(covered * 100) / 100
  };
}

async function normalizeLineItem(orgId: string, value: unknown, index: number, options: { lock?: boolean; lockedAt?: string } = {}) {
  const source = asObject(value);
  const existingSnapshot = asObject(source.pricebook_snapshot);
  const shouldResolve = Object.keys(asObject(source.pricebook_ref)).length > 0 && !Object.keys(existingSnapshot).length;
  const resolved = shouldResolve
    ? await snapshotPricebookItem(orgId, source.pricebook_ref)
    : { ref: asObject(source.pricebook_ref), snapshot: existingSnapshot };
  const snapshotItem = asObject(asObject(resolved.snapshot).item);
  const quantity = maybeNumber(source.quantity);
  const projectedUnitPrice = maybeNumber(source.projected_unit_price ?? source.unit_price ?? snapshotItem.unitPrice);
  const quotedUnitPrice = maybeNumber(source.quoted_unit_price);
  const paidUnitPrice = maybeNumber(source.paid_unit_price);
  const currency = cleanText(source.currency || asObject(resolved.snapshot).currency);
  const sourceSelection = asObject(source.product_selection);
  const snapshotVariant = asObject(asObject(resolved.snapshot).variant);
  const itemTypeId = cleanText(source.item_type_id || sourceSelection.item_type_id || asObject(resolved.ref).item_type_id || snapshotItem.itemTypeId || asObject(asObject(resolved.snapshot).item_type).id);
  const variantId = cleanText(source.variant_id || sourceSelection.variant_id || asObject(resolved.ref).variant_id || snapshotItem.variantId || snapshotVariant.id);
  const variantGroupId = cleanText(source.variant_group_id || sourceSelection.variant_group_id || asObject(resolved.ref).variant_group_id || snapshotItem.variantGroupId || snapshotVariant.group_id);
  const selectedOptions = asObject(source.selected_options || sourceSelection.selected_options || asObject(resolved.ref).selected_options || asObject(resolved.snapshot).selected_options || snapshotItem.defaultOptions);
  const normalized: JsonObject = {
    ...source,
    id: cleanText(source.id) || `material_item_${hashId(`${cleanText(source.name || snapshotItem.name || index)}:${randomUUID()}`)}`,
    parent_item_id: cleanText(source.parent_item_id || source.parentItemId),
    source_item_id: cleanText(source.source_item_id || source.sourceItemId),
    amendment_action: cleanText(source.amendment_action || source.amendmentAction || "add") || "add",
    section: cleanText(source.section || snapshotItem.category),
    structure_id: cleanText(source.structure_id || source.structureId),
    structure_name: cleanText(source.structure_name || source.structureName),
    pricebook_ref: resolved.ref,
    pricebook_snapshot: resolved.snapshot,
    item_type_id: itemTypeId,
    variant_id: variantId,
    variant_group_id: variantGroupId,
    selected_options: selectedOptions,
    product_selection: {
      ...sourceSelection,
      item_type_id: itemTypeId,
      variant_id: variantId,
      variant_group_id: variantGroupId,
      variant_item_id: cleanText(sourceSelection.variant_item_id || asObject(resolved.ref).item_id || snapshotItem.id),
      item_type_name: cleanText(sourceSelection.item_type_name || asObject(asObject(resolved.snapshot).item_type).name || snapshotItem.itemTypeName),
      variant_name: cleanText(sourceSelection.variant_name || snapshotVariant.name || snapshotItem.variantName),
      variant_group_name: cleanText(sourceSelection.variant_group_name || snapshotVariant.group_name || snapshotItem.variantGroupName),
      selected_options: selectedOptions
    },
    name: cleanText(source.name || snapshotItem.name) || "Material item",
    code: cleanText(source.code || snapshotItem.code),
    category: cleanText(source.category || snapshotItem.category),
    manufacturer: cleanText(source.manufacturer || snapshotItem.manufacturer),
    segment: cleanText(source.segment || snapshotItem.segment),
    description: cleanText(source.description || snapshotItem.description),
    quantity,
    unit: cleanText(source.unit || snapshotItem.unit),
    order_quantity: maybeNumber(source.order_quantity ?? source.orderQuantity ?? quantity),
    order_unit: cleanText(source.order_unit || source.orderUnit || source.unit || snapshotItem.unit),
    ...deriveOrderFields(source.order_packaging ?? snapshotItem.order_packaging ?? snapshotItem.orderPackaging, quantity),
    projected_unit_price: projectedUnitPrice,
    projected_total: calculatedTotal(quantity, projectedUnitPrice, source.projected_total ?? source.total_price),
    quoted_unit_price: quotedUnitPrice,
    quoted_total: calculatedTotal(quantity, quotedUnitPrice, source.quoted_total),
    paid_unit_price: paidUnitPrice,
    paid_total: calculatedTotal(quantity, paidUnitPrice, source.paid_total),
    currency,
    pricing: asObject(source.pricing),
    vendor: asObject(source.vendor),
    measurements: asObject(source.measurements),
    metadata: asObject(source.metadata)
  };
  if (options.lock) {
    normalized.locked_pricing = {
      ...asObject(source.locked_pricing),
      projected_unit_price: normalized.projected_unit_price,
      projected_total: normalized.projected_total,
      quoted_unit_price: normalized.quoted_unit_price,
      quoted_total: normalized.quoted_total,
      paid_unit_price: normalized.paid_unit_price,
      paid_total: normalized.paid_total,
      currency,
      locked_at: options.lockedAt || nowIso()
    };
  } else if (Object.keys(asObject(source.locked_pricing)).length) {
    normalized.locked_pricing = asObject(source.locked_pricing);
  }
  return normalized;
}

async function normalizeLineItems(orgId: string, value: unknown, options: { lock?: boolean; lockedAt?: string } = {}) {
  const items = Array.isArray(value) ? value : [];
  return await Promise.all(items.map((entry, index) => normalizeLineItem(orgId, entry, index, options)));
}

async function applyVersionInput(orgId: string, currentItems: JsonObject[], input: JsonObject, lock: boolean, lockedAt: string) {
  if (Array.isArray(input.items)) {
    return await normalizeLineItems(orgId, input.items, { lock, lockedAt });
  }
  let next = currentItems.map((item) => ({ ...item }));
  const removedIds = new Set(normalizeStringArray(input.remove_item_ids));
  if (removedIds.size) {
    next = next.filter((item) => !removedIds.has(cleanText(item.id)));
  }
  for (const rawUpdate of Array.isArray(input.update_items) ? input.update_items : []) {
    const update = asObject(rawUpdate);
    const id = cleanText(update.id);
    if (!id) continue;
    const index = next.findIndex((item) => cleanText(item.id) === id);
    if (index < 0) continue;
    next[index] = await normalizeLineItem(orgId, { ...next[index], ...update, id }, index, { lock, lockedAt });
  }
  for (const rawItem of Array.isArray(input.add_items) ? input.add_items : []) {
    next.push(await normalizeLineItem(orgId, rawItem, next.length, { lock, lockedAt }));
  }
  return next;
}

function selectedItems(items: JsonObject[], itemIds: unknown) {
  const ids = normalizeStringArray(itemIds);
  if (!ids.length) return items;
  const set = new Set(ids);
  return items.filter((item) => set.has(cleanText(item.id)));
}

function deriveTotals(items: JsonObject[]) {
  const sum = (key: string) => items.reduce((total, item) => {
    const value = maybeNumber(item[key]);
    return value === undefined ? total : total + value;
  }, 0);
  return {
    projected_total: Number(sum("projected_total").toFixed(4)),
    quoted_total: Number(sum("quoted_total").toFixed(4)),
    paid_total: Number(sum("paid_total").toFixed(4))
  };
}

async function commitMaterialVersion(
  orgId: string,
  listDoc: JsonObject,
  input: JsonObject,
  ctx: PlatformAuthContext,
  options: { forceStatus?: MaterialListStatus; forceDeliveryStatus?: MaterialDeliveryStatus; lock?: boolean } = {}
) {
  const list = documentView(listDoc);
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(listDoc.revision || 0)) {
    throw conflict("material_list_revision_conflict", "Material list revision does not match.");
  }
  const now = nowIso();
  const currentItems = (Array.isArray(list.current_items) ? list.current_items : []).map(asObject);
  const shouldLock = options.lock === true || ORDERED_STATUSES.has(cleanText(list.status));
  const items = await applyVersionInput(orgId, currentItems, input, shouldLock, now);
  const previousVersions = await listMaterialVersions(orgId, cleanText(list.id));
  const versionNumber = previousVersions.length + 1;
  const versionId = materialVersionId(cleanText(list.id), versionNumber);
  const sections = Object.prototype.hasOwnProperty.call(input, "sections")
    ? normalizeSections(input.sections)
    : (Array.isArray(list.sections) ? list.sections.map(asObject) : []);
  const removedIds = normalizeStringArray(input.remove_item_ids);
  const data = {
    schema_version: MATERIAL_LIST_VERSION_SCHEMA_VERSION,
    id: versionId,
    organization_id: orgId,
    branch_id: cleanText(list.branch_id),
    project_id: cleanText(list.project_id),
    material_list_id: cleanText(list.id),
    version_number: versionNumber,
    reason: cleanText(input.reason || "manual") || "manual",
    title: cleanText(input.title || list.title) || "Materials",
    parent_version_id: cleanText(input.parent_version_id || list.active_version_id),
    amendment_of_version_id: cleanText(input.amendment_of_version_id || input.parent_version_id || list.active_version_id),
    bundled_with_order_id: cleanText(input.bundled_with_order_id),
    bundled_with_delivery_id: cleanText(input.bundled_with_delivery_id),
    status_at_creation: cleanText(list.status || "planning"),
    delivery_status_at_creation: cleanText(list.delivery_status || "unscheduled"),
    source_revision: Number(listDoc.revision || 0),
    sections,
    items,
    change_set: {
      added_items: Array.isArray(input.add_items) ? input.add_items.map(asObject) : [],
      updated_items: Array.isArray(input.update_items) ? input.update_items.map(asObject) : [],
      removed_item_ids: removedIds,
      full_replace: Array.isArray(input.items)
    },
    resources: Object.prototype.hasOwnProperty.call(input, "resources") ? asObject(input.resources) : asObject(list.resources),
    notes: cleanText(input.notes),
    metadata: asObject(input.metadata),
    created_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const versionDoc = await upsertDocument(orgId, MATERIAL_VERSION_COLLECTION, {
    id: versionId,
    data,
    metadata: {
      kind: "material_list_version",
      material_list_id: cleanText(list.id),
      project_id: cleanText(list.project_id),
      reason: data.reason
    }
  }, { replace: true });
  const nextStatus = options.forceStatus || listStatus(list.status);
  const nextDeliveryStatus = options.forceDeliveryStatus || deliveryStatus(list.delivery_status);
  const listData = {
    ...list,
    title: cleanText(input.title || list.title) || "Materials",
    status: nextStatus,
    delivery_status: nextDeliveryStatus,
    sections,
    current_items: items,
    active_version_id: versionId,
    version_number: versionNumber,
    resources: Object.prototype.hasOwnProperty.call(input, "resources") ? asObject(input.resources) : asObject(list.resources),
    totals: deriveTotals(items),
    locked_at: shouldLock && !cleanText(list.locked_at) ? now : cleanText(list.locked_at),
    updated_by_user_id: ctx.userId,
    updated_at: now
  };
  const nextListDoc = await upsertDocument(orgId, MATERIAL_LIST_COLLECTION, {
    id: cleanText(list.id),
    data: listData,
    metadata: {
      kind: "material_list",
      project_id: cleanText(list.project_id),
      branch_id: cleanText(list.branch_id),
      status: nextStatus,
      delivery_status: nextDeliveryStatus
    }
  }, { replace: true });
  await recordMaterialEvent(orgId, cleanText(list.id), "material_list.version_created", {
    version_id: versionId,
    version_number: versionNumber,
    reason: data.reason
  }, ctx);
  return { list: documentView(nextListDoc), version: documentView(versionDoc) };
}

export async function listProjectMaterialLists(orgId: string, projectId: string) {
  await requireMaterialsFlag(orgId);
  const docs = await listDocuments(orgId, MATERIAL_LIST_COLLECTION);
  return docs
    .map(documentView)
    .filter((list) => cleanText(list.project_id) === projectId)
    .sort((a, b) => {
      const aGenerated = asObject(a.metadata).generated_from_scope === true ? 0 : 1;
      const bGenerated = asObject(b.metadata).generated_from_scope === true ? 0 : 1;
      if (aGenerated !== bGenerated) return aGenerated - bGenerated;
      if (aGenerated === 0) return Number(a.sort_order || 0) - Number(b.sort_order || 0) || cleanText(a.title).localeCompare(cleanText(b.title));
      return cleanText(b.updated_at).localeCompare(cleanText(a.updated_at));
    });
}

export async function readMaterialList(orgId: string, listId: string) {
  await requireMaterialsFlag(orgId);
  const doc = await readDocument(orgId, MATERIAL_LIST_COLLECTION, listId);
  const list = documentView(doc);
  if (cleanText(list.organization_id) !== orgId) throw notFound("material_list_not_found", "Material list was not found.");
  return list;
}

export async function createMaterialList(orgId: string, projectId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMaterialsFlag(orgId);
  const { data: project } = await projectData(orgId, projectId);
  const id = materialListId(input);
  const now = nowIso();
  const title = cleanText(input.title || project.title || project.address || "Materials") || "Materials";
  const items = await normalizeLineItems(orgId, input.items);
  const data = {
    schema_version: MATERIALS_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || project.branch_id || ctx.branchId || "default") || "default",
    project_id: projectId,
    title,
    resource_type: ["labor", "equipment"].includes(cleanText(input.resource_type)) ? cleanText(input.resource_type) : "material",
    resource_subtype: cleanText(input.resource_subtype),
    terminology: asObject(input.terminology),
    controls: asObject(input.controls),
    compensation: asObject(input.compensation),
    assignment: asObject(input.assignment),
    color: cleanText(input.color || asObject(input.metadata).color || "var(--primary,#d93025)"),
    sort_order: Number(input.sort_order || 0),
    status: listStatus(input.status),
    delivery_status: deliveryStatus(input.delivery_status),
    scope_template_id: cleanText(input.scope_template_id),
    scope_template_version: Number(input.scope_template_version || 0),
    scope_piece_id: cleanText(input.scope_piece_id),
    schedule: asObject(input.schedule),
    schedule_event_id: cleanText(input.schedule_event_id),
    schedule_status: cleanText(asObject(input.schedule).status || "unscheduled") || "unscheduled",
    order_sources: normalizeOrderSources(input.order_sources),
    measurements: asObject(input.measurements),
    sections: normalizeSections(input.sections),
    current_items: items,
    totals: deriveTotals(items),
    active_version_id: "",
    version_number: 0,
    resources: asObject(input.resources),
    metadata: asObject(input.metadata),
    locked_at: "",
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, MATERIAL_LIST_COLLECTION, {
    id,
    data,
    metadata: {
      kind: "material_list",
      project_id: projectId,
      branch_id: data.branch_id,
      status: data.status,
      delivery_status: data.delivery_status
    }
  }, { replace: true });
  await patchProjectMaterialRefs(orgId, projectId, id);
  await recordMaterialEvent(orgId, id, "material_list.created", { project_id: projectId }, ctx);
  if (items.length) {
    const initial = await commitMaterialVersion(orgId, doc, {
      reason: "manual",
      title,
      items,
      sections: data.sections,
      resources: data.resources
    }, ctx);
    return initial.list;
  }
  return documentView(doc);
}

function scopeResourceType(list: JsonObject) {
  const value = cleanText(list.resource_type).toLowerCase();
  return ["labor", "equipment"].includes(value) ? value : "material";
}

function scopeResourceScheduleDefaults(list: JsonObject) {
  const resourceType = scopeResourceType(list);
  if (resourceType === "labor") return { kind: "project_work", icon: "fa-helmet-safety", color: "#2563eb", title: "Labor" };
  if (resourceType === "equipment") return { kind: "equipment", icon: "fa-truck-pickup", color: "#0f766e", title: "Equipment" };
  return { kind: "material_delivery", icon: "fa-truck-ramp-box", color: "#7c3aed", title: "Material Delivery" };
}

function materialScheduleEventId(projectId: string, listId: string, resourceType = "material") {
  return `event_${hashId(`${projectId}:scope_resource:${resourceType}:${listId}`)}`;
}

function materialEventOrderState(list: JsonObject) {
  return ORDERED_STATUSES.has(cleanText(list.status)) ? "ordered" : "unordered";
}

export async function ensureMaterialListScheduleEvent(orgId: string, listId: string, input: JsonObject = {}) {
  await requireMaterialsFlag(orgId);
  const listDoc = await readDocument(orgId, MATERIAL_LIST_COLLECTION, listId);
  const list = documentView(listDoc);
  const projectId = cleanText(list.project_id);
  if (!projectId) throw badRequest("material_list_project_missing", "The material list is not linked to a project.");
  const projectDoc = await readDocument(orgId, "projects", projectId);
  const project = documentData(projectDoc);
  const schedule = { ...asObject(list.schedule), ...asObject(input.schedule) };
  const eventInput = asObject(input.event);
  const resourceType = scopeResourceType(list);
  const scheduleDefaults = scopeResourceScheduleDefaults(list);
  const workPlanId = cleanText(input.work_plan_id || eventInput.work_plan_id || schedule.work_plan_id);
  const sourceNodeId = cleanText(input.source_node_id || eventInput.source_node_id || schedule.source_node_id);
  const eventTypeId = cleanText(eventInput.event_type_default_id || schedule.event_type_default_id || `${scheduleDefaults.kind}_${normalizeId(listId, "scope_resource")}`);
  const deterministicId = materialScheduleEventId(projectId, listId, resourceType);
  const events = (Array.isArray(project.events) ? project.events : []).map(asObject);
  const linkedIndex = events.findIndex((entry) => cleanText(entry.scope_resource_list_id || entry.material_list_id) === listId);
  const requestedEventId = cleanText(eventInput.id);
  const existingIndex = linkedIndex >= 0
    ? linkedIndex
    : events.findIndex((entry) => cleanText(entry.id) === (requestedEventId || deterministicId));
  let resolvedIndex = existingIndex;
  if (resolvedIndex < 0) {
    resolvedIndex = events.findIndex((entry) => (
      !cleanText(entry.scope_resource_list_id || entry.material_list_id)
      && cleanText(entry.event_type_default_id || entry.type_id) === eventTypeId
      && (!workPlanId || cleanText(entry.work_plan_id) === workPlanId)
      && (!cleanText(list.scope_piece_id) || cleanText(entry.scope_piece_id) === cleanText(list.scope_piece_id))
    ));
  }
  const existing: JsonObject = resolvedIndex >= 0 ? asObject(events[resolvedIndex]) : {};
  const now = nowIso();
  // Gantt structure from the scope definition: a shared group row (rollup
  // parent) plus event-to-event dependencies resolved to deterministic ids.
  const pieceId = cleanText(list.scope_piece_id);
  const scheduleGroupId = cleanText(schedule.group_id);
  const groupEventId = scheduleGroupId ? `event_${hashId(`${projectId}:schedule_group:${pieceId}:${scheduleGroupId}`)}` : "";
  let groupCreated = false;
  if (groupEventId && !events.some((entry) => cleanText(entry.id) === groupEventId)) {
    groupCreated = true;
    events.push({
      id: groupEventId,
      project_id: projectId,
      title: cleanText(schedule.group_title) || scheduleGroupId.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      kind: "schedule_group",
      is_schedule_group: true,
      schedule_rollup: "auto",
      status: "unscheduled",
      color: cleanText(schedule.group_color),
      scope_piece_id: pieceId,
      scope_template_id: cleanText(list.scope_template_id),
      schedule_group_id: scheduleGroupId,
      created_at: now,
      updated_at: now
    });
  }
  const configuredDependencies = Array.isArray(schedule.depends_on) ? schedule.depends_on.map(asObject) : [];
  const resolvedDependencies: JsonObject[] = [];
  for (const [depIndex, dep] of configuredDependencies.entries()) {
    const depListDefinitionId = cleanText(dep.list_id);
    if (!depListDefinitionId) continue;
    const siblingListId = `material_list_${hashId(`scope_materials:${projectId}:${pieceId}:${depListDefinitionId}`)}`;
    let depEventId = cleanText(asObject(events.find((entry) => cleanText(asObject(entry).scope_resource_list_id || asObject(entry).material_list_id) === siblingListId)).id);
    if (!depEventId) {
      const siblingList = await readMaterialList(orgId, siblingListId).catch(() => null);
      if (siblingList) depEventId = materialScheduleEventId(projectId, siblingListId, scopeResourceType(siblingList));
    }
    if (!depEventId) continue;
    const depType = cleanText(dep.type);
    resolvedDependencies.push({
      id: `dep_${depIndex + 1}_${depListDefinitionId}`,
      event_id: depEventId,
      type: ["finish_to_start", "start_to_start", "finish_to_finish"].includes(depType) ? depType : "finish_to_start",
      lag_minutes: Number.isFinite(Number(dep.lag_minutes)) && Number(dep.lag_minutes) !== 0
        ? Math.round(Number(dep.lag_minutes))
        : Math.round(Number(dep.lag_days || 0) * 1440)
    });
  }
  const orderState = resourceType === "material" ? materialEventOrderState(list) : "not_applicable";
  const lockOnOrder = resourceType === "material" && schedule.lock_on_order !== false;
  const assignment = asObject(list.assignment);
  const requestedResourceRef = {
    ...asObject(existing.work_resource_ref),
    ...asObject(assignment.work_resource_ref),
    ...asObject(eventInput.work_resource_ref)
  };
  const resolvedEventId = cleanText(existing.id || eventInput.id || deterministicId);
  const requestedCrewId = cleanText(requestedResourceRef.id || requestedResourceRef.resource_id || eventInput.assigned_crew_id || eventInput.crew_id || assignment.crew_id || existing.assigned_crew_id || existing.crew_id);
  const selfAssigned = !!requestedCrewId && requestedCrewId === resolvedEventId;
  const assignedCrewId = selfAssigned ? "" : requestedCrewId;
  const assignedCrewName = selfAssigned ? "" : cleanText(requestedResourceRef.name || requestedResourceRef.label || eventInput.assigned_crew_name || assignment.crew_name || existing.assigned_crew_name);
  const assignedResourceKind = selfAssigned ? "" : cleanText(requestedResourceRef.kind || requestedResourceRef.resource_kind || eventInput.assigned_resource_kind || assignment.resource_kind || existing.assigned_resource_kind || (assignedCrewId ? "resource_group" : ""));
  const workResourceRef = assignedCrewId ? {
    kind: assignedResourceKind || "resource_group",
    id: assignedCrewId,
    name: assignedCrewName
  } : null;
  const eventInputScheduleLock = asObject(eventInput.schedule_lock);
  const existingScheduleLock = asObject(existing.schedule_lock);
  const generatedFromScope = asObject(list.metadata).generated_from_scope === true;
  const locked = Object.prototype.hasOwnProperty.call(eventInput, "locked")
    ? eventInput.locked === true
    : Object.prototype.hasOwnProperty.call(eventInputScheduleLock, "locked")
      ? eventInputScheduleLock.locked === true
      : Object.prototype.hasOwnProperty.call(existingScheduleLock, "locked")
        ? existingScheduleLock.locked === true
        : Object.prototype.hasOwnProperty.call(existing, "locked")
          ? existing.locked === true
          : schedule.locked === true;
  const existingStartAt = cleanText(existing.start_at);
  const projectedStartAt = cleanText(eventInput.start_at ?? (existingStartAt || cleanText(schedule.start_at)));
  const projectedEndAt = cleanText(eventInput.end_at ?? (cleanText(existing.end_at) || cleanText(schedule.end_at)));
  const existingStatus = cleanText(existing.status);
  const configuredScheduleStatus = cleanText(schedule.status);
  const projectedStatus = cleanText(eventInput.status || (
    projectedStartAt
      ? (existingStartAt && existingStatus.toLowerCase() !== "unscheduled"
          ? existingStatus
          : (configuredScheduleStatus && configuredScheduleStatus.toLowerCase() !== "unscheduled" ? configuredScheduleStatus : "scheduled"))
      : (existingStatus || configuredScheduleStatus || "unscheduled")
  )) || "unscheduled";
  // Scope-driven equipment requirements + single-unit auto-fulfill
  // (equipment.requirements capability; no-op otherwise).
  let equipmentAugment: JsonObject = {};
  if (resourceType === "equipment") {
    const { equipmentScheduleAugment } = await import("../equipment/service.js");
    equipmentAugment = await equipmentScheduleAugment(orgId, list.current_items, { ...existing, ...eventInput }).catch(() => ({}));
  }
  const event: JsonObject = {
    ...existing,
    ...eventInput,
    id: resolvedEventId,
    project_id: projectId,
    type_id: eventTypeId,
    event_type_id: eventTypeId,
    event_type_default_id: eventTypeId,
    title: cleanText(eventInput.title || (resourceType === "material" && generatedFromScope ? list.title || schedule.title : schedule.title || list.title) || scheduleDefaults.title) || scheduleDefaults.title,
    kind: cleanText(eventInput.kind || schedule.kind || scheduleDefaults.kind) || scheduleDefaults.kind,
    schedule_item_kind: resourceType === "material" ? "material_delivery" : resourceType,
    scope_resource_list_id: listId,
    resource_type: resourceType,
    material_list_id: listId,
    material_list_title: cleanText(list.title),
    material_list_name: cleanText(list.title),
    ...(resourceType === "labor" ? {
      labor_list_id: listId,
      work_resource_ref: workResourceRef,
      assigned_resource_kind: assignedResourceKind,
      assigned_crew_id: assignedCrewId,
      assigned_crew_name: assignedCrewName,
      crew_id: assignedCrewId
    } : {}),
    ...(resourceType === "equipment" ? { equipment_list_id: listId, ...equipmentAugment } : {}),
    scope_piece_id: cleanText(list.scope_piece_id),
    scope_template_id: cleanText(list.scope_template_id),
    work_plan_id: workPlanId || cleanText(existing.work_plan_id),
    source_node_id: sourceNodeId || cleanText(existing.source_node_id),
    source_node_template_id: cleanText(input.source_node_template_id || schedule.source_node_template_id || existing.source_node_template_id),
    schedule_rule: {
      ...asObject(existing.schedule_rule),
      ...asObject(schedule.rule || schedule.schedule_rule),
      ...asObject(eventInput.schedule_rule)
    },
    icon: cleanText(eventInput.icon || schedule.icon || scheduleDefaults.icon),
    color: cleanText(eventInput.color || schedule.color || scheduleDefaults.color),
    material_color: cleanText(list.color || "var(--primary,#d93025)"),
    accent_color: cleanText(list.color || "var(--primary,#d93025)"),
    sub_color: cleanText(list.color || "var(--primary,#d93025)"),
    order_status: orderState,
    ordered: resourceType === "material" && orderState === "ordered",
    locked,
    schedule_lock: {
      ...asObject(existing.schedule_lock),
      ...asObject(eventInput.schedule_lock),
      locked,
      reason: cleanText(asObject(eventInput.schedule_lock).reason || asObject(existing.schedule_lock).reason || (orderState === "ordered" ? "material_order" : "manual"))
    },
    lock_on_order: lockOnOrder,
    lock_toggle_visible: resourceType === "material",
    // A scope template's `schedule.confirmation` seeds the customer-confirmation
    // block, so scope-generated appointments arrive already configured. An
    // explicit value on the event still wins, and an answer already given is
    // never overwritten by the template.
    ...(asObject(schedule.confirmation).required !== undefined || asObject(eventInput.confirmation).required !== undefined
      ? {
        confirmation: {
          ...asObject(schedule.confirmation),
          ...asObject(existing.confirmation),
          ...asObject(eventInput.confirmation)
        }
      }
      : {}),
    ...(Object.keys(asObject(schedule.customer_scheduling)).length || Object.keys(asObject(eventInput.customer_scheduling)).length
      ? {
        customer_scheduling: {
          ...asObject(schedule.customer_scheduling),
          ...asObject(existing.customer_scheduling),
          ...asObject(eventInput.customer_scheduling)
        }
      }
      : {}),
    status: projectedStatus,
    start_at: projectedStartAt,
    end_at: projectedEndAt,
    parent_event_id: cleanText(eventInput.parent_event_id) || groupEventId || cleanText(existing.parent_event_id),
    depends_on: Array.isArray(eventInput.depends_on)
      ? eventInput.depends_on
      : (resolvedDependencies.length ? resolvedDependencies : (Array.isArray(existing.depends_on) ? existing.depends_on : [])),
    created_at: cleanText(existing.created_at || now),
    updated_at: now,
    metadata: {
      ...asObject(existing.metadata),
      ...asObject(eventInput.metadata),
      scope_resource_list_id: listId,
      resource_type: resourceType,
      material_list_id: listId,
      generated_from_scope: generatedFromScope,
      schedule_rule: {
        ...asObject(existing.schedule_rule),
        ...asObject(schedule.rule || schedule.schedule_rule),
        ...asObject(eventInput.schedule_rule)
      }
    }
  };
  const eventChanged = groupCreated || resolvedIndex < 0 || !semanticallyEqualStored(existing, event);
  if (!eventChanged) event.updated_at = cleanText(existing.updated_at);
  if (resolvedIndex >= 0) events[resolvedIndex] = event;
  else events.push(event);
  if (eventChanged) {
    await upsertDocument(orgId, "projects", {
      id: projectId,
      data: { ...project, events, updated_at: now },
      metadata: projectDoc.metadata
    }, { replace: true });
  }
  const scheduleStatus = eventScheduleStatus(event);
  const currentDeliveryStatus = deliveryStatus(list.delivery_status);
  const nextDeliveryStatus = resourceType === "material" && ["unscheduled", "scheduled"].includes(currentDeliveryStatus)
    ? deliveryStatus(scheduleStatus)
    : currentDeliveryStatus;
  const nextListData = {
    ...list,
    schedule_event_id: cleanText(event.id),
    schedule_status: scheduleStatus,
    delivery_status: nextDeliveryStatus,
    schedule: {
      ...schedule,
      enabled: true,
      event_id: cleanText(event.id),
      event_type_default_id: eventTypeId,
      title: cleanText(event.title),
      kind: cleanText(event.kind),
      icon: cleanText(event.icon),
      color: cleanText(event.color),
      material_color: cleanText(event.material_color || list.color),
      status: scheduleStatus,
      locked,
      start_at: cleanText(event.start_at),
      end_at: cleanText(event.end_at)
    },
    updated_at: now
  };
  if (!semanticallyEqualStored(list, nextListData)) {
    await upsertDocument(orgId, MATERIAL_LIST_COLLECTION, {
      id: listId,
      data: nextListData,
      metadata: {
        ...asObject(listDoc.metadata),
        schedule_event_id: cleanText(event.id),
        delivery_status: nextDeliveryStatus
      }
    }, { replace: true });
  }
  return event;
}

async function disableGeneratedResourceScheduleEvent(orgId: string, listValue: JsonObject) {
  const list = asObject(listValue);
  const listId = cleanText(list.id);
  const eventId = cleanText(list.schedule_event_id || asObject(list.schedule).event_id);
  if (!listId || !eventId) return list;
  const projectId = cleanText(list.project_id);
  const projectDoc = projectId ? await readDocument(orgId, "projects", projectId).catch(() => null) : null;
  if (projectDoc) {
    const project = documentData(projectDoc);
    const events = (Array.isArray(project.events) ? project.events : []).map(asObject);
    const index = events.findIndex((event) => cleanText(event.id) === eventId);
    if (index >= 0) {
      const now = nowIso();
      const currentEvent = events[index] || {};
      events[index] = {
        ...currentEvent,
        status: "canceled",
        canceled_at: now,
        updated_at: now,
        metadata: { ...asObject(currentEvent.metadata), schedule_disabled_by_scope: true }
      };
      await upsertDocument(orgId, "projects", {
        id: projectId,
        data: { ...project, events, updated_at: now },
        metadata: projectDoc.metadata
      }, { replace: true });
    }
  }
  const listDoc = await readDocument(orgId, MATERIAL_LIST_COLLECTION, listId);
  const current = documentView(listDoc);
  const next = {
    ...current,
    schedule_event_id: "",
    schedule_status: "unscheduled",
    schedule: { ...asObject(current.schedule), enabled: false, event_id: "", status: "unscheduled" },
    updated_at: nowIso()
  };
  const stored = await upsertDocument(orgId, MATERIAL_LIST_COLLECTION, {
    id: listId,
    data: next,
    metadata: { ...asObject(listDoc.metadata), schedule_event_id: "" }
  }, { replace: true });
  return documentView(stored);
}

export async function syncMaterialListFromScheduleEvent(orgId: string, eventValue: JsonObject) {
  const event = asObject(eventValue);
  const listId = cleanText(event.scope_resource_list_id || event.material_list_id || event.labor_list_id || event.equipment_list_id);
  if (!listId) return null;
  const listDoc = await readDocument(orgId, MATERIAL_LIST_COLLECTION, listId).catch(() => null);
  if (!listDoc) return null;
  const list = documentView(listDoc);
  const resourceType = scopeResourceType(list);
  const scheduleStatus = eventScheduleStatus(event);
  const currentDelivery = deliveryStatus(list.delivery_status);
  const nextDelivery = resourceType === "material" && ["unscheduled", "scheduled"].includes(currentDelivery)
    ? deliveryStatus(scheduleStatus)
    : currentDelivery;
  const eventId = cleanText(event.id);
  const requestedCrewId = cleanText(asObject(event.work_resource_ref).id || event.assigned_resource_id || event.resource_id || event.assigned_crew_id || event.crew_id);
  const selfAssigned = !!requestedCrewId && requestedCrewId === eventId;
  const now = nowIso();
  const nextListData = {
    ...list,
    schedule_event_id: cleanText(event.id),
    schedule_status: scheduleStatus,
    delivery_status: nextDelivery,
    assignment: resourceType === "labor" ? {
      ...asObject(list.assignment),
      work_resource_ref: !selfAssigned && Object.keys(asObject(event.work_resource_ref)).length ? asObject(event.work_resource_ref) : null,
      resource_kind: selfAssigned ? "" : cleanText(event.assigned_resource_kind || asObject(event.work_resource_ref).kind),
      crew_id: selfAssigned ? "" : cleanText(event.assigned_crew_id || event.crew_id),
      crew_name: selfAssigned ? "" : cleanText(event.assigned_crew_name)
    } : asObject(list.assignment),
    schedule: {
      ...asObject(list.schedule),
      enabled: true,
      event_id: cleanText(event.id),
      event_type_default_id: cleanText(event.event_type_default_id || event.type_id),
      title: cleanText(event.title),
      kind: cleanText(event.kind),
      icon: cleanText(event.icon),
      color: cleanText(event.color),
      material_color: cleanText(event.material_color || list.color),
      status: scheduleStatus,
      locked: event.locked === true,
      start_at: cleanText(event.start_at),
      end_at: cleanText(event.end_at)
    },
    updated_at: now
  };
  const nextListDoc = semanticallyEqualStored(list, nextListData)
    ? listDoc
    : await upsertDocument(orgId, MATERIAL_LIST_COLLECTION, {
    id: listId,
    data: nextListData,
    metadata: {
      ...asObject(listDoc.metadata),
      schedule_event_id: cleanText(event.id),
      delivery_status: nextDelivery
    }
  }, { replace: true });
  const orderDocs = resourceType === "material" ? await listDocuments(orgId, MATERIAL_ORDER_COLLECTION) : [];
  for (const orderDoc of orderDocs) {
    const order = documentView(orderDoc);
    if (cleanText(order.material_list_id) !== listId) continue;
    if (cleanText(order.schedule_event_id) && cleanText(order.schedule_event_id) !== cleanText(event.id)) continue;
    const nextOrderData = {
      ...order,
      schedule_event_id: cleanText(event.id),
      schedule_status: scheduleStatus,
      schedule_locked: event.locked === true,
      scheduled_window: {
        ...asObject(order.scheduled_window),
        start_at: cleanText(event.start_at),
        end_at: cleanText(event.end_at)
      },
      updated_at: now
    };
    if (!semanticallyEqualStored(order, nextOrderData)) {
      await upsertDocument(orgId, MATERIAL_ORDER_COLLECTION, {
        id: cleanText(order.id),
        data: nextOrderData,
        metadata: { ...asObject(orderDoc.metadata), schedule_event_id: cleanText(event.id) }
      }, { replace: true });
    }
  }
  return documentView(nextListDoc);
}

export async function clearMaterialListScheduleEvent(orgId: string, eventValue: JsonObject) {
  const event = asObject(eventValue);
  const eventId = cleanText(event.id);
  const listId = cleanText(event.scope_resource_list_id || event.material_list_id || event.labor_list_id || event.equipment_list_id);
  if (!listId || !eventId) return null;
  const listDoc = await readDocument(orgId, MATERIAL_LIST_COLLECTION, listId).catch(() => null);
  if (!listDoc) return null;
  const list = documentView(listDoc);
  const currentEventId = cleanText(list.schedule_event_id || asObject(list.schedule).event_id);
  if (currentEventId && currentEventId !== eventId) return list;
  const now = nowIso();
  const nextListData = {
    ...list,
    schedule_event_id: "",
    schedule_status: "unscheduled",
    delivery_status: deliveryStatus(list.delivery_status) === "scheduled" ? "unscheduled" : list.delivery_status,
    schedule: {
      ...asObject(list.schedule),
      enabled: false,
      event_id: "",
      status: "unscheduled",
      locked: false,
      start_at: "",
      end_at: ""
    },
    updated_at: now
  };
  const stored = await upsertDocument(orgId, MATERIAL_LIST_COLLECTION, {
    id: listId,
    data: nextListData,
    metadata: { ...asObject(listDoc.metadata), schedule_event_id: "" }
  }, { replace: true });
  const orderDocs = scopeResourceType(list) === "material" ? await listDocuments(orgId, MATERIAL_ORDER_COLLECTION) : [];
  for (const orderDoc of orderDocs) {
    const order = documentView(orderDoc);
    if (cleanText(order.material_list_id) !== listId || cleanText(order.schedule_event_id) !== eventId) continue;
    await upsertDocument(orgId, MATERIAL_ORDER_COLLECTION, {
      id: cleanText(order.id),
      data: {
        ...order,
        schedule_event_id: "",
        schedule_status: "unscheduled",
        schedule_locked: false,
        scheduled_window: { ...asObject(order.scheduled_window), start_at: "", end_at: "" },
        updated_at: now
      },
      metadata: { ...asObject(orderDoc.metadata), schedule_event_id: "" }
    }, { replace: true });
  }
  return documentView(stored);
}

async function lockMaterialScheduleEventForOrder(orgId: string, listId: string, order: JsonObject, lockOnOrder = true) {
  const event = await ensureMaterialListScheduleEvent(orgId, listId);
  const list = await readMaterialList(orgId, listId);
  const projectId = cleanText(list.project_id);
  const projectDoc = await readDocument(orgId, "projects", projectId);
  const project = documentData(projectDoc);
  const events = (Array.isArray(project.events) ? project.events : []).map(asObject);
  const index = events.findIndex((entry) => cleanText(entry.id) === cleanText(event.id));
  if (index < 0) return event;
  const now = nowIso();
  const currentEvent = asObject(events[index]);
  const currentScheduleLock = asObject(currentEvent.schedule_lock);
  const locked = lockOnOrder
    ? true
    : (Object.prototype.hasOwnProperty.call(currentScheduleLock, "locked") ? currentScheduleLock.locked === true : currentEvent.locked === true);
  const lockedEvent = {
    ...currentEvent,
    material_order_id: cleanText(order.id),
    order_status: "ordered",
    ordered: true,
    locked,
    schedule_lock: {
      ...currentScheduleLock,
      locked,
      reason: lockOnOrder ? "material_order" : cleanText(currentScheduleLock.reason || "manual"),
      locked_at: lockOnOrder ? cleanText(currentScheduleLock.locked_at || now) : cleanText(currentScheduleLock.locked_at),
      unlocked_at: lockOnOrder ? "" : cleanText(currentScheduleLock.unlocked_at)
    },
    locked_at: lockOnOrder ? cleanText(currentEvent.locked_at || now) : cleanText(currentEvent.locked_at),
    locked_reason: lockOnOrder ? "material_order_placed" : cleanText(currentEvent.locked_reason),
    updated_at: now
  };
  events[index] = lockedEvent;
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...project, events, updated_at: now },
    metadata: projectDoc.metadata
  }, { replace: true });
  await syncMaterialListFromScheduleEvent(orgId, lockedEvent);
  return lockedEvent;
}

async function syncMaterialScheduleFulfillment(orgId: string, listId: string, status: string, orderId = "") {
  const list = await readMaterialList(orgId, listId).catch(() => null);
  const projectId = cleanText(list?.project_id);
  const eventId = cleanText(list?.schedule_event_id);
  if (!projectId || !eventId) return null;
  const projectDoc = await readDocument(orgId, "projects", projectId);
  const project = documentData(projectDoc);
  const events = (Array.isArray(project.events) ? project.events : []).map(asObject);
  const index = events.findIndex((entry) => cleanText(entry.id) === eventId);
  if (index < 0) return null;
  const now = nowIso();
  const event = {
    ...asObject(events[index]),
    material_order_id: orderId || cleanText(asObject(events[index]).material_order_id),
    delivery_status: status,
    fulfillment_status: status,
    fulfilled: status === "delivered",
    fulfilled_at: status === "delivered" ? now : cleanText(asObject(events[index]).fulfilled_at),
    updated_at: now
  };
  events[index] = event;
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...project, events, updated_at: now },
    metadata: projectDoc.metadata
  }, { replace: true });
  return event;
}

type ScopeMaterialFact = {
  item: JsonObject;
  catalogItem: JsonObject;
  pricebookId: string;
  pricebookRevision: number;
  currency: string;
  itemId: string;
  itemTypeId: string;
  category: string;
  tags: string[];
};

function selectedScopeMaterialItems(value: unknown) {
  const selected: JsonObject[] = [];
  const visit = (raw: unknown, parentSelected = true) => {
    const item = resolveScopeItemVariation(raw);
    const isSelected = parentSelected && scopeItemSelected(item);
    if (!isSelected) return;
    if (cleanText(asObject(item.pricebook_ref).item_id || asObject(item.pricebook_ref).catalog_item_id)) selected.push(item);
    for (const child of Array.isArray(item.children) ? item.children : []) visit(child, isSelected);
  };
  for (const [index, root] of (Array.isArray(value) ? value : []).entries()) visit(normalizeScopeItem(root, index));
  return selected;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableJsonValue(entry)]));
  }
  return value;
}

function withoutGeneratedVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGeneratedVolatileFields);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject)
      .filter(([key]) => key !== "captured_at")
      .map(([key, entry]) => [key, withoutGeneratedVolatileFields(entry)]));
  }
  return value;
}

function generatedMaterialFingerprint(itemsValue: unknown, measurements: JsonObject) {
  const items = withoutGeneratedVolatileFields((Array.isArray(itemsValue) ? itemsValue : []).map(asObject));
  const canonical = JSON.stringify(stableJsonValue({ items, measurements: withoutGeneratedVolatileFields(measurements) }));
  return createHash("sha256").update(canonical).digest("hex");
}

function selectorValues(value: unknown) {
  return normalizeStringArray(value).map((entry) => entry.toLowerCase());
}

function materialFactMatchesSelector(fact: ScopeMaterialFact, selectorValue: unknown) {
  const selector = asObject(selectorValue);
  const itemIds = selectorValues(selector.pricebook_item_ids);
  const itemTypeIds = selectorValues(selector.item_type_ids);
  const categories = selectorValues(selector.categories);
  const tags = selectorValues(selector.tags);
  if (selectorValues(selector.exclude_pricebook_item_ids).includes(fact.itemId)) return false;
  if (selectorValues(selector.exclude_item_type_ids).includes(fact.itemTypeId)) return false;
  if (selectorValues(selector.exclude_categories).includes(fact.category)) return false;
  if (selectorValues(selector.exclude_tags).some((tag) => fact.tags.includes(tag))) return false;
  const groups: boolean[] = [];
  if (itemIds.length) groups.push(itemIds.includes(fact.itemId));
  if (itemTypeIds.length) groups.push(itemTypeIds.includes(fact.itemTypeId));
  if (categories.length) groups.push(categories.includes(fact.category));
  if (tags.length) groups.push(tags.some((tag) => fact.tags.includes(tag)));
  if (!groups.length) return true;
  return cleanText(selector.match || "any") === "all" ? groups.every(Boolean) : groups.some(Boolean);
}

function scopeMaterialLineItem(fact: ScopeMaterialFact, listId: string, listDefinition: JsonObject, measurements: JsonObject) {
  const item = fact.item;
  const selectedOptions = asObject(item.selected_options || asObject(item.pricebook_ref).selected_options || asObject(item.variables));
  return {
    id: `material_item_${hashId(`${listId}:${cleanText(item.id)}:${fact.itemId}`)}`,
    source_item_id: cleanText(item.id),
    section: fact.category || "materials",
    structure_id: cleanText(item.structure_id || asObject(item.metadata).structure_id),
    structure_name: cleanText(item.structure_name || asObject(item.metadata).structure_name),
    pricebook_ref: {
      ...asObject(item.pricebook_ref),
      pricebook_id: fact.pricebookId,
      item_id: fact.itemId,
      item_type_id: fact.itemTypeId,
      selected_options: selectedOptions,
      ...(fact.pricebookRevision > 0 ? { catalog_revision: fact.pricebookRevision } : {}),
      source: "signed_scope"
    },
    pricebook_snapshot: {
      pricebook_id: fact.pricebookId,
      pricebook_revision: fact.pricebookRevision,
      captured_at: nowIso(),
      item: cloneJson(fact.catalogItem),
      item_type: { id: fact.itemTypeId, name: cleanText(fact.catalogItem.itemTypeName) },
      selected_options: selectedOptions,
      currency: fact.currency || "USD",
      source: fact.pricebookId ? "organization_pricebook" : "default_template"
    },
    item_type_id: fact.itemTypeId,
    variant_id: cleanText(fact.catalogItem.variantId || asObject(item.pricebook_ref).variant_id),
    variant_group_id: cleanText(fact.catalogItem.variantGroupId || asObject(item.pricebook_ref).variant_group_id),
    selected_options: selectedOptions,
    name: cleanText(item.display_name || item.name || fact.catalogItem.name),
    description: cleanText(item.description || fact.catalogItem.description),
    category: fact.category,
    manufacturer: cleanText(fact.catalogItem.manufacturer),
    segment: cleanText(fact.catalogItem.segment),
    quantity: maybeNumber(item.quantity),
    unit: cleanText(item.unit || fact.catalogItem.unit),
    ...deriveOrderFields(item.order_packaging ?? fact.catalogItem.order_packaging ?? fact.catalogItem.orderPackaging, maybeNumber(item.quantity)),
    projected_unit_price: maybeNumber(item.unit_price ?? item.base_price ?? fact.catalogItem.unitPrice),
    currency: fact.currency || "USD",
    measurements: { ...measurements, ...asObject(item.measurements) },
    metadata: {
      ...asObject(item.metadata),
      generated_from_scope: true,
      material_list_definition_id: cleanText(listDefinition.id),
      material_list_title: cleanText(listDefinition.title),
      material_list_color: cleanText(listDefinition.color)
    }
  };
}

async function scopeMaterialFacts(orgId: string, items: JsonObject[]): Promise<ScopeMaterialFact[]> {
  const defaultCatalog = asObject(DEFAULT_PRICEBOOK_TEMPLATE.catalog);
  const defaultItems = (Array.isArray(defaultCatalog.items) ? defaultCatalog.items : []).map(asObject);
  const defaultPricebookId = await resolveDefaultPricebookId(orgId);
  const catalogCache = new Map<string, Promise<{ catalog: JsonObject; manifest: JsonObject }>>();
  const loadCatalog = async (pricebookId: string) => {
    if (!pricebookId) return { catalog: defaultCatalog, manifest: {} };
    if (!catalogCache.has(pricebookId)) {
      catalogCache.set(pricebookId, Promise.all([readCatalog(pricebookId), readManifest(pricebookId)])
        .then(([catalog, manifest]) => ({ catalog: catalog as unknown as JsonObject, manifest: manifest as unknown as JsonObject }))
        .catch(() => ({ catalog: defaultCatalog, manifest: {} })));
    }
    return await (catalogCache.get(pricebookId) as Promise<{ catalog: JsonObject; manifest: JsonObject }>);
  };
  const facts: ScopeMaterialFact[] = [];
  for (const item of items) {
    const ref = asObject(item.pricebook_ref);
    const itemId = cleanText(ref.item_id || ref.catalog_item_id).toLowerCase();
    if (!itemId) continue;
    const pricebookId = cleanText(ref.pricebook_id) || defaultPricebookId;
    const { catalog, manifest } = await loadCatalog(pricebookId);
    const catalogItems = (Array.isArray(catalog.items) ? catalog.items : []).map(asObject);
    const catalogItem = catalogItems.find((entry) => cleanText(entry.id).toLowerCase() === itemId)
      || defaultItems.find((entry) => cleanText(entry.id).toLowerCase() === itemId)
      || {};
    const metadata = asObject(catalogItem.metadata);
    const itemMetadata = asObject(item.metadata);
    const tags = [
      ...normalizeStringArray(catalogItem.tags),
      ...normalizeStringArray(metadata.tags || metadata.material_tags || metadata.material_lists),
      ...normalizeStringArray(item.tags),
      ...normalizeStringArray(itemMetadata.tags || itemMetadata.material_tags || itemMetadata.material_lists),
      cleanText(metadata.material_list_id),
      cleanText(itemMetadata.material_list_id)
    ].map((tag) => tag.toLowerCase()).filter(Boolean);
    facts.push({
      item,
      catalogItem,
      pricebookId,
      pricebookRevision: Number(manifest.revision || ref.catalog_revision || 0),
      currency: cleanText(manifest.currency || "USD"),
      itemId,
      itemTypeId: cleanText(ref.item_type_id || catalogItem.itemTypeId).toLowerCase(),
      category: cleanText(item.category || catalogItem.category).toLowerCase(),
      tags: [...new Set(tags)]
    });
  }
  return facts;
}

async function materialDefinitionForPiece(orgId: string, branchId: string, piece: JsonObject, input: JsonObject) {
  if (Object.keys(asObject(input.resources)).length) return asObject(input.resources);
  if (Object.keys(asObject(input.materials)).length) return asObject(input.materials);
  const templateId = cleanText(input.scope_template_id || piece.template_id || piece.templateId || piece.scope_template_id || piece.type || "manual");
  const requestedVersion = Number(input.scope_template_version || piece.template_version || piece.scope_template_version || 0);
  const template = requestedVersion
    ? (await readScopeTemplateVersion(orgId, branchId, templateId, requestedVersion))
    : (await readScopeTemplate(orgId, branchId, templateId));
  const definition = asObject(template?.definition);
  const resources = asObject(definition.resources);
  const materials = asObject(definition.materials);
  let resolved = Object.keys(resources).length
    ? resources
    : (Object.keys(materials).length
      ? { ...materials, lists: (Array.isArray(materials.lists) ? materials.lists : []).map((entry) => ({ ...asObject(entry), resource_type: "material" })) }
      : {});

  // Published preset scopes retain their original material formulas, while new
  // non-material resource defaults can be added by later preset revisions. This
  // lets older signed roof scopes receive labor/equipment lists without changing
  // their frozen material selections or requiring a one-off project migration.
  if (requestedVersion && asObject(definition.metadata).preset === true) {
    const currentDefinition = asObject(asObject((await readScopeTemplate(orgId, branchId, templateId))).definition);
    const currentResources = asObject(currentDefinition.resources);
    const currentLists = (Array.isArray(currentResources.lists) ? currentResources.lists : []).map(asObject);
    if (currentLists.length) {
      const existingLists = (Array.isArray(resolved.lists) ? resolved.lists : []).map(asObject);
      const currentNonMaterial = currentLists.filter((entry) => ["labor", "equipment"].includes(cleanText(entry.resource_type)));
      const preserved = existingLists.filter((entry) => cleanText(entry.resource_type || "material") === "material");
      const existingCustom = existingLists.filter((entry) => !["material", "labor", "equipment"].includes(cleanText(entry.resource_type)));
      resolved = {
        ...currentResources,
        ...resolved,
        terminology: { ...asObject(currentResources.terminology), ...asObject(resolved.terminology) },
        types: { ...asObject(currentResources.types), ...asObject(resolved.types) },
        lists: [...preserved, ...currentNonMaterial, ...existingCustom],
        extension_points: Array.isArray(currentResources.extension_points) ? currentResources.extension_points : resolved.extension_points
      };
    }
  }
  return resolved;
}

export async function initializeProjectMaterialListsFromScope(
  orgId: string,
  projectId: string,
  input: JsonObject = {},
  ctx?: PlatformAuthContext | null
) {
  await requireMaterialsFlag(orgId);
  const { data: project } = await projectData(orgId, projectId);
  const branchId = cleanText(input.branch_id || project.branch_id || ctx?.branchId || "default") || "default";
  let snapshot: JsonObject = {};
  let snapshotId = cleanText(input.snapshot_id);
  const proposalId = cleanText(input.proposal_id);
  if (!snapshotId && proposalId) {
    const proposalDoc = await readDocument(orgId, "proposals", proposalId).catch(() => null);
    snapshotId = cleanText(asObject(asObject(proposalDoc?.data).delivery).current_snapshot_id);
  }
  if (snapshotId) {
    const snapshotDoc = await readDocument(orgId, "proposal_snapshots", snapshotId);
    snapshot = { id: snapshotId, ...documentData(snapshotDoc) };
  }
  const suppliedScope = asObject(input.scope);
  const scope = Object.keys(suppliedScope).length ? suppliedScope : asObject(asObject(snapshot.content).scope);
  const explicitPiece = asObject(input.scope_piece);
  let pieces = Object.keys(explicitPiece).length ? [explicitPiece] : enrichedProposalScopePieces(scope);
  const requestedPieceId = cleanText(input.scope_piece_id);
  if (requestedPieceId) pieces = pieces.filter((piece) => cleanText(piece.id || piece.scope_piece_id) === requestedPieceId);
  if (!pieces.length && (Array.isArray(scope.root_items) || Object.keys(asObject(input.materials)).length)) {
    pieces = [{
      id: requestedPieceId || "scope",
      template_id: cleanText(input.scope_template_id || "manual"),
      root_items: Array.isArray(scope.root_items) ? scope.root_items : [],
      measurements: asObject(scope.measurements)
    }];
  }
  const actor = ctx || systemMaterialContext(orgId, branchId);
  const forceRegenerate = input.force_regenerate === true || input.regenerate === true || input.force === true;
  const createdLists: JsonObject[] = [];
  const scheduleEvents: JsonObject[] = [];
  let createdCount = 0;
  for (const piece of pieces) {
    const materials = await materialDefinitionForPiece(orgId, branchId, piece, input);
    const requestedResourceType = cleanText(input.resource_type);
    const resourceOverrides = asObject(input.resource_overrides);
    const definitions: JsonObject[] = (Array.isArray(materials.lists) ? materials.lists : []).map((definitionValue): JsonObject => {
      const definition = asObject(definitionValue);
      const override = asObject(resourceOverrides[cleanText(definition.id)]);
      const baseItems = (Array.isArray(definition.items) ? definition.items : []).map(asObject);
      const overrideItems = (Array.isArray(override.items) ? override.items : []).map(asObject);
      const overrideItemsById = new Map<string, JsonObject>();
      overrideItems.forEach((item) => {
        const id = cleanText(item.id);
        if (id) overrideItemsById.set(id, item);
      });
      const mergedItems: JsonObject[] = overrideItems.length ? [
        ...baseItems.map((item) => {
          const itemOverride = overrideItemsById.get(cleanText(item.id));
          if (!itemOverride) return item;
          overrideItemsById.delete(cleanText(item.id));
          return { ...item, ...itemOverride, metadata: { ...asObject(item.metadata), ...asObject(itemOverride.metadata) } };
        }),
        ...overrideItemsById.values()
      ] : baseItems;
      return {
        ...definition,
        ...override,
        controls: { ...asObject(definition.controls), ...asObject(override.controls) },
        compensation: { ...asObject(definition.compensation), ...asObject(override.compensation) },
        assignment: { ...asObject(definition.assignment), ...asObject(override.assignment) },
        items: mergedItems
      } as JsonObject;
    }).filter((definition) => !requestedResourceType || cleanText(definition.resource_type || "material") === requestedResourceType);
    if (materials.enabled === false || !definitions.length) continue;
    const pieceId = cleanText(piece.id || piece.scope_piece_id) || "scope";
    const templateId = cleanText(input.scope_template_id || piece.template_id || piece.templateId || piece.scope_template_id || piece.type || "manual");
    const templateVersion = Number(input.scope_template_version || piece.template_version || piece.scope_template_version || 0);
    const measurements = { ...asObject(scope.measurements), ...asObject(piece.measurements) };
    const selectedItems = selectedScopeMaterialItems(piece.root_items || scope.root_items);
    const facts = await scopeMaterialFacts(orgId, selectedItems);
    const sourceNodes = asObject(input.source_nodes);
    const allOrderSources = normalizeOrderSources(materials.order_sources);
    const assignments = new Map<string, ScopeMaterialFact[]>();
    definitions.forEach((definition) => assignments.set(cleanText(definition.id), []));
    for (const fact of facts) {
      const explicitMatches = definitions.filter((definition) => asObject(definition.selector).default !== true && materialFactMatchesSelector(fact, definition.selector));
      const fallbackMatches = explicitMatches.length ? [] : definitions.filter((definition) => asObject(definition.selector).default === true && materialFactMatchesSelector(fact, definition.selector));
      const matches = [...explicitMatches, ...fallbackMatches];
      const selectedDefinitions = cleanText(materials.assignment || "first_match") === "all_matches" ? matches : matches.slice(0, 1);
      selectedDefinitions.forEach((definition) => assignments.get(cleanText(definition.id))?.push(fact));
    }
    for (const [definitionIndex, definition] of definitions.entries()) {
      const definitionId = cleanText(definition.id);
      if (!definitionId) continue;
      const sourceKey = `scope_materials:${projectId}:${pieceId}:${definitionId}`;
      const listId = `material_list_${hashId(sourceKey)}`;
      let list = await readMaterialList(orgId, listId).catch(() => null);
      const allowedSourceIds = new Set(normalizeStringArray(definition.order_source_ids));
      const orderSources = allowedSourceIds.size ? allOrderSources.filter((source) => allowedSourceIds.has(cleanText(source.id))) : allOrderSources;
      const resourceType = ["labor", "equipment"].includes(cleanText(definition.resource_type)) ? cleanText(definition.resource_type) : "material";
      const assignedFacts = resourceType === "material" ? (assignments.get(definitionId) || []) : [];
      const configuredItems = (Array.isArray(definition.items) ? definition.items : []).map((entry, itemIndex) => {
        const configured = asObject(entry);
        const configuredMetadata = asObject(configured.metadata);
        const quantityMeasurements = normalizeStringArray(configured.quantity_measurements || configuredMetadata.quantity_measurements);
        const singleQuantityMeasurement = cleanText(configured.quantity_measurement || configuredMetadata.quantity_measurement);
        if (singleQuantityMeasurement && !quantityMeasurements.includes(singleQuantityMeasurement)) quantityMeasurements.push(singleQuantityMeasurement);
        const quantityMeasurement = quantityMeasurements.find((key) => Number(maybeNumber(measurements[key]) || 0) > 0) || quantityMeasurements[0] || '';
        return {
          id: cleanText(configured.id || `${resourceType}_item_${itemIndex + 1}`),
          section: resourceType,
          name: cleanText(configured.name || configured.title || `${resourceType} item`),
          quantity: quantityMeasurement ? maybeNumber(measurements[quantityMeasurement]) : maybeNumber(configured.quantity),
          unit: cleanText(configured.unit || (resourceType === "labor" ? "hour" : "ea")),
          projected_unit_price: maybeNumber(configured.projected_unit_price || configured.unit_price),
          metadata: { ...configuredMetadata, generated_from_scope: true, resource_type: resourceType }
        };
      }).filter((item) => asObject(item.metadata).omit_when_zero !== true || Number(maybeNumber(item.quantity) || 0) > 0);
      const items = await normalizeLineItems(orgId, resourceType === "material" ? assignedFacts.map((fact) => scopeMaterialLineItem(fact, listId, definition, measurements)) : configuredItems);
      const desiredFingerprint = generatedMaterialFingerprint(items, measurements);
      const sectionKeys = [...new Set(items.map((item) => cleanText(item.section)).filter(Boolean))];
      const sections = sectionKeys.map((key) => ({ id: key, key, title: key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) }));
      const resources = {
        proposal_ids: [proposalId || cleanText(snapshot.proposal_id)].filter(Boolean),
        proposal_snapshot_ids: [snapshotId].filter(Boolean)
      };
      const generatedMetadata = {
        ...asObject(definition.metadata),
        generated_from_scope: true,
        source_key: sourceKey,
        material_list_definition_id: definitionId,
        scope_definition_order: definitionIndex,
        last_generated_fingerprint: desiredFingerprint,
        selector: asObject(definition.selector),
        materials_definition: { assignment: cleanText(materials.assignment || "first_match"), metadata: asObject(materials.metadata) }
      };
      if (!list) {
        list = await createMaterialList(orgId, projectId, {
          id: listId,
          branch_id: branchId,
          title: cleanText(definition.title || definitionId),
          resource_type: resourceType,
          resource_subtype: cleanText(definition.resource_subtype || definitionId),
          terminology: asObject(asObject(materials.terminology)[resourceType]),
          controls: asObject(definition.controls),
          compensation: asObject(definition.compensation),
          assignment: asObject(definition.assignment),
          color: cleanText(definition.color || "var(--primary,#d93025)"),
          sort_order: definitionIndex,
          scope_template_id: templateId,
          scope_template_version: templateVersion || undefined,
          scope_piece_id: pieceId,
          schedule: asObject(definition.schedule),
          order_sources: orderSources,
          measurements,
          sections,
          items,
          resources,
          metadata: generatedMetadata
        }, actor);
        createdCount += 1;
      } else if (cleanText(list.status) === "planning" && asObject(list.metadata).generated_from_scope === true) {
        const orders = await listMaterialOrders(orgId, listId);
        const currentFingerprint = generatedMaterialFingerprint(list.current_items, asObject(list.measurements));
        const lastGeneratedFingerprint = cleanText(asObject(list.metadata).last_generated_fingerprint);
        if (!orders.length && (forceRegenerate || (lastGeneratedFingerprint && currentFingerprint === lastGeneratedFingerprint))) {
          const itemsChanged = currentFingerprint !== desiredFingerprint;
          const sourceChanged = !!snapshotId && !normalizeStringArray(asObject(list.resources).proposal_snapshot_ids).includes(snapshotId);
          const templateChanged = Number(list.scope_template_version || 0) !== Number(templateVersion || 0);
          const definitionChanged = cleanText(list.title) !== cleanText(definition.title || definitionId)
            || cleanText(list.color) !== cleanText(definition.color || list.color || "var(--primary,#d93025)")
            || Number(list.sort_order || 0) !== definitionIndex
            || (
              resourceType === "labor"
              && asObject(list.compensation).user_overridden !== true
              && cleanText(asObject(list.compensation).mode || asObject(list.compensation).default_mode)
                !== cleanText(asObject(definition.compensation).mode || asObject(definition.compensation).default_mode)
            );
          if (itemsChanged || forceRegenerate) {
            const version = await createMaterialVersion(orgId, listId, {
              expected_revision: Number(list.revision || 0),
              reason: "proposal_import",
              title: cleanText(definition.title || definitionId),
              resource_type: resourceType,
              resource_subtype: cleanText(definition.resource_subtype || definitionId),
              terminology: asObject(asObject(materials.terminology)[resourceType]),
              controls: asObject(definition.controls),
              compensation: asObject(definition.compensation),
              assignment: asObject(definition.assignment),
              items,
              sections,
              resources,
              metadata: { generated_from_scope: true, source_key: sourceKey }
            }, actor);
            list = version.list;
          }
          if (itemsChanged || sourceChanged || templateChanged || definitionChanged || forceRegenerate) {
            list = await patchMaterialList(orgId, listId, {
              expected_revision: Number(list.revision || 0),
              title: cleanText(definition.title || definitionId),
              resource_type: resourceType,
              resource_subtype: cleanText(definition.resource_subtype || definitionId),
              terminology: asObject(asObject(materials.terminology)[resourceType]),
              controls: asObject(definition.controls),
              compensation: asObject(definition.compensation),
              assignment: asObject(definition.assignment),
              color: cleanText(definition.color || list.color || "var(--primary,#d93025)"),
              sort_order: definitionIndex,
              scope_template_id: templateId,
              scope_template_version: templateVersion || undefined,
              scope_piece_id: pieceId,
              schedule: asObject(definition.schedule),
              order_sources: orderSources,
              measurements,
              replace_measurements: true,
              sections,
              resources,
              metadata: generatedMetadata
            }, actor);
          }
        }
      }
      const schedule = asObject(definition.schedule);
      // Equipment schedule events only generate when the org runs equipment
      // scheduling; without the capability the behavior matches the legacy
      // suppressed state byte-for-byte.
      const scheduleEnabled = schedule.enabled === true
        && (resourceType !== "equipment" || await isCapabilityEnabled(orgId, "equipment.scheduling").catch(() => false));
      if (scheduleEnabled) {
        const sourceNodeId = cleanText(sourceNodes[cleanText(schedule.source_node_template_id)] || sourceNodes[definitionId]);
        const event = await ensureMaterialListScheduleEvent(orgId, cleanText(list.id), {
          work_plan_id: cleanText(input.work_plan_id),
          source_node_id: sourceNodeId,
          source_node_template_id: cleanText(schedule.source_node_template_id),
          schedule
        });
        scheduleEvents.push(event);
        list = await readMaterialList(orgId, cleanText(list.id));
      } else if (resourceType === "equipment" && cleanText(list.schedule_event_id || asObject(list.schedule).event_id)) {
        list = await disableGeneratedResourceScheduleEvent(orgId, list);
      }
      createdLists.push(list);
    }
  }
  return {
    material_lists: createdLists,
    schedule_events: scheduleEvents,
    count: createdLists.length,
    created_count: createdCount
  };
}

export async function patchMaterialList(orgId: string, listId: string, patch: JsonObject, ctx: PlatformAuthContext) {
  await requireMaterialsFlag(orgId);
  const currentDoc = await readDocument(orgId, MATERIAL_LIST_COLLECTION, listId);
  const current = documentView(currentDoc);
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(currentDoc.revision || 0)) {
    throw conflict("material_list_revision_conflict", "Material list revision does not match.");
  }
  const incomingStatus = Object.prototype.hasOwnProperty.call(patch, "status") ? listStatus(patch.status) : listStatus(current.status);
  const incomingDelivery = Object.prototype.hasOwnProperty.call(patch, "delivery_status") ? deliveryStatus(patch.delivery_status) : deliveryStatus(current.delivery_status);
  const lockNow = incomingStatus !== "planning" && !cleanText(current.locked_at);
  const currentItems = Array.isArray(current.current_items) ? current.current_items.map(asObject) : [];
  const items = lockNow ? await normalizeLineItems(orgId, currentItems, { lock: true, lockedAt: nowIso() }) : currentItems;
  const data = {
    ...current,
    title: cleanText(patch.title || current.title) || "Materials",
    resource_type: Object.prototype.hasOwnProperty.call(patch, "resource_type") ? cleanText(patch.resource_type) : cleanText(current.resource_type || "material"),
    resource_subtype: Object.prototype.hasOwnProperty.call(patch, "resource_subtype") ? cleanText(patch.resource_subtype) : cleanText(current.resource_subtype),
    terminology: Object.prototype.hasOwnProperty.call(patch, "terminology") ? { ...asObject(current.terminology), ...asObject(patch.terminology) } : asObject(current.terminology),
    controls: Object.prototype.hasOwnProperty.call(patch, "controls") ? { ...asObject(current.controls), ...asObject(patch.controls) } : asObject(current.controls),
    compensation: Object.prototype.hasOwnProperty.call(patch, "compensation") ? { ...asObject(current.compensation), ...asObject(patch.compensation) } : asObject(current.compensation),
    assignment: Object.prototype.hasOwnProperty.call(patch, "assignment") ? { ...asObject(current.assignment), ...asObject(patch.assignment) } : asObject(current.assignment),
    color: Object.prototype.hasOwnProperty.call(patch, "color") ? cleanText(patch.color) : cleanText(current.color),
    sort_order: Object.prototype.hasOwnProperty.call(patch, "sort_order") ? Number(patch.sort_order || 0) : Number(current.sort_order || 0),
    status: incomingStatus,
    delivery_status: incomingDelivery,
    scope_template_id: Object.prototype.hasOwnProperty.call(patch, "scope_template_id") ? cleanText(patch.scope_template_id) : cleanText(current.scope_template_id),
    scope_template_version: Object.prototype.hasOwnProperty.call(patch, "scope_template_version") ? Number(patch.scope_template_version || 0) : Number(current.scope_template_version || 0),
    scope_piece_id: Object.prototype.hasOwnProperty.call(patch, "scope_piece_id") ? cleanText(patch.scope_piece_id) : cleanText(current.scope_piece_id),
    schedule: Object.prototype.hasOwnProperty.call(patch, "schedule") ? { ...asObject(current.schedule), ...asObject(patch.schedule) } : asObject(current.schedule),
    schedule_event_id: Object.prototype.hasOwnProperty.call(patch, "schedule_event_id") ? cleanText(patch.schedule_event_id) : cleanText(current.schedule_event_id),
    order_sources: Object.prototype.hasOwnProperty.call(patch, "order_sources") ? normalizeOrderSources(patch.order_sources) : normalizeOrderSources(current.order_sources),
    measurements: Object.prototype.hasOwnProperty.call(patch, "measurements")
      ? (patch.replace_measurements === true ? asObject(patch.measurements) : { ...asObject(current.measurements), ...asObject(patch.measurements) })
      : asObject(current.measurements),
    sections: Object.prototype.hasOwnProperty.call(patch, "sections") ? normalizeSections(patch.sections) : (Array.isArray(current.sections) ? current.sections : []),
    resources: Object.prototype.hasOwnProperty.call(patch, "resources") ? { ...asObject(current.resources), ...asObject(patch.resources) } : asObject(current.resources),
    metadata: Object.prototype.hasOwnProperty.call(patch, "metadata") ? { ...asObject(current.metadata), ...asObject(patch.metadata) } : asObject(current.metadata),
    current_items: items,
    totals: deriveTotals(items),
    locked_at: lockNow ? nowIso() : cleanText(current.locked_at),
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  };
  const doc = await upsertDocument(orgId, MATERIAL_LIST_COLLECTION, {
    id: listId,
    expected_revision: expectedRevision || undefined,
    data,
    metadata: {
      kind: "material_list",
      project_id: cleanText(current.project_id),
      branch_id: cleanText(current.branch_id),
      status: data.status,
      delivery_status: data.delivery_status
    }
  }, { replace: true });
  await recordMaterialEvent(orgId, listId, "material_list.updated", { fields: Object.keys(patch) }, ctx);
  return documentView(doc);
}

export async function archiveMaterialList(orgId: string, listId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const list = await patchMaterialList(orgId, listId, {
    expected_revision: input.expected_revision,
    status: "archived",
    metadata: { archive_reason: cleanText(input.reason) }
  }, ctx);
  await recordMaterialEvent(orgId, listId, "material_list.archived", { reason: cleanText(input.reason) }, ctx);
  return list;
}

export async function listMaterialVersions(orgId: string, listId: string) {
  await requireMaterialsFlag(orgId);
  const docs = await listDocuments(orgId, MATERIAL_VERSION_COLLECTION);
  return docs
    .map(documentView)
    .filter((version) => cleanText(version.material_list_id) === listId)
    .sort((a, b) => Number(a.version_number || 0) - Number(b.version_number || 0));
}

export async function createMaterialVersion(orgId: string, listId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMaterialsFlag(orgId);
  const currentDoc = await readDocument(orgId, MATERIAL_LIST_COLLECTION, listId);
  return await commitMaterialVersion(orgId, currentDoc, input, ctx);
}

export async function createMaterialOrder(orgId: string, listId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMaterialsFlag(orgId);
  const currentDoc = await readDocument(orgId, MATERIAL_LIST_COLLECTION, listId);
  const current = documentView(currentDoc);
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(currentDoc.revision || 0)) {
    throw conflict("material_list_revision_conflict", "Material list revision does not match.");
  }
  const now = nowIso();
  const orderSources = normalizeOrderSources(current.order_sources);
  const requestedOrderSourceId = cleanText(input.order_source_id || asObject(input.metadata).order_source_id);
  const defaultManualOrderSource = { id: "manual", name: "Manual Order", kind: "manual", status: "active", provider: "" };
  const orderSource = requestedOrderSourceId
    ? orderSources.find((source) => cleanText(source.id) === requestedOrderSourceId)
      || (requestedOrderSourceId === "manual" && !orderSources.length ? defaultManualOrderSource : undefined)
    : orderSources.find((source) => cleanText(source.status) === "active" && cleanText(source.kind) === "manual")
      || orderSources.find((source) => cleanText(source.status) === "active")
      || defaultManualOrderSource;
  if (requestedOrderSourceId && !orderSource) throw badRequest("material_order_source_not_found", "The selected material order source is not available for this list.");
  if (cleanText(orderSource?.status || "active") !== "active") {
    throw conflict("material_order_source_unavailable", `${cleanText(orderSource?.name || requestedOrderSourceId) || "This order source"} is not available yet.`);
  }
  const scheduledWindow = asObject(input.scheduled_window);
  const hasScheduledWindow = Object.keys(scheduledWindow).some((key) => cleanText(scheduledWindow[key]));
  const requestedDeliveryStatus = deliveryStatus(input.delivery_status || (hasScheduledWindow || cleanText(current.schedule_status) === "scheduled" ? "scheduled" : "unscheduled"));
  const itemIds = normalizeStringArray(input.item_ids);
  const currentItems = (Array.isArray(current.current_items) ? current.current_items : []).map(asObject);
  const lockSet = itemIds.length ? new Set(itemIds) : null;
  const lockedItems = await Promise.all(currentItems.map((item, index) => {
    const lock = !lockSet || lockSet.has(cleanText(item.id));
    return normalizeLineItem(orgId, item, index, { lock, lockedAt: now });
  }));
  const versionResult = await commitMaterialVersion(orgId, currentDoc, {
    reason: "order_lock",
    title: input.title || current.title,
    items: lockedItems,
    sections: current.sections,
    resources: current.resources,
    metadata: { order_lock: true }
  }, ctx, {
    forceStatus: "ordered",
    forceDeliveryStatus: requestedDeliveryStatus,
    lock: true
  });
  const shouldEnsureSchedule = !!cleanText(input.schedule_event_id || current.schedule_event_id) || asObject(current.schedule).enabled === true;
  const scheduleEvent = shouldEnsureSchedule
    ? await ensureMaterialListScheduleEvent(orgId, listId, {
        event: cleanText(input.schedule_event_id) ? { id: cleanText(input.schedule_event_id) } : {}
      })
    : null;
  const orderedItems = selectedItems(lockedItems, input.item_ids);
  const id = materialOrderId(input, listId);
  const currency = cleanText(orderedItems.find((item) => cleanText(item.currency))?.currency || "USD");
  const data = {
    schema_version: MATERIAL_ORDER_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(current.branch_id),
    project_id: cleanText(current.project_id),
    material_list_id: listId,
    material_version_id: cleanText(versionResult.version.id),
    schedule_event_id: cleanText(input.schedule_event_id || scheduleEvent?.id || current.schedule_event_id),
    schedule_status: scheduleEvent ? eventScheduleStatus(scheduleEvent) : (hasScheduledWindow ? "scheduled" : cleanText(current.schedule_status || "unscheduled")),
    schedule_locked: scheduleEvent ? scheduleEvent.locked === true : false,
    title: cleanText(input.title || current.title) || "Material order",
    order_source_id: cleanText(orderSource?.id || "manual"),
    order_source: orderSource,
    status: "ordered",
    delivery_status: requestedDeliveryStatus,
    vendor: asObject(input.vendor),
    ordered_at: cleanText(input.ordered_at) || now,
    scheduled_window: scheduledWindow,
    items: cloneJson(orderedItems),
    item_ids: orderedItems.map((item) => cleanText(item.id)).filter(Boolean),
    projected_price: moneySnapshot(input.projected_price, currency),
    quoted_price: moneySnapshot(input.quoted_price, currency),
    paid_price: moneySnapshot(input.paid_price, currency),
    totals: deriveTotals(orderedItems),
    notes: cleanText(input.notes),
    metadata: asObject(input.metadata),
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, MATERIAL_ORDER_COLLECTION, {
    id,
    data,
    metadata: {
      kind: "material_order",
      material_list_id: listId,
      project_id: cleanText(current.project_id),
      material_version_id: cleanText(versionResult.version.id),
      schedule_event_id: data.schedule_event_id,
      delivery_status: data.delivery_status
    }
  }, { replace: true });
  await recordMaterialEvent(orgId, listId, "material_order.created", {
    order_id: id,
    version_id: cleanText(versionResult.version.id),
    schedule_event_id: data.schedule_event_id,
    order_source_id: data.order_source_id
  }, ctx);
  if (scheduleEvent) await lockMaterialScheduleEventForOrder(orgId, listId, documentView(doc), asObject(current.schedule).lock_on_order !== false);
  const [latestList, latestOrder] = await Promise.all([readMaterialList(orgId, listId), readMaterialOrder(orgId, id)]);
  return { list: latestList, version: versionResult.version, order: latestOrder };
}

export async function listMaterialOrders(orgId: string, listId: string) {
  await requireMaterialsFlag(orgId);
  const docs = await listDocuments(orgId, MATERIAL_ORDER_COLLECTION);
  return docs
    .map(documentView)
    .filter((order) => cleanText(order.material_list_id) === listId)
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

export async function readMaterialOrder(orgId: string, orderId: string) {
  await requireMaterialsFlag(orgId);
  return documentView(await readDocument(orgId, MATERIAL_ORDER_COLLECTION, orderId));
}

export async function patchMaterialOrder(orgId: string, orderId: string, patch: JsonObject, ctx: PlatformAuthContext) {
  await requireMaterialsFlag(orgId);
  const currentDoc = await readDocument(orgId, MATERIAL_ORDER_COLLECTION, orderId);
  const current = documentView(currentDoc);
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(currentDoc.revision || 0)) {
    throw conflict("material_order_revision_conflict", "Material order revision does not match.");
  }
  const data = {
    ...current,
    title: cleanText(patch.title || current.title) || "Material order",
    order_source_id: Object.prototype.hasOwnProperty.call(patch, "order_source_id") ? cleanText(patch.order_source_id) : cleanText(current.order_source_id),
    schedule_event_id: Object.prototype.hasOwnProperty.call(patch, "schedule_event_id") ? cleanText(patch.schedule_event_id) : cleanText(current.schedule_event_id),
    vendor: Object.prototype.hasOwnProperty.call(patch, "vendor") ? { ...asObject(current.vendor), ...asObject(patch.vendor) } : asObject(current.vendor),
    scheduled_window: Object.prototype.hasOwnProperty.call(patch, "scheduled_window") ? { ...asObject(current.scheduled_window), ...asObject(patch.scheduled_window) } : asObject(current.scheduled_window),
    delivery_status: Object.prototype.hasOwnProperty.call(patch, "delivery_status") ? deliveryStatus(patch.delivery_status) : deliveryStatus(current.delivery_status),
    projected_price: Object.prototype.hasOwnProperty.call(patch, "projected_price") ? moneySnapshot(patch.projected_price, cleanText(asObject(current.projected_price).currency)) : asObject(current.projected_price),
    quoted_price: Object.prototype.hasOwnProperty.call(patch, "quoted_price") ? moneySnapshot(patch.quoted_price, cleanText(asObject(current.quoted_price).currency)) : asObject(current.quoted_price),
    paid_price: Object.prototype.hasOwnProperty.call(patch, "paid_price") ? moneySnapshot(patch.paid_price, cleanText(asObject(current.paid_price).currency)) : asObject(current.paid_price),
    notes: Object.prototype.hasOwnProperty.call(patch, "notes") ? cleanText(patch.notes) : cleanText(current.notes),
    metadata: Object.prototype.hasOwnProperty.call(patch, "metadata") ? { ...asObject(current.metadata), ...asObject(patch.metadata) } : asObject(current.metadata),
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  };
  const doc = await upsertDocument(orgId, MATERIAL_ORDER_COLLECTION, {
    id: orderId,
    expected_revision: expectedRevision || undefined,
    data,
    metadata: {
      kind: "material_order",
      material_list_id: cleanText(current.material_list_id),
      project_id: cleanText(current.project_id),
      delivery_status: data.delivery_status
    }
  }, { replace: true });
  await recordMaterialEvent(orgId, cleanText(current.material_list_id || orderId), "material_order.updated", {
    order_id: orderId,
    fields: Object.keys(patch)
  }, ctx);
  return documentView(doc);
}

export async function recordMaterialDelivery(orgId: string, orderId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMaterialsFlag(orgId);
  const orderDoc = await readDocument(orgId, MATERIAL_ORDER_COLLECTION, orderId);
  const order = documentView(orderDoc);
  const expectedOrderRevision = Number(input.expected_order_revision || 0);
  if (expectedOrderRevision && expectedOrderRevision !== Number(orderDoc.revision || 0)) {
    throw conflict("material_order_revision_conflict", "Material order revision does not match.");
  }
  const now = nowIso();
  const id = materialDeliveryId(input, orderId);
  const status = deliveryStatus(input.status || (input.actual_delivered_at || input.actual_completed_at ? "delivered" : order.delivery_status));
  const itemIds = normalizeStringArray(input.item_ids);
  const data = {
    schema_version: MATERIAL_DELIVERY_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(order.branch_id),
    project_id: cleanText(order.project_id),
    material_list_id: cleanText(order.material_list_id),
    material_order_id: orderId,
    material_version_id: cleanText(order.material_version_id),
    status,
    estimated_window: Object.prototype.hasOwnProperty.call(input, "estimated_window") ? asObject(input.estimated_window) : asObject(order.scheduled_window),
    actual_started_at: cleanText(input.actual_started_at),
    actual_delivered_at: cleanText(input.actual_delivered_at || input.actual_completed_at),
    actual_completed_at: cleanText(input.actual_completed_at || input.actual_delivered_at),
    item_ids: itemIds.length ? itemIds : normalizeStringArray(order.item_ids),
    quantities: Array.isArray(input.quantities) ? input.quantities.map(asObject) : [],
    received_by: asObject(input.received_by),
    notes: cleanText(input.notes),
    metadata: asObject(input.metadata),
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const deliveryDoc = await upsertDocument(orgId, MATERIAL_DELIVERY_COLLECTION, {
    id,
    data,
    metadata: {
      kind: "material_delivery",
      material_order_id: orderId,
      material_list_id: cleanText(order.material_list_id),
      project_id: cleanText(order.project_id),
      status
    }
  }, { replace: true });
  await patchMaterialOrder(orgId, orderId, {
    expected_revision: Number(orderDoc.revision || 0),
    delivery_status: status
  }, ctx);
  if (status === "delivered" || status === "partially_delivered") {
    await patchMaterialList(orgId, cleanText(order.material_list_id), {
      delivery_status: status,
      status: status === "delivered" ? "delivered" : "partially_delivered"
    }, ctx);
  }
  await syncMaterialScheduleFulfillment(orgId, cleanText(order.material_list_id), status, orderId);
  await recordMaterialEvent(orgId, cleanText(order.material_list_id || orderId), "material_delivery.recorded", {
    order_id: orderId,
    delivery_id: id,
    status
  }, ctx);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(order.branch_id || "default"),
    project_id: cleanText(order.project_id),
    type: status === "delivered" ? "material.delivery.completed" : "material.delivery.updated",
    idempotency_key: `material.delivery:${id}:${status}`,
    payload: { order_id: orderId, delivery_id: id, status, delivery_kind: cleanText(asObject(input.metadata).delivery_type) }
  });
  return documentView(deliveryDoc);
}

export async function listMaterialDeliveries(orgId: string, orderId: string) {
  await requireMaterialsFlag(orgId);
  const docs = await listDocuments(orgId, MATERIAL_DELIVERY_COLLECTION);
  return docs
    .map(documentView)
    .filter((delivery) => cleanText(delivery.material_order_id) === orderId)
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

export async function patchMaterialDelivery(orgId: string, deliveryId: string, patch: JsonObject, ctx: PlatformAuthContext) {
  await requireMaterialsFlag(orgId);
  const currentDoc = await readDocument(orgId, MATERIAL_DELIVERY_COLLECTION, deliveryId);
  const current = documentView(currentDoc);
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(currentDoc.revision || 0)) {
    throw conflict("material_delivery_revision_conflict", "Material delivery revision does not match.");
  }
  const status = Object.prototype.hasOwnProperty.call(patch, "status") ? deliveryStatus(patch.status) : deliveryStatus(current.status);
  const data = {
    ...current,
    status,
    estimated_window: Object.prototype.hasOwnProperty.call(patch, "estimated_window") ? { ...asObject(current.estimated_window), ...asObject(patch.estimated_window) } : asObject(current.estimated_window),
    actual_started_at: Object.prototype.hasOwnProperty.call(patch, "actual_started_at") ? cleanText(patch.actual_started_at) : cleanText(current.actual_started_at),
    actual_delivered_at: Object.prototype.hasOwnProperty.call(patch, "actual_delivered_at") ? cleanText(patch.actual_delivered_at) : cleanText(current.actual_delivered_at),
    actual_completed_at: Object.prototype.hasOwnProperty.call(patch, "actual_completed_at") ? cleanText(patch.actual_completed_at) : cleanText(current.actual_completed_at),
    item_ids: Object.prototype.hasOwnProperty.call(patch, "item_ids") ? normalizeStringArray(patch.item_ids) : normalizeStringArray(current.item_ids),
    quantities: Object.prototype.hasOwnProperty.call(patch, "quantities") && Array.isArray(patch.quantities) ? patch.quantities.map(asObject) : (Array.isArray(current.quantities) ? current.quantities : []),
    received_by: Object.prototype.hasOwnProperty.call(patch, "received_by") ? { ...asObject(current.received_by), ...asObject(patch.received_by) } : asObject(current.received_by),
    notes: Object.prototype.hasOwnProperty.call(patch, "notes") ? cleanText(patch.notes) : cleanText(current.notes),
    metadata: Object.prototype.hasOwnProperty.call(patch, "metadata") ? { ...asObject(current.metadata), ...asObject(patch.metadata) } : asObject(current.metadata),
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  };
  const doc = await upsertDocument(orgId, MATERIAL_DELIVERY_COLLECTION, {
    id: deliveryId,
    expected_revision: expectedRevision || undefined,
    data,
    metadata: {
      kind: "material_delivery",
      material_order_id: cleanText(current.material_order_id),
      material_list_id: cleanText(current.material_list_id),
      project_id: cleanText(current.project_id),
      status
    }
  }, { replace: true });
  const orderId = cleanText(current.material_order_id);
  if (orderId) {
    const orderDoc = await readDocument(orgId, MATERIAL_ORDER_COLLECTION, orderId).catch(() => null);
    if (orderDoc) {
      await patchMaterialOrder(orgId, orderId, {
        expected_revision: Number(orderDoc.revision || 0),
        delivery_status: status
      }, ctx);
    }
  }
  const listId = cleanText(current.material_list_id);
  if (listId) {
    await patchMaterialList(orgId, listId, {
      delivery_status: status,
      ...(["delivered", "partially_delivered"].includes(status) ? { status: status === "delivered" ? "delivered" : "partially_delivered" } : {})
    }, ctx);
  }
  await syncMaterialScheduleFulfillment(orgId, cleanText(current.material_list_id), status, cleanText(current.material_order_id));
  await recordMaterialEvent(orgId, cleanText(current.material_list_id || deliveryId), "material_delivery.updated", {
    delivery_id: deliveryId,
    fields: Object.keys(patch)
  }, ctx);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(current.branch_id || "default"),
    project_id: cleanText(current.project_id),
    type: status === "delivered" ? "material.delivery.completed" : "material.delivery.updated",
    idempotency_key: `material.delivery:${deliveryId}:${status}:${cleanText(data.updated_at)}`,
    payload: { delivery_id: deliveryId, status, fields: Object.keys(patch) }
  });
  return documentView(doc);
}

export async function listMaterialEvents(orgId: string, listId: string) {
  await requireMaterialsFlag(orgId);
  const docs = await listDocuments(orgId, MATERIAL_EVENT_COLLECTION);
  return docs
    .map(documentView)
    .filter((event) => cleanText(event.material_list_id) === listId)
    .sort((a, b) => cleanText(a.created_at).localeCompare(cleanText(b.created_at)));
}

export async function recordMaterialEvent(orgId: string, listId: string, type: string, payload: JsonObject = {}, ctx?: PlatformAuthContext | null) {
  const now = nowIso();
  const id = materialEventId(listId, type);
  const data = {
    schema_version: MATERIALS_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    material_list_id: listId,
    type,
    actor_user_id: ctx?.userId || cleanText(payload.actor_user_id),
    payload,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, MATERIAL_EVENT_COLLECTION, {
    id,
    data,
    metadata: {
      kind: "material_event",
      material_list_id: listId,
      type
    }
  }, { replace: true });
  return documentView(doc);
}
