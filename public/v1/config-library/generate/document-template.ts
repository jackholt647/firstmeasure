import type { GeneratedEntry, Generator } from "./index.js";
import { DOCUMENT_TEMPLATE_KIND } from "../kinds/document-template.js";

type Json = Record<string, any>;
const ROOFING_PACK_ITEMS = ["gaf_hd", "gutter_replace"];

/**
 * The roofing sales pack as seedInstantRoofingDocuments made it (signup-sandbox/roofing-documents.ts, pack 17),
 * without an organization: the per-square rate is left at 0 and named in `pricebook_defaults`, filled from the
 * organization's price book when its copy is made.
 */
export async function roofingPack() {
  const { ROOFING_ESTIMATES, roofingEstimateDefinition, scopedWorkflowSteps } = await import("../../signup-sandbox/roofing-documents.js");
  return ROOFING_ESTIMATES.map((spec) => {
    const id = `tpl_instant_roofing_${spec.key}`, workflowId = `wfl_instant_roofing_${spec.key}`;
    const definition = roofingEstimateDefinition(spec.key, { roof: 0, gutter: 0 }) as Json;
    const params = definition.params as Json;
    const pricebookDefaults = params.rate_cents ? [{ param: "rate_cents", item_id: "gaf_hd" }] : [];
    const fields = ["structure", "roof_squares", "waste_percent", "color", "ridge_vent", ...(spec.key === "package" ? ["package_cents"] : ["rate_cents"])];
    const paramItem = (key: string) => ({ kind: params[key]?.type === "string" ? "text" : params[key]?.type, writes: `params.${key}`, label: params[key]?.label, required: true });
    const steps = spec.scope ? scopedWorkflowSteps(spec, id) : [
      { id: "scope", title: "Define the work", audience: ["internal"], items: fields.map(paramItem) },
      { id: "review", title: "Review estimate", audience: ["internal"], items: [{ kind: "review", label: "Review before sending" }], preview: { template_ref: id, live: true } }
    ];
    const completion = spec.presentation ? { offers: ["present", "send_estimate", "send_presentation"], default: "present", presentation: { module_id: `preset_presentation_roofing_${spec.presentation}` } } : null;
    const metadata: Json = spec.scope ? { customer_presentation: { tab: { id: "documents", label: "Documents", icon: "fa-file-lines", order: 60 }, mode: "hybrid", workflow_cta: spec.key === "options" ? "Choose your roof & approve" : "Choose options & approve" } } : {};
    return {
      template: { id, data: { name: spec.title, document_type: "proposal", description: spec.description, status: "active", seeding: "every_organization", definition, metadata: { ...metadata, default: spec.key === "detailed", default_workflow_id: workflowId }, requires_pricebook_items: ROOFING_PACK_ITEMS, pricebook_defaults: pricebookDefaults } },
      workflow: { id: workflowId, data: { name: spec.title, description: spec.description, status: "active", seeding: "with_template", definition: { schema_version: 1, name: spec.title, contract: { params: definition.params, outputs: definition.outputs }, steps, ...(completion ? { completion } : {}) }, metadata, pricebook_defaults: pricebookDefaults } }
    };
  });
}

/** The Operations scope of work and proposal (operations/document-definitions.ts, revision 1). */
export async function operationsDocuments() {
  const { operationsDocumentDefinition, operationsWorkflowDefinition } = await import("../../operations/document-definitions.js");
  return (["scope", "proposal"] as const).map((path) => {
    const id = `tpl_operations_${path}_v1`, workflowId = `wfl_operations_${path}_v1`;
    const definition = operationsDocumentDefinition(path);
    const workflow = operationsWorkflowDefinition(path, definition);
    return {
      template: { id, data: { name: path === "scope" ? "Scope of work" : "Project proposal", document_type: path === "scope" ? "scope_of_work" : "proposal", status: "active", seeding: "on_request", definition, metadata: { default_workflow_id: workflowId } } },
      workflow: { id: workflowId, data: { name: String(workflow.name), status: "active", seeding: "with_template", definition: workflow } }
    };
  });
}

/** One-shot: every template documents/seeds.ts, the roofing pack and Operations made (DOCUMENT_PRESET_REVISION 38). */
export const documentTemplateGenerator: Generator = {
  kind: DOCUMENT_TEMPLATE_KIND,
  async run() {
    const { TEMPLATE_SEEDS, SCOPE_TEMPLATE_SEEDS } = await import("../../documents/seeds.js");
    const entries: GeneratedEntry[] = [];
    for (const seed of TEMPLATE_SEEDS) {
      const metadata = (seed.metadata || {}) as Json;
      entries.push({ id: seed.id, data: { name: seed.name, document_type: seed.document_type, description: seed.description, status: "active", seeding: "every_organization", definition: seed.definition(), metadata, initial_metadata: metadata.default === undefined ? { default: true } : {} } });
    }
    // Templates an industry scope issues by id: made the first time it does, archived (out of the picker).
    for (const seed of SCOPE_TEMPLATE_SEEDS) {
      entries.push({ id: seed.id, data: { name: seed.name, document_type: seed.document_type, description: seed.description, status: "archived", seeding: "on_request", definition: seed.definition(), metadata: seed.metadata || {} } });
    }
    for (const item of await roofingPack()) entries.push(item.template);
    for (const item of await operationsDocuments()) entries.push(item.template);
    return entries;
  }
};
