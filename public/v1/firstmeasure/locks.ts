import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";

import {
  ensureFirstMeasureProjectIndexReady,
  getFirstMeasureProjectIndexDb
} from "./project_index.js";

let lockSchemaReady = false;

function ensureLockSchema() {
  if (lockSchemaReady) return;
  const db = getFirstMeasureProjectIndexDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS firstmeasure_locks (
      lock_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_firstmeasure_locks_expires
      ON firstmeasure_locks (expires_at_ms);
  `);
  lockSchemaReady = true;
}

export async function acquireFirstMeasureLock(
  key: string,
  options: {
    ttlMs?: number;
    waitMs?: number;
    retryMs?: number;
    owner?: string;
  } = {}
) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./locks_postgres.js")).acquirePostgresLock(key, options);
  await ensureFirstMeasureProjectIndexReady();
  ensureLockSchema();

  const lockKey = String(key ?? "").trim();
  if (!lockKey) throw new Error("Lock key is required.");

  const ttlMs = Math.max(1000, Math.floor(Number(options.ttlMs ?? 30_000)));
  const waitMs = Math.max(0, Math.floor(Number(options.waitMs ?? 10_000)));
  const retryMs = Math.max(10, Math.floor(Number(options.retryMs ?? 25)));
  const owner = String(options.owner || `${process.pid}:${randomBytes(8).toString("hex")}`);
  const deadline = Date.now() + waitMs;
  const db = getFirstMeasureProjectIndexDb();

  while (true) {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    try {
      db.exec("BEGIN IMMEDIATE");
      const existing = db.prepare(`
        SELECT owner, expires_at_ms
        FROM firstmeasure_locks
        WHERE lock_key = $lockKey
        LIMIT 1
      `).get({ lockKey }) as { owner?: string; expires_at_ms?: number } | undefined;

      if (!existing || Number(existing.expires_at_ms ?? 0) <= now || existing.owner === owner) {
        db.prepare(`
          INSERT INTO firstmeasure_locks (lock_key, owner, expires_at_ms, acquired_at_ms, updated_at_ms)
          VALUES ($lockKey, $owner, $expiresAt, $now, $now)
          ON CONFLICT(lock_key) DO UPDATE SET
            owner = excluded.owner,
            expires_at_ms = excluded.expires_at_ms,
            updated_at_ms = excluded.updated_at_ms
        `).run({ lockKey, owner, expiresAt, now });
        db.exec("COMMIT");
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await ensureFirstMeasureProjectIndexReady();
          ensureLockSchema();
          const releaseDb = getFirstMeasureProjectIndexDb();
          releaseDb.prepare(`
            DELETE FROM firstmeasure_locks
            WHERE lock_key = $lockKey AND owner = $owner
          `).run({ lockKey, owner });
        };
      }

      db.exec("ROLLBACK");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (Date.now() >= deadline) throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lock '${lockKey}'.`);
    }
    await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }
}
