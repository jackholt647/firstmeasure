import { z } from "zod";

export const PAYMENT_SCHEMA_VERSION = 1;

export const jsonObjectSchema = z.object({}).passthrough();

const optionalIdSchema = z.string().trim().max(160).optional();

export const paymentDirectionSchema = z.enum(["inbound", "outbound"]);
export const paymentStatusSchema = z.enum(["draft", "pending", "authorized", "settled", "failed", "cancelled", "refunded", "partially_refunded"]);
export const obligationStatusSchema = z.enum(["scheduled", "due", "overdue", "partially_paid", "paid", "void"]);
export const payableStatusSchema = z.enum(["open", "partially_paid", "paid", "void"]);

export const moneySchema = jsonObjectSchema.extend({
  amount: z.number().optional(),
  amount_cents: z.number().int().optional(),
  currency: z.string().trim().optional()
}).passthrough();

export const createPaymentSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  direction: paymentDirectionSchema.optional(),
  kind: z.string().trim().optional(),
  status: paymentStatusSchema.optional(),
  project_id: z.string().trim().optional(),
  obligation_id: z.string().trim().optional(),
  contact_ref: jsonObjectSchema.optional(),
  customer_id: z.string().trim().optional(),
  amount: z.number().optional(),
  amount_cents: z.number().int().optional(),
  currency: z.string().trim().optional(),
  method: jsonObjectSchema.optional(),
  processor: jsonObjectSchema.optional(),
  provider: z.string().trim().max(40).optional(),
  fee_cents: z.number().int().min(0).optional(),
  merchant_amount_cents: z.number().int().min(0).optional(),
  received_at: z.string().trim().optional(),
  settled_at: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional(),
  allocate: z.boolean().optional(),
  allocation_mode: z.string().trim().optional(),
  // Provider charge path (used only when the org resolves a payment provider;
  // otherwise these fields are ignored and the legacy record flow runs).
  payment_method_id: z.string().trim().max(200).optional(),
  saved_method_id: z.string().trim().max(200).optional(),
  save_payment_method: z.boolean().optional(),
  apply_surcharge: z.boolean().optional(),
  method_label: z.string().trim().max(200).optional()
}).passthrough();

// Card/bank blocks are forwarded to the adapter for MOCK tokenization only —
// never persisted (see providers/mock.ts createPaymentMethodIntent).
export const paymentMethodIntentSchema = jsonObjectSchema.extend({
  type: z.enum(["card", "bank", "ach"]).optional(),
  card: jsonObjectSchema.extend({
    number: z.string().trim().max(30).optional(),
    exp_month: z.number().int().min(1).max(12).optional(),
    exp_year: z.number().int().min(0).max(3000).optional(),
    cvc: z.string().trim().max(8).optional(),
    name: z.string().trim().max(200).optional(),
    zip: z.string().trim().max(20).optional()
  }).passthrough().optional(),
  bank: jsonObjectSchema.extend({
    routing: z.string().trim().max(20).optional(),
    account: z.string().trim().max(30).optional(),
    account_type: z.string().trim().max(20).optional(),
    name: z.string().trim().max(200).optional()
  }).passthrough().optional(),
  billing_details: jsonObjectSchema.optional()
}).passthrough();

export const createSavedMethodSchema = jsonObjectSchema.extend({
  provider_payment_method_id: z.string().trim().min(1).max(200),
  type: z.enum(["card", "bank", "ach"]).optional(),
  brand: z.string().trim().max(60).optional(),
  last4: z.string().trim().max(8).optional(),
  exp_month: z.number().int().min(1).max(12).nullable().optional(),
  exp_year: z.number().int().min(0).max(3000).nullable().optional(),
  label: z.string().trim().max(200).optional(),
  default: z.boolean().optional()
}).passthrough();

export const refundPaymentSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  amount: z.number().optional(),
  amount_cents: z.number().int().optional(),
  currency: z.string().trim().optional(),
  reason: z.string().trim().optional(),
  method: jsonObjectSchema.optional(),
  processor: jsonObjectSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const clearPaymentSchema = jsonObjectSchema.extend({
  cleared_at: z.string().trim().max(80).optional(),
  note: z.string().trim().max(1000).optional()
}).passthrough();

