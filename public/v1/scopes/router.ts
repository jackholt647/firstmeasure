import { CONDITION_OPERATORS, evaluateConditions } from "../work/conditions.js";
import { PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { readScopeTemplate } from "./storage.js";
import { instantiateScopeTemplateWorkPlan } from "./service.js";
import { listPlanRecords } from "../work/storage.js";
import { isScopePlan } from "../work/opportunities.js";

export const INTAKE_ROUTING_MODULE_ID = "intake_routing";
export const DEFAULT_PIPELINE_TEMPLATE_ID = "sales_pipeline";
export const PIPELINE_SOURCE_TYPE = "pipeline";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function contextPath(source: JsonObject, path: string) {
  return path.split(".").reduce<unknown>((value, key) => (
    value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject)[key] : undefined
  ), source);
}

function conditionsMatchProject(conditions: JsonObject, project: JsonObject) {
  return Object.entries(conditions).every(([path, expected]) => {
    const actual = contextPath(project, path);
    if (Array.isArray(expected)) return expected.map(cleanText).includes(cleanText(actual));
    return cleanText(actual) === cleanText(expected);
  });
}

function normalizeClause(value: unknown, index: number) {
  const clause = asObject(value);
  const operator = CONDITION_OPERATORS.some((entry) => entry.id === cleanText(clause.operator))
    ? cleanText(clause.operator)
    : "equals";
  return {
    id: cleanText(clause.id) || `condition_${index + 1}`,
    field: cleanText(clause.field || clause.path),
    operator,
    value: clause.value ?? ""
  };
}

function formulaMatchesProject(value: unknown, project: JsonObject) {
  const formula = asObject(value);
  const clauses = asArray(formula.conditions).map(normalizeClause).filter((clause) => clause.field);
  if (!clauses.length) return false;
  const matches = clauses.map((clause) => {
    // Routing shares the automation condition contract; project fields are
    // matched case-insensitively and a comma-separated value is a list.
    return evaluateConditions(clause, project, { caseInsensitive: true, commaLists: true, payloadFallback: false });
  });
  return cleanText(formula.match).toLowerCase() === "any" ? matches.some(Boolean) : matches.every(Boolean);
}

export const MANUAL_TEMPLATE_ID = "manual";
type IntakeEntry = { entry: "scope"; template_id: string } | { entry: "unscoped" };

function normalizeEntry(value: unknown) {
  return cleanText(value) === "unscoped" ? "unscoped" : "scope";
}

// Until an organization saves its own routing, a missed call (nothing known
// about the caller or the work) arrives with no scope.
const DEFAULT_RULES = [{
  id: "missed_calls_unscoped",
  title: "Missed calls start without a scope",
  entry: "unscoped",
  formula: { match: "all", conditions: [{ field: "lead_source.kind", operator: "in", value: "missed_call" }] }
}];

function normalizeRouting(value: unknown) {
  const raw = asObject(value);
  const input = Object.prototype.hasOwnProperty.call(raw, "rules") ? raw : { ...raw, rules: DEFAULT_RULES };
  const calls = asObject(input.call_leads);
  return {
    schema_version: 3,
    // What a lead gets when no rule matches: a scope (`default_template_id`)
    // or nothing yet (`unscoped`: the project is a new lead). Each industry
    // preset picks the default (docs/architecture/opportunities.md).
    default_entry: normalizeEntry(input.default_entry),
    default_template_id: cleanText(input.default_template_id) || DEFAULT_PIPELINE_TEMPLATE_ID,
    // The scope the project window preselects for a project made by hand.
    manual_template_id: cleanText(input.manual_template_id) || MANUAL_TEMPLATE_ID,
    // Open opportunities a project may have at once; 0 (the default) means no limit.
    // A missed call or voicemail with no project: from a number no contact has,
    // or from a known contact, it either becomes a lead or is only logged.
    call_leads: {
      unknown_numbers: cleanText(calls.unknown_numbers) === "log" ? "log" : "new_lead",
      known_contacts: cleanText(calls.known_contacts) === "new_lead" ? "new_lead" : "log"
    },
    max_open_opportunities: Number.isInteger(Number(input.max_open_opportunities)) && Number(input.max_open_opportunities) >= 0 ? Number(input.max_open_opportunities) : 0,
    routing_mode: Object.prototype.hasOwnProperty.call(input, "routing_mode")
      ? (cleanText(input.routing_mode) === "formula" ? "formula" : "default")
      : (asArray(input.rules).length ? "formula" : "default"),
    rules: asArray(input.rules).map(asObject).map((rule, index) => ({
      id: cleanText(rule.id) || `intake_rule_${index + 1}`,
      enabled: rule.enabled !== false,
      title: cleanText(rule.title),
      // Dot-path equality conditions evaluated against the project document,
      // e.g. { "lead_source.template": "roofing_instant_estimate" } or { "source": ["canvassing", "call"] }.
      conditions: asObject(rule.conditions),
      formula: {
        match: cleanText(asObject(rule.formula).match).toLowerCase() === "any" ? "any" : "all",
        conditions: asArray(asObject(rule.formula).conditions).map(normalizeClause).filter((clause) => clause.field)
      },
      entry: normalizeEntry(rule.entry),
      template_id: cleanText(rule.template_id)
    }))
    // Settings groups scopes by their categories (scopes/categories.ts); routing no longer stores groups.
  };
}

