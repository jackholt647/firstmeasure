import { randomBytes } from "node:crypto";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";

import {
  ensureFirstMeasureProjectIndexReady,
  getFirstMeasureProjectIndexDb
} from "./project_index.js";

export type FirstMeasureJobStatus = "queued" | "running" | "completed" | "failed";
// An attempt is a fencing token: even the same process must not settle an old claim.
export type FirstMeasureJobClaim = Pick<FirstMeasureJobRow, "lease_owner" | "attempts">;

export type FirstMeasureJobRow = {
  id: string;
  type: string;
  status: FirstMeasureJobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string;
  lease_until_ms: number;
  available_at_ms: number;
  created_at: string;
  updated_at: string;
  started_at: string;
  finished_at: string;
};

export type EnqueueFirstMeasureJobOptions = {
  priority?: number;
  maxAttempts?: number;
  id?: string;
  availableAtMs?: number;
  idempotent?: boolean;
};

export type FirstMeasureWorkerHealth = {
  healthy: boolean;
  worker_id: string;
  worker_count: number;
  heartbeat_at_ms: number;
  heartbeat_age_ms: number | null;
  process_started_at: string;
};

let jobSchemaReady = false;

function nowIso() {
  return new Date().toISOString();
}

function parseJsonRecord(value: unknown) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeJobRow(row: Record<string, unknown>): FirstMeasureJobRow {
  return {
    id: String(row.id ?? ""),
    type: String(row.type ?? ""),
    status: String(row.status ?? "queued") as FirstMeasureJobStatus,
    priority: Number(row.priority ?? 0),
    payload: parseJsonRecord(row.payload_json),
    result: row.result_json ? parseJsonRecord(row.result_json) : null,
    error: String(row.error ?? ""),
    attempts: Number(row.attempts ?? 0),
    max_attempts: Number(row.max_attempts ?? 1),
    lease_owner: String(row.lease_owner ?? ""),
    lease_until_ms: Number(row.lease_until_ms ?? 0),
    available_at_ms: Number(row.available_at_ms ?? 0),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    started_at: String(row.started_at ?? ""),
    finished_at: String(row.finished_at ?? "")
  };
}

async function ensureJobSchema() {
  await ensureFirstMeasureProjectIndexReady();
  if (jobSchemaReady) return;
  const db = getFirstMeasureProjectIndexDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS firstmeasure_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      lease_owner TEXT NOT NULL DEFAULT '',
      lease_until_ms INTEGER NOT NULL DEFAULT 0,
      available_at_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_firstmeasure_jobs_claim
      ON firstmeasure_jobs (status, priority DESC, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_firstmeasure_jobs_lease
      ON firstmeasure_jobs (status, lease_until_ms);
    CREATE INDEX IF NOT EXISTS idx_firstmeasure_jobs_type_status
      ON firstmeasure_jobs (type, status, created_at);
    CREATE TABLE IF NOT EXISTS firstmeasure_worker_heartbeats (
      worker_id TEXT PRIMARY KEY,
      worker_count INTEGER NOT NULL DEFAULT 0,
      heartbeat_at_ms INTEGER NOT NULL,
      process_started_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_firstmeasure_worker_heartbeats_time
      ON firstmeasure_worker_heartbeats (heartbeat_at_ms DESC);
  `);
  const columns = db.prepare("PRAGMA table_info(firstmeasure_jobs)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "available_at_ms")) {
    db.exec("ALTER TABLE firstmeasure_jobs ADD COLUMN available_at_ms INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_firstmeasure_jobs_available
      ON firstmeasure_jobs (status, available_at_ms, priority DESC, created_at, id);
  `);
  jobSchemaReady = true;
}

export async function enqueueFirstMeasureJob(
  type: string,
  payload: Record<string, unknown> = {},
  options: EnqueueFirstMeasureJobOptions = {}
) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).enqueuePostgresJob(type, payload, options);
  await ensureJobSchema();
  const id = String(options.id ?? "").trim() || randomBytes(16).toString("hex");
  const at = nowIso();
  const db = getFirstMeasureProjectIndexDb();
  const insert = options.idempotent ? "INSERT OR IGNORE" : "INSERT";
  db.prepare(`
    ${insert} INTO firstmeasure_jobs (
      id, type, status, priority, payload_json, attempts, max_attempts,
      available_at_ms, created_at, updated_at
    ) VALUES (
      $id, $type, 'queued', $priority, $payloadJson, 0, $maxAttempts,
      $availableAtMs, $at, $at
    )
  `).run({
    id,
    type: String(type),
    priority: Math.floor(Number(options.priority ?? 0)),
    payloadJson: JSON.stringify(payload ?? {}),
    maxAttempts: Math.max(1, Math.min(10, Math.floor(Number(options.maxAttempts ?? 1)))),
    availableAtMs: Math.max(0, Math.floor(Number(options.availableAtMs ?? 0))),
    at
  });
  return id;
}

