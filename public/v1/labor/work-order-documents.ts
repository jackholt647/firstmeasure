/**
 * Work order documents: a labor list, or a project's whole work order column, written out as a real document of the
 * built-in `work_order` type (template `tpl_work_order_default`), so it shows in the project's Documents tab, opens in
 * the document editor and downloads as a PDF through the documents system.
 *
 * Each source has one document with a stable id: `doc_work_order_<list id>` for a list and
 * `doc_work_order_project_<project id>` for the project. Generating again updates that same document in place (a
 * fresh issue of the same record), never a second copy. The document records the list revisions it was written from,
 * so a list that changed since says the document is out of date until it is generated again.
 */
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { listProjectMaterialLists, readMaterialList } from "../materials/storage.js";
import { prepareTemplatedArtifact } from "../documents/artifacts.js";
import { documentInstanceId, readDocumentInstance } from "../documents/storage.js";
import { laborLinesOf } from "./commitments.js";

export const WORK_ORDER_TEMPLATE_ID = "tpl_work_order_default";
const SOURCE_SYSTEM = "labor_work_order";

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const items = (list: JsonObject) => (Array.isArray(list.current_items) ? list.current_items : []).map(obj);
const archived = (list: JsonObject) => !!text(list.archived_at) || text(list.status) === "archived";
const kind = (list: JsonObject) => text(list.resource_type || obj(list.metadata).resource_type);
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const quantity = (value: number) => (Math.round(value * 100) / 100).toLocaleString("en-US");

export function workOrderDocumentId(source: { list_id?: string; project_id?: string }) {
  return documentInstanceId({ id: source.list_id ? `doc_work_order_${source.list_id}` : `doc_work_order_project_${source.project_id}` });
}

/** The lists a work order is written from: one labor list, or every open labor and equipment list on the project. */
async function sourceLists(orgId: string, projectId: string, listId?: string) {
  if (listId) {
    const list = await readMaterialList(orgId, listId);
    if (kind(list) !== "labor") throw badRequest("work_order_not_labor", "A work order is written from a labor list.");
    if (text(list.project_id) !== projectId) throw badRequest("work_order_wrong_project", "That list belongs to another project.");
    return [list];
  }
  return (await listProjectMaterialLists(orgId, projectId)).filter((list) => !archived(list) && ["labor", "equipment"].includes(kind(list)));
}

const assigneeName = (list: JsonObject) => text(obj(obj(list.assignment).work_resource_ref).name);
const listTitle = (list: JsonObject) => text(list.title) || (kind(list) === "equipment" ? "Equipment" : "Work order");

/** What the document says, worked out from the lists as they stand. Pay is the list's own line totals. */
export async function workOrderParams(orgId: string, lists: JsonObject[], scope: "list" | "project") {
  const several = lists.length > 1;
  const columns = [
    ...(several ? [{ key: "list", label: "Work order" }] : []),
    { key: "name", label: "Work" }, { key: "quantity", label: "Qty" }, { key: "unit", label: "Unit" }, { key: "rate", label: "Rate" }, { key: "amount", label: "Amount" }
  ];
  const rows: JsonObject[] = [];
  let totalCents = 0;
  for (const list of lists) {
    const equipment = kind(list) === "equipment", source = items(list);
    laborLinesOf(source).forEach((line, index) => {
      // Equipment lists carry what the equipment costs the business, and a cost-rate line only projects salaried time:
      // neither is paid to the assignee, so neither has an amount here.
      const projection = equipment || obj(source[index]?.metadata).projection_only === true;
      if (!projection && line.total_cents != null) totalCents += line.total_cents;
      rows.push({
        ...(several ? { list: [listTitle(list), assigneeName(list)].filter(Boolean).join(" · ") } : {}),
        name: line.name, quantity: quantity(line.quantity), unit: line.unit,
        rate: projection || line.rate == null ? "" : money(Math.round(line.rate * 100)),
        amount: projection || line.total_cents == null ? "" : money(line.total_cents)
      });
    });
  }
  const assignees = [...new Set(lists.filter((list) => kind(list) === "labor").map(assigneeName).filter(Boolean))];
  // A date is shown only when the organization schedules and a list has one.
  const scheduling = await isCapabilityEnabled(orgId, "platform.scheduling").catch(() => false);
  const starts = scheduling ? lists.map((list) => text(obj(list.schedule).start_at)).filter(Boolean).sort() : [];
  return {
    work_order_title: scope === "list" ? listTitle(lists[0] || {}) : "Work order",
    assignee_name: assignees.join(", ") || "Unassigned",
    scheduled_date: starts[0] || "",
    columns, rows,
    total_label: money(totalCents),
    total_cents: totalCents
  };
}

