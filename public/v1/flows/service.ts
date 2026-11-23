import { randomUUID } from "node:crypto";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { evaluateConditions } from "../work/conditions.js";
import { emitWorkEvent } from "../work/engine.js";
import { libraryEntries } from "../config-library/library.js";
import { flowDefinitionSchema, runSourceSchema, type FlowBlock, type FlowDefinition, type FlowStep } from "./contracts.js";
import { archiveHead, insertRun, listHeads, listRuns, readHead, readRun, readVersion, updateRun, writeVersion, type FlowRun, type FlowVersion } from "./storage.js";

/**
 * Flows: definitions and runs (docs/architecture/flows.md). A run is server-authoritative: the browser sends one step's
 * answers, this validates them against the version the run started on, finds or makes the records the step names,
 * writes answers to their fields, and decides where to go. A step's `action` blocks and an outcome's effects run in the
 * work engine (`flow.step.completed`, `flow.run.completed`, work/engine.ts), like organization rules, so flows add no
 * second automation runtime.
 */
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const now = () => new Date().toISOString();
export const FLOW_TEMPLATE_KIND = "flow_template";

/** Who may edit flows: company settings, or communications (call scripts were edited with it). */
export function canEditFlows(auth: PlatformAuthContext) {
  return hasPermission(auth, "manage_company_settings") || hasPermission(auth, "manage_communications");
}
function requireEditor(auth: PlatformAuthContext) {
  if (!canEditFlows(auth)) throw forbidden("flows_edit_denied", "Editing flows needs company settings or communications access.");
}
/** Playing a flow can find and create contacts and leads, so it needs the same access as making a project. */
function requirePlayer(auth: PlatformAuthContext) {
  if (!hasPermission(auth, "manage_projects") && !hasPermission(auth, "view_projects")) throw forbidden("flows_play_denied", "Playing a flow needs project access.");
}

