import { z } from "zod";

export const WORK_SCHEMA_VERSION = 1;

export const jsonObjectSchema = z.object({}).passthrough();

export const workNodeStatusSchema = z.enum([
  "pending",
  "blocked",
  "ready",
  "active",
  "completed",
  "skipped",
  "canceled"
]);

export const workPlanStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "canceled"
]);

export const workCompletionModeSchema = z.enum([
  "manual",
  "self",
  "all_children",
  "any_child",
  "self_and_children"
]);

export const workAutomationBindingSchema = jsonObjectSchema.extend({
  id: z.string().trim().min(1).max(180).optional(),
  automation: z.string().trim().min(1).max(220),
  enabled: z.boolean().optional(),
  input: jsonObjectSchema.optional(),
  continue_on_error: z.boolean().optional()
}).passthrough();

export const workAutomationBindingsSchema = z.record(z.array(workAutomationBindingSchema)).default({});

export const workTerminologySchema = jsonObjectSchema.extend({
  phase: z.string().trim().min(1).max(80).default("Phase"),
  stage: z.string().trim().min(1).max(80).default("Stage"),
  task: z.string().trim().min(1).max(80).default("To-do"),
  board: z.string().trim().min(1).max(80).default("Board")
}).passthrough();

export const workExternalTriggerSchema = jsonObjectSchema.extend({
  id: z.string().trim().min(1).max(180).optional(),
  event: z.string().trim().min(1).max(220),
  transition: z.enum(["ready", "active", "completed", "skipped", "canceled"]).optional(),
  conditions: jsonObjectSchema.optional()
}).passthrough();

export const followUpQuickOptionSchema = jsonObjectSchema.extend({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  amount: z.number().int().min(1).max(3650),
  unit: z.enum(["days", "weeks", "months"]).default("days")
}).passthrough();

export const followUpOutcomeSchema = jsonObjectSchema.extend({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  action: z.enum(["reschedule", "scheduled", "lost"]),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  stage_id: z.string().trim().max(180).optional()
}).passthrough();

export const followUpRetryPolicySchema = jsonObjectSchema.extend({
  enabled: z.boolean().default(true),
  triggers: z.array(z.enum(["voicemail", "no_answer", "manual_follow_up"])).max(3),
  after_last: z.enum(["repeat_last", "stop"]).default("repeat_last"),
  steps: z.array(followUpQuickOptionSchema).min(1).max(30)
}).passthrough();

export const followUpConfigurationSchema = jsonObjectSchema.extend({
  tag: z.literal("follow_up").default("follow_up"),
  label: z.string().trim().min(1).max(120).default("Follow-up"),
  default_title: z.string().trim().min(1).max(500).default("Follow-up call"),
  default_time: z.string().trim().regex(/^(?:|(?:[01]\d|2[0-3]):[0-5]\d)$/).default(""),
  quick_options: z.array(followUpQuickOptionSchema).min(1).max(20),
  retry_policy: followUpRetryPolicySchema,
  outcomes: z.array(followUpOutcomeSchema).min(3).max(20)
}).passthrough();

export const workConfigurationSchema = jsonObjectSchema.extend({
  schema_version: z.number().int().positive().default(WORK_SCHEMA_VERSION),
  terminology: workTerminologySchema.default({ phase: "Phase", stage: "Stage", task: "To-do", board: "Board" }),
  follow_ups: followUpConfigurationSchema
}).passthrough();

