import { randomUUID } from "node:crypto";

import { badRequest, notFound } from "../platform/errors.js";
import {
  getChannelsDatabase,
  listChannelMembers,
  readMessageRecord,
  type ChannelRow,
  type JsonObject,
  type MessageRow
} from "./storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseJson(value: unknown, fallback: unknown) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function rowObject(row: JsonObject) {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(row)) result[key] = value;
  return result;
}

// --- read state and attention ------------------------------------------------

export async function markUnreadRecord(orgId: string, channelId: string, userId: string, seq: number) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const target = Math.max(1, Math.floor(Number(seq) || 1));
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_read_state
      (organization_id, channel_id, user_id, last_read_seq, manual_unread_seq, version, last_read_at)
    VALUES (?, ?, ?, 0, ?, 1, ?)
    ON CONFLICT (channel_id, user_id) DO UPDATE SET
      manual_unread_seq = excluded.manual_unread_seq,
      version = channel_read_state.version + 1,
      last_read_at = excluded.last_read_at
  `).run(orgId, channelId, userId, target, now));
  return (await readStateRecord(channelId, userId));

  }));
}

export async function readStateRecord(channelId: string, userId: string) {
  const row = (await getChannelsDatabase().prepare(`
    SELECT last_read_seq, manual_unread_seq, version, last_read_at
    FROM channel_read_state WHERE channel_id = ? AND user_id = ?
  `).get(channelId, userId)) as JsonObject | undefined;
  const lastRead = Number(row?.last_read_seq ?? 0);
  const manual = row?.manual_unread_seq == null ? null : Number(row.manual_unread_seq);
  return {
    last_read_seq: lastRead,
    manual_unread_seq: manual,
    effective_read_seq: manual == null ? lastRead : Math.min(lastRead, Math.max(0, manual - 1)),
    version: Number(row?.version ?? 0),
    last_read_at: row?.last_read_at ? String(row.last_read_at) : null
  };
}

export async function markAllReadRecords(orgId: string, userId: string, channels: ChannelRow[]) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const snapshot = (await Promise.all(channels.map(async (channel) => ({
    channel_id: channel.id,
    ...(await readStateRecord(channel.id, userId))
  }))));
  const operationId = `readop_${randomUUID()}`;
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 30_000).toISOString();
  await db.transaction(async () => {
    for (const channel of channels) {
      (await db.prepare(`
        INSERT INTO channel_read_state
          (organization_id, channel_id, user_id, last_read_seq, manual_unread_seq, version, last_read_at)
        VALUES (?, ?, ?, ?, NULL, 1, ?)
        ON CONFLICT (channel_id, user_id) DO UPDATE SET
          last_read_seq = CASE WHEN channel_read_state.last_read_seq > excluded.last_read_seq THEN channel_read_state.last_read_seq ELSE excluded.last_read_seq END,
          manual_unread_seq = NULL,
          version = channel_read_state.version + 1,
          last_read_at = excluded.last_read_at
      `).run(orgId, channel.id, userId, channel.message_seq, now));
      (await db.prepare("DELETE FROM message_mentions WHERE organization_id = ? AND channel_id = ? AND user_id = ?")
        .run(orgId, channel.id, userId));
    }
    (await db.prepare(`
      INSERT INTO channel_read_operations (id, organization_id, user_id, snapshot_json, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(operationId, orgId, userId, json(snapshot), expiresAt, now));
  });
  return { operation_id: operationId, expires_at: expiresAt };

  }));
}

export async function undoReadOperation(orgId: string, userId: string, operationId: string) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const operation = (await db.prepare(`
    SELECT * FROM channel_read_operations WHERE id = ? AND organization_id = ? AND user_id = ?
  `).get(operationId, orgId, userId)) as JsonObject | undefined;
  if (!operation) throw notFound("read_operation_not_found", "This read operation is no longer available.");
  if (Date.parse(String(operation.expires_at)) < Date.now()) {
    (await db.prepare("DELETE FROM channel_read_operations WHERE id = ?").run(operationId));
    throw badRequest("read_operation_expired", "The undo period has expired.");
  }
  const snapshot = parseJson(operation.snapshot_json, []) as JsonObject[];
  await db.transaction(async () => {
    for (const state of snapshot) {
      (await db.prepare(`
        INSERT INTO channel_read_state
          (organization_id, channel_id, user_id, last_read_seq, manual_unread_seq, version, last_read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (channel_id, user_id) DO UPDATE SET
          last_read_seq = excluded.last_read_seq,
          manual_unread_seq = excluded.manual_unread_seq,
          version = channel_read_state.version + 1,
          last_read_at = excluded.last_read_at
      `).run(
        orgId,
        cleanText(state.channel_id),
        userId,
        Number(state.last_read_seq) || 0,
        state.manual_unread_seq == null ? null : Number(state.manual_unread_seq),
        Math.max(1, Number(state.version) || 1),
        cleanText(state.last_read_at) || nowIso()
      ));
    }
    (await db.prepare("DELETE FROM channel_read_operations WHERE id = ?").run(operationId));
  });
  return { restored: snapshot.length };

  }));
}