export async function recordFirstMeasureWorkerHeartbeat(
  workerId: string,
  workerCount: number,
  processStartedAt: string
) {
  if (isFirstMeasurePostgresEnabled()) {
    return (await import("./job_queue_postgres.js")).recordPostgresWorkerHeartbeat(
      workerId,
      workerCount,
      processStartedAt
    );
  }
  await ensureJobSchema();
  const heartbeatAtMs = Date.now();
  const db = getFirstMeasureProjectIndexDb();
  db.prepare(`
    INSERT INTO firstmeasure_worker_heartbeats (
      worker_id, worker_count, heartbeat_at_ms, process_started_at
    ) VALUES ($workerId, $workerCount, $heartbeatAtMs, $processStartedAt)
    ON CONFLICT(worker_id) DO UPDATE SET
      worker_count = excluded.worker_count,
      heartbeat_at_ms = excluded.heartbeat_at_ms,
      process_started_at = excluded.process_started_at
  `).run({
    workerId: String(workerId),
    workerCount: Math.max(0, Math.floor(Number(workerCount))),
    heartbeatAtMs,
    processStartedAt: String(processStartedAt)
  });
  db.prepare(`DELETE FROM firstmeasure_worker_heartbeats WHERE heartbeat_at_ms < $cutoffMs`)
    .run({ cutoffMs: heartbeatAtMs - 24 * 60 * 60_000 });
  return heartbeatAtMs;
}

