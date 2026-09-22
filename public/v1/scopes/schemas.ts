import { z } from "zod";

import { jsonObjectSchema, workAutomationBindingsSchema, workNodeDefinitionSchema } from "../work/schemas.js";

const scopeDefinitionIdSchema = z.string().trim().min(1).max(180);

export const scopeMaterialSelectorSchema = jsonObjectSchema.extend({
  match: z.enum(["any", "all"]).optional(),
  pricebook_item_ids: z.array(scopeDefinitionIdSchema).optional(),
  item_type_ids: z.array(scopeDefinitionIdSchema).optional(),
  categories: z.array(z.string().trim().min(1).max(180)).optional(),
  tags: z.array(z.string().trim().min(1).max(180)).optional(),
  exclude_pricebook_item_ids: z.array(scopeDefinitionIdSchema).optional(),
  exclude_item_type_ids: z.array(scopeDefinitionIdSchema).optional(),
  exclude_categories: z.array(z.string().trim().min(1).max(180)).optional(),
  exclude_tags: z.array(z.string().trim().min(1).max(180)).optional(),
  default: z.boolean().optional()
}).passthrough();

export const scopeScheduleDependencySchema = jsonObjectSchema.extend({
  list_id: scopeDefinitionIdSchema,
  type: z.enum(["finish_to_start", "start_to_start", "finish_to_finish"]).optional(),
  lag_minutes: z.number().int().min(-129_600).max(129_600).optional(),
  lag_days: z.number().min(-90).max(90).optional()
}).passthrough();

export const scopeMaterialScheduleSchema = jsonObjectSchema.extend({
  enabled: z.boolean().optional(),
  event_type_default_id: scopeDefinitionIdSchema.optional(),
  title: z.string().trim().min(1).max(300).optional(),
  kind: z.string().trim().min(1).max(120).optional(),
  icon: z.string().trim().max(120).optional(),
  color: z.string().trim().max(80).optional(),
  source_node_template_id: scopeDefinitionIdSchema.optional(),
  lock_on_order: z.boolean().optional(),
  rule: jsonObjectSchema.optional(),
  // Gantt structure: lists sharing a group_id nest under one derived group
  // row; depends_on links this list's event after another list's event.
  group_id: scopeDefinitionIdSchema.optional(),
  group_title: z.string().trim().min(1).max(300).optional(),
  group_color: z.string().trim().max(80).optional(),
  depends_on: z.array(scopeScheduleDependencySchema).optional(),
  // Seeds `event.confirmation` on the generated event, so a scope template can
  // declare "appointments of this kind always ask the customer to confirm"
  // without anyone configuring each appointment by hand.
  confirmation: jsonObjectSchema.optional(),
  // Seeds per-event customer scheduling/rescheduling policy. An explicit event
  // value wins so staff can tighten or disable one appointment without
  // changing the scope template.
  customer_scheduling: jsonObjectSchema.optional()
}).passthrough();

export const scopeMaterialOrderSourceSchema = jsonObjectSchema.extend({
  id: scopeDefinitionIdSchema,
  name: z.string().trim().min(1).max(300),
  kind: z.enum(["manual", "integration"]).optional(),
  status: z.enum(["active", "coming_soon", "disabled"]).optional(),
  provider: z.string().trim().max(180).optional()
}).passthrough();

