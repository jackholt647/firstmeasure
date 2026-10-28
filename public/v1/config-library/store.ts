import path from "node:path";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";

/**
 * The platform config library's tables (docs/architecture/config-library.md). One head row per entry (what code
 * reads), every revision ever saved (append-only, never edited), content-addressed assets (images a default uses),
 * coding-agent access keys, each sandbox test organization's starting state, and a single sequence that rises with
 * every write so other processes notice a change with one cheap query. Raise schemaVersion with every table or
 * column change, or Postgres hosts never run it.
 */

let database: SqlStore | undefined;
export function libraryStore() {
  return database ??= openSqlStore({ id: "config-library", filename: path.resolve(env.platformStorageRoot, "config-library.sqlite"), schemaVersion: 1, initialize: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS config_library_heads (
        kind TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, sha256 TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '',
        seq INTEGER NOT NULL,
        PRIMARY KEY (kind, entry_id)
      );
      CREATE INDEX IF NOT EXISTS config_library_heads_seq ON config_library_heads(seq);
      CREATE TABLE IF NOT EXISTS config_library_revisions (
        kind TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, sha256 TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL, action TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', author_kind TEXT NOT NULL DEFAULT 'person',
        note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, seq INTEGER NOT NULL,
        PRIMARY KEY (kind, entry_id, revision)
      );
      CREATE INDEX IF NOT EXISTS config_library_revisions_seq ON config_library_revisions(seq);
      CREATE TABLE IF NOT EXISTS config_library_meta (key TEXT NOT NULL PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS config_library_assets (
        sha256 TEXT NOT NULL PRIMARY KEY, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, file_name TEXT NOT NULL DEFAULT '',
        data_base64 TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config_library_keys (
        id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER NOT NULL DEFAULT 0, revoked_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS config_library_initial_states (
        organization_id TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, captured_at TEXT NOT NULL, captured_by TEXT NOT NULL DEFAULT '',
        restored_at TEXT NOT NULL DEFAULT '', restored_by TEXT NOT NULL DEFAULT '', restores INTEGER NOT NULL DEFAULT 0
      );
    `);
    await db.prepare("INSERT INTO config_library_meta(key,value) VALUES('seq',0) ON CONFLICT(key) DO NOTHING").run();
  } });
}
export async function closeLibraryStore() { const old = database; database = undefined; await old?.close(); }

/** Takes the next sequence number. Call inside a write transaction. */
export async function nextSeq(db: SqlStore) {
  await db.prepare("UPDATE config_library_meta SET value=value+1 WHERE key='seq'").run();
  return Number((await db.prepare("SELECT value FROM config_library_meta WHERE key='seq'").get())?.value || 0);
}
export async function currentSeq() {
  return Number((await libraryStore().prepare("SELECT value FROM config_library_meta WHERE key='seq'").get())?.value || 0);
}
