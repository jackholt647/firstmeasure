// Shared PostgreSQL agent conversation and usage storage (SQLite for local mode): one
// agent_threads/agent_messages pair for EVERY registered agent (keyed by
// agent_id), plus an agent_runs usage/audit table and a meta table used for
// one-time legacy-thread migrations and other markers.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";

import { env } from "../src/config/env.js";
import { notFound } from "../platform/errors.js";
import { asObject, cleanText, nowIso, type JsonObject } from "./util.js";

let database: SqlStore | null = null;
let databasePath = "";

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

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "agents.sqlite");
}

export async function closeAgentsDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}

export function getAgentsDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeAgentsDatabase();
  database = openSqlStore({ id: "agents", schemaVersion: 3, filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS agent_wakeup_jobs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
      kind TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      lease_owner TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', notified_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS agent_wakeup_jobs_due ON agent_wakeup_jobs(state,created_at);
    CREATE INDEX IF NOT EXISTS agent_wakeup_jobs_conversation ON agent_wakeup_jobs(conversation_key,state);
    CREATE TABLE IF NOT EXISTS agent_threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      subject_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_threads_org_idx
      ON agent_threads(agent_id, organization_id, created_by_user_id, updated_at);
    CREATE INDEX IF NOT EXISTS agent_threads_subject_idx
      ON agent_threads(agent_id, organization_id, subject_id, updated_at);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_messages_thread_idx ON agent_messages(thread_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      thread_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'success',
      rounds INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_runs_org_idx ON agent_runs(agent_id, organization_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    -- Pending "waiting on a human" states: the agent sent a DM (or similar)
    -- and expects a reply. A reply resolves the await and re-opens the origin
    -- thread; the timeout scheduler nudges once, then expires with a report
    -- back to the requester.
    CREATE TABLE IF NOT EXISTS agent_awaits (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      origin_thread_id TEXT NOT NULL,
      origin_channel_id TEXT NOT NULL DEFAULT '',
      dm_channel_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      timeout_at TEXT NOT NULL DEFAULT '',
      nudged_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_awaits_dm_idx ON agent_awaits(organization_id, dm_channel_id, status);
    CREATE INDEX IF NOT EXISTS agent_awaits_due_idx ON agent_awaits(status, timeout_at);

    -- Self-scheduled wakeups: the agent stores "wake a future instance of me
    -- with these instructions" — once at fire_at, or recurring on a 5-field
    -- cron (server-local time). The channel agent scheduler sweeps due rows
    -- and re-enters the origin thread, so the woken instance carries the full
    -- conversation context. Recurring schedules stay active until cancelled.
    CREATE TABLE IF NOT EXISTS agent_schedules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      origin_thread_id TEXT NOT NULL,
      origin_channel_id TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'once',
      instructions TEXT NOT NULL DEFAULT '',
      fire_at TEXT NOT NULL DEFAULT '',
      cron TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT '',
      last_fired_at TEXT NOT NULL DEFAULT '',
      fire_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_schedules_due_idx ON agent_schedules(status, kind, fire_at);
    CREATE INDEX IF NOT EXISTS agent_schedules_thread_idx ON agent_schedules(organization_id, origin_thread_id, status);
  `));
  const columns = [
    ["agent_awaits", "created_by_user_id", "TEXT NOT NULL DEFAULT ''"],
    ["agent_schedules", "timezone", "TEXT NOT NULL DEFAULT ''"],
    ["agent_threads", "run_token", "TEXT NOT NULL DEFAULT ''"],
    ["agent_threads", "run_lease_until", "TEXT NOT NULL DEFAULT ''"]
  ];
  for (const [table, column, declaration] of columns) {
    if (db.isPostgres) await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`);
    else {
      const existing = await db.prepare(`PRAGMA table_info(${table})`).all();
      if (!existing.some(row => row.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }
}

// ── Threads ────────────────────────────────────────────────────────────────

export async function createAgentThread(input: JsonObject) {
  const db = getAgentsDatabase();
  const id = cleanText(input.id) || `agent_thread_${randomUUID().replace(/-/g, "")}`;
  const now = cleanText(input.created_at) || nowIso();
  (await db.prepare(`INSERT INTO agent_threads (id, agent_id, organization_id, branch_id, subject_id, title, status, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, cleanText(input.agent_id), cleanText(input.organization_id),
      cleanText(input.branch_id || "default") || "default", cleanText(input.subject_id),
      cleanText(input.title), cleanText(input.status || "idle") || "idle",
      cleanText(input.created_by_user_id) || null, now, cleanText(input.updated_at) || now
    ));
  return (await readAgentThread(cleanText(input.agent_id), cleanText(input.organization_id), id));
}

export async function readAgentThread(agentId: string, orgId: string, threadId: string) {
  const row = (await getAgentsDatabase()
    .prepare("SELECT * FROM agent_threads WHERE agent_id=? AND organization_id=? AND id=?")
    .get(cleanText(agentId), orgId, cleanText(threadId)));
  return row ? asObject(row) : null;
}

export async function listAgentThreads(agentId: string, orgId: string, options: JsonObject = {}) {
  const where = ["agent_id = ?", "organization_id = ?"];
  const params: SQLInputValue[] = [cleanText(agentId), orgId];
  if (cleanText(options.created_by_user_id)) {
    where.push("created_by_user_id = ?");
    params.push(cleanText(options.created_by_user_id));
  }
  if (options.subject_id !== undefined) {
    where.push("subject_id = ?");
    params.push(cleanText(options.subject_id));
  }
  params.push(Math.min(200, Math.max(1, Number(options.limit || 50))));
  return (await getAgentsDatabase()
    .prepare(`SELECT * FROM agent_threads WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params)).map((row) => asObject(row));
}

export async function updateAgentThread(agentId: string, orgId: string, threadId: string, patch: JsonObject) {
  await getAgentsDatabase().prepare(`UPDATE agent_threads SET title=COALESCE(?,title), status=COALESCE(?,status),
    subject_id=COALESCE(?,subject_id), updated_at=? WHERE agent_id=? AND organization_id=? AND id=?`)
    .run(patch.title == null ? null : cleanText(patch.title), patch.status == null ? null : cleanText(patch.status) || "idle",
      patch.subject_id == null ? null : cleanText(patch.subject_id), nowIso(), cleanText(agentId), orgId, cleanText(threadId));
  return readAgentThread(agentId, orgId, threadId);
}

export async function deleteAgentThread(agentId: string, orgId: string, threadId: string) {
  const result = (await getAgentsDatabase()
    .prepare("DELETE FROM agent_threads WHERE agent_id=? AND organization_id=? AND id=?")
    .run(cleanText(agentId), orgId, cleanText(threadId)));
  return Number(result.changes || 0) > 0;
}

// ── Messages ───────────────────────────────────────────────────────────────

export async function appendAgentMessage(agentId: string, orgId: string, threadId: string, input: JsonObject) {
  return (await getAgentsDatabase().transaction(async db => {
    const thread = await db.prepare("UPDATE agent_threads SET updated_at=? WHERE agent_id=? AND organization_id=? AND id=?")
      .run(nowIso(), cleanText(agentId), orgId, cleanText(threadId));
    if (!thread.changes) throw notFound("agent_thread_not_found", "This conversation was not found.");
    const id = cleanText(input.id) || `agent_message_${randomUUID().replace(/-/g, "")}`;
    await db.prepare(`INSERT INTO agent_messages (id, thread_id, agent_id, organization_id, role, content, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, cleanText(threadId), cleanText(agentId), orgId, cleanText(input.role) || "user",
        String(input.content ?? ""), json(input.data), cleanText(input.created_at) || nowIso());
    const row = await db.prepare("SELECT * FROM agent_messages WHERE id=?").get(id);
    return row ? { ...asObject(row), data: parseJson(asObject(row).data_json) } : null;
  }));
}

export async function listAgentMessages(agentId: string, orgId: string, threadId: string, options: JsonObject = {}) {
  const limit = Math.min(500, Math.max(1, Number(options.limit || 200)));
  return (await getAgentsDatabase()
    .prepare(`SELECT * FROM agent_messages WHERE agent_id=? AND organization_id=? AND thread_id=?
      ORDER BY created_at ASC LIMIT ?`)
    .all(cleanText(agentId), orgId, cleanText(threadId), limit))
    .map((row) => ({ ...asObject(row), data: parseJson(asObject(row).data_json) }));
}

// ── Usage / audit ──────────────────────────────────────────────────────────

export async function recordAgentRun(input: JsonObject) {
  const db = getAgentsDatabase();
  const id = `agent_run_${randomUUID().replace(/-/g, "")}`;
  (await db.prepare(`INSERT INTO agent_runs (id, agent_id, organization_id, branch_id, thread_id, user_id, status,
      rounds, tool_calls, input_tokens, output_tokens, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, cleanText(input.agent_id), cleanText(input.organization_id),
      cleanText(input.branch_id || "default") || "default", cleanText(input.thread_id),
      cleanText(input.user_id), cleanText(input.status || "success") || "success",
      Math.max(0, Math.floor(Number(input.rounds) || 0)),
      Math.max(0, Math.floor(Number(input.tool_calls) || 0)),
      Math.max(0, Math.floor(Number(input.input_tokens) || 0)),
      Math.max(0, Math.floor(Number(input.output_tokens) || 0)),
      Math.max(0, Math.floor(Number(input.duration_ms) || 0)),
      nowIso()
    ));
  return id;
}

export async function countAgentRunsToday(agentId: string, orgId: string) {
  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const row = asObject((await getAgentsDatabase()
    .prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE agent_id=? AND organization_id=? AND created_at >= ?")
    .get(cleanText(agentId), orgId, dayStart)));
  return Number(row.count || 0);
}

export async function agentUsageSummary(orgId: string, options: JsonObject = {}) {
  const since = cleanText(options.since) || `${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
  return (await getAgentsDatabase()
    .prepare(`SELECT agent_id, COUNT(*) AS runs, SUM(tool_calls) AS tool_calls,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_runs
      FROM agent_runs WHERE organization_id=? AND created_at >= ?
      GROUP BY agent_id ORDER BY agent_id`)
    .all(orgId, since)).map((row) => asObject(row));
}

// ── Awaits (agent waiting on a human reply) ────────────────────────────────

function awaitFromRow(row: unknown) {
  return asObject(row);
}

export async function createAgentAwait(input: JsonObject) {
  const db = getAgentsDatabase();
  const id = `agent_await_${randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  (await db.prepare(`INSERT INTO agent_awaits (id, agent_id, organization_id, branch_id, origin_thread_id, origin_channel_id,
      dm_channel_id, target_user_id, note, status, timeout_at, nudged_at, created_at, updated_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '', ?, ?, ?)`)
    .run(
      id, cleanText(input.agent_id), cleanText(input.organization_id),
      cleanText(input.branch_id || "default") || "default",
      cleanText(input.origin_thread_id), cleanText(input.origin_channel_id),
      cleanText(input.dm_channel_id), cleanText(input.target_user_id),
      cleanText(input.note), cleanText(input.timeout_at), now, now, cleanText(input.created_by_user_id)
    ));
  const row = (await db.prepare("SELECT * FROM agent_awaits WHERE id=?").get(id));
  return awaitFromRow(row);
}

export async function updateAgentAwait(awaitId: string, patch: JsonObject) {
  const db = getAgentsDatabase();
  const result = await db.prepare(`UPDATE agent_awaits SET status=COALESCE(?,status), timeout_at=COALESCE(?,timeout_at),
    nudged_at=COALESCE(?,nudged_at), note=COALESCE(?,note), updated_at=? WHERE id=?`)
    .run(patch.status == null ? null : cleanText(patch.status) || "pending", patch.timeout_at == null ? null : cleanText(patch.timeout_at),
      patch.nudged_at == null ? null : cleanText(patch.nudged_at), patch.note == null ? null : cleanText(patch.note), nowIso(), cleanText(awaitId));
  return result.changes ? awaitFromRow(await db.prepare("SELECT * FROM agent_awaits WHERE id=?").get(cleanText(awaitId))) : null;
}

/** Open awaits attached to a DM channel — a reply there resolves them. */
export async function listOpenAwaitsForDmChannel(orgId: string, dmChannelId: string) {
  return (await getAgentsDatabase()
    .prepare("SELECT * FROM agent_awaits WHERE organization_id=? AND dm_channel_id=? AND status IN ('pending','nudged') ORDER BY created_at ASC")
    .all(orgId, cleanText(dmChannelId))).map(awaitFromRow);
}

/** Awaits whose timeout has passed, for the follow-up scheduler. */
export async function listDueAgentAwaits(now = nowIso(), limit = 20) {
  return (await getAgentsDatabase()
    .prepare("SELECT * FROM agent_awaits WHERE status IN ('pending','nudged') AND timeout_at != '' AND timeout_at <= ? ORDER BY timeout_at ASC LIMIT ?")
    .all(now, Math.max(1, Math.floor(limit)))).map(awaitFromRow);
}

// ── Schedules (self-scheduled future wakeups) ──────────────────────────────

export async function createAgentSchedule(input: JsonObject) {
  const db = getAgentsDatabase();
  const id = `agent_schedule_${randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  (await db.prepare(`INSERT INTO agent_schedules (id, agent_id, organization_id, branch_id, origin_thread_id, origin_channel_id,
      created_by_user_id, kind, instructions, fire_at, cron, timezone, last_fired_at, fire_count, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 'active', ?, ?)`)
    .run(
      id, cleanText(input.agent_id), cleanText(input.organization_id),
      cleanText(input.branch_id || "default") || "default",
      cleanText(input.origin_thread_id), cleanText(input.origin_channel_id),
      cleanText(input.created_by_user_id),
      cleanText(input.kind) === "recurring" ? "recurring" : "once",
      String(input.instructions ?? ""), cleanText(input.fire_at), cleanText(input.cron),
      cleanText(input.timezone),
      now, now
    ));
  return (await readAgentSchedule(id));
}

export async function readAgentSchedule(scheduleId: string) {
  const row = (await getAgentsDatabase().prepare("SELECT * FROM agent_schedules WHERE id=?").get(cleanText(scheduleId)));
  return row ? asObject(row) : null;
}

export async function updateAgentSchedule(scheduleId: string, patch: JsonObject) {
  const db = getAgentsDatabase();
  await db.prepare(`UPDATE agent_schedules SET status=COALESCE(?,status), instructions=COALESCE(?,instructions),
    fire_at=COALESCE(?,fire_at), cron=COALESCE(?,cron), updated_at=? WHERE id=?`)
    .run(patch.status == null ? null : cleanText(patch.status) || "active", patch.instructions == null ? null : String(patch.instructions),
      patch.fire_at == null ? null : cleanText(patch.fire_at), patch.cron == null ? null : cleanText(patch.cron), nowIso(), cleanText(scheduleId));
  return readAgentSchedule(scheduleId);
}

export async function listAgentSchedules(agentId: string, orgId: string, options: JsonObject = {}) {
  const where = ["agent_id = ?", "organization_id = ?"];
  const params: SQLInputValue[] = [cleanText(agentId), orgId];
  if (options.origin_thread_id !== undefined) {
    where.push("origin_thread_id = ?");
    params.push(cleanText(options.origin_thread_id));
  }
  if (cleanText(options.status)) {
    where.push("status = ?");
    params.push(cleanText(options.status));
  }
  params.push(Math.min(200, Math.max(1, Number(options.limit || 50))));
  return (await getAgentsDatabase()
    .prepare(`SELECT * FROM agent_schedules WHERE ${where.join(" AND ")} ORDER BY created_at ASC LIMIT ?`)
    .all(...params)).map((row) => asObject(row));
}

/** One-time schedules whose fire time has passed, for the wakeup scheduler. */
export async function listDueOnceAgentSchedules(now = nowIso(), limit = 20) {
  return (await getAgentsDatabase()
    .prepare("SELECT * FROM agent_schedules WHERE status='active' AND kind='once' AND fire_at != '' AND fire_at <= ? ORDER BY fire_at ASC LIMIT ?")
    .all(now, Math.max(1, Math.floor(limit)))).map((row) => asObject(row));
}

export async function listActiveRecurringAgentSchedules(limit = 200) {
  return (await getAgentsDatabase()
    .prepare("SELECT * FROM agent_schedules WHERE status='active' AND kind='recurring' ORDER BY created_at ASC LIMIT ?")
    .all(Math.max(1, Math.floor(limit)))).map((row) => asObject(row));
}

/** Advance a schedule only with its durable occurrence recorded in the same transaction. */
export async function claimDueOnceAgentSchedule(scheduleId: string, firedAt: string) {
  return (await getAgentsDatabase().transaction(async db => {
    const result = await db.prepare("UPDATE agent_schedules SET status='done',last_fired_at=?,fire_count=fire_count+1,updated_at=? WHERE id=? AND status='active' AND kind='once' AND fire_at<=?")
      .run(firedAt, nowIso(), scheduleId, firedAt);
    if (!result.changes) return false;
    const schedule = (await readAgentSchedule(scheduleId))!;
    await enqueueAgentWakeup(`schedule:${scheduleId}:${firedAt}`, "schedule", schedule, { recurring: false, firedAt });
    return true;
  }));
}

export async function claimRecurringAgentScheduleFire(scheduleId: string, previousLastFiredAt: string, firedAt: string) {
  return (await getAgentsDatabase().transaction(async db => {
    const result = await db.prepare("UPDATE agent_schedules SET last_fired_at=?,fire_count=fire_count+1,updated_at=? WHERE id=? AND status='active' AND kind='recurring' AND last_fired_at=?")
      .run(firedAt, nowIso(), scheduleId, previousLastFiredAt);
    if (!result.changes) return false;
    await enqueueAgentWakeup(`schedule:${scheduleId}:${firedAt}`, "schedule", (await readAgentSchedule(scheduleId))!, { recurring: true, firedAt });
    return true;
  }));
}

export async function enqueueAgentWakeup(id: string, kind: string, record: JsonObject, event: JsonObject = {}) {
  const conversation = [record.organization_id, record.agent_id, record.origin_channel_id || record.origin_thread_id].map(cleanText).join(":");
  return (await getAgentsDatabase().prepare(`INSERT INTO agent_wakeup_jobs(id,organization_id,conversation_key,kind,payload_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .run(id, cleanText(record.organization_id), conversation, kind, json({ record, event }), nowIso(), nowIso())).changes > 0;
}

export async function advanceAgentAwait(entry: JsonObject, patch: JsonObject, event: JsonObject) {
  return (await getAgentsDatabase().transaction(async db => {
    const current = await db.prepare("SELECT * FROM agent_awaits WHERE id=?").get(cleanText(entry.id));
    if (!current || current.status !== entry.status || current.timeout_at !== entry.timeout_at) return false;
    await updateAgentAwait(cleanText(entry.id), patch);
    await enqueueAgentWakeup(`await:${entry.id}:${event.kind}`, "await", entry, event);
    return true;
  }));
}

export async function claimAgentWakeup(leaseMs = 120000) {
  return (await getAgentsDatabase().transaction(async db => {
    const now = nowIso();
    // A provider/tool may have committed before an interrupted worker died.
    // Keep an explicit reviewable outcome; never blindly replay external tools.
    await db.prepare("UPDATE agent_wakeup_jobs SET state='uncertain',error='The worker stopped before completion was confirmed.',updated_at=? WHERE state='running' AND lease_until<=?").run(now, now);
    const row = await db.prepare(`SELECT j.* FROM agent_wakeup_jobs j WHERE j.state='pending'
      AND NOT EXISTS(SELECT 1 FROM agent_wakeup_jobs active WHERE active.conversation_key=j.conversation_key AND active.state='running')
      ORDER BY j.created_at,j.id LIMIT 1`).get();
    if (!row) return null;
    const token = randomUUID();
    await db.prepare("UPDATE agent_wakeup_jobs SET state='running',lease_owner=?,lease_until=?,updated_at=? WHERE id=?")
      .run(token, new Date(Date.now()+leaseMs).toISOString(), now, cleanText(row.id));
    return { ...row, lease_owner: token, payload: asObject(parseJson(row.payload_json)) };
  }));
}
export async function renewAgentWakeup(id: string, token: string, leaseMs = 120000) {
  return (await getAgentsDatabase().prepare("UPDATE agent_wakeup_jobs SET lease_until=? WHERE id=? AND lease_owner=? AND state='running' AND lease_until>?")
    .run(new Date(Date.now()+leaseMs).toISOString(), id, token, nowIso())).changes === 1;
}
export async function finishAgentWakeup(id: string, token: string, state: "succeeded" | "uncertain" | "cancelled", error = "") {
  return (await getAgentsDatabase().prepare("UPDATE agent_wakeup_jobs SET state=?,error=?,updated_at=? WHERE id=? AND lease_owner=? AND state='running' AND lease_until>?")
    .run(state, error.slice(0,2000), nowIso(), id, token, nowIso())).changes === 1;
}

/**
 * Threads stuck in 'working' from a previous process (a restart kills any
 * in-flight turn) are reset to idle so their conversations aren't wedged.
 */
export async function resetStuckAgentThreads() {
  const now = nowIso();
  const result = await getAgentsDatabase().prepare(`UPDATE agent_threads SET status='idle', run_token='', run_lease_until='', updated_at=?
    WHERE status='working' AND (run_lease_until='' OR run_lease_until<=?)`).run(now, now);
  return result.changes;
}

// ── Meta / migration markers ───────────────────────────────────────────────

export async function readAgentMeta(key: string) {
  const row = (await getAgentsDatabase().prepare("SELECT value FROM agent_meta WHERE key=?").get(cleanText(key)));
  return row ? cleanText(asObject(row).value) : "";
}

export async function writeAgentMeta(key: string, value: string) {
  (await getAgentsDatabase()
    .prepare(`INSERT INTO agent_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(cleanText(key), String(value ?? ""), nowIso()));
}

/**
 * One-time import of a legacy per-module thread store into agents.sqlite.
 * The reader callbacks return rows in the legacy shape; rows whose ids
 * already exist are skipped, so re-running is harmless.
 */
export async function importLegacyThreads(options: {
  agentId: string;
  marker: string;
  listThreads: () => JsonObject[] | Promise<JsonObject[]>;
  listMessages: (threadId: string) => JsonObject[] | Promise<JsonObject[]>;
  subjectField?: string;
}) {
  if ((await readAgentMeta(options.marker)) === "done") return { imported: 0, skipped: true };
  const db = getAgentsDatabase();
  let imported = 0;
  // An unreadable store or partial import must remain retryable. A thread and
  // its messages commit together; existing threads still receive missing rows.
  const threads = await options.listThreads();
  const failures: unknown[] = [];
  for (const thread of threads) {
    const threadId = cleanText(thread.id);
    if (!threadId) continue;
    try {
      const messages = await options.listMessages(threadId);
      await db.transaction(async () => {
        if (!await readAgentThread(options.agentId, cleanText(thread.organization_id), threadId)) {
          await createAgentThread({ id: threadId, agent_id: options.agentId,
            organization_id: cleanText(thread.organization_id), branch_id: cleanText(thread.branch_id || "default") || "default",
            subject_id: cleanText(options.subjectField ? thread[options.subjectField] : thread.subject_id),
            title: cleanText(thread.title), status: "idle", created_by_user_id: cleanText(thread.created_by_user_id),
            created_at: cleanText(thread.created_at), updated_at: cleanText(thread.updated_at) });
        }
        for (const message of messages) {
          const messageId = cleanText(message.id);
          if (!messageId) continue;
          await db.prepare(`INSERT INTO agent_messages (id, thread_id, agent_id, organization_id, role, content, data_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
            .run(messageId, threadId, options.agentId, cleanText(message.organization_id || thread.organization_id),
              cleanText(message.role) || "user", String(message.content ?? ""),
              typeof message.data_json === "string" ? message.data_json : json(message.data), cleanText(message.created_at) || nowIso());
        }
      });
      imported += 1;
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `Could not import ${failures.length} legacy agent conversations.`);
  await writeAgentMeta(options.marker, "done");
  return { imported, skipped: false };
}

/** A renewable claim prevents two replicas from executing the same conversation concurrently. */
export async function acquireAgentThread(agentId: string, orgId: string, threadId: string, token: string, leaseMs = 120_000) {
  const now = nowIso();
  return (await getAgentsDatabase().prepare(`UPDATE agent_threads SET run_token=?, run_lease_until=?, status='working', updated_at=?
    WHERE agent_id=? AND organization_id=? AND id=? AND (run_token='' OR run_lease_until<=?)`)
    .run(token, new Date(Date.now() + leaseMs).toISOString(), now, agentId, orgId, threadId, now)).changes > 0;
}
export async function renewAgentThread(agentId: string, orgId: string, threadId: string, token: string, leaseMs = 120_000) {
  return (await getAgentsDatabase().prepare(`UPDATE agent_threads SET run_lease_until=? WHERE agent_id=? AND organization_id=? AND id=? AND run_token=? AND run_lease_until>?`)
    .run(new Date(Date.now() + leaseMs).toISOString(), agentId, orgId, threadId, token, nowIso())).changes > 0;
}
export async function releaseAgentThread(agentId: string, orgId: string, threadId: string, token: string) {
  return (await getAgentsDatabase().prepare(`UPDATE agent_threads SET run_token='', run_lease_until='', status='idle', updated_at=?
    WHERE agent_id=? AND organization_id=? AND id=? AND run_token=?`).run(nowIso(), agentId, orgId, threadId, token)).changes > 0;
}
