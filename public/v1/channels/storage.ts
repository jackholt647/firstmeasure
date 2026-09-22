import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../platform/sql_store.js";

import { notFound } from "../platform/errors.js";
import { env } from "../src/config/env.js";

export type JsonObject = Record<string, unknown>;

export type ChannelType = "public" | "private" | "dm" | "group_dm" | "project";

export type ChannelRow = {
  id: string;
  organization_id: string;
  type: ChannelType;
  name: string;
  topic: string;
  project_id: string | null;
  dm_key: string | null;
  created_by: string;
  archived_at: string | null;
  message_seq: number;
  last_message_at: string | null;
  settings: JsonObject;
  created_at: string;
  updated_at: string;
};

export type ChannelMemberRow = {
  channel_id: string;
  organization_id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  notify_level: "all" | "mentions" | "muted";
  joined_at: string;
};

export type MessageRow = {
  id: string;
  organization_id: string;
  channel_id: string;
  seq: number;
  parent_id: string | null;
  client_msg_id: string | null;
  author_id: string;
  kind: "message" | "system";
  text: string;
  content: JsonObject;
  content_schema_version: number;
  language_code: string;
  language_confidence: number;
  audience: string[];
  tags: string[];
  mention_users: JsonObject[];
  metadata: JsonObject;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  pinned_at: string | null;
  pinned_by: string | null;
  reply_count: number;
  last_reply_at: string | null;
};

export type MessageTranslationRow = {
  message_id: string;
  organization_id: string;
  source_hash: string;
  source_language: string;
  target_language: string;
  translated_text: string;
  model: string;
  created_at: string;
  updated_at: string;
};

export type MessageRevisionRow = {
  id: string;
  message_id: string;
  revision: number;
  text: string;
  edited_by: string;
  edited_at: string;
};

export type ReactionRow = {
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
};

export type AttachmentRow = {
  id: string;
  organization_id: string;
  channel_id: string | null;
  message_id: string | null;
  media_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: string;
};

let database: SqlStore | null = null;
let databasePath = "";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function parseJson(value: unknown, fallback: unknown) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(cleanText).filter(Boolean))] : [];
}

function nowIso() {
  return new Date().toISOString();
}

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.channelsStorageRoot, "channels.sqlite");
}

