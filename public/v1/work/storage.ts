import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../platform/sql_store.js";

import { env } from "../src/config/env.js";
import { workEventVisibility } from "./events.js";
import type { WorkNodeStatus } from "./schemas.js";

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
  return path.resolve(process.cwd(), env.platformStorageRoot, "work.sqlite");
}

export async function closeWorkDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}
export function getWorkDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeWorkDatabase();
  database = openSqlStore({ id: "work", schemaVersion: 2, filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS work_plans (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      project_id TEXT,
      source_type TEXT,
      source_id TEXT,
      source_version_id TEXT,
      source_key TEXT,
      template_id TEXT,
      template_version INTEGER,
      scope_piece_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      root_node_id TEXT,
      terminology_json TEXT NOT NULL DEFAULT '{}',
      automation_bindings_json TEXT NOT NULL DEFAULT '{}',
      context_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT,
      completed_at TEXT,
      canceled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_plans_source_key_uq
      ON work_plans(organization_id, source_key) WHERE source_key IS NOT NULL AND source_key <> '';
    CREATE INDEX IF NOT EXISTS work_plans_project_idx ON work_plans(organization_id, project_id, status);

    CREATE TABLE IF NOT EXISTS work_nodes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      plan_id TEXT NOT NULL REFERENCES work_plans(id) ON DELETE CASCADE,
      project_id TEXT,
      parent_id TEXT REFERENCES work_nodes(id) ON DELETE CASCADE,
      template_node_id TEXT NOT NULL,
      scope_piece_id TEXT,
      terminology_key TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      completion_mode TEXT NOT NULL,
      actionable INTEGER NOT NULL DEFAULT 0,
      show_in_todo_list INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      assigned_user_ids_json TEXT NOT NULL DEFAULT '[]',
      assigned_role_ids_json TEXT NOT NULL DEFAULT '[]',
      assigned_resource_group_ids_json TEXT NOT NULL DEFAULT '[]',
      automation_bindings_json TEXT NOT NULL DEFAULT '{}',
      external_triggers_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      due_at TEXT,
      ready_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      skipped_at TEXT,
      canceled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_nodes_template_uq ON work_nodes(plan_id, template_node_id);
    CREATE INDEX IF NOT EXISTS work_nodes_project_idx ON work_nodes(organization_id, project_id, status);
    CREATE INDEX IF NOT EXISTS work_nodes_plan_parent_idx ON work_nodes(plan_id, parent_id, sort_order);
    CREATE INDEX IF NOT EXISTS work_nodes_due_idx ON work_nodes(organization_id, due_at, status);

    CREATE TABLE IF NOT EXISTS work_dependencies (
      node_id TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      depends_on_node_id TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
      condition TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL,
      PRIMARY KEY(node_id, depends_on_node_id, condition)
    );

    CREATE TABLE IF NOT EXISTS work_events (
      ${db.isPostgres ? "event_sequence BIGSERIAL UNIQUE," : ""}
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      project_id TEXT,
      plan_id TEXT,
      node_id TEXT,
      type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      context_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'system',
      actor_user_id TEXT,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      processed_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_events_idempotency_uq ON work_events(organization_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS work_events_queue_idx ON work_events(status, available_at, lease_until);

    CREATE TABLE IF NOT EXISTS work_automation_executions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      event_id TEXT NOT NULL REFERENCES work_events(id) ON DELETE CASCADE,
      binding_id TEXT NOT NULL,
      automation TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(event_id, binding_id)
    );

    CREATE TABLE IF NOT EXISTS scope_templates (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      current_version INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, branch_id, id)
    );

    CREATE TABLE IF NOT EXISTS scope_template_versions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      definition_json TEXT NOT NULL,
      checksum TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE(organization_id, branch_id, template_id, version)
    );
    CREATE INDEX IF NOT EXISTS scope_versions_template_idx
      ON scope_template_versions(organization_id, branch_id, template_id, version DESC);

    CREATE TABLE IF NOT EXISTS organization_scope_settings (
      organization_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      flags_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_cron_state (
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      last_fired_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, branch_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS scope_agent_threads (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scope_agent_threads_org_idx ON scope_agent_threads(organization_id, template_id, updated_at);

    CREATE TABLE IF NOT EXISTS scope_agent_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES scope_agent_threads(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scope_agent_messages_thread_idx ON scope_agent_messages(thread_id, created_at);
  `));
  await ensureSqlColumn(db, "work_nodes", "priority", "INTEGER NOT NULL DEFAULT 0");
  await ensureSqlColumn(db, "work_nodes", "assigned_resource_group_ids_json", "TEXT NOT NULL DEFAULT '[]'");
  await ensureSqlColumn(db, "work_events", "visibility", "TEXT NOT NULL DEFAULT 'system'");
  await ensureSqlColumn(db, "work_events", "actor_user_id", "TEXT");
  await ensureSqlColumn(db, "work_automation_executions", "lease_owner", "TEXT NOT NULL DEFAULT ''");
  (await db.exec("CREATE INDEX IF NOT EXISTS work_events_activity_idx ON work_events(organization_id, visibility, created_at)"));
  (await db.exec("CREATE INDEX IF NOT EXISTS work_events_project_activity_idx ON work_events(organization_id, project_id, visibility, created_at)"));
}

function rowObject(row: unknown) {
  return asObject(row);
}

export function planFromRow(row: unknown): JsonObject {
  const value = rowObject(row);
  return {
    ...value,
    template_version: Number(value.template_version || 0),
    terminology: parseJson(value.terminology_json),
    automation_bindings: parseJson(value.automation_bindings_json),
    context: parseJson(value.context_json),
    metadata: parseJson(value.metadata_json)
  };
}

export function nodeFromRow(row: unknown): JsonObject {
  const value = rowObject(row);
  const metadata = parseJson(value.metadata_json);
  return {
    ...value,
    sort_order: Number(value.sort_order || 0),
    depth: Number(value.depth || 0),
    actionable: Number(value.actionable || 0) === 1,
    show_in_todo_list: Number(value.show_in_todo_list || 0) === 1,
    priority: Number(value.priority || 0),
    assigned_user_ids: parseJson(value.assigned_user_ids_json, []),
    assigned_role_ids: parseJson(value.assigned_role_ids_json, []),
    assigned_resource_group_ids: parseJson(value.assigned_resource_group_ids_json, []),
    automation_bindings: parseJson(value.automation_bindings_json),
    external_triggers: parseJson(value.external_triggers_json, []),
    notes: parseJson(value.notes_json, []),
    metadata,
    ...(Object.prototype.hasOwnProperty.call(asObject(metadata), "assignment_policy")
      ? { assignment_policy:asObject(metadata).assignment_policy }
      : {})
  };
}

export function eventFromRow(row: unknown): JsonObject {
  const value = rowObject(row);
  return {
    ...value,
    attempts: Number(value.attempts || 0),
    payload: parseJson(value.payload_json),
    context: parseJson(value.context_json)
  };
}

export async function createPlanRecord(input: JsonObject) {
  return (await getWorkDatabase().transaction(async () => {
  const db = getWorkDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `work_plan_${randomUUID().replace(/-/g, "")}`;
  const sourceKey = cleanText(input.source_key);
  if (sourceKey) {
    const existing = (await db.prepare("SELECT * FROM work_plans WHERE organization_id = ? AND source_key = ?").get(cleanText(input.organization_id), sourceKey));
    if (existing) return { plan: planFromRow(existing), created: false };
  }
  const inserted = (await db.prepare(`INSERT INTO work_plans (
    id, organization_id, branch_id, project_id, source_type, source_id, source_version_id, source_key,
    template_id, template_version, scope_piece_id, title, status, terminology_json,
    automation_bindings_json, context_json, metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(
      id, cleanText(input.organization_id), cleanText(input.branch_id || "default") || "default",
      cleanText(input.project_id) || null, cleanText(input.source_type) || null, cleanText(input.source_id) || null,
      cleanText(input.source_version_id) || null, sourceKey || null, cleanText(input.template_id) || null,
      Number(input.template_version || 0) || null, cleanText(input.scope_piece_id) || null, cleanText(input.title) || "Work Plan",
      cleanText(input.status || "pending") || "pending", json(input.terminology), json(input.automation_bindings),
      json(input.context), json(input.metadata), now, now
    ));
  if (!Number(inserted.changes || 0)) {
    const existing = sourceKey
      ? (await db.prepare("SELECT * FROM work_plans WHERE organization_id = ? AND source_key = ?").get(cleanText(input.organization_id), sourceKey))
      : (await db.prepare("SELECT * FROM work_plans WHERE organization_id = ? AND id = ?").get(cleanText(input.organization_id), id));
    if (existing) return { plan: planFromRow(existing), created: false };
    throw new Error(`Work plan id '${id}' is already in use by another organization.`);
  }
  return { plan: (await readPlanRecord(cleanText(input.organization_id), id)), created: true };

  }));
}

export async function readPlanRecord(orgId: string, planId: string) {
  const row = (await getWorkDatabase().prepare("SELECT * FROM work_plans WHERE organization_id = ? AND id = ?").get(orgId, planId));
  return row ? planFromRow(row) : null;
}

export async function listPlanRecords(orgId: string, options: JsonObject = {}) {
  const where = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  for (const [column, value] of [["project_id", options.project_id], ["status", options.status], ["source_type", options.source_type]] as const) {
    if (!cleanText(value)) continue;
    where.push(`${column} = ?`);
    params.push(cleanText(value));
  }
  return (await getWorkDatabase().prepare(`SELECT * FROM work_plans WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...params)).map(planFromRow);
}

export async function updatePlanRecord(orgId: string, planId: string, patch: JsonObject) {
  return (await getWorkDatabase().transaction(async () => {
  const current = (await readPlanRecord(orgId, planId));
  if (!current) return null;
  const next: JsonObject = { ...current, ...patch, updated_at: nowIso() };
  (await getWorkDatabase().prepare(`UPDATE work_plans SET status=?, root_node_id=?, terminology_json=?, automation_bindings_json=?,
    context_json=?, metadata_json=?, started_at=?, completed_at=?, canceled_at=?, updated_at=? WHERE organization_id=? AND id=?`)
    .run(
      cleanText(next.status), cleanText(next.root_node_id) || null, json(next.terminology), json(next.automation_bindings),
      json(next.context), json(next.metadata), cleanText(next.started_at) || null, cleanText(next.completed_at) || null,
      cleanText(next.canceled_at) || null, cleanText(next.updated_at), orgId, planId
    ));
  return (await readPlanRecord(orgId, planId));

  }));
}

export async function createNodeRecord(input: JsonObject) {
  return (await getWorkDatabase().transaction(async () => {
  const db = getWorkDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `work_node_${randomUUID().replace(/-/g, "")}`;
  (await db.prepare(`INSERT INTO work_nodes (
    id, organization_id, branch_id, plan_id, project_id, parent_id, template_node_id, scope_piece_id,
    terminology_key, title, description, sort_order, depth, status, completion_mode, actionable,
    show_in_todo_list, priority, assigned_user_ids_json, assigned_role_ids_json, assigned_resource_group_ids_json, automation_bindings_json,
    external_triggers_json, notes_json, metadata_json, due_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, cleanText(input.organization_id), cleanText(input.branch_id || "default") || "default", cleanText(input.plan_id),
      cleanText(input.project_id) || null, cleanText(input.parent_id) || null, cleanText(input.template_node_id),
      cleanText(input.scope_piece_id) || null, cleanText(input.terminology_key) || null, cleanText(input.title) || "Work Item",
      cleanText(input.description), Number(input.sort_order || 0), Number(input.depth || 0), cleanText(input.status || "pending"),
      cleanText(input.completion_mode || "manual"), input.actionable === true ? 1 : 0, input.show_in_todo_list === true ? 1 : 0,
      Math.max(0, Math.round(Number(input.priority) || 0)),
      json(input.assigned_user_ids || []), json(input.assigned_role_ids || []), json(input.assigned_resource_group_ids || []), json(input.automation_bindings),
      json(input.external_triggers || []), json(input.notes || []), json(input.metadata), cleanText(input.due_at) || null, now, now
    ));
  return (await readNodeRecord(cleanText(input.organization_id), id));

  }));
}

