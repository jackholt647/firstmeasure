import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, JsonSchema } from "../platform/publication/contracts.js";
import { badRequest, forbidden } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { libraryCopy, libraryData } from "../config-library/library.js";
import { DEFAULT_LEAD_FLOW, LEAD_FLOW_ANSWERS, type LeadFlow } from "../company-profile/catalog.js";
import { saveCompanyProfile } from "../company-profile/profile.js";
import { INTAKE_CATEGORY, SALES_CATEGORY, readScopeCategories, saveScopeCategories, templateCategoryIds } from "./categories.js";
import { readIntakeRouting, saveIntakeRouting } from "./router.js";
import { patchScopeFlags, readScopeFlagState, readScopeTemplate, saveScopeTemplate } from "./storage.js";
import { scopeTemplateDefinitionSchema } from "./schemas.js";
import { normalizeWorkPlanBindingKeys } from "../work/bindings.js";

/**
 * The Automations Hub setup (GP-110, GP-119; docs/architecture/automations-hub.md). It never asks how to configure
 * anything: it asks how the company runs (the company profile's `lead_flow`: does it know what a new lead's job is,
 * does it call first, does it meet the customer before pricing, who runs the job once sold) and builds the flow from
 * that. Every organization starts on the MVP platform's one pipeline (`generic_roofing`, from new lead to finished
 * job, in the Sales and Production lanes); the answers add a first call and an appointment to its front, leave new
 * leads waiting as new leads until a call says what the job is, or end it at the signature and hand the job to the
 * production board. What it writes is what the flowchart draws: the pipeline (and production board), their lanes,
 * which are on, and intake routing's default (rules are kept).
 */
export const PRODUCTION_CATEGORY = "production";
/** The MVP platform's one pipeline, as its sandbox configuration installs it. */
export const PIPELINE_TEMPLATE_ID = "generic_roofing";
export const PIPELINE_CONFIGURATION_ID = "swf_mvp_platform";
/** The production board a sold job is handed to when someone else runs it. */
export const PRODUCTION_TEMPLATE_ID = "roof_replacement";
/** Nodes and bindings the setup adds carry this id prefix, so running it again replaces them. */
const SETUP_PREFIX = "setup_";

const answer = <K extends keyof typeof LEAD_FLOW_ANSWERS>(key: K) => z.enum(LEAD_FLOW_ANSWERS[key]).optional();
const answersSchema = z.object({
  job_known: answer("job_known"), first_call: answer("first_call"), visit: answer("visit"), handoff: answer("handoff"),
  branch_id: z.string().trim().max(120).optional()
}).strict();
type Answers = z.infer<typeof answersSchema>;
const templateOut = z.object({
  id: z.string(), name: z.string(), color: z.string(), icon: z.string(), enabled: z.boolean(), status: z.string(), version: z.number().int(),
  definition: z.record(z.unknown()), install: z.boolean(), changed: z.boolean()
}).strict();
const planSchema = z.object({
  lead_flow: z.object({ job_known: z.string(), first_call: z.string(), visit: z.string(), handoff: z.string() }).strict(),
  routing: z.object({ default_entry: z.enum(["scope", "unscoped"]), default_template_id: z.string() }).strict(),
  pipeline_id: z.string(), production_id: z.string().nullable(), templates: z.array(templateOut)
}).strict();
const outputSchema = z.object({
  lead_flow: planSchema.shape.lead_flow, routing: planSchema.shape.routing, pipeline_id: z.string(), production_id: z.string().nullable(),
  category_ids: z.array(z.string()), routing_revision: z.number().int(), templates_changed: z.array(z.string())
}).strict();
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The answers with every question answered: an unanswered one is the MVP platform's way. */
export function leadFlowOf(answers: Partial<Record<keyof LeadFlow, string | null | undefined>>): LeadFlow {
  const pick = <K extends keyof LeadFlow>(key: K) => ((LEAD_FLOW_ANSWERS[key] as readonly string[]).includes(text(answers[key])) ? text(answers[key]) : DEFAULT_LEAD_FLOW[key]) as LeadFlow[K];
  return { job_known: pick("job_known"), first_call: pick("first_call"), visit: pick("visit"), handoff: pick("handoff") };
}