export async function closeChannelsDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}
export function getChannelsDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeChannelsDatabase();
  database = openSqlStore({ id: "channels", schemaVersion: 2, filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      topic TEXT NOT NULL DEFAULT '',
      project_id TEXT,
      dm_key TEXT,
      created_by TEXT NOT NULL,
      archived_at TEXT,
      message_seq INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS channels_project_uq
      ON channels(organization_id, project_id) WHERE project_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_uq
      ON channels(organization_id, dm_key) WHERE dm_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS channels_org_type_idx ON channels(organization_id, type, last_message_at);

    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      notify_level TEXT NOT NULL DEFAULT 'mentions',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS channel_members_user_idx ON channel_members(organization_id, user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      parent_id TEXT,
      client_msg_id TEXT,
      author_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      text TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL DEFAULT '{}',
      content_schema_version INTEGER NOT NULL DEFAULT 1,
      language_code TEXT NOT NULL DEFAULT 'und',
      language_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
      audience_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      mention_users_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT,
      deleted_by TEXT,
      pinned_at TEXT,
      pinned_by TEXT,
      reply_count INTEGER NOT NULL DEFAULT 0,
      last_reply_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS messages_client_uq
      ON messages(channel_id, author_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_channel_seq_idx ON messages(channel_id, seq);
    CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(parent_id, created_at) WHERE parent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_pinned_idx ON messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS message_translations (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_language TEXT NOT NULL,
      target_language TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, target_language)
    );
    CREATE INDEX IF NOT EXISTS message_translations_org_idx
      ON message_translations(organization_id, target_language);

    CREATE TABLE IF NOT EXISTS message_revisions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      text TEXT NOT NULL,
      edited_by TEXT NOT NULL,
      edited_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS message_revisions_uq ON message_revisions(message_id, revision);

    CREATE TABLE IF NOT EXISTS message_reactions (
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT,
      media_id TEXT NOT NULL,
      file_name TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS message_attachments_message_idx ON message_attachments(message_id);

    CREATE TABLE IF NOT EXISTS saved_items (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS channel_read_state (
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      manual_unread_seq INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      last_read_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS message_mentions (
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS message_mentions_user_idx ON message_mentions(organization_id, user_id, channel_id, seq);

    CREATE TABLE IF NOT EXISTS channel_thread_subscriptions (
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      root_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      following INTEGER NOT NULL DEFAULT 1,
      notify_level TEXT NOT NULL DEFAULT 'all',
      last_read_reply_seq INTEGER NOT NULL DEFAULT 0,
      manual_unread_reply_seq INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (root_message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS channel_thread_subscriptions_user_idx
      ON channel_thread_subscriptions(organization_id, user_id, updated_at);

    CREATE TABLE IF NOT EXISTS channel_attention_items (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      root_message_id TEXT,
      actor_user_id TEXT,
      resource_type TEXT,
      resource_id TEXT,
      dedupe_key TEXT NOT NULL,
      read_at TEXT,
      cleared_at TEXT,
      snoozed_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS channel_attention_dedupe_uq
      ON channel_attention_items(organization_id, recipient_user_id, dedupe_key);
    CREATE INDEX IF NOT EXISTS channel_attention_user_idx
      ON channel_attention_items(organization_id, recipient_user_id, created_at);

    CREATE TABLE IF NOT EXISTS channel_read_operations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_user_preferences (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS channel_drafts (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      draft_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      root_message_id TEXT,
      content_json TEXT NOT NULL DEFAULT '{}',
      text TEXT NOT NULL DEFAULT '',
      attachment_ids_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id, draft_key)
    );

    CREATE TABLE IF NOT EXISTS channel_delivery_outbox (
      scheduled_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_scheduled_messages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      root_message_id TEXT,
      sender_user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      content_json TEXT NOT NULL DEFAULT '{}',
      attachment_ids_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      scheduled_at TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      state TEXT NOT NULL DEFAULT 'scheduled',
      failure_reason TEXT,
      resulting_message_id TEXT,
      client_operation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS channel_scheduled_client_uq
      ON channel_scheduled_messages(organization_id, sender_user_id, client_operation_id)
      WHERE client_operation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS channel_scheduled_due_idx
      ON channel_scheduled_messages(state, scheduled_at);

    CREATE TABLE IF NOT EXISTS channel_message_reminders (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      remind_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, user_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS channel_message_reminders_due_idx
      ON channel_message_reminders(organization_id, user_id, status, remind_at);

    CREATE TABLE IF NOT EXISTS channel_tabs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'members',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_tabs_channel_idx ON channel_tabs(channel_id, position);

    CREATE TABLE IF NOT EXISTS channel_resource_folders (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      parent_id TEXT,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'fa-folder',
      color TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_resource_folders_channel_idx
      ON channel_resource_folders(channel_id, position);

    CREATE TABLE IF NOT EXISTS channel_resource_refs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      folder_id TEXT,
      source_message_id TEXT,
      relationship TEXT NOT NULL DEFAULT 'shared',
      display_note TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS channel_resource_refs_uq
      ON channel_resource_refs(channel_id, resource_type, resource_id, COALESCE(folder_id, ''));
    CREATE INDEX IF NOT EXISTS channel_resource_refs_channel_idx
      ON channel_resource_refs(channel_id, resource_type, position);

    CREATE TABLE IF NOT EXISTS channel_sidebar_sections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_sidebar_items (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      section_id TEXT NOT NULL REFERENCES channel_sidebar_sections(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS channel_huddles (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      root_message_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      started_by TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      recording_media_id TEXT,
      transcript_media_id TEXT,
      notes_document_id TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_huddles_channel_idx ON channel_huddles(channel_id, started_at);

    CREATE TABLE IF NOT EXISTS channel_huddle_participants (
      huddle_id TEXT NOT NULL REFERENCES channel_huddles(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'participant',
      joined_at TEXT NOT NULL,
      left_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (huddle_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS channel_huddle_signals (
      ${db.isPostgres ? "seq BIGSERIAL PRIMARY KEY" : "seq INTEGER PRIMARY KEY AUTOINCREMENT"},
      id TEXT NOT NULL UNIQUE,
      huddle_id TEXT NOT NULL REFERENCES channel_huddles(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      sender_peer_id TEXT NOT NULL,
      target_peer_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_huddle_signals_poll_idx
      ON channel_huddle_signals(huddle_id, seq);

    ${db.isPostgres ? `CREATE TABLE IF NOT EXISTS messages_fts (
      text TEXT NOT NULL, message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
    );
    CREATE INDEX IF NOT EXISTS messages_fts_search_idx ON messages_fts USING GIN(search_vector);
    CREATE INDEX IF NOT EXISTS messages_fts_org_idx ON messages_fts(organization_id);` : `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      message_id UNINDEXED,
      channel_id UNINDEXED,
      organization_id UNINDEXED
    );`}

    CREATE TABLE IF NOT EXISTS channels_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `));
  await ensureSqlColumn(db, "messages", "language_code", "TEXT NOT NULL DEFAULT 'und'");
  await ensureSqlColumn(db, "messages", "language_confidence", "DOUBLE PRECISION NOT NULL DEFAULT 0");
  await ensureSqlColumn(db, "messages", "content_json", "TEXT NOT NULL DEFAULT '{}'");
  await ensureSqlColumn(db, "messages", "content_schema_version", "INTEGER NOT NULL DEFAULT 1");
  await ensureSqlColumn(db, "channel_read_state", "manual_unread_seq", "INTEGER");
  await ensureSqlColumn(db, "channel_read_state", "version", "INTEGER NOT NULL DEFAULT 1");
  // One-time: channel notifications became opt-in (mention-driven default).
  const migrated = (await db.prepare("SELECT value FROM channels_meta WHERE key='notify_default_mentions'").get()) as JsonObject | undefined;
  if (!migrated) {
    (await db.exec("UPDATE channel_members SET notify_level='mentions' WHERE notify_level='all'"));
    (await db.prepare("INSERT INTO channels_meta (key, value, updated_at) VALUES ('notify_default_mentions', 'done', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(nowIso()));
  }
}

export async function readChannelsMeta(key: string) {
  const row = (await getChannelsDatabase().prepare("SELECT value FROM channels_meta WHERE key=?").get(cleanText(key))) as JsonObject | undefined;
  return row ? String(row.value ?? "") : "";
}

export async function writeChannelsMeta(key: string, value: string) {
  (await getChannelsDatabase()
    .prepare("INSERT INTO channels_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(cleanText(key), String(value ?? ""), nowIso()));
}

// --- row mapping -------------------------------------------------------------

function channelFromRow(row: JsonObject): ChannelRow {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    type: String(row.type) as ChannelType,
    name: String(row.name ?? ""),
    topic: String(row.topic ?? ""),
    project_id: row.project_id == null ? null : String(row.project_id),
    dm_key: row.dm_key == null ? null : String(row.dm_key),
    created_by: String(row.created_by ?? ""),
    archived_at: row.archived_at == null ? null : String(row.archived_at),
    message_seq: Number(row.message_seq ?? 0),
    last_message_at: row.last_message_at == null ? null : String(row.last_message_at),
    settings: parseJson(row.settings_json, {}) as JsonObject,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function memberFromRow(row: JsonObject): ChannelMemberRow {
  return {
    channel_id: String(row.channel_id),
    organization_id: String(row.organization_id),
    user_id: String(row.user_id),
    role: String(row.role ?? "member") as ChannelMemberRow["role"],
    notify_level: String(row.notify_level ?? "all") as ChannelMemberRow["notify_level"],
    joined_at: String(row.joined_at)
  };
}

function messageFromRow(row: JsonObject): MessageRow {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    channel_id: String(row.channel_id),
    seq: Number(row.seq ?? 0),
    parent_id: row.parent_id == null ? null : String(row.parent_id),
    client_msg_id: row.client_msg_id == null ? null : String(row.client_msg_id),
    author_id: String(row.author_id ?? ""),
    kind: String(row.kind ?? "message") as MessageRow["kind"],
    text: String(row.text ?? ""),
    content: parseJson(row.content_json, {}) as JsonObject,
    content_schema_version: Number(row.content_schema_version ?? 1),
    language_code: String(row.language_code ?? "und"),
    language_confidence: Number(row.language_confidence ?? 0),
    audience: asStringArray(parseJson(row.audience_json, [])),
    tags: asStringArray(parseJson(row.tags_json, [])),
    mention_users: (parseJson(row.mention_users_json, []) as JsonObject[]).filter((item) => item && typeof item === "object"),
    metadata: parseJson(row.metadata_json, {}) as JsonObject,
    created_at: String(row.created_at),
    edited_at: row.edited_at == null ? null : String(row.edited_at),
    deleted_at: row.deleted_at == null ? null : String(row.deleted_at),
    deleted_by: row.deleted_by == null ? null : String(row.deleted_by),
    pinned_at: row.pinned_at == null ? null : String(row.pinned_at),
    pinned_by: row.pinned_by == null ? null : String(row.pinned_by),
    reply_count: Number(row.reply_count ?? 0),
    last_reply_at: row.last_reply_at == null ? null : String(row.last_reply_at)
  };
}

// --- channels ----------------------------------------------------------------

export function dmKeyForMembers(userIds: string[]) {
  const sorted = [...new Set(userIds.map(cleanText).filter(Boolean))].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}

export async function createChannelRecord(input: {
  organization_id: string;
  type: ChannelType;
  name?: string;
  topic?: string;
  project_id?: string | null;
  dm_key?: string | null;
  created_by: string;
  settings?: JsonObject;
}) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const now = nowIso();
  const id = `chan_${randomUUID()}`;
  (await db.prepare(`
    INSERT INTO channels (id, organization_id, type, name, topic, project_id, dm_key, created_by, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.organization_id,
    input.type,
    cleanText(input.name),
    cleanText(input.topic),
    input.project_id || null,
    input.dm_key || null,
    input.created_by,
    JSON.stringify(input.settings ?? {}),
    now,
    now
  ));
  return (await readChannelRecord(input.organization_id, id))!;

  }));
}

export async function readChannelRecord(orgId: string, channelId: string) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT * FROM channels WHERE organization_id = ? AND id = ?")
    .get(orgId, channelId)) as JsonObject | undefined;
  return row ? channelFromRow(row) : null;
}

export async function findChannelByProject(orgId: string, projectId: string) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT * FROM channels WHERE organization_id = ? AND project_id = ?")
    .get(orgId, projectId)) as JsonObject | undefined;
  return row ? channelFromRow(row) : null;
}

export async function findChannelByDmKey(orgId: string, dmKey: string) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT * FROM channels WHERE organization_id = ? AND dm_key = ?")
    .get(orgId, dmKey)) as JsonObject | undefined;
  return row ? channelFromRow(row) : null;
}

export async function updateChannelRecord(orgId: string, channelId: string, patch: {
  name?: string;
  topic?: string;
  archived_at?: string | null;
  settings?: JsonObject;
}) {
  return (await getChannelsDatabase().transaction(async () => {
  const existing = (await readChannelRecord(orgId, channelId));
  if (!existing) return null;
  const db = getChannelsDatabase();
  (await db.prepare(`
    UPDATE channels SET name = ?, topic = ?, archived_at = ?, settings_json = ?, updated_at = ?
    WHERE organization_id = ? AND id = ?
  `).run(
    patch.name !== undefined ? cleanText(patch.name) : existing.name,
    patch.topic !== undefined ? cleanText(patch.topic) : existing.topic,
    patch.archived_at !== undefined ? patch.archived_at : existing.archived_at,
    JSON.stringify(patch.settings !== undefined ? patch.settings : existing.settings),
    nowIso(),
    orgId,
    channelId
  ));
  return (await readChannelRecord(orgId, channelId));

  }));
}

export async function listChannelRecords(orgId: string, options: { types?: ChannelType[]; includeArchived?: boolean } = {}) {
  const types = options.types?.length ? options.types : null;
  const clauses = ["organization_id = ?"];
  const params: unknown[] = [orgId];
  if (types) {
    clauses.push(`type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }
  if (!options.includeArchived) clauses.push("archived_at IS NULL");
  const rows = (await getChannelsDatabase()
    .prepare(`SELECT * FROM channels WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(last_message_at, created_at) DESC`)
    .all(...(params as string[]))) as JsonObject[];
  return rows.map(channelFromRow);
}

// --- members -----------------------------------------------------------------

export async function upsertChannelMember(input: {
  channel_id: string;
  organization_id: string;
  user_id: string;
  role?: ChannelMemberRow["role"];
  notify_level?: ChannelMemberRow["notify_level"];
}) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  (await db.prepare(`
    INSERT INTO channel_members (channel_id, organization_id, user_id, role, notify_level, joined_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (channel_id, user_id) DO UPDATE SET
      role = excluded.role,
      notify_level = excluded.notify_level
  `).run(
    input.channel_id,
    input.organization_id,
    input.user_id,
    input.role ?? "member",
    // Channel notifications are opt-in: default = mention-driven only.
    input.notify_level ?? "mentions",
    nowIso()
  ));

  }));
}

export async function setMemberNotifyLevel(channelId: string, userId: string, notifyLevel: ChannelMemberRow["notify_level"]) {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase()
    .prepare("UPDATE channel_members SET notify_level = ? WHERE channel_id = ? AND user_id = ?")
    .run(notifyLevel, channelId, userId));

  }));
}

export async function removeChannelMember(channelId: string, userId: string) {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase()
    .prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
    .run(channelId, userId));

  }));
}

export async function listChannelMembers(channelId: string) {
  const rows = (await getChannelsDatabase()
    .prepare("SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC")
    .all(channelId)) as JsonObject[];
  return rows.map(memberFromRow);
}

export async function readChannelMember(channelId: string, userId: string) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?")
    .get(channelId, userId)) as JsonObject | undefined;
  return row ? memberFromRow(row) : null;
}

export async function listMembershipChannelIds(orgId: string, userId: string) {
  const rows = (await getChannelsDatabase()
    .prepare("SELECT channel_id FROM channel_members WHERE organization_id = ? AND user_id = ?")
    .all(orgId, userId)) as JsonObject[];
  return rows.map((row) => String(row.channel_id));
}

// --- messages ----------------------------------------------------------------

export async function findMessageByClientId(channelId: string, authorId: string, clientMsgId: string) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT * FROM messages WHERE channel_id = ? AND author_id = ? AND client_msg_id = ?")
    .get(channelId, authorId, clientMsgId)) as JsonObject | undefined;
  return row ? messageFromRow(row) : null;
}

export async function createMessageRecord(input: {
  organization_id: string;
  channel_id: string;
  parent_id?: string | null;
  client_msg_id?: string | null;
  author_id: string;
  kind?: MessageRow["kind"];
  text: string;
  content?: JsonObject;
  content_schema_version?: number;
  language_code?: string;
  language_confidence?: number;
  audience?: string[];
  tags?: string[];
  mention_users?: JsonObject[];
  metadata?: JsonObject;
  created_at?: string;
}) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  if (cleanText(input.client_msg_id)) {
    const existing = await findMessageByClientId(input.channel_id, input.author_id, cleanText(input.client_msg_id));
    if (existing && existing.organization_id === input.organization_id) return existing;
  }
  const now = nowIso();
  const createdAt = cleanText(input.created_at) || now;
  const id = `msg_${randomUUID()}`;
  const mentionUsers = Array.isArray(input.mention_users) ? input.mention_users : [];

  await db.transaction(async () => {
    const changed = await db.prepare("UPDATE channels SET message_seq = message_seq + 1, last_message_at = ?, updated_at = ? WHERE id = ? AND organization_id = ?")
      .run(now, now, input.channel_id, input.organization_id);
    if (!changed.changes) throw notFound("channel_not_found", "This channel was not found.");
    if (input.parent_id) {
      const parent = await db.prepare("SELECT id FROM messages WHERE organization_id=? AND channel_id=? AND id=?").get(input.organization_id, input.channel_id, input.parent_id);
      if (!parent) throw notFound("message_not_found", "The parent message was not found in this channel.");
    }
    const seqRow = (await db.prepare("SELECT message_seq FROM channels WHERE id = ?").get(input.channel_id)) as JsonObject;
    const seq = Number(seqRow?.message_seq ?? 1);

    (await db.prepare(`
      INSERT INTO messages (
        id, organization_id, channel_id, seq, parent_id, client_msg_id, author_id, kind, text, content_json, content_schema_version,
        language_code, language_confidence, audience_json, tags_json, mention_users_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.organization_id,
      input.channel_id,
      seq,
      input.parent_id || null,
      cleanText(input.client_msg_id) || null,
      input.author_id,
      input.kind ?? "message",
      input.text,
      JSON.stringify(input.content ?? {}),
      Math.max(1, Number(input.content_schema_version) || 1),
      cleanText(input.language_code) || "und",
      Math.max(0, Math.min(1, Number(input.language_confidence) || 0)),
      JSON.stringify(asStringArray(input.audience)),
      JSON.stringify(asStringArray(input.tags)),
      JSON.stringify(mentionUsers),
      JSON.stringify(input.metadata ?? {}),
      createdAt
    ));

    if (input.parent_id) {
      (await db.prepare("UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?")
        .run(createdAt, input.parent_id));
    }

    const mentionIds = [...new Set(mentionUsers.map((user) => cleanText(user.id || user.user_id)).filter(Boolean))];
    for (const userId of mentionIds) {
      (await db.prepare(`
        INSERT INTO message_mentions (organization_id, channel_id, message_id, seq, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`).run(input.organization_id, input.channel_id, id, seq, userId, createdAt));
    }

    (await db.prepare("INSERT INTO messages_fts (text, message_id, channel_id, organization_id) VALUES (?, ?, ?, ?)")
      .run(input.text, id, input.channel_id, input.organization_id));
  
  });
  return (await readMessageRecord(input.organization_id, id))!;

  }));
}

export async function readMessageRecord(orgId: string, messageId: string) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT * FROM messages WHERE organization_id = ? AND id = ?")
    .get(orgId, messageId)) as JsonObject | undefined;
  return row ? messageFromRow(row) : null;
}

export async function readMessageBySequence(orgId: string, channelId: string, seq: number) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT * FROM messages WHERE organization_id = ? AND channel_id = ? AND seq = ?")
    .get(orgId, channelId, Math.max(0, Math.floor(Number(seq) || 0)))) as JsonObject | undefined;
  return row ? messageFromRow(row) : null;
}

export async function setMessageLanguage(orgId: string, messageId: string, languageCode: string, confidence: number) {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase().prepare(`
    UPDATE messages SET language_code = ?, language_confidence = ?
    WHERE organization_id = ? AND id = ?
  `).run(
    cleanText(languageCode) || "und",
    Math.max(0, Math.min(1, Number(confidence) || 0)),
    orgId,
    messageId
  ));
  return (await readMessageRecord(orgId, messageId));

  }));
}

