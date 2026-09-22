import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStore } from "../platform/sql_store.js";

import { getCommunicationsDatabase } from "../messaging/communications_storage.js";
import { notFound } from "../platform/errors.js";

export type ChatJson = Record<string, unknown>;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseJson(value: unknown, fallback: unknown = {}) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function getChatDatabase(): SqlStore { return getCommunicationsDatabase(); }
/** Schema lifecycle is owned by the shared communications store. */
export function resetChatSchemaCache() {}

export async function initializeChatSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_widget_keys (
      widget_key      TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id       TEXT NOT NULL DEFAULT 'default',
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL,
      revoked_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_widget_keys_org ON chat_widget_keys(organization_id, branch_id, status);

    CREATE TABLE IF NOT EXISTS chat_visitors (
      id                 TEXT PRIMARY KEY,
      organization_id    TEXT NOT NULL,
      branch_id          TEXT NOT NULL DEFAULT 'default',
      token_hash         TEXT NOT NULL,
      contact_id         TEXT,
      display_name       TEXT,
      email              TEXT,
      phone              TEXT,
      ip_hash            TEXT,
      last_ip_hash       TEXT,
      user_agent         TEXT,
      page_url           TEXT,
      portal_customer_id TEXT,
      first_seen_at      TEXT NOT NULL,
      last_seen_at       TEXT NOT NULL,
      metadata_json      TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_visitors_token ON chat_visitors(organization_id, token_hash);
    CREATE INDEX IF NOT EXISTS idx_chat_visitors_ip ON chat_visitors(organization_id, ip_hash, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_chat_visitors_contact ON chat_visitors(organization_id, contact_id);

    CREATE TABLE IF NOT EXISTS chat_conversation_state (
      conversation_id      TEXT PRIMARY KEY,
      organization_id      TEXT NOT NULL,
      branch_id            TEXT NOT NULL DEFAULT 'default',
      visitor_id           TEXT NOT NULL,
      widget_key           TEXT NOT NULL,
      origin_url           TEXT,
      source               TEXT NOT NULL DEFAULT 'website',
      handling_mode        TEXT NOT NULL DEFAULT 'human',
      ai_status            TEXT,
      claimed_by_user_id   TEXT,
      claimed_at           TEXT,
      claim_expires_at     TEXT,
      visitor_last_seen_at TEXT,
      visitor_typing_until TEXT,
      agent_typing_user_id TEXT,
      agent_typing_name    TEXT,
      agent_typing_until   TEXT,
      first_response_due_at TEXT,
      last_notified_at     TEXT,
      escalated_at         TEXT,
      closed_at            TEXT,
      closed_by            TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_state_org_open ON chat_conversation_state(organization_id, closed_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_state_visitor ON chat_conversation_state(organization_id, visitor_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_agent_presence (
      organization_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      user_name       TEXT,
      conversation_id TEXT NOT NULL DEFAULT '',
      last_seen_at    TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS chat_read_state (
      organization_id      TEXT NOT NULL,
      user_id              TEXT NOT NULL,
      conversation_id      TEXT NOT NULL,
      last_read_message_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS chat_ai_usage_events (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      conversation_id TEXT,
      kind            TEXT NOT NULL,
      model           TEXT NOT NULL,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      tool_rounds     INTEGER,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_ai_usage_org ON chat_ai_usage_events(organization_id, created_at);
  `));
}

function rowObject(row: unknown): ChatJson {
  return row && typeof row === "object" ? { ...(row as ChatJson) } : {};
}

// --- Widget keys -----------------------------------------------------------

export function generateWidgetKey() {
  return `cw_${randomBytes(18).toString("base64url")}`;
}

export async function ensureWidgetKey(organizationId: string, branchId = "default") {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getChatDatabase();
  const existing = (await db.prepare(
    "SELECT * FROM chat_widget_keys WHERE organization_id = ? AND branch_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(organizationId, branchId));
  if (existing) return rowObject(existing);
  const key = generateWidgetKey();
  (await db.prepare("INSERT INTO chat_widget_keys (widget_key, organization_id, branch_id, status, created_at) VALUES (?, ?, ?, 'active', ?)")
    .run(key, organizationId, branchId, nowIso()));
  return rowObject((await db.prepare("SELECT * FROM chat_widget_keys WHERE widget_key = ?").get(key)));

  }));
}

export async function rotateWidgetKey(organizationId: string, branchId = "default") {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getChatDatabase();
  const now = nowIso();
  (await db.prepare("UPDATE chat_widget_keys SET status = 'revoked', revoked_at = ? WHERE organization_id = ? AND branch_id = ? AND status = 'active'")
    .run(now, organizationId, branchId));
  return (await ensureWidgetKey(organizationId, branchId));

  }));
}

export async function findWidgetKey(widgetKey: string) {
  const row = (await getChatDatabase().prepare("SELECT * FROM chat_widget_keys WHERE widget_key = ?").get(cleanText(widgetKey) as string));
  return row ? rowObject(row) : null;
}

// --- Visitors --------------------------------------------------------------

export function generateVisitorToken() {
  return `cv_${randomBytes(32).toString("base64url")}`;
}

export async function findVisitorByTokenHash(organizationId: string, tokenHash: string) {
  const row = (await getChatDatabase().prepare("SELECT * FROM chat_visitors WHERE organization_id = ? AND token_hash = ?")
    .get(organizationId, tokenHash));
  return row ? visitorFromRow(row) : null;
}

export async function readVisitor(organizationId: string, visitorId: string) {
  const row = (await getChatDatabase().prepare("SELECT * FROM chat_visitors WHERE organization_id = ? AND id = ?")
    .get(organizationId, visitorId));
  if (!row) throw notFound("chat_visitor_not_found", "This chat visitor was not found.");
  return visitorFromRow(row);
}

function visitorFromRow(row: unknown) {
  const record = rowObject(row);
  record.metadata = parseJson(record.metadata_json);
  delete record.metadata_json;
  return record;
}

export async function createVisitor(input: ChatJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getChatDatabase();
  const now = nowIso();
  const id = `visitor_${randomUUID().replace(/-/g, "")}`;
  (await db.prepare(`INSERT INTO chat_visitors (
    id, organization_id, branch_id, token_hash, contact_id, display_name, email, phone,
    ip_hash, last_ip_hash, user_agent, page_url, portal_customer_id, first_seen_at, last_seen_at, metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, cleanText(input.organization_id) as string, (cleanText(input.branch_id) as string) || "default",
      cleanText(input.token_hash) as string, (cleanText(input.contact_id) as string) || null,
      (cleanText(input.display_name) as string) || null, (cleanText(input.email) as string) || null,
      (cleanText(input.phone) as string) || null, (cleanText(input.ip_hash) as string) || null,
      (cleanText(input.ip_hash) as string) || null, (cleanText(input.user_agent) as string) || null,
      (cleanText(input.page_url) as string) || null, (cleanText(input.portal_customer_id) as string) || null,
      now, now, json(input.metadata)
    ));
  return (await readVisitor(cleanText(input.organization_id) as string, id));

  }));
}

const VISITOR_PATCH_COLUMNS = ["contact_id", "display_name", "email", "phone", "last_ip_hash", "user_agent", "page_url", "portal_customer_id"] as const;

export async function updateVisitor(organizationId: string, visitorId: string, patch: ChatJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getChatDatabase();
  const sets: string[] = ["last_seen_at = ?"];
  const params: SQLInputValue[] = [nowIso()];
  for (const column of VISITOR_PATCH_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, column)) {
      sets.push(`${column} = ?`);
      params.push((cleanText(patch[column]) as string) || null);
    }
  }
  params.push(organizationId, visitorId);
  (await db.prepare(`UPDATE chat_visitors SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`).run(...params));
  return (await readVisitor(organizationId, visitorId));

  }));
}

