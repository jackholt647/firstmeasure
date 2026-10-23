import { createHash } from "node:crypto";
import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import { readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { createDocumentInstance, patchDocumentInstance, resolveDocumentInstance } from "../documents/service.js";
import { readDocumentInstance } from "../documents/storage.js";
import { renderTemplatedArtifact } from "../documents/artifacts.js";
import { PURCHASE_ORDER_DEFAULT_TERMS, SHOPPING_LIST_DEFAULT_NOTES } from "../documents/supplier-templates.js";
import { sendProjectEmail, sendProjectSms } from "../comms/service.js";
import { createProjectChecklist, patchProjectChecklistItem, readProjectChecklistDetail } from "../workforce/crew_storage.js";
import { createPublicLink, resolvePublicLink } from "../public-links/service.js";

/**
 * How a project's materials are ordered from the Materials order window, beyond the order record itself
 * (createMaterialOrder, or the calculus ledger's `order` command):
 *
 * - A purchase order is a `purchase_order` document, one per supplier on an order, written from
 *   `tpl_purchase_order_default`. Its number comes from the organization's sequence the first time it is made.
 * - The supplier email goes through the project's email, with that purchase order attached when asked.
 * - A shopping list is a project checklist (crew_storage) whose items are the materials to pick up, grouped by
 *   supplier. People it is assigned to check it off in the app; anyone else gets a public link that can view it or
 *   also check it off. Its PDF is a `shopping_list` document.
 */

const PO_TEMPLATE = "tpl_purchase_order_default";
const SHOPPING_TEMPLATE = "tpl_shopping_list_default";
const PO_SEQUENCE_COLLECTION = "material_purchase_order_sequences";
export const SHOPPING_LIST_SOURCE = "materials_shopping_list";
export const SHOPPING_LINK_KIND = "materials_shopping_list";
const SHOPPING_LINK_PATH = "/v1/materials/public/shopping-lists/{token}/app";

const text = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const short = (max: number) => z.string().trim().max(max).default("");
const cents = z.number().int().min(0).max(1e13).nullable().optional();

const partySchema = z.object({ name: short(300), details: short(2000), email: short(320) }).strict().default({});
const purchaseOrderLineSchema = z.object({
  name: z.string().trim().min(1).max(500), details: short(2000), sku: short(120), quantity: z.number().finite().min(0).max(1e9), unit: short(60),
  unit_price_cents: cents, total_cents: cents, material_list_id: short(200), material_item_id: short(200)
}).strict();

/** One purchase order: `key` names the order it belongs to (its supplier and lists), so the same order keeps one document. */
export const purchaseOrderInputSchema = z.object({
  key: z.string().trim().min(1).max(500),
  po_number: short(60),
  order_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  delivery_label: short(300),
  supplier: partySchema,
  ship_to: partySchema,
  buyer: partySchema,
  intro: short(4000),
  notes: short(4000),
  terms: z.string().trim().max(6000).optional(),
  lines: z.array(purchaseOrderLineSchema).min(1).max(1000),
  delivery_cents: cents,
  list_ids: z.array(z.string().trim().min(1).max(200)).max(50).default([])
}).strict();
export type PurchaseOrderInput = z.infer<typeof purchaseOrderInputSchema>;

export function purchaseOrderDocumentId(orgId: string, projectId: string, key: string) {
  return `doc_po_${hash([orgId, projectId, key])}`;
}

/** The organization's next purchase order number. Numbers are never reused, even when a purchase order is never sent. */
export async function allocatePurchaseOrderNumber(orgId: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readDocument(orgId, PO_SEQUENCE_COLLECTION, "default").catch((error) => { if ((error as { statusCode?: number }).statusCode === 404) return null; throw error; });
    const data = asObject(current?.data);
    const next = Math.max(1, Math.floor(Number(data.next) || 1001));
    const prefix = Object.prototype.hasOwnProperty.call(data, "prefix") ? text(data.prefix) : "PO-";
    try {
      await upsertDocument(orgId, PO_SEQUENCE_COLLECTION, { id: "default", data: { ...data, prefix, next: next + 1 }, ...(current ? { expected_revision: current.revision } : {}) }, { replace: true, createOnly: !current });
      return `${prefix}${next}`;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409 || attempt === 7) throw error;
    }
  }
  throw conflict("purchase_order_number_contention", "A purchase order number could not be allocated. Try again.");
}

