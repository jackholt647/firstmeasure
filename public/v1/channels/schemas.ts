import { z } from "zod";

const audienceGroup = z.enum(["office", "crew", "sales"]);
const richContentSchema = z.object({
  type: z.literal("doc").default("doc"),
  blocks: z.array(z.record(z.unknown())).max(500).default([])
}).passthrough();

export const mentionUserSchema = z.object({
  id: z.string().trim().min(1).optional(),
  user_id: z.string().trim().optional(),
  name: z.string().trim().optional(),
  email: z.string().trim().optional(),
  avatar: z.string().trim().optional()
}).passthrough();

export const createChannelSchema = z.object({
  new_conversation: z.boolean().default(false),
  type: z.enum(["public", "private", "dm", "group_dm"]).default("public"),
  name: z.string().trim().max(80).default(""),
  topic: z.string().trim().max(500).default(""),
  member_user_ids: z.array(z.string().trim().min(1)).default([])
});

export const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  topic: z.string().trim().max(500).optional(),
  settings: z.record(z.unknown()).optional()
});

export const addMembersSchema = z.object({
  user_ids: z.array(z.string().trim().min(1)).min(1)
});

export const memberPatchSchema = z.object({
  role: z.enum(["owner", "admin", "member"]).optional(),
  notify_level: z.enum(["all", "mentions", "muted"]).optional()
});

export const postMessageSchema = z.object({
  text: z.string().max(20_000).default(""),
  content: richContentSchema.optional(),
  content_schema_version: z.number().int().min(1).max(20).default(1),
  client_msg_id: z.string().trim().max(120).optional(),
  parent_id: z.string().trim().optional(),
  audience: z.array(audienceGroup).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).default([]),
  mention_users: z.array(mentionUserSchema).default([]),
  attachment_ids: z.array(z.string().trim().min(1)).default([]),
  metadata: z.record(z.unknown()).default({})
}).refine((input) => Boolean(input.text.trim() || input.attachment_ids.length), {
  message: "A message needs text or an attachment."
});

export const editMessageSchema = z.object({
  text: z.string().min(1).max(20_000),
  content: richContentSchema.optional(),
  content_schema_version: z.number().int().min(1).max(20).optional(),
  audience: z.array(audienceGroup).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).optional(),
  mention_users: z.array(mentionUserSchema).optional()
});

export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(32),
  on: z.boolean().default(true)
});

export const readStateSchema = z.object({
  last_read_seq: z.number().int().min(0)
});

export const unreadStateSchema = z.object({
  seq: z.number().int().positive()
});

export const attentionPatchSchema = z.object({
  read: z.boolean().optional(),
  cleared: z.boolean().optional(),
  snoozed_until: z.string().datetime().nullable().optional()
});

export const threadSubscriptionSchema = z.object({
  following: z.boolean().default(true),
  notify_level: z.enum(["all", "mentions", "muted"]).default("all")
});

export const collaborationPreferencesSchema = z.object({
  default_notify_level: z.enum(["all", "mentions", "muted"]).optional(),
  keywords: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  dnd: z.record(z.unknown()).optional(),
  send_mode: z.enum(["enter", "modified_enter"]).optional(),
  notification_previews: z.boolean().optional(),
  huddle_invites: z.boolean().optional()
}).passthrough();

export const draftSchema = z.object({
  channel_id: z.string().trim().min(1),
  root_message_id: z.string().trim().optional(),
  text: z.string().max(20_000).default(""),
  content: richContentSchema.optional(),
  attachment_ids: z.array(z.string().trim().min(1)).max(50).default([])
});

export const scheduledMessageSchema = draftSchema.extend({
  scheduled_at: z.string().datetime(),
  timezone: z.string().trim().max(80).default("UTC"),
  metadata: z.record(z.unknown()).default({}),
  client_operation_id: z.string().trim().max(120).optional()
}).refine((input) => Boolean(input.text.trim() || input.attachment_ids.length), {
  message: "A scheduled message needs text or an attachment."
});

export const scheduledMessagePatchSchema = z.object({
  text: z.string().max(20_000).optional(),
  content: richContentSchema.optional(),
  attachment_ids: z.array(z.string().trim().min(1)).max(50).optional(),
  scheduled_at: z.string().datetime().optional(),
  timezone: z.string().trim().max(80).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const messageReminderSchema = z.object({
  remind_at: z.string().datetime()
});

export const tabSchema = z.object({
  kind: z.enum(["messages", "files", "media", "documents", "todos", "pins", "links", "huddle_notes", "folder", "workflow"]),
  label: z.string().trim().min(1).max(80),
  config: z.record(z.unknown()).default({}),
  position: z.number().int().min(0).default(0),
  visibility: z.enum(["members", "managers"]).default("members")
});

export const folderSchema = z.object({
  parent_id: z.string().trim().optional(),
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  icon: z.string().trim().max(80).default("fa-folder"),
  color: z.string().trim().max(40).default(""),
  position: z.number().int().min(0).default(0)
});

export const resourceRefSchema = z.object({
  resource_type: z.enum(["media", "document", "action_item", "link", "project", "huddle"]),
  resource_id: z.string().trim().min(1),
  folder_id: z.string().trim().optional(),
  source_message_id: z.string().trim().optional(),
  relationship: z.enum(["attachment", "shared", "created_from", "huddle_output"]).default("shared"),
  display_note: z.string().trim().max(500).default(""),
  position: z.number().int().min(0).default(0)
});

export const sidebarSectionSchema = z.object({
  id: z.string().trim().optional(),
  label: z.string().trim().min(1).max(80),
  position: z.number().int().min(0).default(0),
  collapsed: z.boolean().default(false),
  channel_ids: z.array(z.string().trim().min(1)).max(500).default([])
});

export const createHuddleSchema = z.object({
  audio: z.boolean().default(true),
  video: z.boolean().default(false),
  recording_enabled: z.boolean().default(false),
  record_video: z.boolean().default(true)
});

export const huddleRecordingSchema = z.object({
  attachment_id: z.string().trim().min(1)
});

export const huddleMediaStateSchema = z.object({
  microphone_enabled: z.boolean().optional(),
  camera_enabled: z.boolean().optional(),
  screen_enabled: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "At least one media state is required.");

export const huddleSignalSchema = z.object({
  sender_peer_id: z.string().trim().min(1).max(200),
  target_peer_id: z.string().trim().max(200).optional(),
  kind: z.enum(["hello", "offer", "answer", "ice", "bye", "reaction"]),
  payload: z.record(z.unknown()).default({})
});

export const createActionItemFromMessageSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  body: z.string().trim().max(10_000).optional(),
  due_at: z.string().datetime().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  assigned_user_ids: z.array(z.string().trim().min(1)).max(50).default([]),
  client_operation_id: z.string().trim().max(120).optional()
});

export const listMessagesQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  channel_id: z.string().trim().optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});
