import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ArtifactSyncRecord = {
  object_key: string;
  source_size: number;
  source_mtime_ms: number;
  source_sha256: string;
  remote_size: number;
  remote_etag: string;
  status: string;
  last_seen_run: string;
  verified_at: string;
};

export type ArtifactSyncRunSummary = {
  discovered: number;
  uploaded: number;
  skipped: number;
  verified: number;
  failed: number;
  orphaned: number;
  sourceBytes: number;
  uploadedBytes: number;
};

export class ArtifactSyncLedger {
  readonly #database: DatabaseSync;
  readonly #targetEnvironment: string;

  constructor(filePath: string, targetEnvironment: string) {
    const resolved = path.resolve(filePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.#database = new DatabaseSync(resolved);
    this.#targetEnvironment = targetEnvironment;
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 15000;
      CREATE TABLE IF NOT EXISTS artifact_sync_files (
        target_environment TEXT NOT NULL,
        object_key TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        source_mtime_ms INTEGER NOT NULL,
        source_sha256 TEXT NOT NULL,
        remote_size INTEGER NOT NULL,
        remote_etag TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        last_seen_run TEXT NOT NULL,
        verified_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (target_environment, object_key)
      );
      CREATE INDEX IF NOT EXISTS artifact_sync_files_seen_idx
        ON artifact_sync_files(target_environment, last_seen_run);
      CREATE TABLE IF NOT EXISTS artifact_sync_runs (
        run_id TEXT PRIMARY KEY,
        target_environment TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_root TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT '',
        summary_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  startRun(runId: string, sourceId: string, sourceRoot: string) {
    this.#database.prepare(`
      INSERT INTO artifact_sync_runs(run_id,target_environment,source_id,source_root,status,started_at)
      VALUES(?,?,?,?,?,?)
    `).run(runId, this.#targetEnvironment, sourceId, sourceRoot, "running", new Date().toISOString());
  }

  finishRun(runId: string, status: "complete" | "failed", summary: ArtifactSyncRunSummary, error = "") {
    this.#database.prepare(`
      UPDATE artifact_sync_runs
      SET status=?, finished_at=?, summary_json=?, error=?
      WHERE run_id=?
    `).run(status, new Date().toISOString(), JSON.stringify(summary), error, runId);
  }

  get(objectKey: string): ArtifactSyncRecord | null {
    return (this.#database.prepare(`
      SELECT object_key,source_size,source_mtime_ms,source_sha256,remote_size,remote_etag,status,last_seen_run,verified_at
      FROM artifact_sync_files
      WHERE target_environment=? AND object_key=?
    `).get(this.#targetEnvironment, objectKey) as ArtifactSyncRecord | undefined) ?? null;
  }

  save(record: ArtifactSyncRecord) {
    this.#database.prepare(`
      INSERT INTO artifact_sync_files(
        target_environment,object_key,source_size,source_mtime_ms,source_sha256,
        remote_size,remote_etag,status,last_seen_run,verified_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target_environment,object_key) DO UPDATE SET
        source_size=excluded.source_size,
        source_mtime_ms=excluded.source_mtime_ms,
        source_sha256=excluded.source_sha256,
        remote_size=excluded.remote_size,
        remote_etag=excluded.remote_etag,
        status=excluded.status,
        last_seen_run=excluded.last_seen_run,
        verified_at=excluded.verified_at
    `).run(
      this.#targetEnvironment,
      record.object_key,
      record.source_size,
      record.source_mtime_ms,
      record.source_sha256,
      record.remote_size,
      record.remote_etag,
      record.status,
      record.last_seen_run,
      record.verified_at
    );
  }

  close() {
    this.#database.close();
  }
}
