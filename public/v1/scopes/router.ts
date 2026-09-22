import { PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { listScopeTemplates, readScopeTemplate } from "./storage.js";
import { instantiateScopeTemplateWorkPlan } from "./service.js";
import { listPlanRecords } from "../work/storage.js";

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
  const operator = ["equals", "not_equals", "contains", "in", "is_present", "is_missing"].includes(cleanText(clause.operator))
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
    const actual = contextPath(project, clause.field);
    const actualText = cleanText(actual).toLowerCase();
    const expectedValues = (Array.isArray(clause.value) ? clause.value : cleanText(clause.value).split(","))
      .map((entry) => cleanText(entry).toLowerCase()).filter(Boolean);
    if (clause.operator === "is_present") return actual !== undefined && actual !== null && cleanText(actual) !== "";
    if (clause.operator === "is_missing") return actual === undefined || actual === null || cleanText(actual) === "";
    if (clause.operator === "not_equals") return !expectedValues.includes(actualText);
    if (clause.operator === "contains") return expectedValues.some((expected) => actualText.includes(expected));
    if (clause.operator === "in") return expectedValues.includes(actualText);
    return expectedValues.includes(actualText);
  });
  return cleanText(formula.match).toLowerCase() === "any" ? matches.some(Boolean) : matches.every(Boolean);
}

function normalizeBucket(value: unknown, index: number) {
  const bucket = asObject(value);
  return {
    id: cleanText(bucket.id) || `scope_bucket_${index + 1}`,
    name: cleanText(bucket.name || bucket.title) || `Scope group ${index + 1}`,
    description: cleanText(bucket.description),
    sort_order: Number(bucket.sort_order ?? index),
    template_ids: [...new Set(asArray(bucket.template_ids).map(cleanText).filter(Boolean))],
    default_kinds: [...new Set(asArray(bucket.default_kinds).map(cleanText).filter(Boolean))]
  };
}

export const DEFAULT_SCOPE_BUCKETS = [
  { id: "sales", name: "Sales Scopes", description: "Scopes used to qualify, estimate, and sell work.", sort_order: 0, template_ids: [], default_kinds: ["pipeline", "sales"] },
  { id: "production", name: "Production Scopes", description: "Scopes used to plan and deliver sold work.", sort_order: 1, template_ids: [], default_kinds: ["production"] }
];

function normalizeRouting(value: unknown) {
  const input = asObject(value);
  const configuredBuckets = asArray(input.buckets);
  return {
    schema_version: 2,
    // Every project gets an entry scope. Conditional routing may choose a
    // more specific scope; this template is the guaranteed fallback.
    default_template_id: cleanText(input.default_template_id) || DEFAULT_PIPELINE_TEMPLATE_ID,
    routing_mode: Object.prototype.hasOwnProperty.call(input, "routing_mode")
      ? (cleanText(input.routing_mode) === "formula" ? "formula" : "default")
      : (asArray(input.rules).length ? "formula" : "default"),
    rules: asArray(input.rules).map(asObject).map((rule, index) => ({
      id: cleanText(rule.id) || `intake_rule_${index + 1}`,
      enabled: rule.enabled !== false,
      title: cleanText(rule.title),
      // Dot-path equality conditions evaluated against the project document,
      // e.g. { "lead_source.kind": "instant_estimate" } or { "source": ["canvassing", "call"] }.
      conditions: asObject(rule.conditions),
      formula: {
        match: cleanText(asObject(rule.formula).match).toLowerCase() === "any" ? "any" : "all",
        conditions: asArray(asObject(rule.formula).conditions).map(normalizeClause).filter((clause) => clause.field)
      },
      template_id: cleanText(rule.template_id)
    })),
    buckets: (configuredBuckets.length ? configuredBuckets : DEFAULT_SCOPE_BUCKETS).map(normalizeBucket)
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

export function resolveIntakeTemplateId(routing: JsonObject, project: JsonObject) {
  const rules = cleanText(routing.routing_mode) === "default" ? [] : asArray(routing.rules).map(asObject);
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!cleanText(rule.template_id)) continue;
    const formula = asObject(rule.formula);
    const matches = asArray(formula.conditions).length
      ? formulaMatchesProject(formula, project)
      : conditionsMatchProject(asObject(rule.conditions), project);
    if (matches) return cleanText(rule.template_id);
  }
  return cleanText(routing.default_template_id);
}

async function activePipelinePlans(orgId: string, projectId: string) {
  return (await listPlanRecords(orgId, { project_id: projectId, source_type: PIPELINE_SOURCE_TYPE }))
    .filter((plan) => !["completed", "canceled"].includes(cleanText(plan.status)));
}

// Routes a project into its entry pipeline. Idempotent: a project with a live
// pipeline plan is left alone. Called on every project create/update the same
// way the old hardcoded sales plan was ensured.
export async function ensurePipelinePlanForProject(orgId: string, projectValue: JsonObject) {
  const project = asObject(projectValue);
  const projectId = cleanText(project.id || project.project_id);
  if (!projectId || cleanText(project.workflow_state) === "contact_only") return null;
  if ((await activePipelinePlans(orgId, projectId)).length) return null;
  const branchId = cleanText(project.branch_id || "default") || "default";
  const routing = await readIntakeRouting(orgId, branchId);
  const templateId = resolveIntakeTemplateId(routing, project);
  if (!templateId) return null;
  let template: JsonObject;
  try {
    template = (await readScopeTemplate(orgId, branchId, templateId));
  } catch {
    template = {};
  }
  if (!cleanText(template.id) || template.enabled === false) {
    const enabledTemplates = (await listScopeTemplates(orgId, branchId, {})) as JsonObject[];
    template = enabledTemplates.find((entry) => cleanText(entry.id) === DEFAULT_PIPELINE_TEMPLATE_ID)
      || enabledTemplates.find((entry) => cleanText(asObject(entry.definition).kind) === "pipeline")
      || enabledTemplates[0]
      || {};
    if (!cleanText(template.id) || template.enabled === false) return null;
  }
  return await instantiateScopeTemplateWorkPlan(orgId, {
    project_id: projectId,
    branch_id: branchId,
    template,
    source_type: PIPELINE_SOURCE_TYPE,
    source_id: cleanText(template.id),
    source_key: `${PIPELINE_SOURCE_TYPE}:${projectId}:${cleanText(template.id)}`,
    context: { project_created_at: cleanText(project.created_at), intake_routing: true }
  });
}
