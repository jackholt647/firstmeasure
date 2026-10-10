import { z } from 'zod';

export const key=z.string().trim().min(1).max(180);
export const phone=z.string().regex(/^\+[1-9]\d{7,14}$/);
export const zone=z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Choose a valid time zone.');
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleSchema=z.object({
  timezone:zone.default('America/Los_Angeles'),
  business_hours:z.array(z.object({day:z.number().int().min(0).max(6),open:time,close:z.union([time,z.literal('24:00')])}).refine(v=>v.close>v.open,'Split overnight hours across two days.')).max(28).default([1,2,3,4,5].map(day=>({day,open:'08:00',close:'17:00'}))),
  holidays:z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366).default([])
});
export const targetSchema=z.object({kind:z.enum(['ring','user','group','forward','voicemail','announcement','menu']).default('ring'),id:z.string().max(180).default(''),number:z.union([phone,z.literal('')]).default(''),message:z.string().max(1500).default('')});
export const routingSchema=z.object({
  schedule:scheduleSchema.nullable().default(null),
  strategy:z.enum(['longest_idle','sequential','simultaneous','round_robin']).default('longest_idle'),
  ring_seconds:z.number().int().min(10).max(60).default(25),max_wait_seconds:z.number().int().min(10).max(600).default(60),
  max_queue:z.number().int().min(1).max(100).default(20),
  open:targetSchema.default({kind:'ring'}),closed:targetSchema.default({kind:'voicemail'}),unanswered:targetSchema.default({kind:'voicemail'}),
  greeting:z.string().max(1500).default('Thank you for calling. Please hold while we connect you.'),
  voicemail_greeting:z.string().min(1).max(1500).default('We are unavailable. Please leave your name, number, and a message after the tone.'),
  closed_greeting:z.string().max(1500).default(''),
  voicemail_media_id:z.string().max(180).default(''),closed_media_id:z.string().max(180).default(''),
  menu:z.array(z.object({digit:z.string().regex(/^[0-9*#]$/),label:z.string().min(1).max(100),target:targetSchema.refine(t=>t.kind!=='menu','Nested menus use a separate group.')})).max(12).default([])
}).refine(v=>new Set(v.menu.map(i=>i.digit)).size===v.menu.length,'Menu keys must be unique.');
export const messagingPolicySchema=z.object({
  enabled:z.boolean().default(false),schedule:scheduleSchema.default({}),
  timezone_mode:z.enum(['schedule','contact']).default('schedule'),unknown_timezone:z.enum(['hold','fallback']).default('hold'),
  apply_manual:z.boolean().default(false),expiry_hours:z.number().int().min(1).max(720).default(72),
  cancel_on_reply:z.boolean().default(true),auto_reply_open:z.string().max(1500).default(''),auto_reply_closed:z.string().max(1500).default(''),
  missed_call_reply:z.string().max(1500).default(''),cooldown_minutes:z.number().int().min(30).max(10080).default(180)
});
export const trackingSchema=z.object({enabled:z.boolean().default(false),source:z.string().trim().max(160).default(''),medium:z.string().trim().max(100).default(''),campaign:z.string().trim().max(160).default(''),ad_id:z.string().trim().max(160).default(''),landing_page:z.string().max(1000).default('')}).refine(v=>!v.enabled||!!v.source,'Enter the advertising source.');
export const lineSchema=z.object({label:z.string().trim().min(1).max(100),user_ids:z.array(key).max(100).default([]),group_id:z.string().max(180).default(''),department_ids:z.array(key).max(100).default([]),routing:routingSchema.nullable().default(null),messaging:messagingPolicySchema.nullable().default(null),tracking:trackingSchema.default({}),revision:z.number().int().nonnegative()});
export const groupSchema=z.object({label:z.string().trim().min(1).max(100),department_ids:z.array(key).max(100).default([]),user_ids:z.array(key).min(1).max(100),routing:routingSchema,revision:z.number().int().nonnegative()});
export const personalSchema=z.object({schedule:scheduleSchema.nullable().default(null),voicemail_greeting:z.string().max(1500).default(''),voicemail_media_id:z.string().max(180).default(''),available:z.boolean().default(true),notifications:z.object({missed_calls:z.boolean().default(true),voicemail:z.boolean().default(true),texts:z.boolean().default(true),push:z.boolean().default(true)}).default({}),revision:z.number().int().nonnegative()});
export type Routing=z.infer<typeof routingSchema>;
export type Target=z.infer<typeof targetSchema>;
export type Schedule=z.infer<typeof scheduleSchema>;
export type MessagingPolicy=z.infer<typeof messagingPolicySchema>;
