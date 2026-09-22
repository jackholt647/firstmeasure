import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import * as postgres from "./storage_postgres.js";
// Assistant conversation storage: threads and messages in assistant.sqlite,
// mirroring the stats agent's thread tables. Threads are personal — they are
// listed per user — but org-scoped for auth and cleanup.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { env } from "../src/config/env.js";

export type JsonObject = Record<string, unknown>;

let database: DatabaseSync | null = null;
let databasePath = "";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function nowIso() {
  return new Date().toISOString();
}

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "assistant.sqlite");
}

export function closeAssistantDatabase() {
  database?.close();
  database = null;
  databasePath = "";
}

export function getAssistantDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  closeAssistantDatabase();
  mkdirSync(path.dirname(nextPath), { recursive: true });
  const db = new DatabaseSync(nextPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  initializeSchema(db);
  database = db;
  databasePath = nextPath;
  return db;
}

function initializeSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_threads (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_threads_org_idx ON assistant_threads(organization_id, created_by_user_id, updated_at);

    CREATE TABLE IF NOT EXISTS assistant_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_messages_thread_idx ON assistant_messages(thread_id, created_at);
  `);
}

export async function createAssistantThread(input: JsonObject) {
  if (isFirstMeasurePostgresEnabled()) return (await postgres.createAssistantThread(input));
  const db = getAssistantDatabase();
  const id = cleanText(input.id) || `assistant_thread_${randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  db.prepare(`INSERT INTO assistant_threads (id, organization_id, branch_id, title, status, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)`)
    .run(id, cleanText(input.organization_id), cleanText(input.branch_id || "default") || "default",
      cleanText(input.title), cleanText(input.created_by_user_id) || null, now, now);
  return (await readAssistantThread(cleanText(input.organization_id), id));
}

export async function readAssistantThread(orgId: string, threadId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgres.readAssistantThread(orgId, threadId));
  const row = getAssistantDatabase().prepare("SELECT * FROM assistant_threads WHERE organization_id=? AND id=?").get(orgId, threadId);
  return row ? asObject(row) : null;
}

export async function listAssistantThreads(orgId: string, options: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgres.listAssistantThreads(orgId, options));
  const where = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  if (cleanText(options.created_by_user_id)) {
    where.push("created_by_user_id = ?");
    params.push(cleanText(options.created_by_user_id));
  }
  params.push(Math.min(100, Math.max(1, Number(options.limit || 50))));
  return getAssistantDatabase().prepare(`SELECT * FROM assistant_threads WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params).map((row) => asObject(row));
}

export async function updateAssistantThread(orgId: string, threadId: string, patch: JsonObject) {
  if (isFirstMeasurePostgresEnabled()) return (await postgres.updateAssistantThread(orgId, threadId, patch));
  const current = (await readAssistantThread(orgId, threadId));
  if (!current) return null;
  getAssistantDatabase().prepare("UPDATE assistant_threads SET title=?, status=?, updated_at=? WHERE organization_id=? AND id=?")
    .run(cleanText(patch.title ?? current.title), cleanText(patch.status ?? current.status) || "idle", nowIso(), orgId, threadId);
  return (await readAssistantThread(orgId, threadId));
}

export async function deleteAssistantThread(orgId: string, threadId: string) {
  if (isFirstMeasurePostgresEnabled()) return (await postgres.deleteAssistantThread(orgId, threadId));
  const result = getAssistantDatabase().prepare("DELETE FROM assistant_threads WHERE organization_id=? AND id=?").run(orgId, threadId);
  return Number(result.changes || 0) > 0;
}

export async function appendAssistantMessage(orgId: string, threadId: string, input: JsonObject) {
  if (isFirstMeasurePostgresEnabled()) return (await postgres.appendAssistantMessage(orgId, threadId, input));
  const db = getAssistantDatabase();
  const id = cleanText(input.id) || `assistant_message_${randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  db.prepare(`INSERT INTO assistant_messages (id, thread_id, organization_id, role, content, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, threadId, orgId, cleanText(input.role) || "user", String(input.content ?? ""), json(input.data), now);
  db.prepare("UPDATE assistant_threads SET updated_at=? WHERE organization_id=? AND id=?").run(now, orgId, threadId);
  const row = db.prepare("SELECT * FROM assistant_messages WHERE id=?").get(id);
  return row ? { ...asObject(row), data: parseJson(asObject(row).data_json) } : null;
}

export async function listAssistantMessages(orgId: string, threadId: string, options: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled()) return (await postgres.listAssistantMessages(orgId, threadId, options));
  const limit = Math.min(500, Math.max(1, Number(options.limit || 200)));
  return getAssistantDatabase().prepare(`SELECT * FROM assistant_messages WHERE organization_id=? AND thread_id=?
    ORDER BY created_at ASC LIMIT ?`).all(orgId, threadId, limit)
    .map((row) => ({ ...asObject(row), data: parseJson(asObject(row).data_json) }));
}
