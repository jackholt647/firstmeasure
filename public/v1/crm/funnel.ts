import { z } from "zod";
import { badRequest, PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { evaluateConditions, validateConditions } from "../work/conditions.js";
import { getWorkDatabase, listNodeRecords } from "../work/storage.js";
import { spendBySource, readSourceCatalog, withPaths } from "./sources.js";

// The funnel (docs/architecture/crm.md, "The funnel"): an ordered list of milestones,
// each reached on a project by the first work event that matches one of its `when`
// entries, unless the project also reached a milestone it names in `unless`.
// Milestones are read from the work event log, never stored.

export const FUNNEL_MODULE = "crm_funnel";
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const parse = (value: unknown) => { try { return object(JSON.parse(text(value) || "{}")); } catch { return {}; } };

const milestoneSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(80),
  term: z.string().trim().max(120).default(""),
  when: z.array(z.object({ event: z.string().trim().min(1).max(120), conditions: z.object({}).passthrough().default({}) }).strict()).min(1).max(10),
  unless: z.array(z.string().trim().max(64)).max(10).default([]),
  /** Who is credited for this milestone in reports: the event's actor, or the appointment's assignee. */
  credit: z.enum(["", "actor", "assignee"]).default(""),
  color: z.string().max(20).default("")
}).strict();
export type Milestone = z.infer<typeof milestoneSchema>;
const funnelSchema = z.object({ version: z.literal(1).default(1), milestones: z.array(milestoneSchema).max(20).default([]) }).strict();

export function normalizeFunnel(value: unknown) {
  const funnel = funnelSchema.parse({ ...object(value), version: 1 });
  const ids = funnel.milestones.map(m => m.id);
  if (new Set(ids).size !== ids.length) throw badRequest("crm_funnel_duplicate", "Each milestone needs its own id.");
  for (const m of funnel.milestones) {
    for (const [i, w] of m.when.entries()) {
      const issues = validateConditions(w.conditions, `milestone "${m.id}" when ${i + 1}`);
      if (issues.length) throw badRequest("crm_funnel_conditions_invalid", issues[0]!, { issues });
    }
    const missing = m.unless.filter(id => !ids.includes(id));
    if (missing.length) throw badRequest("crm_funnel_unless_missing", `"${m.label}" names a milestone that is not in the funnel.`);
  }
  return funnel;
}

/** The default funnel: lead, appointment set, appointment held, won. Industry presets replace it. */
export const DEFAULT_FUNNEL = normalizeFunnel({ milestones: [
  { id: "lead", label: "Lead", when: [{ event: "lead.received" }] },
  { id: "set", label: "Appointment set", credit: "actor", when: [{ event: "project.event_scheduled", conditions: { match: "any", rules: [
    { field: "payload.event_type_default_id", operator: "in", value: ["sales_appointment", "appointment"] }] } }] },
  { id: "sat", label: "Appointment held", credit: "assignee", when: [{ event: "project.event.completed", conditions: { match: "any", rules: [
    { field: "payload.event_type_default_id", operator: "in", value: ["sales_appointment", "appointment"] }] } }] },
  { id: "won", label: "Won", when: [{ event: "opportunity.won" }] }
] });

export async function readFunnel(orgId: string) {
  try { const funnel = normalizeFunnel((await readBranchModule(orgId, "default", FUNNEL_MODULE)).data); return funnel.milestones.length ? funnel : DEFAULT_FUNNEL; }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return DEFAULT_FUNNEL; throw error; }
}

export async function saveFunnel(orgId: string, value: unknown) {
  const funnel = normalizeFunnel(object(value).data ?? value);
  await saveBranchModule(orgId, "default", FUNNEL_MODULE, { data: funnel, metadata: { kind: "crm_funnel" } }, { replace: true });
  return funnel;
}

type Reached = { at: string; actor: string; assignees: string[] };
export type ProjectMilestones = Map<string, Record<string, Reached>>;

