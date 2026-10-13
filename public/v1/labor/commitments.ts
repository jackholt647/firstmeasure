import { z } from "zod";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { readMaterialList, recordMaterialEvent } from "../materials/storage.js";
import { registerWorkEvents } from "../work/events.js";
import { listPaySheets } from "./pay-sheets.js";

/**
 * Committing a labor list hands it to whoever it is assigned to. The commitment is a frozen copy of what was sent:
 * later edits to the list never change it, and committing again makes a new revision that supersedes the last.
 *
 * What "hand it to them" means depends on the recipient. Two methods are fixed (share it inside FirstMate, or email a
 * work order). The third runs the recipient's own delivery code in the module sandbox; that code only plans steps
 * from a fixed set, and by default it asks someone to deliver the work by hand with a to-do.
 */
export const COMMITMENT_COLLECTION = "labor_commitments";
export const DELIVERY_SETTING_COLLECTION = "labor_delivery_settings";
/** Units inside an assignee: the groups within it that each do one job at a time. What a unit is called (crew, team, pod) comes from terminology, never from here. */
export const UNIT_COLLECTION = "assignee_units"; // assignee_units_v1
export const DELIVERY_METHODS = ["share", "work_order_email", "custom"] as const;
export type DeliveryMethod = typeof DELIVERY_METHODS[number];
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const subjectSchema = z.object({ type: z.enum(["organization_user", "resource_group", "organization_connection"]), id }).strict();
export const deliverySettingSchema = z.object({
  subject: subjectSchema,
  method: z.enum(DELIVERY_METHODS),
  /** Where a work order is emailed. A connection's own contact email is used when this is empty. */
  email: z.string().trim().max(320).email().or(z.literal("")).optional(),
  /** Delivery code for the custom method. It receives `inputs.commitment` and `inputs.recipient` and returns `{ outputs: { steps } }`. */
  source: z.string().max(64_000).optional()
}).strict();
export const commitInputSchema = z.object({ list_id: id, unit_id: id.optional(), note: z.string().trim().max(4000).optional(), idempotency_key: z.string().trim().max(200).optional() }).strict();
export type Subject = z.infer<typeof subjectSchema>;
export type DeliveryStep = { action: "todo"; title: string; body?: string; assigned_user_ids?: string[]; assigned_resource_group_ids?: string[] } | { action: "email"; to: string; subject: string; text: string; html?: string } | { action: "share" };

/** The default for a recipient with no delivery code of their own: someone delivers the work by hand. */
export const DEFAULT_CUSTOM_DELIVERY = `const c = inputs.commitment;
return { outputs: { steps: [{ action: "todo", title: "Send work to " + c.assignee.name, body: c.title + " on " + c.project_title + " is committed and has not been delivered. Open the project to send it." }] } };`;

let eventsRegistered = false;
function registerEvents() {
  if (eventsRegistered) return;
  eventsRegistered = true;
  registerWorkEvents([
    { name: "labor.list.committed", notification: { group: "materials", source: "materials", tab: "general" }, description: "A labor list was committed to its assignee.", visibility: "activity" },
    { name: "labor.list.delivered", notification: { group: "materials", source: "materials", tab: "general" }, description: "A committed labor list reached its recipient.", visibility: "activity" }
  ]);
}

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
/** An assignee is anyone work can be assigned to: a person, a group of users, or an outside company. Equipment is not one. */
const KIND_TO_TYPE: Record<string, Subject["type"]> = { resource_group: "resource_group", organization_connection: "organization_connection", organization_user: "organization_user", user: "organization_user" };

function requireCommit(orgId: string, auth: PlatformAuthContext) {
  if (!auth || auth.orgId !== orgId || !hasPermission(auth, "manage_projects")) throw forbidden("labor_commit_denied", "Committing labor requires project management access.");
}
function requireSettings(orgId: string, auth: PlatformAuthContext) {
  if (!auth || auth.orgId !== orgId || !hasPermission(auth, "manage_company_settings")) throw forbidden("labor_delivery_setting_denied", "Delivery settings require company settings access.");
}
const settingId = (subject: Subject) => `${subject.type}:${subject.id}`;

