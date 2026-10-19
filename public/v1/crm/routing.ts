import { z } from "zod";
import { badRequest, PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { validateConditions } from "../work/conditions.js";

// Lead routing and scoring (docs/architecture/crm.md, "Lead routing and scoring"). Nothing here routes a
// lead: the settings generate organization rules whose action is custom code in the bounded sandbox
// (scope.code.run.v1). The code below is the preset program; a company can replace it with its own,
// which may declare any published data. The programs read the CRM's published leads (crm provider),
// select with the shared condition contract, and write through crm.leads.update.

export const ROUTING_MODULE = "crm_routing";
export const ROUTING_RULE_PREFIX = "crm_routing_";
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const id = z.string().trim().min(1).max(160);
const conditions = z.object({}).passthrough().default({});

const settingsSchema = z.object({
  version: z.literal(1).default(1),
  routing: z.object({
    enabled: z.boolean().default(false),
    /** rotation: next in turn; weighted: by share; balanced: fewest open leads; rules: the first rule whose conditions match picks the people. */
    method: z.enum(["rotation", "weighted", "balanced", "rules"]).default("rotation"),
    user_ids: z.array(id).max(500).default([]),
    weights: z.record(z.number().min(0).max(100)).default({}),
    /** Skip anyone who already has this many open leads (0: no limit). */
    max_open_leads: z.number().int().min(0).max(10000).default(0),
    rules: z.array(z.object({ id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), label: z.string().trim().max(120).default(""), conditions, user_ids: z.array(id).max(500).default([]) }).strict()).max(50).default([]),
    /** Who gets a lead when nobody in the pool can take it. */
    fallback_user_ids: z.array(id).max(50).default([]),
    /** Move a lead nobody has touched after this many minutes (0: never). */
    reassign_after_minutes: z.number().int().min(0).max(10080).default(0),
    reassign_limit: z.number().int().min(0).max(20).default(2),
    notify: z.boolean().default(true)
  }).strict().default({}),
  scoring: z.object({
    enabled: z.boolean().default(false),
    rules: z.array(z.object({ id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), label: z.string().trim().max(120).default(""), conditions, points: z.number().int().min(-1000).max(1000) }).strict()).max(40).default([])
  }).strict().default({}),
  /** A company's own programs in place of the presets (the same inputs, bindings and outputs). */
  custom: z.object({ routing_source: z.string().max(64000).default(""), scoring_source: z.string().max(64000).default("") }).strict().default({})
}).strict();
export type RoutingSettings = z.infer<typeof settingsSchema>;

export function normalizeRouting(value: unknown) {
  const settings = settingsSchema.parse({ ...object(value), version: 1 });
  for (const rule of settings.routing.rules) {
    const issues = validateConditions(rule.conditions, `routing rule "${rule.id}"`);
    if (issues.length) throw badRequest("crm_routing_conditions_invalid", issues[0]!, { issues });
  }
  for (const rule of settings.scoring.rules) {
    const issues = validateConditions(rule.conditions, `score rule "${rule.id}"`);
    if (issues.length) throw badRequest("crm_scoring_conditions_invalid", issues[0]!, { issues });
  }
  if (settings.routing.enabled && !settings.routing.user_ids.length && !settings.routing.rules.some(r => r.user_ids.length) && !settings.routing.fallback_user_ids.length) {
    throw badRequest("crm_routing_nobody", "Choose the people leads are routed to.");
  }
  return settings;
}

export async function readRouting(orgId: string) {
  try { return normalizeRouting((await readBranchModule(orgId, "default", ROUTING_MODULE)).data); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return normalizeRouting({}); throw error; }
}