export async function setThreadSubscriptionRecord(
  orgId: string,
  channelId: string,
  rootMessageId: string,
  userId: string,
  following: boolean,
  notifyLevel = "all"
) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_thread_subscriptions
      (organization_id, channel_id, root_message_id, user_id, following, notify_level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (root_message_id, user_id) DO UPDATE SET
      following = excluded.following,
      notify_level = excluded.notify_level,
      version = channel_thread_subscriptions.version + 1,
      updated_at = excluded.updated_at
  `).run(orgId, channelId, rootMessageId, userId, following ? 1 : 0, notifyLevel, now, now));
  return (await threadSubscriptionRecord(rootMessageId, userId));

  }));
}

export async function threadSubscriptionRecord(rootMessageId: string, userId: string) {
  const row = (await getChannelsDatabase().prepare(`
    SELECT * FROM channel_thread_subscriptions WHERE root_message_id = ? AND user_id = ?
  `).get(rootMessageId, userId)) as JsonObject | undefined;
  return row ? {
    ...rowObject(row),
    following: Number(row.following) === 1,
    last_read_reply_seq: Number(row.last_read_reply_seq) || 0,
    manual_unread_reply_seq: row.manual_unread_reply_seq == null ? null : Number(row.manual_unread_reply_seq),
    version: Number(row.version) || 1
  } : null;
}

export async function listThreadSubscriptionRows(orgId: string, userId: string): Promise<JsonObject[]> {
  return ((await getChannelsDatabase().prepare(`
    SELECT s.*, root.text AS root_text, root.author_id AS root_author_id,
      root.reply_count, root.last_reply_at, root.created_at AS root_created_at
    FROM channel_thread_subscriptions s
    JOIN messages root ON root.id = s.root_message_id
    WHERE s.organization_id = ? AND s.user_id = ? AND s.following = 1 AND root.deleted_at IS NULL
    ORDER BY COALESCE(root.last_reply_at, root.created_at) DESC
  `).all(orgId, userId)) as JsonObject[]).map((row) => ({
    ...rowObject(row),
    following: true,
    reply_count: Number(row.reply_count) || 0
  }));
}

export async function listParticipatedThreadRows(orgId: string, userId: string): Promise<JsonObject[]> {
  return ((await getChannelsDatabase().prepare(`
    SELECT DISTINCT root.id AS root_message_id, root.channel_id,
      root.text AS root_text, root.author_id AS root_author_id,
      root.reply_count, root.last_reply_at, root.created_at AS root_created_at,
      COALESCE(s.following, 0) AS following,
      COALESCE(s.notify_level, 'all') AS notify_level,
      COALESCE(s.last_read_reply_seq, 0) AS last_read_reply_seq
    FROM messages root
    LEFT JOIN channel_thread_subscriptions s
      ON s.root_message_id = root.id AND s.user_id = ? AND s.organization_id = ?
    WHERE root.organization_id = ?
      AND root.parent_id IS NULL
      AND root.deleted_at IS NULL
      AND root.reply_count > 0
      AND (
        root.author_id = ?
        OR s.following = 1
        OR EXISTS (
          SELECT 1 FROM messages reply
          WHERE reply.parent_id = root.id AND reply.author_id = ? AND reply.deleted_at IS NULL
        )
      )
    ORDER BY COALESCE(root.last_reply_at, root.created_at) DESC
    LIMIT 200
  `).all(userId, orgId, orgId, userId, userId)) as JsonObject[]).map((row) => ({
    ...rowObject(row),
    following: Number(row.following) === 1,
    reply_count: Number(row.reply_count) || 0,
    last_read_reply_seq: Number(row.last_read_reply_seq) || 0
  }));
}

export async function markThreadReadRecord(orgId: string, userId: string, rootMessageId: string, lastReplySeq: number) {
  return (await getChannelsDatabase().transaction(async () => {
  const current = (await threadSubscriptionRecord(rootMessageId, userId));
  if (!current) {
    const root = (await readMessageRecord(orgId, rootMessageId));
    if (!root) throw notFound("message_not_found", "This thread does not exist.");
    (await setThreadSubscriptionRecord(orgId, root.channel_id, rootMessageId, userId, true, "all"));
  }
  (await getChannelsDatabase().prepare(`
    UPDATE channel_thread_subscriptions
    SET last_read_reply_seq = CASE WHEN last_read_reply_seq > ? THEN last_read_reply_seq ELSE ? END, manual_unread_reply_seq = NULL,
      version = version + 1, updated_at = ?
    WHERE organization_id = ? AND user_id = ? AND root_message_id = ?
  `).run(Math.max(0, Number(lastReplySeq) || 0), Math.max(0, Number(lastReplySeq) || 0), nowIso(), orgId, userId, rootMessageId));
  return (await threadSubscriptionRecord(rootMessageId, userId));

  }));
}

export async function recordAttentionForMessage(channel: ChannelRow, message: MessageRow) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const targets = new Map<string, string>();
  if (channel.type === "dm" || channel.type === "group_dm") {
    for (const member of (await listChannelMembers(channel.id))) {
      if (member.user_id !== message.author_id) targets.set(member.user_id, "direct_message");
    }
  }
  for (const mentioned of message.mention_users) {
    const userId = cleanText(mentioned.id || mentioned.user_id);
    if (userId && userId !== message.author_id) targets.set(userId, "mention");
  }
  if (message.parent_id) {
    const root = (await readMessageRecord(channel.organization_id, message.parent_id));
    if (root?.author_id && root.author_id !== message.author_id && !targets.has(root.author_id)) {
      targets.set(root.author_id, "thread_reply");
    }
    const followers = (await db.prepare(`
      SELECT user_id FROM channel_thread_subscriptions
      WHERE root_message_id = ? AND following = 1 AND user_id <> ?
    `).all(message.parent_id, message.author_id)) as JsonObject[];
    for (const follower of followers) {
      const userId = cleanText(follower.user_id);
      if (userId && !targets.has(userId)) targets.set(userId, "thread_reply");
    }
  }
  const now = nowIso();
  for (const [recipient, kind] of targets) {
    const dedupeKey = `${kind}:${message.id}`;
    (await db.prepare(`
      INSERT INTO channel_attention_items
        (id, organization_id, recipient_user_id, kind, channel_id, message_id, root_message_id,
         actor_user_id, dedupe_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`).run(
      `attention_${randomUUID()}`,
      channel.organization_id,
      recipient,
      kind,
      channel.id,
      message.id,
      message.parent_id,
      message.author_id,
      dedupeKey,
      now,
      now
    ));
  }
  return targets;

  }));
}

export async function recordReactionAttention(orgId: string, message: MessageRow, actorUserId: string, emoji: string) {
  return (await getChannelsDatabase().transaction(async () => {
  if (!message.author_id || message.author_id === actorUserId) return;
  const now = nowIso();
  (await getChannelsDatabase().prepare(`
    INSERT INTO channel_attention_items
      (id, organization_id, recipient_user_id, kind, channel_id, message_id, root_message_id,
       actor_user_id, dedupe_key, created_at, updated_at)
    VALUES (?, ?, ?, 'reaction', ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT DO NOTHING`).run(
    `attention_${randomUUID()}`,
    orgId,
    message.author_id,
    message.channel_id,
    message.id,
    message.parent_id,
    actorUserId,
    `reaction:${message.id}:${actorUserId}:${emoji}`,
    now,
    now
  ));

  }));
}

export async function recordChannelEventAttention(channel: ChannelRow, message: MessageRow, kind: "huddle_started" | "huddle_ended") {
  return (await getChannelsDatabase().transaction(async () => {
  const now = nowIso();
  const db = getChannelsDatabase();
  const recipients = new Set((await listChannelMembers(channel.id)).map((member) => member.user_id).filter(Boolean));
  recipients.add(message.author_id);
  for (const userId of recipients) {
    (await db.prepare(`
      INSERT INTO channel_attention_items
        (id, organization_id, recipient_user_id, kind, channel_id, message_id, root_message_id,
         actor_user_id, dedupe_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`).run(
      `attention_${randomUUID()}`,
      channel.organization_id,
      userId,
      kind,
      channel.id,
      message.id,
      message.parent_id,
      message.author_id,
      `${kind}:${message.id}:${userId}`,
      now,
      now
    ));
  }

  }));
}

export async function listAttentionRows(orgId: string, userId: string, options: { kind?: string; unreadOnly?: boolean; limit?: number } = {}) {
  const clauses = ["a.organization_id = ?", "a.recipient_user_id = ?", "a.cleared_at IS NULL"];
  const params: unknown[] = [orgId, userId];
  if (cleanText(options.kind)) {
    clauses.push("a.kind = ?");
    params.push(cleanText(options.kind));
  }
  if (options.unreadOnly) clauses.push("a.read_at IS NULL");
  params.push(Math.min(Math.max(Number(options.limit) || 100, 1), 200));
  return ((await getChannelsDatabase().prepare(`
    SELECT a.*, m.text, m.created_at AS message_created_at, c.name AS channel_name,
      c.type AS channel_type, c.project_id
    FROM channel_attention_items a
    LEFT JOIN messages m ON m.id = a.message_id
    JOIN channels c ON c.id = a.channel_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY a.created_at DESC LIMIT ?
  `).all(...(params as string[]))) as JsonObject[]).map(rowObject);
}

export async function updateAttentionRecord(orgId: string, userId: string, itemId: string, patch: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const row = (await db.prepare(`
    SELECT * FROM channel_attention_items WHERE id = ? AND organization_id = ? AND recipient_user_id = ?
  `).get(itemId, orgId, userId)) as JsonObject | undefined;
  if (!row) throw notFound("attention_item_not_found", "This activity item does not exist.");
  const now = nowIso();
  const readAt: string | null = Object.prototype.hasOwnProperty.call(patch, "read")
    ? (patch.read === true ? now : null)
    : (cleanText(row.read_at) || null);
  const clearedAt: string | null = patch.cleared === true ? now : (cleanText(row.cleared_at) || null);
  const snoozedUntil: string | null = Object.prototype.hasOwnProperty.call(patch, "snoozed_until")
    ? cleanText(patch.snoozed_until) || null
    : cleanText(row.snoozed_until) || null;
  (await db.prepare(`
    UPDATE channel_attention_items SET read_at = ?, cleared_at = ?, snoozed_until = ?, updated_at = ?
    WHERE id = ?
  `).run(readAt, clearedAt, snoozedUntil, now, itemId));
  return rowObject((await db.prepare("SELECT * FROM channel_attention_items WHERE id = ?").get(itemId)) as JsonObject);

  }));
}

export async function markAllAttentionReadRecords(orgId: string, userId: string) {
  return (await getChannelsDatabase().transaction(async () => {
  const now = nowIso();
  const result = (await getChannelsDatabase().prepare(`
    UPDATE channel_attention_items SET read_at = COALESCE(read_at, ?), updated_at = ?
    WHERE organization_id = ? AND recipient_user_id = ? AND cleared_at IS NULL
  `).run(now, now, orgId, userId));
  return { updated: Number(result.changes), read_at: now };

  }));
}

// --- preferences, drafts, and scheduled messages -----------------------------

const DEFAULT_PREFERENCES = {
  default_notify_level: "mentions",
  keywords: [],
  dnd: { enabled: false, start: "22:00", end: "08:00", timezone: "local" },
  send_mode: "enter",
  notification_previews: true,
  huddle_invites: true
};

export async function readCollaborationPreferences(orgId: string, userId: string) {
  const row = (await getChannelsDatabase().prepare(`
    SELECT preferences_json, version, updated_at FROM channel_user_preferences
    WHERE organization_id = ? AND user_id = ?
  `).get(orgId, userId)) as JsonObject | undefined;
  return {
    ...DEFAULT_PREFERENCES,
    ...(parseJson(row?.preferences_json, {}) as JsonObject),
    version: Number(row?.version ?? 0),
    updated_at: row?.updated_at ? String(row.updated_at) : null
  };
}

export async function saveCollaborationPreferences(orgId: string, userId: string, patch: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const { version: _version, updated_at: _updatedAt, ...current } = (await readCollaborationPreferences(orgId, userId));
  const next = { ...current, ...patch };
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_user_preferences (organization_id, user_id, preferences_json, version, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT (organization_id, user_id) DO UPDATE SET
      preferences_json = excluded.preferences_json,
      version = channel_user_preferences.version + 1,
      updated_at = excluded.updated_at
  `).run(orgId, userId, json(next), now));
  return (await readCollaborationPreferences(orgId, userId));

  }));
}

