import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { badRequest, forbidden } from "../platform/errors.js";
import type { JsonSchema, PublicationContext, TargetRef } from "../platform/publication/contracts.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { readPublishedData, registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { readMaterialList } from "../materials/storage.js";
import { completionItems, finalizeInputSchema, finalizeLaborList, listCompletions, reopenInputSchema, reopenLaborList, REOPEN_PERMISSION } from "../labor/completion.js";
import { closeInputSchema, closeoutChecks, closeProject, readCloseout, reopenCloseout, reopenCloseoutSchema } from "./closeout.js";

/**
 * Published completion and closeout. Seeing or finalizing completed work is project management (manage_projects);
 * reopening finalized work or a closed-out project needs `reopen_finalized_work`. Everything is project scoped and a
 * call aimed at one project only touches that project's lists.
 */
type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});
const actor = (ctx: PublicationContext) => (ctx.auth ? ctx.auth : { orgId: ctx.organizationId, userId: "", branchId: ctx.branchId, system: true });
const access = (permission: string) => ({ scopes: ["project"] as const, permissions: [permission], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] as const });
const str = { type: "string" }, strings = { type: "array", items: str }, cents = { type: ["integer", "null"] };
const historySchema = { type: "array", items: { type: "object", required: ["action", "at", "by_user_id"], properties: { action: { enum: ["finalized", "reopened", "closed"] }, at: str, by_user_id: str, reason: str, method: str, confirmed: { type: "integer" }, closeout_id: str }, additionalProperties: false } };
const completionSchema: JsonSchema = { type: "object", required: ["id", "commitment_id", "list_id", "project_id", "state", "method", "items", "finalized_at", "finalized_by_user_id", "history"], properties: {
  id: str, commitment_id: str, list_id: str, project_id: str, list_title: str, state: { enum: ["finalized", "reopened"] }, assignee: { type: "object" }, total_cents: { type: "integer" }, unpriced_lines: { type: "integer" }, commitment_revision: { type: "integer" },
  method: { enum: ["approve", "select_all", "each"] }, items: { type: "array", items: { type: "object", required: ["id", "name", "confirmed"], properties: { id: str, name: str, quantity: { type: "number" }, unit: str, total_cents: cents, confirmed: { type: "boolean" } }, additionalProperties: false } },
  confirmed_material_ids: strings, confirmed_requirement_ids: strings, evidence: { type: "object", properties: { media_ids: strings }, additionalProperties: false }, note: str, closeout_id: str,
  finalized_at: str, finalized_by_user_id: str, reopened_at: str, reopened_by_user_id: str, reopen_reason: str, history: historySchema, revision: { type: "integer" }
}, additionalProperties: false };
const itemSchema = { type: "object", required: ["id", "kind", "list_id", "list_title", "label", "detail", "total_cents", "done"], properties: { id: str, kind: { enum: ["line", "material", "requirement"] }, list_id: str, list_title: str, label: str, detail: str, total_cents: cents, done: { type: "boolean" } }, additionalProperties: false };
const rowSchema = { type: "object", required: ["id", "label", "detail", "status"], properties: { id: str, label: str, detail: str, status: { enum: ["ok", "warning", "info"] } }, additionalProperties: false };
const stepSchema = { type: "object", required: ["id", "title", "status", "summary", "rows", "sources", "missing"], properties: { id: str, title: str, status: { enum: ["ok", "warning", "unavailable"] }, summary: str, rows: { type: "array", items: rowSchema }, sources: strings, missing: strings }, additionalProperties: false };
const closeoutSchema = { type: "object", required: ["project_id", "state", "closed_at", "closed_by_user_id", "lists", "checks", "history"], properties: {
  project_id: str, state: { enum: ["closed", "reopened"] }, closed_at: str, closed_by_user_id: str, note: str,
  lists: { type: "array", items: { type: "object", properties: { list_id: str, commitment_id: str, title: str, total_cents: { type: "integer" } }, additionalProperties: false } },
  checks: { type: "array", items: { type: "object", properties: { id: str, status: str, summary: str }, additionalProperties: false } },
  reopened_at: str, reopened_by_user_id: str, reopen_reason: str, history: historySchema, revision: { type: "integer" }
}, additionalProperties: false };
const checksSchema = { type: "object", required: ["project_id", "steps", "closeout", "open_work_orders"], properties: { project_id: str, steps: { type: "array", items: stepSchema }, closeout: { anyOf: [closeoutSchema, { type: "null" }] }, open_work_orders: strings }, additionalProperties: false };
const json = (schema: Parameters<typeof zodToJsonSchema>[0]) => zodToJsonSchema(schema, { $refStrategy: "none" }) as JsonSchema;

async function sameProject(ctx: PublicationContext, target: TargetRef, listId: unknown) {
  const list = await readMaterialList(ctx.organizationId, String(listId || ""));
  if (String(list.project_id || "") !== target.projectId) throw forbidden("labor_target_mismatch", "This belongs to a different project.");
}
/** Photos named as reviewed must be project media the caller can read; screen-reported ids are never trusted as they are. */
async function reviewedMedia(ctx: PublicationContext, target: TargetRef, ids: unknown) {
  for (const id of Array.isArray(ids) ? ids : []) {
    const result = await readPublishedData(ctx, { provider: "media", export: "metadata", target: { ...target, id: String(id) } });
    if (result.status !== "ready") throw badRequest("labor_finalize_media_unknown", "A reviewed photo is not one of this project's photos.");
  }
}

