import { z } from "zod";

import { actionCatalogEntry } from "../../work/automations/catalog.js";
import { workEventDefinition } from "../../work/events.js";
import { compileSequences } from "../../work/sequences.js";
import { scopeTemplateDefinitionSchema } from "../../scopes/schemas.js";
import type { LibraryKind, RegistryChecks } from "../contracts.js";

export const SCOPE_TEMPLATE_KIND = "scope_template";

/**
 * The scope library (docs/architecture/opportunities.md, docs/architecture/automation-authoring.md): every scope
 * template the platform ships. An entry is one complete scope template definition, exactly what an organization's
 * copy starts as. Entries without `metadata.industry_preset` are installed in every organization; an industry entry
 * is added only by the CRM setup for its pack (crm/presets.ts). The structure below the top level is owned by
 * `scopeTemplateDefinitionSchema` and the automation checks in `validate`.
 */
type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => String(value ?? "").trim();
const id = z.string().trim().min(1).max(180);

const label = z.string().trim().min(1).max(300);
const visitAction = z.object({
  id: id.optional(),
  label,
  transition: id,
  icon: z.string().trim().max(120).optional(),
  tone: z.enum(["success", "warning", "neutral", "danger"]).optional(),
  notify: z.object({ channel: z.enum(["sms", "email"]), message: z.string().trim().min(1).max(2000) }).strict().optional(),
  effect: z.object({ kind: z.enum(["send_workflow_to_portal"]), scope_template_id: id }).strict().optional()
}).strict();
/** The guided field visit on appointments of these event types (workforce/crew_api.ts). */
const visitWorkflowSchema = z.object({
  enabled: z.boolean(),
  id,
  title: label,
  event_types: z.array(id).min(1).max(20),
  steps: z.array(z.object({
    id,
    title: label,
    navigation_title: label,
    kind: z.enum(["notification", "status", "workflow_prepare", "outcome", "workflow", "notes_followup", "follow_up", "summary", "complete", "checklist", "payment"]),
    description: z.string().trim().max(2000),
    action: visitAction.optional(),
    actions: z.array(visitAction).max(10).optional(),
    scope_template_id: id.optional(),
    target_tab: id.optional(),
    requires: z.enum(["workflow_complete"]).optional(),
    when: z.object({ step_id: id, action_ids: z.array(id).min(1) }).strict().optional()
  }).strict()).min(1).max(30)
}).strict();

const metadataSchema = z.object({
  /** A library default. An organization's copy keeps `preset: true` until someone edits it. */
  preset: z.literal(true),
  /** Set on industry sales scopes: installed by that industry's CRM pack, never in every organization. */
  industry_preset: z.string().trim().min(1).max(80).optional(),
  field_launch: z.object({
    enabled: z.boolean(),
    title: z.string().trim().min(1).max(300),
    description: z.string().max(2000),
    category: z.string().trim().min(1).max(120),
    icon: z.string().trim().max(120),
    keywords: z.array(z.string().trim().min(1).max(120)).max(50),
    frequent: z.boolean()
  }).strict().optional(),
  visit_workflow: visitWorkflowSchema.optional()
}).strict();

export const scopeTemplateEntrySchema = scopeTemplateDefinitionSchema.extend({
  measurement_schema_ids: z.array(id).max(20).optional(),
  metadata: metadataSchema
}).strict();
export type ScopeTemplateEntry = z.infer<typeof scopeTemplateEntrySchema>;

const WORK_EVENTS_AS_TRIGGERS = /^work\./;
/** Events a binding may listen for besides the registered catalog (bindings use lifecycle hooks such as onStarted). */
function bindingKeyProblems(key: string) {
  if (/^on[A-Z][A-Za-z]+$/.test(key)) return [];
  return workEventDefinition(key).description ? [] : [`binding key "${key}" is not a lifecycle hook or registered event`];
}

