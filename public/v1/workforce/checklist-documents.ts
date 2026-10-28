/**
 * Checklist documents: a project checklist written out as a real document of the built-in `checklist` type (template
 * `tpl_checklist_default`, a config library entry made on request), so it shows in the project's Documents tab and
 * can be emailed, downloaded or printed for anyone without the crew app. A checklist that asks for a sign-off
 * (`signature_required`) gets a signature line, filled with the crew app sign-off when there is one.
 *
 * Each checklist has one document with a stable id, `doc_checklist_<checklist id>`: writing it again updates that
 * document in place (prepareTemplatedArtifact, which saves through saveDocumentInstance), never a second copy.
 */
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { readDocument } from "../platform/storage.js";
import { prepareTemplatedArtifact } from "../documents/artifacts.js";
import { documentInstanceId, readDocumentInstance } from "../documents/storage.js";
import { readProjectChecklistDetail } from "./crew_storage.js";

export const CHECKLIST_TEMPLATE_ID = "tpl_checklist_default";
const SOURCE_SYSTEM = "project_checklist";
const RATINGS: Record<string, string> = { good: "Good", neutral: "Okay", bad: "Needs attention" };

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const day = (value: unknown) => {
  const date = new Date(text(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
};

export function checklistDocumentId(checklistId: string) {
  return documentInstanceId({ id: `doc_checklist_${checklistId}` });
}

/** What the document says, from the checklist as it stands. `names` maps user ids to display names. */
export function checklistDocumentParams(checklist: Awaited<ReturnType<typeof readProjectChecklistDetail>>, names: Record<string, string> = {}) {
  const rows = checklist.items.map((item) => {
    const rating = item.item_type === "rating" ? RATINGS[item.rating] || "" : "";
    const who = names[item.completed_by_user_id] || "";
    return {
      name: item.title,
      details: [rating, item.note].filter(Boolean).join(" · "),
      checked: item.completed,
      done_by: item.completed ? [who, day(item.completed_at)].filter(Boolean).join(" · ") : ""
    };
  });
  const signature = checklist.crew_signature;
  const assignees = checklist.assigned_user_ids.map((id) => names[id]).filter(Boolean);
  return {
    title: checklist.title,
    list_date: new Date().toISOString().slice(0, 10),
    assignee: assignees.join(", "),
    rows,
    signature_required: checklist.signature_required,
    signer_name: checklist.signature_required ? text(signature?.signer_name) : "",
    signed_on: checklist.signature_required ? day(signature?.signed_at) : ""
  };
}

/** Writes the checklist's document, or brings it up to date. Returns the document. */
export async function generateChecklistDocument(orgId: string, projectId: string, checklistId: string, ctx: PlatformAuthContext, names: Record<string, string> = {}) {
  const checklist = await readProjectChecklistDetail(orgId, projectId, checklistId);
  const documentId = checklistDocumentId(checklist.id);
  const existing = await readDocumentInstance(orgId, documentId).catch(() => null);
  if (existing && obj(existing.metadata).source_system !== SOURCE_SYSTEM) throw badRequest("checklist_document_id_taken", "Another document already uses this checklist's id.");
  const project = await readDocument(orgId, "projects", projectId).catch(() => null);
  const { document } = await prepareTemplatedArtifact({
    orgId, documentId, documentType: "checklist", templateId: CHECKLIST_TEMPLATE_ID, projectId,
    branchId: text(obj(obj(project).data).branch_id) || text(ctx.branchId) || "default", actorUserId: text(ctx.userId) || undefined,
    title: `Checklist: ${checklist.title}`,
    params: checklistDocumentParams(checklist, names),
    metadata: {
      source_system: SOURCE_SYSTEM, source_checklist_id: checklist.id, source_project_id: projectId,
      source_checklist_revision: checklist.revision, generated_at: new Date().toISOString(), generated_by_user_id: text(ctx.userId)
    }
  });
  return document;
}