function purchaseOrderParams(input: PurchaseOrderInput, poNumber: string): JsonObject {
  const lines = input.lines.map((line) => ({ ...line, unit_price_cents: line.unit_price_cents ?? null, total_cents: line.total_cents ?? (line.unit_price_cents == null ? null : Math.round(line.unit_price_cents * line.quantity)) }));
  const pricesComplete = lines.every((line) => line.total_cents != null);
  const subtotal = lines.reduce((sum, line) => sum + (line.total_cents ?? 0), 0);
  const delivery = Math.max(0, input.delivery_cents ?? 0);
  return {
    po_number: poNumber,
    order_date: input.order_date || new Date().toISOString().slice(0, 10),
    delivery_label: input.delivery_label,
    supplier: input.supplier, ship_to: input.ship_to, buyer: input.buyer,
    intro: input.intro, notes: input.notes,
    terms: input.terms ?? PURCHASE_ORDER_DEFAULT_TERMS,
    lines,
    subtotal_cents: subtotal, delivery_cents: delivery, total_cents: subtotal + delivery, prices_complete: pricesComplete,
    list_ids: input.list_ids
  };
}

/** The purchase order's document, made the first time and rewritten from the order window after that. */
async function writePurchaseOrder(orgId: string, projectId: string, input: PurchaseOrderInput, ctx: PlatformAuthContext) {
  const id = purchaseOrderDocumentId(orgId, projectId, input.key);
  const existing = await readDocumentInstance(orgId, id).catch(() => null);
  if (existing && text(existing.project_id) !== projectId) throw forbidden("purchase_order_project", "This purchase order belongs to another project.");
  const poNumber = input.po_number || text(asObject(existing?.params).po_number) || await allocatePurchaseOrderNumber(orgId);
  const params = purchaseOrderParams(input, poNumber);
  const title = `Purchase Order ${poNumber}${input.supplier.name ? ` - ${input.supplier.name}` : ""}`;
  const metadata = { source_system: "materials", purchase_order_key: input.key, material_list_ids: input.list_ids };
  const document = existing
    ? await patchDocumentInstance(orgId, id, { title, params, metadata }, ctx)
    : (await createDocumentInstance(orgId, projectId, { id, document_type: "purchase_order", template_id: PO_TEMPLATE, workflow_id: null, title, params, metadata }, ctx)).document;
  return { id, document, params, title, poNumber };
}

/** Writes the purchase order and returns what the order window needs to show it as it will print. */
export async function preparePurchaseOrder(orgId: string, projectId: string, raw: unknown, ctx: PlatformAuthContext) {
  const input = purchaseOrderInputSchema.parse(raw);
  const written = await writePurchaseOrder(orgId, projectId, input, ctx);
  const resolved = await resolveDocumentInstance(orgId, written.document);
  return {
    document_id: written.id, po_number: written.poNumber, title: written.title, params: written.params,
    default_terms: PURCHASE_ORDER_DEFAULT_TERMS,
    preview: { resolved_definition: resolved.resolved_definition, widget_data: resolved.widget_data, theme: resolved.theme, theme_vars: resolved.theme_vars, params: asObject(resolved.scope).params || written.params }
  };
}

export async function renderPurchaseOrderPdf(orgId: string, projectId: string, raw: unknown, ctx: PlatformAuthContext) {
  const input = purchaseOrderInputSchema.parse(raw);
  const written = await writePurchaseOrder(orgId, projectId, input, ctx);
  const rendered = await renderTemplatedArtifact({
    orgId, documentId: written.id, documentType: "purchase_order", templateId: PO_TEMPLATE, projectId, branchId: ctx.branchId || "default",
    actorUserId: ctx.userId, title: written.title, params: written.params, metadata: asObject(written.document.metadata),
    fileName: `purchase-order-${written.poNumber.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase() || "draft"}.pdf`
  });
  return { bytes: rendered.bytes, fileName: rendered.fileName, contentType: "application/pdf", documentId: written.id, poNumber: written.poNumber };
}