/** The fields routing and scoring write, declared on projects in every branch so a new lead with no scope has them. */
export const ROUTING_FIELDS: JsonObject[] = [
  { entity: "project", path: "crm.owner", key: "crm.owner", type: "organization_user", cardinality: "one", label: "Lead owner", required: false, enabled: true, location: "overview", order: 5 },
  { entity: "project", path: "crm.score", key: "crm.score", type: "integer", label: "Lead score", required: false, enabled: true, location: "overview", order: 6 },
  { entity: "project", path: "crm.routed_at", key: "crm.routed_at", type: "datetime", label: "Routed at", required: false, enabled: true, background_only: true, show_in_overview: false },
  { entity: "project", path: "crm.route_count", key: "crm.route_count", type: "integer", label: "Times routed", required: false, enabled: true, background_only: true, show_in_overview: false }
];

async function ensureFields(orgId: string) {
  const { readStructureBranches } = await import("../workforce/organization-structure.js");
  const branches = [...new Set(["default", ...(await readStructureBranches(orgId).catch(() => [])).map(b => text(object(b).id)).filter(Boolean)])];
  for (const branch of branches) {
    for (let attempt = 0; ; attempt++) {
      const module = await readBranchModule(orgId, branch, "custom_fields").catch(() => null);
      const data = object(module?.data), fields = Array.isArray(data.fields) ? data.fields.map(object) : [];
      const missing = ROUTING_FIELDS.filter(f => !fields.some(x => text(x.path || x.key) === f.path && text(x.entity || "project") === "project"));
      if (!missing.length) break;
      try {
        await saveBranchModule(orgId, branch, "custom_fields", { data: { ...data, fields: [...fields, ...missing] }, metadata: object(module?.metadata), expected_revision: Number(module?.revision || 0) }, { replace: true });
        break;
      } catch (error) { if (!(error instanceof PlatformError) || error.code !== "revision_conflict" || attempt >= 2) throw error; }
    }
  }
}

const BINDINGS = {
  leads: { kind: "data", policy: "live", source: { provider: "crm", export: "opportunities", target: { scope: "organization", organizationId: "$organization" } } },
  update: { kind: "action", policy: "live", action: { action: "crm.leads.update", target: { scope: "organization", organizationId: "$organization" } } },
  notify: { kind: "action", policy: "live", action: { action: "notification.create.v1", target: { scope: "organization", organizationId: "$organization" } } }
};

/**
 * The preset routing program. inputs.settings is the routing settings; inputs.mode is "assign" (a new lead,
 * state.trigger.project_id) or "reassign" (a sweep of leads nobody touched in time). Writes crm.owner,
 * crm.routed_at and crm.route_count, and tells the new owner.
 */
