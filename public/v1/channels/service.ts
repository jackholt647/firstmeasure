import type { PlatformAuthContext } from "../platform/auth.js";
import { hasPermission } from "../platform/auth.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { publishRealtimeEvent } from "../platform/realtime.js";
// Circular with ./agent.js by design (it posts back through this service);
// safe because both sides only reference each other inside function bodies.
import { maybeTriggerChannelAgent } from "./agent.js";
import { listDocuments, readDocument } from "../platform/storage.js";
import { registerWorkEvents } from "../work/events.js";
import { env } from "../src/config/env.js";
import * as calls from "../calls/service.js";
import {
  attachToMessage,
  createChannelRecord,
  createMessageRecord,
  dmKeyForMembers,
  editMessageRecord,
  findChannelByDmKey,
  findChannelByProject,
  findMessageByClientId,
  getChannelsDatabase,
  listAttachmentsForMessages,
  listChannelMembers,
  listChannelRecords,
  listMembershipChannelIds,
  listMentionRowsForUser,
  listMessageRecords,
  listMessageRevisions,
  listMessageTranslations,
  listPinnedMessages,
  listReactionsForMessages,
  listReactionsToUser,
  listRepliesToUser,
  listSavedMessageIds,
  listSavedMessages,
  readChannelMember,
  readChannelRecord,
  readChannelsMeta,
  readAttachmentRecord,
  writeChannelsMeta,
  readMessageRecord,
  readMessageBySequence,
  readMessageTranslation,
  removeChannelMember,
  restoreMessageRecord,
  searchMessageRecords,
  setMessagePinned,
  setMessageLanguage,
  saveMessageTranslation,
  setSavedItem,
  softDeleteMessageRecord,
  toggleReactionRecord,
  unreadSummary,
  updateChannelRecord,
  upsertChannelMember,
  upsertReadState,
  type ChannelRow,
  type JsonObject,
  type MessageRow,
  type MessageTranslationRow
} from "./storage.js";
import {
  detectMessageLanguage,
  normalizeLanguage,
  translateMessageText,
  translationSourceHash
} from "./translation.js";
import * as collaboration from "./collaboration.js";

registerWorkEvents([
  { name: "channels.channel.created", description: "A team messaging channel was created.", visibility: "system" },
  { name: "channels.channel.archived", description: "A team messaging channel was archived.", visibility: "system" },
  { name: "channels.message.posted", description: "A message was posted in a team channel or project thread.", visibility: "system" },
  { name: "channels.message.edited", description: "A team channel message was edited.", visibility: "system" },
  { name: "channels.message.deleted", description: "A team channel message was removed.", visibility: "system" },
  { name: "channels.message.restored", description: "A removed team channel message was restored.", visibility: "system" }
]);

const AUDIENCE_GROUPS = ["office", "crew", "sales"] as const;
const GENERAL_CHANNEL_NAME = "general";
const TYPING_TTL_MS = 6_000;

const typingState = new Map<string, Map<string, Map<string, number>>>();
const translationRuns = new Map<string, Promise<JsonObject>>();

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function nowIso() {
  return new Date().toISOString();
}

function viewerTranslationPreferences(ctx: PlatformAuthContext): { language: string; auto_translate_messages: boolean } {
  const preferences = asObject(ctx.identity.preferences);
  return {
    language: normalizeLanguage(preferences.language, "en"),
    auto_translate_messages: preferences.auto_translate_messages === true
  };
}

async function emitChannelsEvent(type: string, ctx: PlatformAuthContext, payload: JsonObject, projectId?: string | null) {
  try {
    const { emitWorkEvent } = await import("../work/engine.js");
    await emitWorkEvent({
      organization_id: ctx.orgId,
      branch_id: ctx.branchId || "default",
      project_id: projectId || undefined,
      type,
      payload,
      context: { actor_user_id: ctx.userId },
      idempotency_key: `${type}:${cleanText(payload.message_id || payload.channel_id)}:${cleanText(payload.at) || nowIso()}`
    });
  } catch {
    /* the work engine is best-effort from messaging's perspective */
  }
}

// --- viewer audience groups ---------------------------------------------------
// Mirrors the retired frontend Portal.ProjectNotes.currentGroups() so per-message
// audience filtering keeps today's semantics but is enforced server-side.

export function viewerAudienceGroups(ctx: PlatformAuthContext): string[] {
  if (["owner", "admin", "super_admin"].includes(ctx.role)) return [...AUDIENCE_GROUPS];
  const roleTokens = [
    ctx.role,
    ...(ctx.accessProfile?.access_role_ids ?? []),
    ...Object.keys(asObject(ctx.user.roles))
  ].map((token) => cleanText(token).toLowerCase()).join(" ");
  const groups = new Set<string>();
  if (/sales|estim|business.develop|account.executive/.test(roleTokens)) groups.add("sales");
  if (/crew|field|installer|technician|foreman|production|repair/.test(roleTokens) || ctx.applicationAccess.field?.enabled === true) groups.add("crew");
  if (/office|admin|manager|owner|dispatch|coordinator/.test(roleTokens) || (!groups.size && ctx.applicationAccess.management?.enabled === true)) groups.add("office");
  if (!groups.size) groups.add("office");
  return [...groups];
}

function messageVisibleTo(message: MessageRow, ctx: PlatformAuthContext, groups: string[]) {
  if (!message.audience.length) return true;
  if (message.author_id === ctx.userId) return true;
  const mentioned = message.mention_users.some((user) => cleanText(user.id || user.user_id) === ctx.userId);
  if (mentioned) return true;
  return message.audience.some((group) => groups.includes(group));
}

// --- user directory -----------------------------------------------------------

type UserProfile = { id: string; name: string; email: string; avatar: string };

const directoryCache = new Map<string, { at: number; users: Map<string, UserProfile> }>();
const DIRECTORY_TTL_MS = 30_000;

export async function userDirectory(orgId: string): Promise<Map<string, UserProfile>> {
  const cached = directoryCache.get(orgId);
  if (cached && Date.now() - cached.at < DIRECTORY_TTL_MS) return cached.users;
  const users = new Map<string, UserProfile>();
  try {
    const documents = await listDocuments(orgId, "users");
    for (const document of documents) {
      const data = asObject(document.data);
      users.set(document.id, {
        id: document.id,
        name: cleanText(data.name || data.display_name || data.full_name || data.email) || "Unknown",
        email: cleanText(data.email).toLowerCase(),
        avatar: cleanText(data.avatar || data.avatar_url || data.photo_url || data.profile_photo_url)
      });
    }
  } catch {
    /* organization may not exist yet in tests */
  }
  // AI agents participate as pseudo-users: merging their profiles here makes
  // authorship, DM titles, and member lists resolve everywhere. Disabled
  // agents still resolve (for historical messages) but drop out of pickers.
  try {
    const { agentChannelParticipants } = await import("../agents/participants.js");
    for (const participant of await agentChannelParticipants(orgId, "default", { includeDisabled: true })) {
      users.set(participant.id, { id: participant.id, name: participant.name, email: "", avatar: "" });
    }
  } catch {
    /* agent participation is best-effort */
  }
  directoryCache.set(orgId, { at: Date.now(), users });
  return users;
}

export function invalidateUserDirectory(orgId: string) {
  directoryCache.delete(orgId);
}

export async function listDirectoryUsers(ctx: PlatformAuthContext) {
  const documents = await listDocuments(ctx.orgId, "users");
  const users = documents
    .map((document) => {
      const data = asObject(document.data);
      const status = cleanText(data.status).toLowerCase();
      return {
        id: document.id,
        name: cleanText(data.name || data.display_name || data.full_name || data.email) || "Unknown",
        email: cleanText(data.email).toLowerCase(),
        avatar: cleanText(data.avatar || data.avatar_url || data.photo_url || data.profile_photo_url),
        title: cleanText(data.job_title || data.title),
        pronouns: cleanText(data.pronouns),
        department: cleanText(data.department),
        location: cleanText(data.location),
        phone: cleanText(data.work_phone || data.phone),
        time_zone: cleanText(data.time_zone || data.timezone),
        bio: cleanText(data.bio),
        disabled: data.disabled === true || status === "disabled"
      };
    })
    .filter((user) => user.id && !user.disabled);

  try {
    const { agentChannelParticipants } = await import("../agents/participants.js");
    for (const participant of await agentChannelParticipants(ctx.orgId, "default")) {
      if (!users.some((user) => user.id === participant.id)) {
        users.push({ id: participant.id, name: participant.name, email: "", avatar: "", title:"", pronouns:"", department:"", location:"", phone:"", time_zone:"", bio:"", disabled: false });
      }
    }
  } catch {
    /* agent participation is best-effort */
  }

  return users;
}

// --- channel access -----------------------------------------------------------

function isPrivateType(channel: ChannelRow) {
  return channel.type === "private" || channel.type === "dm" || channel.type === "group_dm";
}

// Field users see project messages through the crew app (per-message audience
// still applies), so project-channel access is permission OR field-app based.
function canAccessProjectChannels(ctx: PlatformAuthContext) {
  return hasPermission(ctx, "view_projects|manage_company_settings") || ctx.applicationAccess.field?.enabled === true;
}

export function canManageChannels(ctx: PlatformAuthContext) {
  return hasPermission(ctx, "manage_channels");
}

export async function requireChannelAccess(ctx: PlatformAuthContext, channelId: string, options: { write?: boolean } = {}) {
  const channel = (await readChannelRecord(ctx.orgId, channelId));
  if (!channel) throw notFound("channel_not_found", "This channel does not exist.");
  const membership = (await readChannelMember(channel.id, ctx.userId));
  if (isPrivateType(channel)) {
    // DMs and private channels are member-only. Deliberately no owner/admin
    // bypass on reads: administrators must add themselves (a visible action).
    if (!membership) throw forbidden("channel_forbidden", "You are not a member of this channel.");
  } else if (channel.type === "project") {
    if (!canAccessProjectChannels(ctx)) {
      throw forbidden("channel_forbidden", "You do not have access to project messages.");
    }
  }
  if (options.write && channel.archived_at) {
    throw badRequest("channel_archived", "This channel is archived.");
  }
  return { channel, membership };
}

async function channelAdminAllowed(ctx: PlatformAuthContext, channel: ChannelRow) {
  if (canManageChannels(ctx)) return true;
  const membership = (await readChannelMember(channel.id, ctx.userId));
  return membership?.role === "owner" || membership?.role === "admin";
}

// --- personal message inbox -----------------------------------------------
// The topbar Messages dropdown: only things that should directly notify the
// user — mentions, DMs, replies to their messages, reactions to their
// messages — plus channels they explicitly subscribed to (notify_level
// 'all'; the default is mention-driven only).

const INBOX_WINDOW_MS = 14 * 24 * 3_600_000;

function inboxSeenKey(orgId: string, userId: string) {
  return `inbox_seen:${orgId}:${userId}`;
}