export const supplierEmailSchema = z.object({
  to: z.string().trim().min(3).max(500),
  subject: z.string().trim().min(1).max(998),
  text: z.string().min(1).max(100_000),
  html: z.string().max(500_000).optional(),
  idempotency_key: z.string().trim().max(500).optional(),
  purchase_order: purchaseOrderInputSchema.optional()
}).strict();

/** Emails one supplier its order through the project's email, with its purchase order attached when one is given. */
export async function sendSupplierOrderEmail(orgId: string, projectId: string, raw: unknown, ctx: PlatformAuthContext) {
  const input = supplierEmailSchema.parse(raw);
  const pdf = input.purchase_order ? await renderPurchaseOrderPdf(orgId, projectId, input.purchase_order, ctx) : null;
  const sent = await sendProjectEmail(orgId, ctx.branchId || "default", projectId, {
    to: input.to, subject: input.subject, text: input.text, ...(input.html ? { html: input.html } : {}),
    ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
    source: { type: "user", user_id: ctx.userId, id: "materials_order" },
    ...(pdf ? { attachments: [{ name: pdf.fileName, content_type: pdf.contentType, content: pdf.bytes }] } : {})
  }, ctx);
  return { ...asObject(sent), purchase_order: pdf ? { document_id: pdf.documentId, po_number: pdf.poNumber, file_name: pdf.fileName } : null };
}

// ---------------------------------------------------------------------------
// Shopping lists
// ---------------------------------------------------------------------------

const shoppingItemSchema = z.object({
  name: z.string().trim().min(1).max(500), details: short(2000), quantity: z.number().finite().min(0).max(1e9), unit: short(60), sku: short(120),
  image_url: z.string().trim().max(2000).refine((value) => !value || /^(https?:\/\/|\/)/.test(value), "Use a web address for the image.").default(""),
  material_list_id: short(200), material_item_id: short(200)
}).strict();
export const shoppingListInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4000).optional(),
  list_ids: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  groups: z.array(z.object({ supplier: short(300), address: short(1000), items: z.array(shoppingItemSchema).min(1).max(1000) }).strict()).min(1).max(40),
  assignees: z.array(z.object({ kind: z.enum(["organization_user", "resource_group"]), id: z.string().trim().min(1).max(200), name: short(300) }).strict()).max(40).default([])
}).strict();

/** Makes the shopping list: one checklist item per material, in supplier order, assigned to the people who will pick it up. */
export async function createShoppingList(orgId: string, projectId: string, raw: unknown, ctx: PlatformAuthContext) {
  const input = shoppingListInputSchema.parse(raw);
  const items = input.groups.flatMap((group, groupIndex) => group.items.map((item, index) => ({
    title: item.name,
    description: [`${Number(item.quantity.toFixed(4))} ${item.unit}`.trim(), group.supplier ? `from ${group.supplier}` : "", item.details].filter(Boolean).join(" · "),
    item_type: "todo",
    sort_order: (groupIndex * 1000 + index + 1) * 10,
    metadata: { source: SHOPPING_LIST_SOURCE, supplier: group.supplier, supplier_address: group.address, group_index: groupIndex, quantity: item.quantity, unit: item.unit, sku: item.sku, details: item.details, image_url: item.image_url, material_list_id: item.material_list_id, material_item_id: item.material_item_id }
  })));
  const users = input.assignees.filter((entry) => entry.kind === "organization_user").map((entry) => entry.id);
  const groups = input.assignees.filter((entry) => entry.kind === "resource_group").map((entry) => entry.id);
  const checklist = await createProjectChecklist(orgId, projectId, {
    title: input.title,
    description: input.notes ?? SHOPPING_LIST_DEFAULT_NOTES,
    kind: "todo", audience: "crew", icon: "fa-basket-shopping",
    items,
    metadata: { source: SHOPPING_LIST_SOURCE, material_list_ids: input.list_ids, assignee_names: input.assignees.map((entry) => entry.name).filter(Boolean), suppliers: input.groups.map((group) => group.supplier) },
    assigned_user_ids: users, assigned_resource_group_ids: groups
  }, ctx.userId);
  return await readShoppingList(orgId, projectId, String(checklist.id));
}