export async function readDraftRecord(orgId: string, userId: string, draftKey: string) {
  const row = (await getChannelsDatabase().prepare(`
    SELECT * FROM channel_drafts WHERE organization_id = ? AND user_id = ? AND draft_key = ?
  `).get(orgId, userId, draftKey)) as JsonObject | undefined;
  if (!row || row.deleted_at) return null;
  return {
    ...rowObject(row),
    content: parseJson(row.content_json, {}),
    attachment_ids: parseJson(row.attachment_ids_json, []),
    revision: Number(row.revision) || 1
  };
}

export async function saveDraftRecord(orgId: string, userId: string, draftKey: string, input: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_drafts
      (organization_id, user_id, draft_key, channel_id, root_message_id, content_json, text,
       attachment_ids_json, revision, deleted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
    ON CONFLICT (organization_id, user_id, draft_key) DO UPDATE SET
      channel_id = excluded.channel_id,
      root_message_id = excluded.root_message_id,
      content_json = excluded.content_json,
      text = excluded.text,
      attachment_ids_json = excluded.attachment_ids_json,
      revision = channel_drafts.revision + 1,
      deleted_at = NULL,
      updated_at = excluded.updated_at
  `).run(
    orgId,
    userId,
    draftKey,
    cleanText(input.channel_id),
    cleanText(input.root_message_id) || null,
    json(input.content),
    String(input.text ?? ""),
    json(Array.isArray(input.attachment_ids) ? input.attachment_ids : []),
    now,
    now
  ));
  return (await readDraftRecord(orgId, userId, draftKey));

  }));
}

export async function deleteDraftRecord(orgId: string, userId: string, draftKey: string) {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase().prepare(`
    UPDATE channel_drafts SET deleted_at = ?, revision = revision + 1, updated_at = ?
    WHERE organization_id = ? AND user_id = ? AND draft_key = ?
  `).run(nowIso(), nowIso(), orgId, userId, draftKey));
  return { deleted: true };

  }));
}

export async function listScheduledRecords(orgId: string, userId: string): Promise<JsonObject[]> {
  return ((await getChannelsDatabase().prepare(`
    SELECT * FROM channel_scheduled_messages
    WHERE organization_id = ? AND sender_user_id = ? AND state <> 'cancelled'
    ORDER BY scheduled_at ASC
  `).all(orgId, userId)) as JsonObject[]).map(scheduledRow);
}

function scheduledRow(row: JsonObject): JsonObject {
  return {
    ...rowObject(row),
    content: parseJson(row.content_json, {}),
    attachment_ids: parseJson(row.attachment_ids_json, []),
    metadata: parseJson(row.metadata_json, {})
  };
}

export async function createScheduledRecord(orgId: string, userId: string, input: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const clientOperationId = cleanText(input.client_operation_id) || null;
  if (clientOperationId) {
    const existing = (await db.prepare(`
      SELECT * FROM channel_scheduled_messages
      WHERE organization_id = ? AND sender_user_id = ? AND client_operation_id = ?
    `).get(orgId, userId, clientOperationId)) as JsonObject | undefined;
    if (existing) return scheduledRow(existing);
  }
  const id = `scheduled_${randomUUID()}`;
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_scheduled_messages
      (id, organization_id, channel_id, root_message_id, sender_user_id, text, content_json,
       attachment_ids_json, metadata_json, scheduled_at, timezone, state, client_operation_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
  `).run(
    id,
    orgId,
    cleanText(input.channel_id),
    cleanText(input.root_message_id) || null,
    userId,
    String(input.text ?? ""),
    json(input.content),
    json(Array.isArray(input.attachment_ids) ? input.attachment_ids : []),
    json(input.metadata),
    cleanText(input.scheduled_at),
    cleanText(input.timezone) || "UTC",
    clientOperationId,
    now,
    now
  ));
  return scheduledRow((await db.prepare("SELECT * FROM channel_scheduled_messages WHERE id = ?").get(id)) as JsonObject);

  }));
}

