import path from "node:path";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import type { JsonObject } from "../platform/storage.js";

/**
 * Flows and runs (docs/architecture/flows.md). Every save of a flow is a new version row; the flow that plays is its
 * newest published version, and a run pins the version it started on. Runs keep answers, the path taken, the records
 * found or made and the outcome.
 */
let database: SqlStore | undefined;
export function flowStore() {
  return database ??= openSqlStore({ id: "flows", filename: path.resolve(env.platformStorageRoot, "flows.sqlite"), schemaVersion: 1, initialize: async (db) => {
    await db.exec(`CREATE TABLE IF NOT EXISTS flow_versions (organization_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
      name TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL, author_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (organization_id, id, version));
    CREATE TABLE IF NOT EXISTS flow_heads (organization_id TEXT NOT NULL, id TEXT NOT NULL, latest_version INTEGER NOT NULL, published_version INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (organization_id, id));
    CREATE TABLE IF NOT EXISTS flow_runs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, flow_id TEXT NOT NULL, flow_version INTEGER NOT NULL, status TEXT NOT NULL,
      step_id TEXT NOT NULL, path_json TEXT NOT NULL, answers_json TEXT NOT NULL, contact_id TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
      call_id TEXT NOT NULL DEFAULT '', outcome_id TEXT NOT NULL DEFAULT '', source_json TEXT NOT NULL, started_by TEXT NOT NULL, started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS flow_runs_org_flow ON flow_runs(organization_id, flow_id, started_at);
    CREATE INDEX IF NOT EXISTS flow_runs_org_project ON flow_runs(organization_id, project_id, started_at);`);
  } });
}

const json = (value: unknown, fallback: unknown) => { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } };
export type FlowVersion = { id: string; version: number; status: "draft" | "published"; name: string; kind: string; definition: JsonObject; author_id: string; created_at: string };
export type FlowHead = { id: string; latest_version: number; published_version: number; archived: boolean; updated_at: string };
export type FlowRun = {
  id: string; flow_id: string; flow_version: number; status: "open" | "done" | "abandoned"; step_id: string; path: string[]; answers: JsonObject;
  contact_id: string; project_id: string; call_id: string; outcome_id: string; source: JsonObject; started_by: string; started_at: string;
  updated_at: string; finished_at: string; revision: number;
};

const versionOf = (row: JsonObject): FlowVersion => ({ id: String(row.id), version: Number(row.version), status: row.status === "published" ? "published" : "draft", name: String(row.name),
  kind: String(row.kind), definition: json(row.data_json, {}), author_id: String(row.author_id || ""), created_at: String(row.created_at) });
const headOf = (row: JsonObject): FlowHead => ({ id: String(row.id), latest_version: Number(row.latest_version), published_version: Number(row.published_version || 0), archived: Number(row.archived) === 1, updated_at: String(row.updated_at) });
const runOf = (row: JsonObject): FlowRun => ({
  id: String(row.id), flow_id: String(row.flow_id), flow_version: Number(row.flow_version), status: String(row.status) as FlowRun["status"], step_id: String(row.step_id),
  path: json(row.path_json, []), answers: json(row.answers_json, {}), contact_id: String(row.contact_id || ""), project_id: String(row.project_id || ""), call_id: String(row.call_id || ""),
  outcome_id: String(row.outcome_id || ""), source: json(row.source_json, {}), started_by: String(row.started_by), started_at: String(row.started_at), updated_at: String(row.updated_at),
  finished_at: String(row.finished_at || ""), revision: Number(row.revision || 1)
});

