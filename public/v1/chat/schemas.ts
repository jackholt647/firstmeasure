import { z } from "zod";

/**
 * Live chat schemas. Settings are stored as the `live_chat` branch module and
 * are normalized through defaultChatSettings()/normalizeChatSettings() so the
 * frontend can always rely on a fully-populated shape.
 */

const hoursWindowSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/)
}).passthrough();

const routeSchema = z.object({
  kind: z.enum(["all", "roles", "users"]).default("all"),
  role_ids: z.array(z.string().trim().min(1).max(180)).max(50).optional(),
  user_ids: z.array(z.string().trim().min(1).max(180)).max(100).optional()
}).passthrough();

export const chatSettingsSchema = z.object({
  schema_version: z.number().optional(),
  enabled: z.boolean().optional(),
  website: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  portal: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  appearance: z.object({
    primary_color: z.string().trim().max(32).optional(),
    background_color: z.string().trim().max(32).optional(),
    text_color: z.string().trim().max(32).optional(),
    font_family: z.string().trim().max(80).optional(),
    position: z.enum(["bottom_right", "bottom_left"]).optional(),
    launcher_label: z.string().trim().max(60).optional(),
    show_branding: z.boolean().optional()
  }).passthrough().optional(),
  copy: z.object({
    greeting: z.string().trim().max(500).optional(),
    offline_message: z.string().trim().max(500).optional(),
    team_display: z.enum(["first_name", "team_name"]).optional(),
    team_name: z.string().trim().max(80).optional()
  }).passthrough().optional(),
  pre_chat: z.object({
    require_name: z.boolean().optional(),
    require_email: z.boolean().optional(),
    require_phone: z.boolean().optional()
  }).passthrough().optional(),
  live_hours: z.object({
    timezone: z.string().trim().max(80).optional(),
    days: z.record(z.array(hoursWindowSchema).max(6)).optional()
  }).passthrough().optional(),
  presence: z.object({
    require_agent_presence: z.boolean().optional(),
    force_status: z.enum(["auto", "online", "offline"]).optional()
  }).passthrough().optional(),
  mode: z.enum(["human", "ai", "ai_when_offline", "ai_first_then_human"]).optional(),
  claiming: z.object({
    mode: z.enum(["presence", "claim"]).optional(),
    auto_claim_on_reply: z.boolean().optional(),
    allow_takeover: z.boolean().optional(),
    idle_release_minutes: z.number().min(1).max(480).optional(),
    release_on_disconnect: z.boolean().optional()
  }).passthrough().optional(),
  notifications: z.object({
    route: routeSchema.optional(),
    debounce_seconds: z.number().min(0).max(3600).optional(),
    escalate_after_seconds: z.number().min(0).max(3600).optional(),
    escalation_route: routeSchema.optional()
  }).passthrough().optional(),
  visitor_history: z.object({ visible_to_visitor: z.boolean().optional() }).passthrough().optional(),
  transcripts: z.object({ offer_email_on_close: z.boolean().optional() }).passthrough().optional(),
  voice: z.object({
    mode: z.enum(["attachment", "dictation", "off"]).optional(),
    max_seconds: z.number().min(5).max(300).optional()
  }).passthrough().optional(),
  ai: z.object({
    enabled: z.boolean().optional(),
    disclose: z.boolean().optional(),
    tone: z.object({
      preset: z.enum(["friendly", "professional", "concise", "custom"]).optional(),
      custom: z.string().trim().max(2000).optional()
    }).passthrough().optional(),
    instructions: z.string().trim().max(8000).optional(),
    knowledge: z.string().trim().max(24000).optional(),
    tools: z.object({
      capture_contact: z.boolean().optional(),
      create_lead: z.boolean().optional(),
      get_business_info: z.boolean().optional(),
      lookup_customer: z.boolean().optional()
    }).passthrough().optional(),
    suggestions: z.object({
      enabled: z.boolean().optional(),
      auto: z.boolean().optional(),
      auto_after_seconds: z.number().min(5).max(600).optional(),
      allow_one_click_send: z.boolean().optional()
    }).passthrough().optional()
  }).passthrough().optional()
}).passthrough();

export type ChatSettingsInput = z.infer<typeof chatSettingsSchema>;

const pageContextSchema = z.object({
  kind: z.enum(["website", "customer_portal"]).optional(),
  title: z.string().trim().max(200).optional(),
  url: z.string().trim().max(2000).optional(),
  tab_id: z.string().trim().max(100).optional(),
  tab_label: z.string().trim().max(200).optional(),
  project_id: z.string().trim().max(200).optional(),
  project_title: z.string().trim().max(300).optional(),
  captured_at: z.string().trim().max(50).optional(),
  viewport: z.object({
    width: z.number().int().min(0).max(10000).optional(),
    height: z.number().int().min(0).max(10000).optional()
  }).optional(),
  snapshot: z.object({
    media_id: z.string().trim().max(200),
    public_url: z.string().trim().max(3000),
    content_type: z.enum(["image/jpeg", "image/png"]),
    width: z.number().int().min(1).max(5000).optional(),
    height: z.number().int().min(1).max(5000).optional()
  }).strict().optional(),
  visible_text: z.array(z.string().trim().max(240)).max(12).optional()
}).strict();

export const publicSessionSchema = z.object({
  visitor_token: z.string().trim().max(200).optional(),
  page_url: z.string().trim().max(2000).optional(),
  portal_grant: z.string().trim().max(2000).optional()
}).passthrough();

export const publicStartConversationSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  page_url: z.string().trim().max(2000).optional(),
  page_context: pageContextSchema.optional(),
  idempotency_key: z.string().trim().max(200).optional()
}).passthrough();

export const publicSendMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  page_url: z.string().trim().max(2000).optional(),
  page_context: pageContextSchema.optional(),
  idempotency_key: z.string().trim().max(200).optional()
}).passthrough();

export const publicOfflineDetailsSchema = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(40).optional()
}).passthrough();

export const teamSendMessageSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  internal_note: z.boolean().optional(),
  suggestion_id: z.string().trim().max(200).optional(),
  suggestion_edited: z.boolean().optional(),
  idempotency_key: z.string().trim().max(200).optional()
}).passthrough();

export const teamLinkSchema = z.object({
  contact_id: z.string().trim().max(180).optional(),
  project_id: z.string().trim().max(180).optional()
}).passthrough();

export const teamPresenceSchema = z.object({
  conversation_id: z.string().trim().max(180).optional()
}).passthrough();

export const suggestSchema = z.object({
  hint: z.string().trim().max(1000).optional()
}).passthrough();

export const polishSchema = z.object({
  text: z.string().trim().min(1).max(8000)
}).passthrough();