export const ROUTING_PROGRAM = String.raw`
const s = inputs.settings || {};
const mode = inputs.mode || 'assign';
const OWNER = 'cf.crm.owner', AT = 'cf.crm.routed_at', COUNT = 'cf.crm.route_count';
const openRows = (await api.data.select('leads', { where: { match: 'all', rules: [{ field: 'state', operator: 'in', value: ['new_lead', 'open'] }] }, fields: ['id', 'title', OWNER, AT, COUNT, 'last_touch_at', 'created_at'], limit: 5000 })).map(r => r.value);
const recent = (await api.data.select('leads', { where: { match: 'all', rules: [{ field: AT, operator: 'after', value: 'now-30d' }] }, fields: ['id', OWNER, AT], limit: 5000 })).map(r => r.value);
const openCount = {}, lastAt = {}, recentCount = {};
for (const r of openRows) if (r[OWNER]) openCount[r[OWNER]] = (openCount[r[OWNER]] || 0) + 1;
for (const r of recent) { const o = r[OWNER]; if (!o) continue; recentCount[o] = (recentCount[o] || 0) + 1; if (!lastAt[o] || String(r[AT]) > lastAt[o]) lastAt[o] = String(r[AT]); }
async function matches(projectId, conditions) {
  if (!conditions || !Array.isArray(conditions.rules) || !conditions.rules.length) return true;
  const rows = await api.data.select('leads', { where: { match: 'all', rules: [{ field: 'id', operator: 'equals', value: projectId }, conditions] }, fields: ['id'], limit: 5 });
  return rows.length > 0;
}
async function poolFor(projectId) {
  if (s.method === 'rules') {
    for (const rule of s.rules || []) if ((rule.user_ids || []).length && await matches(projectId, rule.conditions || {})) return { people: rule.user_ids, rule: rule.id };
  }
  return { people: s.user_ids || [], rule: '' };
}
function pick(people, exclude) {
  let list = people.filter(u => !exclude.includes(u));
  if (s.max_open_leads > 0) list = list.filter(u => (openCount[u] || 0) < s.max_open_leads);
  if (!list.length) return '';
  const order = (u) => people.indexOf(u);
  const by = (score) => list.slice().sort((a, b) => score(a) - score(b) || order(a) - order(b))[0];
  if (s.method === 'balanced') return by(u => openCount[u] || 0);
  if (s.method === 'weighted') return by(u => (recentCount[u] || 0) / Math.max(0.01, (s.weights || {})[u] ?? 1));
  return list.slice().sort((a, b) => String(lastAt[a] || '').localeCompare(String(lastAt[b] || '')) || order(a) - order(b))[0];
}
async function route(row, exclude) {
  const pool = await poolFor(row.id);
  let owner = pick(pool.people, exclude);
  if (!owner) owner = pick(s.fallback_user_ids || [], exclude);
  if (!owner) return { project_id: row.id, owner: '', reason: 'nobody_available' };
  const values = { 'crm.owner': { subject_type: 'organization_user', subject_id: owner }, 'crm.routed_at': api.now, 'crm.route_count': Number(row[COUNT] || 0) + 1 };
  await api.actions.invoke('update', { project_id: row.id, values });
  openCount[owner] = (openCount[owner] || 0) + 1; lastAt[owner] = api.now;
  if (s.notify !== false) await api.actions.invoke('notify', {
    id: 'crm_routed_' + row.id + '_' + (Number(row[COUNT] || 0) + 1), title: exclude.length ? 'A lead was passed to you' : 'New lead assigned to you',
    body: String(row.title || 'A new lead') + (exclude.length ? ' was not worked in time and is yours now.' : ' is yours.'),
    target_user_ids: [owner], frontend_action: { kind: 'open_project', project_id: row.id, project_tab: 'overview' }
  });
  return { project_id: row.id, owner, rule: pool.rule, reason: exclude.length ? 'reassigned' : 'assigned' };
}
const results = [];
if (mode === 'assign') {
  const projectId = (state.trigger || {}).project_id;
  const row = openRows.find(r => r.id === projectId);
  if (!row) results.push({ project_id: projectId || '', owner: '', reason: 'not_an_open_lead' });
  else if (row[OWNER]) results.push({ project_id: row.id, owner: row[OWNER], reason: 'already_owned' });
  else results.push(await route(row, []));
} else {
  const minutes = Number(s.reassign_after_minutes || 0);
  if (minutes > 0) {
    const stale = (await api.data.select('leads', { where: { match: 'all', rules: [
      { field: 'state', operator: 'in', value: ['new_lead', 'open'] }, { field: OWNER, operator: 'is_present' },
      { field: AT, operator: 'before', value: 'now-' + minutes + 'm' }, { field: COUNT, operator: 'less_than', value: Number(s.reassign_limit ?? 2) + 1 }
    ] }, fields: ['id', 'title', OWNER, AT, COUNT, 'last_touch_at'], limit: 200, orderBy: { field: AT, direction: 'asc' } })).map(r => r.value)
      .filter(r => !r.last_touch_at || String(r.last_touch_at) < String(r[AT])).slice(0, 15);
    for (const row of stale) results.push(await route(row, [row[OWNER]]));
  }
}
return { outputs: { results } };
`;

