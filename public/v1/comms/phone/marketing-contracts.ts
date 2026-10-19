import {z} from 'zod';
import {phone,scheduleSchema} from './contracts.js';
const key=z.string().trim().regex(/^[a-zA-Z0-9_-]{1,180}$/),label=z.string().trim().min(1).max(160),ref=z.string().trim().max(180).default(''),revision=z.number().int().nonnegative();
export const sourceSchema=z.object({label,enabled:z.boolean().default(true),external_ref:ref,revision:z.number().int().nonnegative()}).strict();
export const poolSchema=z.object({label,enabled:z.boolean().default(false),numbers:z.array(phone).min(1).max(200),fallback_number:phone,
 origins:z.array(z.string().url().refine(v=>{try{const u=new URL(v);return u.protocol==='https:'&&u.origin===v;}catch{return false;}},'Use an exact HTTPS origin, without a path.')).min(1).max(20),
 lease_minutes:z.number().int().min(5).max(120).default(30),reuse_hours:z.number().int().min(1).max(168).default(24),retention_days:z.number().int().min(8).max(90).default(30),
 lead_source_id:ref,marketing_campaign_id:ref,
 rules:z.array(z.object({utm_source:z.string().max(160).default(''),utm_campaign:z.string().max(160).default(''),referrer_host:z.string().max(255).default(''),lead_source_id:key,marketing_campaign_id:ref}).strict().refine(v=>!!(v.utm_source||v.utm_campaign||v.referrer_host),'Add a source, campaign or referrer match.')).max(100).default([]),
 revision:z.number().int().nonnegative()}).strict();

export const broadcastSchema=z.object({label:z.string().trim().min(1).max(160),sender_identity_id:key,template:z.string().trim().min(1).max(1600),
 schedule:scheduleSchema.default({}),timezone_mode:z.enum(['schedule','contact']).default('contact'),unknown_timezone:z.enum(['hold','fallback']).default('hold'),
 scheduled_for:z.union([z.string().datetime(),z.literal('')]).default(''),expiry_hours:z.number().int().min(1).max(720).default(72),stop_on_reply:z.boolean().default(true),
 messages_per_second:z.number().min(0.01).max(10).default(1),lead_source_id:z.string().max(180).default(''),marketing_campaign_id:z.string().max(180).default(''),revision
}).strict();
export const audienceSchema=z.object({contacts:z.array(z.object({project_id:key,contact_id:key}).strict()).min(1).max(500),revision}).strict();
export const broadcastCommandSchema=z.object({action:z.enum(['start','pause','resume','cancel']),revision,confirmed:z.literal(true)}).strict();
