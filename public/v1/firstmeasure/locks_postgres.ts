import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";

import { queryPostgres } from "../src/database/postgres.js";
import { ensurePostgresProjectIndexReady } from "./project_index_postgres.js";

let lockSchemaReady: Promise<void> | null = null;

function ensurePostgresLockSchema() {
  if (!lockSchemaReady) {
    lockSchemaReady = queryPostgres(`
      CREATE TABLE IF NOT EXISTS firstmeasure_locks (
        lock_key text PRIMARY KEY,
        owner text NOT NULL,
        expires_at_ms bigint NOT NULL,
        acquired_at_ms bigint NOT NULL,
        updated_at_ms bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_firstmeasure_locks_expires
        ON firstmeasure_locks (expires_at_ms);
    `).then(() => undefined).catch((error) => {
      lockSchemaReady = null;
      throw error;
    });
  }
  return lockSchemaReady;
}

export async function acquirePostgresLock(
  key: string,
  options: { ttlMs?: number; waitMs?: number; retryMs?: number; owner?: string } = {}
) {
  await ensurePostgresProjectIndexReady();
  await ensurePostgresLockSchema();
  const lockKey = String(key ?? "").trim();
  if (!lockKey) throw new Error("Lock key is required.");
  const ttlMs = Math.max(1_000, Math.floor(Number(options.ttlMs ?? 30_000)));
  const waitMs = Math.max(0, Math.floor(Number(options.waitMs ?? 10_000)));
  const retryMs = Math.max(10, Math.floor(Number(options.retryMs ?? 25)));
  const owner = String(options.owner || `${process.pid}:${randomBytes(8).toString("hex")}`);
  const deadline = Date.now() + waitMs;

  while (true) {
    const now = Date.now();
    const result = await queryPostgres<{ owner: string }>(`
      INSERT INTO firstmeasure_locks (
        lock_key, owner, expires_at_ms, acquired_at_ms, updated_at_ms
      ) VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (lock_key) DO UPDATE SET
        owner = EXCLUDED.owner,
        expires_at_ms = EXCLUDED.expires_at_ms,
        acquired_at_ms = EXCLUDED.acquired_at_ms,
        updated_at_ms = EXCLUDED.updated_at_ms
      WHERE firstmeasure_locks.expires_at_ms <= $4
         OR firstmeasure_locks.owner = EXCLUDED.owner
      RETURNING owner
    `, [lockKey, owner, now + ttlMs, now]);
    if (result.rows[0]?.owner === owner) break;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock '${lockKey}'.`);
    await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }

  // A lease keeps the lock cross-process without checking a connection out of
  // the one-connection application pool for the entire protected operation.
  // Renew long operations so another worker cannot take over after the TTL.
  const renewEveryMs = Math.max(1_000, Math.floor(ttlMs / 3));
  const renewal = setInterval(() => {
    const now = Date.now();
    void queryPostgres(`
      UPDATE firstmeasure_locks
      SET expires_at_ms = $3, updated_at_ms = $2
      WHERE lock_key = $1 AND owner = $4
    `, [lockKey, now, now + ttlMs, owner]).catch((error) => {
      console.error(`Failed to renew PostgreSQL lock '${lockKey}'.`, error);
    });
  }, renewEveryMs);
  renewal.unref();

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(renewal);
    await queryPostgres(
      "DELETE FROM firstmeasure_locks WHERE lock_key = $1 AND owner = $2",
      [lockKey, owner]
    );
  };
}