export async function readNodeRecord(orgId: string, nodeId: string) {
  const row = (await getWorkDatabase().prepare("SELECT * FROM work_nodes WHERE organization_id = ? AND id = ?").get(orgId, nodeId));
  return row ? nodeFromRow(row) : null;
}

export async function listNodeRecords(orgId: string, options: JsonObject = {}) {
  const where = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  const filters = [
    ["plan_id", options.plan_id], ["project_id", options.project_id], ["parent_id", options.parent_id],
    ["status", options.status], ["scope_piece_id", options.scope_piece_id]
  ] as const;
  for (const [column, value] of filters) {
    if (value === undefined || value === null || (column !== "parent_id" && !cleanText(value))) continue;
    if (column === "parent_id" && value === "__root__") where.push("parent_id IS NULL");
    else {
      where.push(`${column} = ?`);
      params.push(cleanText(value));
    }
  }
  if (options.actionable === true) where.push("actionable = 1");
  if (options.show_in_todo_list === true) where.push("show_in_todo_list = 1");
  if (options.open_only === true) where.push("status NOT IN ('completed','skipped','canceled')");
  return (await getWorkDatabase().prepare(`SELECT * FROM work_nodes WHERE ${where.join(" AND ")} ORDER BY depth ASC, sort_order ASC, created_at ASC`).all(...params)).map(nodeFromRow);
}

