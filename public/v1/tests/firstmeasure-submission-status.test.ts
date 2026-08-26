import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectManifest } from "../firstmeasure/storage.js";

test("submission persists its QA status and history as one manifest update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-submission-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_STORAGE_ROOT = root;
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "projects-index.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";

  try {
    const storage = await import("../firstmeasure/storage.js");
    const index = await import("../firstmeasure/project_index.js");
    const { updateStatusForSubmission } = await import("../firstmeasure/api.js");
    await index.ensureFirstMeasureProjectIndexReady();

    const id = "submission-enters-qa";
    const now = new Date().toISOString();
    await storage.saveManifest(id, {
      id,
      schema_version: 2,
      status: "in_progress",
      address: "124 QA Pipeline Way",
      workflow: { assigned_to: { email: "tech@example.test" }, work_history: [] },
      work_history: [],
      timestamps: { created_at: now, queued_at: now, started_at: now, updated_at: now }
    } as unknown as ProjectManifest);

    const submitted = await updateStatusForSubmission(id, "awaiting_review");
    assert.equal(submitted.status, "awaiting_review");
    assert.ok(Date.parse(String(submitted.timestamps.uploaded_at)) > 0);
    const submittedHistory = submitted.work_history as unknown as Array<Record<string, unknown>>;
    assert.equal(String(submittedHistory.at(-1)?.event), "submitted_for_qa");
    assert.equal(
      String(((submitted.workflow as Record<string, unknown>).work_history as Array<Record<string, unknown>>).at(-1)?.event),
      "submitted_for_qa"
    );

    const qaQueue = await index.queryIndexedQueueBucket({ group: "qa_waiting", limit: 10 });
    assert.equal(qaQueue.rows.some((row) => row.manifest.id === id), true);
    await index.closeFirstMeasureProjectIndex();
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("firstmeasure-submission-test-")) {
      throw new Error(`Refusing to remove unexpected test path '${resolved}'.`);
    }
    await rm(resolved, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }).catch((error) => {
      if (String((error as NodeJS.ErrnoException)?.code ?? "") !== "EBUSY") throw error;
    });
  }
});
