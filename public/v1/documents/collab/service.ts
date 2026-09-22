import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../../platform/sql_store.js";
import { env } from "../../src/config/env.js";

/** Shared command revisions and expiring presence; each web process owns only its sockets. */
export type JsonObject = Record<string, unknown>;
export type CollabActor = { id: string; name: string; email: string };
export type CollabPresenceEntry = {
  actor: CollabActor; color: string; cursor: JsonObject | null; selection: JsonObject | null;
  joined_at: string; last_seen: string;
};
export type CollabLogEntry = { revision: number; actor_id: string; commands: unknown[] };
export type AppendCollabCommandsResult =
  | { ok: true; revision: number }
  | { ok: false; stale: true; revision: number; missed: CollabLogEntry[] };

type Connection = {
  id: number; orgId: string; docId: string; actor: CollabActor; revision: number; roster: string;
  write: (chunk: string) => void; close: () => void;
};
const connections = new Map<number, Connection>();
const ownerId = `collab_${process.pid}_${randomUUID()}`;
const COLORS = ["#2563EB", "#DC2626", "#059669", "#D97706", "#7C3AED", "#DB2777", "#0891B2", "#65A30D"];
export const COLLAB_PRESENCE_TTL_MS = 30_000;
let connectionCounter = 0;
let timer: NodeJS.Timeout | null = null;
let polling: Promise<void> | null = null;
let lastHeartbeat = 0;
let database: SqlStore | null = null;
let databasePath = "";
const text = (value: unknown) => String(value ?? "").trim();
const key = (orgId: string, docId: string) => JSON.stringify([orgId, docId]);
function parse<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}
function encode(event: string, payload: unknown) { return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`; }

export function getDocumentsCollabDatabase(): SqlStore {
  const nextPath = path.resolve(process.cwd(), process.env.DOCUMENTS_STORAGE_ROOT ?? "./storage/documents", "documents.sqlite");
  if (database && databasePath === nextPath) return database;
  if (database) throw new Error("Close document collaboration before changing its directory.");
  database = openSqlStore({ id: "document-collaboration", filename: nextPath, initialize: async db => {
    await db.exec(`CREATE TABLE IF NOT EXISTS document_collab_log (
      organization_id TEXT NOT NULL, doc_id TEXT NOT NULL, revision INTEGER NOT NULL,
      actor_id TEXT NOT NULL, actor_json TEXT NOT NULL DEFAULT '{}', commands_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, PRIMARY KEY(organization_id, doc_id, revision));
      CREATE INDEX IF NOT EXISTS document_collab_log_org_idx ON document_collab_log(organization_id, doc_id, revision);
      CREATE TABLE IF NOT EXISTS document_collab_presence (
        organization_id TEXT NOT NULL, doc_id TEXT NOT NULL, actor_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        actor_json TEXT NOT NULL, color TEXT NOT NULL, cursor_json TEXT, selection_json TEXT,
        joined_at TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(organization_id, doc_id, actor_id, owner_id));
      CREATE INDEX IF NOT EXISTS document_collab_presence_expiry ON document_collab_presence(last_seen);`);
    await ensureSqlColumn(db, "document_collab_log", "actor_json", "TEXT NOT NULL DEFAULT '{}'");
  }});
  databasePath = nextPath;
  return database;
}
export async function closeDocumentsCollabDatabase() {
  await database?.close(); database = null; databasePath = "";
}
function presenceView(rows: JsonObject[]): CollabPresenceEntry[] {
  const seen = new Set<string>();
  return rows.filter(row => { const id = text(row.actor_id); if (seen.has(id)) return false; seen.add(id); return true; }).map(row => ({
    actor: parse(row.actor_json, { id: text(row.actor_id), name: "", email: "" }), color: text(row.color),
    cursor: parse(row.cursor_json, null), selection: parse(row.selection_json, null),
    joined_at: text(row.joined_at), last_seen: text(row.last_seen)
  }));
}
async function roster(orgId: string, docId: string) {
  return presenceView(await getDocumentsCollabDatabase().prepare(`SELECT * FROM document_collab_presence
    WHERE organization_id=? AND doc_id=? AND last_seen>? ORDER BY last_seen DESC, actor_id`)
    .all(orgId, docId, new Date(Date.now() - COLLAB_PRESENCE_TTL_MS).toISOString()));
}
async function currentRevision(orgId: string, docId: string) {
  const row = await getDocumentsCollabDatabase().prepare(`SELECT MAX(revision) AS revision FROM document_collab_log
    WHERE organization_id=? AND doc_id=?`).get(orgId, docId);
  return Number(row?.revision || 0);
}
async function touchPresence(orgId: string, docId: string, actor: CollabActor, update: { cursor?: JsonObject | null; selection?: JsonObject | null } = {}) {
  const db = getDocumentsCollabDatabase();
  return (await db.transaction(async () => {
    const entries = await roster(orgId, docId);
    const prior = entries.find(entry => entry.actor.id === actor.id);
    const color = prior?.color || COLORS.find(value => !entries.some(entry => entry.color === value)) || COLORS[entries.length % COLORS.length]!;
    const at = new Date().toISOString();
    const entry: CollabPresenceEntry = { actor, color, cursor: "cursor" in update ? update.cursor ?? null : prior?.cursor ?? null,
      selection: "selection" in update ? update.selection ?? null : prior?.selection ?? null, joined_at: prior?.joined_at || at, last_seen: at };
    await db.prepare(`INSERT INTO document_collab_presence
      (organization_id,doc_id,actor_id,owner_id,actor_json,color,cursor_json,selection_json,joined_at,last_seen)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,doc_id,actor_id,owner_id) DO UPDATE SET
      actor_json=excluded.actor_json,color=excluded.color,cursor_json=excluded.cursor_json,selection_json=excluded.selection_json,last_seen=excluded.last_seen`)
      .run(orgId, docId, actor.id, ownerId, JSON.stringify(actor), color, JSON.stringify(entry.cursor), JSON.stringify(entry.selection), entry.joined_at, at);
    return entry;
  }, key(orgId, docId)));
}
export async function collabHello(orgId: string, docId: string) {
  return { revision: await currentRevision(orgId, docId), presence: await roster(orgId, docId) };
}
export async function listMissedCollabCommands(orgId: string, docId: string, afterRevision: number): Promise<CollabLogEntry[]> {
  const rows = await getDocumentsCollabDatabase().prepare(`SELECT revision,actor_id,commands_json FROM document_collab_log
    WHERE organization_id=? AND doc_id=? AND revision>? ORDER BY revision`).all(orgId, docId, Math.max(0, Math.floor(afterRevision)));
  return rows.map(row => ({ revision: Number(row.revision), actor_id: text(row.actor_id), commands: parse(row.commands_json, []) }));
}
export async function appendCollabCommands(orgId: string, docId: string, actor: CollabActor,
  input: { base_revision: number; commands: unknown[]; actor_cursor?: JsonObject | null }): Promise<AppendCollabCommandsResult> {
  const db = getDocumentsCollabDatabase();
  return (await db.transaction(async () => {
    const revision = await currentRevision(orgId, docId);
    const base = Math.max(0, Math.floor(Number(input.base_revision) || 0));
    if (base !== revision) return { ok: false, stale: true, revision, missed: await listMissedCollabCommands(orgId, docId, base) };
    const presence = await touchPresence(orgId, docId, actor, input.actor_cursor !== undefined ? { cursor: input.actor_cursor } : {});
    await db.prepare(`INSERT INTO document_collab_log(organization_id,doc_id,revision,actor_id,actor_json,commands_json,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(orgId, docId, revision + 1, actor.id, JSON.stringify({ ...actor, color: presence.color }), JSON.stringify(input.commands ?? []), new Date().toISOString());
    // SSE pollers read only committed rows, including the originating process.
    return { ok: true, revision: revision + 1 };
  }, key(orgId, docId)));
}
export async function updateCollabPresence(orgId: string, docId: string, actor: CollabActor, update: { cursor?: JsonObject | null; selection?: JsonObject | null } = {}) {
  await touchPresence(orgId, docId, actor, update);
  return (await roster(orgId, docId));
}
export async function pruneStaleCollabPresence(ttlMs = COLLAB_PRESENCE_TTL_MS) {
  const db = getDocumentsCollabDatabase();
  const at = new Date().toISOString();
  const live = new Map([...connections.values()].map(connection => [JSON.stringify([connection.orgId, connection.docId, connection.actor.id]), connection]));
  for (const connection of live.values()) {
    await db.prepare(`UPDATE document_collab_presence SET last_seen=? WHERE organization_id=? AND doc_id=? AND actor_id=? AND owner_id=?`)
      .run(at, connection.orgId, connection.docId, connection.actor.id, ownerId);
  }
  return (await db.prepare("DELETE FROM document_collab_presence WHERE last_seen<?").run(new Date(Date.now() - ttlMs).toISOString())).changes;
}