export async function editMessageRecord(orgId: string, message: MessageRow, input: {
  text: string;
  content?: JsonObject;
  content_schema_version?: number;
  language_code?: string;
  language_confidence?: number;
  mention_users?: JsonObject[];
  audience?: string[];
  tags?: string[];
  edited_by: string;
}) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const now = nowIso();
  await db.transaction(async () => {
    const countRow = (await db.prepare("SELECT COUNT(*) AS n FROM message_revisions WHERE message_id = ?").get(message.id)) as JsonObject;
    const revision = Number(countRow?.n ?? 0) + 1;
    (await db.prepare(`
      INSERT INTO message_revisions (id, organization_id, message_id, revision, text, edited_by, edited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `rev_${randomUUID()}`,
      orgId,
      message.id,
      revision,
      message.text,
      message.author_id,
      message.edited_at ?? message.created_at
    ));

    const mentionUsers = input.mention_users !== undefined ? input.mention_users : message.mention_users;
    (await db.prepare(`
      UPDATE messages SET text = ?, content_json = ?, content_schema_version = ?, language_code = ?, language_confidence = ?, mention_users_json = ?, audience_json = ?, tags_json = ?, edited_at = ?
      WHERE id = ?
    `).run(
      input.text,
      JSON.stringify(input.content !== undefined ? input.content : message.content),
      Math.max(1, Number(input.content_schema_version) || message.content_schema_version || 1),
      cleanText(input.language_code) || "und",
      Math.max(0, Math.min(1, Number(input.language_confidence) || 0)),
      JSON.stringify(mentionUsers ?? []),
      JSON.stringify(input.audience !== undefined ? asStringArray(input.audience) : message.audience),
      JSON.stringify(input.tags !== undefined ? asStringArray(input.tags) : message.tags),
      now,
      message.id
    ));

    const mentionIds = [...new Set((mentionUsers ?? []).map((user) => cleanText((user as JsonObject).id || (user as JsonObject).user_id)).filter(Boolean))];
    for (const userId of mentionIds) {
      (await db.prepare(`
        INSERT INTO message_mentions (organization_id, channel_id, message_id, seq, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`).run(orgId, message.channel_id, message.id, message.seq, userId, now));
    }

    (await db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(message.id));
    (await db.prepare("INSERT INTO messages_fts (text, message_id, channel_id, organization_id) VALUES (?, ?, ?, ?)")
      .run(input.text, message.id, message.channel_id, orgId));
  
  });
  return (await readMessageRecord(orgId, message.id))!;

  }));
}

function translationFromRow(row: JsonObject): MessageTranslationRow {
  return {
    message_id: String(row.message_id),
    organization_id: String(row.organization_id),
    source_hash: String(row.source_hash),
    source_language: String(row.source_language),
    target_language: String(row.target_language),
    translated_text: String(row.translated_text),
    model: String(row.model),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export async function readMessageTranslation(messageId: string, targetLanguage: string, sourceHash?: string) {
  const row = (await getChannelsDatabase().prepare(`
    SELECT * FROM message_translations
    WHERE message_id = ? AND target_language = ?
  `).get(messageId, targetLanguage)) as JsonObject | undefined;
  if (!row || (sourceHash && String(row.source_hash) !== sourceHash)) return null;
  return translationFromRow(row);
}

export async function listMessageTranslations(messageIds: string[], targetLanguage: string) {
  const result = new Map<string, MessageTranslationRow>();
  if (!messageIds.length) return result;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = (await getChannelsDatabase().prepare(`
    SELECT * FROM message_translations
    WHERE target_language = ? AND message_id IN (${placeholders})
  `).all(targetLanguage, ...messageIds)) as JsonObject[];
  for (const row of rows) {
    const translation = translationFromRow(row);
    result.set(translation.message_id, translation);
  }
  return result;
}

export async function saveMessageTranslation(input: Omit<MessageTranslationRow, "created_at" | "updated_at">) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO message_translations (
      message_id, organization_id, source_hash, source_language, target_language,
      translated_text, model, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id, target_language) DO UPDATE SET
      source_hash = excluded.source_hash,
      source_language = excluded.source_language,
      translated_text = excluded.translated_text,
      model = excluded.model,
      updated_at = excluded.updated_at
  `).run(
    input.message_id,
    input.organization_id,
    input.source_hash,
    input.source_language,
    input.target_language,
    input.translated_text,
    input.model,
    now,
    now
  ));
  return (await readMessageTranslation(input.message_id, input.target_language, input.source_hash))!;

  }));
}