/** The preset scoring program: the points of every score rule the lead matches, written to crm.score. */
export const SCORING_PROGRAM = String.raw`
const projectId = (state.trigger || {}).project_id;
if (!projectId) return { outputs: { score: null } };
const found = await api.data.select('leads', { where: { match: 'all', rules: [{ field: 'id', operator: 'equals', value: projectId }] }, fields: ['id', 'cf.crm.score'], limit: 5 });
if (!found.length) return { outputs: { score: null } };
let score = 0; const reasons = [];
for (const rule of inputs.rules || []) {
  const c = rule.conditions || {};
  if (!Array.isArray(c.rules) || !c.rules.length) { score += Number(rule.points || 0); reasons.push(rule.id); continue; }
  const hit = await api.data.select('leads', { where: { match: 'all', rules: [{ field: 'id', operator: 'equals', value: projectId }, c] }, fields: ['id'], limit: 5 });
  if (hit.length) { score += Number(rule.points || 0); reasons.push(rule.id); }
}
if (Number(found[0].value['cf.crm.score']) !== score) await api.actions.invoke('update', { project_id: projectId, values: { 'crm.score': score } });
return { outputs: { score, reasons } };
`;

const anyObject = { type: "object", additionalProperties: true };
function program(idValue: string, source: string, inputs: JsonObject, bindings: JsonObject) {
  return { id: idValue, source, policy: "live", mode: "command", inputs, inputSchema: anyObject, outputSchema: anyObject, bindings };
}

/** The organization rules the settings stand for; every rule id starts with crm_routing_. */
export function routingRules(settings: RoutingSettings): JsonObject[] {
  const rules: JsonObject[] = [];
  const r = settings.routing, routingSource = text(settings.custom.routing_source) || ROUTING_PROGRAM;
  if (r.enabled) {
    rules.push({ id: `${ROUTING_RULE_PREFIX}assign`, enabled: true, title: "Route each new lead to an owner", explainer: "Lead routing in CRM settings: picks the lead's owner when it arrives.",
      event: "lead.received", conditions: {}, automation: "scope.code.run.v1", input: program("crm_lead_routing", routingSource, { settings: r, mode: "assign" }, BINDINGS) });
    if (r.reassign_after_minutes > 0) rules.push({ id: `${ROUTING_RULE_PREFIX}reassign`, enabled: true, title: "Pass on leads nobody worked in time", explainer: `Lead routing in CRM settings: a lead untouched ${r.reassign_after_minutes} minutes after it was routed goes to the next person.`,
      schedule: { cron: "*/5 * * * *" }, conditions: {}, automation: "scope.code.run.v1", input: program("crm_lead_reassign", routingSource, { settings: r, mode: "reassign" }, BINDINGS) });
  }
  const sc = settings.scoring, scoringSource = text(settings.custom.scoring_source) || SCORING_PROGRAM;
  if (sc.enabled && sc.rules.length) {
    for (const event of ["lead.received", "crm.disposition.recorded", "project.event_scheduled", "project.event.completed", "opportunity.won", "opportunity.lost"]) {
      rules.push({ id: `${ROUTING_RULE_PREFIX}score_${event.replace(/[^a-z]+/g, "_")}`, enabled: true, title: "Score the lead", explainer: `Lead scoring in CRM settings: rescores the lead on ${event}.`,
        event, conditions: {}, automation: "scope.code.run.v1", input: program("crm_lead_scoring", scoringSource, { rules: sc.rules }, { leads: BINDINGS.leads, update: BINDINGS.update }) });
    }
  }
  return rules;
}

/** Saves the settings and replaces the generated rules (and only those) in the organization's rules. */
export async function saveRouting(orgId: string, value: unknown, authorUserId: string) {
  const settings = normalizeRouting(object(value).data ?? value);
  if (settings.routing.enabled || settings.scoring.enabled) await ensureFields(orgId);
  await saveBranchModule(orgId, "default", ROUTING_MODULE, { data: settings, metadata: { kind: "crm_routing" } }, { replace: true });
  const { readAutomationRules, saveAutomationRules } = await import("../work/rules.js");
  const current = await readAutomationRules(orgId, "default");
  const kept = current.rules.filter(rule => !text(rule.id).startsWith(ROUTING_RULE_PREFIX));
  await saveAutomationRules(orgId, "default", { expected_revision: current.revision, rules: [...kept, ...routingRules(settings)] }, { authorUserId });
  return settings;
}
