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
  contact_ref: jsonObjectSchema.optional(),
  customer_id: z.string().trim().optional(),
  amount: z.number().optional(),
  amount_cents: z.number().int().optional(),
  currency: z.string().trim().optional(),
  method: jsonObjectSchema.optional(),
  processor: jsonObjectSchema.optional(),
  received_at: z.string().trim().optional(),
  settled_at: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  metadata: jsonObjectSchema.optional(),
  allocate: z.boolean().optional(),
  allocation_mode: z.string().trim().optional()
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
  vendor_ref: jsonObjectSchema.optional(),
  crew_ref: jsonObjectSchema.optional(),
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