/** The lanes a board sits in: the lane categories it had are replaced, other categories stay. */
export function setupCategoryIds(current: string[], lanes: string[]) {
  const kept = current.filter((id) => id !== SALES_CATEGORY && id !== PRODUCTION_CATEGORY && id !== INTAKE_CATEGORY);
  return [...lanes, ...kept];
}

/** The MVP platform's pipeline as its configuration installs it: the library scope it starts from, its fields over it. */
export function pipelineSource(): JsonObject | null {
  const step = array(object(libraryData("sandbox_configuration", PIPELINE_CONFIGURATION_ID)).setup).map(object)
    .find((entry) => text(entry.action) === "sandbox.scopeTemplate.install" && text(object(entry.input).template_id) === PIPELINE_TEMPLATE_ID);
  if (!step) return null;
  const input = object(step.input);
  const base = libraryCopy<JsonObject>("scope_template", text(input.from) || PIPELINE_TEMPLATE_ID);
  if (!base) return null;
  delete base.sort_order;
  return { ...base, ...clone(object(input.template)), id: PIPELINE_TEMPLATE_ID };
}

// The steps the setup adds tick themselves when something later happens on the project, as the pipeline's own do.
const PROPOSAL_DONE = [
  { id: "proposal_document", event: "document.created", conditions: { "payload.document_type": "proposal" } },
  { id: "proposal", event: "proposal.created" },
  { id: "proposal_sent_document", event: "document.sent", conditions: { "payload.document_type": "proposal" } },
  { id: "proposal_sent", event: "proposal.sent" },
  { id: "proposal_signed", event: "document.signed", conditions: { "payload.document_type": "proposal" } },
  { id: "contract_signed", event: "document.signed", conditions: { "payload.document_type": "contract" } },
  { id: "esign", event: "proposal.esign.completed" }
];
const MEASURED = [{ id: "report_ordered", event: "measurement.report.ordered" }, { id: "report_delivered", event: "measurement.report.completed" }];
const BOOKED = { id: "appointment_booked", event: "project.event_scheduled", conditions: { "payload.event_type_default_id": "sales_appointment" } };
const HELD = { id: "appointment_held", event: "project.event.completed", conditions: { "payload.event_type_default_id": "sales_appointment" } };
const triggers = (own: JsonObject[], later: JsonObject[]) => [
  ...own.map((trigger) => ({ ...trigger, transition: "completed", explainer: "Done when this happens on the project." })),
  ...later.map((trigger) => ({ ...trigger, transition: "completed", explainer: "A later step happened first, so this one is done too." }))
];
const todo = (id: string, title: string, extra: JsonObject = {}) => ({ id, title, terminology_key: "work.task", actionable: true, show_in_todo_list: true, ...extra });

/** "Call the customer": the sales pipeline's first call (its call list and how the call went), on this board. */
function callTodo(): JsonObject {
  const library = object(array(object(array(object(object(libraryData("scope_template", "sales_pipeline")).work_plan).root_nodes)[0]).children)
    .map(object).flatMap((stage) => array(stage.children).map(object)).find((node) => text(node.id) === "contact_lead"));
  return todo(`${SETUP_PREFIX}call`, "Call the customer", {
    ...(library.automation_bindings ? { automation_bindings: clone(library.automation_bindings) } : {}),
    ...(library.metadata ? { metadata: clone(library.metadata) } : {}),
    external_triggers: triggers([BOOKED], [...MEASURED, ...PROPOSAL_DONE])
  });
}

/**
 * The pipeline the answers make, from its source: a first call (the first stage becomes "First call", its own steps
 * move to the next stage), an appointment after it, and, when someone else runs the sold job, the pipeline ends at
 * the signature (the step that marks the sale won) and its last stage starts the production board. Bindings someone
 * added to a stage of the current copy (a board wire drawn in the hub) are kept.
 */