let registered = false;
export function registerCloseoutPublication() {
  if (registered) return;
  registered = true;
  const revision = (value: unknown) => `sha256:${contentHash(value)}`;
  registerDataProvider({ id: "labor-completion", version: "1", apps: ["materials", "crew"], exports: {
    project: { description: "Work orders on this project whose work was confirmed as done and finalized to be paid: who confirmed it and when, how (one approval, checkboxes with Select all, or each line checked), every line and whether it was confirmed, the photos reviewed, and any reopening by a manager with its reason. A finalized list is locked; its commitment is what is paid.", schema: { type: "array", items: completionSchema }, schemaVersion: "1", access: access("manage_projects"),
      read: async (ctx, ref) => { const value = await listCompletions(ctx.organizationId, { project_id: ref.target.projectId! }); return { value, revision: revision(value.map((entry) => [entry.id, entry.revision])) }; } },
    items: { description: "What a person confirms to finish work on this project: each work order's line items, and optionally the material lines and requirement rows. Pass `list_id` for one work order, `materials` and `requirements` to include those. `done` is true for what is already finalized (labor) or delivered (material) or completed (requirements).", schema: { type: "object", required: ["project_id", "list_id", "items"], properties: { project_id: str, list_id: str, items: { type: "array", items: itemSchema } }, additionalProperties: false }, schemaVersion: "1", argsSchema: { type: "object", properties: { list_id: { type: "string", maxLength: 200 }, materials: { type: "boolean" }, requirements: { type: "boolean" } }, additionalProperties: false }, access: access("manage_projects"),
      read: async (ctx, ref) => { const value = await completionItems(ctx.organizationId, ref.target.projectId!, obj(ref.args) as { list_id?: string; materials?: boolean; requirements?: boolean }); return { value, revision: revision(value) }; } }
  } });
  registerDataProvider({ id: "project-closeout", version: "1", apps: ["materials", "financials"], exports: {
    checks: { description: "Everything checked before a project is closed out, read from other apps through the published data layer with the reader's own access: change orders signed, documents signed, payments received, every requirement accounted for, paid expenses with receipts, final expenses actual against planned, and work orders finalized to be paid. A step whose data is not published or not visible is `unavailable` and says why; `missing` names what is not published. Checks warn and never block. Also carries the closeout record, if any.", schema: checksSchema, schemaVersion: "1", access: access("manage_projects"),
      read: async (ctx, ref) => { const value = await closeoutChecks(ctx, ref.target.projectId!); return { value: JSON.parse(JSON.stringify(value)), revision: revision(value) }; } },
    record: { description: "The project's closeout: who closed it and when, the work orders finalized with it, how the checks stood, and every close and reopen.", schema: { anyOf: [closeoutSchema, { type: "null" }] }, schemaVersion: "1", access: access("manage_projects"),
      read: async (ctx, ref) => { const value = await readCloseout(ctx.organizationId, ref.target.projectId!); return { value, revision: revision(value) }; } }
  } });
  const policy = (permission: string) => ({ scopes: ["project"] as const, permissions: [permission], capabilities: ["platform.materials"], systemKinds: ["work", "module"] as const });
  registerAction({ id: "labor.list.finalize", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "confirm a work order's labor as done and mark it to be paid. Every line item must be confirmed (method approve confirms them all). The list is committed first if it changed since it was committed, without sending anything, then locked. Piece-rate pay is earned on the day it is finalized.", inputSchema: json(finalizeInputSchema), outputSchema: completionSchema, policy: policy("manage_projects"), effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required",
    execute: async (ctx, target, input) => { await sameProject(ctx, target, input.list_id); await reviewedMedia(ctx, target, input.evidence_media_ids); return finalizeLaborList(ctx.organizationId, input, actor(ctx)); } });
  registerAction({ id: "labor.list.reopen", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "take back finalized work so the work order can change again. Recorded with who, when and the reason; pay earned on it is reversed at the next pay refresh.", inputSchema: json(reopenInputSchema), outputSchema: completionSchema, policy: policy(REOPEN_PERMISSION), effect: "write", executionKinds: ["api", "agent"], idempotency: "required",
    execute: async (ctx, target, input) => { await sameProject(ctx, target, input.list_id); return reopenLaborList(ctx.organizationId, input, actor(ctx)); } });
  registerAction({ id: "project-closeout.close", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "close out a project: finalize the remaining work orders (each confirmed line by line or approved) and record its finances as finished, with who and when. The checks in project-closeout.checks warn and do not stop this; every work order must end up finalized.", inputSchema: json(closeInputSchema), outputSchema: closeoutSchema, policy: policy("manage_projects"), effect: "write", executionKinds: ["api", "agent"], idempotency: "required",
    execute: async (ctx, target, input) => { for (const entry of Array.isArray(input.finalize) ? input.finalize : []) await reviewedMedia(ctx, target, obj(entry).evidence_media_ids); return closeProject(ctx, target.projectId!, input); } });
  registerAction({ id: "project-closeout.reopen", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "reopen a closed-out project's finances, with a reason. The work orders stay finalized; reopen each one separately if it must change.", inputSchema: json(reopenCloseoutSchema), outputSchema: closeoutSchema, policy: policy(REOPEN_PERMISSION), effect: "write", executionKinds: ["api", "agent"], idempotency: "required",
    execute: (ctx, target, input) => reopenCloseout(ctx, target.projectId!, input) });
}