export const workNodeDefinitionSchema: z.ZodType<any> = z.lazy(() => jsonObjectSchema.extend({
  id: z.string().trim().min(1).max(180),
  title: z.string().trim().min(1).max(500),
  description: z.string().optional(),
  terminology_key: z.string().trim().max(180).optional(),
  sort_order: z.number().int().optional(),
  actionable: z.boolean().optional(),
  show_in_todo_list: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  completion_mode: workCompletionModeSchema.optional(),
  depends_on: z.array(z.string().trim().min(1).max(180)).optional(),
  assigned_user_ids: z.array(z.string().trim().min(1)).optional(),
  assigned_role_ids: z.array(z.string().trim().min(1)).optional(),
  assigned_resource_group_ids: z.array(z.string().trim().min(1)).optional(),
  assignment_policy: jsonObjectSchema.optional(),
  due_offset_minutes: z.number().int().optional(),
  automation_bindings: workAutomationBindingsSchema.optional(),
  external_triggers: z.array(workExternalTriggerSchema).optional(),
  metadata: jsonObjectSchema.optional(),
  children: z.array(workNodeDefinitionSchema).optional()
}).passthrough());

export const createWorkPlanSchema = jsonObjectSchema.extend({
  id: z.string().trim().min(1).max(180).optional(),
  branch_id: z.string().trim().max(180).optional(),
  project_id: z.string().trim().max(180).optional(),
  source_type: z.string().trim().max(120).optional(),
  source_id: z.string().trim().max(180).optional(),
  source_version_id: z.string().trim().max(180).optional(),
  source_key: z.string().trim().max(500).optional(),
  template_id: z.string().trim().max(180).optional(),
  template_version: z.number().int().positive().optional(),
  scope_piece_id: z.string().trim().max(180).optional(),
  title: z.string().trim().min(1).max(500),
  terminology: jsonObjectSchema.optional(),
  automation_bindings: workAutomationBindingsSchema.optional(),
  root_nodes: z.array(workNodeDefinitionSchema).min(1),
  context: jsonObjectSchema.optional(),
  metadata: jsonObjectSchema.optional(),
  start_immediately: z.boolean().optional()
}).passthrough();

export const patchWorkNodeSchema = jsonObjectSchema.extend({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().optional(),
  status: workNodeStatusSchema.optional(),
  assigned_user_ids: z.array(z.string().trim().min(1)).optional(),
  assigned_role_ids: z.array(z.string().trim().min(1)).optional(),
  assigned_resource_group_ids: z.array(z.string().trim().min(1)).optional(),
  assignment_policy: jsonObjectSchema.optional(),
  priority: z.number().int().min(0).max(100).optional(),
  due_at: z.string().trim().optional(),
  notes: z.array(jsonObjectSchema).optional(),
  metadata: jsonObjectSchema.optional(),
  reason: z.string().trim().optional()
}).passthrough();

export const transitionWorkNodeSchema = jsonObjectSchema.extend({
  status: workNodeStatusSchema,
  reason: z.string().trim().optional(),
  allow_reopen: z.boolean().optional(),
  payload: jsonObjectSchema.optional()
}).passthrough();

export const setManualPlanStageSchema = jsonObjectSchema.extend({
  stage_id: z.string().trim().min(1).max(180)
}).passthrough();

export const emitWorkEventSchema = jsonObjectSchema.extend({
  event: z.string().trim().min(1).max(220),
  project_id: z.string().trim().max(180).optional(),
  plan_id: z.string().trim().max(180).optional(),
  node_id: z.string().trim().max(180).optional(),
  idempotency_key: z.string().trim().max(500).optional(),
  payload: jsonObjectSchema.optional(),
  context: jsonObjectSchema.optional()
}).passthrough();

export type WorkNodeStatus = z.infer<typeof workNodeStatusSchema>;
export type WorkPlanStatus = z.infer<typeof workPlanStatusSchema>;
export type WorkCompletionMode = z.infer<typeof workCompletionModeSchema>;
export type WorkAutomationBinding = z.infer<typeof workAutomationBindingSchema>;
export type WorkNodeDefinition = z.infer<typeof workNodeDefinitionSchema>;
export type CreateWorkPlanInput = z.infer<typeof createWorkPlanSchema>;
export type WorkConfiguration = z.infer<typeof workConfigurationSchema>;
