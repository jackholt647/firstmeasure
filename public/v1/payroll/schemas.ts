import { z } from "zod";

export const jsonObjectSchema = z.object({}).passthrough();
export const payrollIdSchema = z.string().trim().min(1).max(180);
export const isoDateSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

export const payrollRecurrenceSchema = jsonObjectSchema.extend({
  frequency: z.enum(["weekly", "biweekly", "semi_monthly", "monthly"]),
  weekday: z.number().int().min(0).max(6).optional(),
  days: z.array(z.number().int().min(1).max(31)).min(1).max(4).optional(),
  day: z.number().int().min(1).max(31).optional(),
  anchor_date: isoDateSchema.optional()
}).superRefine((value, context) => {
  if (["weekly", "biweekly"].includes(value.frequency) && value.weekday === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["weekday"], message: "Weekly schedules require a weekday." });
  }
  if (value.frequency === "biweekly" && !value.anchor_date) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["anchor_date"], message: "Biweekly schedules require an anchor date." });
  }
  if (value.frequency === "semi_monthly" && !value.days?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["days"], message: "Semi-monthly schedules require pay days." });
  }
  if (value.frequency === "monthly" && value.day === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["day"], message: "Monthly schedules require a pay day." });
  }
});

export const payrollDelaySchema = jsonObjectSchema.extend({
  periods: z.number().int().min(0).max(26).optional(),
  days: z.number().int().min(0).max(365).optional()
});

export const payrollScheduleInputSchema = jsonObjectSchema.extend({
  name: z.string().trim().min(1).max(300),
  status: z.enum(["active", "archived"]).optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  timezone: z.string().trim().min(1).max(120).optional(),
  recurrence: payrollRecurrenceSchema,
  delay: payrollDelaySchema.optional(),
  timing_basis: z.enum(["worked", "completed"]).optional(),
  clawback_cap_percent: z.number().min(0).max(100).optional(),
  metadata: jsonObjectSchema.optional(),
  expected_revision: z.number().int().positive().optional()
});

export const payrollSchedulePatchSchema = payrollScheduleInputSchema.partial().extend({
  expected_revision: z.number().int().positive()
});

export const payrollPolicySubjectSchema = z.enum([
  "organization",
  "worker_type",
  "access_role",
  "resource_group",
  "organization_user",
  "organization_connection"
]);

export const payrollPolicyInputSchema = jsonObjectSchema.extend({
  schedule_id: payrollIdSchema,
  earning_kind: z.enum(["*", "hourly", "salary", "piece_rate", "commission", "reimbursement", "adjustment", "clawback"]).optional(),
  timing_basis: z.enum(["worked", "completed"]).optional(),
  clawback_cap_percent: z.number().min(0).max(100).optional(),
  metadata: jsonObjectSchema.optional(),
  expected_revision: z.number().int().positive().optional()
});

/** Anyone work can be assigned to can be paid: a person, a group of users paid as one, or an outside company. */
export const PAYROLL_PAYEE_TYPES = ["organization_user", "resource_group", "organization_connection"] as const;
export const payrollPayeeType = (value: unknown) => (PAYROLL_PAYEE_TYPES as readonly string[]).includes(String(value)) ? String(value) as typeof PAYROLL_PAYEE_TYPES[number] : "organization_user";
export const payrollPayeeRefSchema = jsonObjectSchema.extend({
  type: z.enum(PAYROLL_PAYEE_TYPES),
  id: payrollIdSchema,
  name: z.string().trim().max(300).optional(),
  worker_type: z.enum(["employee", "independent_contractor", "subcontractor"]).optional(),
  access_role_ids: z.array(payrollIdSchema).optional(),
  resource_group_ids: z.array(payrollIdSchema).optional(),
  metadata: jsonObjectSchema.optional()
});

export const payrollLedgerStateSchema = z.enum(["projected", "accrued", "void"]);
export const payrollLedgerKindSchema = z.enum(["hourly", "salary", "piece_rate", "commission", "reimbursement", "adjustment", "clawback"]);

