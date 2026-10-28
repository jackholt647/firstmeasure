import { formTemplate, listFormTemplates } from "../../forms/templates.js";
import type { Generator } from "./index.js";

/** One-shot: form templates from today's builders. The picker order becomes `sort_order`. */
export const formTemplateGenerator: Generator = {
  kind: "form_template",
  run: () => listFormTemplates().map((template, index) => {
    const { id, name, description, icon, category, industry, requires } = template;
    return { id, data: { name, description, icon, category, ...(industry ? { industry } : {}), requires, sort_order: index, definition: formTemplate(id)!.build() } };
  })
};