/** Automation, condition and event references across a definition: what reviewScopeAutomations checks at save time. */
export function scopeTemplateProblems(definition: Json, registries: Pick<RegistryChecks, "conditions" | "measurementSchema" | "measurementKey">) {
  const problems: string[] = [];
  const checkBindings = (bindings: unknown, where: string) => {
    for (const [key, entries] of Object.entries(obj(bindings))) {
      problems.push(...bindingKeyProblems(key).map((message) => `${where}: ${message}`));
      for (const [index, value] of list(entries).entries()) {
        const binding = obj(value);
        const at = `${where} › ${key}[${text(binding.id) || index}]`;
        if (!actionCatalogEntry(text(binding.automation))) problems.push(`${at}: unknown action "${text(binding.automation)}".`);
        if (binding.conditions !== undefined) problems.push(...registries.conditions(binding.conditions, `${at} conditions`));
      }
    }
  };
  const walk = (nodes: unknown[], path: string) => {
    for (const value of nodes) {
      const node = obj(value);
      const where = `${path}${text(node.id) || text(node.title)}`;
      checkBindings(node.automation_bindings, where);
      for (const [index, value] of list(node.external_triggers).entries()) {
        const trigger = obj(value);
        const at = `${where} › trigger[${text(trigger.id) || index}]`;
        const event = text(trigger.event);
        if (WORK_EVENTS_AS_TRIGGERS.test(event)) problems.push(`${at}: work events cannot be external triggers.`);
        else if (event !== "proposal.signed" && !workEventDefinition(event).description) problems.push(`${at}: "${event}" is not a registered event.`);
        if (trigger.conditions !== undefined) problems.push(...registries.conditions(trigger.conditions, `${at} conditions`));
      }
      for (const step of list(obj(node.sequence).steps).map(obj)) {
        if (step.conditions !== undefined) problems.push(...registries.conditions(step.conditions, `${where} › sequence step ${text(step.id)} conditions`));
      }
      walk(list(node.children), `${where} / `);
    }
  };
  const workPlan = obj(definition.work_plan);
  checkBindings(workPlan.automation_bindings, "scope");
  walk(compileSequences(list(workPlan.root_nodes) as never[]), "");
  for (const schemaId of list(definition.measurement_schema_ids)) {
    if (!registries.measurementSchema(text(schemaId))) problems.push(`measurement_schema_ids: there is no measurement schema called ${text(schemaId)}.`);
  }
  return problems;
}

export const scopeTemplateKind: LibraryKind<ScopeTemplateEntry> = {
  kind: SCOPE_TEMPLATE_KIND,
  title: "Scope library",
  description: "Scope templates the platform ships: stages, automations, lists, checklists and assignments for a kind of work. Every organization gets a copy of each; an industry scope (metadata.industry_preset) is added by that industry's CRM setup only. A copy follows the library until the organization edits it.",
  schema: scopeTemplateEntrySchema as unknown as z.ZodType<ScopeTemplateEntry>,
  titleOf: (data) => data.name,
  validate(data, ctx) {
    const problems: string[] = [];
    if (data.id !== ctx.id) problems.push(`The definition's id (${data.id}) must be the entry id (${ctx.id}).`);
    if (data.status && data.status !== "active") problems.push("A library scope template is active; organizations archive their own copies.");
    problems.push(...scopeTemplateProblems(data as unknown as Json, ctx.registries));
    for (const step of data.metadata.visit_workflow?.steps || []) {
      for (const named of [step.scope_template_id, ...[step.action, ...(step.actions || [])].map((action) => action?.effect?.scope_template_id)]) {
        if (named && named !== ctx.id && !ctx.registries.entry(SCOPE_TEMPLATE_KIND, named)) problems.push(`metadata.visit_workflow step ${step.id}: there is no scope template ${named} in the library.`);
      }
    }
    for (const resourceList of list(obj(data.resources).lists).map(obj)) {
      for (const item of list(resourceList.items).map(obj)) {
        const meta = obj(item.metadata);
        const where = `resources ${text(resourceList.id)} › ${text(item.id)}`;
        const single = text(meta.quantity_measurement);
        if (single && !ctx.registries.measurementKey(single)) problems.push(`${where}: there is no measurement ${single}.`);
        // A fallback list: the first measurement a report has is used, so at least one must be in the dictionary.
        const fallbacks = list(meta.quantity_measurements).map(text).filter(Boolean);
        if (fallbacks.length && !fallbacks.some((key) => ctx.registries.measurementKey(key))) problems.push(`${where}: none of ${fallbacks.join(", ")} is a measurement.`);
      }
    }
    return problems;
  },
  /** Copies live in the organization's default branch (scopes/storage.ts). */
  orgCopies: {
    status: async (orgId, ids) => (await import("../../scopes/storage.js")).scopeLibraryCopyStatus(orgId, "default", ids),
    reset: async (ctx, id) => (await import("../../scopes/storage.js")).resetScopeTemplateToLibrary(ctx.orgId, "default", id)
  }
};