export async function personalInbox(ctx: PlatformAuthContext, options: { limit?: number } = {}) {
  const limit = Math.min(80, Math.max(10, Number(options.limit || 40)));
  const seenAt = (await readChannelsMeta(inboxSeenKey(ctx.orgId, ctx.userId)));
  const windowStart = new Date(Date.now() - INBOX_WINDOW_MS).toISOString();
  const directory = await userDirectory(ctx.orgId);
  const views = await listChannelsForUser(ctx);
  const channelById = new Map(views.map((view) => [String(view.id), view] as const));
  const authorName = (id: string) => directory.get(cleanText(id))?.name || "Someone";
  const snippet = (text: unknown) => cleanText(text).replace(/\s+/g, " ").slice(0, 120);
  const entries: JsonObject[] = [];

  const pushEntry = (entry: JsonObject) => {
    const channel = channelById.get(cleanText(entry.channel_id));
    if (!channel) return; // not visible to this user
    entries.push({
      ...entry,
      channel_type: channel.type,
      channel_name: channel.type === "dm" || channel.type === "group_dm"
        ? cleanText(channel.display_name)
        : channel.type === "project"
          ? "Project notes"
          : `#${cleanText(channel.name) || "untitled"}`,
      project_id: channel.project_id || null
    });
  };

  // Unread mentions (rows clear when the channel is read).
  for (const row of (await listMentionRowsForUser(ctx.orgId, ctx.userId, limit))) {
    pushEntry({
      kind: "mention",
      unread: true,
      channel_id: row.channel_id,
      message_id: row.message_id,
      parent_id: row.parent_id,
      author: { id: row.author_id, name: authorName(String(row.author_id)) },
      text: snippet(row.text),
      at: row.created_at
    });
  }
  // Unread DMs: one entry per conversation.
  for (const view of views) {
    if (view.type !== "dm" && view.type !== "group_dm") continue;
    const unread = asObject(view.unread as JsonObject);
    if (Number(unread.unread_count || 0) <= 0) continue;
    const last = (await listMessageRecords(ctx.orgId, String(view.id), { limit: 1 })).pop();
    pushEntry({
      kind: "dm",
      unread: true,
      count: Number(unread.unread_count || 0),
      channel_id: view.id,
      message_id: last?.id ?? null,
      parent_id: null,
      author: last ? { id: last.author_id, name: authorName(last.author_id) } : { id: "", name: cleanText(view.display_name) },
      text: last ? snippet(last.text) : "New conversation",
      at: view.last_message_at || last?.created_at
    });
  }
  // Replies to my messages / reactions on my messages (window-bounded;
  // unread = newer than the last time the dropdown was opened).
  for (const row of (await listRepliesToUser(ctx.orgId, ctx.userId, windowStart, limit))) {
    pushEntry({
      kind: "reply",
      unread: !seenAt || String(row.created_at) > seenAt,
      channel_id: row.channel_id,
      message_id: row.message_id,
      parent_id: row.parent_id,
      author: { id: row.author_id, name: authorName(String(row.author_id)) },
      text: snippet(row.text),
      at: row.created_at
    });
  }
  for (const row of (await listReactionsToUser(ctx.orgId, ctx.userId, windowStart, limit))) {
    pushEntry({
      kind: "reaction",
      unread: !seenAt || String(row.created_at) > seenAt,
      channel_id: row.channel_id,
      message_id: row.message_id,
      parent_id: row.parent_id,
      emoji: row.emoji,
      author: { id: row.reactor_id, name: authorName(String(row.reactor_id)) },
      text: snippet(row.message_text),
      at: row.created_at
    });
  }
  // Channels the user explicitly subscribed to (notify everything).
  for (const view of views) {
    if (view.type === "dm" || view.type === "group_dm") continue;
    const membership = (await readChannelMember(String(view.id), ctx.userId));
    if (membership?.notify_level !== "all") continue;
    const unread = asObject(view.unread as JsonObject);
    if (Number(unread.unread_count || 0) <= 0) continue;
    const last = (await listMessageRecords(ctx.orgId, String(view.id), { limit: 1 })).pop();
    pushEntry({
      kind: "channel",
      unread: true,
      count: Number(unread.unread_count || 0),
      channel_id: view.id,
      message_id: last?.id ?? null,
      parent_id: null,
      author: last ? { id: last.author_id, name: authorName(last.author_id) } : { id: "", name: "" },
      text: last ? snippet(last.text) : "New messages",
      at: view.last_message_at || last?.created_at
    });
  }

  // Newest first; dedupe mention/DM overlap (a mention inside a DM would
  // otherwise appear twice — keep the mention).
  const dmMentionChannels = new Set(entries.filter((entry) => entry.kind === "mention").map((entry) => cleanText(entry.channel_id)));
  const deduped = entries.filter((entry) => !(entry.kind === "dm" && dmMentionChannels.has(cleanText(entry.channel_id))));
  deduped.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const sliced = deduped.slice(0, limit);
  const unreadTotal = deduped.reduce((sum, entry) => sum + (entry.unread ? Math.max(1, Number(entry.count || 1)) : 0), 0);
  return { entries: sliced, unread_total: unreadTotal, seen_at: seenAt || null };
}

export async function markPersonalInboxSeen(ctx: PlatformAuthContext) {
  (await writeChannelsMeta(inboxSeenKey(ctx.orgId, ctx.userId), nowIso()));
  return { seen_at: nowIso() };
}

// --- realtime helpers ---------------------------------------------------------

async function realtimeTargets(channel: ChannelRow): Promise<string[] | null> {
  if (!isPrivateType(channel)) return null;
  return (await listChannelMembers(channel.id)).map((member) => member.user_id);
}

function messageIsAudienceRestricted(message: MessageRow) {
  return message.audience.length > 0 && message.audience.length < AUDIENCE_GROUPS.length;
}

async function publishMessageEvent(topic: string, channel: ChannelRow, message: MessageRow, hydrated: JsonObject | null | undefined) {
  // Audience-restricted messages are announced as stubs so the body never
  // reaches a connection the read API would have filtered; clients refetch.
  const payload: JsonObject = messageIsAudienceRestricted(message) || !hydrated
    ? { channel_id: channel.id, channel_type: channel.type, project_id: channel.project_id, message_id: message.id, seq: message.seq, parent_id: message.parent_id, stub: true }
    : { channel_id: channel.id, channel_type: channel.type, project_id: channel.project_id, message: hydrated, seq: message.seq, parent_id: message.parent_id };
  (await publishRealtimeEvent({ organization_id: channel.organization_id, topic, user_ids: (await realtimeTargets(channel)), payload }));
}

// --- hydration ----------------------------------------------------------------

export async function hydrateMessages(ctx: PlatformAuthContext, channel: ChannelRow, messages: MessageRow[]) {
  for (const message of messages) {
    if (message.language_code !== "und" || message.deleted_at) continue;
    const detected = detectMessageLanguage(message.text);
    message.language_code = detected.code;
    message.language_confidence = detected.confidence;
    (await setMessageLanguage(ctx.orgId, message.id, detected.code, detected.confidence));
  }
  const directory = await userDirectory(ctx.orgId);
  const ids = messages.map((message) => message.id);
  const reactions = (await listReactionsForMessages(ids));
  const attachments = (await listAttachmentsForMessages(ids));
  const saved = (await listSavedMessageIds(ctx.orgId, ctx.userId));
  const manage = canManageChannels(ctx);
  const preferences = viewerTranslationPreferences(ctx);
  const translations = (await listMessageTranslations(ids, preferences.language));
  return messages.map((message) => hydrateMessage(ctx, message, { directory, reactions, attachments, saved, manage, preferences, translations }));
}

function hydrateMessage(
  ctx: PlatformAuthContext,
  message: MessageRow,
  helpers: {
    directory: Map<string, UserProfile>;
    reactions: Map<string, { message_id: string; user_id: string; emoji: string; created_at: string }[]>;
    attachments: Map<string, unknown[]>;
    saved: Set<string>;
    manage: boolean;
    preferences: { language: string; auto_translate_messages: boolean };
    translations: Map<string, MessageTranslationRow>;
  }
): JsonObject {
  const author = helpers.directory.get(message.author_id) ?? { id: message.author_id, name: "Unknown", email: "", avatar: "" };
  const isAuthor = message.author_id === ctx.userId;
  const deleted = Boolean(message.deleted_at);
  const canModerate = isAuthor || helpers.manage;
  const sourceHash = translationSourceHash(message.text);
  const cachedTranslation = helpers.translations.get(message.id);
  const translationAvailable = message.language_code !== "und" && message.language_code !== helpers.preferences.language;

  const reactionRows = helpers.reactions.get(message.id) ?? [];
  const reactionSummary = new Map<string, { emoji: string; count: number; user_ids: string[]; reacted: boolean }>();
  for (const row of reactionRows) {
    const entry = reactionSummary.get(row.emoji) ?? { emoji: row.emoji, count: 0, user_ids: [], reacted: false };
    entry.count += 1;
    entry.user_ids.push(row.user_id);
    if (row.user_id === ctx.userId) entry.reacted = true;
    reactionSummary.set(row.emoji, entry);
  }

  const base: JsonObject = {
    id: message.id,
    channel_id: message.channel_id,
    seq: message.seq,
    parent_id: message.parent_id,
    kind: message.kind,
    author,
    created_at: message.created_at,
    edited_at: message.edited_at,
    deleted_at: message.deleted_at,
    deleted_by: message.deleted_by,
    pinned_at: message.pinned_at,
    reply_count: message.reply_count,
    last_reply_at: message.last_reply_at,
    audience: message.audience,
    tags: message.tags,
    can_edit: !deleted && isAuthor,
    can_delete: !deleted && canModerate,
    can_restore: deleted && canModerate,
    is_saved: helpers.saved.has(message.id),
    language_code: message.language_code,
    language_confidence: message.language_confidence,
    translation: {
      available: translationAvailable,
      source_language: message.language_code,
      target_language: helpers.preferences.language,
      auto_translate: helpers.preferences.auto_translate_messages,
      cached_text: translationAvailable && cachedTranslation?.source_hash === sourceHash
        ? cachedTranslation.translated_text
        : null
    }
  };

  if (deleted) {
    // Tombstone: the body only survives for people who could restore it.
    return {
      ...base,
      text: canModerate ? message.text : "",
      mention_users: [],
      reactions: [],
      attachments: [],
      metadata: {}
    };
  }

  return {
    ...base,
    text: message.text,
    mention_users: message.mention_users,
    metadata: message.metadata,
    reactions: [...reactionSummary.values()],
    attachments: helpers.attachments.get(message.id) ?? []
  };
}

// --- channel views ------------------------------------------------------------

async function channelView(ctx: PlatformAuthContext, channel: ChannelRow, extras: JsonObject = {}): Promise<JsonObject> {
  const members = (await listChannelMembers(channel.id));
  const directory = await userDirectory(ctx.orgId);
  const isDm = channel.type === "dm" || channel.type === "group_dm";
  const memberProfiles = members.map((member) => ({
    ...(directory.get(member.user_id) ?? { id: member.user_id, name: "Unknown", email: "", avatar: "" }),
    role: member.role,
    notify_level: member.notify_level
  }));
  const others = memberProfiles.filter((member) => member.id !== ctx.userId);
  const displayName = channel.name && isDm ? channel.name : isDm
    ? (others.length ? others.map((member) => member.name).join(", ") : "Just you")
    : channel.name;
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    display_name: displayName || channel.name,
    topic: channel.topic,
    project_id: channel.project_id,
    archived_at: channel.archived_at,
    message_seq: channel.message_seq,
    last_message_at: channel.last_message_at,
    settings: channel.settings,
    created_by: channel.created_by,
    created_at: channel.created_at,
    member_count: members.length,
    members: memberProfiles,
    is_member: members.some((member) => member.user_id === ctx.userId),
    can_manage: (await channelAdminAllowed(ctx, channel)),
    ...extras
  };
}