export async function readShoppingList(orgId: string, projectId: string, checklistId: string) {
  const checklist = await readProjectChecklistDetail(orgId, projectId, checklistId).catch(() => null);
  if (!checklist || text(asObject(checklist.metadata).source) !== SHOPPING_LIST_SOURCE) throw notFound("shopping_list_not_found", "This shopping list was not found.");
  return checklist;
}

/** A shopping list as its recipient sees it: suppliers in order, each with its items. */
function shoppingListGroups(checklist: Awaited<ReturnType<typeof readShoppingList>>) {
  const groups: { supplier: string; address: string; items: JsonObject[] }[] = [];
  for (const item of checklist.items) {
    const meta = asObject(item.metadata);
    const supplier = text(meta.supplier);
    let group = groups.find((entry) => entry.supplier === supplier);
    if (!group) groups.push(group = { supplier, address: text(meta.supplier_address), items: [] });
    group.items.push({ id: item.id, name: item.title, details: text(meta.details), quantity: Number(meta.quantity) || 0, unit: text(meta.unit), sku: text(meta.sku), image_url: text(meta.image_url), checked: item.completed === true, revision: item.revision });
  }
  return groups;
}

export const shoppingShareSchema = z.object({
  permission: z.enum(["view", "check"]).default("check"),
  expires_in_days: z.number().int().min(1).max(365).default(30),
  recipient: z.object({ name: short(200), email: short(320), phone: short(40) }).strict().optional(),
  message: z.string().trim().max(1000).optional()
}).strict();

/** A link someone without an account opens to see the list, and check it off when the link allows; sent to them when an address is given. */
export async function shareShoppingList(orgId: string, projectId: string, checklistId: string, raw: unknown, ctx: PlatformAuthContext) {
  const input = shoppingShareSchema.parse(raw);
  const checklist = await readShoppingList(orgId, projectId, checklistId);
  const link = await createPublicLink(orgId, {
    kind: SHOPPING_LINK_KIND, resource_type: "project_checklist", resource_id: checklist.id, destination_path: SHOPPING_LINK_PATH,
    allowed_actions: input.permission === "check" ? ["view", "check"] : ["view"],
    expires_at: new Date(Date.now() + input.expires_in_days * 86_400_000).toISOString(),
    metadata: { project_id: projectId, recipient: asObject(input.recipient), permission: input.permission },
    created_by: ctx.userId
  });
  const recipient = input.recipient;
  const greeting = recipient?.name ? `Hi ${recipient.name},` : "Hi,";
  const body = `${greeting}\n\n${input.message || `Here is the shopping list "${checklist.title}".`} ${input.permission === "check" ? "Check off each item as you pick it up." : ""}\n\n${link.url}`.replace(/ +\n/g, "\n");
  const sent: JsonObject = {};
  if (recipient?.email) {
    sent.email = await sendProjectEmail(orgId, ctx.branchId || "default", projectId, { to: recipient.email, subject: `Shopping list: ${checklist.title}`, text: body, source: { type: "user", user_id: ctx.userId, id: "materials_shopping_list" }, idempotency_key: `shopping_list_email:${link.document.id}` }, ctx)
      .then(() => ({ ok: true })).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : "email_failed" }));
  }
  if (recipient?.phone) {
    sent.sms = await sendProjectSms(orgId, ctx.branchId || "default", projectId, { to: recipient.phone, text: `${input.message || `Shopping list: ${checklist.title}`} ${link.url}`, source: { type: "user", user_id: ctx.userId, id: "materials_shopping_list" }, idempotency_key: `shopping_list_sms:${link.document.id}` }, ctx)
      .then(() => ({ ok: true })).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : "sms_failed" }));
  }
  return { url: link.url, link_id: link.document.id, permission: input.permission, expires_at: text(asObject(link.document.data).expires_at), sent };
}

