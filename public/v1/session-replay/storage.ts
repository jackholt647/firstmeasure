import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { ensureSqlColumn, openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { env } from "../src/config/env.js";

/**
 * Session replay storage (docs/architecture/session-replay.md). A session is one
 * browser tab of one person in one organization; a page is one load of a document
 * in it; a chunk is a few seconds of that page, stored gzip-compressed exactly as
 * the recorder sent it. Blobs are large strings (stylesheets) stored once per
 * organization under their content address and shared by every session.
 *
 * Archives (session-replay/archive.ts) re-pack a finished session into one row; its chunk
 * rows stay as an index with an empty body, and vocabulary versions hold what archives share.
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
  /** When the session was archived (0 while it is live) and what its archive costs. */
  archived_at: number;
  archive_bytes: number;
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
  database = openSqlStore({ id: "session_replay", schemaVersion: 2, filename: nextPath, initialize });
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
    CREATE TABLE IF NOT EXISTS session_replay_archives (
      session_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      format INTEGER NOT NULL,
      platform_generation INTEGER NOT NULL DEFAULT 0,
      platform_version INTEGER NOT NULL DEFAULT 0,
      org_generation INTEGER NOT NULL DEFAULT 0,
      org_version INTEGER NOT NULL DEFAULT 0,
      pages INTEGER NOT NULL DEFAULT 0,
      pages_verbatim INTEGER NOT NULL DEFAULT 0,
      chunks INTEGER NOT NULL DEFAULT 0,
      bytes_live BIGINT NOT NULL DEFAULT 0,
      bytes_json BIGINT NOT NULL DEFAULT 0,
      bytes_archive BIGINT NOT NULL DEFAULT 0,
      json_sha256 TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL,
      data ${binary} NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_replay_archives_org ON session_replay_archives (organization_id, org_generation, org_version);
    CREATE INDEX IF NOT EXISTS idx_session_replay_archives_platform ON session_replay_archives (platform_generation, platform_version);
    CREATE TABLE IF NOT EXISTS session_replay_vocab_versions (
      scope TEXT NOT NULL,
      generation INTEGER NOT NULL,
      version INTEGER NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      tokens_added INTEGER NOT NULL DEFAULT 0,
      token_bytes INTEGER NOT NULL DEFAULT 0,
      dictionary_version INTEGER NOT NULL DEFAULT 0,
      dictionary_bytes INTEGER NOT NULL DEFAULT 0,
      dictionary_sha256 TEXT NOT NULL DEFAULT '',
      platform_generation INTEGER NOT NULL DEFAULT 0,
      platform_version INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      tokens ${binary} NOT NULL,
      dictionary ${binary} NOT NULL,
      PRIMARY KEY (scope, generation, version)
    );
    CREATE TABLE IF NOT EXISTS session_replay_string_counts (
      organization_id TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      sessions INTEGER NOT NULL DEFAULT 0,
      last_at BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, text_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_session_replay_string_counts_hash ON session_replay_string_counts (text_hash);
    CREATE TABLE IF NOT EXISTS session_replay_archive_runs (
      id TEXT PRIMARY KEY,
      dry_run INTEGER NOT NULL DEFAULT 0,
      started_at BIGINT NOT NULL,
      finished_at BIGINT NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      bytes_live BIGINT NOT NULL DEFAULT 0,
      bytes_archive BIGINT NOT NULL DEFAULT 0,
      report_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS session_replay_archive_lock (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL DEFAULT '',
      until_at BIGINT NOT NULL DEFAULT 0
    );
  `);
  await ensureSqlColumn(store, "session_replay_sessions", "archived_at", "BIGINT NOT NULL DEFAULT 0");
  await ensureSqlColumn(store, "session_replay_sessions", "archive_bytes", "BIGINT NOT NULL DEFAULT 0");
  await ensureSqlColumn(store, "session_replay_chunks", "archived", "INTEGER NOT NULL DEFAULT 0");
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
    device: parse(row.device_json),
    archived_at: num(row.archived_at),
    archive_bytes: num(row.archive_bytes)
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

/** Stores one chunk. Retries of a chunk already stored change nothing; an archived session takes no more. */
export async function storeReplayChunk(input: ChunkInput): Promise<"stored" | "duplicate" | "conflict" | "full" | "archived"> {
  const store = db();
  return await store.transaction(async (tx) => {
    const existing = await tx.prepare("SELECT * FROM session_replay_sessions WHERE id=?").get(input.session_id);
    if (existing && (text(existing.organization_id) !== input.organization_id || text(existing.user_id) !== input.user_id)) return "conflict";
    if (existing && num(existing.archived_at) > 0) return "archived";
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

/** A page's chunks as the recorder sent them (gzip JSON). Archived chunks are restored from the session's archive. */
export async function readReplayChunks(sessionId: string, pageId: string, afterSeq: number, limit: number) {
  const rows = await db().prepare(`SELECT page_id, seq, t_start, t_end, events, bytes_raw, bytes_stored, received_at, archived, data FROM session_replay_chunks
    WHERE session_id=? AND page_id=? AND seq>? ORDER BY seq LIMIT ${Math.max(1, Math.min(500, limit))}`).all(sessionId, pageId, afterSeq);
  const chunks = rows.map((row): ReplayChunk => ({
    page_id: text(row.page_id), seq: num(row.seq), t_start: num(row.t_start), t_end: num(row.t_end), events: num(row.events),
    bytes_raw: num(row.bytes_raw), bytes_stored: num(row.bytes_stored), received_at: num(row.received_at), data: bytes(row.data)
  }));
  if (!rows.some((row) => num(row.archived) === 1)) return chunks;
  const { readArchivedPageChunks } = await import("./archive.js");
  const restored = await readArchivedPageChunks(sessionId, pageId);
  return chunks.map((chunk) => {
    const json = restored.get(chunk.seq);
    if (json === undefined) throw new Error(`Session replay archive ${sessionId} has no chunk ${pageId}/${chunk.seq}.`);
    return { ...chunk, data: gzipSync(Buffer.from(json, "utf8")) };
  });
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
    await tx.prepare("DELETE FROM session_replay_archives WHERE session_id=?").run(sessionId);
    await tx.prepare("DELETE FROM session_replay_chunks WHERE session_id=?").run(sessionId);
    await tx.prepare("DELETE FROM session_replay_pages WHERE session_id=?").run(sessionId);
    const result = await tx.prepare("DELETE FROM session_replay_sessions WHERE id=?").run(sessionId);
    return result.changes > 0;
  }, sessionId);
}

/**
 * Bytes per organization. `bytes_stored` is what every session cost as recorded (gzip chunks);
 * `archived_*` say how many sessions were re-packed, what they cost live and what they cost now,
 * and `vocabulary_bytes` is the organization's own vocabulary (tokens and dictionaries).
 */
export async function replayStorageTotals() {
  const sessions = await db().prepare(`SELECT organization_id, COUNT(*) AS sessions, SUM(bytes_stored) AS bytes_stored, SUM(bytes_raw) AS bytes_raw,
    SUM(chunks) AS chunks, SUM(events) AS events, SUM(last_at - started_at) AS active_ms, MAX(last_at) AS last_at,
    SUM(CASE WHEN archived_at > 0 THEN 1 ELSE 0 END) AS archived_sessions,
    SUM(CASE WHEN archived_at > 0 THEN bytes_stored ELSE 0 END) AS archived_bytes_live,
    SUM(CASE WHEN archived_at > 0 THEN archive_bytes ELSE 0 END) AS archived_bytes
    FROM session_replay_sessions GROUP BY organization_id`).all();
  const blobs = await db().prepare(`SELECT organization_id, COUNT(*) AS blobs, SUM(bytes_stored) AS bytes_stored, SUM(bytes_raw) AS bytes_raw
    FROM session_replay_blobs GROUP BY organization_id`).all();
  const vocabularies = await db().prepare(`SELECT scope, COUNT(*) AS versions, SUM(LENGTH(tokens) + LENGTH(dictionary)) AS bytes
    FROM session_replay_vocab_versions GROUP BY scope`).all();
  const blobByOrg = new Map(blobs.map((row) => [text(row.organization_id), row]));
  const vocabularyByScope = new Map(vocabularies.map((row) => [text(row.scope), row]));
  return sessions.map((row) => {
    const blob = blobByOrg.get(text(row.organization_id));
    const vocabulary = vocabularyByScope.get(text(row.organization_id));
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
      blob_bytes_raw: num(blob?.bytes_raw),
      archived_sessions: num(row.archived_sessions),
      archived_bytes_live: num(row.archived_bytes_live),
      archived_bytes: num(row.archived_bytes),
      vocabulary_versions: num(vocabulary?.versions),
      vocabulary_bytes: num(vocabulary?.bytes)
    };
  });
}

/** The platform-wide vocabulary's stored size (shared by every organization's archives). */
export async function platformVocabularyTotals() {
  const row = await db().prepare(`SELECT COUNT(*) AS versions, SUM(LENGTH(tokens) + LENGTH(dictionary)) AS bytes, MAX(token_count) AS tokens
    FROM session_replay_vocab_versions WHERE scope=?`).get(PLATFORM_SCOPE);
  return { versions: num(row?.versions), bytes: num(row?.bytes), tokens: num(row?.tokens) };
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

// ---------------------------------------------------------------------------
// Archives and vocabularies (session-replay/archive.ts)
// ---------------------------------------------------------------------------

/** The scope of the platform-wide vocabulary; an organization's vocabulary uses its organization id. */
export const PLATFORM_SCOPE = "platform";

export type VocabVersion = {
  scope: string;
  generation: number;
  version: number;
  token_count: number;
  tokens_added: number;
  token_bytes: number;
  /** The version whose dictionary this one uses (itself when it built one; 0 for none). */
  dictionary_version: number;
  dictionary_bytes: number;
  dictionary_sha256: string;
  platform_generation: number;
  platform_version: number;
  sessions: number;
  created_at: number;
};

const VOCAB_COLUMNS = `scope, generation, version, token_count, tokens_added, token_bytes, dictionary_version, dictionary_bytes, dictionary_sha256,
  platform_generation, platform_version, sessions, created_at`;

function vocabFromRow(row: Row): VocabVersion {
  return {
    scope: text(row.scope), generation: num(row.generation), version: num(row.version), token_count: num(row.token_count),
    tokens_added: num(row.tokens_added), token_bytes: num(row.token_bytes), dictionary_version: num(row.dictionary_version), dictionary_bytes: num(row.dictionary_bytes),
    dictionary_sha256: text(row.dictionary_sha256), platform_generation: num(row.platform_generation),
    platform_version: num(row.platform_version), sessions: num(row.sessions), created_at: num(row.created_at)
  };
}

/** The newest version of a scope's newest generation. */
export async function latestVocabVersion(scope: string) {
  const row = await db().prepare(`SELECT ${VOCAB_COLUMNS} FROM session_replay_vocab_versions WHERE scope=?
    ORDER BY generation DESC, version DESC LIMIT 1`).get(scope);
  return row ? vocabFromRow(row) : null;
}

export async function readVocabVersion(scope: string, generation: number, version: number) {
  const row = await db().prepare(`SELECT ${VOCAB_COLUMNS} FROM session_replay_vocab_versions WHERE scope=? AND generation=? AND version=?`)
    .get(scope, generation, version);
  return row ? vocabFromRow(row) : null;
}

/** The token blobs of versions 1..version of a generation, oldest first (a version adds to the ones before it). */
export async function readVocabTokenBlobs(scope: string, generation: number, version: number) {
  const rows = await db().prepare(`SELECT version, tokens FROM session_replay_vocab_versions WHERE scope=? AND generation=? AND version<=?
    ORDER BY version`).all(scope, generation, version);
  return rows.map((row) => ({ version: num(row.version), tokens: bytes(row.tokens) }));
}

export async function readVocabDictionary(scope: string, generation: number, version: number) {
  const row = await db().prepare("SELECT dictionary FROM session_replay_vocab_versions WHERE scope=? AND generation=? AND version=?")
    .get(scope, generation, version);
  return row ? bytes(row.dictionary) : null;
}

/** Adds a version. False when that version already exists (another run made it first). */
export async function insertVocabVersion(row: VocabVersion & { tokens: Buffer; dictionary: Buffer }) {
  const result = await db().prepare(`INSERT INTO session_replay_vocab_versions (${VOCAB_COLUMNS}, tokens, dictionary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (scope, generation, version) DO NOTHING`).run(
    row.scope, row.generation, row.version, row.token_count, row.tokens_added, row.token_bytes, row.dictionary_version, row.dictionary_bytes, row.dictionary_sha256,
    row.platform_generation, row.platform_version, row.sessions, row.created_at, row.tokens, row.dictionary);
  return result.changes > 0;
}

export async function listVocabVersions(scope?: string) {
  const rows = await db().prepare(`SELECT ${VOCAB_COLUMNS}, LENGTH(tokens) AS tokens_stored, LENGTH(dictionary) AS dictionary_stored
    FROM session_replay_vocab_versions ${scope ? "WHERE scope=?" : ""} ORDER BY scope, generation, version`).all(...(scope ? [scope] : []));
  return rows.map((row) => ({ ...vocabFromRow(row), tokens_stored: num(row.tokens_stored), dictionary_stored: num(row.dictionary_stored) }));
}

const COUNT_BATCH = 400;
function batches<T>(list: T[], size = COUNT_BATCH) {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** In how many sessions of the organization each string (by hash) has been seen. */
export async function readStringCounts(organizationId: string, hashes: string[]) {
  const counts = new Map<string, number>();
  for (const part of batches(hashes)) {
    const rows = await db().prepare(`SELECT text_hash, sessions FROM session_replay_string_counts WHERE organization_id=?
      AND text_hash IN (${part.map(() => "?").join(",")})`).all(organizationId, ...part);
    for (const row of rows) counts.set(text(row.text_hash), num(row.sessions));
  }
  return counts;
}

/** Counts one more session for each string. */
export async function addStringCounts(organizationId: string, hashes: string[], at: number) {
  for (const part of batches(hashes)) {
    await db().prepare(`INSERT INTO session_replay_string_counts (organization_id, text_hash, sessions, last_at)
      VALUES ${part.map(() => "(?,?,1,?)").join(",")}
      ON CONFLICT (organization_id, text_hash) DO UPDATE SET sessions = session_replay_string_counts.sessions + 1, last_at = excluded.last_at`)
      .run(...part.flatMap((hash) => [organizationId, hash, at]));
  }
}

/** In how many organizations each string (by hash) has been seen. */
export async function organizationsPerString(hashes: string[]) {
  const counts = new Map<string, number>();
  for (const part of batches(hashes)) {
    const rows = await db().prepare(`SELECT text_hash, COUNT(*) AS orgs FROM session_replay_string_counts
      WHERE text_hash IN (${part.map(() => "?").join(",")}) GROUP BY text_hash`).all(...part);
    for (const row of rows) counts.set(text(row.text_hash), num(row.orgs));
  }
  return counts;
}

/**
 * Keeps an organization's string statistics bounded: strings seen once and not since `staleBefore`
 * are forgotten, and beyond `keep` rows the least seen go first.
 */
export async function pruneStringCounts(organizationId: string, staleBefore: number, keep: number) {
  const stale = await db().prepare("DELETE FROM session_replay_string_counts WHERE organization_id=? AND sessions<=1 AND last_at<?")
    .run(organizationId, staleBefore);
  const total = num((await db().prepare("SELECT COUNT(*) AS n FROM session_replay_string_counts WHERE organization_id=?").get(organizationId))?.n);
  let trimmed = 0;
  if (total > keep) {
    const cut = await db().prepare(`SELECT sessions, last_at FROM session_replay_string_counts WHERE organization_id=?
      ORDER BY sessions DESC, last_at DESC LIMIT 1 OFFSET ${Math.floor(keep)}`).get(organizationId);
    if (cut) {
      trimmed = (await db().prepare(`DELETE FROM session_replay_string_counts WHERE organization_id=?
        AND (sessions < ? OR (sessions = ? AND last_at <= ?))`).run(organizationId, num(cut.sessions), num(cut.sessions), num(cut.last_at))).changes;
    }
  }
  return stale.changes + trimmed;
}

/** Live sessions with no chunk received since `before`, oldest first. */
export async function listArchiveCandidates(options: { before: number; limit: number; sessionIds?: string[]; organizationId?: string }) {
  const where = ["s.archived_at=0", "s.last_at<?"];
  const values: (string | number)[] = [options.before];
  if (options.organizationId) { where.push("s.organization_id=?"); values.push(options.organizationId); }
  if (options.sessionIds?.length) { where.push(`s.id IN (${options.sessionIds.map(() => "?").join(",")})`); values.push(...options.sessionIds); }
  const rows = await db().prepare(`SELECT s.* FROM session_replay_sessions s WHERE ${where.join(" AND ")}
    AND NOT EXISTS (SELECT 1 FROM session_replay_chunks c WHERE c.session_id=s.id AND c.received_at>=?)
    ORDER BY s.started_at, s.id LIMIT ${Math.max(1, Math.min(5000, Math.floor(options.limit)))}`).all(...values, options.before);
  return rows.map(sessionFromRow);
}

export type SourceChunkRow = { seq: number; json: string; bytes_stored: number; received_at: number; t_end: number };
export type SourcePage = { page_id: string; url: string; started_at: number; chunks: SourceChunkRow[] };

/** A live session's chunk JSON by page, in page order, with what the archive must find unchanged before it commits. */
export async function readReplaySource(sessionId: string) {
  const pageRows = await db().prepare("SELECT page_id, url, started_at FROM session_replay_pages WHERE session_id=? ORDER BY started_at, page_id").all(sessionId);
  const rows = await db().prepare(`SELECT page_id, seq, received_at, t_end, bytes_stored, archived, data FROM session_replay_chunks
    WHERE session_id=? ORDER BY page_id, seq`).all(sessionId);
  const byPage = new Map<string, SourceChunkRow[]>(pageRows.map((row) => [text(row.page_id), []]));
  const pageInfo = new Map(pageRows.map((row) => [text(row.page_id), { url: text(row.url), started_at: num(row.started_at) }]));
  let maxReceived = 0, bytesLive = 0;
  for (const row of rows) {
    if (num(row.archived) === 1) throw new Error(`Session replay ${sessionId} is already archived.`);
    const pageId = text(row.page_id);
    if (!byPage.has(pageId)) byPage.set(pageId, []);
    byPage.get(pageId)!.push({ seq: num(row.seq), json: gunzipSync(bytes(row.data)).toString("utf8"), bytes_stored: num(row.bytes_stored),
      received_at: num(row.received_at), t_end: num(row.t_end) });
    maxReceived = Math.max(maxReceived, num(row.received_at));
    bytesLive += num(row.bytes_stored);
  }
  const pages: SourcePage[] = [...byPage].filter(([, chunks]) => chunks.length).map(([page_id, chunks]) => ({
    page_id, url: pageInfo.get(page_id)?.url || "", started_at: pageInfo.get(page_id)?.started_at || 0, chunks
  }));
  return { pages, chunks: rows.length, maxReceived, bytesLive };
}

export type ArchiveRecord = {
  session_id: string;
  organization_id: string;
  format: number;
  platform_generation: number;
  platform_version: number;
  org_generation: number;
  org_version: number;
  pages: number;
  pages_verbatim: number;
  chunks: number;
  bytes_live: number;
  bytes_json: number;
  bytes_archive: number;
  json_sha256: string;
  created_at: number;
};

function archiveFromRow(row: Row): ArchiveRecord {
  return {
    session_id: text(row.session_id), organization_id: text(row.organization_id), format: num(row.format),
    platform_generation: num(row.platform_generation), platform_version: num(row.platform_version),
    org_generation: num(row.org_generation), org_version: num(row.org_version), pages: num(row.pages), pages_verbatim: num(row.pages_verbatim),
    chunks: num(row.chunks), bytes_live: num(row.bytes_live), bytes_json: num(row.bytes_json), bytes_archive: num(row.bytes_archive),
    json_sha256: text(row.json_sha256), created_at: num(row.created_at)
  };
}

/**
 * Writes a verified archive and empties the session's chunk bodies in one transaction. Returns "changed"
 * (and writes nothing) when a chunk arrived or the session was archived or deleted since it was read.
 */
export async function commitReplayArchive(input: ArchiveRecord & { data: Buffer; expect_chunks: number; expect_max_received: number }) {
  return await db().transaction(async (tx) => {
    const session = await tx.prepare("SELECT archived_at FROM session_replay_sessions WHERE id=?").get(input.session_id);
    if (!session || num(session.archived_at) > 0) return "changed" as const;
    const live = await tx.prepare("SELECT COUNT(*) AS n, MAX(received_at) AS latest FROM session_replay_chunks WHERE session_id=? AND archived=0")
      .get(input.session_id);
    if (num(live?.n) !== input.expect_chunks || num(live?.latest) !== input.expect_max_received) return "changed" as const;
    await tx.prepare(`INSERT INTO session_replay_archives (session_id, organization_id, format, platform_generation, platform_version, org_generation,
      org_version, pages, pages_verbatim, chunks, bytes_live, bytes_json, bytes_archive, json_sha256, created_at, data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.session_id, input.organization_id, input.format, input.platform_generation, input.platform_version, input.org_generation,
      input.org_version, input.pages, input.pages_verbatim, input.chunks, input.bytes_live, input.bytes_json, input.bytes_archive,
      input.json_sha256, input.created_at, input.data);
    await tx.prepare("UPDATE session_replay_chunks SET data=?, archived=1 WHERE session_id=?").run(Buffer.alloc(0), input.session_id);
    await tx.prepare("UPDATE session_replay_sessions SET archived_at=?, archive_bytes=? WHERE id=?").run(input.created_at, input.data.length, input.session_id);
    return "archived" as const;
  }, input.session_id);
}

export async function readReplayArchive(sessionId: string) {
  const row = await db().prepare("SELECT * FROM session_replay_archives WHERE session_id=?").get(sessionId);
  return row ? { ...archiveFromRow(row), data: bytes(row.data) } : null;
}

/** Archives of an organization, newest first, without their bodies unless asked. */
export async function listReplayArchives(organizationId: string, limit: number) {
  const rows = await db().prepare(`SELECT a.*, s.started_at AS session_started_at FROM session_replay_archives a
    JOIN session_replay_sessions s ON s.id=a.session_id WHERE a.organization_id=? ORDER BY s.started_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`)
    .all(organizationId);
  return rows.map((row) => ({ ...archiveFromRow(row), started_at: num(row.session_started_at) }));
}

export async function recordArchiveRun(run: { id: string; dry_run: boolean; started_at: number; finished_at: number; sessions: number; bytes_live: number; bytes_archive: number; report: unknown }) {
  await db().prepare(`INSERT INTO session_replay_archive_runs (id, dry_run, started_at, finished_at, sessions, bytes_live, bytes_archive, report_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(run.id, run.dry_run ? 1 : 0, run.started_at, run.finished_at, run.sessions, run.bytes_live, run.bytes_archive,
    JSON.stringify(run.report));
}

export async function listArchiveRuns(limit: number) {
  const rows = await db().prepare(`SELECT * FROM session_replay_archive_runs ORDER BY started_at DESC LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`).all();
  return rows.map((row) => ({ id: text(row.id), dry_run: num(row.dry_run) === 1, started_at: num(row.started_at), finished_at: num(row.finished_at),
    sessions: num(row.sessions), bytes_live: num(row.bytes_live), bytes_archive: num(row.bytes_archive), report: parse(row.report_json) }));
}

/** One archive run writes at a time (the platform worker's job and an administrator's run both take this lease). */
export async function acquireArchiveLock(owner: string, leaseMs: number) {
  const now = Date.now();
  await db().prepare("INSERT INTO session_replay_archive_lock (id, owner, until_at) VALUES ('archive', '', 0) ON CONFLICT (id) DO NOTHING").run();
  const result = await db().prepare("UPDATE session_replay_archive_lock SET owner=?, until_at=? WHERE id='archive' AND (until_at<? OR owner=?)")
    .run(owner, now + leaseMs, now, owner);
  return result.changes === 1;
}

export async function releaseArchiveLock(owner: string) {
  await db().prepare("UPDATE session_replay_archive_lock SET owner='', until_at=0 WHERE id='archive' AND owner=?").run(owner);
}

/**
 * Everything session replay keeps for an organization: sessions, archives, blobs, its vocabulary and its
 * string statistics. The platform vocabulary holds only strings seen in several organizations and is untouched.
 */
export async function deleteReplayOrganization(organizationId: string) {
  return await db().transaction(async (tx) => {
    const sessions = (await tx.prepare("DELETE FROM session_replay_sessions WHERE organization_id=?").run(organizationId)).changes;
    for (const table of ["session_replay_archives", "session_replay_chunks", "session_replay_pages", "session_replay_blobs", "session_replay_string_counts", "session_replay_org_settings"]) {
      await tx.prepare(`DELETE FROM ${table} WHERE organization_id=?`).run(organizationId);
    }
    await tx.prepare("DELETE FROM session_replay_vocab_versions WHERE scope=?").run(organizationId);
    return { sessions };
  }, organizationId);
}