export async function getFirstMeasureWorkerHealth(maxAgeMs = 120_000): Promise<FirstMeasureWorkerHealth> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await import("./job_queue_postgres.js")).getPostgresWorkerHealth(maxAgeMs);
  }
  await ensureJobSchema();
  const row = getFirstMeasureProjectIndexDb().prepare(`
    SELECT worker_id, worker_count, heartbeat_at_ms, process_started_at
    FROM firstmeasure_worker_heartbeats
    ORDER BY heartbeat_at_ms DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;
  const heartbeatAtMs = Number(row?.heartbeat_at_ms ?? 0);
  const heartbeatAgeMs = heartbeatAtMs > 0 ? Math.max(0, Date.now() - heartbeatAtMs) : null;
  const workerCount = Number(row?.worker_count ?? 0);
  return {
    healthy: heartbeatAgeMs != null && heartbeatAgeMs <= Math.max(1_000, maxAgeMs) && workerCount > 0,
    worker_id: String(row?.worker_id ?? ""),
    worker_count: workerCount,
    heartbeat_at_ms: heartbeatAtMs,
    heartbeat_age_ms: heartbeatAgeMs,
    process_started_at: String(row?.process_started_at ?? "")
  };
}

export async function getFirstMeasureJob(id: string) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).getPostgresJob(id);
  await ensureJobSchema();
  const row = getFirstMeasureProjectIndexDb().prepare(`
    SELECT *
    FROM firstmeasure_jobs
    WHERE id = $id
    LIMIT 1
  `).get({ id: String(id) }) as Record<string, unknown> | undefined;
  return row ? normalizeJobRow(row) : null;
}

export async function getFirstMeasureJobStats() {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).getPostgresJobStats();
  await ensureJobSchema();
  const rows = getFirstMeasureProjectIndexDb().prepare(`
    SELECT status, COUNT(*) AS count
    FROM firstmeasure_jobs
    GROUP BY status
  `).all() as Array<{ status?: string; count?: number }>;
  const stats: Record<string, number> = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    stats[String(row.status ?? "")] = Number(row.count ?? 0);
  }
  return stats;
}

export async function listFirstMeasureJobs(ids: string[]) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).listPostgresJobs(ids);
  await ensureJobSchema();
  const uniqueIds = Array.from(new Set(ids.map((id) => String(id).trim()).filter(Boolean))).slice(0, 1000);
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map((_, index) => `$id${index}`);
  const params = Object.fromEntries(uniqueIds.map((id, index) => [`id${index}`, id]));
  const rows = getFirstMeasureProjectIndexDb().prepare(`
    SELECT *
    FROM firstmeasure_jobs
    WHERE id IN (${placeholders.join(", ")})
  `).all(params) as Array<Record<string, unknown>>;
  return rows.map(normalizeJobRow);
}

export async function claimNextFirstMeasureJob(
  workerId: string,
  types: string[],
  leaseMs = 60_000
) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).claimNextPostgresJob(workerId, types, leaseMs);
  await ensureJobSchema();
  const allowedTypes = types.map((type) => String(type).trim()).filter(Boolean);
  if (!allowedTypes.length) return null;
  const typePlaceholders = allowedTypes.map((_, index) => `$type${index}`);
  const typeParams = Object.fromEntries(allowedTypes.map((type, index) => [`type${index}`, type]));
  const db = getFirstMeasureProjectIndexDb();
  const nowMs = Date.now();
  const at = nowIso();
  const candidate = db.prepare(`
    SELECT id
    FROM firstmeasure_jobs
    WHERE type IN (${typePlaceholders.join(", ")})
      AND attempts < max_attempts
      AND available_at_ms <= $nowMs
      AND (
        status = 'queued'
        OR (status = 'running' AND lease_until_ms <= $nowMs)
      )
    ORDER BY priority DESC, created_at ASC, id ASC
    LIMIT 1
  `).get({ ...typeParams, nowMs }) as { id?: string } | undefined;
  if (!candidate?.id) return null;
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = db.prepare(`
      UPDATE firstmeasure_jobs
      SET status = 'running',
        attempts = attempts + 1,
        lease_owner = $workerId,
        lease_until_ms = $leaseUntilMs,
        started_at = CASE WHEN started_at = '' THEN $at ELSE started_at END,
        updated_at = $at,
        error = ''
      WHERE id = $id
        AND type IN (${typePlaceholders.join(", ")})
        AND attempts < max_attempts
        AND available_at_ms <= $nowMs
        AND (
          status = 'queued'
          OR (status = 'running' AND lease_until_ms <= $nowMs)
        )
    `).run({
      ...typeParams,
      id: candidate.id,
      workerId,
      nowMs,
      leaseUntilMs: nowMs + Math.max(1000, Math.floor(leaseMs)),
      at
    });
    db.exec("COMMIT");
    if (Number(result.changes ?? 0) === 0) return null;
    return await getFirstMeasureJob(candidate.id);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export async function renewFirstMeasureJobLease(id: string, claim: FirstMeasureJobClaim, leaseMs: number) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).renewPostgresJobLease(id, claim, leaseMs);
  await ensureJobSchema();
  const now = Date.now();
  return Number(getFirstMeasureProjectIndexDb().prepare(`UPDATE firstmeasure_jobs
    SET lease_until_ms=$until, updated_at=$at WHERE id=$id AND status='running'
    AND lease_owner=$owner AND attempts=$attempt AND lease_until_ms>$now`).run({
    id, owner: claim.lease_owner, attempt: claim.attempts, now,
    until: now + Math.max(1000, Math.floor(leaseMs)), at: nowIso()
  }).changes) === 1;
}

export async function reapExhaustedFirstMeasureJobs(types: string[]) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).reapExhaustedPostgresJobs(types);
  await ensureJobSchema();
  if (!types.length) return 0;
  const params = Object.fromEntries(types.map((type, i) => [`type${i}`, type]));
  return Number(getFirstMeasureProjectIndexDb().prepare(`UPDATE firstmeasure_jobs
    SET status='failed', error='Worker lease expired after final attempt.', lease_owner='',
    lease_until_ms=0, updated_at=$at, finished_at=$at
    WHERE status='running' AND lease_until_ms<=$now AND attempts>=max_attempts
    AND type IN (${types.map((_, i) => `$type${i}`).join(',')})`).run({ ...params, now: Date.now(), at: nowIso() }).changes);
}

export async function completeFirstMeasureJob(id: string, result: Record<string, unknown>, claim: FirstMeasureJobClaim) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).completePostgresJob(id, result, claim);
  await ensureJobSchema();
  const at = nowIso();
  const updated = getFirstMeasureProjectIndexDb().prepare(`
    UPDATE firstmeasure_jobs
    SET status = 'completed',
      result_json = $resultJson,
      error = '',
      lease_owner = '',
      lease_until_ms = 0,
      available_at_ms = 0,
      updated_at = $at,
      finished_at = $at
    WHERE id = $id AND status='running' AND lease_owner=$owner AND attempts=$attempt AND lease_until_ms>$now
  `).run({ id, resultJson: JSON.stringify(result ?? {}), at, owner: claim.lease_owner, attempt: claim.attempts, now: Date.now() });
  return Number(updated.changes) === 1;
}

export async function failFirstMeasureJob(id: string, error: unknown, claim: FirstMeasureJobClaim) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./job_queue_postgres.js")).failPostgresJob(id, error, claim);
  await ensureJobSchema();
  const at = nowIso();
  const db = getFirstMeasureProjectIndexDb();
  const row = await getFirstMeasureJob(id);
  const canRetry = row ? row.attempts < row.max_attempts : false;
  const retryDelayMs = row && canRetry ? getFirstMeasureJobRetryDelayMs(row) : 0;
  const updated = db.prepare(`
    UPDATE firstmeasure_jobs
    SET status = $status,
      error = $error,
      lease_owner = '',
      lease_until_ms = 0,
      available_at_ms = $availableAtMs,
      updated_at = $at,
      finished_at = CASE WHEN $status = 'failed' THEN $at ELSE finished_at END
    WHERE id = $id AND status='running' AND lease_owner=$owner AND attempts=$attempt AND lease_until_ms>$now
  `).run({
    id,
    status: canRetry ? "queued" : "failed",
    error: error instanceof Error ? error.message : String(error),
    availableAtMs: canRetry ? Date.now() + retryDelayMs : 0,
    at, owner: claim.lease_owner, attempt: claim.attempts, now: Date.now()
  });
  return Number(updated.changes) === 1;
}

export function getFirstMeasureJobRetryDelayMs(job: Pick<FirstMeasureJobRow, "type" | "attempts">) {
  if (job.type !== "report.delivery" && job.type !== "report.release") return 0;
  const delays = [15_000, 30_000, 60_000, 120_000];
  return delays[Math.max(0, Math.min(delays.length - 1, job.attempts - 1))] ?? 120_000;
}
