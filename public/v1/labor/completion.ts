import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, PlatformError } from "../platform/errors.js";
import { listDocuments, upsertDocument, type JsonObject } from "../platform/storage.js";
import { contentHash } from "../platform/publication/validation.js";
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
  note: z.string().trim().max(2000).optional(),
  /**
   * Pay out only the confirmed lines now and the rest later. Each payout is its own completion; the lines it pays are
   * locked and the others stay open. Without it every line not yet paid must be confirmed.
   */
  partial: z.boolean().optional()
}).strict();
/** Reopens every payout of the list, or with `completion_id` that one payout. */
export const reopenInputSchema = z.object({ list_id: id, reason: z.string().trim().min(3).max(1000), completion_id: id.optional() }).strict();

export type CompletionEntry = { action: "finalized" | "reopened"; at: string; by_user_id: string; reason?: string; method?: CompletionMethod; confirmed?: number; closeout_id?: string };
export type Completion = {
  id: string; commitment_id: string; list_id: string; project_id: string; list_title: string;
  /** finalized: done and to be paid. reopened: a manager took it back; the list can be edited and committed again. */
  state: "finalized" | "reopened";
  assignee: Commitment["assignee"]; total_cents: number; unpriced_lines: number; commitment_revision: number;
  method: CompletionMethod;
  /**
   * Every line of the commitment, and whether this payout pays it (`confirmed`). A line an earlier payout paid says
   * so (`paid_earlier`). A whole-list payout has every line confirmed.
   */
  items: { id: string; name: string; quantity: number; unit: string; total_cents: number | null; confirmed: boolean; paid_earlier?: boolean }[];
  /** `list`: the whole work order in one payout (its `finalized_at` is the list's). `lines`: some of its lines now, the rest in other payouts. */
  scope: "list" | "lines";
  /** The lines this payout pays, and nothing else. They are locked while it is finalized. */
  line_ids: string[];
  /** After this payout every line of the work order was paid out. */
  fully_paid: boolean;
  /** The row id this payout earns under in the `labor_commitments` pay source: the commitment for a whole list, else this completion. */
  pay_unit: string;
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
const view = (document: { id: string; revision?: number; data: JsonObject }): Completion => {
  const data = document.data as unknown as Completion;
  const items = Array.isArray(data.items) ? data.items : [];
  // A record from before payouts could be partial is a whole-list payout.
  return { ...data, id: document.id, revision: Number(document.revision || 0), scope: data.scope || "list", line_ids: Array.isArray(data.line_ids) ? data.line_ids : items.filter((item) => item.confirmed !== false).map((item) => item.id), fully_paid: data.fully_paid ?? true, pay_unit: data.pay_unit || data.commitment_id };
};

export async function listCompletions(orgId: string, filter: { project_id?: string; list_id?: string } = {}): Promise<Completion[]> {
  return (await listDocuments(orgId, COMPLETION_COLLECTION)).map(view)
    .filter((entry) => (!filter.project_id || entry.project_id === filter.project_id) && (!filter.list_id || entry.list_id === filter.list_id))
    .sort((a, b) => a.finalized_at.localeCompare(b.finalized_at) || a.id.localeCompare(b.id));
}
/** Commitments whose work is all paid out: the last payout of their list paid every line. */
export async function finalizedCommitmentIds(orgId: string) {
  return new Set((await listCompletions(orgId)).filter((entry) => entry.state === "finalized" && entry.fully_paid).map((entry) => entry.commitment_id));
}
export type ListPayState = { state: "open" | "part" | "paid"; lines: ReturnType<typeof laborLinesOf>; payouts: Completion[]; paid: Map<string, Completion>; paid_cents: number; last: Completion | null };
/**
 * How far a work order is paid out: `open` (nothing yet), `part` (some lines, by one or more payouts) or `paid` (every
 * line it has now). `paid` maps each paid line to the payout that paid it. Reads only.
 */
export async function listPayState(orgId: string, list: JsonObject, completions?: Completion[]): Promise<ListPayState> {
  const listId = text(list.id);
  const payouts = (completions || await listCompletions(orgId, { list_id: listId })).filter((entry) => entry.list_id === listId && entry.state === "finalized");
  const lines = laborLinesOf((Array.isArray(list.current_items) ? list.current_items : []).map(obj));
  const paid = new Map<string, Completion>();
  for (const payout of payouts) for (const line of payout.line_ids) paid.set(line, payout);
  const state = !payouts.length ? "open" : lines.length && lines.every((line) => paid.has(line.id)) ? "paid" : "part";
  return { state, lines, payouts, paid, paid_cents: payouts.reduce((sum, entry) => sum + entry.total_cents, 0), last: payouts[payouts.length - 1] || null };
}
/** The last payout of a work order that is paid out in full, or null while any of its lines is still open. */
export async function finalizedCompletionFor(orgId: string, listId: string) {
  const payouts = (await listCompletions(orgId, { list_id: listId })).filter((entry) => entry.state === "finalized");
  if (!payouts.length) return null;
  const list = await readMaterialList(orgId, listId).catch(() => null);
  if (!list) return payouts[payouts.length - 1]!;
  const pay = await listPayState(orgId, list, payouts);
  return pay.state === "paid" ? pay.last : null;
}
const sameLine = (a: ReturnType<typeof laborLinesOf>[number], b: ReturnType<typeof laborLinesOf>[number]) => a.name === b.name && a.quantity === b.quantity && a.unit === b.unit && a.rate === b.rate && a.total_cents === b.total_cents;
/**
 * Refuses a change to what is paid out. A work order paid out in full is locked as a whole. One paid out in part keeps
 * its paid lines exactly as they are (`items`, the lines it would have after the change, are checked), cannot change
 * assignee, and cannot be archived or generated again (`strict`); its other lines stay open. Every labor-list writer
 * calls this: commit, generate, and the material list store before a new version or a patch.
 */
export async function assertLaborListOpen(orgId: string, listId: string, options: { items?: unknown[]; strict?: boolean; assignment?: unknown } = {}) {
  const payouts = (await listCompletions(orgId, { list_id: listId })).filter((entry) => entry.state === "finalized");
  if (!payouts.length) return;
  const list = await readMaterialList(orgId, listId);
  const pay = await listPayState(orgId, list, payouts);
  if (pay.state === "paid") throw conflict("labor_list_finalized", `This work order was finalized to be paid on ${pay.last!.finalized_at.slice(0, 10)}. A manager has to reopen it before it can change.`);
  if (pay.state !== "part") return;
  if (options.strict) throw conflict("labor_list_partly_paid", "Some lines of this work order are already paid out. A manager has to reopen them before it can be generated again or archived.");
  if (options.assignment !== undefined) {
    const before = obj(obj(list.assignment).work_resource_ref), after = obj(obj(options.assignment).work_resource_ref);
    if (Object.keys(after).length && (text(after.id) !== text(before.id) || text(after.kind) !== text(before.kind))) throw conflict("labor_list_partly_paid", "Some lines of this work order are already paid out to its assignee, so it cannot be given to someone else. Put the rest on a new work order.");
  }
  if (!options.items) return;
  const next = new Map(laborLinesOf(options.items.map(obj)).map((line) => [line.id, line]));
  for (const line of pay.lines.filter((entry) => pay.paid.has(entry.id))) {
    const after = next.get(line.id);
    if (!after || !sameLine(line, after)) throw conflict("labor_line_paid", `"${line.name || "A line"}" was paid out on ${pay.paid.get(line.id)!.finalized_at.slice(0, 10)} and cannot change. A manager has to reopen that payout first.`);
  }
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
 * Confirms work as done and pays it out. The list as it stands is what is paid: if it has no current commitment, or
 * changed since it was committed, it is committed first (nothing is sent, the work is done). Every line not yet paid
 * must be confirmed, unless `partial`, which pays out only the confirmed lines now and leaves the rest open. Each
 * payout is its own completion with its own `finalized_at`. Paying out a list that is already paid in full returns
 * its last payout.
 */
export async function finalizeLaborList(orgId: string, input: unknown, actor: Actor, options: { closeoutId?: string } = {}): Promise<Completion> {
  requireActor(orgId, actor, "manage_projects", "labor_finalize_denied", "Finalizing work for payment requires project management access.");
  const parsed = finalizeInputSchema.parse(input);
  const list = await readMaterialList(orgId, parsed.list_id);
  if (text(list.resource_type) !== "labor") throw badRequest("labor_finalize_not_labor", "Only a work order's labor list is finalized to be paid.");
  const before = await listPayState(orgId, list);
  if (before.state === "paid") return before.last!;
  if (text(list.status) === "archived") throw badRequest("labor_finalize_archived", "This list is archived.");
  const lines = before.lines;
  if (!lines.length) throw badRequest("labor_finalize_empty", "There is nothing on this list to finalize.");
  const known = new Set(lines.map((line) => line.id));
  const open = lines.filter((line) => !before.paid.has(line.id));
  const confirmed = new Set(parsed.method === "approve" && !parsed.confirmed_item_ids ? open.map((line) => line.id) : parsed.confirmed_item_ids || []);
  const unknown = [...confirmed].filter((entry) => !known.has(entry));
  if (unknown.length) throw badRequest("labor_finalize_unknown_items", "Some confirmed line items are not on this list. Reload it and confirm again.");
  const again = lines.filter((line) => confirmed.has(line.id) && before.paid.has(line.id));
  if (again.length) throw badRequest("labor_finalize_already_paid", `${again.slice(0, 3).map((line) => `"${line.name}"`).join(", ")} ${again.length === 1 ? "is" : "are"} already paid out.`);
  const missing = open.filter((line) => !confirmed.has(line.id));
  if (!confirmed.size) throw badRequest("labor_finalize_unconfirmed", "Confirm at least one line item to pay out.");
  if (missing.length && !parsed.partial) throw badRequest("labor_finalize_unconfirmed", `Confirm every line item before finalizing: ${missing.slice(0, 3).map((line) => `"${line.name}"`).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""} ${missing.length === 1 ? "is" : "are"} not confirmed.`);
  // What is paid is a frozen commitment of the list as it is now. An unchanged list keeps the commitment it has.
  const commitment = await commitLaborList(orgId, { list_id: parsed.list_id }, actor, undefined, { deliver: false });
  if (commitment.lines.map((line) => line.id).join("|") !== lines.map((line) => line.id).join("|")) throw conflict("labor_finalize_changed", "This list changed while it was being finalized. Reload it and confirm again.");
  const payNow = commitment.lines.filter((line) => confirmed.has(line.id));
  const fully = !missing.length;
  // The whole work order in one payout keeps the one-record-per-commitment shape whole lists always had.
  const scope: Completion["scope"] = before.state === "open" && fully ? "list" : "lines";
  const completionId = scope === "list" ? `lf_${commitment.id}` : `lp_${commitment.id}_${contentHash(payNow.map((line) => line.id).sort()).slice(0, 12)}`;
  const now = new Date().toISOString(), previous = (await listCompletions(orgId, { list_id: parsed.list_id })).find((entry) => entry.id === completionId) || null;
  const draft: Completion = {
    id: completionId, commitment_id: commitment.id, list_id: parsed.list_id, project_id: text(list.project_id), list_title: text(list.title) || "Labor",
    state: "finalized", assignee: commitment.assignee, total_cents: payNow.reduce((sum, line) => sum + (line.total_cents || 0), 0), unpriced_lines: payNow.filter((line) => line.total_cents == null).length, commitment_revision: commitment.revision,
    method: parsed.method, items: commitment.lines.map((line) => ({ id: line.id, name: line.name, quantity: line.quantity, unit: line.unit, total_cents: line.total_cents, confirmed: confirmed.has(line.id), ...(before.paid.has(line.id) ? { paid_earlier: true } : {}) })),
    scope, line_ids: payNow.map((line) => line.id), fully_paid: fully, pay_unit: scope === "list" ? commitment.id : completionId,
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
  await recordMaterialEvent(orgId, parsed.list_id, "labor_completion.finalized", { commitment_id: commitment.id, completion_id: saved.id, scope, method: parsed.method, confirmed: confirmed.size, evidence: draft.evidence.media_ids.length }, actor.system ? null : actor as PlatformAuthContext).catch(() => null);
  await emit(orgId, text(actor.branchId) || text(list.branch_id), saved, "labor.list.finalized").catch(() => null);
  return saved;
}

/**
 * A manager takes paid-out work back: every payout of the list, or one (`completion_id`). Its lines can change and be
 * paid out again, and pay earned on them is reversed at the next refresh.
 */
export async function reopenLaborList(orgId: string, input: unknown, actor: Actor): Promise<Completion> {
  requireActor(orgId, actor, REOPEN_PERMISSION, "labor_reopen_denied", "Only a manager who may reopen finalized work can do this.");
  const parsed = reopenInputSchema.parse(input);
  const payouts = (await listCompletions(orgId, { list_id: parsed.list_id })).filter((entry) => entry.state === "finalized" && (!parsed.completion_id || entry.id === parsed.completion_id));
  if (!payouts.length) throw badRequest("labor_reopen_not_finalized", parsed.completion_id ? "That payout is not finalized on this work order." : "This work order is not finalized.");
  const { readCloseout } = await import("../closeout/closeout.js");
  if ((await readCloseout(orgId, payouts[0]!.project_id))?.state === "closed") throw conflict("labor_reopen_closed_out", "This project is closed out. Reopen the closeout first.");
  const now = new Date().toISOString();
  let saved = payouts[0]!;
  for (const held of payouts) {
    saved = await write(orgId, { ...held, state: "reopened", reopened_at: now, reopened_by_user_id: text(actor.userId), reopen_reason: parsed.reason, history: [...held.history, { action: "reopened", at: now, by_user_id: text(actor.userId), reason: parsed.reason }] }, held.revision);
    await recordMaterialEvent(orgId, parsed.list_id, "labor_completion.reopened", { commitment_id: held.commitment_id, completion_id: held.id, reason: parsed.reason }, actor.system ? null : actor as PlatformAuthContext).catch(() => null);
    await emit(orgId, text(actor.branchId), saved, "labor.list.reopened").catch(() => null);
  }
  return saved;
}

/**
 * The rows of the `labor_commitments` pay source (payroll/pay-sources.ts), one for each commitment and one for each
 * payout of part of a list. A commitment paid out whole carries that payout's `finalized_at`, as it always has. A
 * payout of some lines is its own row (`id` its `pay_unit`, `commitment_id`, `payout_id`), with the total of the lines
 * it paid and its own `finalized_at`, so a rule that earns on `finalized_at` earns each payout when it is made. Its
 * commitment's row then carries only what is still unpaid and no `finalized_at`. Reads only.
 */
export async function laborPayRows(orgId: string, commitments: Commitment[]): Promise<JsonObject[]> {
  const finalized = (await listCompletions(orgId)).filter((entry) => entry.state === "finalized");
  const paidByList = new Map<string, Set<string>>();
  for (const entry of finalized) { const set = paidByList.get(entry.list_id) || new Set<string>(); entry.line_ids.forEach((line) => set.add(line)); paidByList.set(entry.list_id, set); }
  const rows: JsonObject[] = [];
  for (const entry of commitments) {
    const own = finalized.filter((payout) => payout.commitment_id === entry.id);
    const whole = own.find((payout) => payout.scope === "list") || null, parts = own.filter((payout) => payout.scope === "lines");
    const base = { id: entry.id, assignee_key: `${entry.assignee.type}:${entry.assignee.id}`, assignee_name: entry.assignee.name, unit_id: entry.unit?.id || "", project_id: entry.project_id, list_id: entry.list_id };
    // A list paid out in parts keeps on its commitment only what nobody has been paid for yet.
    const paid = whole ? null : paidByList.get(entry.list_id);
    const unpaid = paid ? entry.lines.filter((line) => !paid.has(line.id)) : null;
    rows.push({
      ...base, status: entry.status,
      total_cents: unpaid ? unpaid.reduce((sum, line) => sum + (line.total_cents || 0), 0) : entry.total_cents, unpriced_lines: unpaid ? unpaid.filter((line) => line.total_cents == null).length : entry.unpriced_lines,
      committed_at: entry.committed_at, released_at: entry.released_at || "", release_reason: entry.release_reason || "",
      // Finished and confirmed to be paid (labor/completion.ts). Empty until then, and again if a manager reopens it.
      finalized_at: whole?.finalized_at || "", finalized_by_user_id: whole?.finalized_by_user_id || "", completion_method: whole?.method || ""
    });
    // Paid-out work stays paid when the list is committed again later, so a payout's row is never superseded.
    for (const payout of parts) rows.push({ ...base, id: payout.pay_unit, commitment_id: entry.id, payout_id: payout.id, status: "committed", total_cents: payout.total_cents, unpriced_lines: payout.unpriced_lines, committed_at: entry.committed_at, released_at: "", release_reason: "", finalized_at: payout.finalized_at, finalized_by_user_id: payout.finalized_by_user_id, completion_method: payout.method });
  }
  return rows;
}
/**
 * What of a commitment is not paid out yet: its lines no payout of its list has paid. Projected pay counts only this,
 * so work paid out in part is not projected again. Reads only.
 */
export async function unpaidShares(orgId: string) {
  const paidByList = new Map<string, Set<string>>();
  for (const entry of (await listCompletions(orgId)).filter((row) => row.state === "finalized")) { const set = paidByList.get(entry.list_id) || new Set<string>(); entry.line_ids.forEach((line) => set.add(line)); paidByList.set(entry.list_id, set); }
  return (entry: Pick<Commitment, "list_id" | "lines" | "total_cents" | "unpriced_lines">) => {
    const paid = paidByList.get(entry.list_id);
    if (!paid?.size) return { total_cents: entry.total_cents, unpriced_lines: entry.unpriced_lines };
    const unpaid = entry.lines.filter((line) => !paid.has(line.id));
    return { total_cents: unpaid.reduce((sum, line) => sum + (line.total_cents || 0), 0), unpriced_lines: unpaid.filter((line) => line.total_cents == null).length };
  };
}

export type CompletionItem = { id: string; kind: "line" | "material" | "requirement"; list_id: string; list_title: string; label: string; detail: string; total_cents: number | null; done: boolean; paid_at?: string };
const money = (cents: number | null) => (cents == null ? "" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const amount = (quantity: number, unit: string) => (quantity ? `${Math.round(quantity * 100) / 100} ${unit}`.trim() : "");
/**
 * What a person confirms to finish work: a labor list's line items, and, when asked, the project's material lines and
 * requirement rows. Reads only. `done` says a line is already paid out (`paid_at` says when), whether its whole list
 * was or only that line.
 */
export async function completionItems(orgId: string, projectId: string, args: { list_id?: string; materials?: boolean; requirements?: boolean } = {}) {
  const lists = (await listProjectMaterialLists(orgId, projectId)).filter((list) => text(list.status) !== "archived");
  const completions = await listCompletions(orgId, { project_id: projectId });
  const items: CompletionItem[] = [];
  for (const list of lists.filter((entry) => text(entry.resource_type) === "labor" && (!args.list_id || text(entry.id) === args.list_id))) {
    const title = text(obj(obj(list.assignment).work_resource_ref).name) || text(list.title) || "Work order";
    const pay = await listPayState(orgId, list, completions);
    for (const line of pay.lines) { const paid = pay.paid.get(line.id); items.push({ id: line.id, kind: "line", list_id: text(list.id), list_title: title, label: line.name || "Untitled", detail: [amount(line.quantity, line.unit), money(line.total_cents)].filter(Boolean).join(" · "), total_cents: line.total_cents, done: !!paid, ...(paid ? { paid_at: paid.finalized_at } : {}) }); }
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

// ---- How work is confirmed, for the whole organization ----
/**
 * Which of the three completion methods Pay out and Closeout use: one approval (`approve`), checkboxes with Select all
 * (`select_all`, the default) or each line checked on its own (`each`). Kept on the organization's default branch in
 * the `work_completion` branch module. The widget's `method` parameter is what it sets; a caller may still pass its own.
 */
export const COMPLETION_SETTINGS_MODULE = "work_completion";
export const completionSettingsSchema = z.object({ method: z.enum(COMPLETION_METHODS), expected_revision: z.number().int().nonnegative().optional() }).strict();
export async function readCompletionSettings(orgId: string): Promise<{ method: CompletionMethod; revision: number }> {
  const { readBranchModule } = await import("../platform/storage.js");
  const module = await readBranchModule(orgId, "default", COMPLETION_SETTINGS_MODULE).catch(() => null);
  const method = text(obj(module?.data).method);
  return { method: (COMPLETION_METHODS as readonly string[]).includes(method) ? method as CompletionMethod : "select_all", revision: Number((module as { revision?: number } | null)?.revision || 0) };
}
export async function saveCompletionSettings(orgId: string, input: unknown, actor: Actor) {
  requireActor(orgId, actor, "manage_company_settings", "completion_settings_denied", "Choosing how work is confirmed requires company settings access.");
  const parsed = completionSettingsSchema.parse(input);
  const { saveBranchModule } = await import("../platform/storage.js");
  const current = await readCompletionSettings(orgId);
  if (parsed.expected_revision !== undefined && parsed.expected_revision !== current.revision) throw conflict("completion_settings_revision", "Someone else changed how work is confirmed. Reload and try again.");
  await saveBranchModule(orgId, "default", COMPLETION_SETTINGS_MODULE, { data: { method: parsed.method, updated_by_user_id: text(actor.userId) } }, { replace: true });
  return readCompletionSettings(orgId);
}

/** A project's payouts, each finalized one saying whether its work order is now paid out in full (`all`) or in part. Reads only. */
export async function projectCompletions(orgId: string, projectId: string) {
  const completions = await listCompletions(orgId, { project_id: projectId });
  const states = new Map<string, ListPayState["state"]>();
  for (const listId of new Set(completions.filter((entry) => entry.state === "finalized").map((entry) => entry.list_id))) {
    const list = await readMaterialList(orgId, listId).catch(() => null);
    states.set(listId, list ? (await listPayState(orgId, list, completions)).state : "paid");
  }
  return completions.map((entry) => (entry.state === "finalized" ? { ...entry, list_paid: states.get(entry.list_id) === "paid" ? "all" as const : "part" as const } : entry));
}

/**
 * The rest of a work order paid out in part will not be done: its open lines are taken off the list and the
 * commitment still holding them is released with the reason, so the work order is finalized on the lines already
 * paid out and nothing more is owed or projected for it. Recorded on the list with who and why. Closeout uses this
 * when the remainder of a partly paid work order is cancelled rather than paid.
 */
export const cancelRemainderSchema = z.object({ list_id: id, reason: z.string().trim().min(3).max(1000) }).strict();
export async function cancelRemainingLines(orgId: string, input: unknown, actor: Actor) {
  requireActor(orgId, actor, "manage_projects", "labor_cancel_denied", "Cancelling the rest of a work order requires project management access.");
  const parsed = cancelRemainderSchema.parse(input);
  const list = await readMaterialList(orgId, parsed.list_id);
  if (text(list.resource_type) !== "labor") throw badRequest("labor_cancel_not_labor", "Only a work order's labor list is cancelled this way.");
  const pay = await listPayState(orgId, list);
  if (pay.state !== "part") throw badRequest("labor_cancel_not_partial", pay.state === "paid" ? "Every line of this work order is already paid out." : "Nothing on this work order is paid out yet. Pay out what was done first.");
  const items = (Array.isArray(list.current_items) ? list.current_items : []).map(obj);
  const keep = items.filter((item) => pay.paid.has(text(item.id)));
  const removed = pay.lines.filter((line) => !pay.paid.has(line.id));
  const { createMaterialVersion } = await import("../materials/storage.js");
  await createMaterialVersion(orgId, parsed.list_id, { expected_revision: Number(list.revision || 0), reason: "revision", notes: `Rest cancelled: ${parsed.reason}`, items: keep }, actor as PlatformAuthContext);
  // Whoever still holds the open lines no longer does: the work was taken back, which is what releasing means.
  const { releaseCommitment } = await import("./commitments.js");
  for (const commitment of (await listCommitments(orgId, { list_id: parsed.list_id })).filter((entry) => entry.status === "committed")) await releaseCommitment(orgId, { id: commitment.id, reason: `Rest cancelled: ${parsed.reason}` }, actor);
  await recordMaterialEvent(orgId, parsed.list_id, "labor_completion.remainder_cancelled", { reason: parsed.reason, lines: removed.map((line) => ({ id: line.id, name: line.name, total_cents: line.total_cents })) }, actor.system ? null : actor as PlatformAuthContext).catch(() => null);
  const after = await listPayState(orgId, await readMaterialList(orgId, parsed.list_id));
  return { list_id: parsed.list_id, state: after.state, cancelled: removed.map((line) => ({ id: line.id, name: line.name, total_cents: line.total_cents })), paid_cents: after.paid_cents };
}