export async function updateScheduledRecord(orgId: string, userId: string, id: string, patch: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const current = (await db.prepare(`
    SELECT * FROM channel_scheduled_messages WHERE id = ? AND organization_id = ? AND sender_user_id = ?
  `).get(id, orgId, userId)) as JsonObject | undefined;
  if (!current) throw notFound("scheduled_message_not_found", "This scheduled message does not exist.");
  if (!["scheduled", "failed"].includes(cleanText(current.state))) {
    throw badRequest("scheduled_message_locked", "This scheduled message can no longer be changed.");
  }
  (await db.prepare(`
    UPDATE channel_scheduled_messages SET text = ?, content_json = ?, attachment_ids_json = ?,
      metadata_json = ?, scheduled_at = ?, timezone = ?, state = 'scheduled', failure_reason = NULL, updated_at = ?
    WHERE id = ?
  `).run(
    Object.prototype.hasOwnProperty.call(patch, "text") ? String(patch.text ?? "") : String(current.text),
    Object.prototype.hasOwnProperty.call(patch, "content") ? json(patch.content) : String(current.content_json),
    Object.prototype.hasOwnProperty.call(patch, "attachment_ids") ? json(patch.attachment_ids) : String(current.attachment_ids_json),
    Object.prototype.hasOwnProperty.call(patch, "metadata") ? json(patch.metadata) : String(current.metadata_json),
    cleanText(patch.scheduled_at) || String(current.scheduled_at),
    cleanText(patch.timezone) || String(current.timezone),
    nowIso(),
    id
  ));
  return scheduledRow((await db.prepare("SELECT * FROM channel_scheduled_messages WHERE id = ?").get(id)) as JsonObject);

  }));
}

