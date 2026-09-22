import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { JsonObject } from "../platform/storage.js";

export const DOCUMENT_SCHEMA_VERSION = 1;
export const DOCUMENT_SNAPSHOT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Shared DocModel library (CommonJS-compatible UMD). The library is the single
// source of truth for the DocModel format, expressions, overrides, theme
// tokens, and geometry — the backend never reimplements any of it.
// ---------------------------------------------------------------------------

export type FMDocModelApi = {
  SCHEMA_VERSION: number;
  NODE_TYPES: string[];
  PAGE_ROLES: string[];
  PARAM_TYPES: string[];
  OUTPUT_TYPES: string[];
  HORIZONTAL_POSITION_UNITS: Array<"percent" | "px">;
  HORIZONTAL_POSITION_ANCHORS: Array<"left" | "center" | "right">;
  generateId: (prefix?: string) => string;
  deepClone: <T>(value: T) => T;
  deepMerge: (base: unknown, patch: unknown) => JsonObject;
  getPath: (target: unknown, path: string | Array<string | number>) => unknown;
  createDocument: (options?: JsonObject) => JsonObject;
  createBlankDocument: (options?: JsonObject) => JsonObject;
  createPage: (role?: string, overrides?: JsonObject) => JsonObject;
  createNode: (type: string, overrides?: JsonObject) => JsonObject;
  paperDimensions: (doc: JsonObject) => { w_pt: number; h_pt: number };
  normalizeHorizontalPosition: (value: unknown) => { unit: "percent" | "px"; anchor: "left" | "center" | "right"; value: number };
  horizontalPositionToLeft: (position: unknown, parentWidthPx: number, itemWidthPx: number) => number;
  horizontalPositionFromLeft: (leftPx: number, itemWidthPx: number, parentWidthPx: number, options?: unknown) => { unit: "percent" | "px"; anchor: "left" | "center" | "right"; value: number };
  normalizeViewHorizontalPositions: <T extends JsonObject>(doc: T, options?: { parent_width_pt?: number }) => T;
  applyOverrides: (definition: JsonObject, ops: unknown[]) => { document: JsonObject; applied: number; skipped: unknown[] };
  interpolate: (template: unknown, scope: JsonObject) => unknown;
  hasInterpolation: (value: unknown) => boolean;
  evaluateSafe: (expr: string, scope: JsonObject, fallback?: unknown) => unknown;
  buildScope: (data: JsonObject, extra?: JsonObject) => JsonObject;
  resolveBindings: (document: JsonObject, data: JsonObject) => JsonObject;
  resolveThemeTokens: (theme: JsonObject, context: JsonObject) => Record<string, string>;
  themeCssText: (vars: Record<string, string>, selector?: string) => string;
  pageMasterForRole: (theme: JsonObject, role: string) => JsonObject | null;
  paramDefaultValue: (def: JsonObject | null | undefined) => unknown;
  missingRequiredParams: (paramDefs: JsonObject, values: JsonObject) => string[];
  requiredOutputsSatisfied: (outputDefs: JsonObject, outputValues: JsonObject, gate?: string) => boolean;
  outputValueSatisfies: (def: JsonObject | null | undefined, value: unknown) => boolean;
  validateDocument: (doc: unknown) => { ok: boolean; errors: Array<{ path: string; message: string }> };
  widgetRefs: (doc: JsonObject) => Array<{ id: string; version: number; node_id: string }>;
  formatters: Record<string, (...args: unknown[]) => unknown>;
  // v2 (components / repeaters / named styles)
  mergedComponents: (doc: JsonObject, ...extraSets: Array<JsonObject | null | undefined>) => JsonObject;
  resolveStyleRef: (styleRef: string, doc: JsonObject | null, theme: JsonObject | null) => JsonObject;
  availableStyleRefs: (doc: JsonObject | null, theme: JsonObject | null) => string[];
  instantiateComponent: (def: JsonObject, input: JsonObject, scope: JsonObject, ctx: JsonObject, idBase: string) => JsonObject[];
};

const require = createRequire(import.meta.url);