/** Every project's milestones, read from the work event log of the types the funnel names. */
export async function projectMilestones(orgId: string, funnel = DEFAULT_FUNNEL): Promise<ProjectMilestones> {
  const types = [...new Set(funnel.milestones.flatMap(m => m.when.map(w => w.event)))];
  if (!types.length) return new Map();
  const rows = await getWorkDatabase().prepare(`SELECT project_id,node_id,type,payload_json,context_json,actor_user_id,created_at FROM work_events
    WHERE organization_id=? AND project_id IS NOT NULL AND project_id<>'' AND type IN (${types.map(() => "?").join(",")}) ORDER BY created_at`).all(orgId, ...types);
  const needsNodes = funnel.milestones.some(m => m.when.some(w => w.event.startsWith("work.node.")));
  const nodeTemplates = new Map<string, string>();
  if (needsNodes) for (const node of await listNodeRecords(orgId, {})) nodeTemplates.set(text(node.id), text(node.template_node_id));
  const out: ProjectMilestones = new Map();
  for (const row of rows.map(object)) {
    const payload = parse(row.payload_json), context = parse(row.context_json);
    const nodeId = text(row.node_id);
    const event = { type: text(row.type), payload, context };
    const conditionContext = { event, payload, context, node: { id: nodeId, template_node_id: nodeTemplates.get(nodeId) || "" } };
    const projectId = text(row.project_id);
    const reached = out.get(projectId) || {};
    for (const m of funnel.milestones) {
      if (reached[m.id]) continue;
      if (!m.when.some(w => w.event === event.type && evaluateConditions(w.conditions, conditionContext, { caseInsensitive: true, payloadFallback: false }))) continue;
      const ev = object(payload.event);
      const assignees = [...new Set([...list(ev.assigned_user_ids), ...list(ev.resource_refs).map(object).filter(r => text(r.kind || r.subject_type) === "organization_user").map(r => r.id || r.subject_id)].map(text).filter(Boolean))];
      reached[m.id] = { at: text(row.created_at), actor: text(row.actor_user_id || context.actor_user_id || ev.booking_actor || ev.scheduled_by_user_id || ev.created_by_user_id), assignees };
    }
    out.set(projectId, reached);
  }
  for (const [projectId, reached] of out) {
    for (const m of funnel.milestones) if (reached[m.id] && m.unless.some(id => reached[id])) delete reached[m.id];
    out.set(projectId, reached);
  }
  return out;
}

/** Milestone dates as row fields for the opportunities collection. */
export function milestoneFields(milestones: ProjectMilestones) {
  const out = new Map<string, JsonObject>();
  for (const [projectId, reached] of milestones) out.set(projectId, Object.fromEntries(Object.entries(reached).map(([id, r]) => [id, r.at])));
  return out;
}

export type FunnelGroup = "source" | "source_kind" | "scope" | "branch" | "month" | "setter" | "rep" | "owner" | "none";

/**
 * Counts, rates and costs between milestones for the leads whose first milestone falls in
 * [from, to] (a cohort), grouped by one dimension. Rows come from the opportunities
 * collection so the same access rules apply as in views.
 */
