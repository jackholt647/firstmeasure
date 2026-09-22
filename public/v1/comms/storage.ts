import { randomUUID } from "node:crypto";
import type { SqlStore } from "../platform/sql_store.js";

import { getCommunicationsDatabase } from "../messaging/communications_storage.js";
import { notFound } from "../platform/errors.js";

export type CommsJson = Record<string, unknown>;

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

export function getCommsDatabase(): SqlStore { return getCommunicationsDatabase(); }
/** Schema lifecycle is owned by the shared communications store. */
export function resetCommsSchemaCache() {}

export async function initializeCommsSchema(db: SqlStore) {
  // Full-text index over communication_messages. External-content FTS5 with
  // trigger maintenance means EVERY writer (messaging, chat, email engine,
  // automations) is indexed without knowing comms exists.
  if (db.isPostgres) {
    await db.exec(`ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS search_document tsvector
      GENERATED ALWAYS AS (to_tsvector('english', COALESCE(subject, '') || ' ' || COALESCE(text_body, ''))) STORED;
      CREATE INDEX IF NOT EXISTS communication_messages_search_idx ON communication_messages USING GIN(search_document);`);
  } else {
  (await db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS comms_message_fts USING fts5(
      subject, text_body,
      content='communication_messages',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS comms_message_fts_ai AFTER INSERT ON communication_messages BEGIN
      INSERT INTO comms_message_fts(rowid, subject, text_body)
      VALUES (new.rowid, COALESCE(new.subject, ''), COALESCE(new.text_body, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS comms_message_fts_ad AFTER DELETE ON communication_messages BEGIN
      INSERT INTO comms_message_fts(comms_message_fts, rowid, subject, text_body)
      VALUES ('delete', old.rowid, COALESCE(old.subject, ''), COALESCE(old.text_body, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS comms_message_fts_au AFTER UPDATE OF subject, text_body ON communication_messages BEGIN
      INSERT INTO comms_message_fts(comms_message_fts, rowid, subject, text_body)
      VALUES ('delete', old.rowid, COALESCE(old.subject, ''), COALESCE(old.text_body, ''));
      INSERT INTO comms_message_fts(rowid, subject, text_body)
      VALUES (new.rowid, COALESCE(new.subject, ''), COALESCE(new.text_body, ''));
    END;

  `));
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS comms_agent_threads (
      id                 TEXT PRIMARY KEY,
      organization_id    TEXT NOT NULL,
      branch_id          TEXT NOT NULL DEFAULT 'default',
      project_id         TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT NOT NULL DEFAULT '',
      title              TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'idle',
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comms_agent_threads_scope
      ON comms_agent_threads(organization_id, project_id, created_by_user_id, updated_at);

    CREATE TABLE IF NOT EXISTS comms_agent_messages (
      id              TEXT PRIMARY KEY,
      thread_id       TEXT NOT NULL REFERENCES comms_agent_threads(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      data_json       TEXT NOT NULL DEFAULT '{}',
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comms_agent_messages_thread
      ON comms_agent_messages(thread_id, created_at);

    CREATE TABLE IF NOT EXISTS comms_auto_replies (
      id                 TEXT PRIMARY KEY,
      organization_id    TEXT NOT NULL,
      branch_id          TEXT NOT NULL DEFAULT 'default',
      project_id         TEXT NOT NULL DEFAULT '',
      conversation_id    TEXT NOT NULL DEFAULT '',
      inbound_message_id TEXT NOT NULL,
      outbound_message_id TEXT NOT NULL DEFAULT '',
      channel            TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'draft',
      content_json       TEXT NOT NULL DEFAULT '{}',
      error              TEXT NOT NULL DEFAULT '',
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comms_auto_replies_scope
      ON comms_auto_replies(organization_id, project_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_auto_replies_inbound
      ON comms_auto_replies(organization_id, inbound_message_id);

    CREATE TABLE IF NOT EXISTS comms_templates (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id       TEXT NOT NULL DEFAULT 'default',
      name            TEXT NOT NULL,
      channel         TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT '',
      subject         TEXT NOT NULL DEFAULT '',
      body            TEXT NOT NULL,
      variables_json  TEXT NOT NULL DEFAULT '[]',
      seed_key        TEXT NOT NULL DEFAULT '',
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comms_templates_scope
      ON comms_templates(organization_id, branch_id, channel, active, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_templates_seed
      ON comms_templates(organization_id, branch_id, seed_key)
      WHERE seed_key <> '';

    CREATE TABLE IF NOT EXISTS comms_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
  // One-time backfill for databases that predate the FTS table. NOTE:
  // count(*) on an external-content FTS5 table reads THROUGH to the content
  // table, so it cannot detect an unbuilt index — hence the explicit marker.
  const marker = (await db.prepare("SELECT value FROM comms_meta WHERE key = 'fts_rebuilt'").get()) as CommsJson | undefined;
  if (!marker && !db.isPostgres) {
    (await db.exec("INSERT INTO comms_message_fts(comms_message_fts) VALUES ('rebuild')"));
    (await db.prepare("INSERT INTO comms_meta (key, value) VALUES ('fts_rebuilt', ?)").run(nowIso()));
  }
}

// ---------------------------------------------------------------------------
// Reusable message templates
// ---------------------------------------------------------------------------

const STARTER_TEMPLATES = [
  {
    seed_key: "sms_missed_call",
    name: "Sorry we missed you",
    channel: "sms",
    category: "Calls",
    body: "Hi {{first_name}}, this is {{sender_name}} from {{company_name}}. I just tried to reach you about {{project_name}}. Call or text me back when you have a moment.",
    variables: ["first_name", "sender_name", "company_name", "project_name"]
  },
  {
    seed_key: "sms_follow_up",
    name: "Quick follow-up",
    channel: "sms",
    category: "Calls",
    body: "Hi {{first_name}}, here is the follow-up I promised from {{company_name}}: ",
    variables: ["first_name", "company_name"]
  },
  {
    seed_key: "sms_appointment",
    name: "Appointment confirmation",
    channel: "sms",
    category: "Scheduling",
    body: "Hi {{first_name}}, your appointment with {{company_name}} is confirmed for {{appointment_time}}. Reply here if anything changes.",
    variables: ["first_name", "company_name", "appointment_time"]
  }
] as const;

function templateFromRow(row: CommsJson) {
  return {
    ...row,
    active: Number(row.active) === 1,
    variables: parseJson(row.variables_json, []),
    variables_json: undefined
  } as CommsJson;
}

export async function seedCommsTemplates(organizationId: string, branchId = "default") {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommsDatabase();
  const normalizedBranchId = branchId || "default";
  const markerKey = `templates_seeded:${organizationId}:${normalizedBranchId}`;
  const seeded = (await db.prepare("SELECT 1 AS seeded FROM comms_meta WHERE key = ?").get(markerKey));
  if (seeded) return;
  const now = nowIso();
  const insert = db.prepare(`INSERT INTO comms_templates (
    id, organization_id, branch_id, name, channel, category, subject, body,
    variables_json, seed_key, active, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`);
  for (const starter of STARTER_TEMPLATES) {
    (await insert.run(
      `cmt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      organizationId,
      normalizedBranchId,
      starter.name,
      starter.channel,
      starter.category,
      starter.body,
      json(starter.variables),
      starter.seed_key,
      now,
      now
    ));
  }
  (await db.prepare("INSERT INTO comms_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(markerKey, now));

  }));
}

export async function listCommsTemplates(
  organizationId: string,
  branchId = "default",
  options: { channel?: string; active?: boolean } = {}
) {
  (await seedCommsTemplates(organizationId, branchId));
  const conditions = ["organization_id = ?", "branch_id = ?"];
  const params: unknown[] = [organizationId, branchId || "default"];
  const channel = cleanText(options.channel).toLowerCase();
  if (channel) {
    conditions.push("channel = ?");
    params.push(channel);
  }
  if (typeof options.active === "boolean") {
    conditions.push("active = ?");
    params.push(options.active ? 1 : 0);
  }
  return ((await getCommsDatabase().prepare(`
    SELECT * FROM comms_templates
    WHERE ${conditions.join(" AND ")}
    ORDER BY active DESC, channel ASC, category ASC, LOWER(name) ASC
  `).all(...(params as never[]))) as CommsJson[]).map(templateFromRow);
}

export async function readCommsTemplate(organizationId: string, branchId: string, templateId: string) {
  const row = (await getCommsDatabase().prepare(`
    SELECT * FROM comms_templates
    WHERE organization_id = ? AND branch_id = ? AND id = ?
  `).get(organizationId, branchId || "default", templateId)) as CommsJson | undefined;
  if (!row) throw notFound("comms_template_not_found", "This message template was not found.");
  return templateFromRow(row);
}

export async function createCommsTemplate(organizationId: string, branchId: string, input: CommsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommsDatabase();
  const now = nowIso();
  const id = `cmt_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  (await db.prepare(`INSERT INTO comms_templates (
    id, organization_id, branch_id, name, channel, category, subject, body,
    variables_json, seed_key, active, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`).run(
    id,
    organizationId,
    branchId || "default",
    cleanText(input.name),
    cleanText(input.channel).toLowerCase(),
    cleanText(input.category),
    cleanText(input.subject),
    String(input.body ?? ""),
    json(Array.isArray(input.variables) ? input.variables : []),
    input.active === false ? 0 : 1,
    now,
    now
  ));
  return (await readCommsTemplate(organizationId, branchId, id));

  }));
}

export async function updateCommsTemplate(organizationId: string, branchId: string, templateId: string, patch: CommsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const current = (await readCommsTemplate(organizationId, branchId, templateId));
  (await getCommsDatabase().prepare(`UPDATE comms_templates SET
    name = ?, channel = ?, category = ?, subject = ?, body = ?,
    variables_json = ?, active = ?, updated_at = ?
    WHERE organization_id = ? AND branch_id = ? AND id = ?
  `).run(
    cleanText(patch.name ?? current.name),
    cleanText(patch.channel ?? current.channel).toLowerCase(),
    cleanText(patch.category ?? current.category),
    cleanText(patch.subject ?? current.subject),
    String(patch.body ?? current.body ?? ""),
    json(Array.isArray(patch.variables) ? patch.variables : current.variables),
    (patch.active ?? current.active) === false ? 0 : 1,
    nowIso(),
    organizationId,
    branchId || "default",
    templateId
  ));
  return (await readCommsTemplate(organizationId, branchId, templateId));

  }));
}

export async function deleteCommsTemplate(organizationId: string, branchId: string, templateId: string) {
  return (await getCommunicationsDatabase().transaction(async () => {
  (await readCommsTemplate(organizationId, branchId, templateId));
  (await getCommsDatabase().prepare(`
    DELETE FROM comms_templates
    WHERE organization_id = ? AND branch_id = ? AND id = ?
  `).run(organizationId, branchId || "default", templateId));

  }));
}

/** Turn free text into a safe FTS5 prefix query. */
export function ftsQueryFromText(text: string) {
  const terms = cleanText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (!terms.length) return "";
  return terms.map((term) => `"${term.replace(/"/g, "")}"*`).join(" ");
}

export type CommsSearchHit = { message: CommsJson; snippet: string };

export async function searchCommunicationMessages(
  organizationId: string,
  query: string,
  options: { project_id?: string; channel?: string; limit?: number;branch_id?:string } = {}
): Promise<CommsSearchHit[]> {
  const db = getCommsDatabase();
  const match = ftsQueryFromText(query);
  if (!match) return [];
  const conditions = ["m.organization_id = ?"];
  const pgMatch = cleanText(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12).map(term => `'${term}':*`).join(" & ");
  const params: unknown[] = [db.isPostgres ? pgMatch : match, organizationId];
  if(cleanText(options.branch_id)){conditions.push('m.branch_id = ?');params.push(options.branch_id);}
  const projectId = cleanText(options.project_id);
  if (projectId) { conditions.push("m.project_id = ?"); params.push(projectId); }
  const channel = cleanText(options.channel);
  if (channel) { conditions.push("m.channel = ?"); params.push(channel); }
  const limit = Math.max(1, Math.min(100, Number(options.limit || 25)));
  params.push(limit);
  const rows = (await db.prepare(`
    SELECT m.*, snippet(comms_message_fts, 1, '[', ']', ' … ', 18) AS fts_snippet
    FROM comms_message_fts f
    JOIN communication_messages m ON m.rowid = f.rowid
    WHERE comms_message_fts MATCH ? AND ${conditions.join(" AND ")}
    ORDER BY m.created_at DESC
    LIMIT ?
  `, `WITH criteria AS (SELECT to_tsquery('english', ?) AS query)
    SELECT m.*, ts_headline('english', m.text_body, criteria.query, 'StartSel=[,StopSel=],MaxWords=18,MinWords=5') AS fts_snippet
    FROM communication_messages m CROSS JOIN criteria
    WHERE m.search_document @@ criteria.query AND ${conditions.join(" AND ")}
    ORDER BY m.created_at DESC LIMIT ?`).all(...(params as never[]))) as CommsJson[];
  return rows.map((row) => {
    const snippet = cleanText(row.fts_snippet);
    delete row.fts_snippet;
    return { message: row, snippet };
  });
}

// ---------------------------------------------------------------------------
// Comms agent threads
// ---------------------------------------------------------------------------

function threadFromRow(row: CommsJson) {
  return { ...row };
}

export async function createCommsAgentThread(input: CommsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommsDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `cat_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  (await db.prepare(`INSERT INTO comms_agent_threads (id, organization_id, branch_id, project_id, created_by_user_id, title, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)`)
    .run(
      id, cleanText(input.organization_id), cleanText(input.branch_id) || "default",
      cleanText(input.project_id), cleanText(input.created_by_user_id), cleanText(input.title), now, now
    ));
  return (await readCommsAgentThread(cleanText(input.organization_id), id));

  }));
}

export async function readCommsAgentThread(organizationId: string, threadId: string) {
  const row = (await getCommsDatabase().prepare("SELECT * FROM comms_agent_threads WHERE organization_id = ? AND id = ?")
    .get(organizationId, threadId)) as CommsJson | undefined;
  if (!row) throw notFound("comms_thread_not_found", "This comms agent thread was not found.");
  return threadFromRow(row);
}

export async function listCommsAgentThreads(organizationId: string, projectId: string, userId: string, limit = 20) {
  return ((await getCommsDatabase().prepare(`
    SELECT * FROM comms_agent_threads
    WHERE organization_id = ? AND project_id = ? AND created_by_user_id = ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(organizationId, projectId, userId, Math.max(1, Math.min(100, limit)))) as CommsJson[]).map(threadFromRow);
}

export async function updateCommsAgentThread(organizationId: string, threadId: string, patch: CommsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const current = (await readCommsAgentThread(organizationId, threadId));
  (await getCommsDatabase().prepare("UPDATE comms_agent_threads SET title = ?, status = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
    .run(
      cleanText(patch.title ?? current.title),
      cleanText(patch.status ?? current.status) || "idle",
      nowIso(), organizationId, threadId
    ));
  return (await readCommsAgentThread(organizationId, threadId));

  }));
}