export async function softDeleteMessageRecord(orgId: string, messageId: string, deletedBy: string) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  await db.transaction(async () => {
    (await db.prepare("UPDATE messages SET deleted_at = ?, deleted_by = ?, pinned_at = NULL, pinned_by = NULL WHERE organization_id = ? AND id = ?")
      .run(nowIso(), deletedBy, orgId, messageId));
    (await db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(messageId));
  
  });
  return (await readMessageRecord(orgId, messageId));

  }));
}

export async function restoreMessageRecord(orgId: string, messageId: string) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const message = (await readMessageRecord(orgId, messageId));
  if (!message) return null;
  await db.transaction(async () => {
    (await db.prepare("UPDATE messages SET deleted_at = NULL, deleted_by = NULL WHERE organization_id = ? AND id = ?")
      .run(orgId, messageId));
    (await db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(messageId));
    (await db.prepare("INSERT INTO messages_fts (text, message_id, channel_id, organization_id) VALUES (?, ?, ?, ?)")
      .run(message.text, messageId, message.channel_id, orgId));
  
  });
  return (await readMessageRecord(orgId, messageId));

  }));
}

export async function listMessageRecords(orgId: string, channelId: string, options: {
  before?: number;
  after?: number;
  limit?: number;
  parentId?: string | null;
} = {}) {
  const clauses = ["organization_id = ?", "channel_id = ?"];
  const params: unknown[] = [orgId, channelId];
  if (options.parentId !== undefined) {
    if (options.parentId === null) clauses.push("parent_id IS NULL");
    else {
      clauses.push("parent_id = ?");
      params.push(options.parentId);
    }
  }
  if (options.before) {
    clauses.push("seq < ?");
    params.push(options.before);
  }
  if (options.after) {
    clauses.push("seq > ?");
    params.push(options.after);
  }
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const descending = !options.after;
  const rows = (await getChannelsDatabase()
    .prepare(`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY seq ${descending ? "DESC" : "ASC"} LIMIT ?`)
    .all(...(params as string[]), limit)) as JsonObject[];
  const messages = rows.map(messageFromRow);
  return descending ? messages.reverse() : messages;
}