function loadDocModel(): FMDocModelApi {
  const candidates = [
    // Source layout: public/v1/documents/*.ts -> public/libraries/doc-model
    fileURLToPath(new URL("../../libraries/doc-model/firstmate-doc-model.js", import.meta.url)),
    path.resolve(process.cwd(), "../libraries/doc-model/firstmate-doc-model.js"),
    path.resolve(process.cwd(), "public/libraries/doc-model/firstmate-doc-model.js"),
    path.resolve(process.cwd(), "libraries/doc-model/firstmate-doc-model.js")
  ];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return require(candidate) as FMDocModelApi;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to load the FMDocModel library (public/libraries/doc-model/firstmate-doc-model.js): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export const FMDocModel: FMDocModelApi = loadDocModel();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const jsonObjectSchema = z.object({}).passthrough();

const idSchema = z.string().trim().min(1).max(160);
const optionalIdSchema = z.string().trim().max(160).optional();

export const documentStatusSchema = z.enum([
  "draft", "issued", "sent", "viewed", "signed", "completed",
  "declined", "expired", "void", "needs_review"
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const snapshotReasonSchema = z.enum(["send", "sign", "pdf", "manual"]);

export const assetStatusSchema = z.enum(["draft", "active", "archived"]);

/** A DocModel definition, structurally validated through the shared library. */
export const docModelDefinitionSchema = jsonObjectSchema.superRefine((value, ctx) => {
  const result = FMDocModel.validateDocument(value);
  if (!result.ok) {
    for (const error of result.errors.slice(0, 20)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: error.path ? error.path.split(".") : [], message: error.message });
    }
  }
});

/** Theme documents are structured but intentionally loose — the library owns token semantics. */
export const themeDefinitionSchema = jsonObjectSchema.extend({
  name: z.string().trim().optional(),
  tokens: jsonObjectSchema.optional(),
  type_styles: jsonObjectSchema.optional(),
  page_masters: z.array(jsonObjectSchema).optional(),
  widget_skins: jsonObjectSchema.optional()
}).passthrough();

export const themeRefSchema = jsonObjectSchema.extend({
  theme_id: z.string().trim().min(1),
  version: z.number().int().positive().optional()
}).passthrough();

export const mediaRefSchema = jsonObjectSchema.extend({
  media_id: z.string().trim().optional(),
  variant: z.string().trim().optional(),
  markup_layer_id: z.string().trim().optional(),
  url: z.string().trim().optional()
}).passthrough();

export const recipientSchema = jsonObjectSchema.extend({
  id: z.string().trim().optional(),
  name: z.string().trim().optional(),
  email: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  role: z.string().trim().optional()
}).passthrough();

// --- templates ---------------------------------------------------------------

export const createTemplateSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  name: z.string().trim().min(1).max(200),
  document_type: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim()).optional(),
  status: assetStatusSchema.optional(),
  preview_media_ref: mediaRefSchema.optional(),
  definition: docModelDefinitionSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

/** Body for POST /templates/from-examples (vision template generation). */
export const templateFromExamplesSchema = jsonObjectSchema.extend({
  name: z.string().trim().max(200).optional(),
  document_type: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(4000).optional(),
  files: z.array(jsonObjectSchema.extend({
    file_name: z.string().trim().min(1).max(300),
    content_type: z.string().trim().max(120).optional(),
    data_base64: z.string().min(1)
  })).min(1).max(6)
}).passthrough();

export const patchTemplateSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim()).optional(),
  status: assetStatusSchema.optional(),
  preview_media_ref: mediaRefSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const publishTemplateSchema = jsonObjectSchema.extend({
  definition: docModelDefinitionSchema,
  expected_version: z.number().int().min(0).optional()
}).passthrough();

// --- folders (Doc Studio marketing/custom tabs) ------------------------------

export const folderItemTypeSchema = z.enum(["media", "file", "document", "visual_document"]);

