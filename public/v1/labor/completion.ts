import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, PlatformError } from "../platform/errors.js";
import { listDocuments, upsertDocument, type JsonObject } from "../platform/storage.js";
import { listProjectMaterialLists, readMaterialList, recordMaterialEvent } from "../materials/storage.js";
import { registerWorkEvents } from "../work/events.js";
import { requireActor, type Actor } from "./assignees.js";
import { commitLaborList, laborLinesOf, listCommitments, type Commitment } from "./commitments.js";

/**
 * Completion: a labor list whose work is done, confirmed and to be paid.
 *
 * A commitment says what was handed to an assignee and for what pay. Finalizing says the work on it was done: a person
 * confirmed its lines (by one approval, or line by line), optionally with the photos they reviewed, and from then on
 * the list is locked like an ordered material list and its commitment is what gets paid. Piece-rate pay is earned on
 * the day it was finalized (the `labor_commitments` pay source carries `finalized_at`).
 *
 * Finalized is not released. Releasing a commitment means the work was taken back; finalizing means it was finished.
 * A finalized commitment cannot be released, its list cannot be committed or generated again, and only a person with
 * `reopen_finalized_work` can reopen it, which is recorded with who, when and why. A completion is its own record
 * keyed by its commitment: commitments are never edited.
 */
export const COMPLETION_COLLECTION = "labor_completions";
/** Taking back finalized work, or reopening a closed-out project's finances. Finalizing itself needs manage_projects. */
export const REOPEN_PERMISSION = "reopen_finalized_work";
export const COMPLETION_METHODS = ["approve", "select_all", "each"] as const;
export type CompletionMethod = typeof COMPLETION_METHODS[number];

registerWorkEvents([
  { name: "labor.list.finalized", notification: { group: "materials", source: "materials", tab: "general" }, description: "A labor list's work was confirmed as done and marked to be paid.", visibility: "activity" },
  { name: "labor.list.reopened", notification: { group: "materials", source: "materials", tab: "general" }, description: "A labor list that was finalized to be paid was reopened by a manager.", visibility: "activity" }
]);

const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const ids = (max: number) => z.array(z.string().trim().min(1).max(240)).max(max);
export const finalizeInputSchema = z.object({
  list_id: id,
  /** How the person confirmed: one approval of everything, checkboxes with Select all, or each line checked by itself. */
  method: z.enum(COMPLETION_METHODS).default("select_all"),
  /** The list's line ids the person confirmed. Every line must be confirmed. With `approve` it may be left out. */
  confirmed_item_ids: ids(500).optional(),
  /** Material lines and requirement rows the person also confirmed, when they were shown. Recorded, never required. */
  confirmed_material_ids: ids(500).optional(),
  confirmed_requirement_ids: ids(500).optional(),
  /** Project photos the person reviewed. */
  evidence_media_ids: ids(50).optional(),
  note: z.string().trim().max(2000).optional()
}).strict();
export const reopenInputSchema = z.object({ list_id: id, reason: z.string().trim().min(3).max(1000) }).strict();

export type CompletionEntry = { action: "finalized" | "reopened"; at: string; by_user_id: string; reason?: string; method?: CompletionMethod; confirmed?: number; closeout_id?: string };
export type Completion = {
  id: string; commitment_id: string; list_id: string; project_id: string; list_title: string;
  /** finalized: done and to be paid. reopened: a manager took it back; the list can be edited and committed again. */
  state: "finalized" | "reopened";
  assignee: Commitment["assignee"]; total_cents: number; unpriced_lines: number; commitment_revision: number;
  method: CompletionMethod;
  /** Every line of the commitment, and whether the person confirmed it. A finalized list has all of them confirmed. */
  items: { id: string; name: string; quantity: number; unit: string; total_cents: number | null; confirmed: boolean }[];
  confirmed_material_ids: string[]; confirmed_requirement_ids: string[];
  evidence: { media_ids: string[] };
  note: string; closeout_id: string;
  finalized_at: string; finalized_by_user_id: string;
  reopened_at?: string; reopened_by_user_id?: string; reopen_reason?: string;
  /** Every finalize and reopen, oldest first. Never shortened. */
  history: CompletionEntry[];
  revision: number;
};

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const view = (document: { id: string; revision?: number; data: JsonObject }): Completion => ({ ...(document.data as unknown as Completion), id: document.id, revision: Number(document.revision || 0) });