export async function findVisitorsByIpHash(organizationId: string, ipHash: string, excludeVisitorId = "", limit = 5) {
  if (!ipHash) return [];
  return (await getChatDatabase().prepare(
    "SELECT * FROM chat_visitors WHERE organization_id = ? AND ip_hash = ? AND id != ? ORDER BY last_seen_at DESC LIMIT ?"
  ).all(organizationId, ipHash, excludeVisitorId, limit)).map(visitorFromRow);
}

// --- Conversation state ----------------------------------------------------

export async function createConversationState(input: ChatJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getChatDatabase();
  const now = nowIso();
  (await db.prepare(`INSERT INTO chat_conversation_state (
    conversation_id, organization_id, branch_id, visitor_id, widget_key, origin_url, source,
    handling_mode, ai_status, first_response_due_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      cleanText(input.conversation_id) as string, cleanText(input.organization_id) as string,
      (cleanText(input.branch_id) as string) || "default", cleanText(input.visitor_id) as string,
      cleanText(input.widget_key) as string, (cleanText(input.origin_url) as string) || null,
      (cleanText(input.source) as string) || "website",
      (cleanText(input.handling_mode) as string) || "human", (cleanText(input.ai_status) as string) || null,
      (cleanText(input.first_response_due_at) as string) || null, now, now
    ));
  return (await readConversationState(cleanText(input.organization_id) as string, cleanText(input.conversation_id) as string));

  }));
}

export async function readConversationState(organizationId: string, conversationId: string) {
  const row = (await getChatDatabase().prepare("SELECT * FROM chat_conversation_state WHERE organization_id = ? AND conversation_id = ?")
    .get(organizationId, conversationId));
  if (!row) throw notFound("chat_conversation_not_found", "This chat conversation was not found.");
  return rowObject(row);
}

const STATE_PATCH_COLUMNS = [
  "handling_mode", "ai_status", "claimed_by_user_id", "claimed_at", "claim_expires_at",
  "visitor_last_seen_at", "visitor_typing_until", "agent_typing_user_id", "agent_typing_name",
  "agent_typing_until", "first_response_due_at", "last_notified_at", "escalated_at", "closed_at", "closed_by"
] as const;

export async function updateConversationState(organizationId: string, conversationId: string, patch: ChatJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getChatDatabase();
  const sets: string[] = ["updated_at = ?"];
  const params: SQLInputValue[] = [nowIso()];
  for (const column of STATE_PATCH_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, column)) {
      sets.push(`${column} = ?`);
      params.push((cleanText(patch[column]) as string) || null);
    }
  }
  params.push(organizationId, conversationId);
  (await db.prepare(`UPDATE chat_conversation_state SET ${sets.join(", ")} WHERE organization_id = ? AND conversation_id = ?`).run(...params));
  return (await readConversationState(organizationId, conversationId));

  }));
}

export async function listConversationStatesForVisitor(organizationId: string, visitorId: string, limit = 20) {
  return (await getChatDatabase().prepare(
    "SELECT * FROM chat_conversation_state WHERE organization_id = ? AND visitor_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(organizationId, visitorId, limit)).map(rowObject);
}

/**
 * Inbox listing: chat conversation state joined with the shared conversation
 * row, its latest visible message, and the caller's unread count.
 */
export async function listInboxConversations(organizationId: string, userId: string, options: ChatJson = {}) {
  const db = getChatDatabase();
  const status = cleanText(options.status) as string;
  const limit = Math.max(1, Math.min(200, Number(options.limit || 100)));
  const statusCondition = status === "closed"
    ? "s.closed_at IS NOT NULL"
    : status === "all" ? "1=1" : "s.closed_at IS NULL";
  const rows = (await db.prepare(`
    SELECT s.*, c.subject, c.contact_id AS conversation_contact_id, c.project_id AS conversation_project_id,
           c.last_message_at, c.status AS conversation_status,
           v.display_name AS visitor_name, v.email AS visitor_email, v.phone AS visitor_phone,
           v.contact_id AS visitor_contact_id, v.page_url AS visitor_page_url, v.portal_customer_id,
           lm.text_body AS last_message_text, lm.direction AS last_message_direction, lm.sender_json AS last_message_sender_json,
           li.created_at AS last_inbound_at,
           COALESCE(u.unread, 0) AS unread_count,
           r.last_read_message_at
    FROM chat_conversation_state s
    JOIN communication_conversations c ON c.organization_id = s.organization_id AND c.id = s.conversation_id
    JOIN chat_visitors v ON v.organization_id = s.organization_id AND v.id = s.visitor_id
    LEFT JOIN communication_messages lm ON lm.id = (
      SELECT m1.id FROM communication_messages m1
      WHERE m1.organization_id = s.organization_id AND m1.conversation_id = s.conversation_id
        AND COALESCE(m1.purpose, '') != 'internal'
      ORDER BY m1.created_at DESC, m1.id DESC LIMIT 1
    )
    LEFT JOIN communication_messages li ON li.id = (
      SELECT m2.id FROM communication_messages m2
      WHERE m2.organization_id = s.organization_id AND m2.conversation_id = s.conversation_id AND m2.direction = 'inbound'
      ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1
    )
    LEFT JOIN chat_read_state r ON r.organization_id = s.organization_id AND r.conversation_id = s.conversation_id AND r.user_id = ?
    LEFT JOIN (
      SELECT m.conversation_id AS cid, COUNT(*) AS unread
      FROM communication_messages m
      LEFT JOIN chat_read_state rs ON rs.organization_id = m.organization_id AND rs.conversation_id = m.conversation_id AND rs.user_id = ?
      WHERE m.organization_id = ? AND m.channel = 'webchat' AND m.direction = 'inbound'
        AND m.created_at > COALESCE(rs.last_read_message_at, '')
      GROUP BY m.conversation_id
    ) u ON u.cid = s.conversation_id
    WHERE s.organization_id = ? AND ${statusCondition}
    ORDER BY COALESCE(c.last_message_at, s.updated_at) DESC
    LIMIT ?
  `).all(userId, userId, organizationId, organizationId, limit));
  return rows.map((row) => {
    const record = rowObject(row);
    record.last_message_sender = parseJson(record.last_message_sender_json);
    delete record.last_message_sender_json;
    return record;
  });
}

/** Cursor feed over a conversation's messages. Cursor: `${created_at}|${id}`. */
export async function listMessagesAfter(organizationId: string, conversationId: string, cursor: string, options: ChatJson = {}) {
  const db = getChatDatabase();
  const [cursorAt, cursorId] = String(cursor || "").split("|");
  const conditions = ["organization_id = ?", "conversation_id = ?"];
  const params: SQLInputValue[] = [organizationId, conversationId];
  if (cursorAt) {
    conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
    params.push(cursorAt, cursorAt, cursorId || "");
  }
  if (options.public_only) conditions.push("COALESCE(purpose, '') != 'internal'");
  const limit = Math.max(1, Math.min(500, Number(options.limit || 200)));
  params.push(limit);
  return (await db.prepare(
    `SELECT * FROM communication_messages WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT ?`
  ).all(...params)).map((row) => {
    const record = rowObject(row);
    for (const [key, target] of [["sender_json", "sender"], ["metadata_json", "metadata"]] as const) {
      record[target] = parseJson(record[key]);
      delete record[key];
    }
    return record;
  });
}

export function messageCursor(message: ChatJson) {
  return `${cleanText(message.created_at)}|${cleanText(message.id)}`;
}

// --- Presence --------------------------------------------------------------

export async function upsertPresence(organizationId: string, userId: string, userName: string, conversationId = "") {
  (await getChatDatabase().prepare(`
    INSERT INTO chat_agent_presence (organization_id, user_id, user_name, conversation_id, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, user_id, conversation_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, user_name = excluded.user_name
  `).run(organizationId, userId, userName || null, conversationId, nowIso()));
}

export async function listFreshPresence(organizationId: string, cutoffIso: string) {
  return (await getChatDatabase().prepare(
    "SELECT * FROM chat_agent_presence WHERE organization_id = ? AND last_seen_at >= ?"
  ).all(organizationId, cutoffIso)).map(rowObject);
}

export async function lastGlobalPresence(organizationId: string, userId: string) {
  const row = (await getChatDatabase().prepare(
    "SELECT last_seen_at FROM chat_agent_presence WHERE organization_id = ? AND user_id = ? AND conversation_id = ''"
  ).get(organizationId, userId));
  return row ? cleanText(rowObject(row).last_seen_at) as string : "";
}

// --- Read state ------------------------------------------------------------

export async function upsertReadState(organizationId: string, userId: string, conversationId: string, lastReadAt: string) {
  (await getChatDatabase().prepare(`
    INSERT INTO chat_read_state (organization_id, user_id, conversation_id, last_read_message_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(organization_id, user_id, conversation_id) DO UPDATE SET
      last_read_message_at = CASE WHEN chat_read_state.last_read_message_at > excluded.last_read_message_at THEN chat_read_state.last_read_message_at ELSE excluded.last_read_message_at END
  `).run(organizationId, userId, conversationId, lastReadAt));
}

// --- AI usage --------------------------------------------------------------

export async function createAiUsageEvent(input: ChatJson) {
  (await getChatDatabase().prepare(`INSERT INTO chat_ai_usage_events (
    id, organization_id, conversation_id, kind, model, input_tokens, output_tokens, tool_rounds, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `aiusage_${randomUUID().replace(/-/g, "")}`, cleanText(input.organization_id) as string,
      (cleanText(input.conversation_id) as string) || null, cleanText(input.kind) as string,
      cleanText(input.model) as string, Number(input.input_tokens || 0), Number(input.output_tokens || 0),
      Number(input.tool_rounds || 0), nowIso()
    ));
}

export async function countAiEventsSince(organizationId: string, kind: string, sinceIso: string) {
  const row = (await getChatDatabase().prepare(
    "SELECT COUNT(*) AS total FROM chat_ai_usage_events WHERE organization_id = ? AND kind = ? AND created_at >= ?"
  ).get(organizationId, kind, sinceIso));
  return Number(rowObject(row).total || 0);
}

export async function listAiUsageEvents(organizationId: string, sinceIso: string) {
  return (await getChatDatabase().prepare(
    "SELECT * FROM chat_ai_usage_events WHERE organization_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 500"
  ).all(organizationId, sinceIso)).map(rowObject);
}