export async function cancelScheduledRecord(orgId: string, userId: string, id: string) {
  return (await getChannelsDatabase().transaction(async () => {
  const result = (await getChannelsDatabase().prepare(`
    UPDATE channel_scheduled_messages SET state = 'cancelled', updated_at = ?
    WHERE id = ? AND organization_id = ? AND sender_user_id = ? AND state IN ('scheduled', 'failed')
  `).run(nowIso(), id, orgId, userId));
  if (!Number(result.changes)) throw notFound("scheduled_message_not_found", "This scheduled message cannot be cancelled.");
  return { cancelled: true };

  }));
}

export async function saveMessageReminderRecord(orgId: string, userId: string, messageId: string, remindAt: string): Promise<JsonObject> {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const id = `reminder_${randomUUID()}`;
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_message_reminders
      (id, organization_id, user_id, message_id, remind_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT (organization_id, user_id, message_id) DO UPDATE SET
      remind_at = excluded.remind_at, status = 'pending', updated_at = excluded.updated_at
  `).run(id, orgId, userId, messageId, remindAt, now, now));
  return rowObject((await db.prepare(`
    SELECT * FROM channel_message_reminders
    WHERE organization_id = ? AND user_id = ? AND message_id = ?
  `).get(orgId, userId, messageId)) as JsonObject);

  }));
}

export async function listMessageReminderRecords(orgId: string, userId: string): Promise<JsonObject[]> {
  return ((await getChannelsDatabase().prepare(`
    SELECT * FROM channel_message_reminders
    WHERE organization_id = ? AND user_id = ? AND status IN ('pending', 'due')
    ORDER BY remind_at ASC
  `).all(orgId, userId)) as JsonObject[]).map(rowObject);
}

export async function removeMessageReminderRecord(orgId: string, userId: string, reminderId: string) {
  return (await getChannelsDatabase().transaction(async () => {
  const result = (await getChannelsDatabase().prepare(`
    UPDATE channel_message_reminders SET status = 'dismissed', updated_at = ?
    WHERE id = ? AND organization_id = ? AND user_id = ?
  `).run(nowIso(), reminderId, orgId, userId));
  if (!Number(result.changes)) throw notFound("reminder_not_found", "This reminder does not exist.");
  return { removed: true };

  }));
}

// --- tabs, folders, resources, and personal sidebar --------------------------

const DEFAULT_TABS = [
  ["messages", "Messages"],
  ["files", "Files"],
  ["documents", "Documents"],
  ["todos", "To Dos"],
  ["pins", "Pins"]
] as const;

export async function listTabRecords(orgId: string, channelId: string, userId: string): Promise<JsonObject[]> {
  const db = getChannelsDatabase();
  const existing = (await db.prepare(`
    SELECT * FROM channel_tabs WHERE organization_id = ? AND channel_id = ? ORDER BY position, created_at
  `).all(orgId, channelId)) as JsonObject[];
  if (!existing.length) {
    const now = nowIso();
    for (const [position, [kind, label]] of DEFAULT_TABS.entries()) {
      (await db.prepare(`
        INSERT INTO channel_tabs
          (id, organization_id, channel_id, kind, label, position, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`tab_${randomUUID()}`, orgId, channelId, kind, label, position, userId, now, now));
    }
  }
  return ((await db.prepare(`
    SELECT * FROM channel_tabs WHERE organization_id = ? AND channel_id = ? ORDER BY position, created_at
  `).all(orgId, channelId)) as JsonObject[]).map((row): JsonObject => ({ ...rowObject(row), config: parseJson(row.config_json, {}) }));
}

export async function createTabRecord(orgId: string, channelId: string, userId: string, input: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const id = `tab_${randomUUID()}`;
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_tabs
      (id, organization_id, channel_id, kind, label, config_json, position, visibility, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    orgId,
    channelId,
    cleanText(input.kind),
    cleanText(input.label) || cleanText(input.kind),
    json(input.config),
    Number(input.position) || 0,
    cleanText(input.visibility) || "members",
    userId,
    now,
    now
  ));
  return (await listTabRecords(orgId, channelId, userId)).find((tab) => tab.id === id);

  }));
}

