import type { PlatformAuthContext } from "../platform/auth.js";
import { listDocuments, type JsonObject } from "../platform/storage.js";
import { listNodeRecords, listPlanRecords } from "../work/storage.js";
import { isFollowUpWorkNode } from "../work/followups.js";
import { isIntakePlan } from "../work/opportunities.js";
import { listAllContactLinks, listAllContacts } from "../contacts/records.js";
import { customFieldValueAtPath } from "../custom_fields/service.js";
import { hasResourcePermission } from "../workforce/department-access.js";
import { branchScope } from "../workforce/branch-scope.js";

// The CRM's collections (docs/architecture/crm.md, "Views"): flat rows built from the
// records that exist (contacts, projects, work plans and nodes, call lists, schedule
// events) and never written. Building them reads every record of a collection; that is
// in docs/optimization-backlog.md ("CRM views").

export type CrmCollection = "opportunities" | "contacts" | "follow_ups" | "appointments";
export const CRM_COLLECTIONS: CrmCollection[] = ["opportunities", "contacts", "follow_ups", "appointments"];
export type FieldType = "text" | "number" | "money" | "date" | "bool" | "select" | "multi" | "user" | "contact";
export type CrmField = {
  key: string; label: string; term?: string; type: FieldType; group?: string;
  /** Another row key shown under this value when the field is a view's first column. */
  sub?: string;
  options?: { value: string; label: string; color?: string }[];
  column?: boolean; sortable?: boolean; groupable?: boolean; filterable?: boolean; writable?: boolean;
};
export type CrmRow = JsonObject & { id: string };
export type CollectionResult = { rows: CrmRow[]; fields: CrmField[]; labels: Record<string, string> };

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown) => [...new Set(list(value).map(text).filter(Boolean))];
const DAY = 86_400_000;
const time = (value: unknown) => { const t = Date.parse(text(value)); return Number.isFinite(t) ? t : NaN; };
const latest = (...values: unknown[]) => values.map(text).filter(v => Number.isFinite(time(v))).sort().at(-1) || "";

/** What one viewer may see: rows outside it are dropped before any filter runs. */
export function rowAccess(ctx: PlatformAuthContext | null) {
  if (!ctx) return { project: () => true, contact: () => true };
  const scope = branchScope(ctx);
  const branchOk = (ids: string[]) => !scope.restricted_view || !ids.length || ids.some(id => scope.visible_branch_ids.includes(id));
  return {
    project: (project: JsonObject) => branchOk([text(project.branch_id) || "default"]) && hasResourcePermission(ctx, "view_projects", { ...project, department_ids: list(project.department_ids) }),
    contact: (branchIds: string[]) => branchOk(branchIds)
  };
}

