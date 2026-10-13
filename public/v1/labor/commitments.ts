import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, PlatformError } from "../platform/errors.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { contentHash } from "../platform/publication/validation.js";
import { readMaterialList, recordMaterialEvent } from "../materials/storage.js";
import { registerWorkEvents } from "../work/events.js";
import { ASSIGNEE_TYPE_BY_KIND, assigneeSchema, requireActor, requireAssignee, type Actor, type Assignee } from "./assignees.js";
import { listPaySheets } from "./pay-sheets.js";

/**
 * Committing a labor list hands it to its assignee. The commitment is a frozen copy of what was sent: later edits to
 * the list never change it, and committing a changed list makes a new revision that supersedes the last. Committing a
 * list that has not changed returns the commitment it already has, so a second click sends nothing twice.
 *
 * What "hand it to them" means depends on the assignee. Two methods are fixed (share it inside FirstMate, or email a
 * work order). The third runs the assignee's own delivery code in the module sandbox; that code only plans steps
 * from a fixed set, and by default it asks someone to deliver the work by hand with a to-do.
 */
export const COMMITMENT_COLLECTION = "labor_commitments";
export const DELIVERY_SETTING_COLLECTION = "labor_delivery_settings";
/** Units inside an assignee: the groups within it that each do one job at a time. What a unit is called (crew, team, pod) comes from terminology, never from here. */
export const UNIT_COLLECTION = "assignee_units";
export const DELIVERY_METHODS = ["share", "work_order_email", "custom"] as const;
export type DeliveryMethod = typeof DELIVERY_METHODS[number];
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const deliverySettingSchema = z.object({
  subject: assigneeSchema,
  method: z.enum(DELIVERY_METHODS),
  /** Where a work order is emailed. An outside company's own contact email is used when this is empty. */
  email: z.string().trim().max(320).email().or(z.literal("")).optional(),
  /** Delivery code for the custom method. It receives `inputs.commitment`, `inputs.recipient` and `inputs.work_order` and returns `{ outputs: { steps } }`. */
  source: z.string().max(64_000).optional()
}).strict();
export const commitInputSchema = z.object({ list_id: id, unit_id: id.optional(), note: z.string().trim().max(4000).optional(), idempotency_key: z.string().trim().min(8).max(200).optional() }).strict();
export type Subject = Assignee;
export type DeliveryStep = { action: "todo"; title: string; body?: string; assigned_user_ids?: string[]; assigned_resource_group_ids?: string[] } | { action: "email"; to: string; subject: string; text: string; html?: string } | { action: "share" };

/** The default for a recipient with no delivery code of their own: someone delivers the work by hand. */
export const DEFAULT_CUSTOM_DELIVERY = `const c = inputs.commitment;
return { outputs: { steps: [{ action: "todo", title: "Send work to " + c.assignee.name, body: c.title + " on " + c.project_title + " is committed and has not been delivered. Open the project to send it." }] } };`;

// Registered when this module loads, like every other event, so automation authoring knows them before the first commit.
registerWorkEvents([
  { name: "labor.list.committed", notification: { group: "materials", source: "materials", tab: "general" }, description: "A labor list was committed to its assignee.", visibility: "activity" },
  { name: "labor.list.delivered", notification: { group: "materials", source: "materials", tab: "general" }, description: "A committed labor list reached its assignee.", visibility: "activity" },
  { name: "labor.list.released", notification: { group: "materials", source: "materials", tab: "general" }, description: "A committed labor list was released because the work finished or was taken back.", visibility: "activity" }
]);

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
export type { Actor } from "./assignees.js";
const requireCommit = (orgId: string, actor: Actor) => requireActor(orgId, actor, "manage_projects", "labor_commit_denied", "Committing labor requires project management access.");
const requireSettings = (orgId: string, actor: Actor) => requireActor(orgId, actor, "manage_company_settings", "labor_delivery_setting_denied", "This requires company settings access.");
const settingId = (subject: Subject) => `${subject.type}:${subject.id}`;

