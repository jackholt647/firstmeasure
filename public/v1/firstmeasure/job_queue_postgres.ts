import { randomBytes } from "node:crypto";

import { queryPostgres, withPostgresTransaction } from "../src/database/postgres.js";
import { ensurePostgresProjectIndexReady } from "./project_index_postgres.js";
import {
  getFirstMeasureJobRetryDelayMs,
  type EnqueueFirstMeasureJobOptions,
  type FirstMeasureJobRow,
  type FirstMeasureWorkerHealth
} from "./job_queue.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function iso(value: unknown) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function normalize(row: Record<string, unknown>): FirstMeasureJobRow {
  return {
    id: String(row.id ?? ""), type: String(row.type ?? ""), status: String(row.status ?? "queued") as FirstMeasureJobRow["status"],
    priority: Number(row.priority ?? 0), payload: object(row.payload_json), result: row.result_json ? object(row.result_json) : null,
    error: String(row.error ?? ""), attempts: Number(row.attempts ?? 0), max_attempts: Number(row.max_attempts ?? 1),
    lease_owner: String(row.lease_owner ?? ""), lease_until_ms: Number(row.lease_until_ms ?? 0), available_at_ms: Number(row.available_at_ms ?? 0),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at), started_at: iso(row.started_at), finished_at: iso(row.finished_at)
  };
}

export async function enqueuePostgresJob(
  type: string, payload: Record<string, unknown> = {}, options: EnqueueFirstMeasureJobOptions = {}
) {
  await ensurePostgresProjectIndexReady();
  const id = String(options.id ?? "").trim() || randomBytes(16).toString("hex");
  await queryPostgres(`INSERT INTO firstmeasure_jobs (
    id,type,status,priority,payload_json,attempts,max_attempts,available_at_ms,created_at,updated_at
  ) VALUES ($1,$2,'queued',$3,$4::jsonb,0,$5,$6,now(),now())
  ${options.idempotent ? "ON CONFLICT (id) DO NOTHING" : ""}`, [
    id, String(type), Math.floor(Number(options.priority ?? 0)), JSON.stringify(payload ?? {}),
    Math.max(1, Math.min(10, Math.floor(Number(options.maxAttempts ?? 1)))),
    Math.max(0, Math.floor(Number(options.availableAtMs ?? 0)))
  ]);
  return id;
}

export async function recordPostgresWorkerHeartbeat(
  workerId: string,
  workerCount: number,
  processStartedAt: string
) {
  const heartbeatAtMs = Date.now();
  await ensurePostgresProjectIndexReady();
  await queryPostgres(`
    INSERT INTO firstmeasure_worker_heartbeats (
      worker_id, worker_count, heartbeat_at_ms, process_started_at
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (worker_id) DO UPDATE SET
      worker_count = EXCLUDED.worker_count,
      heartbeat_at_ms = EXCLUDED.heartbeat_at_ms,
      process_started_at = EXCLUDED.process_started_at
  `, [String(workerId), Math.max(0, Math.floor(Number(workerCount))), heartbeatAtMs, String(processStartedAt)]);
  await queryPostgres("DELETE FROM firstmeasure_worker_heartbeats WHERE heartbeat_at_ms < $1", [heartbeatAtMs - 24 * 60 * 60_000]);
  return heartbeatAtMs;
}

export async function getPostgresWorkerHealth(maxAgeMs = 120_000): Promise<FirstMeasureWorkerHealth> {
  await ensurePostgresProjectIndexReady();
  const result = await queryPostgres<Record<string, unknown>>(`
    SELECT worker_id, worker_count, heartbeat_at_ms, process_started_at
    FROM firstmeasure_worker_heartbeats
    ORDER BY heartbeat_at_ms DESC
    LIMIT 1
  `);
  const row = result.rows[0];
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

export async function getPostgresJob(id: string) {
  await ensurePostgresProjectIndexReady();
  const result = await queryPostgres<Record<string, unknown>>("SELECT * FROM firstmeasure_jobs WHERE id = $1", [String(id)]);
  return result.rows[0] ? normalize(result.rows[0]) : null;
}

export async function getPostgresJobStats() {
  await ensurePostgresProjectIndexReady();
  const result = await queryPostgres<{ status: string; count: string }>("SELECT status, COUNT(*)::text AS count FROM firstmeasure_jobs GROUP BY status");
  const stats: Record<string, number> = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of result.rows) stats[row.status] = Number(row.count);
  return stats;
}

export async function listPostgresJobs(ids: string[]) {
  await ensurePostgresProjectIndexReady();
  const unique = Array.from(new Set(ids.map((id) => String(id).trim()).filter(Boolean))).slice(0, 1000);
  if (!unique.length) return [];
  const result = await queryPostgres<Record<string, unknown>>("SELECT * FROM firstmeasure_jobs WHERE id = ANY($1::text[])", [unique]);
  return result.rows.map(normalize);
}

export async function claimNextPostgresJob(workerId: string, types: string[], leaseMs = 60_000) {
  await ensurePostgresProjectIndexReady();
  const allowed = types.map((type) => String(type).trim()).filter(Boolean);
  if (!allowed.length) return null;
  return withPostgresTransaction(async (client) => {
    const now = Date.now();
    const result = await client.query<Record<string, unknown>>(`
      SELECT * FROM firstmeasure_jobs
      WHERE type = ANY($1::text[]) AND attempts < max_attempts AND available_at_ms <= $2
        AND (status = 'queued' OR (status = 'running' AND lease_until_ms <= $2))
      ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    `, [allowed, now]);
    if (!result.rows[0]) return null;
    const id = String(result.rows[0].id);
    const updated = await client.query<Record<string, unknown>>(`
      UPDATE firstmeasure_jobs SET status='running', attempts=attempts+1, lease_owner=$2,
        lease_until_ms=$3, started_at=COALESCE(started_at,now()), updated_at=now(), error=''
      WHERE id=$1 RETURNING *
    `, [id, workerId, now + Math.max(1000, Math.floor(leaseMs))]);
    return updated.rows[0] ? normalize(updated.rows[0]) : null;
  });
}

export async function completePostgresJob(id: string, result: Record<string, unknown>) {
  await ensurePostgresProjectIndexReady();
  await queryPostgres(`UPDATE firstmeasure_jobs SET status='completed', result_json=$2::jsonb, error='',
    lease_owner='', lease_until_ms=0, available_at_ms=0, updated_at=now(), finished_at=now() WHERE id=$1`,
  [id, JSON.stringify(result ?? {})]);
}

export async function failPostgresJob(id: string, error: unknown) {
  await ensurePostgresProjectIndexReady();
  await withPostgresTransaction(async (client) => {
    const result = await client.query<Record<string, unknown>>("SELECT * FROM firstmeasure_jobs WHERE id=$1 FOR UPDATE", [id]);
    if (!result.rows[0]) return;
    const job = normalize(result.rows[0]);
    const retry = job.attempts < job.max_attempts;
    const delay = retry ? getFirstMeasureJobRetryDelayMs(job) : 0;
    await client.query(`UPDATE firstmeasure_jobs SET status=$2, error=$3, lease_owner='', lease_until_ms=0,
      available_at_ms=$4, updated_at=now(), finished_at=CASE WHEN $2='failed' THEN now() ELSE finished_at END WHERE id=$1`,
    [id, retry ? "queued" : "failed", error instanceof Error ? error.message : String(error), retry ? Date.now() + delay : 0]);
  });
}
