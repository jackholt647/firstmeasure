import { z } from "zod";

export const MATERIALS_SCHEMA_VERSION = 1;
export const MATERIAL_LIST_VERSION_SCHEMA_VERSION = 1;
export const MATERIAL_ORDER_SCHEMA_VERSION = 1;
export const MATERIAL_DELIVERY_SCHEMA_VERSION = 1;

export const jsonObjectSchema = z.object({}).passthrough();

const idSchema = z.string().trim().min(1).max(160);
const optionalIdSchema = z.string().trim().max(160).optional();

export const materialListStatusSchema = z.enum([
  "planning",
  "ordered",
  "partially_delivered",
  "delivered",
  "cancelled",
  "archived"
]);

export const materialDeliveryStatusSchema = z.enum([
  "unscheduled",
  "scheduled",
  "delivering",
  "partially_delivered",
  "delivered",
  "delayed",
  "cancelled"
]);

export const materialVersionReasonSchema = z.enum([
  "manual",
  "measurement_import",
  "proposal_import",
  "supplement",
  "removal",
  "revision",
  "order_lock",
  "delivery_update"
]);

export const materialPricebookRefSchema = jsonObjectSchema.extend({
  pricebook_id: z.string().trim().optional(),
  item_id: z.string().trim().optional(),
  item_type_id: z.string().trim().optional(),
  variant_id: z.string().trim().optional(),
  variant_group_id: z.string().trim().optional(),
  catalog_revision: z.number().int().positive().optional(),
  item_revision: z.number().int().positive().optional(),
  selected_options: jsonObjectSchema.optional(),
  source: z.string().trim().optional()
}).passthrough();

export const materialMoneySchema = jsonObjectSchema.extend({
  amount: z.number().optional(),
  currency: z.string().trim().optional(),
  source: z.string().trim().optional(),
  locked: z.boolean().optional(),
  locked_at: z.string().trim().optional()
}).passthrough();

export const materialScheduleWindowSchema = jsonObjectSchema.extend({
  date: z.string().trim().optional(),
  start_date: z.string().trim().optional(),
  end_date: z.string().trim().optional(),
  time: z.string().trim().optional(),
  start_time: z.string().trim().optional(),
  end_time: z.string().trim().optional(),
  timezone: z.string().trim().optional(),
  precision: z.enum(["datetime", "time_range", "day", "day_range", "unknown"]).optional(),
  notes: z.string().trim().optional()
}).passthrough();

export const materialLineItemSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  parent_item_id: z.string().trim().optional(),
  source_item_id: z.string().trim().optional(),
  amendment_action: z.enum(["add", "update", "remove"]).optional(),
  section: z.string().trim().optional(),
  structure_id: z.string().trim().optional(),
  structure_name: z.string().trim().optional(),
  pricebook_ref: materialPricebookRefSchema.optional(),
  pricebook_snapshot: jsonObjectSchema.optional(),
  item_type_id: z.string().trim().optional(),
  variant_id: z.string().trim().optional(),
  variant_group_id: z.string().trim().optional(),
  selected_options: jsonObjectSchema.optional(),
  product_selection: jsonObjectSchema.optional(),
  name: z.string().trim().optional(),
  code: z.string().trim().optional(),
  category: z.string().trim().optional(),
  manufacturer: z.string().trim().optional(),
  segment: z.string().trim().optional(),
  description: z.string().trim().optional(),
  quantity: z.number().optional(),
  unit: z.string().trim().optional(),
  order_quantity: z.number().optional(),
  order_unit: z.string().trim().optional(),
  projected_unit_price: z.number().optional(),
  projected_total: z.number().optional(),
  quoted_unit_price: z.number().optional(),
  quoted_total: z.number().optional(),
  paid_unit_price: z.number().optional(),
  paid_total: z.number().optional(),
  unit_price: z.number().optional(),
  total_price: z.number().optional(),
  currency: z.string().trim().optional(),
  pricing: jsonObjectSchema.optional(),
  locked_pricing: jsonObjectSchema.optional(),
  vendor: jsonObjectSchema.optional(),
  measurements: jsonObjectSchema.optional(),
  notes: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const materialSectionSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  key: z.string().trim().optional(),
  title: z.string().trim().optional(),
  structure_id: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const materialListResourcesSchema = jsonObjectSchema.extend({
  proposal_ids: z.array(z.string().trim()).optional(),
  proposal_snapshot_ids: z.array(z.string().trim()).optional(),
  measurement_project_ids: z.array(z.string().trim()).optional(),
  firstmeasure_project_ids: z.array(z.string().trim()).optional(),
  media_refs: z.array(jsonObjectSchema).optional()
}).passthrough();