export async function listDeliverySettings(orgId: string) {
  return (await listDocuments(orgId, DELIVERY_SETTING_COLLECTION)).map((document) => ({ ...(document.data as unknown as z.infer<typeof deliverySettingSchema>), revision: Number(document.revision || 0) }));
}
export async function saveDeliverySetting(orgId: string, input: unknown, auth: PlatformAuthContext) {
  requireSettings(orgId, auth);
  const parsed = deliverySettingSchema.parse(input);
  const document = await upsertDocument(orgId, DELIVERY_SETTING_COLLECTION, { id: settingId(parsed.subject), data: { ...parsed, updated_by_user_id: auth.userId } as unknown as JsonObject, metadata: { kind: "labor_delivery_setting" } }, { replace: true });
  return { ...parsed, revision: Number((document as { revision?: number }).revision || 0) };
}
/**
 * How a recipient receives work when nothing has been chosen for them: people and groups inside the organization, and
 * subcontractors whose own organization is linked, are shared with; an unlinked subcontractor is emailed a work order.
 */
export function defaultDeliveryMethod(subject: Subject, connection?: JsonObject | null): DeliveryMethod {
  if (subject.type !== "organization_connection") return "share";
  return text(connection?.linked_organization_id) && text(connection?.link_status) === "active" ? "share" : "work_order_email";
}

export type Commitment = {
  id: string; list_id: string; project_id: string; project_title: string; title: string; revision: number;
  /** committed: the assignee holds this work. superseded: a later revision replaced it. released: the work is finished or was taken back. */
  status: "committed" | "superseded" | "released";
  /** The unit within the assignee this was committed to, when one was chosen. */
  unit: { id: string; name: string } | null;
  assignee: { type: Subject["type"]; id: string; name: string };
  lines: { id: string; name: string; quantity: number; unit: string; rate_cents: number | null; total_cents: number | null; kind: string }[];
  total_cents: number; pay_sheet: { id: string; revision: number } | null; schedule: JsonObject | null; note: string;
  committed_by_user_id: string; committed_at: string;
  delivery: { method: DeliveryMethod; status: "delivered" | "needs_attention" | "pending"; detail: string; steps: JsonObject[]; delivered_at?: string };
};
const row = (document: { id: string; data: JsonObject }) => ({ ...(document.data as unknown as Omit<Commitment, "id">), id: document.id }) as Commitment;
export async function listCommitments(orgId: string, filter: { project_id?: string; list_id?: string; subject?: Subject } = {}) {
  return (await listDocuments(orgId, COMMITMENT_COLLECTION)).map(row)
    .filter((entry) => (!filter.project_id || entry.project_id === filter.project_id) && (!filter.list_id || entry.list_id === filter.list_id) && (!filter.subject || (entry.assignee.type === filter.subject.type && entry.assignee.id === filter.subject.id)))
    .sort((a, b) => a.committed_at.localeCompare(b.committed_at));
}
/** What an assignee has been committed to and not released from: the basis for its availability. */
export async function currentCommitmentsFor(orgId: string, subject: Subject) {
  return (await listCommitments(orgId, { subject })).filter((entry) => entry.status === "committed");
}

