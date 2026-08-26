import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";

import { env } from "../src/config/env.js";
import {
  bootstrapPostgresApplicationUser,
  getPostgresPool,
  queryPostgres,
  withPostgresClient,
  withPostgresTransaction
} from "../src/database/postgres.js";
import { FIRSTMEASURE_FILE_NAMES } from "./constants.js";
import {
  buildIndexedProjectDocument,
  FIRSTMEASURE_QUEUE_GROUPS,
  type FirstMeasureQueueGroup,
  type LegacyListActor,
  type LegacyListQuery,
  type LegacyListResult,
  type ProjectActivityField,
  type ProjectIndexManifestQuery,
  type ProjectIndexStatus,
  type QueueBucketQuery,
  type QueueChangesQuery,
  type QueueCountsQuery,
  type RebuildProjectIndexResult
} from "./project_index.js";
import type { ProjectManifest } from "./storage.js";

const SCHEMA_VERSION = 5;
const IMPORT_KEY = "project_json_import_v2";
const MIGRATION_LOCK = "firstmeasure-postgres-schema-v3";
const QUEUE_EVENT_RETENTION_ROWS = 100_000;

let readyPromise: Promise<void> | null = null;
let queueEventsUntilPrune = 250;

const PROJECT_COLUMNS = [
  "id", "manifest_json", "storage_path", "schema_version", "status", "project_type", "address", "address_normalized",
  "id_normalized", "owner_name", "owner_name_normalized", "owner_email", "issuer_name", "issuer_name_normalized",
  "issuer_email", "resident_name", "resident_name_normalized", "resident_email", "resident_phone", "organization_id",
  "team_id", "assigned_to_name", "assigned_to_email", "reserved_to_name", "reserved_to_email", "correction_to_name",
  "correction_to_email", "qa_claimed_by_name", "qa_claimed_by_email", "complexity", "amount_charged", "is_filler",
  "is_vip", "is_expedited", "instant_enabled", "instant_only", "include_gutter_measurements", "has_insights", "has_pdf_state",
  "has_report_pdf", "has_summary_pdf", "has_model_data", "has_google_image", "has_mask_tif", "has_dsm_tif",
  "thumbnail_artifact_name", "created_at", "queued_at", "processed_at", "started_at", "uploaded_at", "completed_at",
  "rejected_at", "cancelled_at", "updated_at", "created_at_ms", "queued_at_ms", "processed_at_ms", "started_at_ms",
  "uploaded_at_ms", "completed_at_ms", "rejected_at_ms", "cancelled_at_ms", "updated_at_ms", "sort_ts", "search_text",
  "queue_group", "queue_priority", "queue_order_ms", "delivery_hold_status", "force_kick_email",
  "force_kick_acknowledged", "source_sha256"
] as const;

const RECORDSET_TYPES: Record<(typeof PROJECT_COLUMNS)[number], string> = {
  id: "text", manifest_json: "jsonb", storage_path: "text", schema_version: "integer", status: "text", project_type: "text",
  address: "text", address_normalized: "text", id_normalized: "text", owner_name: "text", owner_name_normalized: "text",
  owner_email: "text", issuer_name: "text", issuer_name_normalized: "text", issuer_email: "text", resident_name: "text",
  resident_name_normalized: "text", resident_email: "text", resident_phone: "text", organization_id: "text", team_id: "text",
  assigned_to_name: "text", assigned_to_email: "text", reserved_to_name: "text", reserved_to_email: "text",
  correction_to_name: "text", correction_to_email: "text", qa_claimed_by_name: "text", qa_claimed_by_email: "text",
  complexity: "text", amount_charged: "double precision", is_filler: "integer", is_vip: "integer", is_expedited: "integer",
  instant_enabled: "integer", instant_only: "integer", include_gutter_measurements: "integer", has_insights: "integer",
  has_pdf_state: "integer", has_report_pdf: "integer", has_summary_pdf: "integer", has_model_data: "integer",
  has_google_image: "integer", has_mask_tif: "integer", has_dsm_tif: "integer", thumbnail_artifact_name: "text",
  created_at: "text", queued_at: "text", processed_at: "text", started_at: "text", uploaded_at: "text", completed_at: "text",
  rejected_at: "text", cancelled_at: "text", updated_at: "text", created_at_ms: "bigint", queued_at_ms: "bigint",
  processed_at_ms: "bigint", started_at_ms: "bigint", uploaded_at_ms: "bigint", completed_at_ms: "bigint",
  rejected_at_ms: "bigint", cancelled_at_ms: "bigint", updated_at_ms: "bigint", sort_ts: "bigint", search_text: "text",
  queue_group: "text", queue_priority: "integer", queue_order_ms: "bigint", delivery_hold_status: "text",
  force_kick_email: "text", force_kick_acknowledged: "integer", source_sha256: "text"
};

type IndexedDocument = Record<string, unknown> & { id: string; manifest_json: unknown; source_sha256: string };

export async function ensurePostgresProjectIndexReady() {
  readyPromise ??= initializePostgres();
  await readyPromise;
}

async function initializePostgres() {
  await bootstrapPostgresApplicationUser();
  const startedAt = Date.now();
  const clusterWorkerId = String(process.env.V1_CLUSTER_WORKER ?? "").trim();
  const canLeadMigration = !clusterWorkerId || clusterWorkerId === "1";
  while (Date.now() - startedAt < env.postgresStartupWaitMs) {
    if (await postgresSchemaIsReady()) return;
    // Worker slot 1 is also the only process that opens the administrator
    // connection and applies grants. Keeping schema leadership on that stable
    // slot prevents another one of 44 workers from racing CREATE TABLE before
    // the application role has been granted schema access.
    if (canLeadMigration && await initializePostgresAsLeader()) return;
    const jitter = Math.floor(Math.random() * Math.max(25, env.postgresStartupPollMs / 3));
    await new Promise((resolve) => setTimeout(resolve, env.postgresStartupPollMs + jitter));
  }
  throw new Error(
    `Timed out after ${env.postgresStartupWaitMs}ms waiting for the PostgreSQL schema/import leader. ` +
    "Check the first web worker's migration logs before restarting the cluster."
  );
}

async function initializePostgresAsLeader() {
  return withPostgresClient(async (client) => {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [MIGRATION_LOCK]
    );
    if (!lock.rows[0]?.acquired) return false;
    try {
      await initializeSchema(client);
      const importedWithCurrentSchema = env.postgresAutoMigrate
        ? await importProjectsIfNeeded(client)
        : false;
      await migrateDerivedQueueColumns(client, importedWithCurrentSchema);
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]).catch(() => undefined);
    }
  });
}

async function postgresSchemaIsReady() {
  try {
    const result = await queryPostgres<{ schema_ready: boolean; import_status: string }>(`
      SELECT
        EXISTS(SELECT 1 FROM firstmeasure_schema_migrations WHERE version = $1) AS schema_ready,
        COALESCE((SELECT value->>'status' FROM firstmeasure_migration_state WHERE key = $2), '') AS import_status
    `, [SCHEMA_VERSION, IMPORT_KEY]);
    const row = result.rows[0];
    if (env.postgresAutoMigrate && row?.import_status === "failed") {
      throw new Error("The PostgreSQL project import leader reported a failed migration.");
    }
    return row?.schema_ready === true && (!env.postgresAutoMigrate || row.import_status === "complete");
  } catch (error) {
    const code = String((error as { code?: unknown })?.code ?? "");
    if (code === "42P01" || code === "3F000") return false;
    throw error;
  }
}