export async function listChannelsForUser(ctx: PlatformAuthContext, options: { includeArchived?: boolean } = {}) {
  await ensureGeneralChannel(ctx);
  await ensureFirstMateAssistantDm(ctx);
  const membershipIds = new Set((await listMembershipChannelIds(ctx.orgId, ctx.userId)));
  const includeArchived = Boolean(options.includeArchived) && (canManageChannels(ctx) || hasPermission(ctx, "manage_company_settings"));
  const all = (await listChannelRecords(ctx.orgId, { includeArchived }));
  const canSeeProjects = canAccessProjectChannels(ctx);
  const visible = all.filter((channel) => {
    if (isPrivateType(channel)) return membershipIds.has(channel.id);
    if (channel.type === "project") return canSeeProjects && channel.last_message_at;
    return true;
  });
  const unreads = (await unreadSummary(ctx.orgId, ctx.userId, visible.map((channel) => channel.id)));
  const views = [];
  for (const channel of visible) {
    views.push(await channelView(ctx, channel, { unread: unreads.get(channel.id) ?? { unread_count: 0, mention_count: 0, last_read_seq: 0 } }));
  }
  return views;
}

async function ensureFirstMateAssistantDm(ctx: PlatformAuthContext) {
  try {
    const { agentChannelParticipants } = await import("../agents/participants.js");
    const assistant = (await agentChannelParticipants(ctx.orgId, ctx.branchId || "default"))
      .find((participant) => participant.agent_id === "assistant");
    if (!assistant) return;

    const memberIds = [ctx.userId, assistant.id];
    const dmKey = dmKeyForMembers(memberIds);
    let channel = (await findChannelByDmKey(ctx.orgId, dmKey));
    if (!channel) {
      channel = (await createChannelRecord({
        organization_id: ctx.orgId,
        type: "dm",
        dm_key: dmKey,
        created_by: ctx.userId
      }));
    } else if (channel.archived_at) {
      channel = (await updateChannelRecord(ctx.orgId, channel.id, { archived_at: null })) || channel;
    }
    for (const userId of memberIds) {
      (await upsertChannelMember({
        channel_id: channel.id,
        organization_id: ctx.orgId,
        user_id: userId,
        role: userId === ctx.userId ? "owner" : "member"
      }));
    }
  } catch {
    // Channels remain available if the optional agent framework cannot load.
  }
}

async function ensureGeneralChannel(ctx: PlatformAuthContext) {
  const existing = (await listChannelRecords(ctx.orgId, { types: ["public"], includeArchived: true }));
  if (existing.length) return;
  const channel = (await createChannelRecord({
    organization_id: ctx.orgId,
    type: "public",
    name: GENERAL_CHANNEL_NAME,
    topic: "Company-wide announcements and chatter.",
    created_by: ctx.userId
  }));
  (await upsertChannelMember({ channel_id: channel.id, organization_id: ctx.orgId, user_id: ctx.userId, role: "owner" }));
}

export async function createChannel(ctx: PlatformAuthContext, input: {
  new_conversation?: boolean;
  type: "public" | "private" | "dm" | "group_dm";
  name: string;
  topic: string;
  member_user_ids: string[];
}) {
  const isDm = input.type === "dm" || input.type === "group_dm";
  if (!isDm && !hasPermission(ctx, "create_channels|manage_channels")) {
    throw forbidden("permission_denied", "You do not have permission to create channels.");
  }

  const memberIds = [...new Set([ctx.userId, ...input.member_user_ids.map(cleanText).filter(Boolean)])];
  if (isDm) {
    if (memberIds.length < 2) throw badRequest("dm_requires_members", "Direct messages need at least one other person.");
    const type = memberIds.length === 2 ? "dm" : "group_dm";
    const directory = await userDirectory(ctx.orgId);
    if (input.new_conversation && (memberIds.length !== 2 || !memberIds.some(id => id.startsWith('agent_') && directory.has(id)))) {
      throw badRequest("assistant_conversation_required", "Separate conversations are available for an assistant direct message.");
    }
    const dmKey = dmKeyForMembers(memberIds) + (input.new_conversation ? `:conversation:${(await import('node:crypto')).randomUUID()}` : '');
    const existing = (await findChannelByDmKey(ctx.orgId, dmKey));
    if (existing) return channelView(ctx, existing);
    const channel = (await createChannelRecord({ organization_id: ctx.orgId, type, dm_key: dmKey, name:input.new_conversation ? cleanText(input.name) || 'New assistant conversation' : '', created_by: ctx.userId }));
    for (const userId of memberIds) {
      (await upsertChannelMember({ channel_id: channel.id, organization_id: ctx.orgId, user_id: userId, role: userId === ctx.userId ? "owner" : "member" }));
    }
    return channelView(ctx, channel);
  }

  const name = cleanText(input.name).toLowerCase().replace(/[^a-z0-9_\- ]+/g, "").replace(/\s+/g, "-");
  if (!name) throw badRequest("channel_name_required", "Channels need a name.");
  const duplicate = (await listChannelRecords(ctx.orgId, { types: ["public", "private"], includeArchived: true }))
    .find((channel) => channel.name === name);
  if (duplicate) throw badRequest("channel_name_taken", `A channel named #${name} already exists.`);

  const channel = (await createChannelRecord({
    organization_id: ctx.orgId,
    type: input.type,
    name,
    topic: input.topic,
    created_by: ctx.userId
  }));
  (await upsertChannelMember({ channel_id: channel.id, organization_id: ctx.orgId, user_id: ctx.userId, role: "owner" }));
  for (const userId of memberIds.filter((id) => id !== ctx.userId)) {
    (await upsertChannelMember({ channel_id: channel.id, organization_id: ctx.orgId, user_id: userId, role: "member" }));
  }
  await emitChannelsEvent("channels.channel.created", ctx, { channel_id: channel.id, name: channel.name, type: channel.type });
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.channel.updated",
    user_ids: (await realtimeTargets(channel)),
    payload: { channel_id: channel.id, action: "created" }
  }));
  return channelView(ctx, channel);
}

/**
 * Ctx-free variant for backend services (call dispositions, automations) that
 * need the project channel without a user session. Callers are responsible
 * for having verified project access themselves.
 */
export async function ensureProjectChannelRecord(orgId: string, projectId: string, title = "", createdBy = "system") {
  const existing = (await findChannelByProject(orgId, projectId));
  if (existing) {
    if (title && existing.name !== title) (await updateChannelRecord(orgId, existing.id, { name: title }));
    return (await findChannelByProject(orgId, projectId))!;
  }
  return (await createChannelRecord({
    organization_id: orgId,
    type: "project",
    name: title || "Project",
    project_id: projectId,
    created_by: createdBy
  }));
}

export async function ensureProjectChannel(ctx: PlatformAuthContext, projectId: string) {
  if (!canAccessProjectChannels(ctx)) {
    throw forbidden("permission_denied", "You do not have access to projects.");
  }
  let title = "";
  try {
    const project = await readDocument(ctx.orgId, "projects", projectId);
    const data = asObject(project.data);
    title = cleanText(data.title || data.name || data.project_title);
  } catch {
    throw notFound("project_not_found", "This project does not exist.");
  }
  const existing = (await findChannelByProject(ctx.orgId, projectId));
  if (existing) {
    if (title && existing.name !== title) (await updateChannelRecord(ctx.orgId, existing.id, { name: title }));
    return channelView(ctx, (await findChannelByProject(ctx.orgId, projectId))!);
  }
  const channel = (await createChannelRecord({
    organization_id: ctx.orgId,
    type: "project",
    name: title || "Project",
    project_id: projectId,
    created_by: ctx.userId
  }));
  return channelView(ctx, channel);
}

export async function getChannel(ctx: PlatformAuthContext, channelId: string) {
  const { channel } = await requireChannelAccess(ctx, channelId);
  return channelView(ctx, channel);
}

export async function updateChannel(ctx: PlatformAuthContext, channelId: string, patch: { name?: string; topic?: string; settings?: JsonObject }) {
  const { channel } = await requireChannelAccess(ctx, channelId);
  if (!(await channelAdminAllowed(ctx, channel))) throw forbidden("permission_denied", "Only channel admins can update this channel.");
  if (channel.type === "dm" || channel.type === "group_dm") throw badRequest("dm_not_editable", "Direct messages cannot be renamed.");
  const name = patch.name !== undefined && channel.type !== "project"
    ? cleanText(patch.name).toLowerCase().replace(/[^a-z0-9_\- ]+/g, "").replace(/\s+/g, "-")
    : undefined;
  const updated = (await updateChannelRecord(ctx.orgId, channelId, { name, topic: patch.topic, settings: patch.settings }));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.channel.updated",
    user_ids: (await realtimeTargets(channel)),
    payload: { channel_id: channelId, action: "updated" }
  }));
  return channelView(ctx, updated!);
}

export async function setChannelArchived(ctx: PlatformAuthContext, channelId: string, archived: boolean) {
  const { channel } = await requireChannelAccess(ctx, channelId);
  if (!(await channelAdminAllowed(ctx, channel))) throw forbidden("permission_denied", "Only channel admins can archive this channel.");
  if (channel.type === "project") throw badRequest("project_channel", "Project message threads cannot be archived.");
  const updated = (await updateChannelRecord(ctx.orgId, channelId, { archived_at: archived ? nowIso() : null }));
  if (archived) await emitChannelsEvent("channels.channel.archived", ctx, { channel_id: channelId, name: channel.name });
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.channel.updated",
    user_ids: (await realtimeTargets(channel)),
    payload: { channel_id: channelId, action: archived ? "archived" : "unarchived" }
  }));
  return channelView(ctx, updated!);
}

export async function addChannelMembers(ctx: PlatformAuthContext, channelId: string, userIds: string[]) {
  const { channel } = await requireChannelAccess(ctx, channelId);
  if (channel.type === "dm") throw badRequest("dm_fixed_membership", "Direct messages have fixed membership.");
  if (channel.type === "project") throw badRequest("project_channel", "Project message threads use project access, not membership.");
  const selfJoinPublic = channel.type === "public" && userIds.length === 1 && userIds[0] === ctx.userId;
  if (!selfJoinPublic && !(await channelAdminAllowed(ctx, channel))) {
    throw forbidden("permission_denied", "Only channel admins can add members.");
  }
  const directory = await userDirectory(ctx.orgId);
  for (const userId of userIds) {
    if (!directory.has(userId)) throw badRequest("unknown_user", `User ${userId} is not part of this organization.`);
    if (!(await readChannelMember(channelId, userId))) {
      (await upsertChannelMember({ channel_id: channelId, organization_id: ctx.orgId, user_id: userId, role: "member" }));
      const profile = directory.get(userId)!;
      (await createMessageRecord({
        organization_id: ctx.orgId,
        channel_id: channelId,
        author_id: ctx.userId,
        kind: "system",
        text: userId === ctx.userId ? `${directory.get(ctx.userId)?.name ?? "Someone"} joined the channel.` : `${profile.name} was added to the channel.`
      }));
    }
  }
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.channel.updated",
    user_ids: (await realtimeTargets((await readChannelRecord(ctx.orgId, channelId))!)),
    payload: { channel_id: channelId, action: "members_changed" }
  }));
  return channelView(ctx, (await readChannelRecord(ctx.orgId, channelId))!);
}

