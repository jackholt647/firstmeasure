import { z } from "zod";

export const compensationSubjectTypeSchema = z.enum([
  "organization_user",
  "resource_group",
  "organization_connection"
]);

export const compensationComponentKindSchema = z.enum(["hourly", "salary", "piece_rate"]);

const jsonObjectSchema = z.object({}).passthrough();
const stableIdSchema = z.string().trim().min(1).max(180);

export const compensationComponentSchema = jsonObjectSchema.extend({
  id: stableIdSchema.optional(),
  kind: compensationComponentKindSchema,
  label: z.string().trim().max(300).optional(),
  rate_cents: z.number().int().min(0),
  period: z.string().trim().max(80).optional(),
  hours_per_period: z.number().positive().optional(),
  hourly_equivalent_rate_cents: z.number().int().min(0).optional(),
  unit: z.string().trim().max(120).optional(),
  capability_scope_ids: z.array(stableIdSchema).optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const compensationProfileInputSchema = jsonObjectSchema.extend({
  id: stableIdSchema.optional(),
  name: z.string().trim().max(300).optional(),
  status: z.enum(["active", "archived"]).optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  effective_from: z.string().trim().max(80).optional(),
  effective_to: z.string().trim().max(80).optional(),
  components: z.array(compensationComponentSchema).optional(),
  notes: z.string().trim().max(4000).optional(),
  metadata: jsonObjectSchema.optional(),
  expected_revision: z.number().int().positive().optional(),

  // Transitional input aliases. They are normalized into components and are
  // never the canonical stored representation.
  type: z.string().trim().optional(),
  default_hourly: z.boolean().optional(),
  default_salary: z.boolean().optional(),
  default_piece_rate: z.boolean().optional(),
  hourly_rate_cents: z.number().int().min(0).optional(),
  salary_rate_cents: z.number().int().min(0).optional(),
  salary_period: z.string().trim().max(80).optional(),
  piece_rates: z.array(jsonObjectSchema).optional()
}).passthrough();

export type CompensationSubjectType = z.infer<typeof compensationSubjectTypeSchema>;
export type CompensationComponent = z.infer<typeof compensationComponentSchema>;
export type CompensationProfileInput = z.infer<typeof compensationProfileInputSchema>;