export async function listDeliverySettings(orgId: string) {
  return (await listDocuments(orgId, DELIVERY_SETTING_COLLECTION)).map((document) => { const { updated_by_user_id: _by, ...data } = document.data as unknown as z.infer<typeof deliverySettingSchema> & { updated_by_user_id?: string }; return { ...data, revision: Number(document.revision || 0) }; });
}
export async function saveDeliverySetting(orgId: string, input: unknown, actor: Actor) {
  requireSettings(orgId, actor);
  const parsed = deliverySettingSchema.parse(input);
  await requireAssignee(orgId, parsed.subject);
  const document = await upsertDocument(orgId, DELIVERY_SETTING_COLLECTION, { id: settingId(parsed.subject), data: { ...parsed, updated_by_user_id: text(actor.userId) } as unknown as JsonObject, metadata: { kind: "labor_delivery_setting", subject_type: parsed.subject.type, subject_id: parsed.subject.id } }, { replace: true });
  return { ...parsed, revision: Number((document as { revision?: number }).revision || 0) };
}
/**
 * How an assignee receives work when nothing has been chosen for them: people and groups inside the organization are
 * shared with; an outside company is emailed a work order.
 */
export function defaultDeliveryMethod(subject: Subject): DeliveryMethod {
  return subject.type === "organization_connection" ? "work_order_email" : "share";
}

export type Commitment = {
  id: string; list_id: string; project_id: string; project_title: string; title: string; revision: number;
  /** committed: the assignee holds this work. superseded: a later revision replaced it. released: the work is finished or was taken back. */
  status: "committed" | "superseded" | "released";
  /** The unit within the assignee this was committed to, when one was chosen. */
  unit: { id: string; name: string } | null;
  assignee: { type: Subject["type"]; id: string; name: string };
  /** `rate` is dollars per unit exactly as the list held it; `total_cents` is the list's own line total. A line with no rate has neither. */
  lines: { id: string; name: string; quantity: number; unit: string; rate: number | null; total_cents: number | null; kind: string }[];
  /** The sum of the priced lines. `unpriced_lines` says how many lines are not in it. */
  total_cents: number; unpriced_lines: number;
  /** The assignee's pay sheets as they stood, so the rates behind a commitment can be traced. */
  pay_sheets: { id: string; revision: number }[];
  schedule: JsonObject | null; note: string;
  /** The list revision and a hash of exactly what was frozen. A list whose current hash differs has changed since. */
  list_revision: number; content_hash: string; idempotency_key: string;
  committed_by_user_id: string; committed_at: string;
  delivery: { method: DeliveryMethod; status: "delivered" | "needs_attention" | "pending"; detail: string; steps: JsonObject[]; delivered_at?: string };
  /** Set when the automation event for this commitment could not be recorded. */
  event_error?: string;
  superseded_by?: string; released_at?: string; released_by_user_id?: string; release_reason?: string;
};
type Stored = Commitment & { store_revision: number };
const row = (document: { id: string; revision?: number; data: JsonObject }) => ({ ...(document.data as unknown as Omit<Commitment, "id">), id: document.id, store_revision: Number(document.revision || 0) }) as Stored;
const metadata = (entry: Commitment) => ({ kind: "labor_commitment", list_id: entry.list_id, project_id: entry.project_id, subject_type: entry.assignee.type, subject_id: entry.assignee.id });
const publicView = ({ store_revision: _revision, ...entry }: Stored): Commitment => entry;
async function storedCommitments(orgId: string) {
  const all = (await listDocuments(orgId, COMMITMENT_COLLECTION)).map(row);
  // Only a list's newest revision can be current. An older one that was never marked (a write that did not finish) is
  // read as superseded whatever became of the newer one, so it can never come back to life.
  const newest = new Map<string, number>();
  for (const entry of all) newest.set(entry.list_id, Math.max(newest.get(entry.list_id) || 0, entry.revision));
  return all.map((entry) => (entry.status === "committed" && entry.revision < (newest.get(entry.list_id) || 0) ? { ...entry, status: "superseded" as const } : entry));
}
async function save(orgId: string, entry: Stored, options: { createOnly?: boolean } = {}) {
  const { id: commitmentId, store_revision, ...data } = entry;
  const document = await upsertDocument(orgId, COMMITMENT_COLLECTION, { id: commitmentId, ...(options.createOnly ? {} : { expected_revision: store_revision }), data: data as unknown as JsonObject, metadata: metadata(entry) }, { replace: true, ...(options.createOnly ? { createOnly: true } : {}) });
  return { ...entry, store_revision: Number((document as { revision?: number }).revision || 0) } as Stored;
}
export async function listCommitments(orgId: string, filter: { project_id?: string; list_id?: string; subject?: Subject } = {}): Promise<Commitment[]> {
  return (await storedCommitments(orgId))
    .filter((entry) => (!filter.project_id || entry.project_id === filter.project_id) && (!filter.list_id || entry.list_id === filter.list_id) && (!filter.subject || (entry.assignee.type === filter.subject.type && entry.assignee.id === filter.subject.id)))
    .sort((a, b) => a.committed_at.localeCompare(b.committed_at) || a.revision - b.revision).map(publicView);
}
/** What an assignee has been committed to and not released from: the basis for its availability. */
export async function currentCommitmentsFor(orgId: string, subject: Subject) {
  return (await listCommitments(orgId, { subject })).filter((entry) => entry.status === "committed");
}

