import { z } from "zod";

const jsonObject = z.record(z.string(), z.unknown());

export const saveCategorySchema = z.object({
  id: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(160),
  icon: z.string().trim().max(80).optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
  status: z.enum(["active", "archived"]).optional(),
  expected_revision: z.number().int().min(0).optional()
});

export const operatorRequirementSchema = z.object({
  tag_id: z.string().trim().max(160).optional(),
  label: z.string().trim().max(200)
});

export const attributeFieldSchema = z.object({
  key: z.string().trim().min(1).max(120),
  label: z.string().trim().max(200),
  kind: z.enum(["text", "number", "date", "select", "boolean"]).optional(),
  options: z.array(z.string().trim().max(200)).max(60).optional()
});

export const ratesSchema = z.object({
  hourly_cents: z.number().int().min(0).optional(),
  daily_cents: z.number().int().min(0).optional(),
  weekly_cents: z.number().int().min(0).optional()
}).partial();

export const saveTypeSchema = z.object({
  id: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["vehicle", "trailer", "tool", "other"]).optional(),
  category_id: z.string().trim().max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  icon: z.string().trim().max(80).optional(),
  color: z.string().trim().max(40).optional(),
  tracking: z.enum(["unit", "quantity"]).optional(),
  mobility: z.enum(["mobile", "fixed", "portable"]).optional(),
  pool_quantity: z.number().int().min(0).max(1000000).optional(),
  allow_double_booking: z.boolean().optional(),
  default_meter_kind: z.enum(["none", "hours", "miles", "both"]).optional(),
  operator_requirements: z.array(operatorRequirementSchema).max(40).optional(),
  attributes_schema: z.array(attributeFieldSchema).max(80).optional(),
  default_rates: ratesSchema.optional(),
  scope_item_keys: z.array(z.string().trim().max(200)).max(80).optional(),
  status: z.enum(["active", "archived"]).optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
  expected_revision: z.number().int().min(0).optional()
});

export const saveYardSchema = z.object({
  id: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(200),
  address: jsonObject.optional(),
  status: z.enum(["active", "archived"]).optional(),
  expected_revision: z.number().int().min(0).optional()
});

export const UNIT_STATUSES = ["available", "down", "reserved", "retired"] as const;
export const UNIT_OWNERSHIPS = ["owned", "leased", "rented", "customer"] as const;

export const saveUnitSchema = z.object({
  id: z.string().trim().max(120).optional(),
  type_id: z.string().trim().max(120).optional(),
  branch_id: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(240),
  identifier: z.string().trim().max(160).optional(),
  serial_number: z.string().trim().max(200).optional(),
  license_plate: z.string().trim().max(60).optional(),
  year: z.string().trim().max(12).optional(),
  make: z.string().trim().max(120).optional(),
  model: z.string().trim().max(120).optional(),
  vin: z.string().trim().max(60).optional(),
  color: z.string().trim().max(40).optional(),
  ownership: z.enum(UNIT_OWNERSHIPS).optional(),
  contact_id: z.string().trim().max(160).optional(),
  service_location: jsonObject.optional(),
  acquisition: jsonObject.optional(),
  status: z.enum(UNIT_STATUSES).optional(),
  condition_status_id: z.string().trim().max(120).optional(),
  location_source: z.enum(["manual", "assignment", "telematics"]).optional(),
  location: jsonObject.optional(),
  home_location: jsonObject.optional(),
  current_meter: jsonObject.optional(),
  rates: ratesSchema.optional(),
  attributes: jsonObject.optional(),
  operator_tag_overrides: z.array(operatorRequirementSchema).max(40).optional(),
  custody: jsonObject.optional(),
  photos: z.array(z.unknown()).max(200).optional(),
  documents: z.array(z.unknown()).max(200).optional(),
  tags: z.array(z.string().trim().max(160)).max(80).optional(),
  notes: z.string().trim().max(8000).optional(),
  expected_revision: z.number().int().min(0).optional()
});

export const patchUnitSchema = saveUnitSchema.partial();

