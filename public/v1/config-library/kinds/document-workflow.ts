import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { workflowDefinitionSchema } from "../../documents/workflows/schemas.js";
import { workflowCompletionSchema } from "../../documents/modules/presentation-schema.js";
import {
  DOCUMENT_TEMPLATE_KIND, DOCUMENT_WORKFLOW_KIND, PRESENTATION_DECK_KIND, PRESENTATION_PRESET_PREFIX, asRecord, entrySchema, jsonObject, missingEntry, plainText, pricebookDefaultSchema
} from "./document-shared.js";

export { DOCUMENT_WORKFLOW_KIND };

/**
 * A document workflow organizations start with (docs/architecture/config-library.md): the steps that fill a
 * document, internal and customer-facing. `seeding` says when an organization's copy is made: for every
 * organization, or together with the template that names it as its `default_workflow_id`. A workflow whose last
 * step presents names the deck's module (`preset_presentation_<deck>`); the deck is copied to the organization
 * before the workflow is.
 */
const workflowShapeSchema = z.object({
  schema_version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  contract: z.object({ params: z.record(jsonObject).default({}), outputs: z.record(jsonObject).default({}) }).strict(),
  /** Steps and their items: their structure is the workflow schema's (documents/workflows/schemas.ts). */
  steps: z.array(jsonObject).min(1).max(60),
  audiences: jsonObject.optional(),
  completion: jsonObject.optional()
}).strict();

export const documentWorkflowEntrySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: plainText(2000).default(""),
  status: z.enum(["active", "archived"]).default("active"),
  seeding: z.enum(["every_organization", "with_template"]),
  definition: workflowShapeSchema,
  metadata: z.object({
    customer_presentation: z.object({
      tab: z.object({ id: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(80), icon: z.string().trim().max(80), order: z.number().int() }).strict(),
      mode: z.enum(["document", "workflow", "hybrid"]),
      workflow_cta: z.string().trim().max(120).optional(),
      document_cta: z.string().trim().max(120).optional(),
      auto_open: z.boolean().optional()
    }).strict().optional()
  }).strict().default({}),
  /** Contract parameters whose default is an item's price in the organization's price book, filled in at copy time. */
  pricebook_defaults: z.array(pricebookDefaultSchema).max(40).default([])
}).strict();
export type DocumentWorkflowEntry = z.infer<typeof documentWorkflowEntrySchema>;

/** The presentation deck a workflow's completion names, when it names a library deck. */
export function workflowDeckId(definition: unknown) {
  const moduleId = String(asRecord(asRecord(asRecord(definition).completion).presentation).module_id || "");
  return moduleId.startsWith(PRESENTATION_PRESET_PREFIX) ? moduleId.slice(PRESENTATION_PRESET_PREFIX.length) : "";
}

export const documentWorkflowKind: LibraryKind<DocumentWorkflowEntry> = {
  kind: DOCUMENT_WORKFLOW_KIND,
  title: "Document workflows",
  description: "Workflows that fill the library's document templates, internal and customer steps. Each organization keeps its own copy; an untouched copy follows the library.",
  schema: entrySchema(documentWorkflowEntrySchema),
  validate(data, ctx) {
    const errors: string[] = [];
    const parsed = workflowDefinitionSchema.safeParse(data.definition);
    if (!parsed.success) errors.push(...parsed.error.issues.slice(0, 20).map((issue) => `definition.${issue.path.join(".")}: ${issue.message}`));
    if (data.definition.completion !== undefined) {
      const completion = workflowCompletionSchema.safeParse(data.definition.completion);
      if (!completion.success) errors.push(...completion.error.issues.slice(0, 5).map((issue) => `definition.completion.${issue.path.join(".")}: ${issue.message}`));
      const moduleId = String(asRecord(asRecord(data.definition.completion).presentation).module_id || "");
      const deck = workflowDeckId(data.definition);
      if (moduleId && !deck) errors.push(`definition.completion.presentation: a library workflow presents a library deck (${PRESENTATION_PRESET_PREFIX}<deck id>), not ${moduleId}.`);
      if (deck && missingEntry(ctx, PRESENTATION_DECK_KIND, deck)) errors.push(`definition.completion.presentation: no presentation deck ${deck} in the library.`);
    }
    data.definition.steps.forEach((step, index) => {
      const template = String(asRecord(step.preview).template_ref || "");
      if (template && missingEntry(ctx, DOCUMENT_TEMPLATE_KIND, template)) errors.push(`definition.steps[${index}].preview.template_ref: no document template ${template} in the library.`);
    });
    for (const fill of data.pricebook_defaults) {
      if (!data.definition.contract.params[fill.param]) errors.push(`pricebook_defaults: the workflow contract has no parameter ${fill.param}.`);
    }
    return errors;
  },
  titleOf: (data) => data.name,
  orgCopies: {
    status: async (orgId, ids) => (await import("../../documents/library-copies.js")).documentCopyStatus("workflow", orgId, ids),
    reset: async (ctx, id) => (await import("../../documents/library-copies.js")).resetDocumentCopy("workflow", ctx, id)
  }
};
