import { z } from "zod";

import { FMDocModel, jsonObjectSchema } from "../documents/schemas.js";

export const WEBSITE_SCHEMA_VERSION = 1;

// Re-export the shared DocModel library handle so websites code has one import
// site (the documents module owns the CJS loading logic).
export { FMDocModel };

/** A DocModel definition validated through the shared library; website pages
 *  must be `kind: "view"` documents. */
export const viewDefinitionSchema = jsonObjectSchema.superRefine((value, ctx) => {
  if ((value as Record<string, unknown>).kind !== "view") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: 'Website pages must be DocModels of kind "view".' });
    return;
  }
  const result = FMDocModel.validateDocument(value);
  if (!result.ok) {
    for (const error of result.errors.slice(0, 20)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: error.path ? error.path.split(".") : [], message: error.message });
    }
  }
});

const navSchema = jsonObjectSchema.extend({
  header: z.boolean().optional(),
  footer: z.boolean().optional(),
  order: z.number().int().min(0).optional()
}).passthrough();

const seoSchema = jsonObjectSchema.extend({
  title: z.string().trim().max(300).optional(),
  description: z.string().trim().max(1000).optional()
}).passthrough();

/**
 * Portal-page audience targeting. An absent or fully-empty block is a wildcard
 * (every project sees the page) — that is the pre-targeting behavior and every
 * existing page keeps it.
 *
 * Contract: docs/customer-portal-v2-spec.md §3.1. These rules are evaluated
 * server-side only and are never included in a portal payload.
 */
const audienceSchema = jsonObjectSchema.extend({
  match: z.enum(["any", "all"]).optional(),
  scope_template_ids: z.array(z.string().trim().max(160)).max(50).optional(),
  tag_ids: z.array(z.string().trim().max(120)).max(50).optional(),
  project_status: z.array(z.string().trim().max(60)).max(20).optional(),
  custom_field: jsonObjectSchema.extend({
    key: z.string().trim().max(120).optional(),
    in: z.array(z.string().trim().max(200)).max(50).optional()
  }).passthrough().optional()
}).passthrough();

const siteSettingsSchema = jsonObjectSchema.extend({
  design_width_pt: z.number().min(240).max(2400).optional(),
  theme_vars: jsonObjectSchema.optional(),
  chat: jsonObjectSchema.extend({
    enabled: z.boolean().optional(),
    widget_key: z.string().trim().max(200).optional()
  }).passthrough().optional(),
  seo: seoSchema.optional()
}).passthrough();

// --- sites -------------------------------------------------------------------

export const createSiteSchema = jsonObjectSchema.extend({
  name: z.string().trim().min(1).max(200)
}).passthrough();

export const patchSiteSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  home_page_id: z.string().trim().min(1).max(160).optional(),
  header_page_id: z.string().trim().min(1).max(160).nullable().optional(),
  footer_page_id: z.string().trim().min(1).max(160).nullable().optional(),
  settings: siteSettingsSchema.optional(),
  status: z.enum(["active", "archived"]).optional()
}).passthrough();

// --- pages -------------------------------------------------------------------

export const createPageSchema = jsonObjectSchema.extend({
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(120).optional()
}).passthrough();

export const patchPageSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().max(120).optional(),
  enabled: z.boolean().optional(),
  nav: navSchema.optional(),
  seo: seoSchema.optional(),
  notes: z.string().max(20000).optional(),
  audience: audienceSchema.nullable().optional()
}).passthrough();

export const saveDraftSchema = jsonObjectSchema.extend({
  definition: viewDefinitionSchema,
  expected_revision: z.number().int().positive().optional()
}).passthrough();

export const publishPageSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional()
}).passthrough();

export const discardDraftSchema = publishPageSchema;

export const restorePageSchema = jsonObjectSchema.extend({
  version: z.number().int().positive(),
  expected_revision: z.number().int().positive().optional()
}).passthrough();

export const resolvePageSchema = jsonObjectSchema.extend({
  source: z.enum(["draft", "published"]).optional()
}).passthrough();
