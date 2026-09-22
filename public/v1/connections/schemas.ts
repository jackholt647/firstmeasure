import { z } from "zod";

import { compensationProfileInputSchema } from "../compensation/schemas.js";
import { jsonObjectSchema, stableIdSchema } from "../workforce/schemas.js";

const contactSchema = jsonObjectSchema.extend({
  id: stableIdSchema.optional(),
  name: z.string().trim().max(300).optional(),
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().max(80).optional(),
  role: z.string().trim().max(180).optional(),
  primary: z.boolean().optional()
}).passthrough();

export const organizationConnectionCreateSchema = jsonObjectSchema.extend({
  id: stableIdSchema.optional(),
  name: z.string().trim().min(1).max(300),
  legal_name: z.string().trim().max(300).optional(),
  status: z.enum(["active", "inactive", "archived"]).optional(),
  relationship_type_ids: z.array(stableIdSchema).optional(),
  contacts: z.array(contactSchema).optional(),
  address: jsonObjectSchema.optional(),
  payment_metadata: jsonObjectSchema.optional(),
  payment_terms: jsonObjectSchema.extend({
    basis: z.enum(["payroll_schedule", "net_days"]).optional(),
    net_days: z.number().int().min(0).max(365).optional()
  }).optional(),
  branch_ids: z.array(stableIdSchema).optional(),
  capability_scope_ids: z.array(stableIdSchema).optional(),
  project_types: z.array(stableIdSchema).optional(),
  linked_organization_id: stableIdSchema.nullable().optional(),
  link_status: z.enum(["unlinked", "pending", "linked"]).optional(),
  compensation_profile: compensationProfileInputSchema.optional(),
  compensation_plan: compensationProfileInputSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const organizationConnectionPatchSchema = organizationConnectionCreateSchema.partial().extend({
  expected_revision: z.number().int().positive()
}).passthrough();