export async function listCompletions(orgId: string, filter: { project_id?: string; list_id?: string } = {}): Promise<Completion[]> {
  return (await listDocuments(orgId, COMPLETION_COLLECTION)).map(view)
    .filter((entry) => (!filter.project_id || entry.project_id === filter.project_id) && (!filter.list_id || entry.list_id === filter.list_id))
    .sort((a, b) => a.finalized_at.localeCompare(b.finalized_at) || a.id.localeCompare(b.id));
}
/** Commitments whose work is finalized to be paid. */
export async function finalizedCommitmentIds(orgId: string) {
  return new Set((await listCompletions(orgId)).filter((entry) => entry.state === "finalized").map((entry) => entry.commitment_id));
}
/** The finalized completion holding a list, or null when the list is open. */
export async function finalizedCompletionFor(orgId: string, listId: string) {
  return (await listCompletions(orgId, { list_id: listId })).find((entry) => entry.state === "finalized") || null;
}
/**
 * Refuses a change to a list whose work is finalized to be paid. Every labor-list writer that can change what is paid
 * (commit, generate) calls this; the material list store should call it before editing a labor list's lines too.
 */
export async function assertLaborListOpen(orgId: string, listId: string) {
  const held = await finalizedCompletionFor(orgId, listId);
  if (held) throw conflict("labor_list_finalized", `This work order was finalized to be paid on ${held.finalized_at.slice(0, 10)}. A manager has to reopen it before it can change.`);
}

async function emit(orgId: string, branchId: string, completion: Completion, name: string) {
  const { emitWorkEvent } = await import("../work/engine.js");
  await emitWorkEvent({ organization_id: orgId, branch_id: branchId || "default", project_id: completion.project_id, type: name, idempotency_key: `${name}:${completion.id}:${completion.history.length}`, payload: { list_id: completion.list_id, commitment_id: completion.commitment_id, assignee: completion.assignee, total_cents: completion.total_cents, state: completion.state } });
}
async function write(orgId: string, completion: Completion, expected?: number) {
  const { id: completionId, revision: _revision, ...data } = completion;
  const document = await upsertDocument(orgId, COMPLETION_COLLECTION, { id: completionId, ...(expected === undefined ? {} : expected ? { expected_revision: expected } : {}), data: data as unknown as JsonObject, metadata: { kind: "labor_completion", list_id: completion.list_id, project_id: completion.project_id, commitment_id: completion.commitment_id, state: completion.state } }, { replace: true, ...(expected === 0 ? { createOnly: true } : {}) });
  return { ...completion, revision: Number((document as { revision?: number }).revision || 0) };
}

/**
 * Confirms a labor list's work as done and marks it to be paid. The list as it stands is what is paid: if it has no
 * current commitment, or changed since it was committed, it is committed first (nothing is sent, the work is done).
 * Every line must be confirmed. Finalizing a list that is already finalized returns what is recorded.
 */
