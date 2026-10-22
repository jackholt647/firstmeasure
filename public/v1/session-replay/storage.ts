import path from "node:path";

import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { env } from "../src/config/env.js";

/**
 * Session replay storage (docs/architecture/session-replay.md). A session is one
 * browser tab of one person in one organization; a page is one load of a document
 * in it; a chunk is a few seconds of that page, stored gzip-compressed exactly as
 * the recorder sent it. Blobs are large strings (stylesheets) stored once per
 * organization under their content address and shared by every session.
 */
type Row = Record<string, unknown>;
export type ReplaySession = {
  id: string;
  organization_id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  started_at: number;
  last_at: number;
  pages: number;
  chunks: number;
  events: number;
  bytes_stored: number;
  bytes_raw: number;
  user_agent: string;
  first_url: string;
  last_url: string;
  recorder_version: string;
  device: Record<string, unknown>;
};
export type ReplayPage = {
  session_id: string;
  page_id: string;
  started_at: number;
  last_at: number;
  url: string;
  title: string;
  chunks: number;
  max_seq: number;
  events: number;
  bytes_stored: number;
  bytes_raw: number;
  meta: Record<string, unknown>;
};
export type ReplayChunk = {
  page_id: string;
  seq: number;
  t_start: number;
  t_end: number;
  events: number;
  bytes_raw: number;
  bytes_stored: number;
  received_at: number;
  data: Buffer;
};

let database: SqlStore | null = null;
let databasePath = "";
const text = (value: unknown) => String(value ?? "").trim();
const num = (value: unknown) => Number(value ?? 0) || 0;
const parse = (value: unknown) => { try { return value ? JSON.parse(String(value)) as Record<string, unknown> : {}; } catch { return {}; } };
const bytes = (value: unknown) => Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);

export async function closeSessionReplayDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return await current?.close();
}

function db() {
  const nextPath = path.resolve(process.cwd(), env.platformStorageRoot, "session-replay.sqlite");
  if (database && databasePath === nextPath) return database;
  void closeSessionReplayDatabase();
  // Raise this whenever initialize gains a table or a column: Postgres runs it again only for a higher version.
  database = openSqlStore({ id: "session_replay", schemaVersion: 1, filename: nextPath, initialize });
  databasePath = nextPath;
  return database;
}

