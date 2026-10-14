import { readAssigneeStoreRecord, registerAssigneeCleanup, requireAssigneeRecord } from "../assignees/base.js";
import { ASSIGNEE_KIND_BY_NAME, ASSIGNEE_KINDS, assigneeRefSchema, type AssigneeRef } from "../assignees/contract.js";
import type { JsonObject } from "../platform/storage.js";

/**
 * Labor's view of an assignee. The definition is the assignee base (`assignees/`, docs/architecture/assignee-base.md);
 * this file only keeps the names labor, payroll and scheduling already import and says what labor does with its own
 * records when an assignee is removed. Stored references elsewhere call the same thing a work resource or a subject.
 */
export const ASSIGNEE_TYPES = ASSIGNEE_KINDS;
export const assigneeSchema = assigneeRefSchema;
export type Assignee = AssigneeRef;
/** The kinds a list's `work_resource_ref` uses, mapped to assignee types. */
export const ASSIGNEE_TYPE_BY_KIND: Record<string, Assignee["type"]> = ASSIGNEE_KIND_BY_NAME;
export { requireActor, type Actor } from "../assignees/base.js";

/** The live record behind an assignee, or null when there is none or it has been archived. Reads only. */
export async function readAssignee(orgId: string, assignee: Assignee): Promise<{ name: string; record: JsonObject } | null> {
  const found = await readAssigneeStoreRecord(orgId, assignee).catch(() => null);
  return found && found.status !== "archived" ? { name: found.name, record: found.record } : null;
}
/** Refuses a pay sheet, delivery setting, unit or commitment for an assignee that does not exist, so none is left orphaned from the start. */
export async function requireAssignee(orgId: string, assignee: Assignee) {
  const found = await requireAssigneeRecord(orgId, assignee);
  return { name: found.name, record: found.record };
}

// ---- What labor removes when an assignee is removed ----
const same = (subject: unknown, assignee: Assignee) => !!subject && (subject as Assignee).type === assignee.type && (subject as Assignee).id === assignee.id;
registerAssigneeCleanup("labor-pay-sheets", async (orgId, assignee, actor) => {
  const sheets = await import("./pay-sheets.js");
  const own = (await sheets.listPaySheets(orgId)).filter((sheet) => same(sheet.subject, assignee));
  for (const sheet of own) await sheets.archivePaySheet(orgId, { id: sheet.id }, actor);
  return { removed: own.length };
});
registerAssigneeCleanup("assignee-units", async (orgId, assignee, actor) => {
  const commitments = await import("./commitments.js");
  let removed = 0, kept = 0, detail = "";
  // Units are removed from the bottom up. One that still holds committed work is kept, and so is everything above it.
  for (let pass = 0; pass < 25; pass += 1) {
    const own = await commitments.listUnits(orgId, assignee);
    const leaves = own.filter((unit) => !own.some((other) => other.parent_unit_id === unit.id));
    let progressed = false;
    for (const unit of leaves) {
      try { await commitments.archiveUnit(orgId, { id: unit.id }, actor); removed += 1; progressed = true; }
      catch (error) { detail = error instanceof Error ? error.message : "A unit could not be removed."; }
    }
    if (!progressed) { kept = own.length; break; }
  }
  return { removed, kept, detail: kept ? detail : "" };
});
registerAssigneeCleanup("assignee-capabilities", async (orgId, assignee) => {
  const { deleteDocument } = await import("../platform/storage.js");
  const { CAPABILITY_COLLECTION } = await import("./capabilities.js");
  try { await deleteDocument(orgId, CAPABILITY_COLLECTION, `${assignee.type}:${assignee.id}`); return { removed: 1 }; }
  catch (error) { if ((error as { statusCode?: number; code?: string })?.statusCode === 404 || (error as { code?: string })?.code === "ENOENT") return { removed: 0 }; throw error; }
});
registerAssigneeCleanup("labor-delivery-settings", async (orgId, assignee) => {
  const { deleteDocument } = await import("../platform/storage.js");
  const { DELIVERY_SETTING_COLLECTION } = await import("./commitments.js");
  try { await deleteDocument(orgId, DELIVERY_SETTING_COLLECTION, `${assignee.type}:${assignee.id}`); return { removed: 1 }; }
  catch (error) { if ((error as { statusCode?: number; code?: string })?.statusCode === 404 || (error as { code?: string })?.code === "ENOENT") return { removed: 0 }; throw error; }
});