export async function finalizeLaborList(orgId: string, input: unknown, actor: Actor, options: { closeoutId?: string } = {}): Promise<Completion> {
  requireActor(orgId, actor, "manage_projects", "labor_finalize_denied", "Finalizing work for payment requires project management access.");
  const parsed = finalizeInputSchema.parse(input);
  const held = await finalizedCompletionFor(orgId, parsed.list_id);
  if (held) return held;
  const list = await readMaterialList(orgId, parsed.list_id);
  if (text(list.resource_type) !== "labor") throw badRequest("labor_finalize_not_labor", "Only a work order's labor list is finalized to be paid.");
  if (text(list.status) === "archived") throw badRequest("labor_finalize_archived", "This list is archived.");
  const lines = laborLinesOf((Array.isArray(list.current_items) ? list.current_items : []).map(obj));
  if (!lines.length) throw badRequest("labor_finalize_empty", "There is nothing on this list to finalize.");
  const known = new Set(lines.map((line) => line.id));
  const confirmed = new Set(parsed.method === "approve" && !parsed.confirmed_item_ids ? [...known] : parsed.confirmed_item_ids || []);
  const unknown = [...confirmed].filter((entry) => !known.has(entry));
  if (unknown.length) throw badRequest("labor_finalize_unknown_items", "Some confirmed line items are not on this list. Reload it and confirm again.");
  const missing = lines.filter((line) => !confirmed.has(line.id));
  if (missing.length) throw badRequest("labor_finalize_unconfirmed", `Confirm every line item before finalizing: ${missing.slice(0, 3).map((line) => `"${line.name}"`).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""} ${missing.length === 1 ? "is" : "are"} not confirmed.`);
  // What is paid is a frozen commitment of the list as it is now. An unchanged list keeps the commitment it has.
  const commitment = await commitLaborList(orgId, { list_id: parsed.list_id }, actor, undefined, { deliver: false });
  if (commitment.lines.map((line) => line.id).join("|") !== lines.map((line) => line.id).join("|")) throw conflict("labor_finalize_changed", "This list changed while it was being finalized. Reload it and confirm again.");
  const now = new Date().toISOString(), previous = (await listCompletions(orgId, { list_id: parsed.list_id })).find((entry) => entry.commitment_id === commitment.id) || null;
  const draft: Completion = {
    id: `lf_${commitment.id}`, commitment_id: commitment.id, list_id: parsed.list_id, project_id: text(list.project_id), list_title: text(list.title) || "Labor",
    state: "finalized", assignee: commitment.assignee, total_cents: commitment.total_cents, unpriced_lines: commitment.unpriced_lines, commitment_revision: commitment.revision,
    method: parsed.method, items: commitment.lines.map((line) => ({ id: line.id, name: line.name, quantity: line.quantity, unit: line.unit, total_cents: line.total_cents, confirmed: true })),
    confirmed_material_ids: [...new Set(parsed.confirmed_material_ids || [])], confirmed_requirement_ids: [...new Set(parsed.confirmed_requirement_ids || [])],
    evidence: { media_ids: [...new Set(parsed.evidence_media_ids || [])] }, note: parsed.note || "", closeout_id: options.closeoutId || "",
    finalized_at: now, finalized_by_user_id: text(actor.userId), history: [...(previous?.history || []), { action: "finalized", at: now, by_user_id: text(actor.userId), method: parsed.method, confirmed: confirmed.size, ...(options.closeoutId ? { closeout_id: options.closeoutId } : {}) }],
    revision: 0
  };
  let saved: Completion;
  try { saved = await write(orgId, draft, previous ? previous.revision : 0); }
  catch (error) {
    if (error instanceof PlatformError && error.statusCode === 409) { const won = await finalizedCompletionFor(orgId, parsed.list_id); if (won) return won; throw conflict("labor_finalize_conflict", "Someone else changed this work order just now. Reload and try again."); }
    throw error;
  }
  await recordMaterialEvent(orgId, parsed.list_id, "labor_completion.finalized", { commitment_id: commitment.id, method: parsed.method, confirmed: confirmed.size, evidence: draft.evidence.media_ids.length }, actor.system ? null : actor as PlatformAuthContext).catch(() => null);
  await emit(orgId, text(actor.branchId) || text(list.branch_id), saved, "labor.list.finalized").catch(() => null);
  return saved;
}