export async function updateNodeRecord(orgId: string, nodeId: string, patch: JsonObject) {
  return (await getWorkDatabase().transaction(async () => {
  const current = (await readNodeRecord(orgId, nodeId));
  if (!current) return null;
  const next: JsonObject = { ...current, ...patch, updated_at: nowIso() };
  (await getWorkDatabase().prepare(`UPDATE work_nodes SET title=?, description=?, status=?, completion_mode=?, actionable=?,
    show_in_todo_list=?, priority=?, assigned_user_ids_json=?, assigned_role_ids_json=?, assigned_resource_group_ids_json=?, automation_bindings_json=?,
    external_triggers_json=?, notes_json=?, metadata_json=?, due_at=?, ready_at=?, started_at=?, completed_at=?,
    skipped_at=?, canceled_at=?, updated_at=? WHERE organization_id=? AND id=?`)
    .run(
      cleanText(next.title), cleanText(next.description), cleanText(next.status), cleanText(next.completion_mode),
      next.actionable === true ? 1 : 0, next.show_in_todo_list === true ? 1 : 0,
      Math.max(0, Math.round(Number(next.priority) || 0)), json(next.assigned_user_ids || []),
      json(next.assigned_role_ids || []), json(next.assigned_resource_group_ids || []), json(next.automation_bindings), json(next.external_triggers || []),
      json(next.notes || []), json(next.metadata), cleanText(next.due_at) || null, cleanText(next.ready_at) || null,
      cleanText(next.started_at) || null, cleanText(next.completed_at) || null, cleanText(next.skipped_at) || null,
      cleanText(next.canceled_at) || null, cleanText(next.updated_at), orgId, nodeId
    ));
  return (await readNodeRecord(orgId, nodeId));

  }));
}