export function parseFlow(value: unknown): FlowDefinition {
  const parsed = flowDefinitionSchema.safeParse(value);
  if (!parsed.success) throw badRequest("flow_invalid", parsed.error.issues[0]?.message || "This flow is not valid.", { issues: parsed.error.issues.slice(0, 12).map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  return parsed.data;
}

function summary(head: { id: string; latest_version: number; published_version: number; archived: boolean; updated_at: string }, version: FlowVersion | null) {
  const definition = object(version?.definition);
  return { id: head.id, name: text(version?.name), kind: text(version?.kind) || "workflow", icon: text(definition.icon), color: text(definition.color), description: text(definition.description),
    latest_version: head.latest_version, published_version: head.published_version, archived: head.archived, updated_at: head.updated_at, entry: object(definition.entry) };
}

export async function listFlows(auth: PlatformAuthContext, options: { includeArchived?: boolean } = {}) {
  const heads = (await listHeads(auth.orgId)).filter((head) => options.includeArchived || !head.archived);
  const versions = await Promise.all(heads.map((head) => readVersion(auth.orgId, head.id, head.latest_version)));
  return heads.map((head, index) => summary(head, versions[index] || null));
}

/** The flow as it plays (its published version) or, for an editor, its newest version. */
export async function readFlow(org: string, id: string, options: { version?: number; latest?: boolean } = {}) {
  const head = await readHead(org, id);
  if (!head) throw notFound("flow_not_found", "This flow does not exist.");
  const version = options.version || (options.latest ? head.latest_version : head.published_version);
  if (!version) throw notFound("flow_not_published", "This flow has not been published yet.");
  const found = await readVersion(org, id, version);
  if (!found) throw notFound("flow_version_not_found", "This version of the flow does not exist.");
  return { ...summary(head, found), version: found.version, status: found.status, definition: parseFlow(found.definition) };
}

export async function saveFlow(auth: PlatformAuthContext, input: { id?: string; definition?: unknown; publish?: boolean; expected_version?: number }) {
  requireEditor(auth);
  const definition = parseFlow(input.definition);
  const id = text(input.id) || `flow_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw badRequest("flow_id_invalid", "A flow id uses letters, numbers, dots, dashes and underscores.");
  const saved = await writeVersion(auth.orgId, id, { name: definition.name, kind: definition.kind, definition: definition as unknown as JsonObject, publish: input.publish !== false, authorId: auth.userId,
    ...(input.expected_version !== undefined ? { expectedVersion: Number(input.expected_version) } : {}) });
  if (saved.conflict) throw conflict("flow_changed", "This flow changed since you opened it. Reload it before saving.", { latest_version: saved.latest });
  return readFlow(auth.orgId, id, { version: saved.version });
}

export async function archiveFlow(auth: PlatformAuthContext, id: string, archived = true) {
  requireEditor(auth);
  if (!(await readHead(auth.orgId, id))) throw notFound("flow_not_found", "This flow does not exist.");
  await archiveHead(auth.orgId, id, archived);
  return { id, archived };
}

/** Library flow templates (config library kind `flow_template`): starting points an organization copies. */
export function flowTemplates() {
  return libraryEntries<JsonObject>(FLOW_TEMPLATE_KIND).map((entry) => ({ id: entry.id, title: text(entry.title), definition: object(entry.data.definition), description: text(entry.data.description) }));
}

/** The flows offered in the New menu for this person: published, not archived, `entry.new_menu.enabled`, their roles. */
export async function newMenuFlows(auth: PlatformAuthContext) {
  const roles = new Set([text(auth.role), ...((auth.accessProfile?.access_role_ids || []) as string[]).map(text)]);
  return (await listFlows(auth)).filter((flow) => flow.published_version > 0)
    .map((flow) => ({ flow, entry: object(object(flow.entry).new_menu) }))
    .filter(({ entry }) => entry.enabled === true && (!Array.isArray(entry.role_ids) || !entry.role_ids.length || hasPermission(auth, "manage_company_settings") || (entry.role_ids as string[]).some((role) => roles.has(text(role)))))
    .sort((a, b) => Number(a.entry.sort_order || 0) - Number(b.entry.sort_order || 0) || a.flow.name.localeCompare(b.flow.name))
    .map(({ flow, entry }) => ({ id: flow.id, label: text(entry.label) || flow.name, icon: text(entry.icon) || flow.icon || "fa-diagram-project", kind: flow.kind }));
}

// ── Runs ──────────────────────────────────────────────────────────────────

type Loaded = { run: FlowRun; definition: FlowDefinition; contact: JsonObject; project: JsonObject };

async function contactRecord(org: string, id: string) {
  if (!id) return {};
  const { readContact } = await import("../contacts/records.js");
  return object(await readContact(org, id).catch(() => ({})));
}
async function projectRecord(org: string, id: string) {
  if (!id) return {};
  const document = await readDocument(org, "projects", id).catch(() => null);
  return document ? { id: document.id, revision: document.revision, ...object(document.data) } : {};
}

async function load(auth: PlatformAuthContext, runId: string): Promise<Loaded> {
  const run = await readRun(auth.orgId, runId);
  if (!run) throw notFound("flow_run_not_found", "This run does not exist.");
  if (run.started_by !== auth.userId && !canEditFlows(auth)) throw forbidden("flow_run_denied", "This run belongs to someone else.");
  const version = await readVersion(auth.orgId, run.flow_id, run.flow_version);
  if (!version) throw notFound("flow_version_not_found", "The version of the flow this run started on is gone.");
  return { run, definition: parseFlow(version.definition), contact: await contactRecord(auth.orgId, run.contact_id), project: await projectRecord(auth.orgId, run.project_id) };
}

/** What templates and conditions read: answers, the run's records, the run and the person. */
function contextOf(auth: PlatformAuthContext, loaded: Loaded): JsonObject {
  const user = object(auth.user), organization = object(auth.organization);
  return {
    answers: loaded.run.answers, contact: loaded.contact, project: loaded.project,
    run: { id: loaded.run.id, kind: loaded.definition.kind, call_id: loaded.run.call_id, source: loaded.run.source, started_by: loaded.run.started_by },
    user: { id: auth.userId, name: text(user.name || user.display_name || [user.first_name, user.last_name].filter(Boolean).join(" ")), first_name: text(user.first_name) },
    organization: { id: auth.orgId, name: text(organization.name || organization.company_name) }
  };
}
const pathValue = (context: JsonObject, path: string) => path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as JsonObject)[key] : undefined, context);
/** `{{answers.name}}`, `{{contact.first_name}}`, `{{organization.name}}`; a template that names nothing becomes empty. */
export function fill(value: string, context: JsonObject) {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) => { const found = pathValue(context, path); return found === undefined || found === null || typeof found === "object" ? "" : String(found); });
}
/** Fills only the flow's own heads (answers, run, user); project, contact and organization stay for the work engine. */
function fillOwn(value: unknown, context: JsonObject): unknown {
  if (typeof value === "string") return value.replace(/\{\{\s*((answers|run|user)\.[A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) => { const found = pathValue(context, path); return found === undefined || found === null ? "" : typeof found === "object" ? JSON.stringify(found) : String(found); });
  if (Array.isArray(value)) return value.map((entry) => fillOwn(entry, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillOwn(entry, context)]));
  return value;
}

function stepOf(definition: FlowDefinition, id: string) {
  const step = definition.steps.find((entry) => entry.id === id);
  if (!step) throw badRequest("flow_step_missing", `This flow has no step "${id}".`);
  return step;
}

/** One answer, coerced to its input; throws with the question's label when it does not fit. */
function answerFor(block: Extract<FlowBlock, { kind: "ask" | "choice" }>, raw: unknown) {
  const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length);
  const name = block.label || block.key;
  if (empty) { if (block.required) throw badRequest("flow_answer_required", `${name} needs an answer.`); return undefined; }
  const ids = new Set(block.options.map((option) => option.id));
  if (block.kind === "choice" || (block.kind === "ask" && block.input === "select")) {
    if (!ids.has(text(raw))) throw badRequest("flow_answer_invalid", `${name}: pick one of the choices.`);
    return text(raw);
  }
  switch (block.input) {
    case "multi": { const list = (Array.isArray(raw) ? raw : [raw]).map(text); if (list.some((entry) => !ids.has(entry))) throw badRequest("flow_answer_invalid", `${name}: pick from the choices.`); return list; }
    case "number": case "money": { const number = Number(raw); if (!Number.isFinite(number)) throw badRequest("flow_answer_invalid", `${name} needs a number.`); return number; }
    case "yes_no": return raw === true || raw === "yes" || raw === "true";
    case "email": { const value = text(raw).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw badRequest("flow_answer_invalid", `${name} needs an email address.`); return value; }
    default: return text(raw).slice(0, 4000);
  }
}

/** The step drawn for the player: say/note text filled from the run, everything the person needs and nothing else. */
function stepView(step: FlowStep, context: JsonObject) {
  return { id: step.id, title: fill(step.title, context), blocks: step.blocks.map((block) => {
    if (block.kind === "say" || block.kind === "note") return { ...block, text: fill(block.text, context) };
    if (block.kind === "action") return { id: block.id, kind: block.kind, label: fill(block.label, context), preview: fill(block.preview, context), explainer: block.explainer };
    return block;
  }) };
}

export function runView(auth: PlatformAuthContext, loaded: Loaded) {
  const context = contextOf(auth, loaded);
  const { run, definition } = loaded;
  const outcome = definition.outcomes.find((entry) => entry.id === run.outcome_id);
  return {
    run: { id: run.id, flow_id: run.flow_id, flow_version: run.flow_version, status: run.status, step_id: run.step_id, path: run.path, answers: run.answers,
      contact_id: run.contact_id, project_id: run.project_id, call_id: run.call_id, outcome_id: run.outcome_id, revision: run.revision, started_at: run.started_at, finished_at: run.finished_at },
    flow: { id: run.flow_id, name: definition.name, kind: definition.kind, icon: definition.icon, color: definition.color },
    step: stepView(stepOf(definition, run.step_id), context),
    can_back: run.status === "open" && run.path.length > 0,
    contact: loaded.contact.id ? { id: loaded.contact.id, name: text(loaded.contact.name) } : null,
    project: loaded.project.id ? { id: loaded.project.id, title: text(loaded.project.title || loaded.project.address) } : null,
    outcome: outcome ? { id: outcome.id, label: outcome.label, color: outcome.color } : null
  };
}

export async function startRun(auth: PlatformAuthContext, input: { flow_id: string; source?: unknown }) {
  requirePlayer(auth);
  const flow = await readFlow(auth.orgId, text(input.flow_id));
  const source = runSourceSchema.parse(input.source || {});
  if (source.project_id) await readDocument(auth.orgId, "projects", source.project_id);
  const time = now();
  const run: FlowRun = { id: `flowrun_${randomUUID().replace(/-/g, "")}`, flow_id: flow.id, flow_version: flow.version, status: "open", step_id: flow.definition.start, path: [], answers: {},
    contact_id: text(source.contact_id), project_id: text(source.project_id), call_id: text(source.call_id), outcome_id: "", source, started_by: auth.userId,
    started_at: time, updated_at: time, finished_at: "", revision: 1 };
  await insertRun(auth.orgId, run);
  return runView(auth, { run, definition: flow.definition, contact: await contactRecord(auth.orgId, run.contact_id), project: await projectRecord(auth.orgId, run.project_id) });
}

export async function readRunView(auth: PlatformAuthContext, runId: string) {
  return runView(auth, await load(auth, runId));
}

/** `from` maps a record field to `answers.<key>` (or any context path); the first contact field that has a value wins. */
function fromAnswers(from: Record<string, string>, context: JsonObject) {
  return Object.fromEntries(Object.entries(from).map(([field, path]) => [field, pathValue(context, path.replace(/^\{\{\s*|\s*\}\}$/g, ""))])
    .filter(([, value]) => value !== undefined && value !== null && text(value) !== ""));
}

async function findOrMakeContact(auth: PlatformAuthContext, loaded: Loaded, block: Extract<FlowBlock, { kind: "contact" }>) {
  const fields = fromAnswers(block.from, contextOf(auth, loaded));
  const records = await import("../contacts/records.js");
  if (block.mode !== "create") {
    if (loaded.contact.id) return loaded.contact;
    const match = (await records.findExactMatches(auth.orgId, fields))[0];
    if (match) return object(match);
    if (block.mode === "find") throw badRequest("flow_contact_not_found", "No contact has that email or phone.");
  }
  if (!hasPermission(auth, "manage_projects")) throw forbidden("flow_contact_create_denied", "Making a contact needs project access.");
  return object(await records.createContact(auth.orgId, { ...fields, branch_ids: [auth.branchId || "default"] }));
}

async function findOrMakeProject(auth: PlatformAuthContext, loaded: Loaded, block: Extract<FlowBlock, { kind: "project" }>) {
  if (loaded.project.id && block.mode !== "create_project" && block.mode !== "create_lead") return loaded.project;
  if (block.mode === "find") throw badRequest("flow_project_not_found", "This run has no project to work on.");
  if (!hasPermission(auth, "manage_projects")) throw forbidden("flow_project_create_denied", "Making a project needs project access.");
  const fields = fromAnswers(block.from, contextOf(auth, loaded));
  const branchId = auth.branchId || "default";
  if (block.mode === "create_project") {
    const { createProject } = await import("../projects/create.js");
    const document = await createProject(auth.orgId, { data: { branch_id: branchId, title: text(fields.title || fields.address) || "New project", address: text(fields.address), summary: text(fields.summary) },
      ...(block.template_id ? { scope_template_id: block.template_id } : {}) });
    if (loaded.contact.id) {
      const { setProjectContactLinks, refreshProjections } = await import("../contacts/records.js");
      await setProjectContactLinks(auth.orgId, document.id, [{ contact_id: text(loaded.contact.id), role: "", primary: true }]);
      await refreshProjections(auth.orgId, [document.id]);
    }
    return projectRecord(auth.orgId, document.id);
  }
  // A lead through canonical intake: routing and lead.received run, recorded as entered by this person.
  const { receiveLead } = await import("../leads/receive.js");
  const flow = loaded.definition;
  const result = await receiveLead(auth.orgId, { branch_id: branchId, source: { kind: "manual_lead", provider: flow.name, entered_by_user_id: auth.userId, flow_id: loaded.run.flow_id, flow_run_id: loaded.run.id },
    contacts: loaded.contact.id ? [{ contact_id: text(loaded.contact.id) }] as never : [], address: text(fields.address), title: text(fields.title), summary: text(fields.summary),
    notification: false });
  return projectRecord(auth.orgId, text(object(result.project).id));
}

/** Answers with `saves_to` are written through the contact and project writers when their step is left. */
async function writeAnswers(auth: PlatformAuthContext, loaded: Loaded, step: FlowStep) {
  const contact: JsonObject = {}, contactFields: JsonObject = {}, projectFields: JsonObject = {}, projectPatch: JsonObject = {};
  for (const block of step.blocks) {
    if (block.kind !== "ask" || !block.saves_to || !Object.hasOwn(loaded.run.answers, block.key)) continue;
    const [entity, ...rest] = block.saves_to.split("."), field = rest.join("."), value = loaded.run.answers[block.key];
    if (entity === "contact") { if (field.startsWith("cf.")) contactFields[field.slice(3)] = value; else contact[field] = value; }
    else if (field.startsWith("cf.")) projectFields[field.slice(3)] = value; else projectPatch[field] = value;
  }
  if ((Object.keys(contact).length || Object.keys(contactFields).length) && loaded.contact.id) {
    const { updateContact } = await import("../contacts/records.js");
    const existing = object(loaded.contact.custom_field_values);
    await updateContact(auth.orgId, text(loaded.contact.id), { ...contact, ...(Object.keys(contactFields).length ? { custom_field_values: { ...existing, ...contactFields } } : {}) });
  }
  if (loaded.project.id && Object.keys(projectPatch).length) {
    const { patchProjectDocument } = await import("../work/automations/builtins.js");
    await patchProjectDocument(auth.orgId, text(loaded.project.id), projectPatch);
  }
  if (loaded.project.id && Object.keys(projectFields).length) {
    const { userPublicationContext } = await import("../platform/publication/context.js");
    const { invokeAction } = await import("../platform/publication/actions.js");
    const project = await readDocument(auth.orgId, "projects", text(loaded.project.id));
    await invokeAction(userPublicationContext(auth, { projectId: project.id }), { action: "custom-fields.project.write", target: { scope: "project", organizationId: auth.orgId, projectId: project.id } },
      { values: projectFields, expectedRevision: Number(project.revision) }, { idempotencyKey: `flow:${loaded.run.id}:${step.id}:${loaded.run.revision}` });
  }
}

/** Where a step goes: a choice option that jumps or ends wins, then the step's own `next` (branches use the one condition contract). */
function resolveNext(step: FlowStep, context: JsonObject): { to: string | null; outcome: string | null } {
  for (const block of step.blocks) {
    if (block.kind === "outcome") return { to: null, outcome: block.outcome };
    if (block.kind !== "choice") continue;
    const picked = block.options.find((option) => option.id === text(object(context.answers)[block.key]));
    if (picked?.outcome) return { to: null, outcome: picked.outcome };
    if (picked?.to) return { to: picked.to, outcome: null };
  }
  const next = step.next;
  if (next === null || next === undefined) return { to: null, outcome: null };
  if (typeof next === "string") return { to: next, outcome: null };
  for (const branch of next.branches) if (evaluateConditions(branch.when, context)) return { to: branch.to, outcome: null };
  return { to: next.otherwise, outcome: null };
}

async function emit(auth: PlatformAuthContext, loaded: Loaded, type: string, payload: JsonObject) {
  await emitWorkEvent({ organization_id: auth.orgId, branch_id: text(loaded.project.branch_id) || auth.branchId || "default", project_id: text(loaded.project.id) || undefined, type,
    payload: { flow_id: loaded.run.flow_id, flow_version: loaded.run.flow_version, run_id: loaded.run.id, contact_id: loaded.run.contact_id, started_by: loaded.run.started_by, ...payload },
    idempotency_key: `flow:${loaded.run.id}:${type}:${text(payload.step_id) || text(payload.outcome_id)}:${loaded.run.path.length}` });
}

/**
 * Answers one step and moves on. Records the step's answers, finds or makes its records, writes answers to their fields,
 * hands its actions to the work engine, then goes to the next step or ends the run with an outcome.
 */
export async function advanceRun(auth: PlatformAuthContext, runId: string, input: { step_id: string; answers?: unknown; revision?: number }) {
  requirePlayer(auth);
  const loaded = await load(auth, runId);
  const { run, definition } = loaded;
  if (run.status !== "open") throw conflict("flow_run_finished", "This run has already finished.");
  if (text(input.step_id) !== run.step_id) throw conflict("flow_run_moved", "This run is on another step. Reload it.");
  const revision = run.revision;
  if (input.revision !== undefined && Number(input.revision) !== revision) throw conflict("flow_run_moved", "This run changed in another window. Reload it.");
  const step = stepOf(definition, run.step_id);
  const given = object(input.answers);
  for (const block of step.blocks) {
    if (block.kind !== "ask" && block.kind !== "choice") continue;
    const value = answerFor(block, given[block.key]);
    if (value === undefined) delete run.answers[block.key]; else run.answers[block.key] = value as never;
  }
  for (const block of step.blocks) {
    if (block.kind === "contact") { loaded.contact = await findOrMakeContact(auth, loaded, block); run.contact_id = text(loaded.contact.id); }
    if (block.kind === "project") { loaded.project = await findOrMakeProject(auth, loaded, block); run.project_id = text(loaded.project.id); }
  }
  await writeAnswers(auth, loaded, step);
  const context = contextOf(auth, loaded);
  const actions = step.blocks.filter((block): block is Extract<FlowBlock, { kind: "action" }> => block.kind === "action");
  if (actions.length) await emit(auth, loaded, "flow.step.completed", { step_id: step.id, answers: run.answers });
  const next = resolveNext(step, context);
  const time = now();
  run.updated_at = time;
  if (next.to) { run.path = [...run.path, run.step_id]; run.step_id = next.to; }
  else {
    run.status = "done"; run.finished_at = time;
    if (next.outcome) run.outcome_id = next.outcome;
  }
  if (!(await updateRun(auth.orgId, run, revision))) throw conflict("flow_run_moved", "This run changed in another window. Reload it.");
  run.revision = revision + 1;
  if (run.status === "done") {
    await emit(auth, loaded, "flow.run.completed", { outcome_id: run.outcome_id, answers: run.answers });
  }
  return runView(auth, loaded);
}

/** Back one step along the way taken; answers are kept so going forward again shows them. */
export async function backRun(auth: PlatformAuthContext, runId: string) {
  const loaded = await load(auth, runId);
  const { run } = loaded;
  if (run.status !== "open" || !run.path.length) throw conflict("flow_run_cannot_back", "There is no step to go back to.");
  const revision = run.revision;
  run.step_id = run.path[run.path.length - 1]!; run.path = run.path.slice(0, -1); run.updated_at = now();
  if (!(await updateRun(auth.orgId, run, revision))) throw conflict("flow_run_moved", "This run changed in another window. Reload it.");
  run.revision = revision + 1;
  return runView(auth, loaded);
}

export async function abandonRun(auth: PlatformAuthContext, runId: string) {
  const loaded = await load(auth, runId);
  const { run } = loaded;
  if (run.status !== "open") return runView(auth, loaded);
  const revision = run.revision;
  run.status = "abandoned"; run.finished_at = run.updated_at = now();
  if (!(await updateRun(auth.orgId, run, revision))) throw conflict("flow_run_moved", "This run changed in another window. Reload it.");
  run.revision = revision + 1;
  return runView(auth, loaded);
}

/**
 * What a flow event asks the work engine to run, read again from the stored flow version (never from the event): a
 * step's `action` blocks (`flow.step.completed`) or an outcome's effects (`flow.run.completed`), with the flow's own
 * templates filled from the run's answers. Project, contact and organization templates are left for the engine.
 */
export async function flowAutomationsForEvent(event: JsonObject): Promise<Array<{ id: string; automation: string; input: JsonObject; conditions: unknown }>> {
  const type = text(event.type), payload = object(event.payload), org = text(event.organization_id);
  if (type !== "flow.step.completed" && type !== "flow.run.completed") return [];
  const run = await readRun(org, text(payload.run_id));
  if (!run || run.flow_id !== text(payload.flow_id)) return [];
  const version = await readVersion(org, run.flow_id, run.flow_version);
  if (!version) return [];
  const definition = parseFlow(version.definition);
  const context = { answers: run.answers, run: { id: run.id, kind: definition.kind, call_id: run.call_id, started_by: run.started_by }, user: { id: run.started_by } };
  if (type === "flow.step.completed") {
    const step = definition.steps.find((entry) => entry.id === text(payload.step_id));
    return (step?.blocks || []).filter((block): block is Extract<FlowBlock, { kind: "action" }> => block.kind === "action")
      .map((block) => ({ id: `${step!.id}:${block.id}`, automation: block.automation, input: object(fillOwn(block.input, context)), conditions: block.when || {} }));
  }
  const outcome = definition.outcomes.find((entry) => entry.id === run.outcome_id);
  return (outcome?.effects || []).map((effect, index) => ({ id: `${outcome!.id}:${index + 1}`, automation: effect.automation, input: object(fillOwn(effect.input, context)), conditions: effect.when || {} }));
}

export async function runsFor(auth: PlatformAuthContext, filter: { flow_id?: string; project_id?: string }) {
  requirePlayer(auth);
  return listRuns(auth.orgId, { ...(filter.flow_id ? { flowId: filter.flow_id } : {}), ...(filter.project_id ? { projectId: filter.project_id } : {}) });
}

/**
 * A preview plays a definition without a run or any writes (setups, the editor): the step a set of answers reaches, and
 * where each step goes. Records and actions are only described.
 */
export function previewStep(definitionValue: unknown, input: { step_id?: string; answers?: unknown }) {
  const definition = parseFlow(definitionValue);
  const answers = object(input.answers);
  const context = { answers, contact: {}, project: {}, run: { kind: definition.kind }, user: {}, organization: {} };
  const step = stepOf(definition, text(input.step_id) || definition.start);
  return { step: stepView(step, context), next: resolveNext(step, context) };
}
