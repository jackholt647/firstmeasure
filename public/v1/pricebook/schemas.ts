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

export const priceUpdateRuleSchema = z.object({
  id: optionalString,
  label: optionalString,
  mode: z.enum(["fixed", "live", "conditional"]).default("fixed"),
  source: z.enum(["organization_pricebook", "global_pricebook", "manual"]).optional(),
  lock_on: z.array(z.enum(["signature", "payment", "send", "acceptance"])).optional(),
  expires_after: z.object({
    amount: z.number().nonnegative(),
    unit: z.enum(["hours", "days", "months", "years"])
  }).optional(),
  formula: nullableString,
  metadata: z.record(z.unknown()).optional()
}).passthrough();

const variantAdjustmentSchema = z.object({
  operation: z.enum(["add", "multiply", "divide", "formula", "none"]).optional(),
  value: z.number().optional(),
  formula: nullableString,
  target: z.enum(["sell_price", "internal_cost", "both"]).optional()
}).passthrough();

const variantDimensionValueSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  hex: nullableString,
  image: nullableString,
  adjustment: variantAdjustmentSchema.optional(),
  pricing_update_rule: priceUpdateRuleSchema.optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

const variantDimensionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["color", "option", "pricing_policy"]).optional(),
  affects_sku: z.boolean().optional(),
  values: z.array(variantDimensionValueSchema),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

const itemImageSchema = z.object({
  asset_id: z.string().min(1),
  role: optionalString,
  alt: optionalString
}).passthrough();

const mediaRefSchema = z.object({
  asset_id: optionalString,
  media_id: optionalString,
  role: optionalString,
  caption: optionalString,
  alt: optionalString
}).passthrough();

const selectionSchema = z.object({
  mode: z.enum(["fixed", "optional", "choice"]).optional(),
  selected: z.boolean().optional(),
  selected_by: z.enum(["internal", "customer", "system"]).optional(),
  selectable_by: z.array(z.enum(["internal", "customer", "system"])).optional(),
  group_id: optionalString,
  group_behavior: z.enum(["single", "multiple"]).optional(),
  required: z.boolean().optional(),
  default_selected: z.boolean().optional(),
  locked_after: optionalString
}).passthrough();

const variationSelectionSchema = z.object({
  selected_variation_id: optionalString,
  selected_by: z.enum(["internal", "customer", "system"]).optional(),
  selectable_by: z.array(z.enum(["internal", "customer", "system"])).optional(),
  required: z.boolean().optional(),
  default_variation_id: optionalString
}).passthrough();

const variationSchema = z.object({
  id: z.string().min(1),
  label: optionalString,
  name: optionalString,
  overrides: z.record(z.unknown()).optional()
}).passthrough();

const componentSchema = z.object({
  id: optionalString,
  item_ref: z.string().min(1).optional(),
  itemRef: z.string().min(1).optional(),
  item_id: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  included: z.boolean().optional(),
  price_driving: z.boolean().optional(),
  selection: selectionSchema.optional(),
  variation_selection: variationSelectionSchema.optional(),
  variables: z.record(z.unknown()).optional(),
  measurements: z.record(z.unknown()).optional(),
  overrides: z.record(z.unknown()).optional()
}).passthrough();

const variationSetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  variable_key: optionalString,
  values: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    media_refs: z.array(mediaRefSchema).optional(),
    overrides: z.record(z.unknown()).optional()
  }).passthrough())
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

export const orderPackagingSchema = z.object({
  order_unit: z.string().min(1),
  order_unit_plural: optionalString,
  units_per_package: z.number().nonnegative().optional(),
  packages_per_unit: z.number().nonnegative().optional(),
  description: optionalString
}).passthrough();

export const pricebookItemSchema = z.object({
  id: z.string().min(1),
  code: optionalString,
  name: z.string().min(1),
  kind: z.enum(["atomic", "assembly"]).optional(),
  category: z.string().optional(),
  manufacturer: z.string().optional(),
  type: optionalString,
  segment: z.enum(PRICEBOOK_SEGMENTS).optional(),
  unit: z.string().optional(),
  unitPrice: z.number().optional(),
  unit_price: z.number().optional(),
  base_price: z.number().optional(),
  internal_cost: z.number().optional(),
  amount: z.number().optional(),
  formulaConfig: formulaConfigSchema.optional(),
  formula_config: formulaConfigSchema.optional(),
  autoAdd: z.boolean().optional(),
  auto_add: z.boolean().optional(),
  order_packaging: orderPackagingSchema.nullable().optional(),
  orderPackaging: orderPackagingSchema.nullable().optional(),
  description: nullableString,
  internal_description: nullableString,
  external_description: nullableString,
  images: z.array(itemImageSchema).optional(),
  media_refs: z.array(mediaRefSchema).optional(),
  options: z.array(itemOptionSchema).optional(),
  variables: z.record(z.unknown()).optional(),
  measurements: z.record(z.unknown()).optional(),
  variation_set_refs: z.array(z.string()).optional(),
  variation_overrides: z.record(z.unknown()).optional(),
  variations: z.array(variationSchema).optional(),
  variant_dimensions: z.array(variantDimensionSchema).optional(),
  variant_overrides: z.record(z.record(z.unknown())).optional(),
  default_variant_selection: z.record(z.string()).optional(),
  default_pricing_update_rule: priceUpdateRuleSchema.optional(),
  global_item_ref: z.record(z.unknown()).optional(),
  global_link_mode: z.enum(["live", "snapshot", "local"]).optional(),
  selection: selectionSchema.optional(),
  selection_groups: z.array(z.record(z.unknown())).optional(),
  components: z.array(componentSchema).optional(),
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
  variation_sets: z.array(variationSetSchema).optional(),
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