export async function createDependencyRecord(nodeId: string, dependsOnNodeId: string, condition = "completed") {
  return (await getWorkDatabase().transaction(async () => {
  (await getWorkDatabase().prepare("INSERT INTO work_dependencies (node_id, depends_on_node_id, condition, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(nodeId, dependsOnNodeId, condition, nowIso()));

  }));
}

export async function replaceDependencyRecords(nodeId: string, dependencies: Array<{ node_id: string; condition?: string }>) {
  const db = getWorkDatabase();
  (await db.prepare("DELETE FROM work_dependencies WHERE node_id = ?").run(nodeId));
  for (const dependency of dependencies) {
    (await createDependencyRecord(nodeId, cleanText(dependency.node_id), cleanText(dependency.condition || "completed") || "completed"));
  }
}

export async function listDependenciesForNode(nodeId: string) {
  return (await getWorkDatabase().prepare(`SELECT d.*, n.status AS depends_on_status FROM work_dependencies d
    JOIN work_nodes n ON n.id = d.depends_on_node_id WHERE d.node_id = ?`).all(nodeId)).map(rowObject);
}

export async function listDependents(nodeId: string) {
  return (await getWorkDatabase().prepare("SELECT * FROM work_dependencies WHERE depends_on_node_id = ?").all(nodeId)).map(rowObject);
}

export async function createEventRecord(input: JsonObject) {
  return (await getWorkDatabase().transaction(async () => {
  const db = getWorkDatabase();
  const orgId = cleanText(input.organization_id);
  const key = cleanText(input.idempotency_key) || `${cleanText(input.type)}:${randomUUID()}`;
  const existing = (await db.prepare("SELECT * FROM work_events WHERE organization_id = ? AND idempotency_key = ?").get(orgId, key));
  if (existing) return { event: eventFromRow(existing), created: false };
  const now = nowIso();
  const id = cleanText(input.id) || `work_event_${randomUUID().replace(/-/g, "")}`;
  const visibility = cleanText(input.visibility) === "activity" || cleanText(input.visibility) === "system"
    ? cleanText(input.visibility)
    : workEventVisibility(cleanText(input.type));
  const actorUserId = cleanText(input.actor_user_id || asObject(input.context).actor_user_id) || null;
  const inserted = (await db.prepare(`INSERT INTO work_events (id, organization_id, branch_id, project_id, plan_id, node_id, type,
    idempotency_key, payload_json, context_json, status, attempts, visibility, actor_user_id, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(
      id, orgId, cleanText(input.branch_id || "default") || "default", cleanText(input.project_id) || null,
      cleanText(input.plan_id) || null, cleanText(input.node_id) || null, cleanText(input.type), key,
      json(input.payload), json(input.context), visibility, actorUserId, cleanText(input.available_at || now), now, now
    ));
  if (!Number(inserted.changes || 0)) {
    const concurrent = (await db.prepare("SELECT * FROM work_events WHERE organization_id = ? AND idempotency_key = ?").get(orgId, key));
    if (concurrent) return { event: eventFromRow(concurrent), created: false };
    throw new Error(`Work event id '${id}' is already in use by another organization.`);
  }
  return { event: (await readEventRecord(orgId, id)), created: true };

  }));
}

export async function readEventRecord(orgId: string, eventId: string) {
  const row = (await getWorkDatabase().prepare("SELECT * FROM work_events WHERE organization_id = ? AND id = ?").get(orgId, eventId));
  return row ? eventFromRow(row) : null;
}

export async function listEventRecords(orgId: string, options: JsonObject = {}) {
  const where = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  for (const [column, value] of [
    ["project_id", options.project_id],
    ["plan_id", options.plan_id],
    ["node_id", options.node_id],
    ["status", options.status],
    ["visibility", options.visibility],
    ["actor_user_id", options.actor_user_id],
    ["type", options.type]
  ] as const) {
    if (!cleanText(value)) continue;
    where.push(`${column} = ?`);
    params.push(cleanText(value));
  }
  if (cleanText(options.type_prefix)) {
    where.push("type LIKE ?");
    params.push(`${cleanText(options.type_prefix)}%`);
  }
  // Cursor pagination for activity feeds: pass the oldest created_at from the
  // previous page as `before`.
  if (cleanText(options.before)) {
    where.push("created_at < ?");
    params.push(cleanText(options.before));
  }
  const limit = Math.min(500, Math.max(1, Number(options.limit || 100)));
  params.push(limit);
  return (await getWorkDatabase().prepare(`SELECT * FROM work_events WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...params)).map(eventFromRow);
}

// ── Scope agent threads ────────────────────────────────────────────────────

export async function createAgentThread(input: JsonObject) {
  return (await getWorkDatabase().transaction(async () => {
  const db = getWorkDatabase();
  const id = cleanText(input.id) || `agent_thread_${randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  (await db.prepare(`INSERT INTO scope_agent_threads (id, organization_id, branch_id, template_id, title, status, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)`)
    .run(id, cleanText(input.organization_id), cleanText(input.branch_id || "default") || "default",
      cleanText(input.template_id), cleanText(input.title), cleanText(input.created_by_user_id) || null, now, now));
  return (await readAgentThread(cleanText(input.organization_id), id));

  }));
}

export async function readAgentThread(orgId: string, threadId: string) {
  const row = (await getWorkDatabase().prepare("SELECT * FROM scope_agent_threads WHERE organization_id=? AND id=?").get(orgId, threadId));
  return row ? rowObject(row) : null;
}

export async function listAgentThreads(orgId: string, options: JsonObject = {}) {
  const where = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  if (cleanText(options.template_id)) {
    where.push("template_id = ?");
    params.push(cleanText(options.template_id));
  }
  params.push(Math.min(100, Math.max(1, Number(options.limit || 50))));
  return (await getWorkDatabase().prepare(`SELECT * FROM scope_agent_threads WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params)).map(rowObject);
}

export async function updateAgentThread(orgId: string, threadId: string, patch: JsonObject) {
  return (await getWorkDatabase().transaction(async () => {
  const db = getWorkDatabase();
  const current = (await readAgentThread(orgId, threadId));
  if (!current) return null;
  (await db.prepare("UPDATE scope_agent_threads SET title=?, status=?, updated_at=? WHERE organization_id=? AND id=?")
    .run(cleanText(patch.title ?? current.title), cleanText(patch.status ?? current.status) || "idle", nowIso(), orgId, threadId));
  return (await readAgentThread(orgId, threadId));

  }));
}

export async function appendAgentMessage(orgId: string, threadId: string, input: JsonObject) {
  const db = getWorkDatabase();
  const id = cleanText(input.id) || `agent_message_${randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  (await db.prepare(`INSERT INTO scope_agent_messages (id, thread_id, organization_id, role, content, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, threadId, orgId, cleanText(input.role) || "user", String(input.content ?? ""), json(input.data), now));
  (await db.prepare("UPDATE scope_agent_threads SET updated_at=? WHERE organization_id=? AND id=?").run(now, orgId, threadId));
  const row = (await db.prepare("SELECT * FROM scope_agent_messages WHERE id=?").get(id));
  return row ? { ...rowObject(row), data: parseJson(rowObject(row).data_json) } : null;
}

export async function listAgentMessages(orgId: string, threadId: string, options: JsonObject = {}) {
  const limit = Math.min(500, Math.max(1, Number(options.limit || 200)));
  return (await getWorkDatabase().prepare(`SELECT * FROM scope_agent_messages WHERE organization_id=? AND thread_id=?
    ORDER BY created_at ASC LIMIT ?`).all(orgId, threadId, limit))
    .map((row) => ({ ...rowObject(row), data: parseJson(rowObject(row).data_json) }));
}

export async function readCronState(orgId: string, branchId: string, ruleId: string) {
  const row = (await getWorkDatabase().prepare("SELECT * FROM automation_cron_state WHERE organization_id=? AND branch_id=? AND rule_id=?")
    .get(orgId, branchId, ruleId));
  return row ? rowObject(row) : null;
}

export async function saveCronState(orgId: string, branchId: string, ruleId: string, lastFiredAt: string) {
  return (await getWorkDatabase().transaction(async () => {
  (await getWorkDatabase().prepare(`INSERT INTO automation_cron_state (organization_id, branch_id, rule_id, last_fired_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, branch_id, rule_id) DO UPDATE SET last_fired_at=excluded.last_fired_at, updated_at=excluded.updated_at`)
    .run(orgId, branchId, ruleId, lastFiredAt, nowIso()));

  }));
}

export async function claimNextEvent(workerId: string, maxAttempts = 5) {
  const db = getWorkDatabase();
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + 90_000).toISOString();
  const token = `${workerId}:${randomUUID()}`;
  return await db.transaction(async () => {
    const row = (await db.prepare(`SELECT * FROM work_events WHERE attempts < ? AND available_at <= ? AND
      (status = 'pending' OR status = 'failed' OR (status = 'processing' AND lease_until < ?))
      ORDER BY created_at ASC LIMIT 1`).get(maxAttempts, now, now));
    if (!row) {
      return null;
    }
    const event = eventFromRow(row);
    (await db.prepare("UPDATE work_events SET status='processing', attempts=attempts+1, lease_owner=?, lease_until=?, updated_at=? WHERE id=?")
      .run(token, leaseUntil, now, cleanText(event.id)));
    return (await readEventRecord(cleanText(event.organization_id), cleanText(event.id)));
  
  });
}

export async function renewEventLease(eventId: string, leaseOwner: string) {
  const now = nowIso();
  const result = await getWorkDatabase().prepare(`UPDATE work_events SET lease_until=?,updated_at=?
    WHERE id=? AND lease_owner=? AND status='processing' AND lease_until>?`)
    .run(new Date(Date.now() + 90_000).toISOString(), now, eventId, leaseOwner, now);
  return result.changes === 1;
}
export async function finishEventRecord(eventId: string, leaseOwner: string, error?: unknown) {
  const now = nowIso();
  const message = error ? String(error instanceof Error ? error.message : error) : "";
  const result = await getWorkDatabase().prepare(`UPDATE work_events SET status=?,processed_at=?,error=?,lease_owner=NULL,
    lease_until=NULL,available_at=?,updated_at=? WHERE id=? AND lease_owner=? AND status='processing' AND lease_until>?`)
    .run(error ? "failed" : "completed", error ? null : now, message || null,
      error ? new Date(Date.now() + 2000).toISOString() : now, now, eventId, leaseOwner, now);
  return result.changes === 1;
}

export async function beginExecutionRecord(input: JsonObject) {
  return (await getWorkDatabase().transaction(async () => {
  const db = getWorkDatabase();
  const eventId = cleanText(input.event_id);
  const bindingId = cleanText(input.binding_id);
  const leaseOwner = cleanText(input.lease_owner);
  const event = await readEventRecord(cleanText(input.organization_id), eventId);
  if (!leaseOwner || event?.lease_owner !== leaseOwner || event.status !== "processing" || cleanText(event.lease_until) <= nowIso()) throw new Error("Work event lease lost.");
  const existing = (await db.prepare("SELECT * FROM work_automation_executions WHERE event_id = ? AND binding_id = ?").get(eventId, bindingId));
  const now = nowIso();
  if (existing && (asObject(existing).status === "succeeded" || (asObject(existing).status === "running" && asObject(existing).lease_owner === leaseOwner))) return { execution: asObject(existing), execute: false };
  if (existing) {
    (await db.prepare(`UPDATE work_automation_executions SET status='running', attempts=attempts+1, input_json=?, error=NULL,
      started_at=?, updated_at=?,lease_owner=? WHERE event_id=? AND binding_id=?`).run(json(input.input), now, now, leaseOwner, eventId, bindingId));
  } else {
    const id = `work_execution_${randomUUID().replace(/-/g, "")}`;
    (await db.prepare(`INSERT INTO work_automation_executions (id, organization_id, event_id, binding_id, automation,
      status, attempts, input_json, output_json, started_at, created_at, updated_at, lease_owner)
      VALUES (?, ?, ?, ?, ?, 'running', 1, ?, '{}', ?, ?, ?, ?)`)
      .run(id, cleanText(input.organization_id), eventId, bindingId, cleanText(input.automation), json(input.input), now, now, now, leaseOwner));
  }
  return {
    execution: asObject((await db.prepare("SELECT * FROM work_automation_executions WHERE event_id = ? AND binding_id = ?").get(eventId, bindingId))),
    execute: true
  };

  }));
}

export async function finishExecutionRecord(eventId: string, bindingId: string, leaseOwner: string, output: unknown, error?: unknown) {
  return (await getWorkDatabase().transaction(async () => {
  const now = nowIso();
  (await getWorkDatabase().prepare(`UPDATE work_automation_executions SET status=?, output_json=?, error=?, completed_at=?, updated_at=?
    WHERE event_id=? AND binding_id=? AND lease_owner=? AND EXISTS (SELECT 1 FROM work_events WHERE id=? AND lease_owner=? AND status='processing' AND lease_until>?)`).run(
      error ? "failed" : "succeeded", json(output), error ? String(error instanceof Error ? error.message : error) : null,
      now, now, eventId, bindingId, leaseOwner, eventId, leaseOwner, now
    ));

  }));
}

export async function listExecutionRecords(orgId: string, options: JsonObject = {}): Promise<JsonObject[]> {
  const where = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  if (cleanText(options.event_id)) {
    where.push("event_id = ?");
    params.push(cleanText(options.event_id));
  }
  return (await getWorkDatabase().prepare(`SELECT * FROM work_automation_executions WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`)
    .all(...params)).map((row) => {
      const value = asObject(row);
      return { ...value, input: parseJson(value.input_json), output: parseJson(value.output_json) };
    });
}

export async function dueNodeRecords(now = nowIso()) {
  return (await getWorkDatabase().prepare(`SELECT * FROM work_nodes WHERE due_at IS NOT NULL AND due_at <> '' AND due_at <= ?
    AND status NOT IN ('completed','skipped','canceled') ORDER BY due_at ASC`).all(now)).map(nodeFromRow);
}

// Open nodes that declare timers (metadata.timers). The LIKE prefilter keeps
// the scan cheap; anchor math happens in the scheduler.
export async function timerCandidateNodes() {
  return (await getWorkDatabase().prepare(`SELECT * FROM work_nodes WHERE metadata_json LIKE '%"timers"%'
    AND status NOT IN ('completed','skipped','canceled')`).all()).map(nodeFromRow);
}

export async function nodeStatusCounts(planId: string) {
  return (await getWorkDatabase().prepare("SELECT status, COUNT(*) AS count FROM work_nodes WHERE plan_id = ? GROUP BY status")
    .all(planId)).reduce<JsonObject>((output, row) => {
      const item = asObject(row);
      output[cleanText(item.status)] = Number(item.count || 0);
      return output;
    }, {});
}

export function terminalNodeStatus(status: unknown) {
  return ["completed", "skipped", "canceled"].includes(cleanText(status));
}

export function transitionTimestampPatch(status: WorkNodeStatus, now = nowIso()): JsonObject {
  if (status === "ready") return { ready_at: now };
  if (status === "active") return { started_at: now };
  if (status === "completed") return { completed_at: now };
  if (status === "skipped") return { skipped_at: now };
  if (status === "canceled") return { canceled_at: now };
  return {};
}
