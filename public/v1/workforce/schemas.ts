import { z } from "zod";

import { compensationProfileInputSchema } from "../compensation/schemas.js";

export const jsonObjectSchema = z.object({}).passthrough();
export const stableIdSchema = z.string().trim().min(1).max(180);

const terminologyPairSchema = z.object({
  singular: z.string().trim().min(1).max(120).optional(),
  plural: z.string().trim().min(1).max(120).optional()
}).passthrough();

export const workforceTerminologySchema = z.object({
  resource_group: terminologyPairSchema.optional(),
  resource_group_member: terminologyPairSchema.optional(),
  organization_connection: terminologyPairSchema.optional(),
  applications: z.object({
    management: z.string().trim().min(1).max(120).optional(),
    field: z.string().trim().min(1).max(120).optional()
  }).passthrough().optional()
}).passthrough();

export const workforceConfigurationInputSchema = jsonObjectSchema.extend({
  terminology: workforceTerminologySchema.optional(),
  resource_group_kinds: z.array(jsonObjectSchema.extend({
    id: stableIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    status: z.enum(["active", "archived"]).optional()
  })).optional(),
  assignment_tags: z.array(jsonObjectSchema.extend({
    id: stableIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    status: z.enum(["active", "archived"]).optional()
  })).optional(),
  expected_revision: z.number().int().positive()
}).passthrough();

export const resourceGroupMemberSchema = jsonObjectSchema.extend({
  user_id: stableIdSchema,
  role: z.string().trim().min(1).max(180).optional(),
  is_lead: z.boolean().optional(),
  status: z.enum(["active", "inactive"]).optional()
}).passthrough();

export const resourceGroupCreateSchema = jsonObjectSchema.extend({
  id: stableIdSchema.optional(),
  name: z.string().trim().min(1).max(300),
  kind_id: stableIdSchema.optional(),
  assignment_tag_ids: z.array(stableIdSchema).optional(),
  branch_id: stableIdSchema.optional(),
  status: z.enum(["active", "archived"]).optional(),
  primary_member_user_id: stableIdSchema.nullable().optional(),
  members: z.array(resourceGroupMemberSchema).optional(),
  member_user_ids: z.array(stableIdSchema).optional(),
  capability_scope_ids: z.array(stableIdSchema).optional(),
  project_types: z.array(stableIdSchema).optional(),
  compensation_profile: compensationProfileInputSchema.optional(),
  compensation_plan: compensationProfileInputSchema.optional(),
  attributes: jsonObjectSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const resourceGroupPatchSchema = resourceGroupCreateSchema.partial().extend({
  expected_revision: z.number().int().positive()
}).passthrough();

export const resourceGroupMemberMutationSchema = resourceGroupMemberSchema.partial().extend({
  expected_revision: z.number().int().positive()
}).passthrough();

const applicationAccessEntrySchema = jsonObjectSchema.extend({
  enabled: z.boolean(),
  role_id: z.string().trim().min(1).max(180).optional(),
  permissions: jsonObjectSchema.optional()
}).passthrough();

export const workforceUserProfilePatchSchema = jsonObjectSchema.extend({
  expected_revision: z.number().int().positive().optional(),
  application_access: z.record(applicationAccessEntrySchema).optional(),
  access_role_ids: z.array(stableIdSchema).optional(),
  permission_overrides: z.record(z.boolean()).optional(),
  app_access_overrides: z.record(z.union([
    z.enum(["inherit", "show", "hide"]),
    z.boolean(),
    z.null()
  ])).optional(),
  assignment_tag_ids: z.array(stableIdSchema).optional(),
  worker_classification: z.enum(["employee", "independent_contractor"]).optional(),
  payment_terms: jsonObjectSchema.extend({
    basis: z.enum(["payroll_schedule", "net_days"]).optional(),
    net_days: z.number().int().min(0).max(365).optional()
  }).optional(),
  compensation_profile: compensationProfileInputSchema.optional()
}).refine((value) => (
  Object.prototype.hasOwnProperty.call(value, "application_access")
  || Object.prototype.hasOwnProperty.call(value, "access_role_ids")
  || Object.prototype.hasOwnProperty.call(value, "permission_overrides")
  || Object.prototype.hasOwnProperty.call(value, "app_access_overrides")
  || Object.prototype.hasOwnProperty.call(value, "assignment_tag_ids")
  || Object.prototype.hasOwnProperty.call(value, "worker_classification")
  || Object.prototype.hasOwnProperty.call(value, "payment_terms")
  || Object.prototype.hasOwnProperty.call(value, "compensation_profile")
), { message: "At least one workforce profile field is required." });