export const meterEntrySchema = z.object({
  kind: z.enum(["hours", "miles", "fuel"]).optional(),
  value: z.number().min(0).max(100000000).optional(),
  gallons: z.number().min(0).max(1000000).optional(),
  cost_cents: z.number().int().min(0).optional(),
  recorded_at: z.string().trim().max(40).optional(),
  source: z.enum(["manual", "assignment", "maintenance"]).optional(),
  event_id: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(2000).optional()
});

export const programTriggerSchema = z.object({
  every_days: z.number().int().min(0).max(36500).optional(),
  every_meter_hours: z.number().min(0).max(1000000).optional(),
  every_meter_miles: z.number().min(0).max(10000000).optional(),
  per_assignment: z.boolean().optional(),
  daily: z.boolean().optional()
});

export const checklistItemSchema = z.object({
  id: z.string().trim().max(120).optional(),
  label: z.string().trim().min(1).max(400)
});

export const saveProgramSchema = z.object({
  id: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(240),
  kind: z.enum(["service", "inspection"]).optional(),
  type_id: z.string().trim().max(120).optional(),
  unit_id: z.string().trim().max(120).optional(),
  trigger: programTriggerSchema.optional(),
  checklist: z.array(checklistItemSchema).max(120).optional(),
  lead_time_days: z.number().int().min(0).max(365).optional(),
  estimated_downtime_hours: z.number().min(0).max(10000).optional(),
  estimated_cost_cents: z.number().int().min(0).optional(),
  status: z.enum(["active", "archived"]).optional(),
  expected_revision: z.number().int().min(0).optional()
});

export const workOrderCostSchema = z.object({
  parts_cents: z.number().int().min(0).optional(),
  labor_cents: z.number().int().min(0).optional(),
  vendor_cents: z.number().int().min(0).optional(),
  invoice_ref: z.string().trim().max(240).optional()
}).partial();

export const createWorkOrderSchema = z.object({
  unit_id: z.string().trim().min(1).max(120),
  program_id: z.string().trim().max(120).optional(),
  title: z.string().trim().max(300).optional(),
  kind: z.enum(["scheduled", "repair", "inspection"]).optional(),
  due_at: z.string().trim().max(40).optional(),
  assigned_to: jsonObject.optional(),
  notes: z.string().trim().max(8000).optional()
});

export const patchWorkOrderSchema = z.object({
  title: z.string().trim().max(300).optional(),
  kind: z.enum(["scheduled", "repair", "inspection"]).optional(),
  status: z.enum(["open", "in_progress"]).optional(),
  due_at: z.string().trim().max(40).optional(),
  assigned_to: jsonObject.optional(),
  cost: workOrderCostSchema.optional(),
  notes: z.string().trim().max(8000).optional(),
  expected_revision: z.number().int().min(0).optional()
});

export const scheduleWorkOrderSchema = z.object({
  start_at: z.string().trim().min(1).max(40),
  end_at: z.string().trim().min(1).max(40)
});

export const completeWorkOrderSchema = z.object({
  cost: workOrderCostSchema.optional(),
  meter_at_service: jsonObject.optional(),
  checklist_state: z.array(z.object({
    id: z.string().trim().max(120).optional(),
    label: z.string().trim().max(400).optional(),
    passed: z.boolean().optional(),
    notes: z.string().trim().max(2000).optional()
  })).max(200).optional(),
  open_repair: z.boolean().optional(),
  set_unit_down: z.boolean().optional(),
  notes: z.string().trim().max(8000).optional()
});

export const moduleSettingsSchema = z.object({
  tier: z.enum(["simple", "standard", "advanced", "custom", ""]).optional(),
  conflict_mode: z.enum(["warn", "block", "off"]).optional(),
  auto_fulfill_single_unit: z.boolean().optional(),
  default_meter_units: z.enum(["hours", "miles", "both"]).optional(),
  downtime_auto_block: z.boolean().optional(),
  operator_enforcement: z.enum(["warn", "block"]).optional(),
  field_meter_entry: z.boolean().optional(),
  expected_revision: z.number().int().min(0).optional()
});