export const createMaterialListSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  branch_id: z.string().trim().optional(),
  title: z.string().trim().optional(),
  status: materialListStatusSchema.optional(),
  delivery_status: materialDeliveryStatusSchema.optional(),
  sections: z.array(materialSectionSchema).optional(),
  items: z.array(materialLineItemSchema).optional(),
  resources: materialListResourcesSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchMaterialListSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  title: z.string().trim().optional(),
  status: materialListStatusSchema.optional(),
  delivery_status: materialDeliveryStatusSchema.optional(),
  sections: z.array(materialSectionSchema).optional(),
  resources: materialListResourcesSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const createMaterialVersionSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  reason: materialVersionReasonSchema.optional(),
  title: z.string().trim().optional(),
  parent_version_id: z.string().trim().optional(),
  amendment_of_version_id: z.string().trim().optional(),
  bundled_with_order_id: z.string().trim().optional(),
  bundled_with_delivery_id: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  sections: z.array(materialSectionSchema).optional(),
  items: z.array(materialLineItemSchema).optional(),
  add_items: z.array(materialLineItemSchema).optional(),
  update_items: z.array(materialLineItemSchema).optional(),
  remove_item_ids: z.array(idSchema).optional(),
  resources: materialListResourcesSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const createMaterialOrderSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  id: optionalIdSchema,
  title: z.string().trim().optional(),
  vendor: jsonObjectSchema.optional(),
  ordered_at: z.string().trim().optional(),
  scheduled_window: materialScheduleWindowSchema.optional(),
  delivery_status: materialDeliveryStatusSchema.optional(),
  projected_price: materialMoneySchema.optional(),
  quoted_price: materialMoneySchema.optional(),
  paid_price: materialMoneySchema.optional(),
  item_ids: z.array(idSchema).optional(),
  notes: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchMaterialOrderSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  title: z.string().trim().optional(),
  vendor: jsonObjectSchema.optional(),
  scheduled_window: materialScheduleWindowSchema.optional(),
  delivery_status: materialDeliveryStatusSchema.optional(),
  projected_price: materialMoneySchema.optional(),
  quoted_price: materialMoneySchema.optional(),
  paid_price: materialMoneySchema.optional(),
  notes: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const recordMaterialDeliverySchema = jsonObjectSchema.extend({
  expected_order_revision: z.number().int().positive().optional(),
  id: optionalIdSchema,
  status: materialDeliveryStatusSchema.optional(),
  estimated_window: materialScheduleWindowSchema.optional(),
  actual_delivered_at: z.string().trim().optional(),
  actual_started_at: z.string().trim().optional(),
  actual_completed_at: z.string().trim().optional(),
  item_ids: z.array(idSchema).optional(),
  quantities: z.array(jsonObjectSchema.extend({
    item_id: idSchema,
    quantity: z.number().optional(),
    unit: z.string().trim().optional(),
    notes: z.string().trim().optional()
  }).passthrough()).optional(),
  received_by: jsonObjectSchema.optional(),
  notes: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchMaterialDeliverySchema = recordMaterialDeliverySchema.extend({
  expected_revision: z.number().int().positive().optional()
}).passthrough();

export const archiveMaterialListSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  reason: z.string().trim().optional()
}).passthrough();

export type MaterialListStatus = z.infer<typeof materialListStatusSchema>;
export type MaterialDeliveryStatus = z.infer<typeof materialDeliveryStatusSchema>;