export async function listMessageRevisions(messageId: string) {
  const rows = (await getChannelsDatabase()
    .prepare("SELECT * FROM message_revisions WHERE message_id = ? ORDER BY revision DESC")
    .all(messageId)) as JsonObject[];
  return rows.map((row) => ({
    id: String(row.id),
    message_id: String(row.message_id),
    revision: Number(row.revision),
    text: String(row.text ?? ""),
    edited_by: String(row.edited_by ?? ""),
    edited_at: String(row.edited_at ?? "")
  })) as MessageRevisionRow[];
}

// --- reactions ---------------------------------------------------------------

export async function toggleReactionRecord(input: {
  organization_id: string;
  channel_id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  on: boolean;
}) {
  const db = getChannelsDatabase();
  if (input.on) {
    (await db.prepare(`
      INSERT INTO message_reactions (organization_id, channel_id, message_id, user_id, emoji, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`).run(input.organization_id, input.channel_id, input.message_id, input.user_id, input.emoji, nowIso()));
  } else {
    (await db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
      .run(input.message_id, input.user_id, input.emoji));
  }
}

export async function listReactionsForMessages(messageIds: string[]) {
  if (!messageIds.length) return new Map<string, ReactionRow[]>();
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = (await getChannelsDatabase()
    .prepare(`SELECT * FROM message_reactions WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...messageIds)) as JsonObject[];
  const map = new Map<string, ReactionRow[]>();
  for (const row of rows) {
    const entry: ReactionRow = {
      message_id: String(row.message_id),
      user_id: String(row.user_id),
      emoji: String(row.emoji),
      created_at: String(row.created_at)
    };
    const list = map.get(entry.message_id) ?? [];
    list.push(entry);
    map.set(entry.message_id, list);
  }
  return map;
}

// --- attachments ---------------------------------------------------------------

export async function createAttachmentRecord(input: {
  organization_id: string;
  channel_id?: string | null;
  media_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string;
}) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  const id = `att_${randomUUID()}`;
  (await db.prepare(`
    INSERT INTO message_attachments (id, organization_id, channel_id, message_id, media_id, file_name, content_type, size_bytes, uploaded_by, created_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.organization_id,
    input.channel_id || null,
    input.media_id,
    cleanText(input.file_name),
    cleanText(input.content_type),
    Number(input.size_bytes) || 0,
    input.uploaded_by,
    nowIso()
  ));
  return (await readAttachmentRecord(input.organization_id, id))!;

  }));
}