export async function removeMember(ctx: PlatformAuthContext, channelId: string, userId: string) {
  const { channel } = await requireChannelAccess(ctx, channelId);
  if (channel.type === "dm") throw badRequest("dm_fixed_membership", "Direct messages have fixed membership.");
  if (userId !== ctx.userId && !(await channelAdminAllowed(ctx, channel))) {
    throw forbidden("permission_denied", "Only channel admins can remove members.");
  }
  (await removeChannelMember(channelId, userId));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.channel.updated",
    user_ids: null,
    payload: { channel_id: channelId, action: "members_changed" }
  }));
  return { ok: true };
}

// --- messages -----------------------------------------------------------------

export async function listMessages(ctx: PlatformAuthContext, channelId: string, options: { before?: number; after?: number; limit?: number }) {
  const { channel } = await requireChannelAccess(ctx, channelId);
  const groups = viewerAudienceGroups(ctx);
  const raw = (await listMessageRecords(ctx.orgId, channelId, { ...options, parentId: null }))
    .filter((message) => messageVisibleTo(message, ctx, groups));
  const messages = await hydrateMessages(ctx, channel, raw);
  return { channel: await channelView(ctx, channel), messages };
}

export async function listThread(ctx: PlatformAuthContext, messageId: string, options: { after?: number; limit?: number }) {
  const root = (await readMessageRecord(ctx.orgId, messageId));
  if (!root) throw notFound("message_not_found", "This message does not exist.");
  const { channel } = await requireChannelAccess(ctx, root.channel_id);
  const groups = viewerAudienceGroups(ctx);
  if (!messageVisibleTo(root, ctx, groups)) throw notFound("message_not_found", "This message does not exist.");
  const replies = (await listMessageRecords(ctx.orgId, root.channel_id, { parentId: messageId, after: options.after, limit: options.limit ?? 200 }))
    .filter((message) => messageVisibleTo(message, ctx, groups));
  const hydrated = await hydrateMessages(ctx, channel, [root, ...replies]);
  return { root: hydrated[0], replies: hydrated.slice(1) };
}

export async function postMessage(ctx: PlatformAuthContext, channelId: string, input: {
  text: string;
  content?: JsonObject;
  content_schema_version?: number;
  client_msg_id?: string;
  parent_id?: string;
  audience?: string[];
  tags?: string[];
  mention_users?: JsonObject[];
  attachment_ids?: string[];
  metadata?: JsonObject;
}) {
  const { channel, membership } = await requireChannelAccess(ctx, channelId, { write: true });

  // Posting to a public channel you have not joined joins you to it (Slack-style).
  if (channel.type === "public" && !membership) {
    (await upsertChannelMember({ channel_id: channelId, organization_id: ctx.orgId, user_id: ctx.userId, role: "member" }));
  }

  const clientMsgId = cleanText(input.client_msg_id);
  if (clientMsgId) {
    const existing = (await findMessageByClientId(channelId, ctx.userId, clientMsgId));
    if (existing) {
      const [hydrated] = await hydrateMessages(ctx, channel, [existing]);
      return { message: hydrated, deduplicated: true };
    }
  }

  let parentId: string | null = null;
  if (input.parent_id) {
    const parent = (await readMessageRecord(ctx.orgId, input.parent_id));
    if (!parent || parent.channel_id !== channelId) throw badRequest("invalid_parent", "The thread parent does not exist in this channel.");
    // Replies attach to the thread root, never nest.
    parentId = parent.parent_id ?? parent.id;
  }

  const detectedLanguage = detectMessageLanguage(input.text);
  const message = (await createMessageRecord({
    organization_id: ctx.orgId,
    channel_id: channelId,
    parent_id: parentId,
    client_msg_id: clientMsgId || null,
    author_id: ctx.userId,
    text: input.text,
    content: input.content,
    content_schema_version: input.content_schema_version,
    language_code: detectedLanguage.code,
    language_confidence: detectedLanguage.confidence,
    audience: channel.type === "project" ? input.audience : [],
    tags: input.tags,
    mention_users: input.mention_users,
    metadata: input.metadata
  }));

  if (input.attachment_ids?.length) {
    (await attachToMessage(ctx.orgId, input.attachment_ids, message.id, channelId, ctx.userId));
    for (const attachment of (await listAttachmentsForMessages([message.id])).get(message.id) ?? []) {
      (await collaboration.createResourceRefRecord(ctx.orgId, channelId, ctx.userId, {
        resource_type: "media",
        resource_id: attachment.media_id,
        source_message_id: message.id,
        relationship: "attachment"
      }));
    }
  }

  const [hydrated] = await hydrateMessages(ctx, channel, [(await readMessageRecord(ctx.orgId, message.id))!]);
  if (parentId) {
    (await collaboration.setThreadSubscriptionRecord(ctx.orgId, channelId, parentId, ctx.userId, true));
  }
  const attentionTargets = (await collaboration.recordAttentionForMessage(channel, message));
  (await publishMessageEvent("channels.message.created", channel, message, hydrated));
  await emitChannelsEvent("channels.message.posted", ctx, { channel_id: channelId, message_id: message.id, at: message.created_at }, channel.project_id);
  await notifyMentions(ctx, channel, message);
  await notifyMessageSubscribers(ctx, channel, message);
  if (attentionTargets.size) {
    (await publishRealtimeEvent({
      organization_id: ctx.orgId,
      topic: "channels.attention.created",
      user_ids: [...attentionTargets.keys()],
      payload: { channel_id: channel.id, message_id: message.id }
    }));
  }

  // AI participation: an @-mention of an agent, or any message in a DM the
  // agent is a member of, wakes the agent (fire-and-forget; never blocks or
  // fails the post). Static import — a lazy import() of a newly created
  // module fails silently under tsx watch until the process restarts.
  try {
    (await maybeTriggerChannelAgent(ctx, channel, message));
  } catch {
    /* agent participation is best-effort */
  }

  return { message: hydrated, deduplicated: false };
}

/**
 * Post a message AS an agent pseudo-user (no auth context). Publishes the
 * realtime event as a stub so open clients refetch — hydration needs a user
 * context we don't have. Mentioned users still get platform notifications.
 */
export async function postAgentMessage(orgId: string, channelId: string, input: {
  author_id: string;
  text: string;
  parent_id?: string | null;
  mention_users?: JsonObject[];
  metadata?: JsonObject;
  client_msg_id?: string;
}) {
  const channel = (await readChannelRecord(orgId, channelId));
  if (!channel) throw notFound("channel_not_found", "This channel does not exist.");
  if (channel.archived_at) throw badRequest("channel_archived", "This channel is archived.");

  let parentId: string | null = null;
  if (input.parent_id) {
    const parent = (await readMessageRecord(orgId, input.parent_id));
    if (parent && parent.channel_id === channelId) parentId = parent.parent_id ?? parent.id;
  }
  const detectedLanguage = detectMessageLanguage(input.text);
  const message = (await createMessageRecord({
    organization_id: orgId,
    channel_id: channelId,
    parent_id: parentId,
    client_msg_id: cleanText(input.client_msg_id) || null,
    author_id: cleanText(input.author_id),
    text: input.text,
    language_code: detectedLanguage.code,
    language_confidence: detectedLanguage.confidence,
    audience: [],
    tags: [],
    mention_users: input.mention_users,
    metadata: { source: "agent", ...asObject(input.metadata) }
  }));
  if (parentId) (await collaboration.setThreadSubscriptionRecord(orgId, channelId, parentId, cleanText(input.author_id), true));
  (await collaboration.recordAttentionForMessage(channel, message));
  (await publishMessageEvent("channels.message.created", channel, message, null));

  // Mention notifications (best effort), mirroring notifyMentions but with
  // the agent as the excluded author.
  try {
    const targets = [...new Set((input.mention_users ?? [])
      .map((user) => cleanText(asObject(user).id || asObject(user).user_id))
      .filter((id) => id && id !== cleanText(input.author_id)))];
    if (targets.length) {
      const directory = await userDirectory(orgId);
      const authorName = directory.get(cleanText(input.author_id))?.name || "The AI assistant";
      const { createPlatformNotification } = await import("../platform/api.js");
      await createPlatformNotification(orgId, {
        id: `notification_mention_${message.id}_agent`,
        title: `${authorName} mentioned you`,
        body: input.text.length > 160 ? `${input.text.slice(0, 157)}…` : input.text,
        kind: "mention",
        channel: "passive",
        manual_dismissible: true,
        source: "channels_agent",
        target_user_ids: targets,
        frontend_action: channel.type === "project"
          ? { kind: "open_project_message", project_id: channel.project_id, channel_id: channel.id, message_id: message.id, parent_id: parentId }
          : { kind: "open_channel_message", channel_id: channel.id, message_id: message.id, parent_id: parentId }
      });
      (await publishRealtimeEvent({ organization_id: orgId, topic: "channels.unreads.changed", user_ids: targets, payload: { channel_id: channel.id } }));
    }
  } catch {
    /* best effort */
  }
  return { channel, message };
}

/**
 * Find-or-create the DM channel between an agent pseudo-user and a real user
 * (ctx-free variant of createChannel's DM branch, used by agent tools).
 */
export async function ensureAgentDmChannel(orgId: string, agentUserId: string, targetUserId: string) {
  const memberIds = [...new Set([cleanText(agentUserId), cleanText(targetUserId)])].filter(Boolean);
  if (memberIds.length < 2) throw badRequest("dm_requires_members", "A DM needs two participants.");
  const dmKey = dmKeyForMembers(memberIds);
  const existing = (await findChannelByDmKey(orgId, dmKey));
  if (existing) return existing;
  const channel = (await createChannelRecord({
    organization_id: orgId,
    type: "dm",
    name: "",
    dm_key: dmKey,
    created_by: cleanText(agentUserId)
  }));
  for (const userId of memberIds) {
    (await upsertChannelMember({ channel_id: channel.id, organization_id: orgId, user_id: userId, role: userId === cleanText(agentUserId) ? "owner" : "member" }));
  }
  return channel;
}

export async function editMessage(ctx: PlatformAuthContext, messageId: string, input: {
  text: string;
  content?: JsonObject;
  content_schema_version?: number;
  audience?: string[];
  tags?: string[];
  mention_users?: JsonObject[];
}) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  const { channel } = await requireChannelAccess(ctx, message.channel_id, { write: true });
  // Authorship is absolute: not even admins may edit someone else's words.
  if (message.author_id !== ctx.userId) throw forbidden("not_message_author", "Only the author can edit a message.");
  if (message.deleted_at) throw badRequest("message_deleted", "Removed messages cannot be edited. Restore it first.");

  const previousMentions = new Set(message.mention_users.map((user) => cleanText(user.id || user.user_id)).filter(Boolean));
  const detectedLanguage = detectMessageLanguage(input.text);
  const updated = (await editMessageRecord(ctx.orgId, message, {
    text: input.text,
    content: input.content,
    content_schema_version: input.content_schema_version,
    language_code: detectedLanguage.code,
    language_confidence: detectedLanguage.confidence,
    audience: channel.type === "project" ? input.audience : undefined,
    tags: input.tags,
    mention_users: input.mention_users,
    edited_by: ctx.userId
  }));

  const [hydrated] = await hydrateMessages(ctx, channel, [updated]);
  (await publishMessageEvent("channels.message.updated", channel, updated, hydrated));
  await emitChannelsEvent("channels.message.edited", ctx, { channel_id: channel.id, message_id: messageId, at: updated.edited_at ?? nowIso() }, channel.project_id);
  await notifyMentions(ctx, channel, updated, previousMentions);
  return hydrated;
}

