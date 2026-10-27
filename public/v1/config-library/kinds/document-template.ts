import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { LibraryKind, ValidationContext } from "../contracts.js";
import { FMDocModel } from "../../documents/schemas.js";
import { calculusDefinitionSchema } from "../../materials/calculus-contract.js";
import {
  DOCUMENT_TEMPLATE_KIND, DOCUMENT_THEME_KIND, DOCUMENT_WORKFLOW_KIND, asRecord, assetId, bindingErrors, entrySchema, jsonObject, missingEntry, plainText, pricebookDefaultSchema
} from "./document-shared.js";

export { DOCUMENT_TEMPLATE_KIND };

/**
 * A document template organizations start with (docs/architecture/config-library.md): an invoice, a change order,
 * the roofing proposals. An organization gets its own copy, made through the documents writer, and its documents
 * are made from that copy. `seeding` says when the copy is made: for every organization when its document library
 * is first read, or the first time something asks for the template by id (a scope that issues it, the Operations
 * scope of work). Price book rates (`pricebook_defaults`) are filled in when the copy is made.
 */
const documentDefinitionSchema = z.object({
  schema_version: z.number().int().positive(),
  kind: z.literal("document"),
  settings: jsonObject,
  /** null: the page style is chosen when the document is made (a paper upload). */
  theme_ref: z.object({ theme_id: assetId, version: z.number().int().positive().optional() }).strict().nullable(),
  params: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), jsonObject),
  computed: z.record(z.string(), z.string().max(4000)),
  outputs: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), jsonObject),
  styles: jsonObject,
  components: jsonObject,
  chains: jsonObject,
  assets: z.array(z.unknown()),
  edit_policy: jsonObject,
  metadata: z.object({ document_type: z.string().trim().min(1).max(80).optional() }).passthrough(),
  pages: z.array(jsonObject).min(1).max(200),
  /** Code that travels with an accepted document: materials recipes run in the module sandbox. */
  program: z.object({ enabled: z.boolean(), deliverables: z.array(jsonObject).max(20) }).strict().optional()
}).strict();

const metadataSchema = z.object({
  /** The workflow a new document from this template opens with (a `document_workflow` entry). */
  default_workflow_id: assetId.optional(),
  disable_default_workflow: z.boolean().optional(),
  /** How the customer portal offers the document: its tab, document/workflow/hybrid, and the call to action. */
  customer_presentation: z.object({
    tab: z.object({ id: assetId, label: z.string().trim().min(1).max(80), icon: z.string().trim().max(80), order: z.number().int() }).strict(),
    mode: z.enum(["document", "workflow", "hybrid"]),
    workflow_cta: z.string().trim().max(120).optional(),
    document_cta: z.string().trim().max(120).optional(),
    auto_open: z.boolean().optional()
  }).strict().optional(),
  /** Made by an app (payroll, materials), never started by hand: kept out of the New document picker. */
  system: z.boolean().optional(),
  /** What "new document" of this type means when no template is named. */
  default: z.boolean().optional(),
  /** A paper document uploaded and read by the extraction agent. */
  intake: z.enum(["upload"]).optional()
}).strict();

export const documentTemplateEntrySchema = z.object({
  name: z.string().trim().min(1).max(200),
  document_type: z.string().trim().regex(/^[a-z][a-z0-9_]{0,79}$/),
  description: plainText(2000).default(""),
  /** archived: usable by id, never in the template picker. */
  status: z.enum(["active", "archived"]).default("active"),
  seeding: z.enum(["every_organization", "on_request"]),
  definition: documentDefinitionSchema,
  /** Written onto the copy every time it is made or upgraded. */
  metadata: metadataSchema.default({}),
  /** Written onto the copy only when it is first made; the organization may change these afterwards. */
  initial_metadata: metadataSchema.default({}),
  /** Made only for an organization whose price book prices every one of these items. */
  requires_pricebook_items: z.array(pricebookDefaultSchema.shape.item_id).max(40).default([]),
  pricebook_defaults: z.array(pricebookDefaultSchema).max(40).default([])
}).strict();
export type DocumentTemplateEntry = z.infer<typeof documentTemplateEntrySchema>;

