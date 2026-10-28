import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { FMDocModel } from "../../documents/schemas.js";
import { DOCUMENT_THEME_KIND, entrySchema, jsonObject, plainText } from "./document-shared.js";

export { DOCUMENT_THEME_KIND };

/**
 * A document theme every organization starts with (docs/architecture/config-library.md): page masters, tokens and
 * type styles. An organization's copy takes its brand colors and fonts when it is made
 * (documents/theme-defaults.ts `themeDefinitionWithOrganizationDefaults`); the library entry holds only the
 * fallbacks.
 */
const color = z.union([z.string().trim().min(1).max(200), z.object({ from: z.string().trim().min(1).max(120), fallback: z.string().trim().max(200) }).strict()]);
const font = z.object({ family: z.string().max(300), size_pt: z.number().positive().max(400), weight: z.number().int().min(100).max(1000).optional(), color: z.string().max(200).optional() }).strict();
const inset = z.object({ top: z.number().min(0), left: z.number().min(0), right: z.number().min(0), bottom: z.number().min(0) }).strict();

const libraryThemeDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  tokens: z.object({
    colors: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), color),
    fonts: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().max(400)),
    spacing: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.number().min(0).max(1000))
  }).strict(),
  type_styles: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), font),
  page_masters: z.array(z.object({
    id: z.string().trim().min(1).max(120),
    match: z.object({ role: z.string().trim().min(1).max(40) }).strict(),
    /** Shapes drawn on every page the master matches: document-model nodes. */
    chrome: z.array(jsonObject).max(200),
    content_inset: inset
  }).strict()).min(1).max(20),
  /** Per-widget styling the document widgets read (`doc.line_items` header colors). */
  widget_skins: z.record(z.string().regex(/^[a-z][a-z0-9_.]*$/), z.record(z.string().max(300))).default({})
}).strict();

export const documentThemeEntrySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: plainText(2000).default(""),
  definition: libraryThemeDefinitionSchema
}).strict();
export type DocumentThemeEntry = z.infer<typeof documentThemeEntrySchema>;

export const documentThemeKind: LibraryKind<DocumentThemeEntry> = {
  kind: DOCUMENT_THEME_KIND,
  title: "Document themes",
  description: "Page styles every organization starts with. Each organization's copy takes its brand colors and fonts when it is made; an edited copy is the organization's own.",
  schema: entrySchema(documentThemeEntrySchema),
  validate(data) {
    const errors: string[] = [];
    const roles = new Set(FMDocModel.PAGE_ROLES);
    const ids = new Set<string>();
    data.definition.page_masters.forEach((master, index) => {
      if (ids.has(master.id)) errors.push(`definition.page_masters[${index}].id: ${master.id} is used twice.`);
      ids.add(master.id);
      if (master.match.role !== "*" && !roles.has(master.match.role)) errors.push(`definition.page_masters[${index}].match.role: no page role ${master.match.role}.`);
      master.chrome.forEach((node, at) => {
        if (!FMDocModel.NODE_TYPES.includes(String(node.type))) errors.push(`definition.page_masters[${index}].chrome[${at}]: no node type ${String(node.type)}.`);
      });
    });
    if (!data.definition.page_masters.some((master) => master.match.role === "*")) errors.push("definition.page_masters: one master must match every page (role *).");
    return errors;
  },
  titleOf: (data) => data.name,
  orgCopies: {
    status: async (orgId, ids) => (await import("../../documents/library-copies.js")).documentCopyStatus("theme", orgId, ids),
    reset: async (ctx, id) => (await import("../../documents/library-copies.js")).resetDocumentCopy("theme", ctx, id)
  }
};
