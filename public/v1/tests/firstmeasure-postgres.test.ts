import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();
const projectCount = Math.max(500, Math.floor(Number(process.env.FIRSTMEASURE_POSTGRES_TEST_PROJECTS ?? 2_000)));
const scaleProjectCount = Math.max(10_000, Math.floor(Number(process.env.FIRSTMEASURE_POSTGRES_SCALE_PROJECTS ?? 100_000)));

function percentile(values: number[], percentileValue: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index] ?? 0;
}

async function measureConcurrent(total: number, concurrency: number, task: (index: number) => Promise<unknown>) {
  const times: number[] = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < total) {
      const index = cursor;
      cursor += 1;
      const started = performance.now();
      await task(index);
      times.push(performance.now() - started);
    }
  });
  await Promise.all(workers);
  return {
    requests: total,
    concurrency,
    p50_ms: Math.round(percentile(times, 0.5) * 10) / 10,
    p95_ms: Math.round(percentile(times, 0.95) * 10) / 10,
    max_ms: Math.round(Math.max(...times) * 10) / 10
  };
}

test("PostgreSQL migration, concurrency, jobs, and locks", { skip: !databaseUrl }, async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-postgres-test-"));
  const projectRoot = path.join(storageRoot, "projects");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.end();

  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_ADMIN_URL = databaseUrl;
  process.env.FIRSTMEASURE_STORAGE_ROOT = storageRoot;
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.POSTGRES_POOL_MAX = "24";
  process.env.POSTGRES_MIGRATION_BATCH_SIZE = "500";
  process.env.POSTGRES_AUTO_MIGRATE = "true";
  process.env.POSTGRES_ALLOW_EMPTY_IMPORT = "false";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";

  try {
    const baseTime = Date.now() - projectCount * 1_000;
    for (let start = 0; start < projectCount; start += 500) {
      await Promise.all(Array.from({ length: Math.min(500, projectCount - start) }, async (_, offset) => {
        const index = start + offset;
        const id = `pg-load-${String(index).padStart(6, "0")}`;
        const directory = path.join(projectRoot, id);
        await mkdir(directory, { recursive: true });
        const timestamp = new Date(baseTime + index * 1_000).toISOString();
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
          id,
          schema_version: 2,
          status: "queued",
          address: `${index} PostgreSQL Way, Test City, CA`,
          complexity: String(index % 5 + 1),
          is_vip: index % 101 === 0,
          is_expedited: index % 67 === 0,
          workflow: { assigned_to: null, reserved_to: null, correction_to: null, history: [] },
          timestamps: { created_at: timestamp, queued_at: timestamp, updated_at: timestamp }
        }), "utf8");
        await writeFile(path.join(directory, "azure.png"), new Uint8Array([1, 2, 3]));
      }));
    }

    const index = await import("../firstmeasure/project_index.js");
    const queue = await import("../firstmeasure/queue.js");
    const postgresIndex = await import("../firstmeasure/project_index_postgres.js");
    const jobs = await import("../firstmeasure/job_queue.js");
    const locks = await import("../firstmeasure/locks.js");
    const database = await import("../src/database/postgres.js");

    await index.ensureFirstMeasureProjectIndexReady();
    const status = await index.getFirstMeasureProjectIndexStatus();
    assert.equal(status.backfillComplete, true);
    assert.equal(status.indexedProjects, projectCount);

    const search = await index.queryIndexedProjectManifests({ search: "PostgreSQL Way", limit: 25 });
    assert.equal(search.count, projectCount);
    assert.equal(search.projects.length, 25);

    const reservedActor = { email: "reserved-tech@example.test", name: "Reserved Tech", drafter_rank: "senior" };
    const unrelatedActor = { email: "unrelated-tech@example.test", name: "Unrelated Tech", drafter_rank: "senior" };
    const reservationTarget = `pg-load-${String(projectCount - 1).padStart(6, "0")}`;
    const beforeReservation = await queue.getQueueStatus({ actor: reservedActor });
    assert.equal(beforeReservation.queue_breakdown.reserved, 0);
    assert.equal(beforeReservation.queue_breakdown.available_new, projectCount);
    await queue.reserveProject(reservationTarget, { reserved_for: reservedActor });
    const [reservedStatus, unrelatedStatus] = await Promise.all([
      queue.getQueueStatus({ actor: reservedActor }),
      queue.getQueueStatus({ actor: unrelatedActor })
    ]);
    assert.equal(reservedStatus.queue_breakdown.reserved, 1);
    assert.equal(reservedStatus.queue_breakdown.available_new, projectCount);
    assert.equal(unrelatedStatus.queue_breakdown.reserved, 0);
    assert.equal(unrelatedStatus.queue_breakdown.available_new, projectCount - 1);
    const bypassedReservation = await queue.getClaimableQueueStatus({
      actor: reservedActor,
      allow_reserved: false,
      allow_filler: false
    });
    assert.equal(bypassedReservation.claimable_source, "queue");
    assert.notEqual(bypassedReservation.claimable_next_id, reservationTarget);
    await queue.releaseReservation(reservationTarget, {});
    const afterRelease = await queue.getQueueStatus({ actor: reservedActor });
    assert.equal(afterRelease.queue_breakdown.reserved, 0);
    assert.equal(afterRelease.queue_breakdown.available_new, projectCount);

    const claimCount = Math.min(150, Math.floor(projectCount / 2));
    const claims = await Promise.all(Array.from({ length: claimCount }, (_, actorIndex) => queue.claimNextInQueue({
      actor: {
        email: `tech-${actorIndex}@example.test`,
        name: `Tech ${actorIndex}`,
        drafter_rank: "senior"
      },
      allow_reserved: true,
      allow_filler: false
    })));
    const claimedIds = claims.map((claim) => claim.project.id);
    assert.equal(new Set(claimedIds).size, claimCount, "concurrent claims must never return duplicate projects");

    const counterId = claimedIds[0]!;
    await Promise.all(Array.from({ length: 100 }, () => postgresIndex.mutatePostgresManifest(counterId, (manifest) => ({
      ...manifest,
      concurrency_counter: Number((manifest as Record<string, unknown>).concurrency_counter ?? 0) + 1
    }))));
    const counterManifest = await postgresIndex.readPostgresManifestById(counterId);
    assert.equal((counterManifest as Record<string, unknown>).concurrency_counter, 100);

    const jobIds = await Promise.all(Array.from({ length: 200 }, (_, jobIndex) => jobs.enqueueFirstMeasureJob(
      "postgres.integration", { jobIndex }, { maxAttempts: 2 }
    )));
    const claimedJobs = await Promise.all(Array.from({ length: 200 }, (_, workerIndex) => jobs.claimNextFirstMeasureJob(
      `worker-${workerIndex}`, ["postgres.integration"], 60_000
    )));
    assert.equal(new Set(claimedJobs.map((job) => job?.id).filter(Boolean)).size, jobIds.length);

    const release = await locks.acquireFirstMeasureLock("postgres-integration-lock", { waitMs: 100 });
    await assert.rejects(
      locks.acquireFirstMeasureLock("postgres-integration-lock", { waitMs: 50, retryMs: 10 }),
      /Timed out waiting for lock/
    );
    await release();
    const releaseAgain = await locks.acquireFirstMeasureLock("postgres-integration-lock", { waitMs: 100 });
    await releaseAgain();

    const badDirectory = path.join(projectRoot, "bad-project");
    await mkdir(badDirectory, { recursive: true });
    await writeFile(path.join(badDirectory, "manifest.json"), "{not valid json", "utf8");
    await assert.rejects(index.rebuildFirstMeasureProjectIndex(), /refused cutover/);
    const runtimeEnv = await import("../src/config/env.js");
    const mutableRuntimeEnv = runtimeEnv.env as unknown as { postgresImportMaxInvalidManifests: number };
    mutableRuntimeEnv.postgresImportMaxInvalidManifests = 1;
    const toleratedLegacyRebuild = await index.rebuildFirstMeasureProjectIndex();
    assert.equal(toleratedLegacyRebuild.indexedProjects, projectCount);
    const warningState = await database.queryPostgres<{ warning_count: number }>(`
      SELECT COALESCE((value->>'warning_count')::integer, 0) AS warning_count
      FROM firstmeasure_migration_state WHERE key = 'project_json_import_v2'
    `);
    assert.equal(Number(warningState.rows[0]?.warning_count ?? 0), 1);
    mutableRuntimeEnv.postgresImportMaxInvalidManifests = 0;
    await rm(badDirectory, { recursive: true, force: true });
    const rebuilt = await index.rebuildFirstMeasureProjectIndex();
    assert.equal(rebuilt.indexedProjects, projectCount);
    assert.equal((await index.getFirstMeasureProjectIndexStatus()).backfillComplete, true);

    const scaleClient = new pg.Client({ connectionString: databaseUrl });
    await scaleClient.connect();
    // The scale fixture is synthetic test data, so load it without firing the
    // per-project production trigger 100,000 times and rebuild exact counters
    // once afterward. Normal application writes still exercise the trigger.
    await scaleClient.query("ALTER TABLE projects DISABLE TRIGGER projects_queue_counter_trigger");
    await scaleClient.query(`
      INSERT INTO projects (
        id, manifest_json, storage_path, schema_version, status, address, address_normalized, id_normalized,
        created_at, queued_at, updated_at, created_at_ms, queued_at_ms, updated_at_ms, sort_ts, search_text,
        queue_group, queue_priority, queue_order_ms, thumbnail_artifact_name, source_sha256
      )
      SELECT
        'scale-' || lpad(value::text, 7, '0'),
        jsonb_build_object(
          'id', 'scale-' || lpad(value::text, 7, '0'),
          'schema_version', 2,
          'status', 'queued',
          'address', value::text || ' Scale Test Way',
          'workflow', '{}'::jsonb,
          'timestamps', jsonb_build_object('created_at', '2026-08-17T00:00:00.000Z', 'queued_at', '2026-08-17T00:00:00.000Z')
        ),
        '', 2, 'queued', value::text || ' Scale Test Way', value::text || ' scale test way',
        'scale-' || lpad(value::text, 7, '0'),
        '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z',
        value, value, value, value, value::text || ' scale test way',
        'queued', CASE WHEN value % 100 = 0 THEN 1 ELSE 3 END, value, 'azure.png', md5(value::text)
      FROM generate_series(1, $1::integer) AS value
    `, [scaleProjectCount]);
    await scaleClient.query("ALTER TABLE projects ENABLE TRIGGER projects_queue_counter_trigger");
    await scaleClient.query("TRUNCATE project_queue_counters");
    await scaleClient.query(`
      INSERT INTO project_queue_counters (scope, team_id, queue_group, instant_only, project_count)
      SELECT 'all', '', queue_group, instant_only, COUNT(*) FROM projects WHERE queue_group <> ''
      GROUP BY queue_group, instant_only
    `);
    await scaleClient.query(`
      INSERT INTO project_queue_counters (scope, team_id, queue_group, instant_only, project_count)
      SELECT 'team', team_id, queue_group, instant_only, COUNT(*) FROM projects
      WHERE queue_group <> '' AND team_id <> '' GROUP BY team_id, queue_group, instant_only
    `);
    await scaleClient.query(`
      INSERT INTO project_queue_counters (scope, team_id, queue_group, instant_only, project_count)
      SELECT CASE WHEN reserved_to_email = '' THEN 'claim_unreserved' ELSE 'claim_reserved' END,
        reserved_to_email, 'queued', instant_only, COUNT(*) FROM projects
      WHERE queue_group = 'queued' AND assigned_to_email = '' AND thumbnail_artifact_name <> ''
      GROUP BY reserved_to_email, instant_only
    `);
    await scaleClient.query("ANALYZE projects");
    await scaleClient.end();

    const scaleMetrics = await measureConcurrent(600, 64, async (requestIndex) => {
      if (requestIndex % 3 === 0) {
        const result = await postgresIndex.getPostgresQueueCounts({});
        assert.ok(result.total >= scaleProjectCount);
      } else if (requestIndex % 3 === 1) {
        const result = await postgresIndex.queryPostgresQueueBucket({ group: "queued", limit: 25 });
        assert.equal(result.rows.length, 25);
      } else {
        const result = await queue.getQueueStatus({
          actor: { email: `scale-tech-${requestIndex}@example.test`, name: "Scale Tech" }
        });
        assert.ok(result.queue_breakdown.available_new >= scaleProjectCount);
      }
    });
    process.stdout.write(`[postgres-scale] ${JSON.stringify({ projects: scaleProjectCount + projectCount, ...scaleMetrics })}\n`);
    assert.ok(scaleMetrics.p95_ms < 500, `expected indexed p95 below 500ms, received ${scaleMetrics.p95_ms}ms`);
    assert.ok(scaleMetrics.max_ms < 2_000, `expected indexed max below 2000ms, received ${scaleMetrics.max_ms}ms`);

    const scaleClaimIds: string[] = [];
    const scaleClaimMetrics = await measureConcurrent(200, 64, async (actorIndex) => {
      const claimed = await queue.claimNextInQueue({
        actor: {
          email: `scale-claim-${actorIndex}@example.test`,
          name: `Scale Claim ${actorIndex}`,
          drafter_rank: "senior"
        },
        allow_reserved: true,
        allow_filler: false
      });
      scaleClaimIds.push(claimed.project.id);
    });
    process.stdout.write(`[postgres-scale-claims] ${JSON.stringify(scaleClaimMetrics)}\n`);
    assert.equal(new Set(scaleClaimIds).size, scaleClaimIds.length, "large-queue claims must remain unique");
    assert.ok(scaleClaimMetrics.p95_ms < 1_000, `expected claim p95 below 1000ms, received ${scaleClaimMetrics.p95_ms}ms`);
    assert.ok(scaleClaimMetrics.max_ms < 5_000, `expected claim max below 5000ms, received ${scaleClaimMetrics.max_ms}ms`);

    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    await app.ready();
    try {
      const ping = await app.inject({ method: "GET", url: "/v1/firstmeasure/ping" });
      assert.equal(ping.statusCode, 200);
      assert.equal(ping.json().ok, true);

      const counts = await app.inject({ method: "POST", url: "/v1/firstmeasure/queue/counts", payload: {} });
      assert.equal(counts.statusCode, 200);
      assert.equal(counts.json().total, claimCount + scaleClaimIds.length, counts.body);

      const bucket = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/queue/bucket",
        payload: { group: "queued", include_all: true, limit: 25 }
      });
      assert.equal(bucket.statusCode, 200, bucket.body);
      assert.equal(bucket.json().projects.length, 25, bucket.body);

      const statusStarted = performance.now();
      const statusSnapshot = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/status/snapshot",
        payload: {}
      });
      const statusElapsed = performance.now() - statusStarted;
      assert.equal(statusSnapshot.statusCode, 200, statusSnapshot.body);
      assert.ok(statusElapsed < 2_000, `expected status snapshot below 2000ms, received ${statusElapsed}ms`);

      const qaStarted = performance.now();
      const qaBootstrap = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/qa/bootstrap",
        payload: {
          actor: { email: "qa-manager@example.test", name: "QA Manager", roles: ["admin", "manager", "qa"] },
          can_manage_queue: true,
          can_manager_review: true,
          can_do_qa: true,
          limit: 100
        }
      });
      const qaElapsed = performance.now() - qaStarted;
      assert.equal(qaBootstrap.statusCode, 200, qaBootstrap.body);
      assert.ok(qaElapsed < 3_000, `expected QA bootstrap below 3000ms, received ${qaElapsed}ms`);

      const httpClaim = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/queue/claim-next",
        payload: { actor: { email: "http-tech@example.test", name: "HTTP Tech", drafter_rank: "senior" } }
      });
      assert.equal(httpClaim.statusCode, 200, httpClaim.body);

      const compatStatus = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/queue/status/compat",
        payload: {
          actor: { email: "http-tech@example.test", name: "HTTP Tech" },
          include_active_projects: true
        }
      });
      assert.equal(compatStatus.statusCode, 200, compatStatus.body);
      assert.equal(compatStatus.json().active_projects.length, 1);

      const adminStatus = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/admin/index-status",
        payload: { actor: { email: "admin@example.test", roles: ["admin"] } }
      });
      assert.equal(adminStatus.statusCode, 200, adminStatus.body);
      assert.equal(adminStatus.json().firstmeasure.dbPath, "postgresql:managed");
    } finally {
      await app.close();
    }

    await database.closePostgresPools();
  } finally {
    const resolved = path.resolve(storageRoot);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("firstmeasure-postgres-test-")) {
      throw new Error(`Refusing to remove unexpected test path '${resolved}'.`);
    }
    await rm(resolved, { recursive: true, force: true });
  }
});
