// Stats warehouse storage: shared indexed PostgreSQL facts (SQLite in local mode).
//
// The platform's project documents live in an unindexed JSON store, so any
// aggregate over them is a full scan. The stats module instead maintains one
// compact, heavily-indexed row per project (dimensions + money measures) plus
// a mirrored activity-event table, kept fresh incrementally by tailing the
// work-engine event log (see sync.ts). Every metric the dashboard or the
// stats agent asks for compiles to indexed SQL over these tables, which keeps
// arbitrary custom stats millisecond-fast even at 100k+ projects.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";

import { env } from "../src/config/env.js";

export type JsonObject = Record<string, unknown>;

let database: SqlStore | null = null;
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
  return path.resolve(process.cwd(), env.platformStorageRoot, "stats.sqlite");
}

export async function closeStatsDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}
export function getStatsDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeStatsDatabase();
  database = openSqlStore({ id: "stats", filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS stats_projects (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL DEFAULT '',
      template_id TEXT NOT NULL DEFAULT '',
      template_title TEXT NOT NULL DEFAULT '',
      stage_key TEXT NOT NULL DEFAULT '',
      stage_title TEXT NOT NULL DEFAULT '',
      primary_user_id TEXT NOT NULL DEFAULT '',
      assigned_user_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      sold_at TEXT,
      completed_at TEXT,
      canceled_at TEXT,
      updated_at TEXT,
      contract_cents INTEGER NOT NULL DEFAULT 0,
      collected_cents INTEGER NOT NULL DEFAULT 0,
      outstanding_cents INTEGER NOT NULL DEFAULT 0,
      projected_expenses_cents INTEGER NOT NULL DEFAULT 0,
      expenses_cents INTEGER NOT NULL DEFAULT 0,
      projected_profit_cents INTEGER NOT NULL DEFAULT 0,
      profit_cents INTEGER NOT NULL DEFAULT 0,
      attrs_json TEXT NOT NULL DEFAULT '{}',
      computed_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS stats_projects_status_idx ON stats_projects(organization_id, status);
    CREATE INDEX IF NOT EXISTS stats_projects_created_idx ON stats_projects(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS stats_projects_sold_idx ON stats_projects(organization_id, sold_at);
    CREATE INDEX IF NOT EXISTS stats_projects_completed_idx ON stats_projects(organization_id, completed_at);
    CREATE INDEX IF NOT EXISTS stats_projects_template_idx ON stats_projects(organization_id, template_id);
    CREATE INDEX IF NOT EXISTS stats_projects_user_idx ON stats_projects(organization_id, primary_user_id);
    CREATE INDEX IF NOT EXISTS stats_projects_computed_idx ON stats_projects(organization_id, computed_at);

    CREATE TABLE IF NOT EXISTS stats_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      project_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      actor_user_id TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stats_events_type_idx ON stats_events(organization_id, type, created_at);
    CREATE INDEX IF NOT EXISTS stats_events_created_idx ON stats_events(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS stats_events_project_idx ON stats_events(organization_id, project_id);

    CREATE TABLE IF NOT EXISTS stats_sync_state (
      organization_id TEXT PRIMARY KEY,
      last_event_rowid BIGINT NOT NULL DEFAULT 0,
      data_version BIGINT NOT NULL DEFAULT 1,
      backfill_done INTEGER NOT NULL DEFAULT 0,
      views_seeded INTEGER NOT NULL DEFAULT 0,
      project_count INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT NOT NULL DEFAULT '',
      last_reconcile_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stats_query_cache (
      cache_key TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      computed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stats_query_cache_org_idx ON stats_query_cache(organization_id, expires_at);

    CREATE TABLE IF NOT EXISTS stats_views (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      preset_id TEXT NOT NULL DEFAULT '',
      definition_json TEXT NOT NULL DEFAULT '{}',
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS stats_agent_threads (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      view_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stats_agent_threads_org_idx ON stats_agent_threads(organization_id, view_id, updated_at);

    CREATE TABLE IF NOT EXISTS stats_agent_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES stats_agent_threads(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stats_agent_messages_thread_idx ON stats_agent_messages(thread_id, created_at);
  `));
}

// ── Sync state ─────────────────────────────────────────────────────────────

export async function readSyncState(orgId: string) {
  const row = (await getStatsDatabase().prepare("SELECT * FROM stats_sync_state WHERE organization_id = ?").get(orgId));
  return row ? asObject(row) : null;
}

export async function ensureSyncState(orgId: string) {
  const existing = (await readSyncState(orgId));
  if (existing) return existing;
  const now = nowIso();
  (await getStatsDatabase().prepare(`INSERT INTO stats_sync_state (organization_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(orgId, now, now));
  return (await readSyncState(orgId)) as JsonObject;
}

export async function updateSyncState(orgId: string, patch: JsonObject) {
  return (await getStatsDatabase().transaction(async () => {
  const current = (await ensureSyncState(orgId));
  const next = { ...current, ...patch };
  (await getStatsDatabase().prepare(`UPDATE stats_sync_state SET last_event_rowid=?, data_version=?, backfill_done=?, views_seeded=?,
    project_count=?, last_sync_at=?, last_reconcile_at=?, updated_at=? WHERE organization_id=?`)
    .run(
      Math.max(0, Math.floor(Number(next.last_event_rowid || 0))),
      Math.max(1, Math.floor(Number(next.data_version || 1))),
      Number(next.backfill_done || 0) ? 1 : 0,
      Number(next.views_seeded || 0) ? 1 : 0,
      Math.max(0, Math.floor(Number(next.project_count || 0))),
      cleanText(next.last_sync_at),
      cleanText(next.last_reconcile_at),
      nowIso(),
      orgId
    ));
  return (await readSyncState(orgId)) as JsonObject;

  }));
}

export async function bumpDataVersion(orgId: string) {
  return (await getStatsDatabase().transaction(async () => {
  const current = (await ensureSyncState(orgId));
  (await updateSyncState(orgId, { data_version: Number(current.data_version || 1) + 1 }));

  }));
}

export async function listActiveStatsOrgIds() {
  return (await getStatsDatabase().prepare("SELECT organization_id FROM stats_sync_state ORDER BY organization_id").all())
    .map((row) => cleanText(asObject(row).organization_id)).filter(Boolean);
}

// ── Project facts ──────────────────────────────────────────────────────────

export async function upsertProjectFact(fact: JsonObject) {
  (await getStatsDatabase().prepare(`INSERT INTO stats_projects (
      organization_id, project_id, branch_id, title, status, source, template_id, template_title,
      stage_key, stage_title, primary_user_id, assigned_user_ids_json, created_at, sold_at, completed_at,
      canceled_at, updated_at, contract_cents, collected_cents, outstanding_cents, projected_expenses_cents,
      expenses_cents, projected_profit_cents, profit_cents, attrs_json, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, project_id) DO UPDATE SET
      branch_id=excluded.branch_id, title=excluded.title, status=excluded.status, source=excluded.source,
      template_id=excluded.template_id, template_title=excluded.template_title, stage_key=excluded.stage_key,
      stage_title=excluded.stage_title, primary_user_id=excluded.primary_user_id,
      assigned_user_ids_json=excluded.assigned_user_ids_json, created_at=excluded.created_at,
      sold_at=excluded.sold_at, completed_at=excluded.completed_at, canceled_at=excluded.canceled_at,
      updated_at=excluded.updated_at, contract_cents=excluded.contract_cents, collected_cents=excluded.collected_cents,
      outstanding_cents=excluded.outstanding_cents, projected_expenses_cents=excluded.projected_expenses_cents,
      expenses_cents=excluded.expenses_cents, projected_profit_cents=excluded.projected_profit_cents,
      profit_cents=excluded.profit_cents, attrs_json=excluded.attrs_json, computed_at=excluded.computed_at`)
    .run(
      cleanText(fact.organization_id), cleanText(fact.project_id), cleanText(fact.branch_id || "default") || "default",
      cleanText(fact.title), cleanText(fact.status || "open") || "open", cleanText(fact.source),
      cleanText(fact.template_id), cleanText(fact.template_title), cleanText(fact.stage_key), cleanText(fact.stage_title),
      cleanText(fact.primary_user_id), json(fact.assigned_user_ids ?? []),
      cleanText(fact.created_at) || null, cleanText(fact.sold_at) || null, cleanText(fact.completed_at) || null,
      cleanText(fact.canceled_at) || null, cleanText(fact.updated_at) || null,
      Math.round(Number(fact.contract_cents) || 0), Math.round(Number(fact.collected_cents) || 0),
      Math.round(Number(fact.outstanding_cents) || 0), Math.round(Number(fact.projected_expenses_cents) || 0),
      Math.round(Number(fact.expenses_cents) || 0), Math.round(Number(fact.projected_profit_cents) || 0),
      Math.round(Number(fact.profit_cents) || 0), json(fact.attrs ?? {}), nowIso()
    ));
}

export async function deleteProjectFacts(orgId: string, projectIds: string[]) {
  if (!projectIds.length) return;
  const db = getStatsDatabase();
  const remove = db.prepare("DELETE FROM stats_projects WHERE organization_id = ? AND project_id = ?");
  for (const projectId of projectIds) (await remove.run(orgId, cleanText(projectId)));
}

export async function listFactProjectIds(orgId: string) {
  return (await getStatsDatabase().prepare("SELECT project_id FROM stats_projects WHERE organization_id = ?").all(orgId))
    .map((row) => cleanText(asObject(row).project_id)).filter(Boolean);
}

export async function countProjectFacts(orgId: string) {
  const row = asObject((await getStatsDatabase().prepare("SELECT COUNT(*) AS count FROM stats_projects WHERE organization_id = ?").get(orgId)));
  return Number(row.count || 0);
}

// The stalest rows, for the rolling reconcile sweep that heals drift the
// event tail cannot see (e.g. payment edits that emit no work event).
export async function stalestProjectFacts(orgId: string, limit: number) {
  return (await getStatsDatabase().prepare(`SELECT project_id FROM stats_projects WHERE organization_id = ?
    ORDER BY computed_at ASC LIMIT ?`).all(orgId, Math.max(1, Math.floor(limit))))
    .map((row) => cleanText(asObject(row).project_id)).filter(Boolean);
}

// ── Mirrored events ────────────────────────────────────────────────────────

export async function insertStatsEvents(rows: JsonObject[]) {
  return (await getStatsDatabase().transaction(async () => {
  if (!rows.length) return;
  const insert = getStatsDatabase().prepare(`INSERT INTO stats_events
    (id, organization_id, branch_id, project_id, type, actor_user_id, visibility, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  for (const row of rows) {
    (await insert.run(
      cleanText(row.id), cleanText(row.organization_id), cleanText(row.branch_id || "default") || "default",
      cleanText(row.project_id), cleanText(row.type), cleanText(row.actor_user_id),
      cleanText(row.visibility || "system") || "system", cleanText(row.created_at) || nowIso()
    ));
  }

  }));
}

// ── Query cache ────────────────────────────────────────────────────────────

export async function readCachedQuery(cacheKey: string) {
  const row = (await getStatsDatabase().prepare("SELECT * FROM stats_query_cache WHERE cache_key = ?").get(cacheKey));
  if (!row) return null;
  const record = asObject(row);
  if (cleanText(record.expires_at) <= nowIso()) return null;
  return { payload: parseJson(record.payload_json, null), computed_at: cleanText(record.computed_at) };
}

export async function writeCachedQuery(orgId: string, cacheKey: string, payload: unknown, ttlMs: number) {
  const db = getStatsDatabase();
  const now = Date.now();
  (await db.prepare(`INSERT INTO stats_query_cache (cache_key, organization_id, payload_json, computed_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json, computed_at=excluded.computed_at, expires_at=excluded.expires_at`)
    .run(cacheKey, orgId, json(payload), new Date(now).toISOString(), new Date(now + Math.max(1_000, ttlMs)).toISOString()));
  // Opportunistic prune: expired entries never match, but keep the table small.
  if (Math.random() < 0.05) (await db.prepare("DELETE FROM stats_query_cache WHERE expires_at < ?").run(new Date(now).toISOString()));
}

// ── Dashboard views ────────────────────────────────────────────────────────

function viewFromRow(row: unknown) {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    branch_id: cleanText(value.branch_id || "default") || "default",
    title: cleanText(value.title),
    icon: cleanText(value.icon),
    color: cleanText(value.color),
    description: cleanText(value.description),
    sort_order: Number(value.sort_order || 0),
    preset_id: cleanText(value.preset_id),
    definition: asObject(parseJson(value.definition_json)),
    created_by_user_id: cleanText(value.created_by_user_id),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export async function listViewRecords(orgId: string) {
  return (await getStatsDatabase().prepare("SELECT * FROM stats_views WHERE organization_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(orgId)).map(viewFromRow);
}

export async function readViewRecord(orgId: string, viewId: string) {
  const row = (await getStatsDatabase().prepare("SELECT * FROM stats_views WHERE organization_id = ? AND id = ?").get(orgId, cleanText(viewId)));
  return row ? viewFromRow(row) : null;
}

export async function saveViewRecord(orgId: string, input: JsonObject) {
  return (await getStatsDatabase().transaction(async () => {
  const db = getStatsDatabase();
  const id = cleanText(input.id) || `stats_view_${randomUUID().replace(/-/g, "")}`;
  const existing = (await readViewRecord(orgId, id));
  const now = nowIso();
  const definition = asObject(input.definition);
  const sortOrder = input.sort_order !== undefined
    ? Math.max(0, Math.floor(Number(input.sort_order) || 0))
    : existing
      ? existing.sort_order
      : (await listViewRecords(orgId)).length;
  (await db.prepare(`INSERT INTO stats_views (id, organization_id, branch_id, title, icon, color, description, sort_order,
      preset_id, definition_json, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, id) DO UPDATE SET branch_id=excluded.branch_id, title=excluded.title, icon=excluded.icon,
      color=excluded.color, description=excluded.description, sort_order=excluded.sort_order,
      preset_id=excluded.preset_id, definition_json=excluded.definition_json, updated_at=excluded.updated_at`)
    .run(
      id, orgId, cleanText(input.branch_id || existing?.branch_id || "default") || "default",
      cleanText(input.title || definition.title), cleanText(input.icon ?? definition.icon),
      cleanText(input.color ?? definition.color), cleanText(input.description ?? definition.description),
      sortOrder, cleanText(input.preset_id ?? existing?.preset_id),
      json({ ...definition, id, title: cleanText(input.title || definition.title) }),
      cleanText(input.created_by_user_id || existing?.created_by_user_id) || null,
      existing ? existing.created_at : now, now
    ));
  return (await readViewRecord(orgId, id));

  }));
}

export async function deleteViewRecord(orgId: string, viewId: string) {
  const result = (await getStatsDatabase().prepare("DELETE FROM stats_views WHERE organization_id = ? AND id = ?").run(orgId, cleanText(viewId)));
  return Number(result.changes || 0) > 0;
}

// ── Agent threads ──────────────────────────────────────────────────────────

export async function createStatsThread(input: JsonObject) {
  const db = getStatsDatabase();
  const id = cleanText(input.id) || `stats_thread_${randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  (await db.prepare(`INSERT INTO stats_agent_threads (id, organization_id, branch_id, view_id, title, status, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)`)
    .run(id, cleanText(input.organization_id), cleanText(input.branch_id || "default") || "default",
      cleanText(input.view_id), cleanText(input.title), cleanText(input.created_by_user_id) || null, now, now));
  return (await readStatsThread(cleanText(input.organization_id), id));
}

export async function readStatsThread(orgId: string, threadId: string) {
  const row = (await getStatsDatabase().prepare("SELECT * FROM stats_agent_threads WHERE organization_id=? AND id=?").get(orgId, threadId));
  return row ? asObject(row) : null;
}

export async function listStatsThreads(orgId: string, options: JsonObject = {}) {
  const where = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  if (options.view_id !== undefined) {
    where.push("view_id = ?");
    params.push(cleanText(options.view_id));
  }
  params.push(Math.min(100, Math.max(1, Number(options.limit || 50))));
  return (await getStatsDatabase().prepare(`SELECT * FROM stats_agent_threads WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params)).map((row) => asObject(row));
}

export async function updateStatsThread(orgId: string, threadId: string, patch: JsonObject) {
  return (await getStatsDatabase().transaction(async () => {
  const current = (await readStatsThread(orgId, threadId));
  if (!current) return null;
  (await getStatsDatabase().prepare("UPDATE stats_agent_threads SET title=?, status=?, updated_at=? WHERE organization_id=? AND id=?")
    .run(cleanText(patch.title ?? current.title), cleanText(patch.status ?? current.status) || "idle", nowIso(), orgId, threadId));
  return (await readStatsThread(orgId, threadId));

  }));
}

export async function appendStatsMessage(orgId: string, threadId: string, input: JsonObject) {
  return (await getStatsDatabase().transaction(async () => {
  const db = getStatsDatabase();
  const id = cleanText(input.id) || `stats_message_${randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  (await db.prepare(`INSERT INTO stats_agent_messages (id, thread_id, organization_id, role, content, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, threadId, orgId, cleanText(input.role) || "user", String(input.content ?? ""), json(input.data), now));
  (await db.prepare("UPDATE stats_agent_threads SET updated_at=? WHERE organization_id=? AND id=?").run(now, orgId, threadId));
  const row = (await db.prepare("SELECT * FROM stats_agent_messages WHERE id=?").get(id));
  return row ? { ...asObject(row), data: parseJson(asObject(row).data_json) } : null;

  }));
}

export async function listStatsMessages(orgId: string, threadId: string, options: JsonObject = {}) {
  const limit = Math.min(500, Math.max(1, Number(options.limit || 200)));
  return (await getStatsDatabase().prepare(`SELECT * FROM stats_agent_messages WHERE organization_id=? AND thread_id=?
    ORDER BY created_at ASC LIMIT ?`).all(orgId, threadId, limit))
    .map((row) => ({ ...asObject(row), data: parseJson(asObject(row).data_json) }));
}