function workOrder(commitment: Commitment) {
  const money = (cents: number | null) => (cents == null ? "" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const rate = (value: number | null) => (value == null ? "" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`);
  const escape = (value: unknown) => text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const subject = `Work order - ${commitment.project_title}${commitment.revision > 1 ? ` (revision ${commitment.revision})` : ""}`;
  // A total that leaves lines out says so, rather than reading as the whole job.
  const totalLabel = commitment.unpriced_lines ? `Total of priced lines (${commitment.unpriced_lines} not priced)` : "Total";
  const rows = commitment.lines.map((line) => `${line.name}: ${line.quantity} ${line.unit}${line.rate == null ? "" : ` at ${rate(line.rate)}`}${line.total_cents == null ? "" : ` = ${money(line.total_cents)}`}`);
  const body = [`Hello ${commitment.assignee.name},`, "", `Please find the work order for ${commitment.project_title}: ${commitment.title}.`, "", ...rows, "", `${totalLabel}: ${money(commitment.total_cents)}`, ...(commitment.note ? ["", commitment.note] : [])].join("\n");
  const html = `<p>Hello ${escape(commitment.assignee.name)},</p><p>Please find the work order for ${escape(commitment.project_title)}: ${escape(commitment.title)}.</p><table cellpadding="6" style="border-collapse:collapse"><tr><th align="left">Work</th><th align="right">Qty</th><th align="left">Unit</th><th align="right">Rate</th><th align="right">Total</th></tr>${commitment.lines.map((line) => `<tr><td>${escape(line.name)}</td><td align="right">${line.quantity}</td><td>${escape(line.unit)}</td><td align="right">${rate(line.rate)}</td><td align="right">${money(line.total_cents)}</td></tr>`).join("")}<tr><td colspan="4" align="right"><strong>${escape(totalLabel)}</strong></td><td align="right"><strong>${money(commitment.total_cents)}</strong></td></tr></table>${commitment.note ? `<p>${escape(commitment.note)}</p>` : ""}`;
  return { subject, text: body, html };
}

export type DeliveryEffects = {
  todo(body: JsonObject): Promise<unknown>;
  email(input: { to: string; subject: string; text: string; html?: string; idempotency_key: string }): Promise<unknown>;
  run(source: string, inputs: JsonObject): Promise<DeliveryStep[]>;
};
/** The real effects: a to-do, a project email, and the module sandbox for an assignee's own delivery code. */
export function platformDeliveryEffects(orgId: string, commitment: Pick<Commitment, "project_id">, actor: Actor): DeliveryEffects {
  return {
    todo: async (body) => (await import("../work/todos.js")).createTodo(orgId, { ...body, project_id: commitment.project_id }, actor as PlatformAuthContext),
    email: async (input) => (await import("../comms/service.js")).sendProjectEmail(orgId, text(actor.branchId) || "default", commitment.project_id, input, actor),
    run: async (source, inputs) => {
      // Delivery code only plans. It can read nothing and invoke nothing; the steps it returns are carried out here.
      const result = await (await import("../documents/modules/runtime.js")).runModuleCode({ source, inputs, mode: "evaluate" }, { read: async () => { throw badRequest("labor_delivery_read_denied", "Delivery code reads only its inputs."); }, invoke: async () => { throw badRequest("labor_delivery_effect_denied", "Delivery code returns steps; it does not act."); } });
      return z.array(z.discriminatedUnion("action", [
        z.object({ action: z.literal("todo"), title: z.string().trim().min(1).max(300), body: z.string().max(4000).optional(), assigned_user_ids: z.array(id).max(50).optional(), assigned_resource_group_ids: z.array(id).max(50).optional() }).strict(),
        z.object({ action: z.literal("email"), to: z.string().trim().email(), subject: z.string().trim().min(1).max(300), text: z.string().min(1).max(20000), html: z.string().max(100000).optional() }).strict(),
        z.object({ action: z.literal("share") }).strict()
      ])).max(10).parse(obj(result.outputs).steps);
    }
  };
}

type DeliverySetting = { method: DeliveryMethod; email?: string; source?: string };
type Recipient = { emails: string[]; inside: boolean };
/**
 * Carries a commitment to its assignee and reports what happened. A step that cannot run leaves the delivery needing
 * attention; it never reports delivered. Email only goes to an address already on record for the assignee, whatever
 * the delivery code asks for.
 */
export async function deliverCommitment(commitment: Commitment, setting: DeliverySetting, recipient: Recipient, effects: DeliveryEffects): Promise<Commitment["delivery"]> {
  const steps: JsonObject[] = [];
  const result = (status: Commitment["delivery"]["status"], detail: string): Commitment["delivery"] => ({ method: setting.method, status, detail, steps, ...(status === "delivered" ? { delivered_at: new Date().toISOString() } : {}) });
  const order = workOrder(commitment);
  const known = new Set([text(setting.email), ...recipient.emails].filter(Boolean).map((address) => address.toLowerCase()));
  try {
    let plan: DeliveryStep[];
    if (setting.method === "share") plan = [{ action: "share" }];
    else if (setting.method === "work_order_email") {
      const to = text(setting.email) || recipient.emails[0] || "";
      if (!to) return result("needs_attention", `There is no email address for ${commitment.assignee.name}.`);
      plan = [{ action: "email", to, ...order }];
    } else plan = await effects.run(text(setting.source) || DEFAULT_CUSTOM_DELIVERY, { commitment: commitment as unknown as JsonObject, recipient: { emails: [...known], name: commitment.assignee.name, type: commitment.assignee.type }, work_order: order });
    if (!plan.length) return result("needs_attention", "The delivery code planned no steps.");
    for (const step of plan) if (step.action === "email" && !known.has(step.to.toLowerCase())) return result("needs_attention", `${step.to} is not an address on record for ${commitment.assignee.name}.`);
    let reached = false;
    for (const [index, step] of plan.entries()) {
      if (step.action === "share") {
        // Sharing puts the work in front of people who use this organization's FirstMate. An outside company's own account is not reached yet.
        steps.push({ action: "share", reached: recipient.inside });
        reached ||= recipient.inside;
      } else if (step.action === "todo") { await effects.todo({ id: `labor_delivery_${commitment.id}_${index}`, title: step.title, body: step.body || "", assigned_user_ids: step.assigned_user_ids || [], assigned_resource_group_ids: step.assigned_resource_group_ids || [] }); steps.push({ action: "todo", title: step.title }); }
      else { await effects.email({ to: step.to, subject: step.subject, text: step.text, html: step.html, idempotency_key: `labor_commitment:${commitment.id}:${index}` }); steps.push({ action: "email", to: step.to, subject: step.subject }); reached = true; }
    }
    if (reached) return result("delivered", steps.some((step) => step.action === "email") ? "The work order was emailed." : `Shared with ${commitment.assignee.name}.`);
    // A to-do asking someone to send the work, or a share that reaches nobody, is not the work arriving.
    return result("pending", steps.some((step) => step.action === "todo") ? "A to-do was created to deliver this work by hand." : `${commitment.assignee.name} cannot be reached inside FirstMate yet. Send this work another way, then confirm it.`);
  } catch (error) {
    return result("needs_attention", error instanceof Error ? error.message : "Delivery failed.");
  }
}

async function emit(orgId: string, commitment: Commitment, name: string, branchId: string) {
  const { emitWorkEvent } = await import("../work/engine.js");
  await emitWorkEvent({ organization_id: orgId, branch_id: branchId || "default", project_id: commitment.project_id, type: name, idempotency_key: `${name}:${commitment.id}`, payload: { commitment_id: commitment.id, list_id: commitment.list_id, revision: commitment.revision, assignee: commitment.assignee, unit: commitment.unit, total_cents: commitment.total_cents, delivery_method: commitment.delivery.method, delivery_status: commitment.delivery.status } });
}
async function deliverAndRecord(orgId: string, stored: Stored, actor: Actor, effects?: DeliveryEffects) {
  const subject: Subject = { type: stored.assignee.type, id: stored.assignee.id };
  const found = await requireAssignee(orgId, subject).catch(() => null);
  const setting: DeliverySetting = (await listDeliverySettings(orgId)).find((entry) => entry.subject.type === subject.type && entry.subject.id === subject.id) || { method: defaultDeliveryMethod(subject) };
  const contacts = Array.isArray(found?.record.contacts) ? (found!.record.contacts as unknown[]).map(obj) : [];
  const recipient: Recipient = { emails: [...new Set([text(found?.record.email), ...contacts.map((contact) => text(contact.email))].filter(Boolean))], inside: subject.type !== "organization_connection" };
  const delivery = await deliverCommitment(publicView(stored), setting, recipient, effects || platformDeliveryEffects(orgId, stored, actor));
  let next = await save(orgId, { ...stored, delivery });
  await recordMaterialEvent(orgId, next.list_id, "labor_commitment.delivery", { commitment_id: next.id, revision: next.revision, delivery_method: delivery.method, delivery_status: delivery.status }, actor.system ? null : actor as PlatformAuthContext).catch(() => null);
  if (delivery.status === "delivered") next = await save(orgId, await emit(orgId, next, "labor.list.delivered", text(actor.branchId)).then(() => next, (error) => ({ ...next, event_error: error instanceof Error ? error.message : "The delivered event could not be recorded." })));
  return next;
}

/** Freezes a labor list as it stands and hands it to its assignee. An unchanged list returns the commitment it already has. */
export async function commitLaborList(orgId: string, input: unknown, actor: Actor, effects?: DeliveryEffects): Promise<Commitment> {
  requireCommit(orgId, actor);
  const parsed = commitInputSchema.parse(input);
  const list = await readMaterialList(orgId, parsed.list_id);
  if (text(list.resource_type) !== "labor") throw badRequest("labor_commit_not_labor", "Only a labor list can be committed.");
  if (text(list.status) === "archived") throw badRequest("labor_commit_archived", "This list is archived and cannot be committed.");
  const reference = obj(obj(list.assignment).work_resource_ref);
  const type = ASSIGNEE_TYPE_BY_KIND[text(reference.kind)];
  if (!text(reference.id) || !type) throw badRequest("labor_commit_unassigned", "Assign this list before committing it.");
  const subject: Subject = { type, id: text(reference.id) };
  const assignee = await requireAssignee(orgId, subject);
  const project = await readDocument(orgId, "projects", text(list.project_id)).catch(() => null);
  if (!project) throw badRequest("labor_commit_project_missing", "This list's project is no longer available.");
  const items = (Array.isArray(list.current_items) ? list.current_items : []).map(obj);
  if (!items.length) throw badRequest("labor_commit_empty", "There is nothing on this list to commit.");
  const unitId = parsed.unit_id || text(obj(list.assignment).unit_id);
  const unitRow = unitId ? (await listUnits(orgId, subject)).find((entry) => entry.id === unitId) : null;
  if (unitId && !unitRow) throw badRequest("labor_commit_unit_unknown", "That unit does not belong to the assignee this list is assigned to.");
  const unit = unitRow ? { id: unitRow.id, name: unitRow.name } : null;
  const number = (value: unknown) => (value !== null && value !== "" && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null);
  const lines = items.map((item) => {
    const quantity = number(item.quantity) ?? 0, rate = number(item.projected_unit_price), listed = number(item.projected_total);
    // The list's own line total wins: it is what the list shows, and it may have been set by hand.
    const total = rate == null && listed == null ? null : Math.round((listed ?? quantity * rate!) * 100);
    return { id: text(item.id), name: text(item.name), quantity, unit: text(item.unit), rate, total_cents: total, kind: text(obj(item.metadata).compensation_kind) };
  });
  const note = parsed.note || "";
  const schedule = Object.keys(obj(list.schedule)).length ? obj(list.schedule) : null;
  const hash = contentHash({ lines, assignee: subject, unit, note, schedule });
  const existing = (await storedCommitments(orgId)).filter((entry) => entry.list_id === parsed.list_id).sort((a, b) => a.revision - b.revision);
  if (parsed.idempotency_key) { const repeat = existing.find((entry) => entry.idempotency_key === parsed.idempotency_key); if (repeat) return publicView(repeat); }
  const current = [...existing].reverse().find((entry) => entry.status === "committed") || null;
  if (current && current.content_hash === hash) return publicView(current);
  const revision = (existing.at(-1)?.revision || 0) + 1;
  const sheets = (await listPaySheets(orgId)).filter((entry) => entry.subject.type === subject.type && entry.subject.id === subject.id).map((entry) => ({ id: entry.id, revision: entry.revision }));
  const draft: Stored = {
    // The id is the list and the revision, so two commits racing for the same revision cannot both be created.
    id: `lc_${parsed.list_id}_${revision}`, store_revision: 0, list_id: parsed.list_id, project_id: text(list.project_id), project_title: text(project.data.title || project.data.address) || "the project", title: text(list.title) || "Labor",
    revision, status: "committed", unit, assignee: { ...subject, name: text(reference.name) || assignee.name || "the assignee" },
    lines, total_cents: lines.reduce((sum, line) => sum + (line.total_cents || 0), 0), unpriced_lines: lines.filter((line) => line.total_cents == null).length, pay_sheets: sheets,
    schedule, note, list_revision: Number(list.revision || 0), content_hash: hash, idempotency_key: parsed.idempotency_key || "",
    committed_by_user_id: text(actor.userId), committed_at: new Date().toISOString(), delivery: { method: defaultDeliveryMethod(subject), status: "pending", detail: "", steps: [] }
  };
  let stored: Stored;
  try { stored = await save(orgId, draft, { createOnly: true }); }
  catch (error) { if (error instanceof PlatformError && error.code === "document_exists") throw conflict("labor_commit_conflict", "This list was committed by someone else just now. Reload and try again."); throw error; }
  // Marking the earlier revision is tidy-up: readers already treat anything older than the newest as superseded.
  for (const earlier of existing.filter((entry) => entry.status === "committed")) await save(orgId, { ...earlier, status: "superseded", superseded_by: stored.id }).catch(() => null);
  await recordMaterialEvent(orgId, stored.list_id, "labor_commitment.created", { commitment_id: stored.id, revision: stored.revision }, actor.system ? null : actor as PlatformAuthContext).catch(() => null);
  stored = await emit(orgId, stored, "labor.list.committed", text(list.branch_id)).then(() => stored, (error) => save(orgId, { ...stored, event_error: error instanceof Error ? error.message : "The committed event could not be recorded." }));
  return publicView(await deliverAndRecord(orgId, stored, { ...actor, branchId: text(actor.branchId) || text(list.branch_id) }, effects));
}

async function findCurrent(orgId: string, commitmentId: string) {
  const found = (await storedCommitments(orgId)).find((entry) => entry.id === commitmentId);
  if (!found) throw badRequest("labor_commitment_unknown", "This commitment is unavailable.");
  return found;
}
/** Tries again to deliver a commitment that is still held and has not arrived. Email steps keep their original keys, so a retry does not send twice. */
export async function redeliverCommitment(orgId: string, input: unknown, actor: Actor, effects?: DeliveryEffects): Promise<Commitment> {
  requireCommit(orgId, actor);
  const current = await findCurrent(orgId, z.object({ id }).strict().parse(input).id);
  if (current.status !== "committed") throw badRequest("labor_commitment_not_current", "Only a current commitment can be delivered.");
  if (current.delivery.status === "delivered") return publicView(current);
  return publicView(await deliverAndRecord(orgId, current, actor, effects));
}
/** Records that someone delivered the work by hand, for a delivery that is pending or needed attention. */
export async function confirmDelivery(orgId: string, input: unknown, actor: Actor): Promise<Commitment> {
  requireCommit(orgId, actor);
  const parsed = z.object({ id, detail: z.string().trim().max(500).optional() }).strict().parse(input);
  const current = await findCurrent(orgId, parsed.id);
  if (current.status !== "committed") throw badRequest("labor_commitment_not_current", "Only a current commitment can be confirmed.");
  if (current.delivery.status === "delivered") return publicView(current);
  let next = await save(orgId, { ...current, delivery: { ...current.delivery, status: "delivered", detail: parsed.detail || "Confirmed as delivered by hand.", delivered_at: new Date().toISOString() } });
  next = await emit(orgId, next, "labor.list.delivered", text(actor.branchId)).then(() => next, (error) => save(orgId, { ...next, event_error: error instanceof Error ? error.message : "The delivered event could not be recorded." }));
  return publicView(next);
}
/** Finished or taken back: the assignee no longer holds this work, so its capacity is free again. */
export async function releaseCommitment(orgId: string, input: unknown, actor: Actor): Promise<Commitment> {
  requireCommit(orgId, actor);
  const parsed = z.object({ id, reason: z.string().trim().max(500).optional() }).strict().parse(input);
  const current = await findCurrent(orgId, parsed.id);
  if (current.status !== "committed") return publicView(current);
  const released = await save(orgId, { ...current, status: "released", released_at: new Date().toISOString(), released_by_user_id: text(actor.userId), release_reason: parsed.reason || "" });
  await emit(orgId, released, "labor.list.released", text(actor.branchId)).catch(() => null);
  return publicView(released);
}
/** Releases whatever is still held for a list that has been archived, so an archived list never holds an assignee's capacity. */
export async function releaseCommitmentsForList(orgId: string, listId: string, actor: Actor, reason = "The list was archived.") {
  const held = (await storedCommitments(orgId)).filter((entry) => entry.list_id === listId && entry.status === "committed");
  for (const entry of held) await releaseCommitment(orgId, { id: entry.id, reason }, actor);
  return held.length;
}

// ---- Units inside an assignee ----
export const unitInputSchema = z.object({
  id: id.optional(),
  assignee: assigneeSchema,
  /** A unit may sit under another unit of the same assignee. Left out, it sits directly under the assignee. */
  parent_unit_id: id.optional(),
  name: z.string().trim().min(1).max(200),
  /** The kind of group this is, as a terminology key such as a resource group kind id. Its display name is resolved by the terminology system. */
  kind_id: z.string().trim().max(120).optional(),
  expected_revision: z.number().int().nonnegative().optional()
}).strict();
export type Unit = { id: string; assignee: Subject; parent_unit_id: string; name: string; kind_id: string; revision: number };
export async function listUnits(orgId: string, assignee?: Subject): Promise<Unit[]> {
  return (await listDocuments(orgId, UNIT_COLLECTION)).filter((document) => !document.data.archived_at)
    .map((document) => ({ id: document.id, assignee: document.data.assignee as unknown as Subject, parent_unit_id: text(document.data.parent_unit_id), name: text(document.data.name), kind_id: text(document.data.kind_id), revision: Number(document.revision || 0) }))
    .filter((unit) => !assignee || (unit.assignee.type === assignee.type && unit.assignee.id === assignee.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function saveUnit(orgId: string, input: unknown, actor: Actor) {
  requireSettings(orgId, actor);
  const parsed = unitInputSchema.parse(input);
  await requireAssignee(orgId, parsed.assignee);
  const siblings = await listUnits(orgId, parsed.assignee);
  const existing = parsed.id ? siblings.find((unit) => unit.id === parsed.id) || null : null;
  if (parsed.id && !existing) throw badRequest("assignee_unit_unknown", "This unit is unavailable.");
  if (parsed.parent_unit_id) {
    // The parent must be another unit of the same assignee, and following parents upward must never come back here.
    let cursor: Unit | undefined = siblings.find((unit) => unit.id === parsed.parent_unit_id);
    if (!cursor) throw badRequest("assignee_unit_parent_unknown", "The parent unit must belong to the same assignee.");
    for (let depth = 0; cursor; depth += 1) { if (cursor.id === parsed.id || depth > 20) throw badRequest("assignee_unit_cycle", "A unit cannot sit under itself."); const parentId: string = cursor.parent_unit_id; cursor = parentId ? siblings.find((unit) => unit.id === parentId) : undefined; }
  }
  const document = await upsertDocument(orgId, UNIT_COLLECTION, { ...(existing ? { id: existing.id, expected_revision: parsed.expected_revision ?? existing.revision } : {}), data: { assignee: parsed.assignee, parent_unit_id: parsed.parent_unit_id || "", name: parsed.name, kind_id: parsed.kind_id || "", updated_by_user_id: text(actor.userId) } as unknown as JsonObject, metadata: { kind: "assignee_unit", subject_type: parsed.assignee.type, subject_id: parsed.assignee.id } }, { replace: true });
  return { id: document.id, assignee: parsed.assignee, parent_unit_id: parsed.parent_unit_id || "", name: parsed.name, kind_id: parsed.kind_id || "", revision: Number((document as { revision?: number }).revision || 0) } as Unit;
}
export async function archiveUnit(orgId: string, input: unknown, actor: Actor) {
  requireSettings(orgId, actor);
  const parsed = z.object({ id }).strict().parse(input);
  const document = (await listDocuments(orgId, UNIT_COLLECTION)).find((entry) => entry.id === parsed.id && !entry.data.archived_at);
  if (!document) throw badRequest("assignee_unit_unknown", "This unit is unavailable.");
  if ((await listUnits(orgId)).some((unit) => unit.parent_unit_id === parsed.id)) throw badRequest("assignee_unit_has_children", "Move or remove the units under this one first.");
  if ((await storedCommitments(orgId)).some((entry) => entry.status === "committed" && entry.unit?.id === parsed.id)) throw badRequest("assignee_unit_committed", "This unit still holds committed work. Release it or commit it elsewhere first.");
  await upsertDocument(orgId, UNIT_COLLECTION, { id: parsed.id, expected_revision: Number(document.revision || 0), data: { ...document.data, archived_at: new Date().toISOString(), archived_by_user_id: text(actor.userId) }, metadata: { kind: "assignee_unit", subject_type: text(obj(document.data.assignee).type), subject_id: text(obj(document.data.assignee).id) } }, { replace: true });
  return { id: parsed.id, archived: true };
}

/**
 * How much an assignee can take on, worked out only from what it is committed to. Each unit that has no units under it
 * does one job at a time; an assignee with no units is itself one such unit. Work committed to the assignee as a whole,
 * or to a unit that has units under it, uses up one unit without saying which.
 */
export async function assigneeAvailability(orgId: string, assignee: Subject) {
  const all = await listUnits(orgId, assignee);
  const current = await currentCommitmentsFor(orgId, assignee);
  const leaves = all.filter((unit) => !all.some((other) => other.parent_unit_id === unit.id));
  const brief = (entry: Commitment) => ({ id: entry.id, list_id: entry.list_id, project_id: entry.project_id, project_title: entry.project_title, title: entry.title, schedule: entry.schedule, committed_at: entry.committed_at });
  const units = (leaves.length ? leaves : [{ id: "", name: "", parent_unit_id: "", kind_id: "" }]).map((unit) => { const held = current.filter((entry) => (unit.id ? entry.unit?.id === unit.id : true)); return { unit_id: unit.id, name: unit.name, kind_id: unit.kind_id, parent_unit_id: unit.parent_unit_id, capacity: 1, committed: held.map(brief), available: held.length === 0 }; });
  const unplaced = leaves.length ? current.filter((entry) => !leaves.some((unit) => unit.id === entry.unit?.id)) : [];
  const capacity = units.length, used = current.length;
  return { assignee, capacity, committed: used, available: Math.max(0, capacity - used), over_committed: used > capacity, units, unplaced: unplaced.map(brief) };
}
