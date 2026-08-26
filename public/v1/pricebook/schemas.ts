import { z } from "zod";

import {
  DEFAULT_TEMPLATE_KEY,
  PRICEBOOK_CATEGORIES,
  PRICEBOOK_FORMULA_TOKEN_TYPES,
  PRICEBOOK_MANUFACTURERS,
  PRICEBOOK_OPERATORS,
  PRICEBOOK_PARENS,
  PRICEBOOK_SEGMENTS,
  PRICEBOOK_UNITS
} from "./constants.js";

const optionalString = z.string().optional();
const nullableString = z.string().nullable().optional();

const referenceSchema = z.object({
  id: optionalString
}).partial();

const personSchema = z.object({
  id: optionalString,
  email: optionalString,
  name: optionalString
}).partial();

export const actorSchema = z.object({
  id: optionalString,
  email: optionalString,
  name: optionalString,
  roles: z.array(z.string()).optional(),
  team_id: optionalString,
  organization_id: optionalString
}).partial();

export const formulaTokenSchema = z.object({
  type: z.enum(PRICEBOOK_FORMULA_TOKEN_TYPES),
  value: z.string()
}).superRefine((value, ctx) => {
  if (value.type === "operator" && !PRICEBOOK_OPERATORS.includes(value.value as (typeof PRICEBOOK_OPERATORS)[number])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid operator token value." });
  }
  if (value.type === "paren" && !PRICEBOOK_PARENS.includes(value.value as (typeof PRICEBOOK_PARENS)[number])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid paren token value." });
  }
});

export const formulaConfigSchema = z.object({
  tokens: z.array(formulaTokenSchema).min(1),
  includeWaste: z.boolean().optional()
});

const priceAdjustmentSchema = z.object({
  type: z.enum(["flat_delta", "unit_delta", "percent_delta"]),
  amount: z.number(),
  formula_config: formulaConfigSchema.optional()
}).partial({ formula_config: true });

const itemImageSchema = z.object({
  asset_id: z.string().min(1),
  role: optionalString,
  alt: optionalString
}).passthrough();

const optionValueSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: nullableString,
  is_default: z.boolean().optional(),
  price_adjustment: priceAdjustmentSchema.optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

const itemOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  input_type: z.enum(["single_select", "multi_select", "text", "number", "boolean", "color_swatch"]),
  required: z.boolean().optional(),
  values: z.array(optionValueSchema).optional(),
  default_value: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const taxonomyValueSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1)
}).passthrough();

export const measurementFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1)
}).passthrough();

export const assetSchema = z.object({
  id: z.string().min(1),
  file_name: z.string().min(1),
  stored_name: z.string().min(1),
  content_type: optionalString,
  size: z.number().int().nonnegative(),
  kind: z.enum(["image", "file"]).optional(),
  label: nullableString,
  alt_text: nullableString,
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const pricebookItemSchema = z.object({
  id: z.string().min(1),
  code: optionalString,
  name: z.string().min(1),
  category: z.enum(PRICEBOOK_CATEGORIES),
  manufacturer: z.enum(PRICEBOOK_MANUFACTURERS).optional(),
  segment: z.enum(PRICEBOOK_SEGMENTS).optional(),
  unit: z.enum(PRICEBOOK_UNITS),
  unitPrice: z.number(),
  formulaConfig: formulaConfigSchema,
  autoAdd: z.boolean().optional(),
  description: nullableString,
  images: z.array(itemImageSchema).optional(),
  options: z.array(itemOptionSchema).optional(),
  sort_order: z.number().int().optional(),
  status: z.enum(["active", "archived"]).optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const patchPricebookItemSchema = pricebookItemSchema.partial().extend({
  expected_revision: z.number().int().positive().optional()
});

export const taxonomySchema = z.object({
  categories: z.array(taxonomyValueSchema).optional(),
  units: z.array(taxonomyValueSchema).optional(),
  measurement_fields: z.array(measurementFieldSchema).optional(),
  manufacturers: z.array(taxonomyValueSchema).optional(),
  segments: z.array(taxonomyValueSchema).optional()
}).partial();

export const catalogSchema = z.object({
  taxonomy: taxonomySchema.optional(),
  items: z.array(pricebookItemSchema),
  assets: z.array(assetSchema).optional(),
  settings: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const createPricebookSchema = z.object({
  id: optionalString,
  name: optionalString,
  description: nullableString,
  currency: optionalString,
  locale: optionalString,
  template_key: z.string().min(1).optional().default(DEFAULT_TEMPLATE_KEY),
  organization_ref: referenceSchema.optional(),
  owner_ref: personSchema.optional(),
  actor: actorSchema.optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const patchPricebookSchema = z.object({
  name: optionalString,
  description: nullableString,
  status: z.enum(["active", "archived"]).optional(),
  currency: optionalString,
  locale: optionalString,
  organization_ref: referenceSchema.optional(),
  owner_ref: personSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  expected_revision: z.number().int().positive().optional(),
  actor: actorSchema.optional()
}).passthrough();

export const clonePricebookSchema = z.object({
  id: optionalString,
  name: optionalString,
  description: nullableString,
  currency: optionalString,
  locale: optionalString,
  organization_ref: referenceSchema.optional(),
  owner_ref: personSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  actor: actorSchema.optional()
}).passthrough();

export const pricebookQuerySchema = z.object({
  search: optionalString,
  statuses: z.array(z.string()).optional(),
  organization_id: optionalString,
  owner_email: optionalString,
  template_key: optionalString,
  limit: z.number().int().min(1).max(500).optional()
}).partial();

export const saveCatalogSchema = z.object({
  catalog: catalogSchema,
  expected_revision: z.number().int().positive().optional(),
  actor: actorSchema.optional()
}).passthrough();

export const createItemSchema = pricebookItemSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  actor: actorSchema.optional()
}).passthrough();

export const assetUploadJsonSchema = z.object({
  file_name: z.string().min(1),
  content_base64: z.string().optional(),
  content_text: z.string().optional(),
  content_type: optionalString,
  label: nullableString,
  alt_text: nullableString,
  kind: z.enum(["image", "file"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  expected_revision: z.number().int().positive().optional(),
  actor: actorSchema.optional()
}).refine((value) => value.content_base64 || value.content_text !== undefined, {
  message: "content_base64 or content_text is required"
});

export const deleteByRevisionSchema = z.object({
  expected_revision: z.number().int().positive().optional(),
  actor: actorSchema.optional()
}).passthrough();