async function initialize(store: SqlStore) {
  const binary = store.isPostgres ? "BYTEA" : "BLOB";
  await store.exec(`
    CREATE TABLE IF NOT EXISTS session_replay_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      user_email TEXT NOT NULL DEFAULT '',
      user_name TEXT NOT NULL DEFAULT '',
      started_at BIGINT NOT NULL,
      last_at BIGINT NOT NULL,
      pages INTEGER NOT NULL DEFAULT 0,
      chunks INTEGER NOT NULL DEFAULT 0,
      events INTEGER NOT NULL DEFAULT 0,
      bytes_stored BIGINT NOT NULL DEFAULT 0,
      bytes_raw BIGINT NOT NULL DEFAULT 0,
      user_agent TEXT NOT NULL DEFAULT '',
      first_url TEXT NOT NULL DEFAULT '',
      last_url TEXT NOT NULL DEFAULT '',
      recorder_version TEXT NOT NULL DEFAULT '',
      device_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_session_replay_sessions_org ON session_replay_sessions (organization_id, last_at);
    CREATE INDEX IF NOT EXISTS idx_session_replay_sessions_last ON session_replay_sessions (last_at);
    CREATE TABLE IF NOT EXISTS session_replay_pages (
      session_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      last_at BIGINT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      chunks INTEGER NOT NULL DEFAULT 0,
      max_seq INTEGER NOT NULL DEFAULT -1,
      events INTEGER NOT NULL DEFAULT 0,
      bytes_stored BIGINT NOT NULL DEFAULT 0,
      bytes_raw BIGINT NOT NULL DEFAULT 0,
      meta_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (session_id, page_id)
    );
    CREATE TABLE IF NOT EXISTS session_replay_chunks (
      session_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      organization_id TEXT NOT NULL,
      received_at BIGINT NOT NULL,
      t_start BIGINT NOT NULL,
      t_end BIGINT NOT NULL,
      events INTEGER NOT NULL DEFAULT 0,
      bytes_raw INTEGER NOT NULL DEFAULT 0,
      bytes_stored INTEGER NOT NULL DEFAULT 0,
      data ${binary} NOT NULL,
      PRIMARY KEY (session_id, page_id, seq)
    );
    CREATE TABLE IF NOT EXISTS session_replay_blobs (
      organization_id TEXT NOT NULL,
      blob_key TEXT NOT NULL,
      bytes_raw INTEGER NOT NULL DEFAULT 0,
      bytes_stored INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      data ${binary} NOT NULL,
      PRIMARY KEY (organization_id, blob_key)
    );
    CREATE TABLE IF NOT EXISTS session_replay_org_settings (
      organization_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
}

function sessionFromRow(row: Row): ReplaySession {
  return {
    id: text(row.id),
    organization_id: text(row.organization_id),
    user_id: text(row.user_id),
    user_email: text(row.user_email),
    user_name: text(row.user_name),
    started_at: num(row.started_at),
    last_at: num(row.last_at),
    pages: num(row.pages),
    chunks: num(row.chunks),
    events: num(row.events),
    bytes_stored: num(row.bytes_stored),
    bytes_raw: num(row.bytes_raw),
    user_agent: text(row.user_agent),
    first_url: text(row.first_url),
    last_url: text(row.last_url),
    recorder_version: text(row.recorder_version),
    device: parse(row.device_json)
  };
}

function pageFromRow(row: Row): ReplayPage {
  return {
    session_id: text(row.session_id),
    page_id: text(row.page_id),
    started_at: num(row.started_at),
    last_at: num(row.last_at),
    url: text(row.url),
    title: text(row.title),
    chunks: num(row.chunks),
    max_seq: num(row.max_seq),
    events: num(row.events),
    bytes_stored: num(row.bytes_stored),
    bytes_raw: num(row.bytes_raw),
    meta: parse(row.meta_json)
  };
}

export type ChunkInput = {
  organization_id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  session_id: string;
  page_id: string;
  seq: number;
  page_started_at: number;
  t_start: number;
  t_end: number;
  events: number;
  bytes_raw: number;
  data: Buffer;
  meta: Record<string, unknown> | null;
};

export const MAX_SESSION_BYTES = 256 * 1024 * 1024;

/** Stores one chunk. Retries of a chunk already stored change nothing. */
export async function storeReplayChunk(input: ChunkInput): Promise<"stored" | "duplicate" | "conflict" | "full"> {
  const store = db();
  return await store.transaction(async (tx) => {
    const existing = await tx.prepare("SELECT * FROM session_replay_sessions WHERE id=?").get(input.session_id);
    if (existing && (text(existing.organization_id) !== input.organization_id || text(existing.user_id) !== input.user_id)) return "conflict";
    if (existing && num(existing.bytes_stored) + input.data.length > MAX_SESSION_BYTES) return "full";
    const inserted = await tx.prepare(`INSERT INTO session_replay_chunks
      (session_id, page_id, seq, organization_id, received_at, t_start, t_end, events, bytes_raw, bytes_stored, data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (session_id, page_id, seq) DO NOTHING`).run(
      input.session_id, input.page_id, input.seq, input.organization_id, Date.now(), Math.round(input.t_start), Math.round(input.t_end),
      input.events, input.bytes_raw, input.data.length, input.data);
    if (!inserted.changes) return "duplicate";
    const meta = input.meta || {};
    const page = await tx.prepare("SELECT * FROM session_replay_pages WHERE session_id=? AND page_id=?").get(input.session_id, input.page_id);
    if (page) {
      await tx.prepare(`UPDATE session_replay_pages SET last_at=?, chunks=?, max_seq=?, events=?, bytes_stored=?, bytes_raw=?
        ${input.meta ? ", url=?, title=?, meta_json=?" : ""} WHERE session_id=? AND page_id=?`).run(
        Math.max(num(page.last_at), Math.round(input.t_end)), num(page.chunks) + 1, Math.max(num(page.max_seq), input.seq),
        num(page.events) + input.events, num(page.bytes_stored) + input.data.length, num(page.bytes_raw) + input.bytes_raw,
        ...(input.meta ? [text(meta.url).slice(0, 2000), text(meta.title).slice(0, 500), JSON.stringify(meta)] : []),
        input.session_id, input.page_id);
    } else {
      await tx.prepare(`INSERT INTO session_replay_pages
        (session_id, page_id, organization_id, started_at, last_at, url, title, chunks, max_seq, events, bytes_stored, bytes_raw, meta_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.session_id, input.page_id, input.organization_id, Math.round(input.page_started_at || input.t_start), Math.round(input.t_end),
        text(meta.url).slice(0, 2000), text(meta.title).slice(0, 500), 1, input.seq, input.events, input.data.length, input.bytes_raw, JSON.stringify(meta));
    }
    const pageCount = num((await tx.prepare("SELECT COUNT(*) AS n FROM session_replay_pages WHERE session_id=?").get(input.session_id))?.n);
    const url = text(meta.url).slice(0, 2000);
    if (existing) {
      await tx.prepare(`UPDATE session_replay_sessions SET started_at=?, last_at=?, pages=?, chunks=?, events=?, bytes_stored=?, bytes_raw=?, last_url=?
        WHERE id=?`).run(
        Math.min(num(existing.started_at), Math.round(input.t_start)), Math.max(num(existing.last_at), Math.round(input.t_end)), pageCount,
        num(existing.chunks) + 1, num(existing.events) + input.events, num(existing.bytes_stored) + input.data.length,
        num(existing.bytes_raw) + input.bytes_raw, url || text(existing.last_url), input.session_id);
    } else {
      const device = input.meta ? { ...meta } : {};
      delete (device as Record<string, unknown>).title;
      await tx.prepare(`INSERT INTO session_replay_sessions
        (id, organization_id, user_id, user_email, user_name, started_at, last_at, pages, chunks, events, bytes_stored, bytes_raw,
         user_agent, first_url, last_url, recorder_version, device_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.session_id, input.organization_id, input.user_id, input.user_email.slice(0, 320), input.user_name.slice(0, 200),
        Math.round(input.t_start), Math.round(input.t_end), pageCount, 1, input.events, input.data.length, input.bytes_raw,
        text(meta.user_agent).slice(0, 500), url, url, text(meta.recorder).slice(0, 40), JSON.stringify(device));
    }
    return "stored";
  }, input.session_id);
}

export async function missingReplayBlobs(organizationId: string, keys: string[]) {
  if (!keys.length) return [];
  const rows = await db().prepare(`SELECT blob_key FROM session_replay_blobs WHERE organization_id=? AND blob_key IN (${keys.map(() => "?").join(",")})`)
    .all(organizationId, ...keys);
  const have = new Set(rows.map((row) => text(row.blob_key)));
  return keys.filter((key) => !have.has(key));
}

export async function storeReplayBlob(organizationId: string, key: string, rawBytes: number, data: Buffer) {
  const result = await db().prepare(`INSERT INTO session_replay_blobs (organization_id, blob_key, bytes_raw, bytes_stored, created_at, data)
    VALUES (?,?,?,?,?,?) ON CONFLICT (organization_id, blob_key) DO NOTHING`).run(organizationId, key, rawBytes, data.length, Date.now(), data);
  return result.changes > 0;
}

export async function readReplayBlobs(organizationId: string, keys: string[]) {
  if (!keys.length) return new Map<string, Buffer>();
  const rows = await db().prepare(`SELECT blob_key, data FROM session_replay_blobs WHERE organization_id=? AND blob_key IN (${keys.map(() => "?").join(",")})`)
    .all(organizationId, ...keys);
  return new Map(rows.map((row) => [text(row.blob_key), bytes(row.data)]));
}

export async function listReplaySessions(options: { organizationId?: string; before?: number; limit?: number; userQuery?: string }) {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (options.organizationId) { where.push("organization_id=?"); values.push(options.organizationId); }
  if (options.before) { where.push("last_at<?"); values.push(options.before); }
  if (options.userQuery) { where.push("(LOWER(user_email) LIKE ? OR LOWER(user_name) LIKE ?)"); const like = `%${options.userQuery.toLowerCase()}%`; values.push(like, like); }
  const limit = Math.max(1, Math.min(200, options.limit || 50));
  const rows = await db().prepare(`SELECT * FROM session_replay_sessions ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY last_at DESC LIMIT ${limit}`).all(...values);
  return rows.map(sessionFromRow);
}

export async function readReplaySession(sessionId: string) {
  const row = await db().prepare("SELECT * FROM session_replay_sessions WHERE id=?").get(sessionId);
  if (!row) return null;
  const pages = await db().prepare("SELECT * FROM session_replay_pages WHERE session_id=? ORDER BY started_at, page_id").all(sessionId);
  return { session: sessionFromRow(row), pages: pages.map(pageFromRow) };
}

export async function readReplayChunks(sessionId: string, pageId: string, afterSeq: number, limit: number) {
  const rows = await db().prepare(`SELECT page_id, seq, t_start, t_end, events, bytes_raw, bytes_stored, received_at, data FROM session_replay_chunks
    WHERE session_id=? AND page_id=? AND seq>? ORDER BY seq LIMIT ${Math.max(1, Math.min(500, limit))}`).all(sessionId, pageId, afterSeq);
  return rows.map((row): ReplayChunk => ({
    page_id: text(row.page_id), seq: num(row.seq), t_start: num(row.t_start), t_end: num(row.t_end), events: num(row.events),
    bytes_raw: num(row.bytes_raw), bytes_stored: num(row.bytes_stored), received_at: num(row.received_at), data: bytes(row.data)
  }));
}

/** Per-chunk sizes for a session, for the growth chart (no chunk bodies). */
export async function readReplayChunkSizes(sessionId: string) {
  const rows = await db().prepare(`SELECT page_id, seq, t_start, t_end, events, bytes_raw, bytes_stored FROM session_replay_chunks
    WHERE session_id=? ORDER BY t_start, page_id, seq`).all(sessionId);
  return rows.map((row) => ({ page_id: text(row.page_id), seq: num(row.seq), t_start: num(row.t_start), t_end: num(row.t_end),
    events: num(row.events), bytes_raw: num(row.bytes_raw), bytes_stored: num(row.bytes_stored) }));
}

export async function deleteReplaySession(sessionId: string) {
  return await db().transaction(async (tx) => {
    await tx.prepare("DELETE FROM session_replay_chunks WHERE session_id=?").run(sessionId);
    await tx.prepare("DELETE FROM session_replay_pages WHERE session_id=?").run(sessionId);
    const result = await tx.prepare("DELETE FROM session_replay_sessions WHERE id=?").run(sessionId);
    return result.changes > 0;
  }, sessionId);
}

export async function replayStorageTotals() {
  const sessions = await db().prepare(`SELECT organization_id, COUNT(*) AS sessions, SUM(bytes_stored) AS bytes_stored, SUM(bytes_raw) AS bytes_raw,
    SUM(chunks) AS chunks, SUM(events) AS events, SUM(last_at - started_at) AS active_ms, MAX(last_at) AS last_at
    FROM session_replay_sessions GROUP BY organization_id`).all();
  const blobs = await db().prepare(`SELECT organization_id, COUNT(*) AS blobs, SUM(bytes_stored) AS bytes_stored, SUM(bytes_raw) AS bytes_raw
    FROM session_replay_blobs GROUP BY organization_id`).all();
  const blobByOrg = new Map(blobs.map((row) => [text(row.organization_id), row]));
  return sessions.map((row) => {
    const blob = blobByOrg.get(text(row.organization_id));
    return {
      organization_id: text(row.organization_id),
      sessions: num(row.sessions),
      bytes_stored: num(row.bytes_stored),
      bytes_raw: num(row.bytes_raw),
      chunks: num(row.chunks),
      events: num(row.events),
      active_ms: num(row.active_ms),
      last_at: num(row.last_at),
      blobs: num(blob?.blobs),
      blob_bytes_stored: num(blob?.bytes_stored),
      blob_bytes_raw: num(blob?.bytes_raw)
    };
  });
}

export async function recordReplaySetting(organizationId: string, enabled: boolean, updatedBy: string) {
  await db().prepare(`INSERT INTO session_replay_org_settings (organization_id, enabled, updated_by, updated_at) VALUES (?,?,?,?)
    ON CONFLICT (organization_id) DO UPDATE SET enabled=excluded.enabled, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .run(organizationId, enabled ? 1 : 0, updatedBy, new Date().toISOString());
}

export async function listReplaySettings() {
  const rows = await db().prepare("SELECT * FROM session_replay_org_settings ORDER BY updated_at DESC").all();
  return rows.map((row) => ({ organization_id: text(row.organization_id), enabled: num(row.enabled) === 1, updated_by: text(row.updated_by), updated_at: text(row.updated_at) }));
}
