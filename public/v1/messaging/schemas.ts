import { z } from "zod";

export const communicationChannelSchema = z.enum(["sms", "email", "webchat"]);
export const communicationDirectionSchema = z.enum(["outbound", "inbound"]);
export const communicationPurposeSchema = z.enum([
  "customer_care",
  "transactional",
  "appointment",
  "project_update",
  "billing",
  "marketing",
  "account_notification",
  "delivery_notification",
  "fraud_alert",
  "higher_education",
  "polling_voting",
  "public_service_announcement",
  "security_alert",
  "two_factor_auth",
  "internal"
]);

const smsConsentPurposeSchema = z.enum([
  "customer_care",
  "transactional",
  "appointment",
  "project_update",
  "billing",
  "marketing",
  "account_notification",
  "delivery_notification",
  "fraud_alert",
  "higher_education",
  "polling_voting",
  "public_service_announcement",
  "security_alert",
  "two_factor_auth"
]);

export const communicationRecipientSchema = z.object({
  address: z.string().trim().min(1).max(500),
  name: z.string().trim().max(300).optional(),
  type: z.enum(["to", "cc", "bcc"]).optional(),
  contact_id: z.string().trim().max(180).optional(),
  project_id: z.string().trim().max(180).optional(),
  consent_id: z.string().trim().max(180).optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const communicationContentSchema = z.object({
  subject: z.string().trim().max(998).optional(),
  text: z.string().max(100_000).optional(),
  html: z.string().max(500_000).optional(),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(255),
    content_type: z.string().trim().min(1).max(255),
    content: z.custom<Uint8Array | string>((value) => value instanceof Uint8Array || typeof value === "string")
  })).max(20).optional()
}).passthrough();

export const communicationSenderSchema = z.object({
  identity_id: z.string().trim().max(180).optional(),
  address: z.string().trim().max(500).optional(),
  name: z.string().trim().max(300).optional(),
  reply_to: z.string().trim().max(500).optional()
}).passthrough();

export const communicationContextSchema = z.object({
  project_id: z.string().trim().max(180).optional(),
  contact_id: z.string().trim().max(180).optional(),
  proposal_id: z.string().trim().max(180).optional(),
  payment_id: z.string().trim().max(180).optional(),
  event_id: z.string().trim().max(180).optional(),
  work_plan_id: z.string().trim().max(180).optional(),
  work_node_id: z.string().trim().max(180).optional()
}).passthrough();

export const communicationSourceSchema = z.object({
  type: z.enum(["user", "automation", "system", "api", "webhook"]).optional(),
  id: z.string().trim().max(240).optional(),
  user_id: z.string().trim().max(180).optional(),
  automation_id: z.string().trim().max(220).optional(),
  trigger_event_id: z.string().trim().max(220).optional()
}).passthrough();

export const createConversationSchema = z.object({
  id: z.string().trim().max(180).optional(),
  branch_id: z.string().trim().max(180).optional(),
  subject: z.string().trim().max(998).optional(),
  status: z.enum(["open", "closed", "archived"]).optional(),
  channel_strategy: z.enum(["sms", "email", "omnichannel"]).optional(),
  participants: z.array(communicationRecipientSchema).min(1).max(100),
  context: communicationContextSchema.optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const sendCommunicationSchema = z.object({
  id: z.string().trim().max(180).optional(),
  branch_id: z.string().trim().max(180).optional(),
  conversation_id: z.string().trim().max(180).optional(),
  channel: communicationChannelSchema,
  purpose: communicationPurposeSchema.optional(),
  recipients: z.array(communicationRecipientSchema).min(1).max(100),
  content: communicationContentSchema,
  sender: communicationSenderSchema.optional(),
  context: communicationContextSchema.optional(),
  source: communicationSourceSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  metadata: z.record(z.unknown()).optional(),
  idempotency_key: z.string().trim().min(1).max(500).optional(),
  scheduled_for: z.string().trim().optional()
}).passthrough().superRefine((value, ctx) => {
  const text = String(value.content.text || "").trim();
  const html = String(value.content.html || "").trim();
  const subject = String(value.content.subject || "").trim();
  if (value.channel === "sms") {
    if (!text) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content", "text"], message: "SMS text is required." });
    if (text.length > 1600) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content", "text"], message: "SMS text cannot exceed 1600 characters." });
  }
  if (value.channel === "email") {
    if (!subject) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content", "subject"], message: "Email subject is required." });
    if (!text && !html) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "Email text or HTML content is required." });
  }
  if (value.scheduled_for) {
    const timestamp = Date.parse(value.scheduled_for);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.scheduled_for) || !Number.isFinite(timestamp)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduled_for"], message: "scheduled_for must be an RFC 3339 timestamp with an explicit timezone." });
    } else if (timestamp <= Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduled_for"], message: "scheduled_for must be in the future." });
    } else if (timestamp > Date.now() + 366 * 24 * 60 * 60_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduled_for"], message: "scheduled_for cannot be more than one year in the future." });
    }
  }
});

export const smsConsentSchema = z.object({
  phone_number: z.string().trim().min(1).max(40),
  status: z.enum(["opted_in", "opted_out"]),
  consent_id: z.string().trim().min(1).max(180),
  contact_id: z.string().trim().max(180).optional(),
  source: z.enum(["web_form", "written", "verbal", "inbound_message", "imported_with_evidence", "manual_admin"]),
  disclosure_version: z.string().trim().min(1).max(120),
  purposes: z.array(smsConsentPurposeSchema).min(1).max(14),
  evidence: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0, "Consent evidence is required.")
}).strict();

export const simulateCommunicationStatusSchema = z.object({
  status: z.enum(["queued", "sent", "delivered", "failed", "bounced", "opened", "clicked"]),
  reason: z.string().trim().max(1000).optional(),
  delivery_id: z.string().trim().max(180).optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export const simulateInboundCommunicationSchema = z.object({
  channel: communicationChannelSchema,
  from: communicationRecipientSchema,
  to: communicationRecipientSchema,
  content: communicationContentSchema,
  conversation_id: z.string().trim().max(180).optional(),
  context: communicationContextSchema.optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export type CommunicationChannel = z.infer<typeof communicationChannelSchema>;
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type SendCommunicationInput = z.infer<typeof sendCommunicationSchema>;