export function translationPreferences(ctx: PlatformAuthContext) {
  return viewerTranslationPreferences(ctx);
}

export async function translateMessage(ctx: PlatformAuthContext, messageId: string) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  const { channel } = await requireChannelAccess(ctx, message.channel_id);
  const groups = viewerAudienceGroups(ctx);
  if (!messageVisibleTo(message, ctx, groups) || message.deleted_at) {
    throw notFound("message_not_found", "This message does not exist.");
  }
  if (message.language_code === "und") {
    const detected = detectMessageLanguage(message.text);
    message.language_code = detected.code;
    message.language_confidence = detected.confidence;
    (await setMessageLanguage(ctx.orgId, message.id, detected.code, detected.confidence));
  }
  const preferences = viewerTranslationPreferences(ctx);
  if (message.language_code === "und") throw badRequest("language_unknown", "This message is too short to identify its language reliably.");
  if (message.language_code === preferences.language) {
    return {
      message_id: message.id,
      source_language: message.language_code,
      target_language: preferences.language,
      translated_text: message.text,
      cached: true
    };
  }

  const sourceHash = translationSourceHash(message.text);
  const cached = (await readMessageTranslation(message.id, preferences.language, sourceHash));
  if (cached) {
    return {
      message_id: message.id,
      source_language: cached.source_language,
      target_language: cached.target_language,
      translated_text: cached.translated_text,
      cached: true
    };
  }

  const runKey = `${message.id}:${preferences.language}:${sourceHash}`;
  const existingRun = translationRuns.get(runKey);
  if (existingRun) return await existingRun;
  const run = (async () => {
    const translatedText = await translateMessageText({
      text: message.text,
      sourceLanguage: message.language_code,
      targetLanguage: preferences.language,
      mentionUsers: message.mention_users
    });
    const saved = (await saveMessageTranslation({
      message_id: message.id,
      organization_id: ctx.orgId,
      source_hash: sourceHash,
      source_language: message.language_code,
      target_language: preferences.language,
      translated_text: translatedText,
      model: env.openaiTranslationModel
    }));
    return {
      message_id: message.id,
      source_language: saved.source_language,
      target_language: saved.target_language,
      translated_text: saved.translated_text,
      cached: false
    };
  })().finally(() => translationRuns.delete(runKey));
  translationRuns.set(runKey, run);
  return await run;
}

export async function deleteMessage(ctx: PlatformAuthContext, messageId: string) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  const { channel } = await requireChannelAccess(ctx, message.channel_id);
  if (message.author_id !== ctx.userId && !canManageChannels(ctx)) {
    throw forbidden("not_message_author", "Only the author or a channels manager can remove a message.");
  }
  const deleted = (await softDeleteMessageRecord(ctx.orgId, messageId, ctx.userId))!;
  const [hydrated] = await hydrateMessages(ctx, channel, [deleted]);
  (await publishMessageEvent("channels.message.deleted", channel, deleted, hydrated));
  await emitChannelsEvent("channels.message.deleted", ctx, { channel_id: channel.id, message_id: messageId, at: deleted.deleted_at ?? nowIso() }, channel.project_id);
  return hydrated;
}

export async function restoreMessage(ctx: PlatformAuthContext, messageId: string) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  const { channel } = await requireChannelAccess(ctx, message.channel_id);
  if (!message.deleted_at) throw badRequest("message_not_deleted", "This message is not removed.");
  if (message.author_id !== ctx.userId && !canManageChannels(ctx)) {
    throw forbidden("not_message_author", "Only the author or a channels manager can restore a message.");
  }
  const restored = (await restoreMessageRecord(ctx.orgId, messageId))!;
  const [hydrated] = await hydrateMessages(ctx, channel, [restored]);
  (await publishMessageEvent("channels.message.restored", channel, restored, hydrated));
  await emitChannelsEvent("channels.message.restored", ctx, { channel_id: channel.id, message_id: messageId, at: nowIso() }, channel.project_id);
  return hydrated;
}

export async function messageRevisions(ctx: PlatformAuthContext, messageId: string) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  await requireChannelAccess(ctx, message.channel_id);
  const groups = viewerAudienceGroups(ctx);
  if (!messageVisibleTo(message, ctx, groups)) throw notFound("message_not_found", "This message does not exist.");
  const directory = await userDirectory(ctx.orgId);
  const revisions = (await listMessageRevisions(messageId)).map((revision) => ({
    ...revision,
    edited_by_user: directory.get(revision.edited_by) ?? { id: revision.edited_by, name: "Unknown", email: "", avatar: "" }
  }));
  return {
    current: { text: message.text, edited_at: message.edited_at, created_at: message.created_at },
    revisions
  };
}

export async function toggleReaction(ctx: PlatformAuthContext, messageId: string, emoji: string, on: boolean) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  const { channel } = await requireChannelAccess(ctx, message.channel_id, { write: true });
  if (message.deleted_at) throw badRequest("message_deleted", "Removed messages cannot be reacted to.");
  (await toggleReactionRecord({
    organization_id: ctx.orgId,
    channel_id: message.channel_id,
    message_id: messageId,
    user_id: ctx.userId,
    emoji,
    on
  }));
  if (on) (await collaboration.recordReactionAttention(ctx.orgId, message, ctx.userId, emoji));
  const [hydrated] = await hydrateMessages(ctx, channel, [(await readMessageRecord(ctx.orgId, messageId))!]);
  (await publishMessageEvent("channels.reaction.updated", channel, message, hydrated));
  return hydrated;
}

export async function setPinned(ctx: PlatformAuthContext, messageId: string, pinned: boolean) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  const { channel } = await requireChannelAccess(ctx, message.channel_id, { write: true });
  if (message.deleted_at) throw badRequest("message_deleted", "Removed messages cannot be pinned.");
  if (!pinned && message.pinned_by && message.pinned_by !== ctx.userId && !(await channelAdminAllowed(ctx, channel))) {
    throw forbidden("permission_denied", "Only channel admins can unpin messages pinned by others.");
  }
  (await setMessagePinned(ctx.orgId, messageId, pinned ? ctx.userId : null));
  const [hydrated] = await hydrateMessages(ctx, channel, [(await readMessageRecord(ctx.orgId, messageId))!]);
  (await publishMessageEvent("channels.message.updated", channel, (await readMessageRecord(ctx.orgId, messageId))!, hydrated));
  return hydrated;
}

export async function pinnedMessages(ctx: PlatformAuthContext, channelId: string) {
  const { channel } = await requireChannelAccess(ctx, channelId);
  const groups = viewerAudienceGroups(ctx);
  const pinned = (await listPinnedMessages(ctx.orgId, channelId)).filter((message) => messageVisibleTo(message, ctx, groups));
  return hydrateMessages(ctx, channel, pinned);
}

export async function savedMessages(ctx: PlatformAuthContext) {
  const groups = viewerAudienceGroups(ctx);
  const saved = (await listSavedMessages(ctx.orgId, ctx.userId)).filter((message) => messageVisibleTo(message, ctx, groups));
  const results: JsonObject[] = [];
  for (const message of saved) {
    const channel = (await readChannelRecord(ctx.orgId, message.channel_id));
    if (!channel) continue;
    try {
      await requireChannelAccess(ctx, channel.id);
    } catch {
      continue;
    }
    const [hydrated] = await hydrateMessages(ctx, channel, [message]);
    results.push({ ...hydrated, channel: { id: channel.id, name: channel.name, type: channel.type, project_id: channel.project_id } });
  }
  return results;
}

export async function setSaved(ctx: PlatformAuthContext, messageId: string, on: boolean) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  await requireChannelAccess(ctx, message.channel_id);
  (await setSavedItem(ctx.orgId, ctx.userId, messageId, on));
  return { ok: true, saved: on };
}

export async function markRead(ctx: PlatformAuthContext, channelId: string, lastReadSeq: number) {
  await requireChannelAccess(ctx, channelId);
  (await upsertReadState(ctx.orgId, channelId, ctx.userId, lastReadSeq));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.read.updated",
    user_ids: [ctx.userId],
    payload: { channel_id: channelId, last_read_seq: lastReadSeq }
  }));
  return { ok: true };
}

export async function unreads(ctx: PlatformAuthContext) {
  const channels = await listChannelsForUser(ctx);
  const byChannel: JsonObject = {};
  let totalUnread = 0;
  let totalMentions = 0;
  for (const channel of channels) {
    const unread = asObject(channel.unread);
    byChannel[String(channel.id)] = unread;
    totalUnread += Number(unread.unread_count ?? 0);
    totalMentions += Number(unread.mention_count ?? 0);
  }
  return { channels: byChannel, total_unread: totalUnread, total_mentions: totalMentions };
}

export async function markUnread(ctx: PlatformAuthContext, channelId: string, seq: number) {
  await requireChannelAccess(ctx, channelId);
  const message = (await readMessageBySequence(ctx.orgId, channelId, seq));
  if (!message || message.seq !== seq) throw badRequest("invalid_unread_message", "The selected message is not in this channel.");
  const state = (await collaboration.markUnreadRecord(ctx.orgId, channelId, ctx.userId, seq));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.read_state.updated",
    user_ids: [ctx.userId],
    payload: { channel_id: channelId, ...state }
  }));
  return { ok: true, state };
}

export async function markAllRead(ctx: PlatformAuthContext) {
  const visible = await listChannelsForUser(ctx);
  const records = (await Promise.all(visible
    .map(async (item) => (await readChannelRecord(ctx.orgId, String(item.id))))))
    .filter((item): item is ChannelRow => Boolean(item));
  const operation = (await collaboration.markAllReadRecords(ctx.orgId, ctx.userId, records));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.read_state.updated",
    user_ids: [ctx.userId],
    payload: { action: "read_all", ...operation }
  }));
  return { ok: true, ...operation };
}

export async function undoRead(ctx: PlatformAuthContext, operationId: string) {
  const result = (await collaboration.undoReadOperation(ctx.orgId, ctx.userId, operationId));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.read_state.updated",
    user_ids: [ctx.userId],
    payload: { action: "undo_read_all", operation_id: operationId }
  }));
  return { ok: true, ...result };
}

export async function allUnreadMessages(ctx: PlatformAuthContext, options: { limit?: number } = {}) {
  const channels = await listChannelsForUser(ctx);
  const groups = viewerAudienceGroups(ctx);
  const results: JsonObject[] = [];
  const perChannel = Math.max(10, Math.min(Number(options.limit) || 50, 200));
  for (const channelViewValue of channels) {
    const channel = (await readChannelRecord(ctx.orgId, String(channelViewValue.id)));
    if (!channel) continue;
    const state = (await collaboration.readStateRecord(channel.id, ctx.userId));
    const subscriptions = new Set(
      (await collaboration.listThreadSubscriptionRows(ctx.orgId, ctx.userId))
        .filter((row) => String(row.channel_id) === channel.id)
        .map((row) => String(row.root_message_id))
    );
    const raw = (await listMessageRecords(ctx.orgId, channel.id, { after: state.effective_read_seq, limit: perChannel }))
      .filter((message) => !message.parent_id || subscriptions.has(message.parent_id))
      .filter((message) => message.author_id !== ctx.userId && messageVisibleTo(message, ctx, groups));
    if (!raw.length) continue;
    results.push({
      channel: channelViewValue,
      messages: await hydrateMessages(ctx, channel, raw),
      first_unread_seq: raw[0]!.seq
    });
  }
  return { conversations: results, total_unread: results.reduce((sum, item) => sum + (item.messages as unknown[]).length, 0) };
}

