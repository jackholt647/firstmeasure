import { z } from "zod";
import { badRequest, conflict } from "../platform/errors.js";
import { readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import type { PublicationContext, SourceRef } from "../platform/publication/contracts.js";
import { listPublishedData, readPublishedData } from "../platform/publication/providers.js";
import { listProjectMaterialLists } from "../materials/storage.js";
import { registerWorkEvents } from "../work/events.js";
import { requireActor, type Actor } from "../labor/assignees.js";
import { COMPLETION_METHODS, finalizeLaborList, listCompletions, listPayState, REOPEN_PERMISSION } from "../labor/completion.js";

/**
 * Closing out a project: checking that everything that should have happened did, then confirming the remaining work
 * orders as done and the project's finances as finished.
 *
 * The checks read other apps only through the published data layer, with the caller's own access, so a check the
 * caller may not see, or that nothing publishes, is reported as not available rather than guessed. Every check warns
 * and none blocks: the only thing closing requires is that every work order's work is finalized to be paid, which the
 * work order step does first. The last step is the final expenses, which include those work orders; closing out
 * finishes the project and its finances. A closeout is a record on the project (collection `project_closeouts`, keyed by project) of who
 * closed it and when, what was finalized and how the checks stood. Only a person with `reopen_finalized_work` can
 * reopen it, and every close and reopen is kept in its history.
 */
export const CLOSEOUT_COLLECTION = "project_closeouts";

registerWorkEvents([
  { name: "project.closeout.completed", notification: { group: "materials", source: "materials", tab: "general" }, description: "A project was closed out: its work orders were finalized to be paid and its finances marked finished.", visibility: "activity" },
  { name: "project.closeout.reopened", notification: { group: "materials", source: "materials", tab: "general" }, description: "A manager reopened a closed-out project's finances.", visibility: "activity" }
]);

export type CheckStatus = "ok" | "warning" | "unavailable";
export type CheckRow = { id: string; label: string; detail: string; status: "ok" | "warning" | "info" };
export type CloseoutStep = {
  id: "change_orders" | "signatures" | "payments" | "requirements" | "receipts" | "expenses" | "work_orders";
  title: string; status: CheckStatus; summary: string; rows: CheckRow[];
  /** The published sources the step read. */
  sources: string[];
  /** What the step would need that nothing publishes yet. */
  missing: string[];
};
export type Closeout = {
  project_id: string; state: "closed" | "reopened";
  closed_at: string; closed_by_user_id: string; note: string;
  lists: { list_id: string; commitment_id: string; title: string; total_cents: number }[];
  checks: { id: string; status: CheckStatus; summary: string }[];
  reopened_at?: string; reopened_by_user_id?: string; reopen_reason?: string;
  history: { action: "closed" | "reopened"; at: string; by_user_id: string; reason?: string }[];
  revision: number;
};

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const arr = (value: unknown) => (Array.isArray(value) ? value.map(obj) : []);
const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (value: unknown) => text(value).slice(0, 10);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export async function readCloseout(orgId: string, projectId: string): Promise<Closeout | null> {
  const document = await readDocument(orgId, CLOSEOUT_COLLECTION, projectId).catch(() => null);
  return document ? { ...(document.data as unknown as Closeout), project_id: projectId, revision: Number(document.revision || 0) } : null;
}

function target(ctx: PublicationContext, projectId: string): SourceRef["target"] { return { scope: "project", organizationId: ctx.organizationId, projectId }; }
async function read(ctx: PublicationContext, projectId: string, provider: string, exported: string) {
  return readPublishedData(ctx, { provider, export: exported, target: target(ctx, projectId) });
}
const unavailable = (step: Omit<CloseoutStep, "status" | "summary" | "rows">, result: { status: string; message?: string }): CloseoutStep => ({ ...step, status: "unavailable", summary: result.status === "denied" ? `Not available to you: ${text(result.message).replace(/\.+$/, "") || "access is needed"}.` : text(result.message) || "This could not be read.", rows: [] });

const SIGNED = new Set(["signed", "completed"]), WITHDRAWN = new Set(["void", "declined", "expired"]), AWAITING = new Set(["issued", "sent", "viewed", "needs_review"]);
async function documentSteps(ctx: PublicationContext, projectId: string): Promise<[CloseoutStep, CloseoutStep]> {
  const sources = ["widget-objects.document-directory"];
  const changeBase = { id: "change_orders" as const, title: "Change orders", sources, missing: ["Whether each change order is paid: payments.records does not say which payment belongs to which change order."] };
  const signBase = { id: "signatures" as const, title: "Signatures", sources, missing: ["Which documents require a signature is not published. Documents that were sent and are not signed yet are treated as waiting for one."] };
  const result = await read(ctx, projectId, "widget-objects", "document-directory");
  if (result.status !== "ready") return [unavailable(changeBase, result), unavailable(signBase, result)];
  const documents = arr(obj(result.value).items);
  const row = (document: JsonObject): CheckRow => {
    const status = text(document.status).toLowerCase(), signed = SIGNED.has(status);
    return { id: text(document.id), label: text(document.title || document.name) || "Untitled document", detail: [signed ? "Signed" : status === "draft" ? "Not sent yet" : `Not signed (${status || "unknown"})`, Number(document.total_cents) ? money(Number(document.total_cents)) : ""].filter(Boolean).join(" · "), status: signed ? "ok" : AWAITING.has(status) || text(document.document_type) === "change_order" ? "warning" : "info" };
  };
  const live = documents.filter((document) => !WITHDRAWN.has(text(document.status).toLowerCase()));
  const changes = live.filter((document) => text(document.document_type) === "change_order").map(row);
  const others = live.filter((document) => text(document.document_type) !== "change_order").map(row);
  const unsignedChanges = changes.filter((entry) => entry.status !== "ok").length, waiting = others.filter((entry) => entry.status === "warning").length;
  return [
    { ...changeBase, status: unsignedChanges ? "warning" : "ok", summary: !changes.length ? "No change orders on this project." : unsignedChanges ? `${plural(unsignedChanges, "change order")} not signed.` : `All ${plural(changes.length, "change order")} signed.`, rows: changes },
    { ...signBase, status: waiting ? "warning" : "ok", summary: !others.length ? "No documents on this project." : waiting ? `${plural(waiting, "document")} sent and not signed yet.` : "Every sent document is signed.", rows: others }
  ];
}

async function paymentStep(ctx: PublicationContext, projectId: string): Promise<CloseoutStep> {
  const base = { id: "payments" as const, title: "Payments received", sources: ["payments.records"], missing: [] as string[] };
  const result = await read(ctx, projectId, "payments", "records");
  if (result.status !== "ready") return unavailable(base, result);
  const rows: CheckRow[] = [];
  let late = 0, owed = 0;
  for (const payment of arr(result.value)) {
    const status = text(payment.status).toLowerCase();
    if (status === "void") continue;
    // The published balance is not always filled in; what is still owed is the amount less what was allocated.
    const outstanding = Math.max(0, Number(payment.amount_cents || 0) - Number(payment.allocated_cents || 0));
    const due = ["due", "overdue"].includes(status) && outstanding > 0;
    if (due) { late += 1; owed += outstanding; }
    rows.push({ id: text(payment.id), label: text(payment.label) || "Payment", detail: outstanding ? `${money(outstanding)} outstanding${payment.due_at ? `, due ${day(payment.due_at)}` : ""}` : "Received", status: !outstanding ? "ok" : due ? "warning" : "info" });
  }
  return { ...base, status: late ? "warning" : "ok", summary: !rows.length ? "No payments are scheduled on this project." : late ? `${plural(late, "payment")} due and not received (${money(owed)}).` : rows.some((entry) => entry.status === "info") ? "Everything due so far is received. Some payments are not due yet." : "Every payment is received.", rows };
}

async function requirementStep(ctx: PublicationContext, projectId: string): Promise<CloseoutStep> {
  const base = { id: "requirements" as const, title: "Scope accounted for", sources: ["work-requirements.project"], missing: [] as string[] };
  const result = await read(ctx, projectId, "work-requirements", "project");
  if (result.status !== "ready") return unavailable(base, result);
  const value = obj(result.value), rows = arr(value.requirements).map((row): CheckRow => ({ id: text(row.id), label: text(row.label), detail: text(row.status) === "open" ? "Not accounted for" : text(row.status) === "warning" ? arr(row.warnings).map((warning) => text(warning.message)).join(" ") || "Something to check" : text(row.progress) === "completed" ? "Completed" : text(row.progress) === "scheduled" ? "Scheduled" : "Accounted for", status: text(row.status) === "covered" ? "ok" : "warning" }));
  const open = rows.filter((row) => row.detail === "Not accounted for").length, check = rows.filter((row) => row.status === "warning").length - open;
  return { ...base, status: open || check ? "warning" : "ok", summary: !rows.length ? text(value.reason) || "Nothing is required on this project." : [open ? `${open} not accounted for` : "", check ? `${check} to check` : ""].filter(Boolean).join(", ") || "Every requirement is accounted for.", rows };
}

const ORDERED = new Set(["ordered", "partially_delivered", "delivered"]);
async function receiptStep(ctx: PublicationContext, projectId: string, lists: JsonObject[]): Promise<CloseoutStep> {
  const base = { id: "receipts" as const, title: "Receipts", sources: ["receipts.record"], missing: ["Other paid expenses (supplemental expense items and payables) are not published, so only material and equipment lists are checked for a receipt."] };
  const receipts: JsonObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await listPublishedData(ctx, { provider: "receipts", export: "record", target: target(ctx, projectId) }, { limit: 200, ...(cursor ? { cursor } : {}) });
    if (result.status !== "ready") return unavailable(base, result);
    receipts.push(...result.items.map(obj));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  const live = receipts.filter((receipt) => text(receipt.status) !== "void");
  const rows: CheckRow[] = [];
  // A material or equipment list is a paid expense once it is ordered or something was paid on it.
  for (const list of lists.filter((entry) => ["material", "equipment", ""].includes(text(entry.resource_type)) && (ORDERED.has(text(entry.status)) || text(entry.ordered_at) || Number(obj(entry.totals).paid_total) > 0))) {
    const key = `scope_resource_list:${text(list.id)}`, found = live.filter((receipt) => (Array.isArray(receipt.attributed_target_keys) ? receipt.attributed_target_keys : []).map(text).includes(key));
    rows.push({ id: text(list.id), label: text(list.title) || "Materials", detail: found.length ? `${plural(found.length, "receipt")} uploaded` : "No receipt uploaded", status: found.length ? "ok" : "warning" });
  }
  for (const receipt of live.filter((entry) => text(entry.status) === "needs_review")) rows.push({ id: `receipt:${text(receipt.id)}`, label: text(obj(receipt.file).file_name) || "Receipt", detail: "Uploaded and waiting for review", status: "warning" });
  const missing = rows.filter((row) => row.detail === "No receipt uploaded").length, review = rows.filter((row) => row.detail.startsWith("Uploaded and waiting")).length;
  return { ...base, status: missing || review ? "warning" : "ok", summary: [missing ? `${plural(missing, "paid expense")} with no receipt` : "", review ? `${plural(review, "receipt")} waiting for review` : ""].filter(Boolean).join(", ") || (rows.length ? "Every paid list has a receipt." : "No paid material or equipment lists to check."), rows };
}

async function expenseStep(ctx: PublicationContext, projectId: string, lists: JsonObject[], finalized: Map<string, number>): Promise<CloseoutStep> {
  const base = { id: "expenses" as const, title: "Final expenses", sources: ["financials.records", "labor-completion.project"], missing: ["Receipt-backed actuals and the materials, labor and equipment breakdown of the project's financials are not published; the list rows below are read from the lists."] };
  const rows: CheckRow[] = [];
  const result = await read(ctx, projectId, "financials", "records");
  const summary = result.status === "ready" ? obj(arr(result.value)[0]) : null;
  if (summary) rows.push(
    { id: "expenses", label: "Expenses: actual vs planned", detail: `${money(Number(summary.expenses_to_date_cents || 0))} of ${money(Number(summary.projected_expenses_cents || 0))} planned`, status: "info" },
    { id: "revenue", label: "Revenue: collected vs contract", detail: `${money(Number(summary.total_collected_cents || 0))} of ${money(Number(summary.project_total_cents || 0))}`, status: "info" },
    { id: "profit", label: "Profit to date vs projected", detail: `${money(Number(summary.profit_to_date_cents || 0))} of ${money(Number(summary.projected_profit_cents || 0))}`, status: "info" }
  );
  const cents = (dollars: unknown) => Math.round((Number(dollars) || 0) * 100);
  let pending = 0;
  for (const list of lists.filter((entry) => (Array.isArray(entry.current_items) ? entry.current_items : []).length)) {
    const type = text(list.resource_type) || "material", planned = cents(obj(list.totals).projected_total), id = text(list.id);
    const name = `${type === "labor" ? "Labor" : type === "equipment" ? "Equipment" : "Materials"}: ${text(obj(obj(list.assignment).work_resource_ref).name) || text(list.title) || "Untitled"}`;
    if (type === "labor") {
      const actual = finalized.get(id);
      if (actual === undefined) pending += 1;
      rows.push({ id, label: name, detail: actual === undefined ? `${money(planned)} planned · not finalized, so not actual yet` : `${money(actual)} actual of ${money(planned)} planned`, status: actual === undefined ? "warning" : "ok" });
    } else {
      const paid = cents(obj(list.totals).paid_total);
      rows.push({ id, label: name, detail: `${money(paid)} paid of ${money(planned)} planned`, status: paid > planned && planned > 0 ? "warning" : "info" });
    }
  }
  const over = rows.filter((row) => row.status === "warning" && !row.detail.includes("not finalized")).length;
  return { ...base, status: pending || over ? "warning" : "ok", summary: [summary ? "" : `Project financials are not available${result.status !== "ready" && text((result as { message?: string }).message) ? ` (${text((result as { message?: string }).message).replace(/\.+$/, "")})` : ""}`, pending ? `${plural(pending, "work order")} not finalized, so ${pending === 1 ? "its cost is" : "their costs are"} not actual yet` : "", over ? `${plural(over, "list")} paid more than planned` : ""].filter(Boolean).join(". ") || "Every cost is final.", rows };
}

/** Every closeout check for one project, read with the caller's own access. Reads only; nothing here blocks. */
export async function closeoutChecks(ctx: PublicationContext, projectId: string) {
  const lists = (await listProjectMaterialLists(ctx.organizationId, projectId)).filter((list) => text(list.status) !== "archived");
  const completions = (await listCompletions(ctx.organizationId, { project_id: projectId })).filter((entry) => entry.state === "finalized");
  const workOrders = lists.filter((list) => text(list.resource_type) === "labor" && (Array.isArray(list.current_items) ? list.current_items : []).length);
  // A work order is finalized once every line is paid out, in one payout or several; its cost is then the payouts' sum.
  const pays = new Map(await Promise.all(workOrders.map(async (list) => [text(list.id), await listPayState(ctx.organizationId, list, completions)] as const)));
  const finalized = new Map([...pays].filter(([, pay]) => pay.state === "paid").map(([id, pay]) => [id, pay.paid_cents]));
  const workRows = workOrders.map((list): CheckRow => { const pay = pays.get(text(list.id))!; return { id: text(list.id), label: text(obj(obj(list.assignment).work_resource_ref).name) || text(list.title) || "Work order", detail: pay.state === "paid" ? `Finalized ${day(pay.last!.finalized_at)} · ${money(pay.paid_cents)}` : pay.state === "part" ? `${pay.paid.size} of ${pay.lines.length} lines paid out · ${money(pay.paid_cents)}` : "Not finalized", status: pay.state === "paid" ? "ok" : "warning" }; });
  const left = workRows.filter((row) => row.status !== "ok").length;
  const [changes, signatures] = await documentSteps(ctx, projectId);
  const steps: CloseoutStep[] = [changes, signatures, await paymentStep(ctx, projectId), await requirementStep(ctx, projectId), await receiptStep(ctx, projectId, lists),
    { id: "work_orders", title: "Finalize work orders", status: left ? "warning" : "ok", summary: !workRows.length ? "No work orders on this project." : left ? `${plural(left, "work order")} to confirm and finalize.` : "Every work order is finalized to be paid.", rows: workRows, sources: ["labor-completion.items", "labor-completion.project"], missing: [] },
    // Last: the finances, which include the work orders finalized in the step before. Closing out finishes them.
    await expenseStep(ctx, projectId, lists, finalized)];
  const record = await readCloseout(ctx.organizationId, projectId);
  return { project_id: projectId, steps, closeout: record, open_work_orders: workRows.filter((row) => row.status !== "ok").map((row) => row.id) };
}

export const closeInputSchema = z.object({
  /** The remaining work orders, each confirmed in the completion widget. */
  finalize: z.array(z.object({ list_id: z.string().trim().min(1).max(200), method: z.enum(COMPLETION_METHODS).default("select_all"), confirmed_item_ids: z.array(z.string().trim().min(1).max(240)).max(500).optional(), evidence_media_ids: z.array(z.string().trim().min(1).max(240)).max(50).optional(), note: z.string().trim().max(2000).optional() }).strict()).max(50).default([]),
  note: z.string().trim().max(2000).optional()
}).strict();
export const reopenCloseoutSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

const actorOf = (ctx: PublicationContext): Actor => (ctx.auth ? ctx.auth : { orgId: ctx.organizationId, userId: "", branchId: ctx.branchId, system: true });
async function emit(orgId: string, branchId: string, projectId: string, name: string, payload: JsonObject, key: string) {
  const { emitWorkEvent } = await import("../work/engine.js");
  await emitWorkEvent({ organization_id: orgId, branch_id: branchId || "default", project_id: projectId, type: name, idempotency_key: key, payload });
}
async function write(orgId: string, record: Closeout) {
  const { revision, ...data } = record;
  const document = await upsertDocument(orgId, CLOSEOUT_COLLECTION, { id: record.project_id, ...(revision ? { expected_revision: revision } : {}), data: data as unknown as JsonObject, metadata: { kind: "project_closeout", project_id: record.project_id, state: record.state } }, { replace: true, ...(revision ? {} : { createOnly: true }) });
  return { ...record, revision: Number((document as { revision?: number }).revision || 0) };
}

/**
 * Finalizes the remaining work orders and records the project's finances as finished. The checks are taken as they
 * stand and kept with the record; none of them stops the close. A work order that is neither already finalized nor
 * confirmed here does.
 */
export async function closeProject(ctx: PublicationContext, projectId: string, input: unknown): Promise<Closeout> {
  const actor = actorOf(ctx);
  requireActor(ctx.organizationId, actor, "manage_projects", "closeout_denied", "Closing out a project requires project management access.");
  const parsed = closeInputSchema.parse(input || {});
  await readDocument(ctx.organizationId, "projects", projectId);
  const existing = await readCloseout(ctx.organizationId, projectId);
  if (existing?.state === "closed") return existing;
  const lists = (await listProjectMaterialLists(ctx.organizationId, projectId)).filter((list) => text(list.status) !== "archived");
  const ownLists = new Set(lists.map((list) => text(list.id)));
  for (const entry of parsed.finalize) if (!ownLists.has(entry.list_id)) throw badRequest("closeout_list_unknown", "A work order to finalize is not on this project.");
  const closeoutId = `closeout_${projectId}_${(existing?.history.length || 0) + 1}`;
  for (const entry of parsed.finalize) await finalizeLaborList(ctx.organizationId, entry, actor, { closeoutId });
  const completions = (await listCompletions(ctx.organizationId, { project_id: projectId })).filter((entry) => entry.state === "finalized");
  const open: typeof lists = [];
  for (const list of lists.filter((entry) => text(entry.resource_type) === "labor" && (Array.isArray(entry.current_items) ? entry.current_items : []).length)) if ((await listPayState(ctx.organizationId, list, completions)).state !== "paid") open.push(list);
  if (open.length) throw conflict("closeout_work_orders_open", `Confirm and finalize every work order first: ${open.map((list) => text(obj(obj(list.assignment).work_resource_ref).name) || text(list.title) || "a work order").join(", ")}.`);
  const checks = (await closeoutChecks(ctx, projectId)).steps.map((step) => ({ id: step.id, status: step.status, summary: step.summary }));
  const now = new Date().toISOString(), by = text(actor.userId);
  const record = await write(ctx.organizationId, {
    project_id: projectId, state: "closed", closed_at: now, closed_by_user_id: by, note: parsed.note || "",
    lists: completions.map((entry) => ({ list_id: entry.list_id, commitment_id: entry.commitment_id, title: entry.assignee.name || entry.list_title, total_cents: entry.total_cents })), checks,
    history: [...(existing?.history || []), { action: "closed", at: now, by_user_id: by }], revision: existing?.revision || 0
  });
  await emit(ctx.organizationId, text(ctx.branchId), projectId, "project.closeout.completed", { closed_by_user_id: by, lists: record.lists.length, total_cents: record.lists.reduce((sum, entry) => sum + entry.total_cents, 0) }, `project.closeout.completed:${projectId}:${record.history.length}`).catch(() => null);
  return record;
}

/** A manager reopens a closed-out project's finances. The work orders stay finalized; each is reopened on its own. */
export async function reopenCloseout(ctx: PublicationContext, projectId: string, input: unknown): Promise<Closeout> {
  const actor = actorOf(ctx);
  requireActor(ctx.organizationId, actor, REOPEN_PERMISSION, "closeout_reopen_denied", "Only a manager who may reopen finalized work can reopen a closeout.");
  const parsed = reopenCloseoutSchema.parse(input || {});
  const existing = await readCloseout(ctx.organizationId, projectId);
  if (existing?.state !== "closed") throw badRequest("closeout_not_closed", "This project is not closed out.");
  const now = new Date().toISOString(), by = text(actor.userId);
  const record = await write(ctx.organizationId, { ...existing, state: "reopened", reopened_at: now, reopened_by_user_id: by, reopen_reason: parsed.reason, history: [...existing.history, { action: "reopened", at: now, by_user_id: by, reason: parsed.reason }] });
  await emit(ctx.organizationId, text(ctx.branchId), projectId, "project.closeout.reopened", { reopened_by_user_id: by, reason: parsed.reason }, `project.closeout.reopened:${projectId}:${record.history.length}`).catch(() => null);
  return record;
}