export async function updateTabRecord(orgId: string, channelId: string, tabId: string, patch: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const row = (await db.prepare("SELECT * FROM channel_tabs WHERE id = ? AND organization_id = ? AND channel_id = ?")
    .get(tabId, orgId, channelId)) as JsonObject | undefined;
  if (!row) throw notFound("channel_tab_not_found", "This channel tab does not exist.");
  (await db.prepare(`
    UPDATE channel_tabs SET label = ?, config_json = ?, position = ?, visibility = ?, updated_at = ? WHERE id = ?
  `).run(
    cleanText(patch.label) || String(row.label),
    Object.prototype.hasOwnProperty.call(patch, "config") ? json(patch.config) : String(row.config_json),
    Object.prototype.hasOwnProperty.call(patch, "position") ? Number(patch.position) || 0 : Number(row.position),
    cleanText(patch.visibility) || String(row.visibility),
    nowIso(),
    tabId
  ));
  return rowObject((await db.prepare("SELECT * FROM channel_tabs WHERE id = ?").get(tabId)) as JsonObject);

  }));
}

export async function deleteTabRecord(orgId: string, channelId: string, tabId: string) {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase().prepare("DELETE FROM channel_tabs WHERE id = ? AND organization_id = ? AND channel_id = ?")
    .run(tabId, orgId, channelId));
  return { deleted: true };

  }));
}

export async function listFolderRecords(orgId: string, channelId: string) {
  return ((await getChannelsDatabase().prepare(`
    SELECT * FROM channel_resource_folders WHERE organization_id = ? AND channel_id = ?
    ORDER BY position, created_at
  `).all(orgId, channelId)) as JsonObject[]).map(rowObject);
}

export async function createFolderRecord(orgId: string, channelId: string, userId: string, input: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const parentId = cleanText(input.parent_id) || null;
  if (parentId) {
    const parent = (await db.prepare("SELECT parent_id FROM channel_resource_folders WHERE id = ? AND channel_id = ?")
      .get(parentId, channelId)) as JsonObject | undefined;
    if (!parent) throw badRequest("folder_parent_not_found", "The parent folder does not exist.");
    if (parent.parent_id) {
      const grandparent = (await db.prepare("SELECT parent_id FROM channel_resource_folders WHERE id = ?").get(cleanText(parent.parent_id))) as JsonObject | undefined;
      if (grandparent?.parent_id) throw badRequest("folder_depth_exceeded", "Folders may be nested up to three levels.");
    }
  }
  const id = `folder_${randomUUID()}`;
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_resource_folders
      (id, organization_id, channel_id, parent_id, label, description, icon, color, position, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    orgId,
    channelId,
    parentId,
    cleanText(input.label),
    cleanText(input.description),
    cleanText(input.icon) || "fa-folder",
    cleanText(input.color),
    Number(input.position) || 0,
    userId,
    now,
    now
  ));
  return rowObject((await db.prepare("SELECT * FROM channel_resource_folders WHERE id = ?").get(id)) as JsonObject);

  }));
}

export async function updateFolderRecord(orgId: string, channelId: string, folderId: string, patch: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const row = (await db.prepare("SELECT * FROM channel_resource_folders WHERE id = ? AND organization_id = ? AND channel_id = ?")
    .get(folderId, orgId, channelId)) as JsonObject | undefined;
  if (!row) throw notFound("channel_folder_not_found", "This folder does not exist.");
  (await db.prepare(`
    UPDATE channel_resource_folders SET label = ?, description = ?, icon = ?, color = ?, position = ?, updated_at = ?
    WHERE id = ?
  `).run(
    cleanText(patch.label) || String(row.label),
    Object.prototype.hasOwnProperty.call(patch, "description") ? cleanText(patch.description) : String(row.description),
    cleanText(patch.icon) || String(row.icon),
    Object.prototype.hasOwnProperty.call(patch, "color") ? cleanText(patch.color) : String(row.color),
    Object.prototype.hasOwnProperty.call(patch, "position") ? Number(patch.position) || 0 : Number(row.position),
    nowIso(),
    folderId
  ));
  return rowObject((await db.prepare("SELECT * FROM channel_resource_folders WHERE id = ?").get(folderId)) as JsonObject);

  }));
}

export async function deleteFolderRecord(orgId: string, channelId: string, folderId: string) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  (await db.prepare("UPDATE channel_resource_refs SET folder_id = NULL WHERE channel_id = ? AND folder_id = ?").run(channelId, folderId));
  (await db.prepare("UPDATE channel_resource_folders SET parent_id = NULL WHERE channel_id = ? AND parent_id = ?").run(channelId, folderId));
  (await db.prepare("DELETE FROM channel_resource_folders WHERE id = ? AND organization_id = ? AND channel_id = ?")
    .run(folderId, orgId, channelId));
  return { deleted: true };

  }));
}

export async function listResourceRefRows(orgId: string, channelId: string, options: { type?: string; folderId?: string } = {}) {
  const clauses = ["organization_id = ?", "channel_id = ?"];
  const params: unknown[] = [orgId, channelId];
  if (cleanText(options.type)) {
    clauses.push("resource_type = ?");
    params.push(cleanText(options.type));
  }
  if (cleanText(options.folderId)) {
    clauses.push("folder_id = ?");
    params.push(cleanText(options.folderId));
  }
  return ((await getChannelsDatabase().prepare(`
    SELECT * FROM channel_resource_refs WHERE ${clauses.join(" AND ")}
    ORDER BY position, created_at DESC
  `).all(...(params as string[]))) as JsonObject[]).map(rowObject);
}