export async function activity(ctx: PlatformAuthContext, options: { kind?: string; unreadOnly?: boolean; limit?: number } = {}) {
  const rows = (await collaboration.listAttentionRows(ctx.orgId, ctx.userId, options));
  const visible: JsonObject[] = [];
  for (const row of rows) {
    try {
      await requireChannelAccess(ctx, String(row.channel_id));
      visible.push(row);
    } catch {
      // Access changes remove the item from the attention surface.
    }
  }
  return { items: visible, unread_count: visible.filter((item) => !item.read_at).length };
}

export async function updateActivity(ctx: PlatformAuthContext, itemId: string, patch: JsonObject) {
  const item = (await collaboration.updateAttentionRecord(ctx.orgId, ctx.userId, itemId, patch));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.attention.updated",
    user_ids: [ctx.userId],
    payload: { item_id: itemId }
  }));
  return item;
}

export async function markAllActivityRead(ctx: PlatformAuthContext) {
  const result = (await collaboration.markAllAttentionReadRecords(ctx.orgId, ctx.userId));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.attention.updated",
    user_ids: [ctx.userId],
    payload: { action: "read_all" }
  }));
  return result;
}

export async function followedThreads(ctx: PlatformAuthContext) {
  const rows = (await collaboration.listParticipatedThreadRows(ctx.orgId, ctx.userId));
  const results: JsonObject[] = [];
  for (const row of rows) {
    try {
      const thread = await listThread(ctx, String(row.root_message_id), { limit: 200 });
      const lastReplySeq = Math.max(0, ...(thread.replies || []).map((reply: JsonObject) => Number(reply.seq) || 0));
      const lastReadReplySeq = Number(row.last_read_reply_seq) || 0;
      results.push({
        subscription: row,
        ...thread,
        last_reply_seq: lastReplySeq,
        unread_count: (thread.replies || []).filter((reply: JsonObject) => Number(reply.seq) > lastReadReplySeq && cleanText(reply.author_id) !== ctx.userId).length
      });
    } catch {
      // A revoked or deleted thread disappears from this personal view.
    }
  }
  return results;
}

export async function markThreadRead(ctx: PlatformAuthContext, rootMessageId: string, lastReplySeq: number) {
  const root = (await readMessageRecord(ctx.orgId, rootMessageId));
  if (!root) throw notFound("message_not_found", "This thread does not exist.");
  await requireChannelAccess(ctx, root.channel_id);
  return (await collaboration.markThreadReadRecord(ctx.orgId, ctx.userId, root.parent_id || root.id, lastReplySeq));
}

export async function setThreadSubscription(ctx: PlatformAuthContext, rootMessageId: string, following: boolean, notifyLevel = "all") {
  const root = (await readMessageRecord(ctx.orgId, rootMessageId));
  if (!root) throw notFound("message_not_found", "This thread does not exist.");
  await requireChannelAccess(ctx, root.channel_id);
  const canonicalRoot = root.parent_id || root.id;
  const subscription = (await collaboration.setThreadSubscriptionRecord(
    ctx.orgId,
    root.channel_id,
    canonicalRoot,
    ctx.userId,
    following,
    notifyLevel
  ));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.thread_subscription.updated",
    user_ids: [ctx.userId],
    payload: { channel_id: root.channel_id, root_message_id: canonicalRoot, following }
  }));
  return subscription;
}

export async function collaborationPreferences(ctx: PlatformAuthContext) {
  return (await collaboration.readCollaborationPreferences(ctx.orgId, ctx.userId));
}

export async function saveCollaborationPreferences(ctx: PlatformAuthContext, patch: JsonObject) {
  const preferences = (await collaboration.saveCollaborationPreferences(ctx.orgId, ctx.userId, patch));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.preferences.updated",
    user_ids: [ctx.userId],
    payload: { version: preferences.version }
  }));
  return preferences;
}

export async function deliverDueScheduledMessages(ctx: PlatformAuthContext) {
  return deliverAllDueScheduledMessages({ orgId: ctx.orgId, userId: ctx.userId });
}

export async function deliverAllDueScheduledMessages(scope?: { orgId: string; userId: string }) {
  const db = getChannelsDatabase();
  const due = await db.prepare(`SELECT * FROM channel_scheduled_messages
    WHERE state IN ('scheduled','sending') AND scheduled_at <= ?
    ${scope ? "AND organization_id=? AND sender_user_id=?" : ""}
    ORDER BY scheduled_at ASC LIMIT 100`).all(nowIso(), ...(scope ? [scope.orgId, scope.userId] : []));
  let delivered = 0;
  const { isCapabilityEnabled } = await import("../platform/capabilities.js");
  for (const candidate of due) {
    const orgId = cleanText(candidate.organization_id);
    if (!await isCapabilityEnabled(orgId, "apps.channels")) continue;
    try {
      const { backgroundAuthContext, can } = await import("../platform/auth.js");
      const sender = await backgroundAuthContext(orgId, cleanText(candidate.sender_user_id));
      if (!await can(sender, "apps.channels")) throw new Error("The sender no longer has access to Channels.");
      const completed = await collaboration.deliverScheduledRecord(cleanText(candidate.id), async scheduled => {
        const channel = await readChannelRecord(orgId, cleanText(scheduled.channel_id));
        if (!channel || channel.archived_at) throw new Error("The target channel is unavailable.");
        const senderId = cleanText(scheduled.sender_user_id);
        if (isPrivateType(channel) && !(await listChannelMembers(channel.id)).some(member => member.user_id === senderId)) {
          throw new Error("The sender no longer belongs to this channel.");
        }
        const text = cleanText(scheduled.text);
        const detected = detectMessageLanguage(text);
        const message = await createMessageRecord({
          organization_id: orgId, channel_id: channel.id,
          parent_id: cleanText(scheduled.root_message_id) || null,
          client_msg_id: `scheduled:${cleanText(scheduled.id)}`,
          author_id: senderId, text, content: asObject(scheduled.content), content_schema_version: 1,
          language_code: detected.code, language_confidence: detected.confidence,
          audience: [], tags: [], mention_users: [],
          metadata: { ...asObject(scheduled.metadata), scheduled_message_id: scheduled.id }
        });
        const attachments = Array.isArray(scheduled.attachment_ids) ? scheduled.attachment_ids.map(cleanText) : [];
        if (attachments.length) await attachToMessage(orgId, attachments, message.id, channel.id, senderId);
        await collaboration.recordAttentionForMessage(channel, message);
        return message.id;
      });
      if (completed) delivered++;
    } catch (error) {
      // Preserve transient database failures for retry. Invalid destinations
      // remain visible in the sender's schedule list for editing/cancellation.
      const reason = cleanText((error as Error)?.message);
      if (reason === "The target channel is unavailable." || reason === "The sender no longer belongs to this channel." || reason === "The sender no longer has access to Channels."
        || [401, 403, 404].includes(Number((error as { statusCode?: number }).statusCode))) {
        await db.prepare("UPDATE channel_scheduled_messages SET state='failed',failure_reason=?,updated_at=? WHERE id=? AND state IN ('scheduled','sending')")
          .run(reason, nowIso(), cleanText(candidate.id));
      } else throw error;
    }
  }
  // Delivery is durable before realtime fanout. Replays are harmless stubs;
  // the message itself is committed once even across a worker restart.
  for (const item of await db.prepare("SELECT * FROM channel_delivery_outbox ORDER BY created_at LIMIT 100").all()) {
    const orgId = cleanText(item.organization_id);
    const message = await readMessageRecord(orgId, cleanText(item.message_id));
    const channel = message ? await readChannelRecord(orgId, message.channel_id) : null;
    if (message && channel) await publishMessageEvent("channels.message.created", channel, message, null);
    await db.prepare("DELETE FROM channel_delivery_outbox WHERE scheduled_id=?").run(cleanText(item.scheduled_id));
  }
  return delivered;
}

export async function saveMessageReminder(ctx: PlatformAuthContext, messageId: string, remindAt: string) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  await requireChannelAccess(ctx, message.channel_id);
  return (await collaboration.saveMessageReminderRecord(ctx.orgId, ctx.userId, messageId, remindAt));
}

export async function messageReminders(ctx: PlatformAuthContext) {
  const reminders = (await collaboration.listMessageReminderRecords(ctx.orgId, ctx.userId));
  const results: JsonObject[] = [];
  for (const reminder of reminders) {
    const message = (await readMessageRecord(ctx.orgId, cleanText(reminder.message_id)));
    if (!message) continue;
    const channel = (await readChannelRecord(ctx.orgId, message.channel_id));
    if (!channel) continue;
    try {
      await requireChannelAccess(ctx, channel.id);
    } catch {
      continue;
    }
    const [hydrated] = await hydrateMessages(ctx, channel, [message]);
    if (!hydrated) continue;
    results.push({
      ...reminder,
      due: Date.parse(cleanText(reminder.remind_at)) <= Date.now(),
      message: hydrated,
      channel: { id: channel.id, name: channel.name, type: channel.type, project_id: channel.project_id }
    });
  }
  return results;
}

export async function removeMessageReminder(ctx: PlatformAuthContext, reminderId: string) {
  return (await collaboration.removeMessageReminderRecord(ctx.orgId, ctx.userId, reminderId));
}

export async function listChannelTabs(ctx: PlatformAuthContext, channelId: string) {
  await requireChannelAccess(ctx, channelId);
  return (await collaboration.listTabRecords(ctx.orgId, channelId, ctx.userId));
}

export async function createChannelTab(ctx: PlatformAuthContext, channelId: string, input: JsonObject) {
  await requireChannelAccess(ctx, channelId, { write: true });
  return (await collaboration.createTabRecord(ctx.orgId, channelId, ctx.userId, input));
}

export async function updateChannelTab(ctx: PlatformAuthContext, channelId: string, tabId: string, patch: JsonObject) {
  await requireChannelAccess(ctx, channelId, { write: true });
  return (await collaboration.updateTabRecord(ctx.orgId, channelId, tabId, patch));
}

export async function deleteChannelTab(ctx: PlatformAuthContext, channelId: string, tabId: string) {
  await requireChannelAccess(ctx, channelId, { write: true });
  return (await collaboration.deleteTabRecord(ctx.orgId, channelId, tabId));
}

export async function listChannelFolders(ctx: PlatformAuthContext, channelId: string) {
  await requireChannelAccess(ctx, channelId);
  return (await collaboration.listFolderRecords(ctx.orgId, channelId));
}

export async function createChannelFolder(ctx: PlatformAuthContext, channelId: string, input: JsonObject) {
  await requireChannelAccess(ctx, channelId, { write: true });
  return (await collaboration.createFolderRecord(ctx.orgId, channelId, ctx.userId, input));
}

