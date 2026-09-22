import { z } from "zod";

import { workflowItemKind, registerBuiltinWorkflowItemKinds, WORKFLOW_WRITE_PATH_PATTERN } from "./kinds.js";

registerBuiltinWorkflowItemKinds();

/**
 * Workflow definition schema (contract §8):
 * { schema_version:1, name, contract:{params,outputs},
 *   steps:[{ id, title, when?, audience?, items:[{ kind, writes, ... }] }],
 *   audiences:{...} }
 *
 * Publish validation: every item's kind must be registered, its item object
 * must satisfy the kind's schema, and its writes path must be a params.* /
 * outputs.* path the kind allows AND (when the workflow declares a contract)
 * reference a declared contract key.
 */

const jsonObject = z.object({}).passthrough();

export const workflowAudienceSchema = z.enum(["internal", "customer", "field"]);

export const workflowItemEnvelopeSchema = z.object({
  kind: z.string().trim().min(1),
  writes: z.string().trim().optional(),
  label: z.string().trim().max(300).optional(),
  when: z.string().trim().optional(),
  required: z.boolean().optional()
}).passthrough();

export const workflowSectionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().max(300).optional(),
  when: z.string().trim().optional(),
  items: z.array(workflowItemEnvelopeSchema).optional(),
  style: jsonObject.optional(),
  layout: jsonObject.optional(),
  transition: jsonObject.optional()
}).passthrough();

export const workflowStepSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().max(300).optional(),
  kind: z.string().trim().optional(),
  when: z.string().trim().optional(),
  audience: z.array(workflowAudienceSchema).optional(),
  items: z.array(workflowItemEnvelopeSchema).optional(),
  sections: z.array(workflowSectionSchema).optional(),
  preview: jsonObject.optional()
}).passthrough();

export const workflowContractSchema = z.object({
  params: jsonObject.optional(),
  outputs: jsonObject.optional()
}).passthrough();

function contractRootKey(path: string) {
  const rest = path.split(".").slice(1).join(".");
  return rest.split(/[.[]/)[0] || "";
}

export const workflowDefinitionSchema = z.object({
  schema_version: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200),
  contract: workflowContractSchema.optional(),
  steps: z.array(workflowStepSchema).min(1),
  audiences: jsonObject.optional()
}).passthrough().superRefine((definition, ctx) => {
  const contract = definition.contract || {};
  const declaredParams = Object.keys((contract.params as Record<string, unknown>) || {});
  const declaredOutputs = Object.keys((contract.outputs as Record<string, unknown>) || {});
  const seenSteps = new Set<string>();
  definition.steps.forEach((step, stepIndex) => {
    const stepPath = ["steps", stepIndex];
    if (seenSteps.has(step.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...stepPath, "id"], message: `Duplicate step id '${step.id}'.` });
    }
    seenSteps.add(step.id);
    const itemGroups = [
      { items: step.items || [], path: [...stepPath, "items"] },
      ...(step.sections || []).map((section, sectionIndex) => ({ items: section.items || [], path: [...stepPath, "sections", sectionIndex, "items"] }))
    ];
    const seenSections = new Set<string>();
    (step.sections || []).forEach((section, sectionIndex) => {
      if (seenSections.has(section.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...stepPath, "sections", sectionIndex, "id"], message: `Duplicate section id '${section.id}'.` });
      seenSections.add(section.id);
    });
    itemGroups.forEach((group) => group.items.forEach((item, itemIndex) => {
      const itemPath = [...group.path, itemIndex];
      const kind = workflowItemKind(item.kind);
      if (!kind) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...itemPath, "kind"], message: `Unknown workflow item kind '${item.kind}'.` });
        return;
      }
      const parsed = kind.schema.safeParse(item);
      if (!parsed.success) {
        for (const issue of parsed.error.issues.slice(0, 5)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...itemPath, ...issue.path], message: issue.message });
        }
      }
      const writes = String(item.writes || "").trim();
      const writeCheck = kind.validate_write(writes);
      if (!writeCheck.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...itemPath, "writes"], message: writeCheck.reason || "Invalid writes path." });
        return;
      }
      if (!writes) return;
      if (!WORKFLOW_WRITE_PATH_PATTERN.test(writes)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...itemPath, "writes"], message: `writes must be a params.* or outputs.* path (got '${writes}').` });
        return;
      }
      // Contract check: when the workflow declares contract keys, every write
      // must target a declared key so fills never write undeclared data.
      const rootKey = contractRootKey(writes);
      if (writes.startsWith("params.") && declaredParams.length && !declaredParams.includes(rootKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...itemPath, "writes"], message: `writes references params.${rootKey}, which the workflow contract does not declare.` });
      }
      if (writes.startsWith("outputs.") && declaredOutputs.length && !declaredOutputs.includes(rootKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...itemPath, "writes"], message: `writes references outputs.${rootKey}, which the workflow contract does not declare.` });
      }
    }));
  });
});

// --- asset CRUD schemas (mirror templates/themes) ---------------------------

const optionalIdSchema = z.string().trim().max(160).optional();
const assetStatusSchema = z.enum(["draft", "active", "archived"]);

export const createWorkflowSchema = jsonObject.extend({
  id: optionalIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim()).optional(),
  status: assetStatusSchema.optional(),
  definition: workflowDefinitionSchema.optional(),
  metadata: jsonObject.optional()
}).passthrough();

export const patchWorkflowSchema = jsonObject.extend({
  expected_revision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim()).optional(),
  status: assetStatusSchema.optional(),
  metadata: jsonObject.optional()
}).passthrough();

export const publishWorkflowSchema = jsonObject.extend({
  definition: workflowDefinitionSchema,
  expected_version: z.number().int().min(0).optional()
}).passthrough();

/** Body for POST /documents/:documentId/workflow/state. */
export const workflowStateUpdateSchema = jsonObject.extend({
  current_step: z.string().trim().max(120).optional(),
  complete_step: z.string().trim().max(120).optional(),
  completed_steps: z.array(z.string().trim()).optional(),
  expected_revision: z.number().int().positive().optional()
}).passthrough();