export function pipelineDefinition(source: JsonObject, current: JsonObject | null, flow: LeadFlow, productionId: string | null): JsonObject {
  const definition = clone(source);
  const root = object(array(object(definition.work_plan).root_nodes)[0]);
  let stages = array(root.children).map(object);
  const groups = stages.length >= 2 && stages.every((stage) => stage.actionable !== true);
  const call = flow.job_known !== "no" && flow.first_call === "yes", visit = flow.visit === "yes";
  if (groups && (call || visit)) {
    const [first, second] = stages as [JsonObject, JsonObject];
    second.children = [...array(first.children), ...array(second.children)];
    first.children = [call ? callTodo() : todo(`${SETUP_PREFIX}book_appointment`, "Book the appointment", { external_triggers: triggers([BOOKED], [HELD, ...PROPOSAL_DONE]) })];
    if (call) first.title = "First call";
    if (visit) {
      const appointment = { id: `${SETUP_PREFIX}appointment`, title: "Appointment", description: "Meet the customer and see the job before the price.", terminology_key: "work.stage",
        completion_mode: "all_children", depends_on: [text(first.id)], metadata: { color: "#6b5ca5" },
        children: [todo(`${SETUP_PREFIX}meet_customer`, "Meet the customer", { external_triggers: triggers([HELD], PROPOSAL_DONE) })] };
      stages.splice(1, 0, appointment);
      second.depends_on = [appointment.id];
    }
  }
  if (groups && flow.handoff === "separate" && productionId) {
    const wins = (node: JsonObject): boolean => Object.values(object(node.automation_bindings)).some((list) => array(list).some((binding) => text(object(binding).automation) === "sales.markWon.v1"))
      || array(node.children).some((child) => wins(object(child)));
    const signed = stages.findIndex(wins);
    if (signed >= 0) stages = stages.slice(0, signed + 1);
    const last = stages[stages.length - 1]!;
    const bindings = last.automation_bindings = object(last.automation_bindings);
    bindings.onCompleted = [...array(bindings.onCompleted), { id: `${SETUP_PREFIX}start_production`, automation: "scopes.activateTemplate.v1",
      input: { template_id: productionId, instance_key: `flow_${PIPELINE_TEMPLATE_ID}` },
      explainer: "Set up in the Automations Hub: once the job is sold, it starts on the production board." }];
  }
  root.children = stages;
  // A wire someone drew from a stage stays, on the stage of the same id.
  if (current) {
    const nodes = new Map<string, JsonObject>();
    const index = (node: JsonObject) => { if (text(node.id)) nodes.set(text(node.id), node); array(node.children).map(object).forEach(index); };
    array(object(definition.work_plan).root_nodes).map(object).forEach(index);
    const carry = (node: JsonObject) => {
      const target = nodes.get(text(node.id));
      for (const [hook, list] of Object.entries(object(node.automation_bindings))) {
        if (!target) break;
        const own = object(target.automation_bindings);
        const have = new Set(array(own[hook]).map((binding) => text(object(binding).id)));
        const extra = array(list).map(object).filter((binding) => !text(binding.id).startsWith(SETUP_PREFIX) && !have.has(text(binding.id)));
        if (extra.length) target.automation_bindings = { ...own, [hook]: [...array(own[hook]), ...clone(extra)] };
      }
      array(node.children).map(object).forEach(carry);
    };
    array(object(object(current.definition).work_plan).root_nodes).map(object).forEach(carry);
  }
  const currentDefinition = object(current?.definition);
  for (const key of ["name", "description", "color", "icon"] as const) if (text(current?.[key] ?? currentDefinition[key])) definition[key] = text(current?.[key] ?? currentDefinition[key]);
  definition.category_ids = setupCategoryIds(templateCategoryIds(current ? currentDefinition : source), flow.handoff === "separate" ? [SALES_CATEGORY] : [SALES_CATEGORY, PRODUCTION_CATEGORY]);
  return definition;
}