export async function updateChannelFolder(ctx: PlatformAuthContext, channelId: string, folderId: string, patch: JsonObject) {
  await requireChannelAccess(ctx, channelId, { write: true });
  return (await collaboration.updateFolderRecord(ctx.orgId, channelId, folderId, patch));
}

export async function deleteChannelFolder(ctx: PlatformAuthContext, channelId: string, folderId: string) {
  await requireChannelAccess(ctx, channelId, { write: true });
  return (await collaboration.deleteFolderRecord(ctx.orgId, channelId, folderId));
}

function mediaBelongsToProject(media: JsonObject, projectId: string) {
  const owner = asObject(media.owner);
  const metadata = asObject(media.metadata);
  return (
    (cleanText(owner.type) === "project" && cleanText(owner.id) === projectId)
    || cleanText(metadata.project_id) === projectId
  );
}

export async function listChannelResources(
  ctx: PlatformAuthContext,
  channelId: string,
  options: { type?: string; folderId?: string } = {}
) {
  const { channel } = await requireChannelAccess(ctx, channelId);
  const refs = (await collaboration.listResourceRefRows(ctx.orgId, channelId, options));
  const resources: JsonObject[] = refs.map((ref) => ({ ...ref, source: "reference" }));
  if (channel.project_id && !options.folderId) {
    const type = cleanText(options.type);
    if (!type || type === "media" || type === "files") {
      const { listMedia } = await import("../platform/storage.js");
      for (const media of await listMedia(ctx.orgId)) {
        if (mediaBelongsToProject(asObject(media), channel.project_id)) {
          resources.push({ resource_type: "media", resource_id: media.id, resource: media, source: "project" });
        }
      }
    }
    if (!type || type === "document" || type === "documents" || type === "files") {
      const { listProjectDocuments } = await import("../documents/storage.js");
      for (const document of await listProjectDocuments(ctx.orgId, channel.project_id)) {
        resources.push({ resource_type: "document", resource_id: document.id, resource: document, source: "project" });
      }
    }
    if (!type || type === "action_item" || type === "todos") {
      const { listCanonicalActionItems } = await import("../platform/api.js");
      const result = await listCanonicalActionItems(ctx.orgId, ctx as unknown as Record<string, unknown>, {
        includeCompleted: true,
        includeCanceled: false
      });
      const items = Array.isArray(result.items) ? result.items : [];
      for (const itemValue of items) {
        const item = asObject(itemValue);
        const projectIds = Array.isArray(item.project_ids) ? item.project_ids.map(cleanText) : [];
        if (projectIds.includes(channel.project_id)) {
          resources.push({ resource_type: "action_item", resource_id: item.id, resource: item, source: "project" });
        }
      }
    }
  }
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.resource_type}:${resource.resource_id}:${resource.folder_id ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function createChannelResource(ctx: PlatformAuthContext, channelId: string, input: JsonObject) {
  await requireChannelAccess(ctx, channelId, { write: true });
  const resource = (await collaboration.createResourceRefRecord(ctx.orgId, channelId, ctx.userId, input));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.resource.added",
    user_ids: null,
    payload: { channel_id: channelId, resource_id: resource.id }
  }));
  return resource;
}

export async function deleteChannelResource(ctx: PlatformAuthContext, channelId: string, refId: string) {
  await requireChannelAccess(ctx, channelId, { write: true });
  return (await collaboration.deleteResourceRefRecord(ctx.orgId, channelId, refId));
}

export async function createActionItemFromMessage(ctx: PlatformAuthContext, messageId: string, input: JsonObject) {
  const message = (await readMessageRecord(ctx.orgId, messageId));
  if (!message) throw notFound("message_not_found", "This message does not exist.");
  const { channel } = await requireChannelAccess(ctx, message.channel_id);
  const operationId = cleanText(input.client_operation_id) || message.id;
  const { createCanonicalActionItem } = await import("../platform/api.js");
  const title = cleanText(input.title) || message.text.split(/\r?\n/).map(cleanText).find(Boolean)?.slice(0, 240) || "Message follow-up";
  const source = {
    source_type: "channel_message",
    channel_id: channel.id,
    message_id: message.id,
    thread_root_id: message.parent_id,
    project_id: channel.project_id
  };
  const actionItem = await createCanonicalActionItem(ctx.orgId, {
    id: `channel_todo_${operationId.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    title,
    body: cleanText(input.body) || `${message.text}\n\nSource message: ${message.id}`,
    due_at: input.due_at,
    priority: cleanText(input.priority) || "normal",
    assigned_user_ids: Array.isArray(input.assigned_user_ids) ? input.assigned_user_ids : [],
    project_ids: channel.project_id ? [channel.project_id] : [],
    source: "channels",
    payload: source,
    frontend_action: {
      kind: channel.type === "project" ? "open_project_message" : "open_channel_message",
      channel_id: channel.id,
      project_id: channel.project_id,
      message_id: message.id
    }
  }, ctx as unknown as Record<string, unknown>);
  const ref = (await collaboration.createResourceRefRecord(ctx.orgId, channel.id, ctx.userId, {
    resource_type: "action_item",
    resource_id: actionItem.id,
    source_message_id: message.id,
    relationship: "created_from"
  }));
  return { action_item: actionItem, resource_ref: ref };
}

export async function sidebarSections(ctx: PlatformAuthContext) {
  return (await collaboration.listSidebarSections(ctx.orgId, ctx.userId));
}

export async function saveSidebarSection(ctx: PlatformAuthContext, input: JsonObject) {
  return (await collaboration.saveSidebarSection(ctx.orgId, ctx.userId, input));
}

export async function deleteSidebarSection(ctx: PlatformAuthContext, id: string) {
  return (await collaboration.deleteSidebarSection(ctx.orgId, ctx.userId, id));
}

function huddleView(room: JsonObject): JsonObject {
  const settings = asObject(room.settings);
  const recordingMode = cleanText(room.recording_mode || "off");
  return {
    ...room,
    channel_id: cleanText(room.context_id),
    root_message_id: cleanText(room.thread_id) || null,
    recording_media_id: room.recording_media_id || null,
    settings: {
      ...settings,
      audio: true,
      video: room.allow_video !== false,
      recording_enabled: recordingMode !== "off",
      record_video: recordingMode === "video",
      recording_mode: recordingMode
    },
    signaling: room.connection || null
  };
}

export async function createHuddle(ctx: PlatformAuthContext, channelId: string, settings: JsonObject) {
  const { channel } = await requireChannelAccess(ctx, channelId, { write: true });
  let room = await calls.createRoom(ctx, {
    context_type: "channel",
    context_id: channelId,
    title: cleanText(channel.type === "project" ? channel.name || "Project huddle" : channel.name ? `#${channel.name} huddle` : "Channel huddle"),
    allow_video: settings.video !== false,
    recording_mode: settings.recording_enabled
      ? (settings.record_video === false ? "audio" : "video")
      : "off",
    settings
  }, { capabilityGroup: "channels" });
  if (!room.thread_id) {
    const systemMessage = (await createMessageRecord({
      organization_id: ctx.orgId,
      channel_id: channelId,
      author_id: ctx.userId,
      kind: "system",
      text: "Huddle started",
      metadata: { huddle_id: room.id, call_room_id: room.id, event: "huddle_started" }
    }));
    room = (await calls.setRoomThread(ctx, cleanText(room.id), systemMessage.id));
    (await publishMessageEvent("channels.message.created", channel, systemMessage, null));
    (await collaboration.recordChannelEventAttention(channel, systemMessage, "huddle_started"));
  }
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.huddle.started",
    user_ids: (await realtimeTargets(channel)),
    payload: { channel_id: channelId, huddle_id: room.id }
  }));
  return huddleView(room);
}

export async function getHuddle(ctx: PlatformAuthContext, huddleId: string) {
  const room = (await calls.getRoom(ctx, huddleId));
  if (cleanText(room.context_type) !== "channel") throw notFound("huddle_not_found", "This huddle does not exist.");
  await requireChannelAccess(ctx, cleanText(room.context_id));
  return huddleView(room);
}

export async function joinHuddle(ctx: PlatformAuthContext, huddleId: string) {
  const current = await getHuddle(ctx, huddleId);
  const room = await calls.joinRoom(ctx, huddleId);
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.huddle.participant_updated",
    user_ids: null,
    payload: { channel_id: current.channel_id, huddle_id: huddleId, user_id: ctx.userId, state: "joined" }
  }));
  return huddleView(room);
}

export async function updateHuddleMediaState(
  ctx: PlatformAuthContext,
  huddleId: string,
  state: { microphone_enabled?: boolean; camera_enabled?: boolean; screen_enabled?: boolean }
) {
  await getHuddle(ctx, huddleId);
  const room = (await calls.updateMediaState(ctx, huddleId, state));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.huddle.participant_updated",
    user_ids: null,
    payload: {
      channel_id: room.context_id,
      huddle_id: huddleId,
      user_id: ctx.userId,
      state: "media",
      media: state
    }
  }));
  return huddleView(room);
}

export async function leaveHuddle(ctx: PlatformAuthContext, huddleId: string) {
  const current = await getHuddle(ctx, huddleId);
  const room = (await calls.leaveRoom(ctx, huddleId));
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.huddle.participant_updated",
    user_ids: null,
    payload: { channel_id: current.channel_id, huddle_id: huddleId, user_id: ctx.userId, state: "left" }
  }));
  return huddleView(room);
}

export async function removeHuddleParticipant(ctx: PlatformAuthContext, huddleId: string, userId: string) {
  const current = await getHuddle(ctx, huddleId);
  const room = await calls.removeParticipant(ctx, huddleId, userId);
  (await publishRealtimeEvent({ organization_id:ctx.orgId, topic:"channels.huddle.participant_updated", payload:{ channel_id:current.channel_id, huddle_id:huddleId, user_id:userId, state:"removed" } }));
  return huddleView(room);
}

export async function endHuddle(ctx: PlatformAuthContext, huddleId: string) {
  const current = await getHuddle(ctx, huddleId);
  const room = await calls.endRoom(ctx, huddleId);
  const channel = (await readChannelRecord(ctx.orgId, cleanText(current.channel_id)));
  if (channel) {
    const endedMessage = (await createMessageRecord({
      organization_id: ctx.orgId,
      channel_id: channel.id,
      author_id: ctx.userId,
      kind: "system",
      text: "Huddle ended",
      parent_id: cleanText(current.root_message_id) || null,
      metadata: { huddle_id: huddleId, call_room_id: huddleId, event: "huddle_ended" }
    }));
    (await publishMessageEvent("channels.message.created", channel, endedMessage, null));
    (await collaboration.recordChannelEventAttention(channel, endedMessage, "huddle_ended"));
  }
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.huddle.ended",
    user_ids: null,
    payload: { channel_id: current.channel_id, huddle_id: huddleId }
  }));
  return huddleView(room);
}