function revisions(lists: JsonObject[]) {
  return Object.fromEntries(lists.map((list) => [text(list.id), Number(list.revision || 0)]));
}

function entry(document: JsonObject, lists: JsonObject[]) {
  const meta = obj(document.metadata), recorded = obj(meta.source_list_revisions), current = revisions(lists);
  const ids = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  const stale = [...ids].some((id) => Number(recorded[id] ?? -1) !== Number(current[id] ?? -1));
  return {
    document_id: text(document.id), title: text(document.title), status: text(document.status),
    scope: text(meta.work_order_scope) || "list", list_id: text(meta.source_list_id), project_id: text(document.project_id),
    generated_at: text(meta.generated_at) || text(document.updated_at), stale, document
  };
}

/** The work order documents a project has, each with whether its lists changed since it was written. Reads only. */
export async function listWorkOrderDocuments(orgId: string, projectId: string) {
  const lists = await sourceLists(orgId, projectId);
  const found = [];
  const read = (id: string) => readDocumentInstance(orgId, id).then((document) => (text(document.status) === "void" || obj(document.metadata).source_system !== SOURCE_SYSTEM ? null : document)).catch(() => null);
  for (const list of lists.filter((row) => kind(row) === "labor")) {
    const document = await read(workOrderDocumentId({ list_id: text(list.id) }));
    if (document) found.push(entry(document, [list]));
  }
  const whole = await read(workOrderDocumentId({ project_id: projectId }));
  if (whole) found.push(entry(whole, lists));
  return found;
}

/**
 * Writes the work order document for one labor list (`list_id`) or for the whole project, or brings the existing one
 * up to date. Returns the same shape as a listing entry.
 */
export async function generateWorkOrderDocument(orgId: string, projectId: string, input: { list_id?: string }, ctx: PlatformAuthContext) {
  const listId = text(input.list_id), lists = await sourceLists(orgId, projectId, listId || undefined);
  if (!lists.length) throw badRequest("work_order_empty", "This project has no work order lists yet.");
  const scope = listId ? "list" : "project";
  const params = await workOrderParams(orgId, lists, scope);
  const documentId = workOrderDocumentId(listId ? { list_id: listId } : { project_id: projectId });
  const existing = await readDocumentInstance(orgId, documentId).catch(() => null);
  if (existing && obj(existing.metadata).source_system !== SOURCE_SYSTEM) throw badRequest("work_order_id_taken", "Another document already uses this work order's id.");
  const { document } = await prepareTemplatedArtifact({
    orgId, documentId, documentType: "work_order", templateId: WORK_ORDER_TEMPLATE_ID, projectId,
    branchId: text(lists[0]?.branch_id) || text(ctx.branchId) || "default", actorUserId: text(ctx.userId) || undefined,
    title: scope === "list" ? `Work order: ${params.work_order_title}${params.assignee_name !== "Unassigned" ? ` (${params.assignee_name})` : ""}` : "Work order",
    params,
    metadata: {
      source_system: SOURCE_SYSTEM, work_order_scope: scope, source_list_id: listId, source_project_id: projectId,
      source_list_revisions: revisions(lists), generated_at: new Date().toISOString(), generated_by_user_id: text(ctx.userId)
    }
  });
  return entry(document, lists);
}