export const scopeMaterialListDefinitionSchema = jsonObjectSchema.extend({
  id: scopeDefinitionIdSchema,
  title: z.string().trim().min(1).max(300),
  color: z.string().trim().min(1).max(80),
  selector: scopeMaterialSelectorSchema,
  schedule: scopeMaterialScheduleSchema.optional(),
  order_source_ids: z.array(scopeDefinitionIdSchema).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const scopeMaterialsDefinitionSchema = jsonObjectSchema.extend({
  enabled: z.boolean().optional(),
  assignment: z.enum(["first_match", "all_matches"]).optional(),
  lists: z.array(scopeMaterialListDefinitionSchema),
  order_sources: z.array(scopeMaterialOrderSourceSchema).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const scopeResourceTypeSchema = z.enum(["material", "labor", "equipment"]);

export const scopeResourceListDefinitionSchema = jsonObjectSchema.extend({
  id: scopeDefinitionIdSchema,
  resource_type: scopeResourceTypeSchema,
  title: z.string().trim().min(1).max(300),
  color: z.string().trim().min(1).max(80),
  selector: scopeMaterialSelectorSchema.optional(),
  schedule: scopeMaterialScheduleSchema.optional(),
  items: z.array(jsonObjectSchema).optional(),
  controls: jsonObjectSchema.optional(),
  compensation: jsonObjectSchema.optional(),
  order_source_ids: z.array(scopeDefinitionIdSchema).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const scopeResourcesDefinitionSchema = jsonObjectSchema.extend({
  enabled: z.boolean().optional(),
  terminology: jsonObjectSchema.optional(),
  types: jsonObjectSchema.optional(),
  lists: z.array(scopeResourceListDefinitionSchema),
  order_sources: z.array(scopeMaterialOrderSourceSchema).optional(),
  extension_points: z.array(jsonObjectSchema).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const scopeCommissionTriggerSchema = jsonObjectSchema.extend({
  hook: z.enum(["onCreated", "onStarted", "onReady", "onCompleted", "onCanceled"]).optional(),
  node_id: scopeDefinitionIdSchema.optional()
}).passthrough();

const scopeCustomFieldPathSchema = z.string().trim().min(1).max(780)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, "Custom field paths use letters, numbers, underscores, hyphens, and dots.");

export const scopeCustomFieldGroupSchema = jsonObjectSchema.extend({
  path: scopeCustomFieldPathSchema,
  label: z.string().trim().min(1).max(300),
  description: z.string().max(2_000).optional(),
  order: z.number().int().optional(),
  collapsed_by_default: z.boolean().optional(),
  location: z.enum(["project_left", "project_overview", "background"]).optional(),
  icon: z.string().trim().max(120).optional()
}).passthrough();

export const scopeCustomFieldDefaultSourceSchema = jsonObjectSchema.extend({
  source: z.enum(["event_assignment", "first_event_assignee", "appointment_assignee", "event_scheduler"]).optional(),
  event_type_id: scopeDefinitionIdSchema.optional(),
  selection: z.enum(["first_qualifying", "primary", "all"]).optional(),
  write_mode: z.enum(["if_empty"]).optional(),
  fallback_source: z.enum(["proposal_creator"]).optional()
}).passthrough();

export const scopeCustomFieldDefinitionSchema = jsonObjectSchema.extend({
  id: scopeDefinitionIdSchema.optional(),
  path: scopeCustomFieldPathSchema,
  label: z.string().trim().min(1).max(300),
  description: z.string().max(4_000).optional(),
  type: z.enum([
    "text", "multiline", "email", "phone", "url", "number", "currency", "percentage", "slider",
    "date", "datetime", "boolean", "toggle", "select", "radio", "multiselect", "tags", "list",
    "key_value", "json", "formula", "organization_user", "resource_group", "organization_connection",
    "assignable_subject"
  ]),
  cardinality: z.enum(["one", "many"]).optional(),
  group_path: scopeCustomFieldPathSchema.optional(),
  required: z.boolean().optional(),
  enabled: z.boolean().optional(),
  read_only: z.boolean().optional(),
  show_in_overview: z.boolean().optional(),
  show_in_scope: z.boolean().optional(),
  background_only: z.boolean().optional(),
  order: z.number().int().optional(),
  assignment_policy: jsonObjectSchema.optional(),
  default_from: scopeCustomFieldDefaultSourceSchema.optional(),
  ui: jsonObjectSchema.optional(),
  default_value: z.unknown().optional()
}).passthrough();

export const scopeCustomFieldsDefinitionSchema = jsonObjectSchema.extend({
  groups: z.array(scopeCustomFieldGroupSchema).max(100).optional(),
  fields: z.array(scopeCustomFieldDefinitionSchema).max(500).optional()
}).passthrough();

export const scopeEmailForwardingTargetSchema = jsonObjectSchema.extend({
  kind: z.enum(["custom_field", "organization_user", "email"]),
  custom_field_path: scopeCustomFieldPathSchema.optional(),
  user_id: scopeDefinitionIdSchema.optional(),
  email: z.string().trim().email().max(500).optional()
}).passthrough().superRefine((value, context) => {
  if (value.kind === "custom_field" && !value.custom_field_path) context.addIssue({ code:z.ZodIssueCode.custom, path:["custom_field_path"], message:"Custom-field forwarding targets require custom_field_path." });
  if (value.kind === "organization_user" && !value.user_id) context.addIssue({ code:z.ZodIssueCode.custom, path:["user_id"], message:"User forwarding targets require user_id." });
  if (value.kind === "email" && !value.email) context.addIssue({ code:z.ZodIssueCode.custom, path:["email"], message:"Email forwarding targets require email." });
});

export const scopeCommunicationsDefinitionSchema = jsonObjectSchema.extend({
  email_forwarding: jsonObjectSchema.extend({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(-1_000).max(1_000).optional(),
    target: scopeEmailForwardingTargetSchema
  }).passthrough().optional()
}).passthrough();

export const scopeCommissionRoleSchema = jsonObjectSchema.extend({
  key: scopeDefinitionIdSchema,
  label: z.string().trim().min(1).max(300),
  assignment_source: z.enum(["manual", "sales_appointment_assignee", "sales_appointment_scheduler", "project_custom_field"]).optional(),
  custom_field_path: scopeCustomFieldPathSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough().superRefine((value, context) => {
  if (value.assignment_source === "project_custom_field" && !value.custom_field_path) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["custom_field_path"], message: "Custom-field commission roles require custom_field_path." });
  }
});

export const scopeCommissionInstallmentSchema = jsonObjectSchema.extend({
  id: scopeDefinitionIdSchema,
  title: z.string().trim().min(1).max(300),
  share_bps: z.number().int().min(1).max(10_000),
  recognition: scopeCommissionTriggerSchema,
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const scopeCommissionSelectorSchema = jsonObjectSchema.extend({
  item_ids: z.array(scopeDefinitionIdSchema).optional(),
  categories: z.array(z.string().trim().min(1).max(180)).optional(),
  tags: z.array(z.string().trim().min(1).max(180)).optional(),
  exclude_item_ids: z.array(scopeDefinitionIdSchema).optional(),
  exclude_categories: z.array(z.string().trim().min(1).max(180)).optional(),
  exclude_tags: z.array(z.string().trim().min(1).max(180)).optional()
}).passthrough();

export const scopeCommissionTierSchema = jsonObjectSchema.extend({
  min_discount_bps: z.number().int().min(0).max(1_000_000).optional(),
  max_discount_bps: z.number().int().min(0).max(1_000_000).optional(),
  rate_bps: z.number().int().min(0).max(1_000_000)
}).passthrough();

export const scopeCommissionCalculationSchema = jsonObjectSchema.extend({
  mode: z.enum(["preset", "code"]),
  preset: z.enum(["percentage", "percentage_after_discount", "discount_tiered", "fixed", "selected_line_items"]).optional(),
  basis: z.enum(["proposal_total", "proposal_subtotal", "collected_revenue", "forecast_profit", "selected_line_items"]).optional(),
  rate_bps: z.number().int().min(0).max(1_000_000).optional(),
  fixed_amount_cents: z.number().int().min(0).optional(),
  fixed_adjustment_cents: z.number().int().optional(),
  minimum_cents: z.number().int().min(0).optional(),
  maximum_cents: z.number().int().min(0).optional(),
  subtract_discounts: z.boolean().optional(),
  selector: scopeCommissionSelectorSchema.optional(),
  tiers: z.array(scopeCommissionTierSchema).max(50).optional(),
  code: z.string().max(100_000).optional()
}).superRefine((value, context) => {
  if (value.mode === "code" && !String(value.code || "").trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "Custom commission rules require code." });
  }
});

export const scopeCommissionRuleSchema = jsonObjectSchema.extend({
  id: scopeDefinitionIdSchema,
  title: z.string().trim().min(1).max(300),
  enabled: z.boolean().optional(),
  payee_role: scopeDefinitionIdSchema,
  entry_state: z.enum(["projected", "accrued"]).optional(),
  allocation: z.enum(["split_evenly", "each"]).optional(),
  trigger: scopeCommissionTriggerSchema.optional(),
  installments: z.array(scopeCommissionInstallmentSchema).max(20).optional(),
  calculation: scopeCommissionCalculationSchema,
  metadata: jsonObjectSchema.optional()
}).passthrough().superRefine((value, context) => {
  if (value.installments?.length && value.installments.reduce((sum, installment) => sum + installment.share_bps, 0) !== 10_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["installments"], message: "Commission installment shares must total 100%." });
  }
});

export const scopeCommissionsDefinitionSchema = jsonObjectSchema.extend({
  enabled: z.boolean().optional(),
  roles: z.array(scopeCommissionRoleSchema).max(100).optional(),
  rules: z.array(scopeCommissionRuleSchema).max(100),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const scopeChecklistItemDefinitionSchema = jsonObjectSchema.extend({
  title: z.string().trim().min(1).max(500),
  item_type: z.enum(["todo", "rating"]).optional(),
  description: z.string().optional(),
  sort_order: z.number().int().optional()
}).passthrough();

export const scopeChecklistCustomerAccessSchema = jsonObjectSchema.extend({
  visible: z.boolean().optional(),
  can_complete: z.boolean().optional(),
  can_edit_items: z.boolean().optional(),
  voice_mode: z.enum(["off", "complete", "edit"]).optional()
}).passthrough();

export const scopeChecklistDefinitionSchema = jsonObjectSchema.extend({
  id: scopeDefinitionIdSchema,
  title: z.string().trim().min(1).max(300),
  description: z.string().optional(),
  kind: z.enum(["todo", "quality"]).optional(),
  audience: z.enum(["crew", "supervisor"]).optional(),
  crew_editable: z.boolean().optional(),
  icon: z.string().trim().max(120).optional(),
  sort_order: z.number().int().optional(),
  assignment_policy: jsonObjectSchema.optional(),
  assigned_user_ids: z.array(scopeDefinitionIdSchema).optional(),
  assigned_role_ids: z.array(scopeDefinitionIdSchema).optional(),
  assigned_resource_group_ids: z.array(scopeDefinitionIdSchema).optional(),
  customer_access: scopeChecklistCustomerAccessSchema.optional(),
  items: z.array(scopeChecklistItemDefinitionSchema).max(200).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const scopeTemplateKindSchema = z.enum(["pipeline", "production"]);

export const scopeTemplateDefinitionSchema = jsonObjectSchema.extend({
  schema_version: z.number().int().positive().optional(),
  id: scopeDefinitionIdSchema,
  kind: scopeTemplateKindSchema.optional(),
  name: z.string().trim().min(1).max(300),
  description: z.string().optional(),
  details: z.string().optional(),
  color: z.string().trim().max(80).optional(),
  icon: z.string().trim().max(120).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  sort_order: z.number().int().optional(),
  proposal: jsonObjectSchema.optional(),
  fields: z.array(jsonObjectSchema).optional(),
  custom_fields: scopeCustomFieldsDefinitionSchema.optional(),
  communications: scopeCommunicationsDefinitionSchema.optional(),
  materials: scopeMaterialsDefinitionSchema.optional(),
  resources: scopeResourcesDefinitionSchema.optional(),
  // Template-level scheduling presentation: which schedule surface projects
  // from this scope should default to, and Gantt behavior hints.
  scheduling: jsonObjectSchema.extend({
    default_view: z.enum(["routing", "gantt", "calendar", "day", "4day", "week", "month", "appointment_schedule"]).optional(),
    gantt_zoom: z.enum(["hour", "day", "week", "month"]).optional()
  }).passthrough().optional(),
  // Defaults for appointments created under this sales/production scope.
  // Individual appointments can still override or disable the policy.
  customer_scheduling: jsonObjectSchema.optional(),
  commissions: scopeCommissionsDefinitionSchema.optional(),
  checklists: z.array(scopeChecklistDefinitionSchema).max(20).optional(),
  work_plan: jsonObjectSchema.extend({
    title: z.string().trim().max(500).optional(),
    terminology: jsonObjectSchema.optional(),
    automation_bindings: workAutomationBindingsSchema.optional(),
    root_nodes: z.array(workNodeDefinitionSchema).min(1)
  }),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const saveScopeTemplateSchema = scopeTemplateDefinitionSchema.partial().extend({
  id: z.string().trim().min(1).max(180),
  name: z.string().trim().min(1).max(300)
}).passthrough();

export const publishScopeTemplateSchema = jsonObjectSchema.extend({
  definition: scopeTemplateDefinitionSchema.optional(),
  expected_version: z.number().int().positive().optional()
}).passthrough();

export type ScopeTemplateDefinition = z.infer<typeof scopeTemplateDefinitionSchema>;