export async function createResourceRefRecord(orgId: string, channelId: string, userId: string, input: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const existing = (await db.prepare(`
    SELECT * FROM channel_resource_refs
    WHERE channel_id = ? AND resource_type = ? AND resource_id = ? AND COALESCE(folder_id, '') = ?
  `).get(channelId, cleanText(input.resource_type), cleanText(input.resource_id), cleanText(input.folder_id))) as JsonObject | undefined;
  if (existing) return rowObject(existing);
  const id = `resource_${randomUUID()}`;
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_resource_refs
      (id, organization_id, channel_id, resource_type, resource_id, folder_id, source_message_id,
       relationship, display_note, position, added_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    orgId,
    channelId,
    cleanText(input.resource_type),
    cleanText(input.resource_id),
    cleanText(input.folder_id) || null,
    cleanText(input.source_message_id) || null,
    cleanText(input.relationship) || "shared",
    cleanText(input.display_note),
    Number(input.position) || 0,
    userId,
    now,
    now
  ));
  return rowObject((await db.prepare("SELECT * FROM channel_resource_refs WHERE id = ?").get(id)) as JsonObject);

  }));
}

export async function deleteResourceRefRecord(orgId: string, channelId: string, refId: string) {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase().prepare(`
    DELETE FROM channel_resource_refs WHERE id = ? AND organization_id = ? AND channel_id = ?
  `).run(refId, orgId, channelId));
  return { deleted: true };

  }));
}

export async function listSidebarSections(orgId: string, userId: string): Promise<JsonObject[]> {
  const db = getChannelsDatabase();
  const sections = (await db.prepare(`
    SELECT * FROM channel_sidebar_sections WHERE organization_id = ? AND user_id = ?
    ORDER BY position, created_at
  `).all(orgId, userId)) as JsonObject[];
  return (await Promise.all(sections.map(async (section): Promise<JsonObject> => ({
    ...rowObject(section),
    collapsed: Number(section.collapsed) === 1,
    channel_ids: ((await db.prepare(`
      SELECT channel_id FROM channel_sidebar_items WHERE organization_id = ? AND user_id = ? AND section_id = ?
      ORDER BY position
    `).all(orgId, userId, cleanText(section.id))) as JsonObject[]).map((row) => String(row.channel_id))
  }))));
}

export async function saveSidebarSection(orgId: string, userId: string, input: JsonObject) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const id = cleanText(input.id) || `section_${randomUUID()}`;
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_sidebar_sections
      (id, organization_id, user_id, label, position, collapsed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      label = excluded.label, position = excluded.position, collapsed = excluded.collapsed, updated_at = excluded.updated_at
  `).run(
    id,
    orgId,
    userId,
    cleanText(input.label),
    Number(input.position) || 0,
    input.collapsed === true ? 1 : 0,
    now,
    now
  ));
  if (Array.isArray(input.channel_ids)) {
    (await db.prepare("DELETE FROM channel_sidebar_items WHERE organization_id = ? AND user_id = ? AND section_id = ?")
      .run(orgId, userId, id));
    for (const [position, channelId] of input.channel_ids.entries()) {
      (await db.prepare(`
        INSERT INTO channel_sidebar_items
          (organization_id, user_id, section_id, channel_id, position) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET section_id=excluded.section_id, position=excluded.position
      `).run(orgId, userId, id, cleanText(channelId), position));
    }
  }
  return (await listSidebarSections(orgId, userId)).find((section) => section.id === id);

  }));
}

export async function deleteSidebarSection(orgId: string, userId: string, id: string) {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase().prepare(`
    DELETE FROM channel_sidebar_sections WHERE id = ? AND organization_id = ? AND user_id = ?
  `).run(id, orgId, userId));
  return { deleted: true };

  }));
}

// --- huddles -----------------------------------------------------------------

export async function createHuddleRecord(orgId: string, channelId: string, userId: string, settings: JsonObject = {}): Promise<JsonObject> {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const existing = (await db.prepare(`
    SELECT * FROM channel_huddles WHERE organization_id = ? AND channel_id = ? AND state = 'active'
    ORDER BY started_at DESC LIMIT 1
  `).get(orgId, channelId)) as JsonObject | undefined;
  if (existing) {
    (await joinHuddleRecord(orgId, String(existing.id), userId));
    return (await huddleRecord(orgId, String(existing.id)));
  }
  const id = `huddle_${randomUUID()}`;
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_huddles
      (id, organization_id, channel_id, state, started_by, started_at, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(id, orgId, channelId, userId, now, json(settings), now, now));
  (await joinHuddleRecord(orgId, id, userId));
  return (await huddleRecord(orgId, id));

  }));
}

export async function huddleRecord(orgId: string, huddleId: string): Promise<JsonObject> {
  const db = getChannelsDatabase();
  const row = (await db.prepare("SELECT * FROM channel_huddles WHERE id = ? AND organization_id = ?")
    .get(huddleId, orgId)) as JsonObject | undefined;
  if (!row) throw notFound("huddle_not_found", "This huddle does not exist.");
  const participants = ((await db.prepare(`
    SELECT * FROM channel_huddle_participants WHERE huddle_id = ? ORDER BY joined_at
  `).all(huddleId)) as JsonObject[]).map(rowObject);
  return { ...rowObject(row), settings: parseJson(row.settings_json, {}), participants };
}

export async function joinHuddleRecord(orgId: string, huddleId: string, userId: string): Promise<JsonObject> {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const huddle = (await db.prepare("SELECT * FROM channel_huddles WHERE id = ? AND organization_id = ?")
    .get(huddleId, orgId)) as JsonObject | undefined;
  if (!huddle || huddle.state !== "active") throw badRequest("huddle_not_active", "This huddle has ended.");
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO channel_huddle_participants
      (huddle_id, organization_id, user_id, joined_at, left_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?)
    ON CONFLICT (huddle_id, user_id) DO UPDATE SET left_at = NULL, updated_at = excluded.updated_at
  `).run(huddleId, orgId, userId, now, now));
  return (await huddleRecord(orgId, huddleId));

  }));
}