/** Whether saving `next` would change what is stored (the save's own normalizing applied to both). */
function sameDefinition(stored: JsonObject, next: JsonObject) {
  const shape = (value: JsonObject) => {
    const parsed = scopeTemplateDefinitionSchema.safeParse(value);
    const definition = object(parsed.success ? parsed.data : value);
    return JSON.stringify([normalizeWorkPlanBindingKeys(definition.work_plan as Parameters<typeof normalizeWorkPlanBindingKeys>[0]), templateCategoryIds(definition), text(definition.name)]);
  };
  return shape(stored) === shape(next);
}

const view = (template: JsonObject | null, definition: JsonObject, enabled: boolean) => {
  const changed = !template || !sameDefinition(object(template.definition), definition);
  return {
    id: text(definition.id), name: text(definition.name), color: text(definition.color) || "#667085", icon: text(definition.icon) || "fa-diagram-project",
    enabled, status: "active", version: Number(template?.version || template?.current_version || 0), definition, install: !template,
    changed: changed || (template ? template.enabled === false : false) !== !enabled
  };
};

/** What the answers make, without saving anything: the pipeline and production board as they would be, and routing. */
export async function planAutomationsSetup(orgId: string, input: Answers) {
  const branchId = text(input.branch_id) || "default";
  const flow = leadFlowOf(input);
  const source = pipelineSource();
  if (!source) throw badRequest("automations_setup_pipeline_missing", "The MVP platform's pipeline is not in the config library.");
  const read = (id: string) => readScopeTemplate(orgId, branchId, id).then((found) => { const template = found as unknown as JsonObject; return text(template.status) === "archived" ? null : template; }).catch(() => null);
  const [current, production] = await Promise.all([read(PIPELINE_TEMPLATE_ID), read(PRODUCTION_TEMPLATE_ID)]);
  const separate = flow.handoff === "separate" && !!production;
  const pipeline = pipelineDefinition(source, current, flow, separate ? PRODUCTION_TEMPLATE_ID : null);
  const marker = object(object(pipeline.metadata).automations_setup);
  const turnedOn = !!object(object(object(current?.definition).metadata).automations_setup).production_turned_on;
  pipeline.metadata = { ...object(pipeline.metadata), automations_setup: { ...marker, production_turned_on: separate ? production!.enabled === false || turnedOn : false } };
  const templates = [view(current, pipeline, true)];
  if (production && (separate || turnedOn)) {
    const definition: JsonObject = { ...clone(object(production.definition)), id: PRODUCTION_TEMPLATE_ID, name: text(production.name) || text(object(production.definition).name) };
    if (separate) definition.category_ids = setupCategoryIds(templateCategoryIds(definition), [PRODUCTION_CATEGORY]);
    // A production board the setup turned on is turned off again when nobody is handed the job any more.
    templates.push(view(production, definition, separate || production.enabled !== false && !turnedOn));
  }
  return {
    lead_flow: flow,
    routing: { default_entry: flow.job_known === "no" ? "unscoped" as const : "scope" as const, default_template_id: PIPELINE_TEMPLATE_ID },
    pipeline_id: PIPELINE_TEMPLATE_ID, production_id: separate ? PRODUCTION_TEMPLATE_ID : null, templates
  };
}