/** One batch for all local document sockets; no dedicated SQL connection per stream. */
async function pollConnections() {
  if (!connections.size) return;
  const scopes = new Map<string, { orgId: string; docId: string; revision: number }>();
  for (const connection of connections.values()) {
    const id = key(connection.orgId, connection.docId);
    const prior = scopes.get(id);
    scopes.set(id, { orgId: connection.orgId, docId: connection.docId, revision: Math.min(prior?.revision ?? connection.revision, connection.revision) });
  }
  const watched = [...scopes.values()];
  const db = getDocumentsCollabDatabase();
  const entries = await db.prepare(`WITH watched(organization_id,doc_id,after_revision) AS (VALUES ${watched.map(() => "(?,?,CAST(? AS INTEGER))").join(",")})
    SELECT log.* FROM document_collab_log log JOIN watched w ON w.organization_id=log.organization_id AND w.doc_id=log.doc_id
    WHERE log.revision>w.after_revision ORDER BY log.organization_id,log.doc_id,log.revision LIMIT 1000`)
    .all(...watched.flatMap(scope => [scope.orgId, scope.docId, scope.revision]));
  for (const row of entries) for (const connection of connections.values()) {
    if (connection.orgId !== row.organization_id || connection.docId !== row.doc_id || connection.revision >= Number(row.revision)) continue;
    connection.write(encode("commands", { revision: Number(row.revision), actor: parse(row.actor_json, { id: row.actor_id }), commands: parse(row.commands_json, []) }));
    connection.revision = Number(row.revision);
  }
  const presences = await db.prepare(`WITH watched(organization_id,doc_id) AS (VALUES ${watched.map(() => "(?,?)").join(",")})
    SELECT p.* FROM document_collab_presence p JOIN watched w ON w.organization_id=p.organization_id AND w.doc_id=p.doc_id
    WHERE p.last_seen>? ORDER BY p.last_seen DESC,p.actor_id`).all(...watched.flatMap(scope => [scope.orgId, scope.docId]), new Date(Date.now()-COLLAB_PRESENCE_TTL_MS).toISOString());
  for (const scope of watched) {
    const presence = presenceView(presences.filter(row => row.organization_id === scope.orgId && row.doc_id === scope.docId));
    const signature = JSON.stringify(presence);
    for (const connection of connections.values()) if (connection.orgId === scope.orgId && connection.docId === scope.docId && connection.roster !== signature) {
      connection.write(encode("presence", { presence })); connection.roster = signature;
    }
  }
  if (Date.now() - lastHeartbeat >= 15_000) {
    for (const connection of connections.values()) connection.write(": ping\n\n");
    await pruneStaleCollabPresence(); lastHeartbeat = Date.now();
  }
}
function ensurePolling() {
  if (timer) return;
  timer = setInterval(async () => {
    if (polling) return;
    if (!connections.size) { clearInterval(timer!); timer = null; return; }
    polling = pollConnections().catch(error => {
      console.error("Document collaboration polling failed", error);
      for (const connection of [...connections.values()]) connection.close();
    }).finally(() => { polling = null; });
  }, 1000);
  timer.unref();
}
export async function attachCollabStream(request: FastifyRequest, reply: FastifyReply, options: { orgId: string; docId: string; actor: CollabActor }) {
  const { orgId, docId, actor } = options;
  await touchPresence(orgId, docId, actor);
  const hello = await collabHello(orgId, docId);
  const origin = String(request.headers.origin ?? "");
  const corsHeaders: Record<string, string> = origin && env.corsOrigins.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {};
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", ...corsHeaders });
  request.raw.socket.setTimeout(0); request.raw.socket.setNoDelay(true);
  let closed = false;
  const connection: Connection = {
    id: ++connectionCounter, orgId, docId, actor, revision: hello.revision, roster: JSON.stringify(hello.presence),
    write(chunk) {
      if (closed) return;
      if (reply.raw.writableLength > 1024 * 1024) { connection.close(); return; }
      try { reply.raw.write(chunk); } catch { connection.close(); }
    },
    async close() {
      if (closed) return;
      closed = true; connections.delete(connection.id);
      if (![...connections.values()].some(other => other.orgId === orgId && other.docId === docId && other.actor.id === actor.id)) {
        // Other replicas own their presence rows independently. A failed delete expires by TTL.
        void getDocumentsCollabDatabase().prepare(`DELETE FROM document_collab_presence WHERE organization_id=? AND doc_id=? AND actor_id=? AND owner_id=?`)
          .run(orgId, docId, actor.id, ownerId).catch(() => undefined);
      }
      try { reply.raw.end(); } catch { /* closed socket */ }
    }
  };
  connections.set(connection.id, connection);
  connection.write("retry: 3000\n\n" + encode("hello", hello));
  reply.raw.on("close", () => connection.close());
  ensurePolling();
  return connection;
}
export function collabDiagnostics() {
  const scopes = new Map<string, { organization_id: string; doc_id: string; revision: number; presence: number; connections: number }>();
  for (const connection of connections.values()) {
    const id = key(connection.orgId, connection.docId);
    const scope = scopes.get(id) || { organization_id: connection.orgId, doc_id: connection.docId, revision: 0, presence: 0, connections: 0 };
    scope.connections++; scope.revision = Math.max(scope.revision, connection.revision); scope.presence = parse<unknown[]>(connection.roster, []).length; scopes.set(id, scope);
  }
  return [...scopes.values()];
}
export async function resetCollabForTests() {
  if (timer) { clearInterval(timer); timer = null; }
  for (const connection of [...connections.values()]) connection.close();
  if (polling) await polling;
  if (database) await database.prepare("DELETE FROM document_collab_presence WHERE owner_id=?").run(ownerId);
  await closeDocumentsCollabDatabase();
}
