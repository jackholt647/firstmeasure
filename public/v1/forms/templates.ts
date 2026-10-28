import { libraryEntries, libraryEntry } from "../config-library/library.js";
import { formDefinitionSchema, type FormDefinition } from "./contracts.js";

/**
 * Starting points for new forms. Templates are config library entries of the kind `form_template`
 * (config-library/kinds/form_template.ts, docs/architecture/config-library.md), edited as data on dev. A template is
 * only seed content: once created, a form is edited block by block and has no tie to its template. Industry packs
 * add entries; nothing else in the forms module is industry-aware.
 */
export const FORM_TEMPLATE_KIND = "form_template";

export type FormTemplate = {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: "General" | "Staff" | "Scheduling" | "Estimates";
  industry?: string;
  /** lead_forms capability flags the template's blocks need. */
  requires: string[];
};
type FormTemplateData = Omit<FormTemplate, "id"> & { sort_order: number; definition: unknown };

function card(id: string, data: FormTemplateData): FormTemplate {
  return { id, name: data.name, description: data.description, icon: data.icon, category: data.category, ...(data.industry ? { industry: data.industry } : {}), requires: [...data.requires] };
}

/** Every template, in picker order. */
export function listFormTemplates(): FormTemplate[] {
  return libraryEntries<FormTemplateData>(FORM_TEMPLATE_KIND)
    .sort((a, b) => a.data.sort_order - b.data.sort_order || (a.id < b.id ? -1 : 1))
    .map((entry) => card(entry.id, entry.data));
}

export function formTemplate(templateId: string): FormTemplate | null {
  const entry = templateId ? libraryEntry<FormTemplateData>(FORM_TEMPLATE_KIND, templateId) : null;
  return entry ? card(entry.id, entry.data) : null;
}

/** A new form's definition: a fresh copy of the template's (blank when the template is unknown). */
export function buildTemplateDefinition(templateId: string): FormDefinition {
  const entry = libraryEntry<FormTemplateData>(FORM_TEMPLATE_KIND, templateId) || libraryEntry<FormTemplateData>(FORM_TEMPLATE_KIND, "blank");
  if (!entry) throw new Error("The form template library has no blank template.");
  return formDefinitionSchema.parse(structuredClone(entry.data.definition));
}
