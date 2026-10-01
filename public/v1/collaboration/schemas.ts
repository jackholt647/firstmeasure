import { z } from "zod";

export const idSchema = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,180}$/);
export const resourceSchema = z.object({
  owner_org_id: idSchema,
  type: z.enum(["project", "contact", "channel", "document", "media", "invoice"]),
  id: idSchema,
  project_id: idSchema.optional()
}).strict();
export type ResourceRef = z.infer<typeof resourceSchema>;
export const OPERATIONS = ["read", "details.update", "photos.read", "photos.upload", "notes.read", "notes.create", "work.read", "work.update", "schedule.read", "schedule.update", "documents.read", "documents.respond", "messages.read", "messages.post", "invoice.read", "invoice.pay"] as const;
export const policySchema = z.object({
  enabled: z.boolean().default(true),
  accept_connections: z.boolean().default(true),
  receive_shares: z.boolean().default(true),
  send_shares: z.boolean().default(true),
  disclose_name: z.boolean().default(true),
  disclose_email: z.boolean().default(true),
  disclose_phone: z.boolean().default(false),
  allow_exports: z.boolean().default(false),
  allowed_types: z.array(resourceSchema.shape.type).max(6).default(["project", "contact", "channel", "document", "media", "invoice"])
}).strict();
export const audienceSchema = z.object({
  mode: z.enum(["managers", "members", "selected"]).default("managers"),
  user_ids: z.array(idSchema).max(250).default([])
}).strict().refine(a => a.mode !== "selected" || a.user_ids.length > 0, "Select at least one participant.");
export const grantSchema = z.object({
  resource: resourceSchema,
  recipient_org_id: idSchema,
  recipient_identity_id: idSchema.optional(),
  audience: audienceSchema.default({mode:"managers",user_ids:[]}),
  operations: z.array(z.enum(OPERATIONS)).min(1).max(OPERATIONS.length),
  denied_operations: z.array(z.enum(OPERATIONS)).max(OPERATIONS.length).default([]),
  fields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).max(100).default(["title", "address"]),
  child_ids: z.array(idSchema).max(500).default([]),
  response_fields: z.array(idSchema).max(100).default([]),
  include_future: z.boolean().default(false),
  expires_at: z.string().datetime().optional()
}).strict();
export type GrantInput = z.infer<typeof grantSchema>;
export const invitationSchema = z.object({
  kind: z.enum(["connection", "share"]).default("connection"),
  recipient_kind: z.enum(["organization","individual"]).default("organization"),
  email: z.string().trim().email().max(254).transform(v=>v.toLowerCase()).optional(),
  label: z.string().trim().max(160).default(""),
  relationship: z.enum(["contact", "partner", "client"]).default("contact"),
  expires_in_days: z.number().int().min(1).max(30).default(7),
  grant: grantSchema.omit({recipient_org_id:true,recipient_identity_id:true}).optional()
}).strict().refine(v=>v.kind !== "share" || !!v.grant, "Choose a resource to share.")
  .refine(v=>v.recipient_kind!=="individual"||v.kind==="share"&&!!v.email,"Individual shares require a resource and a verified recipient email.");
export const revisionSchema = z.object({expected_revision:z.number().int().positive()}).strict();
export const relationshipSchema = z.object({
  expected_revision:z.number().int().positive(),
  classification:z.enum(["contact","partner","client"]),
  note:z.string().max(20000).default(""),
  payment_terms:z.string().max(2000).default("")
}).strict();
export const pageSchema = z.object({after:idSchema.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)});