export async function saveHuddleRecording(ctx: PlatformAuthContext, huddleId: string, attachmentId: string) {
  const huddle = await getHuddle(ctx, huddleId);
  if (cleanText(huddle.started_by) !== ctx.userId) {
    throw forbidden("huddle_recording_owner_required", "Only the person who started this huddle can save its recording.");
  }
  const attachment = (await readAttachmentRecord(ctx.orgId, attachmentId));
  if (!attachment || cleanText(attachment.channel_id) !== cleanText(huddle.channel_id)) {
    throw badRequest("invalid_huddle_recording", "This recording upload does not belong to the huddle channel.");
  }
  if (cleanText(attachment.uploaded_by) !== ctx.userId) {
    throw forbidden("huddle_recording_uploader_required", "Only the recording uploader can attach it to this huddle.");
  }
  const kind = cleanText(attachment.content_type).startsWith("video/") ? "video_recording" : "audio_recording";
  const existingArtifacts = (await calls.listArtifacts(ctx, huddleId));
  if (existingArtifacts.some((item) => cleanText(item.attachment_id) === attachmentId)) {
    return { huddle, message: null, artifact: existingArtifacts.find((item) => cleanText(item.attachment_id) === attachmentId), deduplicated: true };
  }
  const artifact = (await calls.saveArtifact(ctx, huddleId, {
    kind,
    media_id: cleanText(attachment.media_id),
    attachment_id: attachmentId,
    content_type: cleanText(attachment.content_type)
  }));
  const posted = await postMessage(ctx, cleanText(huddle.channel_id), {
    text: kind === "video_recording" ? "Huddle video recording" : "Huddle audio recording",
    parent_id: cleanText(huddle.root_message_id) || undefined,
    attachment_ids: [attachmentId],
    metadata: {
      event: "huddle_recording",
      huddle_id: huddleId,
      call_room_id: huddleId,
      artifact_id: artifact.id,
      recording_kind: kind
    }
  });
  return { huddle: { ...huddle, recording_media_id: attachment.media_id }, message: posted.message, artifact, deduplicated: false };
}

export async function postHuddleSignal(
  ctx: PlatformAuthContext,
  huddleId: string,
  body: { sender_peer_id: string; target_peer_id?: string; kind: string; payload: JsonObject }
) {
  await getHuddle(ctx, huddleId);
  return (await calls.postSignal(ctx, huddleId, body));
}

export async function listHuddleSignals(ctx: PlatformAuthContext, huddleId: string, afterSeq: number, peerId: string) {
  await getHuddle(ctx, huddleId);
  return (await calls.listSignals(ctx, huddleId, afterSeq, peerId));
}

// --- typing -------------------------------------------------------------------

export async function noteTyping(ctx: PlatformAuthContext, channelId: string) {
  const { channel } = await requireChannelAccess(ctx, channelId, { write: true });
  let orgTyping = typingState.get(ctx.orgId);
  if (!orgTyping) {
    orgTyping = new Map();
    typingState.set(ctx.orgId, orgTyping);
  }
  let channelTyping = orgTyping.get(channelId);
  if (!channelTyping) {
    channelTyping = new Map();
    orgTyping.set(channelId, channelTyping);
  }
  const now = Date.now();
  channelTyping.set(ctx.userId, now + TYPING_TTL_MS);
  for (const [userId, expires] of channelTyping) {
    if (expires < now) channelTyping.delete(userId);
  }
  const directory = await userDirectory(ctx.orgId);
  (await publishRealtimeEvent({
    organization_id: ctx.orgId,
    topic: "channels.typing",
    user_ids: (await realtimeTargets(channel)),
    payload: {
      channel_id: channelId,
      user_id: ctx.userId,
      user_name: directory.get(ctx.userId)?.name ?? "Someone",
      expires_in_ms: TYPING_TTL_MS
    }
  }));
  return { ok: true };
}

// --- search -------------------------------------------------------------------

export async function searchMessages(ctx: PlatformAuthContext, query: string, options: { channelId?: string; limit?: number }) {
  const operators: Record<string, string[]> = {};
  const terms = query.replace(/\b(from|in|before|after|has|is):(?:"([^"]+)"|(\S+))/gi, (_match, key, quoted, bare) => {
    (operators[String(key).toLowerCase()] ||= []).push(cleanText(quoted || bare).toLowerCase());
    return " ";
  }).replace(/\s+/g, " ").trim();
  const groups = viewerAudienceGroups(ctx);
  const membershipIds = new Set((await listMembershipChannelIds(ctx.orgId, ctx.userId)));
  const canSeeProjects = canAccessProjectChannels(ctx);
  const accessible = (await listChannelRecords(ctx.orgId, { includeArchived: true })).filter((channel) => {
    if (options.channelId && channel.id !== options.channelId) return false;
    if (operators.in?.length && !operators.in.some((value) => {
      const normalized = value.replace(/^#/, "");
      return channel.id === value || channel.name.toLowerCase() === normalized;
    })) return false;
    if (isPrivateType(channel)) return membershipIds.has(channel.id);
    if (channel.type === "project") return canSeeProjects;
    return true;
  });
  const channelsById = new Map(accessible.map((channel) => [channel.id, channel]));
  const resultLimit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
  const candidates = terms
    ? (await searchMessageRecords(ctx.orgId, terms, { channelIds: [...channelsById.keys()], limit: Math.min(resultLimit * 5, 100) }))
    : (await Promise.all([...channelsById.keys()].map(async (channelId) => (await listMessageRecords(ctx.orgId, channelId, { limit: 100 }))))).flat()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const fromFilters = operators.from || [];
  const directory = fromFilters.length ? await userDirectory(ctx.orgId) : new Map<string, UserProfile>();
  const authorIds = fromFilters.length
    ? new Set([...directory.values()]
      .filter((user) => fromFilters.some((value) => user.id === value || user.name.toLowerCase().includes(value) || user.email.includes(value)))
      .map((user) => user.id))
    : null;
  const before = operators.before?.[0] ? Date.parse(operators.before[0]) : Number.NaN;
  const after = operators.after?.[0] ? Date.parse(operators.after[0]) : Number.NaN;
  const matches = candidates.filter((message) => {
    if (!channelsById.has(message.channel_id) || !messageVisibleTo(message, ctx, groups)) return false;
    if (authorIds && !authorIds.has(message.author_id)) return false;
    const created = Date.parse(message.created_at);
    if (Number.isFinite(before) && created >= before) return false;
    if (Number.isFinite(after) && created < after) return false;
    if (operators.has?.includes("link") && !/https?:\/\//i.test(message.text)) return false;
    if (operators.is?.includes("pinned") && !message.pinned_at) return false;
    return true;
  });
  const savedIds = operators.is?.includes("saved") ? new Set((await listSavedMessageIds(ctx.orgId, ctx.userId))) : null;
  const results: JsonObject[] = [];
  for (const message of matches) {
    const channel = channelsById.get(message.channel_id)!;
    const [hydrated] = await hydrateMessages(ctx, channel, [message]);
    if (!hydrated) continue;
    const attachments = Array.isArray(hydrated.attachments) ? hydrated.attachments : [];
    const reactions = Array.isArray(hydrated.reactions) ? hydrated.reactions : [];
    if (operators.has?.includes("file") && !attachments.length) continue;
    if (operators.has?.includes("reaction") && !reactions.length) continue;
    if (savedIds && !savedIds.has(message.id)) continue;
    results.push({ ...hydrated, channel: { id: channel.id, name: channel.name, type: channel.type, project_id: channel.project_id } });
    if (results.length >= resultLimit) break;
  }
  return results;
}

// --- mention notifications ------------------------------------------------------

async function notifyMentions(ctx: PlatformAuthContext, channel: ChannelRow, message: MessageRow, alreadyNotified = new Set<string>()) {
  const mentioned = [...new Set(
    message.mention_users
      .map((user) => cleanText(user.id || user.user_id))
      .filter((id) => id && id !== ctx.userId && !alreadyNotified.has(id))
  )];
  const targets: string[] = [];
  for (const userId of mentioned) {
    const preferences = await collaboration.readCollaborationPreferences(ctx.orgId, userId);
    if (asObject(preferences.dnd).enabled === true) continue;
    const memberLevel = (await readChannelMember(channel.id, userId))?.notify_level;
    if (cleanText(memberLevel || preferences.default_notify_level) !== "muted") targets.push(userId);
  }
  if (!targets.length) return;
  try {
    const { createPlatformNotification } = await import("../platform/api.js");
    const actorName = cleanText(ctx.identity.name || ctx.identity.display_name || ctx.identity.email) || "A teammate";
    const frontendAction = channel.type === "project"
      ? { kind: "open_project_message", project_id: channel.project_id, channel_id: channel.id, message_id: message.id, parent_id: message.parent_id }
      : { kind: "open_channel_message", channel_id: channel.id, message_id: message.id, parent_id: message.parent_id };
    await createPlatformNotification(ctx.orgId, {
      id: `notification_mention_${message.id}_${message.edited_at ? "edit" : "post"}`,
      title: `${actorName} mentioned you`,
      body: message.text.length > 140 ? `${message.text.slice(0, 137)}...` : message.text,
      status: "active",
      channel: "passive",
      kind: "mention",
      push: true,
      passive: true,
      manual_dismissible: true,
      target_user_ids: targets,
      branch_id: ctx.branchId || "default",
      source: channel.type === "project" ? "project_message" : "channel_message",
      frontend_action: frontendAction,
      context: {
        channel_id: channel.id,
        channel_type: channel.type,
        project_id: channel.project_id,
        message_id: message.id,
        actor_user_id: ctx.userId
      }
    });
    (await publishRealtimeEvent({
      organization_id: ctx.orgId,
      topic: "channels.unreads.changed",
      user_ids: targets,
      payload: { channel_id: channel.id }
    }));
  } catch {
    /* notifications are best-effort */
  }
}

async function notifyMessageSubscribers(ctx: PlatformAuthContext, channel: ChannelRow, message: MessageRow) {
  const mentioned = new Set(message.mention_users.map((user) => cleanText(user.id || user.user_id)).filter(Boolean));
  const targets: string[] = [];
  for (const { user_id: userId } of await listChannelMembers(channel.id)) {
    if (!userId || userId === ctx.userId || mentioned.has(userId)) continue;
    const preferences = await collaboration.readCollaborationPreferences(ctx.orgId, userId);
    if (asObject(preferences.dnd).enabled === true) continue;
    const member = await readChannelMember(channel.id, userId);
    const effective = cleanText(member?.notify_level || preferences.default_notify_level);
    if (["dm", "group_dm"].includes(channel.type) ? effective !== "muted" : effective === "all") targets.push(userId);
  }
  if (!targets.length) return;
  try {
    const { createPlatformNotification } = await import("../platform/api.js");
    const actorName = cleanText(ctx.identity.name || ctx.identity.display_name || ctx.identity.email) || "A teammate";
    await createPlatformNotification(ctx.orgId, {
      id: `notification_channel_${message.id}`,
      title: channel.type === "dm" || channel.type === "group_dm"
        ? `${actorName} sent a message`
        : `${actorName} posted in #${channel.name}`,
      body: message.text.length > 160 ? `${message.text.slice(0, 157)}...` : message.text,
      status: "active",
      channel: "passive",
      kind: "channel_message",
      push: true,
      passive: true,
      manual_dismissible: true,
      target_user_ids: targets,
      branch_id: ctx.branchId || "default",
      source: channel.type === "project" ? "project_message" : "channel_message",
      frontend_action: channel.type === "project"
        ? { kind: "open_project_message", project_id: channel.project_id, channel_id: channel.id, message_id: message.id, parent_id: message.parent_id }
        : { kind: "open_channel_message", channel_id: channel.id, message_id: message.id, parent_id: message.parent_id },
      context: { channel_id: channel.id, message_id: message.id, actor_user_id: ctx.userId }
    });
  } catch {
    /* push delivery is best effort; Activity remains durable */
  }
}
