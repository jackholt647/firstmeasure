import { randomUUID } from "node:crypto";
import path from "node:path";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { env } from "../src/config/env.js";
import { currentChangeSource, type ChangeSource } from "./source.js";

/**
 * The project change history: one append-only row per change to a project's real work (its material lists, work
 * orders, equipment, scope artifacts, assignments and schedule), and one row per generator run with what it was given
 * and what it made. Rows are never edited or deleted. See docs/architecture/project-history.md.
 */
export type JsonObject = Record<string, unknown>;
export type ChangeDomain = "materials" | "work_order" | "equipment" | "scope" | "schedule" | "measurements";
export type ProjectChange = {
  id: string;
  organization_id: string;
  project_id: string;
  at: string;
  domain: ChangeDomain;
  subject_type: string;
  subject_id: string;
  op: string;
  summary: string;
  source: ChangeSource;
  generation_id: string;
  before: unknown;
  after: unknown;
  diff: unknown;
};
export type GenerationRun = {
  id: string;
  organization_id: string;
  project_id: string;
  at: string;
  generator: string;
  generator_version: string;
  subject_type: string;
  subject_id: string;
  source: ChangeSource;
  inputs: JsonObject;
  output: JsonObject;
};

let database: SqlStore | null = null;
let databasePath = "";
const text = (value: unknown) => String(value ?? "").trim();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = (value: unknown, fallback: unknown = null) => { try { return value == null || value === "" ? fallback : JSON.parse(String(value)); } catch { return fallback; } };

export async function closeHistoryDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return await current?.close();
}

function db() {
  const nextPath = path.resolve(process.cwd(), env.platformStorageRoot, "project-history.sqlite");
  if (database && databasePath === nextPath) return database;
  void closeHistoryDatabase();
  // Raise this whenever initialize gains a table or a column: Postgres runs it again only for a higher version.
  database = openSqlStore({ id: "project_history", schemaVersion: 1, filename: nextPath, initialize });
  databasePath = nextPath;
  return database;
}

async function initialize(store: SqlStore) {
  await store.exec(`
    CREATE TABLE IF NOT EXISTS project_changes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      at TEXT NOT NULL,
      domain TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      op TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      generation_id TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      before_json TEXT NOT NULL DEFAULT 'null',
      after_json TEXT NOT NULL DEFAULT 'null',
      diff_json TEXT NOT NULL DEFAULT 'null'
    );
    CREATE INDEX IF NOT EXISTS idx_project_changes_project ON project_changes (organization_id, project_id, at);
    CREATE INDEX IF NOT EXISTS idx_project_changes_subject ON project_changes (organization_id, subject_id, at);
    CREATE INDEX IF NOT EXISTS idx_project_changes_generation ON project_changes (organization_id, generation_id);
    CREATE TABLE IF NOT EXISTS generation_runs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      at TEXT NOT NULL,
      generator TEXT NOT NULL,
      generator_version TEXT NOT NULL DEFAULT '',
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      inputs_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_generation_runs_project ON generation_runs (organization_id, project_id, at);
    CREATE INDEX IF NOT EXISTS idx_generation_runs_generator ON generation_runs (organization_id, generator, at);
    CREATE INDEX IF NOT EXISTS idx_generation_runs_subject ON generation_runs (organization_id, subject_id, at);
  `);
}

// Ids sort in the order they were written, so two changes in the same millisecond still read back in order.
let sequence = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36).padStart(9, "0")}${(sequence = (sequence + 1) % 1296).toString(36).padStart(2, "0")}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

/**
 * Records one change. The source is whoever is acting now (source.ts) unless one is given. History never stops the
 * work it describes: a failure to record is logged loudly and the change stands (a known limit, recorded in the
 * architecture page).
 */