export async function readAttachmentRecord(orgId: string, attachmentId: string) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT * FROM message_attachments WHERE organization_id = ? AND id = ?")
    .get(orgId, attachmentId)) as JsonObject | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    channel_id: row.channel_id == null ? null : String(row.channel_id),
    message_id: row.message_id == null ? null : String(row.message_id),
    media_id: String(row.media_id),
    file_name: String(row.file_name ?? ""),
    content_type: String(row.content_type ?? ""),
    size_bytes: Number(row.size_bytes ?? 0),
    uploaded_by: String(row.uploaded_by ?? ""),
    created_at: String(row.created_at)
  } as AttachmentRow;
}

export async function attachToMessage(orgId: string, attachmentIds: string[], messageId: string, channelId: string, uploadedBy: string) {
  const db = getChannelsDatabase();
  const attached: AttachmentRow[] = [];
  for (const attachmentId of attachmentIds) {
    const attachment = (await readAttachmentRecord(orgId, attachmentId));
    if (!attachment || attachment.message_id || attachment.uploaded_by !== uploadedBy) continue;
    (await db.prepare("UPDATE message_attachments SET message_id = ?, channel_id = ? WHERE id = ?")
      .run(messageId, channelId, attachmentId));
    attached.push({ ...attachment, message_id: messageId, channel_id: channelId });
  }
  return attached;
}

