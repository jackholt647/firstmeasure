import { z } from "zod";

import { formDefinitionSchema, formItems, requiredFormFlags } from "../../forms/contracts.js";
import { measurementSource } from "../../forms/sources.js";
import type { LibraryKind } from "../contracts.js";

export const FORM_TEMPLATE_KIND = "form_template";

/**
 * Starting points for new website forms (docs/architecture/forms.md). An entry is the picker's card plus the form
 * definition a new form starts as. A form copies its template once and has no tie to it afterwards, so
 * organizations keep no copies to report or reset. `requires` names the lead_forms capability flags the
 * template's blocks need; the definition itself is checked by `formDefinitionSchema`.
 */
const FLAG = z.enum(["contact_form", "appointment_form", "instant_estimate"]);

export const formTemplateEntrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400),
  icon: z.string().trim().regex(/^fa-[a-z0-9-]+$/),
  category: z.enum(["General", "Staff", "Scheduling", "Estimates"]),
  /** An industry pack's template; shown with that industry. */
  industry: z.string().trim().min(1).max(80).optional(),
  requires: z.array(FLAG).min(1).max(3),
  /** Place in the template picker. */
  sort_order: z.number().int().min(0).max(10_000),
  definition: formDefinitionSchema
}).strict();
export type FormTemplateEntry = z.infer<typeof formTemplateEntrySchema>;


export const formTemplateKind: LibraryKind<FormTemplateEntry> = {
  kind: FORM_TEMPLATE_KIND,
  title: "Form templates",
  description: "Starting points for new website forms: the picker card and the steps and blocks a new form starts with. A form copies its template once and is edited on its own after that.",
  schema: formTemplateEntrySchema as unknown as z.ZodType<FormTemplateEntry>,
  titleOf: (data) => data.name,
  validate(data, ctx) {
    const problems: string[] = [];
    if (data.definition.template !== ctx.id) problems.push(`definition.template must be the entry id (${ctx.id}), not ${data.definition.template}.`);
    for (const flag of data.requires) {
      if (!ctx.registries.capability(`lead_forms.${flag}`)) problems.push(`requires: there is no capability lead_forms.${flag}.`);
    }
    for (const flag of requiredFormFlags(data.definition)) {
      if (!data.requires.includes(flag as never)) problems.push(`requires must include ${flag}: the template's blocks need it.`);
    }
    for (const item of formItems(data.definition)) {
      if (item.kind === "property_measurement" && item.source && !measurementSource(item.source)) problems.push(`Block ${item.id}: there is no measurement source ${item.source}.`);
    }
    return problems;
  }
};