async function publicChecklist(token: string, action: string) {
  const resolved = await resolvePublicLink(token, { kind: SHOPPING_LINK_KIND, action });
  const projectId = text(asObject(resolved.document.metadata).project_id) || text(asObject(asObject(resolved.data).metadata).project_id);
  if (!projectId) throw notFound("shopping_list_not_found", "This shopping list is no longer available.");
  const checklist = await readShoppingList(resolved.orgId, projectId, text(resolved.data.resource_id));
  return { resolved, projectId, checklist };
}

export async function publicShoppingList(token: string) {
  const { resolved, projectId, checklist } = await publicChecklist(token, "view");
  const project = asObject((await readDocument(resolved.orgId, "projects", projectId).catch(() => null))?.data);
  const organization = asObject((await readDocument(resolved.orgId, "organizations", resolved.orgId).catch(() => null))?.data);
  const allowed = Array.isArray(resolved.data.allowed_actions) ? resolved.data.allowed_actions.map(text) : [];
  return {
    title: checklist.title, notes: checklist.description, can_check: !allowed.length || allowed.includes("check"),
    project: { title: text(project.title || project.address), address: text(project.address) },
    organization: { name: text(organization.name || organization.display_name), logo_url: text(asObject(organization.branding).logo_url || organization.logo_url) },
    total_items: checklist.total_items, completed_items: checklist.completed_items,
    groups: shoppingListGroups(checklist)
  };
}

export async function checkPublicShoppingListItem(token: string, itemId: string, raw: unknown) {
  const input = z.object({ completed: z.boolean() }).strict().parse(raw);
  const { resolved, projectId, checklist } = await publicChecklist(token, "check");
  if (!checklist.items.some((item) => item.id === itemId)) throw notFound("shopping_list_item_not_found", "This item is not on the shopping list.");
  const item = await patchProjectChecklistItem(resolved.orgId, projectId, itemId, { completed: input.completed }, `public_link:${resolved.document.id}`, false);
  return { id: item.id, checked: item.completed === true };
}

/** The shopping list as a PDF, with each item's box ticked as it stands now. */
export async function renderShoppingListPdf(orgId: string, projectId: string, checklistId: string, ctx: PlatformAuthContext) {
  const checklist = await readShoppingList(orgId, projectId, checklistId);
  const meta = asObject(checklist.metadata);
  const rows = shoppingListGroups(checklist).flatMap((group) => [
    { kind: "group", supplier: group.supplier || "Materials", address: group.address },
    ...group.items.map((item) => ({ kind: "item", name: item.name, details: [item.sku ? `SKU ${item.sku}` : "", text(item.details)].filter(Boolean).join(" · "), quantity: item.quantity, unit: item.unit, checked: item.checked, ...(text(item.image_url) ? { image: { url: text(item.image_url) } } : {}) }))
  ]);
  if (!rows.length) throw badRequest("shopping_list_empty", "This shopping list has no items.");
  const names = Array.isArray(meta.assignee_names) ? meta.assignee_names.map(text).filter(Boolean) : [];
  const rendered = await renderTemplatedArtifact({
    orgId, documentId: `doc_shopping_${hash([orgId, projectId, checklist.id])}`, documentType: "shopping_list", templateId: SHOPPING_TEMPLATE, projectId,
    branchId: ctx.branchId || "default", actorUserId: ctx.userId, title: checklist.title,
    params: { title: checklist.title, list_date: text(checklist.created_at).slice(0, 10), assignee: names.join(", "), notes: checklist.description, rows },
    metadata: { source_system: "materials", shopping_list_id: checklist.id },
    fileName: `${checklist.title.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase().replace(/^-+|-+$/g, "") || "shopping-list"}.pdf`
  });
  return { bytes: rendered.bytes, fileName: rendered.fileName, contentType: "application/pdf" };
}