export const payrollLedgerEntryInputSchema = jsonObjectSchema.extend({
  id: payrollIdSchema.optional(),
  payee: payrollPayeeRefSchema,
  schedule_id: payrollIdSchema.optional(),
  kind: payrollLedgerKindSchema,
  subgroup: z.string().trim().max(120).optional(),
  state: payrollLedgerStateSchema.optional(),
  amount_cents: z.number().int(),
  currency: z.string().trim().min(3).max(8).optional(),
  project_id: payrollIdSchema.optional(),
  project_title: z.string().trim().max(500).optional(),
  worked_at: z.string().trim().max(80).optional(),
  completed_at: z.string().trim().max(80).optional(),
  eligible_at: z.string().trim().max(80).optional(),
  source_event_id: z.string().trim().min(1).max(300),
  source_trigger_id: z.string().trim().max(300).optional(),
  description: z.string().trim().max(1000).optional(),
  metadata: jsonObjectSchema.optional()
}).superRefine((value, context) => {
  if (value.kind === "clawback" && value.amount_cents > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["amount_cents"], message: "Clawback entries must be zero or negative." });
  }
});

export const payrollLedgerBatchInputSchema = jsonObjectSchema.extend({
  entries: z.array(payrollLedgerEntryInputSchema).min(1).max(1000)
});

export const payrollLedgerReverseSchema = jsonObjectSchema.extend({
  source_event_id: z.string().trim().min(1).max(300),
  amount_cents: z.number().int().positive().optional(),
  occurred_at: z.string().trim().max(80).optional(),
  description: z.string().trim().max(1000).optional(),
  metadata: jsonObjectSchema.optional()
});

export const payrollBatchCreateSchema = jsonObjectSchema.extend({
  schedule_id: payrollIdSchema,
  pay_date: isoDateSchema,
  run_type: z.enum(["regular", "off_cycle"]).optional(),
  period_start: isoDateSchema.optional(),
  period_end: isoDateSchema.optional(),
  entry_ids: z.array(payrollIdSchema).max(5000).optional(),
  reason: z.string().trim().max(1000).optional(),
  metadata: jsonObjectSchema.optional()
});

export const payrollBatchItemPatchSchema = jsonObjectSchema.extend({
  status: z.enum(["run", "paid"]),
  payment_reference: z.string().trim().max(300).optional(),
  metadata: jsonObjectSchema.optional()
});

export const payrollBatchActionSchema = jsonObjectSchema.extend({
  action: z.enum(["run", "paid", "void", "submit_approval", "approve", "reject", "finalize", "reopen"]),
  payment_reference: z.string().trim().max(300).optional(),
  approvers: z.array(jsonObjectSchema.extend({
    user_id: payrollIdSchema,
    name: z.string().trim().max(300).optional()
  })).max(25).optional(),
  note: z.string().trim().max(1000).optional(),
  metadata: jsonObjectSchema.optional()
});

export const payrollExportTypeSchema = z.enum([
  "payroll_register", "batch_summary", "batch_detail", "earnings_ledger", "timesheets",
  "commissions", "reimbursements", "contractor_payments", "provider_handoff"
]);

export const payrollExportCreateSchema = jsonObjectSchema.extend({
  type: payrollExportTypeSchema,
  batch_id: payrollIdSchema.optional(),
  from: isoDateSchema.optional(),
  through: isoDateSchema.optional(),
  format: z.enum(["csv", "pdf"]).optional(),
  include_projected: z.boolean().optional(),
  metadata: jsonObjectSchema.optional()
});

export type PayrollScheduleInput = z.infer<typeof payrollScheduleInputSchema>;
export type PayrollPolicySubject = z.infer<typeof payrollPolicySubjectSchema>;
export type PayrollPayeeRef = z.infer<typeof payrollPayeeRefSchema>;
export type PayrollLedgerEntryInput = z.infer<typeof payrollLedgerEntryInputSchema>;
