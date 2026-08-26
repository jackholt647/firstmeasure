import { createHash, randomUUID } from "node:crypto";

import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import {
  listDocuments,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { listPricebookManifests, readCatalog, readManifest } from "../pricebook/storage.js";
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
      catalog_revision: Number(manifest.revision || 0)
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
    .sort((a, b) => cleanText(b.updated_at).localeCompare(cleanText(a.updated_at)));
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
    status: listStatus(input.status),
    delivery_status: deliveryStatus(input.delivery_status),
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
    status: incomingStatus,
    delivery_status: incomingDelivery,
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
    forceDeliveryStatus: deliveryStatus(input.delivery_status || "scheduled"),
    lock: true
  });
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
    title: cleanText(input.title || current.title) || "Material order",
    status: "ordered",
    delivery_status: deliveryStatus(input.delivery_status || "scheduled"),
    vendor: asObject(input.vendor),
    ordered_at: cleanText(input.ordered_at) || now,
    scheduled_window: asObject(input.scheduled_window),
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
      delivery_status: data.delivery_status
    }
  }, { replace: true });
  await recordMaterialEvent(orgId, listId, "material_order.created", {
    order_id: id,
    version_id: cleanText(versionResult.version.id)
  }, ctx);
  return { list: versionResult.list, version: versionResult.version, order: documentView(doc) };
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
  await recordMaterialEvent(orgId, cleanText(order.material_list_id || orderId), "material_delivery.recorded", {
    order_id: orderId,
    delivery_id: id,
    status
  }, ctx);
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
  await recordMaterialEvent(orgId, cleanText(current.material_list_id || deliveryId), "material_delivery.updated", {
    delivery_id: deliveryId,
    fields: Object.keys(patch)
  }, ctx);
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