export async function applyAutomationsSetup(orgId: string, input: Answers, authorUserId: string) {
  const branchId = text(input.branch_id) || "default";
  const plan = await planAutomationsSetup(orgId, input);
  // Production is an ordinary category: an organization that turned it off gets it back for the lane.
  const catalog = await readScopeCategories(orgId);
  const production = catalog.categories.find((category) => category.id === PRODUCTION_CATEGORY);
  if (!production || !production.enabled) {
    await saveScopeCategories(orgId, { categories: [...catalog.categories.filter((category) => category.id !== PRODUCTION_CATEGORY), { id: PRODUCTION_CATEGORY, label: production?.label || "Production", enabled: true }] });
  }
  const changed: string[] = [];
  for (const template of plan.templates) {
    if (template.changed && (template.install || !sameDefinition(object((await readScopeTemplate(orgId, branchId, template.id)).definition), template.definition))) {
      await saveScopeTemplate(orgId, branchId, { ...template.definition, ...(template.install ? {} : { expected_version: template.version || undefined }) } as JsonObject, { publicationAuthorId: authorUserId });
    }
    if (template.changed) changed.push(template.id);
  }
  const flags = await readScopeFlagState(orgId, branchId);
  const toggles = Object.fromEntries(plan.templates.filter((template) => flags.flags[template.id] !== template.enabled).map((template) => [template.id, template.enabled]));
  if (Object.keys(toggles).length) await patchScopeFlags(orgId, { expected_revision: flags.revision, flags: toggles }, branchId);
  const routing = await readIntakeRouting(orgId, branchId);
  const { revision, updated_at: _updatedAt, ...data } = routing;
  const saved = await saveIntakeRouting(orgId, branchId, { expected_revision: revision, data: { ...data, ...plan.routing } });
  // The answers are the company's: other setups and agents read them from the company profile.
  await saveCompanyProfile(orgId, { lead_flow: plan.lead_flow }, authorUserId);
  return { lead_flow: plan.lead_flow, routing: plan.routing, pipeline_id: plan.pipeline_id, production_id: plan.production_id,
    category_ids: templateCategoryIds(plan.templates[0]!.definition), routing_revision: saved.revision, templates_changed: changed };
}

const setupAccess: AccessPolicy = { scopes: ["organization"], permissions: ["manage_company_settings"], systemKinds: ["module", "agent"] };
const ANSWERS = "job_known (yes: almost every lead is the same kind of job, mostly, no: they find out on the phone), first_call (yes: they call every new lead first; not asked when job_known is no), visit (yes: they meet the customer before giving a price) and handoff (same: whoever sold it runs the job, separate: it is handed to someone else); a missing answer is the MVP platform's way (yes, no, no, same)";

let registered = false;
export function registerAutomationsSetupPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "automations-setup", version: "1", apps: ["automations-hub"], exports: {
    plan: { description: `What the Automations Hub setup's answers (args: ${ANSWERS}) would make, without saving anything: the MVP platform's pipeline (generic_roofing) and, when the job is handed off, the production board (roof_replacement), each as the scope template it would be (install: not in the organization yet; changed: different from what is saved), and intake routing's default (unscoped: new leads wait as new leads).`,
      schema: json(planSchema), argsSchema: json(answersSchema), schemaVersion: "1", access: setupAccess,
      read: async (ctx, ref) => ({ value: await planAutomationsSetup(ctx.organizationId, answersSchema.parse(ref.args || {})) }) }
  } });
  registerAction({ id: "automations.setup.apply", version: "2", domain: "work", implementation: backendImplementationDigest(),
    description: `The Automations Hub setup, from how the company runs: ${ANSWERS}. Saves the answers on the company profile (lead_flow) and builds the flow from them: the MVP platform's pipeline (generic_roofing, installed when missing) with a first call and an appointment at its front when asked for, in the Sales and Production lanes, or in Sales ending at the signature with its last stage starting the production board (roof_replacement, turned on) when someone else runs the job; new leads go onto the pipeline, or wait as new leads when they find out what the job is on the phone. Routing rules are kept.`,
    inputSchema: json(answersSchema) as Record<string, unknown>, outputSchema: json(outputSchema) as Record<string, unknown>,
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
    validateInput: (value) => { answersSchema.parse(value); },
    execute: async (ctx, _target, value) => {
      if (!ctx.auth) throw forbidden("automations_setup_person", "The automations setup is saved by a person.");
      return applyAutomationsSetup(ctx.organizationId, answersSchema.parse(value), ctx.auth.userId);
    } });
}
