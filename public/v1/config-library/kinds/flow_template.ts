import { z } from "zod";
import { flowDefinitionSchema } from "../../flows/contracts.js";
import { ACTION_CATALOG } from "../../work/automations/catalog.js";
import type { LibraryKind } from "../contracts.js";

export const FLOW_TEMPLATE_KIND = "flow_template";

/**
 * Starting points for flows (docs/architecture/flows.md): call scripts and workflows an organization copies and then
 * edits on its own. The definition is checked by the flow contract; every automation a block or outcome names must
 * be in the automation catalog.
 */
export const flowTemplateEntrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).default(""),
  category: z.enum(["Leads", "Calls", "Workflows", "Forms"]).default("Workflows"),
  sort_order: z.number().int().min(0).max(10_000).default(100),
  definition: flowDefinitionSchema
}).strict();
export type FlowTemplateEntry = z.infer<typeof flowTemplateEntrySchema>;

export const flowTemplateKind: LibraryKind<FlowTemplateEntry> = {
  kind: FLOW_TEMPLATE_KIND,
  title: "Flow templates",
  description: "Starting points for call scripts and workflows: steps of blocks with branches and outcomes. An organization copies one and edits its own flow after that.",
  schema: flowTemplateEntrySchema as unknown as z.ZodType<FlowTemplateEntry>,
  titleOf: (data) => data.name,
  validate(data) {
    const problems: string[] = [];
    const named = [
      ...data.definition.steps.flatMap((step) => step.blocks.flatMap((block) => block.kind === "action" ? [block.automation] : [])),
      ...data.definition.outcomes.flatMap((outcome) => outcome.effects.map((effect) => effect.automation))
    ];
    for (const automation of new Set(named)) if (!ACTION_CATALOG[automation]) problems.push(`There is no automation ${automation}.`);
    return problems;
  }
};