export async function listAttachmentsForMessages(messageIds: string[]) {
  if (!messageIds.length) return new Map<string, AttachmentRow[]>();
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = (await getChannelsDatabase()
    .prepare(`SELECT * FROM message_attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...messageIds)) as JsonObject[];
  const map = new Map<string, AttachmentRow[]>();
  for (const row of rows) {
    const id = String(row.message_id);
    const list = map.get(id) ?? [];
    list.push({
      id: String(row.id),
      organization_id: String(row.organization_id),
      channel_id: row.channel_id == null ? null : String(row.channel_id),
      message_id: id,
      media_id: String(row.media_id),
      file_name: String(row.file_name ?? ""),
      content_type: String(row.content_type ?? ""),
      size_bytes: Number(row.size_bytes ?? 0),
      uploaded_by: String(row.uploaded_by ?? ""),
      created_at: String(row.created_at)
    });
    map.set(id, list);
  }
  return map;
}

// --- pins / saved --------------------------------------------------------------

export async function setMessagePinned(orgId: string, messageId: string, pinnedBy: string | null) {
  return (await getChannelsDatabase().transaction(async () => {
  (await getChannelsDatabase()
    .prepare("UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE organization_id = ? AND id = ?")
    .run(pinnedBy ? nowIso() : null, pinnedBy, orgId, messageId));

  }));
}

export async function listPinnedMessages(orgId: string, channelId: string) {
  const rows = (await getChannelsDatabase()
    .prepare("SELECT * FROM messages WHERE organization_id = ? AND channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC")
    .all(orgId, channelId)) as JsonObject[];
  return rows.map(messageFromRow);
}

export async function setSavedItem(orgId: string, userId: string, messageId: string, on: boolean) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  if (on) {
    (await db.prepare("INSERT INTO saved_items (organization_id, user_id, message_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(orgId, userId, messageId, nowIso()));
  } else {
    (await db.prepare("DELETE FROM saved_items WHERE user_id = ? AND message_id = ?").run(userId, messageId));
  }

  }));
}

export async function listSavedMessages(orgId: string, userId: string) {
  const rows = (await getChannelsDatabase()
    .prepare(`
      SELECT m.* FROM saved_items s
      JOIN messages m ON m.id = s.message_id
      WHERE s.organization_id = ? AND s.user_id = ? AND m.deleted_at IS NULL
      ORDER BY s.created_at DESC
    `)
    .all(orgId, userId)) as JsonObject[];
  return rows.map(messageFromRow);
}

export async function listSavedMessageIds(orgId: string, userId: string) {
  const rows = (await getChannelsDatabase()
    .prepare("SELECT message_id FROM saved_items WHERE organization_id = ? AND user_id = ?")
    .all(orgId, userId)) as JsonObject[];
  return new Set(rows.map((row) => String(row.message_id)));
}

// --- read state / unreads -------------------------------------------------------

export async function upsertReadState(orgId: string, channelId: string, userId: string, lastReadSeq: number) {
  return (await getChannelsDatabase().transaction(async () => {
  const db = getChannelsDatabase();
  (await db.prepare(`
    INSERT INTO channel_read_state (organization_id, channel_id, user_id, last_read_seq, manual_unread_seq, version, last_read_at)
    VALUES (?, ?, ?, ?, NULL, 1, ?)
    ON CONFLICT (channel_id, user_id) DO UPDATE SET
      last_read_seq = CASE WHEN channel_read_state.last_read_seq > excluded.last_read_seq THEN channel_read_state.last_read_seq ELSE excluded.last_read_seq END,
      manual_unread_seq = CASE
        WHEN channel_read_state.manual_unread_seq IS NOT NULL AND excluded.last_read_seq >= channel_read_state.manual_unread_seq THEN NULL
        ELSE channel_read_state.manual_unread_seq
      END,
      version = channel_read_state.version + 1,
      last_read_at = excluded.last_read_at
  `).run(orgId, channelId, userId, lastReadSeq, nowIso()));
  (await db.prepare("DELETE FROM message_mentions WHERE organization_id = ? AND channel_id = ? AND user_id = ? AND seq <= ?")
    .run(orgId, channelId, userId, lastReadSeq));

  }));
}

export async function readStateFor(channelId: string, userId: string) {
  const row = (await getChannelsDatabase()
    .prepare("SELECT last_read_seq, manual_unread_seq, version, last_read_at FROM channel_read_state WHERE channel_id = ? AND user_id = ?")
    .get(channelId, userId)) as JsonObject | undefined;
  const lastReadSeq = Number(row?.last_read_seq ?? 0);
  const manualUnreadSeq = row?.manual_unread_seq == null ? null : Number(row.manual_unread_seq);
  return {
    last_read_seq: lastReadSeq,
    manual_unread_seq: manualUnreadSeq,
    effective_read_seq: manualUnreadSeq == null ? lastReadSeq : Math.min(lastReadSeq, Math.max(0, manualUnreadSeq - 1)),
    version: Number(row?.version ?? 0),
    last_read_at: row?.last_read_at ? String(row.last_read_at) : null
  };
}

// --- personal inbox queries ----------------------------------------------

/** Unread mentions of the user (rows clear when the channel is read). */
export async function listMentionRowsForUser(orgId: string, userId: string, limit = 30) {
  return ((await getChannelsDatabase().prepare(`
    SELECT mm.message_id, mm.channel_id, mm.created_at AS mentioned_at,
           m.text, m.author_id, m.parent_id, m.created_at
    FROM message_mentions mm
    JOIN messages m ON m.id = mm.message_id
    WHERE mm.organization_id = ? AND mm.user_id = ? AND m.deleted_at IS NULL
    ORDER BY mm.created_at DESC LIMIT ?
  `).all(orgId, userId, Math.max(1, Math.floor(limit)))) as JsonObject[]);
}

/** Replies (thread messages) under messages the user authored. */
export async function listRepliesToUser(orgId: string, userId: string, sinceIso: string, limit = 30) {
  return ((await getChannelsDatabase().prepare(`
    SELECT m.id AS message_id, m.channel_id, m.parent_id, m.author_id, m.text, m.created_at
    FROM messages m
    JOIN messages p ON p.id = m.parent_id
    WHERE m.organization_id = ? AND p.author_id = ? AND m.author_id <> ?
      AND m.deleted_at IS NULL AND m.created_at > ?
    ORDER BY m.created_at DESC LIMIT ?
  `).all(orgId, userId, userId, cleanText(sinceIso), Math.max(1, Math.floor(limit)))) as JsonObject[]);
}

/** Reactions others left on messages the user authored. */
export async function listReactionsToUser(orgId: string, userId: string, sinceIso: string, limit = 30) {
  return ((await getChannelsDatabase().prepare(`
    SELECT r.message_id, r.user_id AS reactor_id, r.emoji, r.created_at,
           m.channel_id, m.parent_id, m.text AS message_text
    FROM message_reactions r
    JOIN messages m ON m.id = r.message_id
    WHERE r.organization_id = ? AND m.author_id = ? AND r.user_id <> ?
      AND m.deleted_at IS NULL AND r.created_at > ?
    ORDER BY r.created_at DESC LIMIT ?
  `).all(orgId, userId, userId, cleanText(sinceIso), Math.max(1, Math.floor(limit)))) as JsonObject[]);
}

export async function unreadSummary(orgId: string, userId: string, channelIds: string[]) {
  const summary = new Map<string, { unread_count: number; mention_count: number; last_read_seq: number; manual_unread_seq: number | null }>();
  if (!channelIds.length) return summary;
  const db = getChannelsDatabase();
  for (const channelId of channelIds) {
    const state = (await readStateFor(channelId, userId));
    const unreadRow = (await db.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE organization_id = ? AND channel_id = ? AND seq > ? AND deleted_at IS NULL AND author_id <> ?
        AND (
          parent_id IS NULL OR EXISTS (
            SELECT 1 FROM channel_thread_subscriptions s
            WHERE s.root_message_id = messages.parent_id AND s.user_id = ? AND s.following = 1
          )
        )
    `).get(orgId, channelId, state.effective_read_seq, userId, userId)) as JsonObject;
    const mentionRow = (await db.prepare(`
      SELECT COUNT(*) AS n FROM message_mentions
      WHERE organization_id = ? AND channel_id = ? AND user_id = ? AND seq > ?
    `).get(orgId, channelId, userId, state.effective_read_seq)) as JsonObject;
    summary.set(channelId, {
      unread_count: Number(unreadRow?.n ?? 0),
      mention_count: Number(mentionRow?.n ?? 0),
      last_read_seq: state.last_read_seq,
      manual_unread_seq: state.manual_unread_seq
    });
  }
  return summary;
}

