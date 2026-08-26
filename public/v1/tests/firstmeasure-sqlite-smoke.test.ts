import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectManifest } from "../firstmeasure/storage.js";

test("SQLite fallback remains operational", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-sqlite-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_STORAGE_ROOT = root;
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "projects-index.sqlite");

  try {
    const storage = await import("../firstmeasure/storage.js");
    const index = await import("../firstmeasure/project_index.js");
    const queue = await import("../firstmeasure/queue.js");
    const jobs = await import("../firstmeasure/job_queue.js");
    await index.ensureFirstMeasureProjectIndexReady();

    for (let projectIndex = 0; projectIndex < 100; projectIndex += 1) {
      const id = `sqlite-${String(projectIndex).padStart(4, "0")}`;
      const timestamp = new Date(Date.now() + projectIndex).toISOString();
      await storage.saveManifest(id, {
        id,
        schema_version: 2,
        status: "queued",
        address: `${projectIndex} SQLite Lane`,
        workflow: { assigned_to: null, reserved_to: null, correction_to: null, history: [] },
        timestamps: { created_at: timestamp, queued_at: timestamp, updated_at: timestamp }
      } as unknown as ProjectManifest);
    }
    const migrationDb = index.getFirstMeasureProjectIndexDb();
    migrationDb.prepare("UPDATE projects SET queue_group = ''").run();
    migrationDb.prepare(`
      INSERT INTO project_index_meta (key, value)
      VALUES ('queue_fields_backfill_v1', '0')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    await index.closeFirstMeasureProjectIndex();
    await index.ensureFirstMeasureProjectIndexReady();
    const remainingQueueBackfill = index.getFirstMeasureProjectIndexDb()
      .prepare("SELECT COUNT(*) AS count FROM projects WHERE queue_group = ''")
      .get() as { count?: number };
    assert.equal(Number(remainingQueueBackfill.count ?? 0), 0);
    await storage.saveArtifact("sqlite-0000", "azure.png", new Uint8Array([1, 2, 3]));

    assert.equal((await index.getFirstMeasureProjectIndexStatus()).indexedProjects, 100);
    assert.equal((await index.queryIndexedProjectManifests({ search: "SQLite Lane", limit: 10 })).count, 100);
    const claimed = await queue.claimNextInQueue({
      actor: { email: "sqlite-tech@example.test", name: "SQLite Tech", drafter_rank: "senior" }
    });
    assert.equal(claimed.project.status, "in_progress");
    await assert.rejects(
      queue.claimNextInQueue({
        actor: { email: "sqlite-tech-2@example.test", name: "SQLite Tech 2", drafter_rank: "senior" }
      }),
      /No eligible project was found/
    );
    await storage.saveManifest("sqlite-resurrected-cancellation", {
      id: "sqlite-resurrected-cancellation",
      schema_version: 2,
      status: "queued",
      address: "Cancelled Order Lane",
      amount_charged: 0,
      cancelled_by_customer: true,
      cancellation: {
        reason: "customer_cancelled_inside_grace_period",
        cancelled_at: new Date().toISOString()
      },
      workflow: { assigned_to: null, reserved_to: null, correction_to: null, history: [] },
      timestamps: { created_at: new Date().toISOString(), queued_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    } as unknown as ProjectManifest);
    assert.equal((await storage.readManifest("sqlite-resurrected-cancellation")).status, "cancelled");
    assert.equal((await storage.patchManifest(claimed.project.id, { test_patch: true }) as Record<string, unknown>).test_patch, true);

    const qaCreatedAt = new Date().toISOString();
    await storage.saveManifest("sqlite-qa-waiting", {
      id: "sqlite-qa-waiting",
      schema_version: 2,
      status: "awaiting_review",
      address: "QA Waiting Lane",
      team_id: "sqlite-team",
      workflow: { qa_claim: null },
      timestamps: { created_at: qaCreatedAt, uploaded_at: qaCreatedAt, updated_at: qaCreatedAt }
    } as unknown as ProjectManifest);
    await storage.saveManifest("sqlite-qa-claimed", {
      id: "sqlite-qa-claimed",
      schema_version: 2,
      status: "submission_failed",
      address: "QA Claimed Lane",
      team_id: "sqlite-team",
      workflow: { qa_claim: { email: "qa@example.test", name: "QA" } },
      timestamps: { created_at: qaCreatedAt, uploaded_at: qaCreatedAt, updated_at: qaCreatedAt }
    } as unknown as ProjectManifest);
    const qaCandidates = await index.queryIndexedQaCandidateManifests({ team_id: "sqlite-team" });
    assert.deepEqual(new Set(qaCandidates.map((manifest) => manifest.id)), new Set(["sqlite-qa-waiting", "sqlite-qa-claimed"]));
    const queueCounts = await index.getIndexedQueueCounts({ team_id: "sqlite-team" });
    assert.equal(queueCounts.groups.qa_waiting, 1);
    assert.equal(queueCounts.groups.qa_claimed, 1);
    const sqliteIndexes = index.getFirstMeasureProjectIndexDb()
      .prepare("PRAGMA index_list(projects)").all() as Array<{ name?: string }>;
    assert.ok(sqliteIndexes.some((entry) => entry.name === "idx_projects_qa_candidates"));
    assert.ok(sqliteIndexes.some((entry) => entry.name === "idx_projects_queue_counts"));

    const noBackupId = "sqlite-transient-patch";
    await storage.saveManifest(noBackupId, {
      id: noBackupId,
      schema_version: 2,
      status: "awaiting_review",
      address: "Transient Patch Lane",
      workflow: { qa_claim: null },
      timestamps: { created_at: qaCreatedAt, uploaded_at: qaCreatedAt, updated_at: qaCreatedAt }
    } as unknown as ProjectManifest);
    await storage.patchManifest(noBackupId, { qa_claimed_by_email: "qa@example.test" }, { backup: false });
    const projectEntries = await readdir(path.join(root, "projects", noBackupId));
    assert.equal(projectEntries.includes("manifest_backups"), false);

    const concurrentId = "sqlite-concurrent-submission";
    const concurrentTimestamp = new Date().toISOString();
    await storage.saveManifest(concurrentId, {
      id: concurrentId,
      schema_version: 2,
      status: "ready",
      address: "Concurrent Submission Lane",
      workflow: { assigned_to: null, reserved_to: null, correction_to: null, history: [] },
      timestamps: { created_at: concurrentTimestamp, queued_at: concurrentTimestamp, updated_at: concurrentTimestamp },
      artifacts: {}
    } as unknown as ProjectManifest);
    await Promise.all([
      storage.updateStatus(concurrentId, "awaiting_review"),
      storage.savePdfState(concurrentId, { revision: 1 }),
      storage.saveArtifact(concurrentId, "Report.pdf", new Uint8Array(256 * 1024)),
      storage.saveArtifact(concurrentId, "Summary.pdf", new Uint8Array(256 * 1024))
    ]);
    const concurrentManifest = await storage.readManifest(concurrentId);
    assert.equal(concurrentManifest.status, "awaiting_review");
    assert.equal(concurrentManifest.artifacts.has_pdf_state, true);
    assert.equal(concurrentManifest.artifacts.has_main_pdf, true);
    assert.equal(concurrentManifest.artifacts.has_summary_pdf, true);

    const jobId = await jobs.enqueueFirstMeasureJob("sqlite.smoke", { ok: true });
    assert.equal((await jobs.claimNextFirstMeasureJob("sqlite-worker", ["sqlite.smoke"]))?.id, jobId);

    const delayedJobId = await jobs.enqueueFirstMeasureJob("sqlite.delayed", { ok: true }, {
      availableAtMs: Date.now() + 60_000
    });
    assert.equal(await jobs.claimNextFirstMeasureJob("sqlite-worker", ["sqlite.delayed"]), null);
    assert.equal((await jobs.getFirstMeasureJob(delayedJobId))?.status, "queued");

    const idempotentJobId = "sqlite-idempotent-job";
    await jobs.enqueueFirstMeasureJob("sqlite.idempotent", { version: 1 }, {
      id: idempotentJobId,
      idempotent: true
    });
    await jobs.enqueueFirstMeasureJob("sqlite.idempotent", { version: 2 }, {
      id: idempotentJobId,
      idempotent: true
    });
    assert.equal((await jobs.getFirstMeasureJob(idempotentJobId))?.payload.version, 1);

    await jobs.recordFirstMeasureWorkerHeartbeat("sqlite-runtime", 2, new Date().toISOString());
    const workerHealth = await jobs.getFirstMeasureWorkerHealth();
    assert.equal(workerHealth.healthy, true);
    assert.equal(workerHealth.worker_count, 2);
    await index.closeFirstMeasureProjectIndex();
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("firstmeasure-sqlite-test-")) {
      throw new Error(`Refusing to remove unexpected test path '${resolved}'.`);
    }
    // Windows can retain the SQLite WAL handle for a few milliseconds after
    // DatabaseSync.close(). Retry cleanup instead of reporting a false product
    // failure after every behavioral assertion has already passed.
    await rm(resolved, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }).catch((error) => {
      if (String((error as NodeJS.ErrnoException)?.code ?? "") !== "EBUSY") throw error;
      // The test process exits immediately afterward, which releases the WAL;
      // a locked temporary directory is preferable to masking a valid fallback
      // test with a Windows-only cleanup failure.
    });
  }
});