function workOrder(commitment: Commitment) {
  const money = (cents: number | null) => (cents == null ? "" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const escape = (value: unknown) => text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const subject = `Work order - ${commitment.project_title}${commitment.revision > 1 ? ` (revision ${commitment.revision})` : ""}`;
  const rows = commitment.lines.map((line) => `${line.name}: ${line.quantity} ${line.unit}${line.rate_cents == null ? "" : ` at ${money(line.rate_cents)}`}${line.total_cents == null ? "" : ` = ${money(line.total_cents)}`}`);
  const body = [`Hello ${commitment.assignee.name},`, "", `Please find the work order for ${commitment.project_title}: ${commitment.title}.`, "", ...rows, "", `Total: ${money(commitment.total_cents)}`, ...(commitment.note ? ["", commitment.note] : [])].join("\n");
  const html = `<p>Hello ${escape(commitment.assignee.name)},</p><p>Please find the work order for ${escape(commitment.project_title)}: ${escape(commitment.title)}.</p><table cellpadding="6" style="border-collapse:collapse"><tr><th align="left">Work</th><th align="right">Qty</th><th align="left">Unit</th><th align="right">Rate</th><th align="right">Total</th></tr>${commitment.lines.map((line) => `<tr><td>${escape(line.name)}</td><td align="right">${line.quantity}</td><td>${escape(line.unit)}</td><td align="right">${money(line.rate_cents)}</td><td align="right">${money(line.total_cents)}</td></tr>`).join("")}<tr><td colspan="4" align="right"><strong>Total</strong></td><td align="right"><strong>${money(commitment.total_cents)}</strong></td></tr></table>${commitment.note ? `<p>${escape(commitment.note)}</p>` : ""}`;
  return { subject, text: body, html };
}

export type DeliveryEffects = {
  todo(body: JsonObject): Promise<unknown>;
  email(input: { to: string; subject: string; text: string; html?: string; idempotency_key: string }): Promise<unknown>;
  run(source: string, inputs: JsonObject): Promise<DeliveryStep[]>;
};
/** The real effects: a to-do, a project email, and the module sandbox for a recipient's own delivery code. */
export function platformDeliveryEffects(orgId: string, commitment: Pick<Commitment, "project_id">, auth: PlatformAuthContext): DeliveryEffects {
  return {
    todo: async (body) => (await import("../work/todos.js")).createTodo(orgId, { ...body, project_id: commitment.project_id }, auth),
    email: async (input) => (await import("../comms/service.js")).sendProjectEmail(orgId, text(auth.branchId) || "default", commitment.project_id, input, auth),
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

/** Carries a commitment to its recipient and reports what happened. A step that cannot run leaves the delivery needing attention; it never reports delivered. */
export async function deliverCommitment(commitment: Commitment, setting: { method: DeliveryMethod; email?: string; source?: string }, recipient: { email: string }, effects: DeliveryEffects): Promise<Commitment["delivery"]> {
  const steps: JsonObject[] = [];
  const done = (detail: string): Commitment["delivery"] => ({ method: setting.method, status: "delivered", detail, steps, delivered_at: new Date().toISOString() });
  const attention = (detail: string): Commitment["delivery"] => ({ method: setting.method, status: "needs_attention", detail, steps });
  const order = workOrder(commitment);
  try {
    let plan: DeliveryStep[];
    if (setting.method === "share") plan = [{ action: "share" }];
    else if (setting.method === "work_order_email") {
      const to = text(setting.email) || recipient.email;
      if (!to) return attention(`There is no email address for ${commitment.assignee.name}.`);
      plan = [{ action: "email", to, ...order }];
    } else plan = await effects.run(text(setting.source) || DEFAULT_CUSTOM_DELIVERY, { commitment: commitment as unknown as JsonObject, recipient: { ...recipient, name: commitment.assignee.name, type: commitment.assignee.type }, work_order: order });
    if (!plan.length) return attention("The delivery code planned no steps.");
    for (const [index, step] of plan.entries()) {
      if (step.action === "share") steps.push({ action: "share" });
      else if (step.action === "todo") { await effects.todo({ id: `labor_delivery_${commitment.id}_${index}`, title: step.title, body: step.body || "", assigned_user_ids: step.assigned_user_ids || [], assigned_resource_group_ids: step.assigned_resource_group_ids || [] }); steps.push({ action: "todo", title: step.title }); }
      else { await effects.email({ to: step.to, subject: step.subject, text: step.text, html: step.html, idempotency_key: `labor_commitment:${commitment.id}:${index}` }); steps.push({ action: "email", to: step.to, subject: step.subject }); }
    }
    // A to-do asking someone to send the work is not the work arriving.
    if (steps.every((step) => step.action === "todo")) return { method: setting.method, status: "pending", detail: "A to-do was created to deliver this work by hand.", steps };
    return done(steps.some((step) => step.action === "email") ? "The work order was emailed." : `Shared with ${commitment.assignee.name}.`);
  } catch (error) {
    return attention(error instanceof Error ? error.message : "Delivery failed.");
  }
}

/** Freezes a labor list as it stands and hands it to whoever it is assigned to. */
export async function commitLaborList(orgId: string, input: unknown, auth: PlatformAuthContext, effects?: DeliveryEffects) {
  requireCommit(orgId, auth);
  registerEvents();
  const parsed = commitInputSchema.parse(input);
  const list = await readMaterialList(orgId, parsed.list_id);
  if (text(list.resource_type) !== "labor") throw badRequest("labor_commit_not_labor", "Only a labor list can be committed to a unit.");
  const reference = obj(obj(list.assignment).work_resource_ref);
  const type = KIND_TO_TYPE[text(reference.kind)];
  if (!text(reference.id) || !type) throw badRequest("labor_commit_unassigned", "Assign this list before committing it.");
  const items = (Array.isArray(list.current_items) ? list.current_items : []).map(obj);
  if (!items.length) throw badRequest("labor_commit_empty", "There is nothing on this list to commit.");
  const subject: Subject = { type, id: text(reference.id) };
  const unitId = parsed.unit_id || text(obj(list.assignment).unit_id);
  const unitRow = unitId ? (await listUnits(orgId, subject)).find((entry) => entry.id === unitId) : null;
  if (unitId && !unitRow) throw badRequest("labor_commit_unit_unknown", "That unit does not belong to the assignee this list is assigned to.");
  const unit = unitRow ? { id: unitRow.id, name: unitRow.name } : null;
  const cents = (value: unknown) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.round(Number(value) * 100) : null);
  const lines = items.map((item) => { const quantity = Number(item.quantity) || 0, rate = cents(item.projected_unit_price); return { id: text(item.id), name: text(item.name), quantity, unit: text(item.unit), rate_cents: rate, total_cents: rate == null ? null : Math.round(quantity * rate), kind: text(obj(item.metadata).compensation_kind) }; });
  const previous = await listCommitments(orgId, { list_id: parsed.list_id });
  const project = await readDocument(orgId, "projects", text(list.project_id)).catch(() => null);
  const connection = subject.type === "organization_connection" ? await (await import("../connections/storage.js")).readOrganizationConnection(orgId, subject.id).catch(() => null) : null;
  const sheet = (await listPaySheets(orgId)).find((entry) => entry.subject.type === subject.type && entry.subject.id === subject.id) || null;
  const stored = (await listDeliverySettings(orgId)).find((entry) => entry.subject.type === subject.type && entry.subject.id === subject.id) || null;
  const setting = stored || { method: defaultDeliveryMethod(subject, connection) };
  const now = new Date().toISOString();
  const draft: Commitment = {
    id: "", list_id: parsed.list_id, project_id: text(list.project_id), project_title: text(obj(project?.data).title || obj(project?.data).address) || "the project", title: text(list.title) || "Labor",
    revision: previous.length + 1, status: "committed", unit, assignee: { ...subject, name: text(reference.name) || text(connection?.name) || "the assignee" },
    lines, total_cents: lines.reduce((sum, line) => sum + (line.total_cents || 0), 0), pay_sheet: sheet ? { id: sheet.id, revision: sheet.revision } : null,
    schedule: Object.keys(obj(list.schedule)).length ? obj(list.schedule) : null, note: parsed.note || "", committed_by_user_id: text(auth.userId), committed_at: now,
    delivery: { method: setting.method, status: "pending", detail: "", steps: [] }
  };
  const { id: _draftId, ...data } = draft;
  const saved = await upsertDocument(orgId, COMMITMENT_COLLECTION, { data: data as unknown as JsonObject, metadata: { kind: "labor_commitment", list_id: draft.list_id, project_id: draft.project_id, subject_type: subject.type, subject_id: subject.id } }, { replace: true });
  const commitment: Commitment = { ...draft, id: saved.id };
  for (const earlier of previous.filter((entry) => entry.status === "committed")) { const { id: earlierId, ...rest } = earlier; await upsertDocument(orgId, COMMITMENT_COLLECTION, { id: earlierId, data: { ...rest, status: "superseded", superseded_by: commitment.id } as unknown as JsonObject, metadata: { kind: "labor_commitment", list_id: earlier.list_id, project_id: earlier.project_id } }, { replace: true }); }
  const contacts = Array.isArray(connection?.contacts) ? connection!.contacts as unknown[] : [];
  const recipientEmail = text(contacts.map(obj).find((contact) => text(contact.email))?.email);
  commitment.delivery = await deliverCommitment(commitment, setting, { email: recipientEmail }, effects || platformDeliveryEffects(orgId, commitment, auth));
  const { id: commitmentId, ...final } = commitment;
  await upsertDocument(orgId, COMMITMENT_COLLECTION, { id: commitmentId, data: final as unknown as JsonObject, metadata: { kind: "labor_commitment", list_id: commitment.list_id, project_id: commitment.project_id, subject_type: subject.type, subject_id: subject.id } }, { replace: true });
  await recordMaterialEvent(orgId, commitment.list_id, "labor_commitment.created", { commitment_id: commitment.id, revision: commitment.revision, delivery_method: commitment.delivery.method, delivery_status: commitment.delivery.status }, auth).catch(() => null);
  const { emitWorkEvent } = await import("../work/engine.js");
  const event = (name: string) => emitWorkEvent({ organization_id: orgId, branch_id: text(list.branch_id) || "default", project_id: commitment.project_id, type: name, idempotency_key: `${name}:${commitment.id}`, payload: { commitment_id: commitment.id, list_id: commitment.list_id, revision: commitment.revision, assignee: commitment.assignee, total_cents: commitment.total_cents, delivery_method: commitment.delivery.method, delivery_status: commitment.delivery.status } }).catch(() => null);
  await event("labor.list.committed");
  if (commitment.delivery.status === "delivered") await event("labor.list.delivered");
  return commitment;
}

/** Finished or taken back: the assignee no longer holds this work, so its capacity is free again. */
export async function releaseCommitment(orgId: string, input: unknown, auth: PlatformAuthContext) {
  requireCommit(orgId, auth);
  const parsed = z.object({ id, reason: z.string().trim().max(500).optional() }).strict().parse(input);
  const current = (await listCommitments(orgId)).find((entry) => entry.id === parsed.id);
  if (!current) throw badRequest("labor_commitment_unknown", "This commitment is unavailable.");
  if (current.status !== "committed") return current;
  const { id: commitmentId, ...rest } = current;
  const released = { ...rest, status: "released" as const, released_at: new Date().toISOString(), released_by_user_id: text(auth.userId), release_reason: parsed.reason || "" };
  await upsertDocument(orgId, COMMITMENT_COLLECTION, { id: commitmentId, data: released as unknown as JsonObject, metadata: { kind: "labor_commitment", list_id: current.list_id, project_id: current.project_id, subject_type: current.assignee.type, subject_id: current.assignee.id } }, { replace: true });
  return { ...released, id: commitmentId } as Commitment;
}

// ---- Units inside an assignee ----
export const unitInputSchema = z.object({
  id: id.optional(),
  assignee: subjectSchema,
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
export async function saveUnit(orgId: string, input: unknown, auth: PlatformAuthContext) {
  requireSettings(orgId, auth);
  const parsed = unitInputSchema.parse(input);
  const siblings = await listUnits(orgId, parsed.assignee);
  const existing = parsed.id ? siblings.find((unit) => unit.id === parsed.id) || null : null;
  if (parsed.id && !existing) throw badRequest("assignee_unit_unknown", "This unit is unavailable.");
  if (parsed.parent_unit_id) {
    // The parent must be another unit of the same assignee, and following parents upward must never come back here.
    let cursor: Unit | undefined = siblings.find((unit) => unit.id === parsed.parent_unit_id);
    if (!cursor) throw badRequest("assignee_unit_parent_unknown", "The parent unit must belong to the same assignee.");
    for (let depth = 0; cursor; depth += 1) { if (cursor.id === parsed.id || depth > 20) throw badRequest("assignee_unit_cycle", "A unit cannot sit under itself."); const parentId: string = cursor.parent_unit_id; cursor = parentId ? siblings.find((unit) => unit.id === parentId) : undefined; }
  }
  const document = await upsertDocument(orgId, UNIT_COLLECTION, { ...(existing ? { id: existing.id, expected_revision: parsed.expected_revision ?? existing.revision } : {}), data: { assignee: parsed.assignee, parent_unit_id: parsed.parent_unit_id || "", name: parsed.name, kind_id: parsed.kind_id || "", updated_by_user_id: auth.userId } as unknown as JsonObject, metadata: { kind: "assignee_unit", subject_type: parsed.assignee.type, subject_id: parsed.assignee.id } }, { replace: true });
  return { id: document.id, assignee: parsed.assignee, parent_unit_id: parsed.parent_unit_id || "", name: parsed.name, kind_id: parsed.kind_id || "", revision: Number((document as { revision?: number }).revision || 0) } as Unit;
}
export async function archiveUnit(orgId: string, input: unknown, auth: PlatformAuthContext) {
  requireSettings(orgId, auth);
  const parsed = z.object({ id }).strict().parse(input);
  const document = (await listDocuments(orgId, UNIT_COLLECTION)).find((entry) => entry.id === parsed.id && !entry.data.archived_at);
  if (!document) throw badRequest("assignee_unit_unknown", "This unit is unavailable.");
  if ((await listUnits(orgId)).some((unit) => unit.parent_unit_id === parsed.id)) throw badRequest("assignee_unit_has_children", "Move or remove the units under this one first.");
  await upsertDocument(orgId, UNIT_COLLECTION, { id: parsed.id, data: { ...document.data, archived_at: new Date().toISOString(), archived_by_user_id: auth.userId }, metadata: { kind: "assignee_unit" } }, { replace: true });
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
  const units = (leaves.length ? leaves : [{ id: "", name: "", parent_unit_id: "" }]).map((unit) => { const held = current.filter((entry) => (unit.id ? entry.unit?.id === unit.id : true)); return { unit_id: unit.id, name: unit.name, parent_unit_id: unit.parent_unit_id, capacity: 1, committed: held.map(brief), available: held.length === 0 }; });
  const unplaced = leaves.length ? current.filter((entry) => !leaves.some((unit) => unit.id === entry.unit?.id)) : [];
  const capacity = units.length, used = current.length;
  return { assignee, capacity, committed: used, available: Math.max(0, capacity - used), over_committed: used > capacity, units, unplaced: unplaced.map(brief) };
}