/** Money text ("$12,345.60") or cents to cents. */
function cents(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const parsed = Number(text(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && text(value) ? Math.round(parsed * 100) : 0;
}

function proposalValue(project: JsonObject) {
  const proposals = list(project.proposals).map(object);
  const signed = proposals.find(p => text(p.status) === "signed");
  const active = signed || proposals.find(p => text(p.proposal_id || p.id) === text(project.active_proposal_id)) || proposals[0];
  if (!active) return 0;
  const totals = object(active.totals);
  return cents(active.total_cents ?? totals.total ?? object(object(active.builder_document).totals).total);
}

type CustomFieldDef = { path: string; label: string; type: string; options?: unknown[] };
function projectFieldDefs(project: JsonObject): CustomFieldDef[] {
  return list(object(project.custom_field_schema).fields || object(project.custom_field_schema).definitions).map(object)
    .map(f => ({ path: text(f.path || f.key || f.id), label: text(f.label || f.path), type: text(f.type || "text"), options: list(f.options || f.choices) }))
    .filter(f => f.path);
}
const FIELD_TYPE: Record<string, FieldType> = {
  text: "text", textarea: "text", long_text: "text", email: "text", phone: "text", url: "text",
  number: "number", integer: "number", decimal: "number", percent: "number", currency: "money", money: "money",
  date: "date", datetime: "date", boolean: "bool", checkbox: "bool", select: "select", single_select: "select", multi_select: "multi",
  organization_user: "user", resource_group: "select", assignable_subject: "select", organization_connection: "select", contact: "contact"
};
/** A stored custom field value as one comparable value: assignees and contacts by id. */
function flatFieldValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(flatFieldValue);
  const v = object(value);
  if (Object.keys(v).length) return text(v.subject_id || v.contact_id || v.id || v.value || v.label);
  return value;
}

async function users(org: string) {
  const out = new Map<string, string>();
  for (const doc of await listDocuments(org, "users").catch(() => [])) {
    const d = object(doc.data);
    out.set(text(doc.id), text(d.name || [d.first_name, d.last_name].filter(Boolean).join(" ") || d.email) || text(doc.id));
  }
  return out;
}

async function stageCatalog(org: string, plans: JsonObject[]) {
  const stages = new Map<string, { label: string; color: string }>();
  const scopes = new Map<string, string>();
  // Scope templates' custom fields, so a view can filter on a field before any project has it.
  const fields: CustomFieldDef[] = [];
  for (const plan of plans) if (text(plan.template_id)) scopes.set(text(plan.template_id), text(plan.title) || text(plan.template_id));
  const { listScopeTemplates } = await import("../scopes/storage.js");
  for (const template of await listScopeTemplates(org, "default", { include_disabled: true }).catch(() => [] as JsonObject[])) {
    const def = object(template.definition);
    scopes.set(text(template.id), text(template.name || def.name) || text(template.id));
    const root = object(list(object(def.work_plan).root_nodes)[0]);
    for (const node of list(root.children).map(object)) if (text(node.terminology_key).endsWith("stage")) stages.set(`${text(template.id)}:${text(node.id)}`, { label: text(node.title) || text(node.id), color: text(node.color || object(node.metadata).color) });
    fields.push(...projectFieldDefs({ custom_field_schema: object(def.custom_fields) }));
  }
  return { stages, scopes, fields };
}

/** Shared context the collections read once per query. */
export async function crmSources(org: string) {
  const [projects, plans, links, people] = await Promise.all([
    listDocuments(org, "projects"), listPlanRecords(org, {}), listAllContactLinks(org), users(org)
  ]);
  const plansByProject = new Map<string, JsonObject[]>();
  for (const plan of plans) plansByProject.set(text(plan.project_id), [...(plansByProject.get(text(plan.project_id)) || []), plan]);
  const linksByProject = new Map<string, { contact_id: string; primary: boolean }[]>();
  const linksByContact = new Map<string, string[]>();
  for (const link of links) {
    linksByProject.set(link.project_id, [...(linksByProject.get(link.project_id) || []), link]);
    linksByContact.set(link.contact_id, [...(linksByContact.get(link.contact_id) || []), link.project_id]);
  }
  return { org, projects: projects.map(d => ({ id: text(d.id), ...object(d.data) } as JsonObject)), plans, plansByProject, linksByProject, linksByContact, people };
}
export type CrmSources = Awaited<ReturnType<typeof crmSources>>;

function salesPlan(plans: JsonObject[]) {
  const live = (p: JsonObject) => !["completed", "canceled"].includes(text(p.status));
  return plans.find(p => p.sales === true && live(p)) || plans.find(p => p.sales === true)
    || plans.find(p => live(p) && text(p.template_id) && !isIntakePlan(p) && object(p.metadata).hide_from_boards !== true);
}

function projectEvents(project: JsonObject) {
  return list(project.events).map(object).filter(e => text(e.id) && !text(e.deleted_at) && !["canceled", "cancelled", "deleted"].includes(text(e.status).toLowerCase()));
}

/** Is this project a lead, an opportunity or a sale: arrived through intake or has a sales scope. */
export function isOpportunityProject(project: JsonObject, plans: JsonObject[]) {
  if (text(project.merged_into) || text(project.deleted_at)) return false;
  return (!!project.lead_source && typeof project.lead_source === "object") || plans.some(p => p.sales === true);
}

export function leadState(project: JsonObject) {
  const lifecycle = object(project.lifecycle), opp = object(lifecycle.opportunities);
  if (lifecycle.new_lead === true) return "new_lead";
  if (Number(opp.won || 0) > 0 || text(lifecycle.sold_at) || text(project.won_at)) return "won";
  if (text(lifecycle.status) === "lost" || text(project.lost_at)) return "lost";
  if (Number(opp.open || 0) > 0) return "open";
  return "closed";
}

export async function opportunityRows(src: CrmSources, ctx: PlatformAuthContext | null, extras: { milestones?: Map<string, JsonObject>; sources?: Map<string, JsonObject>; followUps?: Map<string, string>; touches?: Map<string, string> } = {}): Promise<CollectionResult> {
  const access = rowAccess(ctx);
  const { stages, scopes, fields: templateFields } = await stageCatalog(src.org, src.plans);
  const now = Date.now();
  const customDefs = new Map<string, CustomFieldDef>(templateFields.filter(f => FIELD_TYPE[f.type]).map(f => [f.path, f]));
  const rows: CrmRow[] = [];
  for (const project of src.projects) {
    const plans = src.plansByProject.get(text(project.id)) || [];
    if (!isOpportunityProject(project, plans) || !access.project(project)) continue;
    const lead = object(project.lead_source), lifecycle = object(project.lifecycle), opp = object(lifecycle.opportunities);
    const plan = salesPlan(plans);
    const instance = list(object(project.work_projection).instances).map(object).find(i => text(i.plan_id) === text(plan?.id)) || {};
    const events = projectEvents(project);
    const future = events.filter(e => time(e.start_at) >= now).sort((a, b) => time(a.start_at) - time(b.start_at));
    const past = events.filter(e => time(e.start_at) < now).sort((a, b) => time(b.start_at) - time(a.start_at));
    const links = src.linksByProject.get(text(project.id)) || [];
    const sourceId = text(lead.source_id), source = sourceId ? extras.sources?.get(sourceId) : undefined;
    const row: CrmRow = {
      id: text(project.id), project_id: text(project.id),
      title: text(project.title || project.customer_name || project.address) || "Untitled",
      address: text(project.address), branch_id: text(project.branch_id) || "default",
      created_at: text(project.created_at), updated_at: text(project.updated_at),
      age_days: Number.isFinite(time(project.created_at)) ? Math.max(0, Math.floor((now - time(project.created_at)) / DAY)) : null,
      contact_id: text(project.primary_contact_id || links.find(l => l.primary)?.contact_id || links[0]?.contact_id),
      contact_ids: links.map(l => l.contact_id),
      contact_name: text(project.primary_contact_name || project.customer_name), contact_phone: text(project.primary_contact_phone || project.customer_phone),
      contact_email: text(project.primary_contact_email || project.customer_email),
      state: leadState(project), new_lead: lifecycle.new_lead === true,
      scope_template_id: text(plan?.template_id), scope_name: text(plan?.template_id) ? (scopes.get(text(plan?.template_id)) || text(plan?.title)) : "",
      stage_id: text(plan?.template_id) && text(instance.stage_id) ? `${text(plan?.template_id)}:${text(instance.stage_id)}` : "",
      stage_title: text(instance.stage_title), plan_id: text(plan?.id),
      source_kind: text(lead.kind || project.source), source_provider: text(lead.provider),
      source_id: sourceId, source_channel: text(source?.channel), referrer_contact_id: text(lead.referrer_contact_id),
      value_cents: proposalValue(project),
      next_appointment_at: text(future[0]?.start_at), next_appointment_title: text(future[0]?.title),
      last_appointment_at: text(past[0]?.start_at),
      next_follow_up_at: extras.followUps?.get(text(project.id)) || "",
      last_touch_at: latest(extras.touches?.get(text(project.id)), past[0]?.start_at),
      won_at: text(opp.won_at || lifecycle.sold_at || project.won_at), lost_at: text(opp.lost_at || project.lost_at),
      lost_reason: text(project.lost_reason || plans.find(p => p.outcome === "lost")?.outcome_reason),
      // A won sale still inside its cancellation window (crm/rescission.ts).
      rescission_until: (() => { const r = plans.filter(p => p.outcome === "won").map(p => object(object(p.metadata).rescission)).find(r => time(r.deadline) > now); return text(r?.deadline); })(),
      open_opportunities: Number(opp.open || 0),
      feedback_rating: object(project.feedback).rating ?? null,
      tags: strings(project.tags),
      department_ids: list(project.department_ids)
    };
    const values = object(project.custom_field_values || project.custom_fields);
    for (const def of projectFieldDefs(project)) {
      if (!FIELD_TYPE[def.type]) continue;
      customDefs.set(def.path, def);
      row[`cf.${def.path}`] = flatFieldValue(customFieldValueAtPath(values, def.path));
    }
    const reached = extras.milestones?.get(text(project.id)) || {};
    for (const [id, at] of Object.entries(reached)) row[`milestone.${id}`] = at;
    rows.push(row);
  }
  const labels: Record<string, string> = {};
  for (const [id, name] of src.people) labels[`user:${id}`] = name;
  const fields: CrmField[] = [
    { key: "contact_name", label: "Contact", term: "contacts.contact", type: "text", column: true, sub: "title" },
    { key: "title", label: "Project", term: "projects.project", type: "text" },
    { key: "contact_phone", label: "Phone", type: "text", groupable: false },
    { key: "contact_email", label: "Email", type: "text", groupable: false },
    { key: "address", label: "Address", type: "text", groupable: false },
    { key: "state", label: "Lead state", term: "crm.lead_state", type: "select", column: true, options: [
      { value: "new_lead", label: "New lead", color: "#2563eb" }, { value: "open", label: "Open", color: "#f59e0b" },
      { value: "won", label: "Won", color: "#16a34a" }, { value: "lost", label: "Lost", color: "#dc2626" }, { value: "closed", label: "Closed", color: "#667085" }] },
    { key: "new_lead", label: "New lead", term: "crm.new_lead", type: "bool" },
    { key: "scope_template_id", label: "Scope", term: "scope.scope", type: "select", options: [...scopes].map(([value, label]) => ({ value, label })) },
    { key: "stage_id", label: "Stage", term: "work.stage", type: "select", column: true, writable: true, options: [...stages].map(([value, s]) => ({ value, label: s.label, color: s.color })) },
    { key: "source_kind", label: "Source type", term: "crm.source_type", type: "select", options: [...new Set(rows.map(r => text(r.source_kind)).filter(Boolean))].map(value => ({ value, label: value.replace(/_/g, " ") })) },
    { key: "source_id", label: "Source", term: "crm.source", type: "select", column: true, options: [...(extras.sources?.values() || [])].map(s => ({ value: text(s.id), label: text(s.path_label || s.label) })) },
    { key: "source_provider", label: "Provider", type: "text" },
    { key: "value_cents", label: "Value", type: "money", column: true, groupable: false },
    { key: "next_appointment_at", label: "Next appointment", term: "crm.next_appointment", type: "date", column: true, groupable: false },
    { key: "next_follow_up_at", label: "Next follow-up", type: "date", groupable: false },
    { key: "last_touch_at", label: "Last touch", type: "date", groupable: false },
    { key: "created_at", label: "Created", type: "date", column: true, groupable: false },
    { key: "age_days", label: "Age (days)", type: "number", groupable: false },
    { key: "won_at", label: "Won", type: "date", groupable: false },
    { key: "lost_at", label: "Lost", type: "date", groupable: false },
    { key: "rescission_until", label: "Can cancel until", term: "crm.rescission_until", type: "date", groupable: false },
    { key: "lost_reason", label: "Lost reason", type: "select", options: [...new Set(rows.map(r => text(r.lost_reason)).filter(Boolean))].map(value => ({ value, label: value.replace(/_/g, " ") })) },
    { key: "branch_id", label: "Branch", term: "branches.branch", type: "select", options: [...new Set(rows.map(r => text(r.branch_id)))].map(value => ({ value, label: value })) },
    { key: "feedback_rating", label: "Rating", term: "feedback.rating", type: "number", groupable: false },
    { key: "tags", label: "Tags", type: "multi", groupable: false }
  ];
  for (const def of customDefs.values()) {
    const type = FIELD_TYPE[def.type]!;
    const options = list(def.options).map(o => typeof o === "string" ? { value: o, label: o } : { value: text(object(o).value ?? object(o).id ?? object(o).label), label: text(object(o).label ?? object(o).value) }).filter(o => o.value);
    fields.push({ key: `cf.${def.path}`, label: def.label, type, group: "fields", ...(type === "user" ? { options: [...src.people].map(([value, label]) => ({ value, label })) } : options.length ? { options } : {}), groupable: ["select", "user", "bool"].includes(type) });
  }
  return { rows, fields, labels };
}

export async function contactRows(src: CrmSources, ctx: PlatformAuthContext | null): Promise<CollectionResult> {
  const access = rowAccess(ctx);
  const scope = ctx ? branchScope(ctx) : null;
  const contacts = await listAllContacts(src.org, scope?.restricted_view ? scope.visible_branch_ids : null);
  const projects = new Map(src.projects.map(p => [text(p.id), p]));
  const referred = new Map<string, number>();
  for (const p of src.projects) { const r = text(object(p.lead_source).referrer_contact_id); if (r) referred.set(r, (referred.get(r) || 0) + 1); }
  const now = Date.now();
  const rows: CrmRow[] = [];
  for (const c of contacts) {
    if (!access.contact(c.branch_ids)) continue;
    const mine = (src.linksByContact.get(c.id) || []).map(id => projects.get(id)).filter((p): p is JsonObject => !!p && !text(p.merged_into));
    const states = mine.map(leadState);
    // A lead is a contact with a project whose opportunity is open and not won (docs/architecture/opportunities.md).
    const open = mine.filter(p => ["new_lead", "open"].includes(leadState(p)));
    const won = states.includes("won");
    const nextAppointment = mine.flatMap(projectEvents).filter(e => time(e.start_at) >= now).map(e => text(e.start_at)).sort()[0] || "";
    rows.push({
      id: c.id, contact_id: c.id, name: c.name || c.email || c.phone || "Unnamed", kind: c.contact_kind,
      email: c.email, phone: c.phone, address: c.address, company: c.company, tags: c.tags, branch_ids: c.branch_ids,
      created_at: c.created_at, updated_at: c.updated_at,
      project_count: mine.length, open_opportunities: open.length,
      lead: open.length > 0,
      new_lead: states.includes("new_lead"), customer: won,
      state: won ? (open.length ? "customer_lead" : "customer") : open.length ? (states.includes("new_lead") ? "new_lead" : "lead") : "contact",
      last_activity_at: latest(c.updated_at, ...mine.map(p => p.updated_at)),
      next_appointment_at: nextAppointment,
      leads_referred: referred.get(c.id) || 0,
      value_won_cents: mine.filter(p => leadState(p) === "won").reduce((sum, p) => sum + proposalValue(p), 0),
      ...Object.fromEntries(Object.entries(object(c.custom_field_values)).map(([k, v]) => [`cf.${k}`, flatFieldValue(v)]))
    });
  }
  const tagOptions = [...new Set(rows.flatMap(r => strings(r.tags)))].map(value => ({ value, label: value }));
  const fields: CrmField[] = [
    { key: "name", label: "Name", term: "contacts.contact", type: "text", column: true },
    { key: "phone", label: "Phone", type: "text", column: true, groupable: false },
    { key: "email", label: "Email", type: "text", column: true, groupable: false },
    { key: "state", label: "Relationship", term: "crm.relationship", type: "select", column: true, options: [
      { value: "new_lead", label: "New lead", color: "#2563eb" }, { value: "lead", label: "Lead", color: "#f59e0b" },
      { value: "customer_lead", label: "Customer and lead", color: "#7c3aed" }, { value: "customer", label: "Customer", color: "#16a34a" }, { value: "contact", label: "Contact", color: "#667085" }] },
    { key: "lead", label: "Lead", term: "crm.lead", type: "bool" },
    { key: "new_lead", label: "New lead", term: "crm.new_lead", type: "bool" },
    { key: "customer", label: "Customer", term: "crm.customer", type: "bool" },
    { key: "kind", label: "Kind", type: "select", options: [{ value: "human", label: "Person" }, { value: "org", label: "Company" }] },
    { key: "company", label: "Company", type: "text" },
    { key: "tags", label: "Tags", type: "multi", column: true, options: tagOptions, groupable: false },
    { key: "project_count", label: "Projects", term: "projects.projects", type: "number", column: true, groupable: false },
    { key: "open_opportunities", label: "Open opportunities", type: "number", groupable: false },
    { key: "leads_referred", label: "Leads referred", type: "number", groupable: false },
    { key: "value_won_cents", label: "Won value", type: "money", groupable: false },
    { key: "next_appointment_at", label: "Next appointment", term: "crm.next_appointment", type: "date", groupable: false },
    { key: "last_activity_at", label: "Last activity", type: "date", column: true, groupable: false },
    { key: "created_at", label: "Created", type: "date", groupable: false },
    { key: "address", label: "Address", type: "text", groupable: false }
  ];
  return { rows, fields, labels: {} };
}

export async function followUpRows(src: CrmSources, ctx: PlatformAuthContext | null): Promise<CollectionResult> {
  const access = rowAccess(ctx);
  const projects = new Map(src.projects.map(p => [text(p.id), p]));
  const now = Date.now(), rows: CrmRow[] = [];
  const nodes = (await listNodeRecords(src.org, { actionable: true, open_only: true })).filter(isFollowUpWorkNode)
    .filter(n => ["ready", "active", "pending"].includes(text(n.status)));
  for (const node of nodes) {
    const project = projects.get(text(node.project_id)) || {};
    if (Object.keys(project).length && !access.project(project)) continue;
    const followUp = object(object(node.metadata).follow_up);
    rows.push({
      id: `node:${text(node.id)}`, node_id: text(node.id), kind: "follow_up", channel: text(followUp.channel || "call"),
      title: text(node.title) || "Follow-up", due_at: text(node.due_at), overdue: Number.isFinite(time(node.due_at)) && time(node.due_at) < now,
      attempts: Number(followUp.policy_step_index ?? followUp.attempt ?? 0), project_id: text(node.project_id),
      project_title: text(project.title || project.address), contact_name: text(followUp.contact_name || project.primary_contact_name || project.customer_name),
      phone: text(followUp.phone || project.primary_contact_phone || project.customer_phone), branch_id: text(node.branch_id || project.branch_id) || "default",
      assigned_user_ids: strings(node.assigned_user_ids), list_key: "follow_ups", list_title: "Follow-ups"
    });
  }
  const { getCallListDatabase } = await import("../comms/call-lists.js");
  const entries = await getCallListDatabase().prepare(`SELECT e.*, l.list_key AS list_key, l.title AS list_title, l.kind AS list_kind FROM crm_call_list_entries e JOIN crm_call_lists l ON l.id=e.call_list_id
    WHERE e.organization_id=? AND e.status='pending' AND l.status='active' AND l.kind<>'follow_up' ORDER BY e.priority DESC, e.created_at`).all(src.org).catch(() => [] as JsonObject[]);
  for (const entry of entries.map(object)) {
    const project = projects.get(text(entry.project_id)) || {};
    if (Object.keys(project).length && !access.project(project)) continue;
    const payload = (() => { try { return object(JSON.parse(text(entry.payload_json) || "{}")); } catch { return {}; } })();
    rows.push({
      id: `entry:${text(entry.id)}`, entry_id: text(entry.id), kind: "call", channel: "call", title: text(entry.title) || text(entry.list_title),
      due_at: text(entry.due_at), overdue: Number.isFinite(time(entry.due_at)) && time(entry.due_at) < now, attempts: Number(entry.attempt_count || entry.attempts || 0),
      project_id: text(entry.project_id), project_title: text(project.title || project.address),
      contact_name: text(payload.name || project.primary_contact_name || project.customer_name), phone: text(payload.phone || project.primary_contact_phone || project.customer_phone),
      branch_id: text(project.branch_id) || "default", assigned_user_ids: [], list_key: text(entry.list_key), list_title: text(entry.list_title)
    });
  }
  const listOptions = [...new Map(rows.map(r => [text(r.list_key), text(r.list_title)])).entries()].map(([value, label]) => ({ value, label }));
  const fields: CrmField[] = [
    { key: "contact_name", label: "Contact", term: "contacts.contact", type: "text", column: true, sub: "project_title" },
    { key: "phone", label: "Phone", type: "text", column: true, groupable: false },
    { key: "title", label: "To-do", type: "text", column: true, groupable: false },
    { key: "list_key", label: "List", term: "crm.call_list", type: "select", column: true, options: listOptions },
    { key: "due_at", label: "Due", type: "date", column: true, groupable: false },
    { key: "overdue", label: "Overdue", type: "bool" },
    { key: "attempts", label: "Attempts", type: "number", column: true, groupable: false },
    { key: "project_title", label: "Project", term: "projects.project", type: "text", groupable: false },
    { key: "channel", label: "Channel", type: "select", options: [{ value: "call", label: "Call" }, { value: "text", label: "Text" }, { value: "email", label: "Email" }] },
    { key: "assigned_user_ids", label: "Assigned to", type: "user", options: [...src.people].map(([value, label]) => ({ value, label })), groupable: false }
  ];
  return { rows, fields, labels: {} };
}

export async function appointmentRows(src: CrmSources, ctx: PlatformAuthContext | null): Promise<CollectionResult> {
  const access = rowAccess(ctx);
  const now = Date.now(), rows: CrmRow[] = [];
  const types = new Map<string, string>();
  for (const project of src.projects) {
    if (text(project.merged_into) || !access.project(project)) continue;
    for (const event of projectEvents(project)) {
      const type = text(event.event_type_default_id || event.type);
      const config = object(event.appointment_configuration);
      const isAppointment = type === "appointment" || type.includes("appointment") || Object.keys(config).length > 0 || text(event.kind) === "appointment";
      if (!isAppointment) continue;
      types.set(type, text(event.type_label || config.title || type.replace(/_/g, " ")));
      const userIds = strings([...list(event.assigned_user_ids), ...list(event.resource_refs).map(object).filter(r => text(r.kind) === "organization_user" || text(r.subject_type) === "organization_user").map(r => r.id || r.subject_id)]);
      const status = text(event.status || "scheduled").toLowerCase();
      rows.push({
        id: `${text(project.id)}:${text(event.id)}`, event_id: text(event.id), project_id: text(project.id),
        project_title: text(project.title || project.address), title: text(event.title) || types.get(type) || "Appointment",
        type, preset_id: text(config.preset_id || event.appointment_preset_id), start_at: text(event.start_at), end_at: text(event.end_at),
        upcoming: time(event.start_at) >= now, status, confirmation: text(typeof event.confirmation === "string" ? event.confirmation : object(event.confirmation).status),
        assigned_user_ids: userIds, contact_name: text(project.primary_contact_name || project.customer_name),
        phone: text(project.primary_contact_phone || project.customer_phone),
        address: (typeof event.location === "string" ? text(event.location) : text(object(event.location).address)) || text(project.address),
        branch_id: text(project.branch_id) || "default"
      });
    }
  }
  const fields: CrmField[] = [
    { key: "contact_name", label: "Contact", term: "contacts.contact", type: "text", column: true, sub: "address" },
    { key: "start_at", label: "When", type: "date", column: true, groupable: false },
    { key: "title", label: "Appointment", term: "crm.appointment", type: "text", column: true, groupable: false },
    { key: "type", label: "Type", type: "select", options: [...types].map(([value, label]) => ({ value, label })) },
    { key: "phone", label: "Phone", type: "text", groupable: false },
    { key: "assigned_user_ids", label: "With", type: "user", column: true, options: [...src.people].map(([value, label]) => ({ value, label })), groupable: false },
    { key: "confirmation", label: "Confirmation", type: "select", column: true, options: [{ value: "pending", label: "Not confirmed", color: "#f59e0b" }, { value: "confirmed", label: "Confirmed", color: "#16a34a" }, { value: "declined", label: "Declined", color: "#dc2626" }, { value: "not_required", label: "Not needed", color: "#667085" }] },
    { key: "status", label: "Status", type: "select", options: [{ value: "scheduled", label: "Scheduled" }, { value: "completed", label: "Completed" }, { value: "en_route", label: "On the way" }, { value: "arrived", label: "Arrived" }] },
    { key: "upcoming", label: "Upcoming", type: "bool" },
    { key: "project_title", label: "Project", term: "projects.project", type: "text", groupable: false },
    { key: "address", label: "Where", type: "text", groupable: false }
  ];
  return { rows, fields, labels: {} };
}