/** The browser widget registry (also loadable in Node): which `doc.*` widgets and versions exist. */
let widgets: { get(id: string, version?: number): unknown } | null | undefined;
function documentWidgets() {
  if (widgets !== undefined) return widgets;
  const require = createRequire(import.meta.url);
  const candidates = [
    fileURLToPath(new URL("../../../libraries/doc-widgets/firstmate-doc-widgets.js", import.meta.url)),
    path.resolve(process.cwd(), "../libraries/doc-widgets/firstmate-doc-widgets.js"),
    path.resolve(process.cwd(), "public/libraries/doc-widgets/firstmate-doc-widgets.js")
  ];
  widgets = null;
  for (const candidate of candidates) {
    try { widgets = require(candidate); break; } catch { /* next */ }
  }
  return widgets;
}

/** Checks shared by templates: the document model, its widgets, its theme and its program's recipes. */
export function documentDefinitionErrors(definition: Record<string, unknown>, ctx: ValidationContext, at = "definition") {
  const errors: string[] = [];
  const checked = FMDocModel.validateDocument(definition);
  if (!checked.ok) errors.push(...checked.errors.slice(0, 20).map((error) => `${at}.${error.path}: ${error.message}`));
  const registry = documentWidgets();
  if (registry) {
    for (const ref of FMDocModel.widgetRefs(definition)) {
      if (!registry.get(ref.id, ref.version)) errors.push(`${at}: node ${ref.node_id} uses widget ${ref.id}@${ref.version}, which does not exist.`);
    }
  }
  const themeId = String(asRecord(definition.theme_ref).theme_id || "");
  if (themeId && missingEntry(ctx, DOCUMENT_THEME_KIND, themeId)) errors.push(`${at}.theme_ref: no document theme ${themeId} in the library.`);
  const program = asRecord(definition.program);
  (Array.isArray(program.deliverables) ? program.deliverables : []).forEach((deliverable, index) => {
    const where = `${at}.program.deliverables[${index}]`;
    if (asRecord(deliverable).type !== "materials_calculus") { errors.push(`${where}: only materials_calculus deliverables are defaults.`); return; }
    const parsed = calculusDefinitionSchema.safeParse(deliverable);
    if (!parsed.success) errors.push(...parsed.error.issues.slice(0, 5).map((issue) => `${where}.${issue.path.join(".")}: ${issue.message}`));
    errors.push(...bindingErrors(asRecord(deliverable).bindings, ctx, `${where}.bindings`));
  });
  return errors;
}

export const documentTemplateKind: LibraryKind<DocumentTemplateEntry> = {
  kind: DOCUMENT_TEMPLATE_KIND,
  title: "Document templates",
  description: "Templates organizations start with (invoices, change orders, proposals). Each organization keeps its own copy; an untouched copy follows the library, an edited one is the organization's own until it is reset.",
  schema: entrySchema(documentTemplateEntrySchema),
  validate(data, ctx) {
    const definition = data.definition as unknown as Record<string, unknown>;
    const errors = documentDefinitionErrors(definition, ctx);
    if (data.definition.metadata.document_type && data.definition.metadata.document_type !== data.document_type) errors.push(`definition.metadata.document_type is ${data.definition.metadata.document_type}, not ${data.document_type}.`);
    for (const metadata of [data.metadata, data.initial_metadata]) {
      const workflow = metadata.default_workflow_id;
      if (workflow && missingEntry(ctx, DOCUMENT_WORKFLOW_KIND, workflow)) errors.push(`metadata.default_workflow_id: no document workflow ${workflow} in the library.`);
    }
    for (const fill of data.pricebook_defaults) {
      if (!data.definition.params[fill.param]) errors.push(`pricebook_defaults: the template has no parameter ${fill.param}.`);
    }
    return errors;
  },
  titleOf: (data) => data.name
};
