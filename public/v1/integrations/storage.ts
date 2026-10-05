import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { conflict, notFound } from "../platform/errors.js";
import type { Obj } from "./contracts.js";
let database: SqlStore | undefined;
export const now = () => new Date().toISOString();
export const id = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;
export function db() {
  return (database ??= openSqlStore({
    id: "integrations",
    filename: path.resolve(env.platformStorageRoot, "integrations.sqlite"),
    initialize: async (d) => {
      await d.exec(`CREATE TABLE IF NOT EXISTS integration_objects (organization_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(organization_id,kind,id));
    CREATE INDEX IF NOT EXISTS integration_objects_kind ON integration_objects(kind,organization_id);
    CREATE TABLE IF NOT EXISTS integration_secrets (organization_id TEXT NOT NULL, connection_id TEXT NOT NULL, encrypted_json TEXT NOT NULL, PRIMARY KEY(organization_id,connection_id));
    CREATE TABLE IF NOT EXISTS integration_runs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, connection_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, value_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS integration_runs_connection ON integration_runs(organization_id,connection_id,created_at);
    CREATE TABLE IF NOT EXISTS integration_rows (organization_id TEXT NOT NULL, connection_id TEXT NOT NULL, resource TEXT NOT NULL, generation TEXT NOT NULL, record_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(organization_id,connection_id,resource,generation,record_id));
    CREATE TABLE IF NOT EXISTS integration_changes (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, connection_id TEXT NOT NULL, resource TEXT NOT NULL, value_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS integration_changes_delivery ON integration_changes(delivered_at,created_at);
    CREATE INDEX IF NOT EXISTS integration_changes_source ON integration_changes(organization_id,connection_id,resource,created_at);`);
    },
  }));
}
export async function read(org: string, kind: string, key: string) {
  const r = await db()
    .prepare(
      "SELECT * FROM integration_objects WHERE organization_id=? AND kind=? AND id=?",
    )
    .get(org, kind, key);
  return r
    ? ({
        ...JSON.parse(String(r.value_json)),
        id: String(r.id),
        revision: Number(r.revision),
      } as Obj)
    : null;
}
export async function requireObject(org: string, kind: string, key: string) {
  const r = await read(org, kind, key);
  if (!r)
    throw notFound(
      "integration_missing",
      "This connection resource no longer exists.",
    );
  return r;
}
export async function list(org: string, kind: string) {
  return (
    await db()
      .prepare(
        "SELECT * FROM integration_objects WHERE organization_id=? AND kind=? ORDER BY updated_at DESC",
      )
      .all(org, kind)
  ).map(
    (r) =>
      ({
        ...JSON.parse(String(r.value_json)),
        id: String(r.id),
        revision: Number(r.revision),
      }) as Obj,
  );
}
export async function save(
  org: string,
  kind: string,
  key: string,
  value: Obj,
  expected?: number,
): Promise<Obj> {
  return db().transaction(async () => {
    const prior = await read(org, kind, key);
    if (expected !== undefined && (prior?.revision || 0) !== expected)
      throw conflict(
        "integration_revision",
        "This item changed. Reload before saving.",
      );
    const revision = (prior?.revision || 0) + 1;
    await db()
      .prepare(
        `INSERT INTO integration_objects(organization_id,kind,id,revision,value_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id,kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json,updated_at=excluded.updated_at`,
      )
      .run(org, kind, key, revision, JSON.stringify(value), now());
    return { ...value, id: key, revision };
  }, `${org}:${kind}:${key}`);
}
export async function immutable(
  org: string,
  kind: string,
  key: string,
  value: Obj,
) {
  return db().transaction(async () => {
    const old = await read(org, kind, key);
    return old || save(org, kind, key, value, 0);
  }, `${org}:${kind}:${key}`);
}
export async function claimRun(
  org: string,
  connection: string,
  kind: string,
  key: string,
  value: Obj,
) {
  const time = now();
  return !!(
    await db()
      .prepare(
        "INSERT INTO integration_runs(id,organization_id,connection_id,kind,state,value_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        key,
        org,
        connection,
        kind,
        "running",
        JSON.stringify(value),
        time,
        time,
      )
  ).changes;
}
export async function finishRun(key: string, state: string, value: Obj) {
  await db()
    .prepare(
      "UPDATE integration_runs SET state=?,value_json=?,updated_at=? WHERE id=?",
    )
    .run(state, JSON.stringify(value), now(), key);
}
export async function runs(org: string, connection: string) {
  return (
    await db()
      .prepare(
        "SELECT * FROM integration_runs WHERE organization_id=? AND connection_id=? ORDER BY created_at DESC LIMIT 60",
      )
      .all(org, connection)
  ).map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...JSON.parse(String(r.value_json)),
  }));
}
