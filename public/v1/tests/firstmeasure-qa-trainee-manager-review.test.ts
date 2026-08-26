import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectManifest } from "../firstmeasure/storage.js";

test("VIP projects and projects approved by trainee QA both require manager review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-qa-trainee-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects-index.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");

  try {
    const storage = await import("../firstmeasure/storage.js");
    const index = await import("../firstmeasure/project_index.js");
    const internalStorage = await import("../internal/storage.js");
    const { buildApp } = await import("../src/app.js");
    await index.ensureFirstMeasureProjectIndexReady();

    const trainee = { email: "trainee-qa@example.test", name: "Trainee QA" };
    const experienced = { email: "experienced-qa@example.test", name: "Experienced QA" };
    await internalStorage.saveInternalUser({ ...trainee, role: "qa", is_qa_trainee: true });
    await internalStorage.saveInternalUser({ ...experienced, role: "qa", is_qa_trainee: false });
    assert.equal((await internalStorage.readInternalUser(trainee.email))?.is_qa_trainee, true);
    assert.equal((await internalStorage.readInternalUser(experienced.email))?.is_qa_trainee, false);

    const saveClaimedProject = async (id: string, qa: typeof trainee, isVip: boolean) => {
      const now = new Date().toISOString();
      await storage.saveManifest(id, {
        id,
        schema_version: 2,
        status: "awaiting_review",
        address: `${id} Test Way`,
        is_vip: isVip,
        qa_claimed_by_email: qa.email,
        qa_claimed_by_name: qa.name,
        qa_claimed_at: now,
        workflow: {
          assigned_to: { email: "tech@example.test", name: "Tech" },
          reserved_to: null,
          correction_to: null,
          qa_claim: { email: qa.email, name: qa.name, claimed_at: now },
          history: []
        },
        timestamps: { created_at: now, queued_at: now, updated_at: now }
      } as unknown as ProjectManifest);
    };

    await saveClaimedProject("trainee-standard-project", trainee, false);
    await saveClaimedProject("experienced-vip-project", experienced, true);

    const app = await buildApp();
    await app.ready();
    try {
      const approve = (id: string, actor: typeof trainee) => app.inject({
        method: "POST",
        url: `/v1/firstmeasure/projects/${id}/qa/decision`,
        payload: { actor, status: "approved", threads: [] }
      });

      const traineeApproval = await approve("trainee-standard-project", trainee);
      assert.equal(traineeApproval.statusCode, 200, traineeApproval.body);
      assert.equal(traineeApproval.json().manifest.status, "awaiting_manager_review");
      assert.equal(traineeApproval.json().manifest.manager_review_required, true);
      assert.deepEqual(traineeApproval.json().manifest.manager_review_reasons, ["qa_trainee"]);
      assert.equal(traineeApproval.json().manifest.qa_reviewer_was_trainee, true);
      assert.equal(traineeApproval.json().manifest.qa_completed_at, null);

      const vipApproval = await approve("experienced-vip-project", experienced);
      assert.equal(vipApproval.statusCode, 200, vipApproval.body);
      assert.equal(vipApproval.json().manifest.status, "awaiting_manager_review");
      assert.deepEqual(vipApproval.json().manifest.manager_review_reasons, ["vip"]);
      assert.equal(vipApproval.json().manifest.qa_reviewer_was_trainee, false);
    } finally {
      await app.close();
    }
  } finally {
    // SQLite can keep its index handle briefly locked on Windows after Fastify
    // closes. Clean up what is available without turning a passed routing test
    // into a platform-specific teardown failure.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
    });
  }
});