export const reallocatePaymentSchema = jsonObjectSchema.extend({
  allocations: z.array(jsonObjectSchema.extend({
    obligation_id: z.string().trim(),
    amount_cents: z.number().int()
  }).passthrough()).optional(),
  allocation_mode: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const createPaymentIntentSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  direction: paymentDirectionSchema.optional(),
  kind: z.string().trim().optional(),
  project_id: z.string().trim().optional(),
  contact_ref: jsonObjectSchema.optional(),
  amount: z.number().optional(),
  amount_cents: z.number().int().optional(),
  currency: z.string().trim().optional(),
  provider: z.string().trim().optional(),
  processor: jsonObjectSchema.optional(),
  expires_at: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const createPayableSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  project_id: z.string().trim().optional(),
  kind: z.string().trim().optional(),
  source: jsonObjectSchema.optional(),
  payee_ref: jsonObjectSchema.optional(),
  vendor_ref: jsonObjectSchema.optional(),
  crew_ref: jsonObjectSchema.optional(),
  expense_target_keys: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
  amount: z.number().optional(),
  amount_cents: z.number().int().optional(),
  currency: z.string().trim().optional(),
  due_at: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const createDisbursementSchema = jsonObjectSchema.extend({
  id: optionalIdSchema,
  project_id: z.string().trim().optional(),
  kind: z.string().trim().optional(),
  payable_ids: z.array(z.string().trim()).optional(),
  amount: z.number().optional(),
  amount_cents: z.number().int().optional(),
  currency: z.string().trim().optional(),
  method: jsonObjectSchema.optional(),
  processor: jsonObjectSchema.optional(),
  paid_at: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchMerchantConfigSchema = jsonObjectSchema.extend({
  provider: z.string().trim().max(40).optional(),
  forward: jsonObjectSchema.extend({
    business_id: z.string().trim().max(200).optional(),
    application_id: z.string().trim().max(200).optional(),
    account_id: z.string().trim().max(200).optional(),
    processing_plan_id: z.string().trim().max(200).optional(),
    boarding_status: z.string().trim().max(80).optional(),
    processing_enabled: z.boolean().optional(),
    payouts_enabled: z.boolean().optional(),
    enabled_rails: jsonObjectSchema.extend({
      card: z.boolean().optional(),
      bank: z.boolean().optional(),
      wallets: z.boolean().optional(),
      terminals: z.boolean().optional()
    }).passthrough().optional()
  }).passthrough().optional()
}).passthrough();

export const boardingApplicationSchema = jsonObjectSchema.extend({
  business_id: z.string().trim().max(200).optional(),
  processing_plan_id: z.string().trim().max(200).optional(),
  external_account_id: z.string().trim().max(200).optional(),
  business: jsonObjectSchema.extend({
    name: z.string().trim().max(300).optional(),
    email: z.string().trim().max(300).optional(),
    phone: z.string().trim().max(60).optional()
  }).passthrough().optional(),
  company: jsonObjectSchema.optional(),
  address: jsonObjectSchema.optional(),
  owners: z.array(jsonObjectSchema).max(10).optional(),
  volumes: jsonObjectSchema.optional(),
  // {routing_number, account_number, account_type, holder_name} from the
  // onboarding wizard's bank step. Mock stores it on the application; the
  // Forward adapter tucks it under user_fields.bank_account (no wire slot).
  bank_account: jsonObjectSchema.optional(),
  user_fields: jsonObjectSchema.optional()
}).passthrough();

// Hosted-first signup harness: every field optional — the whole point is
// that the merchant fills the real application out on Forward's hosted form.
export const hostedSignupSchema = jsonObjectSchema.extend({
  business_name: z.string().trim().max(300).optional(),
  email: z.string().trim().max(300).optional(),
  processing_plan_id: z.string().trim().max(200).optional()
}).passthrough();

export const merchantMockAdvanceSchema = jsonObjectSchema.extend({
  op: z.enum(["underwriting", "hosted_submit", "settle", "dispute", "charge", "orphan_payment"]).optional(),
  application_id: z.string().trim().max(200).optional(),
  to: z.enum(["APPROVED", "NEED_INFORMATION", "DECLINED"]).optional(),
  documents_requested: z.array(jsonObjectSchema).max(20).optional(),
  payment_id: z.string().trim().max(200).optional(),
  amount_cents: z.number().int().min(0).optional(),
  reason: z.string().trim().max(300).optional(),
  // op: "charge" — runs a provider intent + charge (mock tokens like
  // pm_mock_visa / pm_mock_declined) so harnesses can produce fee-bearing
  // provider payments over HTTP before the intake modal is wired.
  payment_method_id: z.string().trim().max(200).optional(),
  project_id: z.string().trim().max(200).optional()
}).passthrough();

export const autopayEnrollSchema = jsonObjectSchema.extend({
  saved_method_id: z.string().trim().max(200).optional(),
  contact_ref: jsonObjectSchema.optional(),
  max_amount_cents: z.number().int().min(0).nullable().optional(),
  status: z.enum(["active", "paused"]).optional()
}).passthrough();

export const autopayRunSchema = jsonObjectSchema.extend({
  // Test/simulation hook: evaluate due/retry windows as of this instant.
  now: z.string().trim().max(80).optional()
}).passthrough();

export const matchUnmatchedSchema = jsonObjectSchema.extend({
  payment_id: z.string().trim().min(1).max(200)
}).passthrough();

export const dismissUnmatchedSchema = jsonObjectSchema.extend({
  reason: z.string().trim().max(500).optional()
}).passthrough();

export const createInvoiceSchema = jsonObjectSchema.extend({
  obligation_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  line_items: z.array(jsonObjectSchema.extend({
    type: z.enum(["payment", "manual"]).optional(),
    obligation_id: z.string().trim().max(200).optional(),
    description: z.string().trim().min(1).max(500),
    amount_cents: z.number().int().min(1).max(1_000_000_000)
  }).passthrough()).min(1).max(50).optional(),
  tax_enabled: z.boolean().optional(),
  tax_percent: z.number().min(0).max(100).optional(),
  issue_date: z.string().trim().max(40).optional(),
  due_date: z.string().trim().max(40).optional(),
  render_paid_in_full: z.boolean().optional(),
  notes: z.string().trim().max(4000).optional()
}).passthrough();

export const markInvoiceDueSchema = jsonObjectSchema.extend({
  due_at: z.string().trim().max(80).optional()
}).passthrough();

export const quickInvoiceSchema = jsonObjectSchema.extend({
  obligation_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  send: z.boolean().optional(),
  recipient: z.string().trim().email().optional(),
  include_portal_link: z.boolean().optional(),
  message: z.string().trim().max(4000).optional(),
  notes: z.string().trim().max(4000).optional(),
  tax_enabled: z.boolean().optional()
}).passthrough();

export const voidInvoiceSchema = jsonObjectSchema.extend({
  reason: z.string().trim().max(1000).optional()
}).passthrough();

export const invoiceProductionHoldSchema = jsonObjectSchema.extend({
  enabled: z.boolean(),
  note: z.string().trim().max(1000).optional()
}).passthrough();

export const emailInvoiceSchema = jsonObjectSchema.extend({
  recipient: z.string().trim().email(),
  include_portal_link: z.boolean().optional(),
  subject: z.string().trim().max(300).optional(),
  message: z.string().trim().max(4000).optional()
}).passthrough();

export const createSupplementalExpenseSchema = jsonObjectSchema.extend({
  title: z.string().trim().min(1).max(300),
  resource_type: z.enum(["material", "labor", "equipment", "other"]).optional(),
  projected_cents: z.number().int().min(0).optional(),
  projected_amount: z.number().min(0).optional(),
  actual_cents: z.number().int().min(0).nullable().optional(),
  actual_amount: z.number().min(0).nullable().optional(),
  amount: z.number().min(0).optional(),
  currency: z.string().trim().optional(),
  notes: z.string().trim().max(4000).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchSupplementalExpenseSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  projected_cents: z.number().int().min(0).optional(),
  actual_cents: z.number().int().min(0).nullable().optional(),
  notes: z.string().trim().max(4000).optional(),
  status: z.enum(["active", "archived"]).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const setExpenseActualSchema = jsonObjectSchema.extend({
  target_key: z.string().trim().min(1).max(400),
  actual_cents: z.number().int().min(0).nullable(),
  expected_revision: z.number().int().positive().optional(),
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(4000).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const patchReceiptSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  title: z.string().trim().max(300).optional(),
  total_cents: z.number().int().min(0).optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  purchase_date: z.string().trim().max(40).optional(),
  purchase_time: z.string().trim().max(40).optional(),
  purchase_timezone: z.string().trim().max(100).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const applyReceiptSchema = patchReceiptSchema.extend({
  target_keys: z.array(z.string().trim().min(1).max(400)).min(1),
  accepted_suggestion: z.boolean().optional(),
  attribution_metadata: jsonObjectSchema.optional(),
  reimbursement: jsonObjectSchema.extend({
    payee_ref: jsonObjectSchema.extend({
      kind: z.string().trim().max(80).optional(),
      id: z.string().trim().min(1).max(200),
      name: z.string().trim().max(300).optional()
    }).passthrough(),
    amount_cents: z.number().int().min(0).optional(),
    note: z.string().trim().max(1000).optional()
  }).passthrough().optional()
}).passthrough();

export const jsonReceiptUploadSchema = jsonObjectSchema.extend({
  project_id: z.string().trim().max(200).optional(),
  file_name: z.string().trim().min(1).max(500).optional(),
  content_type: z.string().trim().max(200).optional(),
  file_base64: z.string().min(1).optional(),
  media_id: z.string().trim().max(200).optional(),
  title: z.string().trim().max(300).optional(),
  total_cents: z.number().int().min(0).nullable().optional(),
  purchase_date: z.string().trim().max(40).optional(),
  purchase_time: z.string().trim().max(40).optional(),
  purchase_timezone: z.string().trim().max(100).optional(),
  upload_location: jsonObjectSchema.optional(),
  owner: jsonObjectSchema.optional(),
  associations: z.array(jsonObjectSchema).optional(),
  metadata: jsonObjectSchema.optional()
}).refine((value) => !!value.file_base64 || !!value.media_id, {
  message: "file_base64 or media_id is required"
});