export async function leaveHuddleRecord(orgId: string, huddleId: string, userId: string): Promise<JsonObject> {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase().prepare(`
    UPDATE channel_huddle_participants SET left_at = ?, updated_at = ?
    WHERE huddle_id = ? AND organization_id = ? AND user_id = ?
  `).run(nowIso(), nowIso(), huddleId, orgId, userId));
  return (await huddleRecord(orgId, huddleId));

  }));
}

export async function endHuddleRecord(orgId: string, huddleId: string, userId: string): Promise<JsonObject> {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const huddle = (await db.prepare("SELECT * FROM channel_huddles WHERE id = ? AND organization_id = ?")
    .get(huddleId, orgId)) as JsonObject | undefined;
  if (!huddle) throw notFound("huddle_not_found", "This huddle does not exist.");
  if (cleanText(huddle.started_by) !== userId) throw badRequest("huddle_owner_required", "Only the huddle starter can end it for everyone.");
  const now = nowIso();
  (await db.prepare("UPDATE channel_huddles SET state = 'ended', ended_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, huddleId));
  (await db.prepare("UPDATE channel_huddle_participants SET left_at = COALESCE(left_at, ?), updated_at = ? WHERE huddle_id = ?")
    .run(now, now, huddleId));
  return (await huddleRecord(orgId, huddleId));

  }));
}

export async function setHuddleRecordingRecord(orgId: string, huddleId: string, mediaId: string): Promise<JsonObject> {
  return (await getChannelsDatabase().transaction(async () => {
  const now = nowIso();
  (await getChannelsDatabase().prepare(`
    UPDATE channel_huddles
    SET recording_media_id = ?, updated_at = ?
    WHERE id = ? AND organization_id = ?
  `).run(cleanText(mediaId), now, huddleId, orgId));
  return (await huddleRecord(orgId, huddleId));

  }));
}

export async function createHuddleSignalRecord(
  orgId: string,
  huddleId: string,
  senderPeerId: string,
  kind: string,
  payload: JsonObject,
  targetPeerId?: string
): Promise<JsonObject> {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const huddle = (await db.prepare("SELECT state FROM channel_huddles WHERE id = ? AND organization_id = ?")
    .get(huddleId, orgId)) as JsonObject | undefined;
  if (!huddle || huddle.state !== "active") throw badRequest("huddle_not_active", "This huddle has ended.");
  const id = `signal_${randomUUID()}`;
  const now = nowIso();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  (await db.prepare(`
    INSERT INTO channel_huddle_signals
      (id, huddle_id, organization_id, sender_peer_id, target_peer_id, kind, payload_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, huddleId, orgId, senderPeerId, cleanText(targetPeerId) || null, kind, json(payload), now, expires));
  (await db.prepare("DELETE FROM channel_huddle_signals WHERE expires_at < ?").run(now));
  const row = (await db.prepare("SELECT * FROM channel_huddle_signals WHERE id = ?").get(id)) as JsonObject;
  return { ...rowObject(row), payload: parseJson(row.payload_json, {}) };

  }));
}

export async function listHuddleSignalRecords(
  orgId: string,
  huddleId: string,
  afterSeq: number,
  peerId: string
): Promise<JsonObject[]> {
  const rows = (await getChannelsDatabase().prepare(`
    SELECT * FROM channel_huddle_signals
    WHERE organization_id = ? AND huddle_id = ? AND seq > ?
      AND sender_peer_id <> ?
      AND (target_peer_id IS NULL OR target_peer_id = ?)
      AND expires_at >= ?
    ORDER BY seq ASC
    LIMIT 200
  `).all(orgId, huddleId, Math.max(0, afterSeq), peerId, peerId, nowIso())) as JsonObject[];
  return rows.map((row) => ({ ...rowObject(row), payload: parseJson(row.payload_json, {}) }));
}

/** Message, attachments, attention and delivery acknowledgement commit together.
 * A killed transaction leaves the schedule eligible for the next worker. */
export async function deliverScheduledRecord(id: string, deliver: (record: JsonObject) => Promise<string>) {
  const db = getChannelsDatabase();
  return (await db.transaction(async () => {
    const current = await db.prepare("SELECT * FROM channel_scheduled_messages WHERE id=?").get(id);
    if (!current || !["scheduled", "sending"].includes(cleanText(current.state)) || cleanText(current.scheduled_at) > nowIso()) return false;
    const messageId = await deliver(scheduledRow(current));
    await db.prepare("UPDATE channel_scheduled_messages SET state='sent',resulting_message_id=?,failure_reason=NULL,updated_at=? WHERE id=?")
      .run(messageId, nowIso(), id);
    await db.prepare("INSERT INTO channel_delivery_outbox(scheduled_id,organization_id,message_id,created_at) VALUES(?,?,?,?) ON CONFLICT(scheduled_id) DO NOTHING")
      .run(id, cleanText(current.organization_id), messageId, nowIso());
    return true;
  }));
}