async function initializeSchema(client: PoolClient) {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS firstmeasure_schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS firstmeasure_migration_state (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS projects (
        id text PRIMARY KEY,
        manifest_json jsonb NOT NULL,
        storage_path text NOT NULL DEFAULT '',
        schema_version integer NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT '',
        project_type text NOT NULL DEFAULT '',
        address text NOT NULL DEFAULT '',
        address_normalized text NOT NULL DEFAULT '',
        id_normalized text NOT NULL DEFAULT '',
        owner_name text NOT NULL DEFAULT '',
        owner_name_normalized text NOT NULL DEFAULT '',
        owner_email text NOT NULL DEFAULT '',
        issuer_name text NOT NULL DEFAULT '',
        issuer_name_normalized text NOT NULL DEFAULT '',
        issuer_email text NOT NULL DEFAULT '',
        resident_name text NOT NULL DEFAULT '',
        resident_name_normalized text NOT NULL DEFAULT '',
        resident_email text NOT NULL DEFAULT '',
        resident_phone text NOT NULL DEFAULT '',
        organization_id text NOT NULL DEFAULT '',
        team_id text NOT NULL DEFAULT '',
        assigned_to_name text NOT NULL DEFAULT '',
        assigned_to_email text NOT NULL DEFAULT '',
        reserved_to_name text NOT NULL DEFAULT '',
        reserved_to_email text NOT NULL DEFAULT '',
        correction_to_name text NOT NULL DEFAULT '',
        correction_to_email text NOT NULL DEFAULT '',
        qa_claimed_by_name text NOT NULL DEFAULT '',
        qa_claimed_by_email text NOT NULL DEFAULT '',
        complexity text NOT NULL DEFAULT '',
        amount_charged double precision NOT NULL DEFAULT 0,
        is_filler integer NOT NULL DEFAULT 0,
        is_vip integer NOT NULL DEFAULT 0,
        is_expedited integer NOT NULL DEFAULT 0,
        instant_enabled integer NOT NULL DEFAULT 0,
        instant_only integer NOT NULL DEFAULT 0,
        include_gutter_measurements integer NOT NULL DEFAULT 0,
        has_insights integer NOT NULL DEFAULT 0,
        has_pdf_state integer NOT NULL DEFAULT 0,
        has_report_pdf integer NOT NULL DEFAULT 0,
        has_summary_pdf integer NOT NULL DEFAULT 0,
        has_model_data integer NOT NULL DEFAULT 0,
        has_google_image integer NOT NULL DEFAULT 0,
        has_mask_tif integer NOT NULL DEFAULT 0,
        has_dsm_tif integer NOT NULL DEFAULT 0,
        thumbnail_artifact_name text NOT NULL DEFAULT '',
        created_at text NOT NULL DEFAULT '',
        queued_at text NOT NULL DEFAULT '',
        processed_at text NOT NULL DEFAULT '',
        started_at text NOT NULL DEFAULT '',
        uploaded_at text NOT NULL DEFAULT '',
        completed_at text NOT NULL DEFAULT '',
        rejected_at text NOT NULL DEFAULT '',
        cancelled_at text NOT NULL DEFAULT '',
        updated_at text NOT NULL DEFAULT '',
        created_at_ms bigint NOT NULL DEFAULT 0,
        queued_at_ms bigint NOT NULL DEFAULT 0,
        processed_at_ms bigint NOT NULL DEFAULT 0,
        started_at_ms bigint NOT NULL DEFAULT 0,
        uploaded_at_ms bigint NOT NULL DEFAULT 0,
        completed_at_ms bigint NOT NULL DEFAULT 0,
        rejected_at_ms bigint NOT NULL DEFAULT 0,
        cancelled_at_ms bigint NOT NULL DEFAULT 0,
        updated_at_ms bigint NOT NULL DEFAULT 0,
        sort_ts bigint NOT NULL DEFAULT 0,
        search_text text NOT NULL DEFAULT '',
        search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(search_text, ''))) STORED,
        queue_group text NOT NULL DEFAULT '',
        queue_priority integer NOT NULL DEFAULT 3,
        queue_order_ms bigint NOT NULL DEFAULT 0,
        delivery_hold_status text NOT NULL DEFAULT '',
        force_kick_email text NOT NULL DEFAULT '',
        force_kick_acknowledged integer NOT NULL DEFAULT 0,
        source_sha256 text NOT NULL DEFAULT '',
        revision bigint NOT NULL DEFAULT 1,
        updated_db_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS project_queue_events (
        version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id text NOT NULL UNIQUE,
        project_id text NOT NULL,
        event_type text NOT NULL,
        status text NOT NULL,
        previous_status text NOT NULL DEFAULT '',
        queue_group text NOT NULL DEFAULT '',
        previous_queue_group text NOT NULL DEFAULT '',
        team_id text NOT NULL DEFAULT '',
        actor_email text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        payload_json jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE IF NOT EXISTS project_queue_counters (
        scope text NOT NULL,
        team_id text NOT NULL DEFAULT '',
        queue_group text NOT NULL,
        instant_only integer NOT NULL DEFAULT 0,
        project_count bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, team_id, queue_group, instant_only)
      );
      CREATE TABLE IF NOT EXISTS firstmeasure_jobs (
        id text PRIMARY KEY,
        type text NOT NULL,
        status text NOT NULL,
        priority integer NOT NULL DEFAULT 0,
        payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        result_json jsonb,
        error text NOT NULL DEFAULT '',
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 1,
        lease_owner text NOT NULL DEFAULT '',
        lease_until_ms bigint NOT NULL DEFAULT 0,
        available_at_ms bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        started_at timestamptz,
        finished_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS firstmeasure_worker_heartbeats (
        worker_id text PRIMARY KEY,
        worker_count integer NOT NULL DEFAULT 0,
        heartbeat_at_ms bigint NOT NULL,
        process_started_at text NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS firstmeasure_locks (
        lock_key text PRIMARY KEY,
        owner text NOT NULL,
        expires_at_ms bigint NOT NULL,
        acquired_at_ms bigint NOT NULL,
        updated_at_ms bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS firstmeasure_import_projects (
        run_id text NOT NULL,
        project_id text NOT NULL,
        source_sha256 text NOT NULL,
        PRIMARY KEY (run_id, project_id)
      );
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS queue_group text NOT NULL DEFAULT '';
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS queue_priority integer NOT NULL DEFAULT 3;
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS queue_order_ms bigint NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_hold_status text NOT NULL DEFAULT '';
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS force_kick_email text NOT NULL DEFAULT '';
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS force_kick_acknowledged integer NOT NULL DEFAULT 0;
      CREATE OR REPLACE FUNCTION firstmeasure_adjust_queue_counter(
        p_scope text, p_team_id text, p_group text, p_instant integer, p_delta integer
      ) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF coalesce(p_group, '') = '' THEN RETURN; END IF;
        INSERT INTO project_queue_counters (scope, team_id, queue_group, instant_only, project_count)
        VALUES (p_scope, coalesce(p_team_id, ''), p_group, p_instant, p_delta)
        ON CONFLICT (scope, team_id, queue_group, instant_only)
        DO UPDATE SET project_count = project_queue_counters.project_count + EXCLUDED.project_count;
      END;
      $$;
      CREATE OR REPLACE FUNCTION firstmeasure_projects_queue_counter_trigger()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
          (OLD.queue_group, OLD.team_id, OLD.instant_only) IS DISTINCT FROM
          (NEW.queue_group, NEW.team_id, NEW.instant_only)) THEN
          PERFORM firstmeasure_adjust_queue_counter('all', '', OLD.queue_group, OLD.instant_only, -1);
          IF OLD.team_id <> '' THEN
            PERFORM firstmeasure_adjust_queue_counter('team', OLD.team_id, OLD.queue_group, OLD.instant_only, -1);
          END IF;
        END IF;
        IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
          (OLD.queue_group, OLD.team_id, OLD.instant_only) IS DISTINCT FROM
          (NEW.queue_group, NEW.team_id, NEW.instant_only)) THEN
          PERFORM firstmeasure_adjust_queue_counter('all', '', NEW.queue_group, NEW.instant_only, 1);
          IF NEW.team_id <> '' THEN
            PERFORM firstmeasure_adjust_queue_counter('team', NEW.team_id, NEW.queue_group, NEW.instant_only, 1);
          END IF;
        END IF;
        IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
          (OLD.queue_group, OLD.reserved_to_email, OLD.assigned_to_email, OLD.thumbnail_artifact_name, OLD.instant_only) IS DISTINCT FROM
          (NEW.queue_group, NEW.reserved_to_email, NEW.assigned_to_email, NEW.thumbnail_artifact_name, NEW.instant_only)) THEN
          IF OLD.queue_group = 'queued' AND OLD.assigned_to_email = '' AND OLD.thumbnail_artifact_name <> '' THEN
            IF OLD.reserved_to_email = '' THEN
              PERFORM firstmeasure_adjust_queue_counter('claim_unreserved', '', 'queued', OLD.instant_only, -1);
            ELSE
              PERFORM firstmeasure_adjust_queue_counter('claim_reserved', OLD.reserved_to_email, 'queued', OLD.instant_only, -1);
            END IF;
          END IF;
        END IF;
        IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
          (OLD.queue_group, OLD.reserved_to_email, OLD.assigned_to_email, OLD.thumbnail_artifact_name, OLD.instant_only) IS DISTINCT FROM
          (NEW.queue_group, NEW.reserved_to_email, NEW.assigned_to_email, NEW.thumbnail_artifact_name, NEW.instant_only)) THEN
          IF NEW.queue_group = 'queued' AND NEW.assigned_to_email = '' AND NEW.thumbnail_artifact_name <> '' THEN
            IF NEW.reserved_to_email = '' THEN
              PERFORM firstmeasure_adjust_queue_counter('claim_unreserved', '', 'queued', NEW.instant_only, 1);
            ELSE
              PERFORM firstmeasure_adjust_queue_counter('claim_reserved', NEW.reserved_to_email, 'queued', NEW.instant_only, 1);
            END IF;
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS projects_queue_counter_trigger ON projects;
      CREATE TRIGGER projects_queue_counter_trigger
        AFTER INSERT OR DELETE OR UPDATE OF queue_group, team_id, instant_only, reserved_to_email,
          assigned_to_email, thumbnail_artifact_name ON projects
        FOR EACH ROW EXECUTE FUNCTION firstmeasure_projects_queue_counter_trigger();
      CREATE INDEX IF NOT EXISTS idx_projects_status_sort ON projects (status, sort_ts DESC, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_org_status_sort ON projects (organization_id, status, sort_ts DESC, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_team_status_sort ON projects (team_id, status, sort_ts DESC, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_owner_email_sort ON projects (owner_email, sort_ts DESC, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_instant_only_sort ON projects (instant_only, sort_ts DESC, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_assigned_status ON projects (assigned_to_email, status, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_reserved_status ON projects (reserved_to_email, status, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_address_normalized ON projects (address_normalized);
      CREATE INDEX IF NOT EXISTS idx_projects_started_at_ms ON projects (started_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_uploaded_at_ms ON projects (uploaded_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_completed_at_ms ON projects (completed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_rejected_at_ms ON projects (rejected_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_cancelled_at_ms ON projects (cancelled_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_search_vector ON projects USING gin (search_vector);
      CREATE INDEX IF NOT EXISTS idx_projects_queue_order
        ON projects (queue_group, queue_priority, queue_order_ms, id);
      CREATE INDEX IF NOT EXISTS idx_projects_team_queue_order
        ON projects (team_id, queue_group, queue_priority, queue_order_ms, id);
      CREATE INDEX IF NOT EXISTS idx_projects_claim_queue
        ON projects (queue_priority, queued_at_ms, created_at_ms, id)
        WHERE queue_group = 'queued' AND assigned_to_email = '' AND thumbnail_artifact_name <> '' AND is_filler = 0;
      CREATE INDEX IF NOT EXISTS idx_projects_reserved_claim_queue
        ON projects (reserved_to_email, queue_priority, queued_at_ms, created_at_ms, id)
        WHERE queue_group = 'queued' AND assigned_to_email = '' AND thumbnail_artifact_name <> '' AND is_filler = 0;
      CREATE INDEX IF NOT EXISTS idx_projects_unreserved_claim_queue
        ON projects (queue_priority, queued_at_ms, created_at_ms, id)
        WHERE queue_group = 'queued' AND assigned_to_email = '' AND reserved_to_email = ''
          AND thumbnail_artifact_name <> '' AND is_filler = 0;
      CREATE INDEX IF NOT EXISTS idx_projects_active_assignment
        ON projects (assigned_to_email, updated_at_ms DESC, id DESC)
        WHERE status IN ('processing','in_progress','correction_needed','awaiting_review','awaiting_manager_review');
      CREATE INDEX IF NOT EXISTS idx_projects_correction_available
        ON projects (correction_to_email, updated_at_ms, id)
        WHERE status = 'correction_needed' AND assigned_to_email = '';
      CREATE INDEX IF NOT EXISTS idx_projects_force_kick
        ON projects (force_kick_email, force_kick_acknowledged) WHERE force_kick_email <> '';
      CREATE INDEX IF NOT EXISTS idx_project_queue_events_project ON project_queue_events (project_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_project_queue_events_team_version ON project_queue_events (team_id, version ASC);
      CREATE INDEX IF NOT EXISTS idx_firstmeasure_jobs_claim ON firstmeasure_jobs (status, available_at_ms, priority DESC, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_firstmeasure_jobs_lease ON firstmeasure_jobs (status, lease_until_ms);
      CREATE INDEX IF NOT EXISTS idx_firstmeasure_jobs_type_status ON firstmeasure_jobs (type, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_firstmeasure_locks_expires ON firstmeasure_locks (expires_at_ms);
    `);
    await client.query(
      "INSERT INTO firstmeasure_schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING"
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      `PostgreSQL schema initialization failed. Ensure firstmeasure_app has CREATE permission on the public schema. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

async function migrateDerivedQueueColumns(client: PoolClient, alreadyDerived = false) {
  const applied = await client.query<{ applied: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM firstmeasure_schema_migrations WHERE version = $1) AS applied",
    [SCHEMA_VERSION]
  );
  if (applied.rows[0]?.applied) return;

  if (!alreadyDerived) {
    // Existing databases created by an older build must derive the queue
    // columns from their canonical JSON once. A fresh import from this build
    // already produced those columns and deliberately skips this duplicate
    // full-table pass.
    let afterId = "";
    const batchSize = Math.max(25, Math.min(1000, Math.floor(env.postgresMigrationBatchSize)));
    while (true) {
      const rows = await client.query<{
        id: string;
        manifest_json: unknown;
        storage_path: string;
        thumbnail_artifact_name: string;
      }>(`
        SELECT id, manifest_json, storage_path, thumbnail_artifact_name
        FROM projects
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2
      `, [afterId, batchSize]);
      if (!rows.rows.length) break;
      const documents = rows.rows.map((row) => indexedDocument(manifestFromValue(row.manifest_json), {
        storagePath: row.storage_path,
        currentThumbnailArtifactName: row.thumbnail_artifact_name
      }));
      await upsertDocumentBatch(client, documents, undefined, false);
      afterId = rows.rows.at(-1)!.id;
    }
  }

  await rebuildPostgresQueueCounters(client);
  await client.query(
    "INSERT INTO firstmeasure_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
    [SCHEMA_VERSION]
  );
}

async function rebuildPostgresQueueCounters(client: PoolClient) {
  await client.query("TRUNCATE project_queue_counters");
  await client.query(`
    INSERT INTO project_queue_counters (scope, team_id, queue_group, instant_only, project_count)
    SELECT 'all', '', queue_group, instant_only, COUNT(*)
    FROM projects WHERE queue_group <> ''
    GROUP BY queue_group, instant_only
  `);
  await client.query(`
    INSERT INTO project_queue_counters (scope, team_id, queue_group, instant_only, project_count)
    SELECT 'team', team_id, queue_group, instant_only, COUNT(*)
    FROM projects WHERE queue_group <> '' AND team_id <> ''
    GROUP BY team_id, queue_group, instant_only
  `);
  await client.query(`
    INSERT INTO project_queue_counters (scope, team_id, queue_group, instant_only, project_count)
    SELECT CASE WHEN reserved_to_email = '' THEN 'claim_unreserved' ELSE 'claim_reserved' END,
      reserved_to_email, 'queued', instant_only, COUNT(*)
    FROM projects
    WHERE queue_group = 'queued' AND assigned_to_email = '' AND thumbnail_artifact_name <> ''
    GROUP BY reserved_to_email, instant_only
  `);
}

async function importProjectsIfNeeded(client: PoolClient) {
  const sourceCheckpoint = await projectImportSourceCheckpoint();
  const result = await client.query<{ value: Record<string, unknown> }>(
    "SELECT value FROM firstmeasure_migration_state WHERE key = $1",
    [IMPORT_KEY]
  );
  const state = result.rows[0]?.value ?? {};
  if (String(state.status ?? "") === "complete" && String(state.source_checkpoint ?? "") === sourceCheckpoint) {
    return Number(state.indexed_schema_version ?? 0) >= SCHEMA_VERSION;
  }
  // SQLite updates its index file for every project mutation. Comparing that
  // checkpoint makes a rollback-to-SQLite followed by a later PostgreSQL
  // cutover reconcile automatically, without rescanning 50k+ manifests on
  // every ordinary PostgreSQL restart.
  await runProjectImport(client, true, sourceCheckpoint);
  return true;
}

async function projectImportSourceCheckpoint() {
  const indexPath = path.resolve(process.cwd(), env.firstmeasureIndexDbPath);
  const paths = [indexPath, `${indexPath}-wal`, `${indexPath}-shm`];
  const parts = await Promise.all(paths.map(async (filePath) => {
    const info = await stat(filePath).catch(() => null);
    return info ? `${path.basename(filePath)}:${info.size}:${Math.floor(info.mtimeMs)}` : `${path.basename(filePath)}:missing`;
  }));
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

async function runProjectImport(client: PoolClient, force: boolean, sourceCheckpoint = "") {
  const runId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  const startedAt = new Date().toISOString();
  await writeMigrationState(client, IMPORT_KEY, {
    status: "running", run_id: runId, started_at: startedAt, imported: 0, source_checkpoint: sourceCheckpoint
  });
  await client.query("DELETE FROM firstmeasure_import_projects WHERE run_id = $1", [runId]);
  const root = path.resolve(process.cwd(), env.firstmeasureStorageRoot, "projects");
  const rootExists = await stat(root).then((entry) => entry.isDirectory()).catch(() => false);
  if (!rootExists && !env.postgresAllowEmptyImport) {
    throw new Error(
      `PostgreSQL import source '${root}' does not exist. Refusing to mark an empty production migration complete.`
    );
  }
  if (!rootExists) await mkdir(root, { recursive: true });

  let imported = 0;
  let visited = 0;
  const fatalFailures: Array<{ path: string; error: string }> = [];
  const invalidManifests: Array<{ path: string; error: string; project_id: string }> = [];
  const protectedInvalidIds = new Set<string>();
  let batch: IndexedDocument[] = [];
  const stack = [root];
  const batchSize = Math.max(25, Math.min(1000, Math.floor(env.postgresMigrationBatchSize)));

  while (stack.length) {
    const directory = stack.pop();
    if (!directory) continue;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      fatalFailures.push({ path: directory, error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    if (fileNames.includes(FIRSTMEASURE_FILE_NAMES.manifest)) {
      const manifestPath = path.join(directory, FIRSTMEASURE_FILE_NAMES.manifest);
      visited += 1;
      try {
        const raw = await readFile(manifestPath, "utf8");
        const manifest = JSON.parse(raw) as ProjectManifest;
        if (!String(manifest.id ?? "").trim()) throw new Error("Manifest is missing id.");
        const document = indexedDocument(manifest, { storagePath: directory, fileNames });
        batch.push(document);
        if (batch.length >= batchSize) {
          await upsertDocumentBatch(client, batch, runId, false);
          imported += batch.length;
          batch = [];
          await writeMigrationState(client, IMPORT_KEY, { status: "running", run_id: runId, started_at: startedAt, imported, visited });
        }
      } catch (error) {
        const inferredId = path.basename(directory).trim().toLowerCase();
        const projectId = /^[a-z0-9_-]+$/.test(inferredId) ? inferredId : "";
        if (projectId) protectedInvalidIds.add(projectId);
        invalidManifests.push({
          path: manifestPath,
          error: error instanceof Error ? error.message : String(error),
          project_id: projectId
        });
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "manifest_backups") stack.push(path.join(directory, entry.name));
    }
  }

  if (batch.length) {
    await upsertDocumentBatch(client, batch, runId, false);
    imported += batch.length;
  }

  const tooManyInvalid = invalidManifests.length > env.postgresImportMaxInvalidManifests;
  if (fatalFailures.length || tooManyInvalid) {
    const failures = [...fatalFailures, ...invalidManifests];
    const failure = {
      status: "failed",
      run_id: runId,
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      imported,
      visited,
      failure_count: failures.length,
      invalid_manifest_limit: env.postgresImportMaxInvalidManifests,
      failures: failures.slice(0, 100)
    };
    await writeMigrationState(client, IMPORT_KEY, failure);
    throw new Error(
      `PostgreSQL project import refused cutover because ${fatalFailures.length} filesystem error(s) and ` +
      `${invalidManifests.length} invalid manifest(s) were found (allowed invalid limit ${env.postgresImportMaxInvalidManifests}).`
    );
  }

  if (visited === 0 && !env.postgresAllowEmptyImport) {
    const failure = {
      status: "failed", run_id: runId, started_at: startedAt, failed_at: new Date().toISOString(), imported, visited,
      failure_count: 1, failures: [{ path: root, error: "No project manifest files were found." }]
    };
    await writeMigrationState(client, IMPORT_KEY, failure);
    throw new Error(`PostgreSQL import found no project manifests under '${root}'. Refusing an empty production cutover.`);
  }

  const validation = await validateImport(client, runId, imported);
  if (!validation.valid) {
    await writeMigrationState(client, IMPORT_KEY, {
      status: "failed", run_id: runId, started_at: startedAt, failed_at: new Date().toISOString(), imported, validation
    });
    throw new Error(`PostgreSQL project import validation failed: ${JSON.stringify(validation)}`);
  }

  if (force) {
    const total = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM projects");
    if (Number(total.rows[0]?.count ?? 0) > imported) {
      while (true) {
        const deleted = await client.query<{ id: string }>(`
          DELETE FROM projects
          WHERE id IN (
            (SELECT id FROM projects WHERE NOT (id = ANY($2::text[])))
            EXCEPT
            (SELECT project_id FROM firstmeasure_import_projects WHERE run_id = $1)
            LIMIT 1000
          )
          RETURNING id
        `, [runId, Array.from(protectedInvalidIds)]);
        if (deleted.rowCount === 0) break;
      }
    }
  }
  const finishedAt = new Date().toISOString();
  await writeMigrationState(client, IMPORT_KEY, {
    status: "complete", run_id: runId, started_at: startedAt, finished_at: finishedAt, imported, visited, validation,
    source_checkpoint: sourceCheckpoint,
    indexed_schema_version: SCHEMA_VERSION,
    warning_count: invalidManifests.length,
    warnings: invalidManifests.slice(0, 100)
  });
  while (true) {
    const deleted = await client.query(`
      DELETE FROM firstmeasure_import_projects
      WHERE ctid IN (
        SELECT ctid FROM firstmeasure_import_projects WHERE run_id <> $1 LIMIT 5000
      )
    `, [runId]);
    if (deleted.rowCount === 0) break;
  }
  return { runId, imported, startedAt, finishedAt };
}

async function writeMigrationState(client: PoolClient, key: string, value: Record<string, unknown>) {
  await client.query(`
    INSERT INTO firstmeasure_migration_state (key, value, updated_at)
    VALUES ($1, $2::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `, [key, JSON.stringify(value)]);
}

function indexedDocument(
  manifest: ProjectManifest,
  options: { storagePath?: string; fileNames?: string[]; currentThumbnailArtifactName?: string; artifactFileName?: string } = {}
): IndexedDocument {
  const built = buildIndexedProjectDocument(manifest, {
    currentThumbnailArtifactName: options.currentThumbnailArtifactName ?? "",
    storagePath: options.storagePath,
    fileNames: options.fileNames,
    artifactFileName: options.artifactFileName ?? ""
  }) as Record<string, unknown>;
  const canonical = String(built.manifest_json ?? "{}");
  return {
    ...built,
    id: String(built.id ?? ""),
    manifest_json: JSON.parse(canonical),
    source_sha256: createHash("sha256").update(canonical).digest("hex")
  };
}

async function upsertDocumentBatch(client: PoolClient, documents: IndexedDocument[], runId?: string, recordEvent = true) {
  if (!documents.length) return;
  const previous = recordEvent
    ? await client.query<Record<string, unknown>>(`
        SELECT id, status, team_id, assigned_to_email, reserved_to_email, correction_to_email, qa_claimed_by_email,
          queue_group, queue_priority
        FROM projects WHERE id = ANY($1::text[])
      `, [documents.map((document) => document.id)])
    : { rows: [] as Record<string, unknown>[] };
  const previousById = new Map(previous.rows.map((row) => [String(row.id), row]));
  const recordset = PROJECT_COLUMNS.map((column) => `${column} ${RECORDSET_TYPES[column]}`).join(", ");
  const updates = PROJECT_COLUMNS.filter((column) => column !== "id")
    .map((column) => `${column} = EXCLUDED.${column}`).join(",\n");
  await client.query(`
    INSERT INTO projects (${PROJECT_COLUMNS.join(", ")})
    SELECT ${PROJECT_COLUMNS.map((column) => `x.${column}`).join(", ")}
    FROM jsonb_to_recordset($1::jsonb) AS x(${recordset})
    ON CONFLICT (id) DO UPDATE SET
      ${updates},
      revision = projects.revision + 1,
      updated_db_at = now()
  `, [JSON.stringify(documents)]);

  if (runId) {
    await client.query(`
      INSERT INTO firstmeasure_import_projects (run_id, project_id, source_sha256)
      SELECT $1, x.id, x.source_sha256
      FROM jsonb_to_recordset($2::jsonb) AS x(id text, source_sha256 text)
      ON CONFLICT (run_id, project_id) DO UPDATE SET source_sha256 = EXCLUDED.source_sha256
    `, [runId, JSON.stringify(documents.map((document) => ({ id: document.id, source_sha256: document.source_sha256 }))) ]);
  }

  if (recordEvent) {
    for (const document of documents) await recordQueueEvent(client, previousById.get(document.id) ?? null, document);
    await pruneQueueEvents(client);
  }
}

async function validateImport(client: PoolClient, runId: string, expected: number) {
  const result = await client.query<{ imported: string; matched: string; mismatched: string }>(`
    SELECT
      COUNT(*)::text AS imported,
      COUNT(p.id)::text AS matched,
      COUNT(*) FILTER (WHERE p.id IS NULL OR p.source_sha256 <> i.source_sha256)::text AS mismatched
    FROM firstmeasure_import_projects i
    LEFT JOIN projects p ON p.id = i.project_id
    WHERE i.run_id = $1
  `, [runId]);
  const imported = Number(result.rows[0]?.imported ?? 0);
  const matched = Number(result.rows[0]?.matched ?? 0);
  const mismatched = Number(result.rows[0]?.mismatched ?? 0);
  return { valid: imported === expected && matched === expected && mismatched === 0, expected, imported, matched, mismatched };
}

export async function rebuildPostgresProjectIndex(): Promise<RebuildProjectIndexResult> {
  await ensurePostgresProjectIndexReady();
  return withPostgresClient(async (client) => {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`${MIGRATION_LOCK}-rebuild`]);
    try {
      const result = await runProjectImport(client, true, await projectImportSourceCheckpoint());
      return { dbPath: "postgresql:managed", indexedProjects: result.imported, startedAt: result.startedAt, finishedAt: result.finishedAt };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`${MIGRATION_LOCK}-rebuild`]).catch(() => undefined);
    }
  });
}

export async function getPostgresProjectIndexStatus(): Promise<ProjectIndexStatus> {
  await ensurePostgresProjectIndexReady();
  const [count, migration] = await Promise.all([
    queryPostgres<{ count: string }>("SELECT COUNT(*)::text AS count FROM projects"),
    queryPostgres<{ value: Record<string, unknown> }>("SELECT value FROM firstmeasure_migration_state WHERE key = $1", [IMPORT_KEY])
  ]);
  const value = migration.rows[0]?.value ?? {};
  return {
    dbPath: "postgresql:managed",
    indexedProjects: Number(count.rows[0]?.count ?? 0),
    ftsEnabled: true,
    schemaVersion: SCHEMA_VERSION,
    backfillComplete: value.status === "complete",
    lastRebuildStartedAt: stringOrNull(value.started_at),
    lastRebuildFinishedAt: stringOrNull(value.finished_at),
    lastRebuildCount: value.imported == null ? null : Number(value.imported)
  };
}

export async function listPostgresProjectManifests(): Promise<ProjectManifest[]> {
  await ensurePostgresProjectIndexReady();
  const result = await queryPostgres<{ manifest_json: unknown }>(
    "SELECT manifest_json FROM projects ORDER BY sort_ts DESC, updated_at_ms DESC, id DESC"
  );
  return result.rows.map((row) => manifestFromValue(row.manifest_json));
}

export async function findPostgresProjectByNormalizedAddress(address: string): Promise<ProjectManifest | null> {
  const rows = await findPostgresProjectsByNormalizedAddress(address, { limit: 1 });
  return rows[0] ?? null;
}

export async function findPostgresProjectsByNormalizedAddress(address: string, options: { limit?: number } = {}) {
  await ensurePostgresProjectIndexReady();
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
  const result = await queryPostgres<{ manifest_json: unknown }>(`
    SELECT manifest_json FROM projects WHERE address_normalized = $1
    ORDER BY sort_ts DESC, updated_at_ms DESC, id DESC LIMIT $2
  `, [normalizeSearch(address), limit]);
  return result.rows.map((row) => manifestFromValue(row.manifest_json));
}

export async function queryPostgresProjectManifests(query: ProjectIndexManifestQuery) {
  await ensurePostgresProjectIndexReady();
  const built = buildProjectWhere(query);
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 20_000);
  const count = await queryPostgres<{ count: string }>(`SELECT COUNT(*)::text AS count FROM projects p WHERE ${built.where.join(" AND ")}`, built.values);
  const values = [...built.values, limit];
  const rows = await queryPostgres<{ manifest_json: unknown }>(`
    SELECT p.manifest_json FROM projects p WHERE ${built.where.join(" AND ")}
    ORDER BY p.sort_ts DESC, p.updated_at_ms DESC, p.id DESC LIMIT $${values.length}
  `, values);
  return { count: Number(count.rows[0]?.count ?? 0), projects: rows.rows.map((row) => manifestFromValue(row.manifest_json)) };
}

function buildProjectWhere(query: ProjectIndexManifestQuery) {
  const where = ["TRUE"];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
  if (query.owner_email) add("p.owner_email = ?", String(query.owner_email).trim().toLowerCase());
  if (query.organization_id) add("p.organization_id = ?", String(query.organization_id).trim());
  if (query.team_id) add("p.team_id = ?", String(query.team_id).trim());
  if (query.project_type) add("p.project_type = ?", String(query.project_type).trim());
  if (typeof query.has_report_pdf === "boolean") add("p.has_report_pdf = ?", query.has_report_pdf ? 1 : 0);
  if (query.statuses?.length) { values.push(query.statuses.map(String)); where.push(`p.status = ANY($${values.length}::text[])`); }
  if (!query.includeInstantOnly) where.push("p.instant_only = 0");
  appendSearch(where, values, query.search);
  appendActivity(where, values, query.activityStartMs ?? null, query.activityEndMs ?? null, query.activityFields);
  return { where, values };
}

export async function getPostgresQueueCounts(query: QueueCountsQuery = {}) {
  await ensurePostgresProjectIndexReady();
  if (query.activityStartMs == null && query.activityEndMs == null) {
    const scope = query.team_id ? "team" : "all";
    const teamId = query.team_id ? String(query.team_id).trim() : "";
    const values: unknown[] = [scope, teamId];
    const instantFilter = query.includeInstantOnly ? "" : "AND instant_only = 0";
    const result = await queryPostgres<{ group_id: string; count: string }>(`
      SELECT queue_group AS group_id, SUM(project_count)::text AS count
      FROM project_queue_counters
      WHERE scope = $1 AND team_id = $2 ${instantFilter} AND project_count <> 0
      GROUP BY queue_group
    `, values);
    const groups = emptyQueueCounts();
    for (const row of result.rows) {
      const group = normalizeQueueGroup(row.group_id);
      if (group) groups[group] += Number(row.count);
    }
    return {
      groups,
      total: Object.values(groups).reduce((sum, count) => sum + count, 0),
      version: await readQueueVersion()
    };
  }
  const where = ["TRUE"];
  const values: unknown[] = [];
  if (query.team_id) { values.push(String(query.team_id).trim()); where.push(`p.team_id = $${values.length}`); }
  if (!query.includeInstantOnly) where.push("p.instant_only = 0");
  appendActivity(where, values, query.activityStartMs ?? null, query.activityEndMs ?? null, query.activityFields);
  const result = await queryPostgres<{ group_id: string; count: string }>(`
    SELECT p.queue_group AS group_id, COUNT(*)::text AS count
    FROM projects p
    WHERE ${where.join(" AND ")} AND p.queue_group <> ''
    GROUP BY p.queue_group
  `, values);
  const groups = emptyQueueCounts();
  for (const row of result.rows) {
    const group = normalizeQueueGroup(row.group_id);
    if (group) groups[group] += Number(row.count);
  }
  return { groups, total: Object.values(groups).reduce((sum, count) => sum + count, 0), version: await readQueueVersion() };
}

export async function queryPostgresQueueBucket(query: QueueBucketQuery) {
  await ensurePostgresProjectIndexReady();
  const group = normalizeQueueGroup(query.group) ?? "queued";
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 500);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  const where = ["p.queue_group = $1"];
  const values: unknown[] = [group];
  if (query.team_id) { values.push(String(query.team_id).trim()); where.push(`p.team_id = $${values.length}`); }
  if (!query.includeInstantOnly) where.push("p.instant_only = 0");
  appendActivity(where, values, query.activityStartMs ?? null, query.activityEndMs ?? null, query.activityFields);
  let count = 0;
  if (query.activityStartMs == null && query.activityEndMs == null) {
    const countResult = await queryPostgres<{ count: string }>(`
      SELECT COALESCE(SUM(project_count), 0)::text AS count
      FROM project_queue_counters
      WHERE scope = $1 AND team_id = $2 AND queue_group = $3
        ${query.includeInstantOnly ? "" : "AND instant_only = 0"}
    `, [query.team_id ? "team" : "all", query.team_id ? String(query.team_id).trim() : "", group]);
    count = Number(countResult.rows[0]?.count ?? 0);
  } else {
    const countResult = await queryPostgres<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM projects p WHERE ${where.join(" AND ")}`,
      values
    );
    count = Number(countResult.rows[0]?.count ?? 0);
  }
  const pagingValues = [...values, limit, offset];
  const pagingSql = `LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
  const result = await queryPostgres<{ manifest_json: unknown; thumbnail_artifact_name: string }>(`
    SELECT p.manifest_json, p.thumbnail_artifact_name FROM projects p WHERE ${where.join(" AND ")}
    ${queueGroupOrderSql("p", group)} ${pagingSql}
  `, pagingValues);
  const parsed = result.rows.map((row) => ({ manifest: manifestFromValue(row.manifest_json), thumbnailArtifactName: row.thumbnail_artifact_name || null }));
  const rows = parsed;
  const nextOffset = offset + rows.length;
  return {
    group, count, rows,
    pagination: { limit, offset, next_offset: nextOffset < count ? nextOffset : null, has_more: nextOffset < count },
    version: await readQueueVersion()
  };
}

export async function readPostgresQueueChanges(query: QueueChangesQuery = {}) {
  await ensurePostgresProjectIndexReady();
  const since = Math.max(0, Math.floor(Number(query.since ?? 0)));
  const limit = Math.min(Math.max(Math.floor(Number(query.limit ?? 250)), 1), 1000);
  const values: unknown[] = [since];
  const where = ["version > $1"];
  if (query.team_id) { values.push(String(query.team_id).trim()); where.push(`team_id = $${values.length}`); }
  values.push(limit);
  const result = await queryPostgres<Record<string, unknown>>(`
    SELECT version, project_id, event_type, status, previous_status, queue_group, previous_queue_group,
      team_id, actor_email, created_at, payload_json
    FROM project_queue_events WHERE ${where.join(" AND ")} ORDER BY version ASC LIMIT $${values.length}
  `, values);
  const version = await readQueueVersion();
  return {
    since, version,
    has_more: result.rows.length === limit && Number(result.rows.at(-1)?.version ?? 0) < version,
    changes: result.rows.map((row) => ({
      version: Number(row.version ?? 0), project_id: String(row.project_id ?? ""), event_type: String(row.event_type ?? ""),
      status: String(row.status ?? ""), previous_status: String(row.previous_status ?? "") || null,
      queue_group: String(row.queue_group ?? ""), previous_queue_group: String(row.previous_queue_group ?? "") || null,
      team_id: String(row.team_id ?? ""), actor_email: String(row.actor_email ?? "") || null,
      created_at: new Date(String(row.created_at ?? "")).toISOString(), payload: objectValue(row.payload_json)
    }))
  };
}

export async function isFirstPostgresDeliveredReportForIssuer(manifest: ProjectManifest) {
  await ensurePostgresProjectIndexReady();
  const issuerEmail = String(objectValue(manifest.issuer).email ?? "").trim().toLowerCase();
  const projectId = String(manifest.id ?? "").trim();
  if (!issuerEmail || !projectId) return false;
  const result = await queryPostgres<{ manifest_json: unknown }>(`
    SELECT manifest_json FROM projects WHERE issuer_email = $1 AND status = 'completed' AND has_report_pdf = 1 AND is_filler = 0
    ORDER BY completed_at_ms ASC, updated_at_ms ASC, id ASC
  `, [issuerEmail]);
  let earliestId = "";
  let earliestAt = Number.MAX_SAFE_INTEGER;
  let currentAt = 0;
  for (const row of result.rows) {
    const candidate = manifestFromValue(row.manifest_json);
    const candidateId = String(candidate.id ?? "").trim();
    const deliveredAt = readDeliveryTimestamp(candidate);
    if (!candidateId || !deliveredAt) continue;
    if (deliveredAt < earliestAt || (deliveredAt === earliestAt && (!earliestId || candidateId < earliestId))) {
      earliestAt = deliveredAt;
      earliestId = candidateId;
    }
    if (candidateId === projectId) currentAt = deliveredAt;
  }
  return currentAt ? earliestId === projectId : !earliestId;
}

export async function searchPostgresProjectsForLegacyList(query: LegacyListQuery): Promise<LegacyListResult> {
  await ensurePostgresProjectIndexReady();
  const where = ["TRUE"];
  const values: unknown[] = [];
  if (!query.includeInstantOnly) where.push("p.instant_only = 0");
  appendLegacyVisibility(where, values, query.filter, query.actor);
  appendLegacyStatus(where, query.statusFilter);
  const complexity = String(query.complexityFilter ?? "").trim();
  if (/^[1-5]$/.test(complexity)) { values.push(complexity); where.push(`p.complexity = $${values.length}`); }
  appendSearch(where, values, query.search);
  appendActivity(where, values, query.activityStartMs ?? null, query.activityEndMs ?? null, query.activityFields);
  const count = await queryPostgres<{ count: string }>(`SELECT COUNT(*)::text AS count FROM projects p WHERE ${where.join(" AND ")}`, values);
  const searchText = normalizeSearch(query.search);
  const searchOrderValues = [...values];
  let order = "p.sort_ts DESC, p.updated_at_ms DESC, p.id DESC";
  if (searchText.length >= 2) {
    searchOrderValues.push(searchText, `${searchText}%`, `%${searchText}%`);
    const exact = `$${searchOrderValues.length - 2}`;
    const prefix = `$${searchOrderValues.length - 1}`;
    const contains = `$${searchOrderValues.length}`;
    order = `(CASE WHEN p.id_normalized = ${exact} THEN 220 WHEN p.id_normalized LIKE ${prefix} THEN 140 WHEN p.id_normalized LIKE ${contains} THEN 80 ELSE 0 END
      + CASE WHEN p.address_normalized = ${exact} THEN 180 WHEN p.address_normalized LIKE ${prefix} THEN 130 WHEN p.address_normalized LIKE ${contains} THEN 90 ELSE 0 END
      + CASE WHEN p.resident_name_normalized = ${exact} THEN 170 WHEN p.resident_name_normalized LIKE ${prefix} THEN 120 WHEN p.resident_name_normalized LIKE ${contains} THEN 95 ELSE 0 END) DESC,
      ts_rank_cd(p.search_vector, websearch_to_tsquery('simple', ${exact})) DESC, p.sort_ts DESC, p.updated_at_ms DESC, p.id DESC`;
  }
  searchOrderValues.push(query.limit, (query.page - 1) * query.limit);
  const result = await queryPostgres<{ manifest_json: unknown; thumbnail_artifact_name: string }>(`
    SELECT p.manifest_json, p.thumbnail_artifact_name FROM projects p WHERE ${where.join(" AND ")}
    ORDER BY ${order} LIMIT $${searchOrderValues.length - 1} OFFSET $${searchOrderValues.length}
  `, searchOrderValues);
  return {
    totalCount: Number(count.rows[0]?.count ?? 0),
    rows: result.rows.map((row) => ({ manifest: manifestFromValue(row.manifest_json), thumbnailArtifactName: row.thumbnail_artifact_name || null }))
  };
}

export async function readPostgresProjectArtifactState(projectId: string) {
  await ensurePostgresProjectIndexReady();
  const result = await queryPostgres<Record<string, unknown>>(`
    SELECT has_insights, has_pdf_state, has_report_pdf, has_summary_pdf, has_model_data,
      has_google_image, has_mask_tif, has_dsm_tif FROM projects WHERE id = $1
  `, [projectId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    has_insights: Boolean(row.has_insights), has_pdf_state: Boolean(row.has_pdf_state), has_report_pdf: Boolean(row.has_report_pdf),
    has_main_pdf: Boolean(row.has_report_pdf), has_summary_pdf: Boolean(row.has_summary_pdf), has_model_data: Boolean(row.has_model_data),
    has_google_image: Boolean(row.has_google_image), has_mask_tif: Boolean(row.has_mask_tif), has_dsm_tif: Boolean(row.has_dsm_tif)
  };
}

export async function upsertPostgresProjectIndex(
  manifest: ProjectManifest,
  options?: { storagePath?: string; fileNames?: string[]; artifactFileName?: string | null }
) {
  await ensurePostgresProjectIndexReady();
  await withPostgresTransaction(async (client) => {
    const current = await client.query<{ thumbnail_artifact_name: string }>("SELECT thumbnail_artifact_name FROM projects WHERE id = $1", [manifest.id]);
    const document = indexedDocument(manifest, {
      currentThumbnailArtifactName: current.rows[0]?.thumbnail_artifact_name ?? "",
      storagePath: options?.storagePath,
      fileNames: options?.fileNames,
      artifactFileName: options?.artifactFileName ?? ""
    });
    await upsertDocumentBatch(client, [document], undefined, true);
  });
}

export async function readPostgresManifestById(projectId: string): Promise<ProjectManifest | null> {
  await ensurePostgresProjectIndexReady();
  const result = await queryPostgres<{ manifest_json: unknown }>("SELECT manifest_json FROM projects WHERE id = $1", [projectId]);
  return result.rows[0] ? manifestFromValue(result.rows[0].manifest_json) : null;
}

export async function mutatePostgresManifest(
  projectId: string,
  mutate: (manifest: ProjectManifest) => ProjectManifest | Promise<ProjectManifest>,
  options?: { storagePath?: string; fileNames?: string[]; artifactFileName?: string | null }
) {
  await ensurePostgresProjectIndexReady();
  return withPostgresTransaction(async (client) => {
    const current = await client.query<{ manifest_json: unknown; thumbnail_artifact_name: string }>(
      "SELECT manifest_json, thumbnail_artifact_name FROM projects WHERE id = $1 FOR UPDATE",
      [projectId]
    );
    if (!current.rows[0]) return null;
    const manifest = await mutate(manifestFromValue(current.rows[0].manifest_json));
    const document = indexedDocument(manifest, {
      currentThumbnailArtifactName: current.rows[0].thumbnail_artifact_name ?? "",
      storagePath: options?.storagePath,
      fileNames: options?.fileNames,
      artifactFileName: options?.artifactFileName ?? ""
    });
    await upsertDocumentBatch(client, [document], undefined, true);
    return manifest;
  });
}

export async function upsertPostgresProjectIndexWithClient(
  client: PoolClient,
  manifest: ProjectManifest,
  options?: { storagePath?: string; fileNames?: string[]; artifactFileName?: string | null; currentThumbnailArtifactName?: string }
) {
  const document = indexedDocument(manifest, {
    currentThumbnailArtifactName: options?.currentThumbnailArtifactName ?? "",
    storagePath: options?.storagePath,
    fileNames: options?.fileNames,
    artifactFileName: options?.artifactFileName ?? ""
  });
  await upsertDocumentBatch(client, [document], undefined, true);
}

export async function readPostgresQueueVersion() {
  await ensurePostgresProjectIndexReady();
  return readQueueVersion();
}

export async function queryPostgresRows<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  await ensurePostgresProjectIndexReady();
  return (await queryPostgres<T>(text, values)).rows;
}

async function readQueueVersion() {
  const result = await queryPostgres<{ version: string }>("SELECT COALESCE(MAX(version), 0)::text AS version FROM project_queue_events");
  return Number(result.rows[0]?.version ?? 0);
}

async function recordQueueEvent(client: PoolClient, previous: Record<string, unknown> | null, next: IndexedDocument) {
  const currentSnapshot = snapshot(next);
  const previousSnapshot = previous ? snapshot(previous) : null;
  if (previousSnapshot && !snapshotChanged(previousSnapshot, currentSnapshot)) return;
  const previousGroup = previousSnapshot ? queueGroupFromSnapshot(previousSnapshot) : "";
  const currentGroup = queueGroupFromSnapshot(currentSnapshot);
  const eventType = !previousSnapshot ? "project_indexed" : previousSnapshot.status !== currentSnapshot.status ? "status_changed" : "queue_fields_changed";
  const payload = { previous: previousSnapshot, current: currentSnapshot };
  await client.query(`
    INSERT INTO project_queue_events (event_id, project_id, event_type, status, previous_status, queue_group,
      previous_queue_group, team_id, actor_email, created_at, payload_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'',now(),$9::jsonb)
  `, [`${Date.now()}-${randomBytes(6).toString("hex")}`, currentSnapshot.id, eventType, currentSnapshot.status,
    previousSnapshot?.status ?? "", currentGroup, previousGroup, currentSnapshot.team_id, JSON.stringify(payload)]);
}

async function pruneQueueEvents(client: PoolClient) {
  queueEventsUntilPrune -= 1;
  if (queueEventsUntilPrune > 0) return;
  queueEventsUntilPrune = 250;
  await client.query(`
    DELETE FROM project_queue_events
    WHERE version <= COALESCE((SELECT MAX(version) - $1 FROM project_queue_events), 0)
  `, [QUEUE_EVENT_RETENTION_ROWS]);
}

function appendSearch(where: string[], values: unknown[], raw: unknown) {
  const search = normalizeSearch(raw);
  if (search.length < 2) return;
  values.push(search);
  where.push(`p.search_vector @@ websearch_to_tsquery('simple', $${values.length})`);
}

function appendActivity(
  where: string[], values: unknown[], start: number | null, end: number | null, fields?: ProjectActivityField[]
) {
  if (start == null && end == null) return;
  values.push(start ?? 0, end ?? 8_640_000_000_000_000);
  const lo = `$${values.length - 1}`;
  const hi = `$${values.length}`;
  const selected = fields?.length ? fields : ["started", "uploaded", "completed"];
  const allowed = new Set(["created", "queued", "processed", "started", "uploaded", "completed", "rejected", "cancelled", "updated"]);
  const clauses = selected.filter((field) => allowed.has(field)).map((field) => `p.${field}_at_ms BETWEEN ${lo} AND ${hi}`);
  if (clauses.length) where.push(`(${clauses.join(" OR ")})`);
}

function appendLegacyVisibility(where: string[], values: unknown[], filter: string, actor: LegacyListActor) {
  if (!actor) return;
  const email = String(actor.email ?? "").trim().toLowerCase();
  const team = String(actor.team_id ?? "").trim();
  const org = String(actor.organization_id ?? "").trim();
  const roles = (actor.roles ?? []).map((role) => String(role).toLowerCase());
  if (!email && !team && !org) return;
  if (filter === "all" && roles.some((role) => ["admin", "queue_admin", "manager"].includes(role))) return;
  values.push(email);
  const emailParam = `$${values.length}`;
  if (filter === "team" && team) {
    values.push(team); where.push(`((p.team_id = $${values.length} AND p.team_id <> '') OR p.assigned_to_email = ${emailParam})`); return;
  }
  if (filter === "org" && org) {
    values.push(org); where.push(`((p.organization_id = $${values.length} AND p.organization_id <> '') OR p.owner_email = ${emailParam} OR p.issuer_email = ${emailParam} OR p.assigned_to_email = ${emailParam})`); return;
  }
  where.push(`(p.owner_email = ${emailParam} OR p.issuer_email = ${emailParam} OR p.assigned_to_email = ${emailParam})`);
}

function appendLegacyStatus(where: string[], status: string) {
  if (!status || status === "all") return;
  if (status === "rejected") where.push("p.status IN ('rejected_no_coverage','rejected')");
  else if (status === "cancelled") where.push("p.status = 'cancelled'");
  else if (status === "ready") where.push("p.status = 'completed' AND p.has_report_pdf = 1");
  else if (status === "completed") where.push("p.status = 'completed'");
  else if (status === "processing") where.push("NOT (p.status = 'completed' AND p.has_report_pdf = 1) AND p.status NOT IN ('rejected_no_coverage','rejected','cancelled')");
}

function normalizeSearch(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9@._-]+/g, " ").replace(/\s+/g, " ").trim();
}

function manifestFromValue(value: unknown): ProjectManifest {
  if (typeof value === "string") return JSON.parse(value) as ProjectManifest;
  return objectValue(value) as ProjectManifest;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function readDeliveryTimestamp(manifest: ProjectManifest) {
  const record = objectValue(manifest);
  const delivery = objectValue(record.delivery);
  const email = objectValue(record.email_state);
  const deliveryEmail = objectValue(delivery.email_state);
  const report = objectValue(email.report_email);
  const deliveryReport = objectValue(deliveryEmail.report_email);
  const sent = Boolean(report.sent_ok) || Boolean(deliveryReport.sent_ok);
  const timestamp = String(record.report_sent_at ?? delivery.report_sent_at ?? report.sent_at_utc ?? deliveryReport.sent_at_utc ?? "").trim();
  if (timestamp) return Date.parse(timestamp) || 0;
  if (sent) return Date.parse(String(record.completed_at ?? objectValue(record.timestamps).completed_at ?? "")) || 0;
  return 0;
}

function emptyQueueCounts(): Record<FirstMeasureQueueGroup, number> {
  return Object.fromEntries(FIRSTMEASURE_QUEUE_GROUPS.map((group) => [group, 0])) as Record<FirstMeasureQueueGroup, number>;
}

function normalizeQueueGroup(value: unknown): FirstMeasureQueueGroup | null {
  const raw = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  const aliases: Record<string, FirstMeasureQueueGroup> = {
    rework: "rework_requested", reworking: "rework_requested", change_requests: "rework_requested", rework_requests: "rework_requested",
    structure_pins: "needs_structure_pins", needs_pins: "needs_structure_pins", needs_structure_pin: "needs_structure_pins",
    queue: "queued", queued_projects: "queued", ready: "queued", re_queue: "requeue", corrections: "requeue",
    progress: "in_progress", projects_in_progress: "in_progress", with_qa: "qa_claimed", projects_with_qa: "qa_claimed",
    qa: "qa_waiting", waiting_for_qa: "qa_waiting", projects_waiting_for_qa: "qa_waiting", release_hold: "release_holding",
    release_holds: "release_holding", holding_for_release: "release_holding", waiting_for_release: "release_holding", complete: "completed"
  };
  if (aliases[raw]) return aliases[raw];
  return FIRSTMEASURE_QUEUE_GROUPS.includes(raw as FirstMeasureQueueGroup) ? raw as FirstMeasureQueueGroup : null;
}

function queueGroupOrderSql(p: string, group: FirstMeasureQueueGroup) {
  if (group === "queued") return `ORDER BY ${p}.queue_priority ASC, ${p}.queue_order_ms ASC, ${p}.id ASC`;
  if (["rework_requested", "requeue", "waiting", "needs_structure_pins"].includes(group)) {
    return `ORDER BY ${p}.queue_priority ASC, ${p}.queue_order_ms ASC, ${p}.id ASC`;
  }
  if (group === "release_holding") return `ORDER BY ${p}.completed_at_ms ASC, ${p}.updated_at_ms ASC, ${p}.id ASC`;
  if (group === "completed") return `ORDER BY ${p}.completed_at_ms DESC, ${p}.updated_at_ms DESC, ${p}.id DESC`;
  if (group === "rejected") return `ORDER BY ${p}.rejected_at_ms DESC, ${p}.updated_at_ms DESC, ${p}.id DESC`;
  if (group === "cancelled") return `ORDER BY ${p}.cancelled_at_ms DESC, ${p}.updated_at_ms DESC, ${p}.id DESC`;
  return `ORDER BY ${p}.queue_priority ASC, ${p}.queue_order_ms ASC, ${p}.id ASC`;
}

type QueueSnapshot = {
  id: string;
  status: string;
  team_id: string;
  assigned_to_email: string;
  reserved_to_email: string;
  correction_to_email: string;
  qa_claimed_by_email: string;
  queue_group: string;
  queue_priority: number;
};
function snapshot(value: Record<string, unknown>): QueueSnapshot {
  return { id: String(value.id ?? ""), status: String(value.status ?? ""), team_id: String(value.team_id ?? ""),
    assigned_to_email: String(value.assigned_to_email ?? ""), reserved_to_email: String(value.reserved_to_email ?? ""),
    correction_to_email: String(value.correction_to_email ?? ""), qa_claimed_by_email: String(value.qa_claimed_by_email ?? ""),
    queue_group: String(value.queue_group ?? ""), queue_priority: Number(value.queue_priority ?? 3) };
}
function snapshotChanged(a: QueueSnapshot, b: QueueSnapshot) {
  return a.status !== b.status || a.team_id !== b.team_id || a.assigned_to_email !== b.assigned_to_email ||
    a.reserved_to_email !== b.reserved_to_email || a.correction_to_email !== b.correction_to_email ||
    a.qa_claimed_by_email !== b.qa_claimed_by_email || a.queue_group !== b.queue_group ||
    a.queue_priority !== b.queue_priority;
}
function queueGroupFromSnapshot(value: QueueSnapshot) {
  return value.queue_group;
}

export { getPostgresPool };