export async function recordProjectChange(orgId: string, change: { project_id: string; domain: ChangeDomain; subject_type: string; subject_id: string; op: string; summary?: string; before?: unknown; after?: unknown; diff?: unknown; source?: ChangeSource; user_id?: string }) {
  const projectId = text(change.project_id);
  if (!orgId || !projectId) return null;
  const source = change.source || currentChangeSource(change.user_id);
  const row = { id: newId("chg"), at: new Date().toISOString() };
  try {
    await db().prepare(`INSERT INTO project_changes (id, organization_id, project_id, at, domain, subject_type, subject_id, op, summary, source_kind, user_id, generation_id, source_json, before_json, after_json, diff_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, orgId, projectId, row.at, change.domain, change.subject_type, text(change.subject_id), change.op, text(change.summary), source.kind, text(source.user_id), text(source.generation_id), json(source), json(change.before ?? null), json(change.after ?? null), json(change.diff ?? null));
    return row.id;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "project_history_record_failed", organization_id: orgId, project_id: projectId, domain: change.domain, subject_id: change.subject_id, op: change.op, message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

/** An id for a generator run, taken before it writes so its lines can carry it. */
export const newGenerationId = () => newId("gen");

/** Records a generator run before it writes, and returns its id for the source of everything it writes. */
export async function recordGeneration(orgId: string, run: { project_id: string; generator: string; generator_version?: string; subject_type: string; subject_id: string; inputs: JsonObject; output: JsonObject; user_id?: string; id?: string }) {
  const id = run.id || newId("gen");
  const source = currentChangeSource(run.user_id);
  try {
    await db().prepare(`INSERT INTO generation_runs (id, organization_id, project_id, at, generator, generator_version, subject_type, subject_id, user_id, source_json, inputs_json, output_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, text(run.project_id), new Date().toISOString(), run.generator, text(run.generator_version), run.subject_type, text(run.subject_id), text(source.user_id), json(source), json(run.inputs), json(run.output));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "project_history_generation_failed", organization_id: orgId, project_id: run.project_id, generator: run.generator, message: error instanceof Error ? error.message : String(error) }));
  }
  return id;
}

const changeFromRow = (row: Record<string, unknown>): ProjectChange => ({
  id: text(row.id), organization_id: text(row.organization_id), project_id: text(row.project_id), at: text(row.at), domain: text(row.domain) as ChangeDomain,
  subject_type: text(row.subject_type), subject_id: text(row.subject_id), op: text(row.op), summary: text(row.summary), source: parse(row.source_json, { kind: text(row.source_kind) }) as ChangeSource,
  generation_id: text(row.generation_id), before: parse(row.before_json), after: parse(row.after_json), diff: parse(row.diff_json)
});
const runFromRow = (row: Record<string, unknown>): GenerationRun => ({
  id: text(row.id), organization_id: text(row.organization_id), project_id: text(row.project_id), at: text(row.at), generator: text(row.generator), generator_version: text(row.generator_version),
  subject_type: text(row.subject_type), subject_id: text(row.subject_id), source: parse(row.source_json, {}) as ChangeSource, inputs: parse(row.inputs_json, {}) as JsonObject, output: parse(row.output_json, {}) as JsonObject
});
const limitOf = (value: unknown, fallback: number, max: number) => Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)));

/** Changes, oldest first: for one project, one subject or one generation run. */
export async function listProjectChanges(orgId: string, filter: { project_id?: string; domain?: string; subject_id?: string; generation_id?: string; since?: string; until?: string; limit?: number }) {
  const where = ["organization_id = ?"], values: string[] = [orgId];
  for (const key of ["project_id", "domain", "subject_id", "generation_id"] as const) if (text(filter[key])) { where.push(`${key} = ?`); values.push(text(filter[key])); }
  if (text(filter.since)) { where.push("at >= ?"); values.push(text(filter.since)); }
  if (text(filter.until)) { where.push("at <= ?"); values.push(text(filter.until)); }
  const rows = await db().prepare(`SELECT * FROM project_changes WHERE ${where.join(" AND ")} ORDER BY at ASC, id ASC LIMIT ${limitOf(filter.limit, 500, 2000)}`).all(...values);
  return rows.map(changeFromRow);
}

/** Generator runs, newest first: for one project or subject, or for one generator across the organization. */
export async function listGenerations(orgId: string, filter: { project_id?: string; subject_id?: string; generator?: string; since?: string; limit?: number }) {
  const where = ["organization_id = ?"], values: string[] = [orgId];
  for (const key of ["project_id", "subject_id", "generator"] as const) if (text(filter[key])) { where.push(`${key} = ?`); values.push(text(filter[key])); }
  if (text(filter.since)) { where.push("at >= ?"); values.push(text(filter.since)); }
  const rows = await db().prepare(`SELECT * FROM generation_runs WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ${limitOf(filter.limit, 50, 500)}`).all(...values);
  return rows.map(runFromRow);
}