export async function appendCommsAgentMessage(organizationId: string, threadId: string, input: CommsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  await readCommsAgentThread(organizationId, threadId);
  const db = getCommsDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `cam_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  (await db.prepare("INSERT INTO comms_agent_messages (id, thread_id, organization_id, role, content, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, threadId, organizationId, cleanText(input.role) || "user", String(input.content ?? ""), json(input.data), now));
  (await db.prepare("UPDATE comms_agent_threads SET updated_at = ? WHERE organization_id = ? AND id = ?").run(now, organizationId, threadId));
  return { id, thread_id: threadId, role: cleanText(input.role) || "user", content: String(input.content ?? ""), data: input.data ?? {}, created_at: now };

  }));
}

export async function listCommsAgentMessages(organizationId: string, threadId: string, limit = 200) {
  return ((await getCommsDatabase().prepare(`
    SELECT * FROM comms_agent_messages WHERE organization_id = ? AND thread_id = ?
    ORDER BY created_at ASC LIMIT ?
  `).all(organizationId, threadId, Math.max(1, Math.min(500, limit)))) as CommsJson[])
    .map((row) => ({ ...row, data: parseJson(row.data_json), data_json: undefined } as CommsJson));
}

// ---------------------------------------------------------------------------
// Auto-reply log
// ---------------------------------------------------------------------------

export async function createAutoReplyRecord(input: CommsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommsDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `car_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  try {
    (await db.prepare(`INSERT INTO comms_auto_replies (
      id, organization_id, branch_id, project_id, conversation_id, inbound_message_id,
      outbound_message_id, channel, status, content_json, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, cleanText(input.organization_id), cleanText(input.branch_id) || "default",
        cleanText(input.project_id), cleanText(input.conversation_id), cleanText(input.inbound_message_id),
        cleanText(input.outbound_message_id), cleanText(input.channel), cleanText(input.status) || "draft",
        json(input.content), cleanText(input.error), now, now
      ));
  } catch {
    // Unique inbound index hit — an auto reply already exists for this message.
    return null;
  }
  return (await readAutoReplyRecord(cleanText(input.organization_id), id));

  }));
}

export async function readAutoReplyRecord(organizationId: string, id: string) {
  const row = (await getCommsDatabase().prepare("SELECT * FROM comms_auto_replies WHERE organization_id = ? AND id = ?")
    .get(organizationId, id)) as CommsJson | undefined;
  if (!row) throw notFound("auto_reply_not_found", "This auto reply was not found.");
  return { ...row, content: parseJson(row.content_json), content_json: undefined } as CommsJson;
}

export async function updateAutoReplyRecord(organizationId: string, id: string, patch: CommsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const current = (await readAutoReplyRecord(organizationId, id));
  (await getCommsDatabase().prepare("UPDATE comms_auto_replies SET status = ?, outbound_message_id = ?, content_json = ?, error = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
    .run(
      cleanText(patch.status ?? current.status) || "draft",
      cleanText(patch.outbound_message_id ?? current.outbound_message_id),
      json(patch.content ?? current.content),
      cleanText(patch.error ?? current.error),
      nowIso(), organizationId, id
    ));
  return (await readAutoReplyRecord(organizationId, id));

  }));
}

export async function listAutoReplyRecords(organizationId: string, options: CommsJson = {}) {
  const conditions = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  const projectId = cleanText(options.project_id);
  if (projectId) { conditions.push("project_id = ?"); params.push(projectId); }
  const status = cleanText(options.status);
  if (status) { conditions.push("status = ?"); params.push(status); }
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  params.push(limit);
  return ((await getCommsDatabase().prepare(`
    SELECT * FROM comms_auto_replies WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?
  `).all(...(params as never[]))) as CommsJson[])
    .map((row) => ({ ...row, content: parseJson(row.content_json), content_json: undefined } as CommsJson));
}

export async function countAutoRepliesSince(organizationId: string, sinceIso: string) {
  const row = (await getCommsDatabase().prepare("SELECT count(*) AS n FROM comms_auto_replies WHERE organization_id = ? AND created_at >= ?")
    .get(organizationId, sinceIso)) as CommsJson;
  return Number(row?.n || 0);
}