// --- search ---------------------------------------------------------------------

export async function searchMessageRecords(orgId: string, query: string, options: { channelIds?: string[] | null; limit?: number } = {}) {
  const db = getChannelsDatabase();
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
  const sanitized = query.replace(/["*]/g, " ").trim();
  if (!sanitized) return [];
  const match = sanitized.split(/\s+/).map((term) => `"${term}"`).join(" ");
  const rows = (await db.prepare(`
    SELECT m.* FROM messages_fts f
    JOIN messages m ON m.id = f.message_id
    WHERE f.organization_id = ? AND messages_fts MATCH ? AND m.deleted_at IS NULL
    ORDER BY rank
    LIMIT ?
  `, `WITH criteria AS (SELECT ?::text AS org, plainto_tsquery('simple', ?) AS term)
    SELECT m.* FROM messages_fts f JOIN messages m ON m.id=f.message_id CROSS JOIN criteria
    WHERE f.organization_id=criteria.org AND f.search_vector @@ criteria.term AND m.deleted_at IS NULL
    ORDER BY ts_rank(f.search_vector, criteria.term) DESC, m.created_at DESC LIMIT ?`).all(orgId, match, limit * 5)) as JsonObject[];
  let messages = rows.map(messageFromRow);
  if (options.channelIds) {
    const allowed = new Set(options.channelIds);
    messages = messages.filter((message) => allowed.has(message.channel_id));
  }
  return messages.slice(0, limit);
}

export async function resetChannelsStorageForTests() {
  (await closeChannelsDatabase());
}