export async function listHeads(org: string) {
  return (await flowStore().prepare("SELECT * FROM flow_heads WHERE organization_id=? ORDER BY id").all(org)).map((row) => headOf(row as JsonObject));
}
export async function readHead(org: string, id: string) {
  const row = await flowStore().prepare("SELECT * FROM flow_heads WHERE organization_id=? AND id=?").get(org, id);
  return row ? headOf(row as JsonObject) : null;
}
export async function readVersion(org: string, id: string, version: number) {
  const row = await flowStore().prepare("SELECT * FROM flow_versions WHERE organization_id=? AND id=? AND version=?").get(org, id, version);
  return row ? versionOf(row as JsonObject) : null;
}
/** Saves a new version; `publish` makes it the one new runs play. `expectedVersion` refuses a save over someone else's. */
export async function writeVersion(org: string, id: string, input: { name: string; kind: string; definition: JsonObject; publish: boolean; authorId: string; expectedVersion?: number }) {
  const db = flowStore();
  return db.transaction(async (tx) => {
    const head = await tx.prepare("SELECT * FROM flow_heads WHERE organization_id=? AND id=?").get(org, id) as JsonObject | undefined;
    const latest = Number(head?.latest_version || 0);
    if (input.expectedVersion !== undefined && input.expectedVersion !== latest) return { conflict: true as const, latest };
    const version = latest + 1, now = new Date().toISOString();
    await tx.prepare("INSERT INTO flow_versions(organization_id,id,version,status,name,kind,data_json,author_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(org, id, version, input.publish ? "published" : "draft", input.name, input.kind, JSON.stringify(input.definition), input.authorId, now);
    const published = input.publish ? version : Number(head?.published_version || 0);
    if (head) await tx.prepare("UPDATE flow_heads SET latest_version=?,published_version=?,archived=0,updated_at=? WHERE organization_id=? AND id=?").run(version, published, now, org, id);
    else await tx.prepare("INSERT INTO flow_heads(organization_id,id,latest_version,published_version,archived,updated_at) VALUES(?,?,?,?,0,?)").run(org, id, version, published, now);
    return { conflict: false as const, version };
  }, `flow:${org}:${id}`);
}
export async function archiveHead(org: string, id: string, archived: boolean) {
  await flowStore().prepare("UPDATE flow_heads SET archived=?,updated_at=? WHERE organization_id=? AND id=?").run(archived ? 1 : 0, new Date().toISOString(), org, id);
}

export async function insertRun(org: string, run: FlowRun) {
  await flowStore().prepare(`INSERT INTO flow_runs(id,organization_id,flow_id,flow_version,status,step_id,path_json,answers_json,contact_id,project_id,call_id,outcome_id,source_json,started_by,started_at,updated_at,finished_at,revision)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id, org, run.flow_id, run.flow_version, run.status, run.step_id, JSON.stringify(run.path), JSON.stringify(run.answers), run.contact_id,
    run.project_id, run.call_id, run.outcome_id, JSON.stringify(run.source), run.started_by, run.started_at, run.updated_at, run.finished_at, run.revision);
}
export async function readRun(org: string, id: string) {
  const row = await flowStore().prepare("SELECT * FROM flow_runs WHERE organization_id=? AND id=?").get(org, id);
  return row ? runOf(row as JsonObject) : null;
}
/** Saves a run's new state if nobody else moved it since `revision`; false when someone did. */
export async function updateRun(org: string, run: FlowRun, revision: number) {
  const result = await flowStore().prepare(`UPDATE flow_runs SET status=?,step_id=?,path_json=?,answers_json=?,contact_id=?,project_id=?,call_id=?,outcome_id=?,updated_at=?,finished_at=?,revision=?
    WHERE organization_id=? AND id=? AND revision=?`).run(run.status, run.step_id, JSON.stringify(run.path), JSON.stringify(run.answers), run.contact_id, run.project_id, run.call_id, run.outcome_id,
    run.updated_at, run.finished_at, revision + 1, org, run.id, revision);
  return Number(result.changes || 0) > 0;
}
export async function listRuns(org: string, filter: { flowId?: string; projectId?: string; limit?: number }) {
  const rows = await flowStore().prepare(`SELECT * FROM flow_runs WHERE organization_id=? AND (?='' OR flow_id=?) AND (?='' OR project_id=?) ORDER BY started_at DESC LIMIT ?`)
    .all(org, filter.flowId || "", filter.flowId || "", filter.projectId || "", filter.projectId || "", Math.min(200, Math.max(1, filter.limit || 50)));
  return rows.map((row) => runOf(row as JsonObject));
}
/** Moves an open run onto a call (a run waiting on a lead is played on the call that reaches them). */
export async function attachRunToCall(org: string, id: string, callId: string) {
  const result = await flowStore().prepare("UPDATE flow_runs SET call_id=?,updated_at=?,revision=revision+1 WHERE organization_id=? AND id=? AND status='open'").run(callId, new Date().toISOString(), org, id);
  return Number(result.changes || 0) > 0;
}