export async function readIntakeRouting(orgId: string, branchId = "default") {
  try {
    const document = await readBranchModule(orgId, branchId || "default", INTAKE_ROUTING_MODULE_ID);
    return {
      ...normalizeRouting(document.data),
      revision: Number(document.revision || 0),
      updated_at: cleanText(document.updated_at)
    };
  } catch (error) {
    if (error instanceof PlatformError && error.statusCode === 404) {
      return { ...normalizeRouting({}), revision: 0, updated_at: "" };
    }
    throw error;
  }
}

export async function saveIntakeRouting(orgId: string, branchId: string, value: unknown) {
  const input = asObject(value);
  const routing = normalizeRouting(input.data || input);
  const document = await saveBranchModule(orgId, branchId || "default", INTAKE_ROUTING_MODULE_ID, {
    expected_revision: input.expected_revision,
    data: routing,
    metadata: { kind: "branch_intake_routing" }
  }, { replace: true });
  return {
    ...normalizeRouting(document.data),
    revision: Number(document.revision || 0),
    updated_at: cleanText(document.updated_at)
  };
}

/** Where a lead enters: the first enabled matching rule, else the default. */
export function resolveIntakeEntry(routing: JsonObject, project: JsonObject): IntakeEntry {
  const rules = cleanText(routing.routing_mode) === "default" ? [] : asArray(routing.rules).map(asObject);
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const unscoped = cleanText(rule.entry) === "unscoped";
    if (!unscoped && !cleanText(rule.template_id)) continue;
    const formula = asObject(rule.formula);
    const matches = asArray(formula.conditions).length
      ? formulaMatchesProject(formula, project)
      : conditionsMatchProject(asObject(rule.conditions), project);
    if (matches) return unscoped ? { entry: "unscoped" } : { entry: "scope", template_id: cleanText(rule.template_id) };
  }
  return cleanText(routing.default_entry) === "unscoped" || !cleanText(routing.default_template_id)
    ? { entry: "unscoped" }
    : { entry: "scope", template_id: cleanText(routing.default_template_id) };
}

/**
 * Starts a lead's entry scope, once, when it arrives (`receiveLead`). Nothing
 * else routes a project: opening, editing or proposing on one never does. A
 * project that already has a plan, routing that says `unscoped`, or an entry
 * template that is missing or disabled leaves the project as a new lead.
 */
export async function routeNewLead(orgId: string, projectValue: JsonObject) {
  const project = asObject(projectValue);
  const projectId = cleanText(project.id || project.project_id);
  if (!projectId) return null;
  if ((await listPlanRecords(orgId, { project_id: projectId })).some(isScopePlan)) return null;
  const branchId = cleanText(project.branch_id || "default") || "default";
  const entry = resolveIntakeEntry(await readIntakeRouting(orgId, branchId), project);
  if (entry.entry === "unscoped") return null;
  const template: JsonObject = await readScopeTemplate(orgId, branchId, entry.template_id).catch(() => ({} as JsonObject));
  if (!cleanText(template.id) || template.enabled === false || cleanText(template.status) === "archived") {
    console.warn("[intake] entry scope unavailable; the lead stays unscoped", { orgId, projectId, template_id: entry.template_id });
    return null;
  }
  return await startEntryScope(orgId, projectId, branchId, template, { project_created_at: cleanText(project.created_at), intake_routing: true });
}

/** The entry plan of a new project, from intake routing or a project made by hand. */
export async function startEntryScope(orgId: string, projectId: string, branchId: string, template: JsonObject, context: JsonObject = {}) {
  return await instantiateScopeTemplateWorkPlan(orgId, {
    project_id: projectId,
    branch_id: branchId,
    template,
    source_type: PIPELINE_SOURCE_TYPE,
    source_id: cleanText(template.id),
    source_key: `${PIPELINE_SOURCE_TYPE}:${projectId}:${cleanText(template.id)}`,
    context
  });
}