export const createFolderSchema = jsonObjectSchema.extend({
  label: z.string().trim().min(1).max(100),
  icon: z.string().trim().max(80).optional(),
  position: z.number().int().min(0).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchFolderSchema = jsonObjectSchema.extend({
  label: z.string().trim().min(1).max(100).optional(),
  icon: z.string().trim().max(80).optional(),
  position: z.number().int().min(0).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const createFolderItemSchema = jsonObjectSchema.extend({
  item_type: folderItemTypeSchema,
  name: z.string().trim().min(1).max(300),
  media_ref: mediaRefSchema.optional(),
  definition: docModelDefinitionSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchFolderItemSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  folder_id: optionalIdSchema,
  name: z.string().trim().min(1).max(300).optional(),
  media_ref: mediaRefSchema.optional(),
  definition: docModelDefinitionSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

// --- themes -------------------------------------------------------------------

export const createThemeSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  status: assetStatusSchema.optional(),
  definition: themeDefinitionSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchThemeSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  status: assetStatusSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const publishThemeSchema = jsonObjectSchema.extend({
  definition: themeDefinitionSchema,
  expected_version: z.number().int().min(0).optional()
}).passthrough();

// --- instances ------------------------------------------------------------------

const overrideOpSchema = jsonObjectSchema.extend({
  op: z.enum(["doc.set", "node.set", "node.insert", "node.remove", "node.move", "page.insert", "page.remove", "page.move", "page.set"])
}).passthrough();

export const createDocumentInstanceSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  document_type: z.string().trim().min(1).max(80),
  // Explicit null opts out of the document type's default template.
  template_id: z.string().trim().max(160).nullable().optional(),
  template_version: z.number().int().positive().optional(),
  // Explicit workflow selection; null opts out of the type/template default.
  workflow_id: z.string().trim().max(160).nullable().optional(),
  title: z.string().trim().max(300).optional(),
  params: jsonObjectSchema.optional(),
  theme_ref: themeRefSchema.optional(),
  theme_overrides: jsonObjectSchema.optional(),
  contact_ids: z.array(z.string().trim()).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

/** Draft re-template (rail card "Add variant" convert flow): a draft may be
 *  repointed at a different published template and/or workflow. version
 *  defaults to the target's current published version. Draft-only —
 *  patchDocumentInstance rejects these on any other status. */
export const patchTemplateRefSchema = jsonObjectSchema.extend({
  template_id: z.string().trim().min(1).max(160),
  version: z.number().int().positive().optional()
}).passthrough();

export const patchWorkflowRefSchema = jsonObjectSchema.extend({
  workflow_id: z.string().trim().min(1).max(160),
  version: z.number().int().positive().optional()
}).passthrough();

export const patchDocumentInstanceSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  /** Attach a standalone document to a project (doc-first flows). Only valid
   *  while the document has no project yet. */
  project_id: z.string().trim().max(160).optional(),
  title: z.string().trim().max(300).optional(),
  params: jsonObjectSchema.optional(),
  overrides: z.array(overrideOpSchema).optional(),
  theme_ref: themeRefSchema.nullable().optional(),
  theme_overrides: jsonObjectSchema.optional(),
  template_ref: patchTemplateRefSchema.optional(),
  workflow_ref: patchWorkflowRefSchema.optional(),
  contact_ids: z.array(z.string().trim()).optional(),
  status: z.enum(["declined", "expired", "void"]).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

/** POST /documents/:id/void — cancel a sent document/workflow. The item stays
 *  in timelines as canceled; customer_visibility controls whether the customer
 *  still sees it (default from metadata.cancellation_defaults, else visible). */
export const voidDocumentInstanceSchema = jsonObjectSchema.extend({
  reason: z.string().trim().max(500).optional(),
  customer_visibility: z.enum(["visible", "hidden"]).optional()
}).passthrough();

export const issueDocumentSchema = jsonObjectSchema.extend({
  params: jsonObjectSchema.optional(),
  expected_revision: z.number().int().positive().optional()
}).passthrough();

export const createDocumentSnapshotSchema = jsonObjectSchema.extend({
  reason: snapshotReasonSchema.optional(),
  expected_revision: z.number().int().positive().optional(),
  generate_pdf: z.boolean().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const sendDocumentSchema = createDocumentSnapshotSchema.extend({
  recipients: z.array(recipientSchema).optional(),
  include_pdf: z.boolean().optional(),
  include_portal: z.boolean().optional(),
  message: z.string().optional()
}).passthrough();

export const generateDocumentPdfSchema = jsonObjectSchema.extend({
  snapshot_id: z.string().trim().optional(),
  store: z.boolean().optional(),
  title: z.string().trim().optional()
}).passthrough();

export const recordOutputSchema = jsonObjectSchema.extend({
  value: z.unknown(),
  evidence: jsonObjectSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const publicViewEventSchema = jsonObjectSchema.extend({
  session_id: z.string().trim().optional(),
  path: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const resolveDocumentSchema = jsonObjectSchema.extend({
  params: jsonObjectSchema.optional(),
  overrides: z.array(overrideOpSchema).optional(),
  theme_ref: themeRefSchema.optional(),
  theme_overrides: jsonObjectSchema.optional(),
  // Pricing-scope checkout variables (spec 10.4): { payment_method,
  // processing_fee_percent }. Drives conditional row evaluation.
  checkout: jsonObjectSchema.optional()
}).passthrough();

/** POST /public/:token/pricing — checkout-state pricing preview. */
export const publicPricingPreviewSchema = jsonObjectSchema.extend({
  checkout: jsonObjectSchema.optional()
}).passthrough();

export const ingestDocumentSchema = jsonObjectSchema.extend({
  file_name: z.string().trim().min(1).max(300),
  content_type: z.string().trim().max(200).optional(),
  data_base64: z.string().min(1),
  project_id: z.string().trim().optional(),
  document_type: z.string().trim().optional(),
  /** Paper-upload template: extraction targets exactly its declared fields. */
  template_id: z.string().trim().max(160).optional(),
  title: z.string().trim().max(300).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

/** Field-definition edits for UPLOADED documents (free-form paper uploads). */
export const uploadFieldsSchema = jsonObjectSchema.extend({
  title: z.string().trim().max(300).optional(),
  param_defs: jsonObjectSchema.optional(),
  output_defs: jsonObjectSchema.optional(),
  params: jsonObjectSchema.optional()
}).passthrough();

/** Reviewer sign-off for a paper upload; outputs entries may be null to reject a detected value. */
export const confirmUploadSchema = uploadFieldsSchema.extend({
  outputs: z.record(z.unknown()).optional()
}).passthrough();

/** POST /templates/upload-intake/draft — agent-drafted field schema from an example contract. */
export const draftUploadTemplateRequestSchema = jsonObjectSchema.extend({
  file_name: z.string().trim().min(1).max(300),
  content_type: z.string().trim().max(200).optional(),
  data_base64: z.string().min(1),
  name: z.string().trim().max(200).optional(),
  document_type: z.string().trim().max(80).optional()
}).passthrough();

export type ThemeRef = z.infer<typeof themeRefSchema>;
