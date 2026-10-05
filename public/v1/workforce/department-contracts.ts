import {z} from 'zod';
const id=z.string().trim().min(1).max(120);
const ids=z.array(id).max(200);
export const departmentSchema=z.object({id,label:z.string().trim().min(1).max(100),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),group_id:z.string().max(120).default(''),subject_keys:ids.default([]),role_ids:ids.default([]),group_kind_ids:ids.default([])}).strict();
export const groupSchema=z.object({id:z.string().min(1).max(120),label:z.string().min(1).max(100)}).strict();
export const departmentCatalogSchema=z.object({departments:z.array(departmentSchema).max(200),groups:z.array(groupSchema).max(100)}).strict();
export const departmentSaveSchema=departmentCatalogSchema.extend({revision:z.number().int().nonnegative(),legacy_token:z.string().optional()}).strict();
export const departmentAssignmentSchema=z.object({kind:z.enum(['user','role','group','group_kind']),id:z.string().min(1).max(180),department_ids:z.array(z.string().min(1).max(120)).max(200),revision:z.number().int().nonnegative(),legacy_token:z.string().optional()}).strict();