export async function funnelReport(orgId: string, rows: JsonObject[], milestones: ProjectMilestones, funnel: z.infer<typeof funnelSchema>, input: { from: string; to: string; group: FunnelGroup; owner_field?: string }, people: Map<string, string>) {
  const first = funnel.milestones[0]?.id;
  if (!first) return { milestones: [], groups: [], totals: null };
  const from = Date.parse(`${input.from}T00:00:00Z`), to = Date.parse(`${input.to}T23:59:59Z`);
  const catalog = withPaths((await readSourceCatalog(orgId)).sources);
  const sourceLabels = new Map(catalog.map(s => [s.id, s.path_label || s.label]));
  const { direct: spend } = await spendBySource(orgId, input.from, input.to);
  const setterMilestone = funnel.milestones.find(m => m.credit === "actor")?.id;
  const repMilestone = funnel.milestones.find(m => m.credit === "assignee")?.id;
  type Bucket = { key: string; label: string; counts: Record<string, number>; value_cents: Record<string, number>; project_ids: Record<string, string[]>; spend_cents: number };
  const buckets = new Map<string, Bucket>();
  const keyFor = (row: JsonObject, reached: Record<string, Reached>): [string, string] => {
    switch (input.group) {
      case "source": { const id = text(row.source_id); return [id || "none", id ? (sourceLabels.get(id) || id) : "No source"]; }
      case "source_kind": { const k = text(row.source_kind); return [k || "none", k ? k.replace(/_/g, " ") : "Unknown"]; }
      case "scope": return [text(row.scope_template_id) || "none", text(row.scope_name) || "No scope yet"];
      case "branch": return [text(row.branch_id) || "default", text(row.branch_id) || "default"];
      case "month": { const at = reached[first]?.at || text(row.created_at); return [at.slice(0, 7) || "unknown", at.slice(0, 7) || "Unknown"]; }
      case "setter": { const u = setterMilestone ? reached[setterMilestone]?.actor : ""; return [u || "none", u ? (people.get(u) || u) : "Not set"]; }
      case "rep": { const u = repMilestone ? reached[repMilestone]?.assignees[0] : ""; return [u || "none", u ? (people.get(u) || u) : "No rep"]; }
      case "owner": { const v = text(input.owner_field ? row[input.owner_field] : ""); return [v || "none", v ? (people.get(v) || v) : "No owner"]; }
      default: return ["all", "All leads"];
    }
  };
  for (const row of rows) {
    const reached = milestones.get(text(row.id)) || {};
    const start = Date.parse(reached[first]?.at || text(row.created_at));
    if (!Number.isFinite(start) || start < from || start > to) continue;
    const [key, label] = keyFor(row, reached);
    const bucket = buckets.get(key) || { key, label, counts: {}, value_cents: {}, project_ids: {}, spend_cents: 0 };
    for (const m of funnel.milestones) {
      if (!reached[m.id] && !(m.id === first)) continue;
      bucket.counts[m.id] = (bucket.counts[m.id] || 0) + 1;
      bucket.value_cents[m.id] = (bucket.value_cents[m.id] || 0) + Number(row.value_cents || 0);
      (bucket.project_ids[m.id] ||= []).push(text(row.id));
    }
    buckets.set(key, bucket);
  }
  // Each row is one exact source, so it carries the spend entered on that source; a source
  // that was paid for and brought no leads still shows, so its money is not hidden.
  if (input.group === "source") for (const [id, cents] of spend) {
    const bucket = buckets.get(id) || { key: id, label: sourceLabels.get(id) || id, counts: {}, value_cents: {}, project_ids: {}, spend_cents: 0 };
    bucket.spend_cents = cents; buckets.set(id, bucket);
  }
  const totalSpend = [...spend.values()].reduce((sum, cents) => sum + cents, 0);
  const shape = (b: Bucket) => ({
    key: b.key, label: b.label, spend_cents: b.spend_cents,
    milestones: funnel.milestones.map((m, i) => {
      const count = b.counts[m.id] || 0, prev = i ? (b.counts[funnel.milestones[i - 1]!.id] || 0) : count, base = b.counts[first] || 0;
      return { id: m.id, count, value_cents: b.value_cents[m.id] || 0, rate_from_previous: prev ? count / prev : null, rate_from_first: base ? count / base : null,
        cost_cents: b.spend_cents && count ? Math.round(b.spend_cents / count) : null, project_ids: b.project_ids[m.id] || [] };
    })
  });
  const groups = [...buckets.values()].map(shape).sort((a, b) => (b.milestones[0]?.count || 0) - (a.milestones[0]?.count || 0));
  const all: Bucket = { key: "total", label: "Total", counts: {}, value_cents: {}, project_ids: {}, spend_cents: totalSpend };
  for (const b of buckets.values()) for (const m of funnel.milestones) {
    all.counts[m.id] = (all.counts[m.id] || 0) + (b.counts[m.id] || 0);
    all.value_cents[m.id] = (all.value_cents[m.id] || 0) + (b.value_cents[m.id] || 0);
    (all.project_ids[m.id] ||= []).push(...(b.project_ids[m.id] || []));
  }
  return { milestones: funnel.milestones.map(m => ({ id: m.id, label: m.label, term: m.term, color: m.color })), groups, totals: shape(all), spend_cents: totalSpend };
}
