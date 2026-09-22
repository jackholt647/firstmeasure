import type { QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import { queryPostgres, withPostgresTransaction } from "../src/database/postgres.js";
import { ensurePostgresPlatformStorage } from "../platform/storage_postgres.js";
import { notFound } from "../platform/errors.js";
import type { JsonObject } from "./storage.js";

let schema: Promise<void> | undefined;
async function ensureSchema() {
  schema ??= (async () => {
    await ensurePostgresPlatformStorage();
    await withPostgresTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-assistant-schema-v1'))");
      await client.query(`
        CREATE TABLE IF NOT EXISTS assistant_threads (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, branch_id TEXT NOT NULL DEFAULT 'default',
          title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idle', created_by_user_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS assistant_threads_org_idx ON assistant_threads(organization_id, created_by_user_id, updated_at);
        CREATE TABLE IF NOT EXISTS assistant_messages (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
          organization_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
          data_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS assistant_messages_thread_idx ON assistant_messages(thread_id, created_at);
      `);
    });
  })().catch(error => { schema = undefined; throw error; });
  await schema;
}
const text = (value: unknown) => String(value ?? "").trim();
const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "")}`;
const limit = (value: unknown, fallback: number, maximum: number) => Math.min(maximum, Math.max(1, Math.floor(Number(value) || fallback)));
function message(row: QueryResultRow): JsonObject { return { ...row, data: JSON.parse(String(row.data_json || "{}")) }; }

export async function createAssistantThread(input: JsonObject) {
  await ensureSchema();
  const now = new Date().toISOString();
  const result = await queryPostgres(`INSERT INTO assistant_threads (id, organization_id, branch_id, title, status, created_by_user_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'idle', $5, $6, $6) RETURNING *`,
    [text(input.id) || id("assistant_thread"), text(input.organization_id), text(input.branch_id) || "default", text(input.title), text(input.created_by_user_id) || null, now]);
  return result.rows[0] as JsonObject;
}
export async function readAssistantThread(orgId: string, threadId: string): Promise<JsonObject | null> {
  await ensureSchema();
  return (await queryPostgres("SELECT * FROM assistant_threads WHERE organization_id = $1 AND id = $2", [orgId, threadId])).rows[0] || null;
}
export async function listAssistantThreads(orgId: string, options: JsonObject = {}): Promise<JsonObject[]> {
  await ensureSchema();
  return (await queryPostgres(`SELECT * FROM assistant_threads WHERE organization_id = $1
    AND ($2::text = '' OR created_by_user_id = $2) ORDER BY updated_at DESC, id DESC LIMIT $3`, [orgId, text(options.created_by_user_id), limit(options.limit, 50, 100)])).rows;
}
export async function updateAssistantThread(orgId: string, threadId: string, patch: JsonObject): Promise<JsonObject | null> {
  await ensureSchema();
  return (await queryPostgres(`UPDATE assistant_threads SET title = COALESCE($3, title), status = COALESCE($4, status), updated_at = $5
    WHERE organization_id = $1 AND id = $2 RETURNING *`, [orgId, threadId, patch.title == null ? null : text(patch.title), patch.status == null ? null : text(patch.status) || "idle", new Date().toISOString()])).rows[0] || null;
}
export async function deleteAssistantThread(orgId: string, threadId: string) {
  await ensureSchema();
  return ((await queryPostgres("DELETE FROM assistant_threads WHERE organization_id = $1 AND id = $2", [orgId, threadId])).rowCount || 0) > 0;
}
export async function appendAssistantMessage(orgId: string, threadId: string, input: JsonObject): Promise<JsonObject> {
  await ensureSchema();
  return withPostgresTransaction(async client => {
    const now = new Date().toISOString();
    const thread = await client.query("UPDATE assistant_threads SET updated_at = $3 WHERE organization_id = $1 AND id = $2 RETURNING id", [orgId, threadId, now]);
    if (!thread.rowCount) throw notFound("thread_not_found", "The assistant thread was not found.");
    const result = await client.query(`INSERT INTO assistant_messages (id, thread_id, organization_id, role, content, data_json, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [text(input.id) || id("assistant_message"), threadId, orgId, text(input.role) || "user", String(input.content ?? ""), JSON.stringify(input.data ?? {}), now]);
    return message(result.rows[0]!);
  });
}
export async function listAssistantMessages(orgId: string, threadId: string, options: JsonObject = {}): Promise<JsonObject[]> {
  await ensureSchema();
  return (await queryPostgres("SELECT * FROM assistant_messages WHERE organization_id = $1 AND thread_id = $2 ORDER BY created_at ASC, id ASC LIMIT $3", [orgId, threadId, limit(options.limit, 200, 500)])).rows.map(message);
}