/** A manager takes finalized work back: the list can be changed and committed again, and pay earned on it is reversed at the next refresh. */
export async function reopenLaborList(orgId: string, input: unknown, actor: Actor): Promise<Completion> {
  requireActor(orgId, actor, REOPEN_PERMISSION, "labor_reopen_denied", "Only a manager who may reopen finalized work can do this.");
  const parsed = reopenInputSchema.parse(input);
  const held = await finalizedCompletionFor(orgId, parsed.list_id);
  if (!held) throw badRequest("labor_reopen_not_finalized", "This work order is not finalized.");
  const { readCloseout } = await import("../closeout/closeout.js");
  if ((await readCloseout(orgId, held.project_id))?.state === "closed") throw conflict("labor_reopen_closed_out", "This project is closed out. Reopen the closeout first.");
  const now = new Date().toISOString();
  const saved = await write(orgId, { ...held, state: "reopened", reopened_at: now, reopened_by_user_id: text(actor.userId), reopen_reason: parsed.reason, history: [...held.history, { action: "reopened", at: now, by_user_id: text(actor.userId), reason: parsed.reason }] }, held.revision);
  await recordMaterialEvent(orgId, parsed.list_id, "labor_completion.reopened", { commitment_id: held.commitment_id, reason: parsed.reason }, actor.system ? null : actor as PlatformAuthContext).catch(() => null);
  await emit(orgId, text(actor.branchId), saved, "labor.list.reopened").catch(() => null);
  return saved;
}

export type CompletionItem = { id: string; kind: "line" | "material" | "requirement"; list_id: string; list_title: string; label: string; detail: string; total_cents: number | null; done: boolean };
const money = (cents: number | null) => (cents == null ? "" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const amount = (quantity: number, unit: string) => (quantity ? `${Math.round(quantity * 100) / 100} ${unit}`.trim() : "");
/**
 * What a person confirms to finish work: a labor list's line items, and, when asked, the project's material lines and
 * requirement rows. Reads only. `done` says a line is already part of finalized work.
 */
export async function completionItems(orgId: string, projectId: string, args: { list_id?: string; materials?: boolean; requirements?: boolean } = {}) {
  const lists = (await listProjectMaterialLists(orgId, projectId)).filter((list) => text(list.status) !== "archived");
  const finalized = new Map((await listCompletions(orgId, { project_id: projectId })).filter((entry) => entry.state === "finalized").map((entry) => [entry.list_id, entry]));
  const items: CompletionItem[] = [];
  for (const list of lists.filter((entry) => text(entry.resource_type) === "labor" && (!args.list_id || text(entry.id) === args.list_id))) {
    const title = text(obj(obj(list.assignment).work_resource_ref).name) || text(list.title) || "Work order";
    for (const line of laborLinesOf((Array.isArray(list.current_items) ? list.current_items : []).map(obj))) items.push({ id: line.id, kind: "line", list_id: text(list.id), list_title: title, label: line.name || "Untitled", detail: [amount(line.quantity, line.unit), money(line.total_cents)].filter(Boolean).join(" · "), total_cents: line.total_cents, done: finalized.has(text(list.id)) });
  }
  if (args.materials) for (const list of lists.filter((entry) => !text(entry.resource_type) || text(entry.resource_type) === "material")) {
    const delivered = ["delivered"].includes(text(list.status)) || text(list.delivery_status) === "delivered";
    for (const item of (Array.isArray(list.current_items) ? list.current_items : []).map(obj)) items.push({ id: `${text(list.id)}:${text(item.id)}`, kind: "material", list_id: text(list.id), list_title: text(list.title) || "Materials", label: text(item.name) || "Material", detail: amount(Number(item.quantity) || 0, text(item.unit)), total_cents: null, done: delivered });
  }
  if (args.requirements) {
    const { projectRequirements } = await import("./requirements.js");
    const set = await projectRequirements(orgId, projectId, {});
    for (const row of set.requirements) items.push({ id: row.id, kind: "requirement", list_id: "", list_title: "Requirements", label: row.label, detail: row.status === "open" ? "Not accounted for" : row.progress === "completed" ? "Completed" : row.progress === "scheduled" ? "Scheduled" : "Accounted for", total_cents: null, done: row.progress === "completed" });
  }
  return { project_id: projectId, list_id: args.list_id || "", items };
}
