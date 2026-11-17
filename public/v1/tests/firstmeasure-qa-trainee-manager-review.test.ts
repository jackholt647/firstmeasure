import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");

  try {
    const storage = await import("../firstmeasure/storage.js");
    const index = await import("../firstmeasure/project_index.js");
    const jobs = await import("../firstmeasure/job_queue.js");
    const internalStorage = await import("../internal/storage.js");
    const { buildApp } = await import("../src/app.js");
    await index.ensureFirstMeasureProjectIndexReady();

    const trainee = { email: "trainee-qa@example.test", name: "Trainee QA" };
    const experienced = { email: "experienced-qa@example.test", name: "Experienced QA" };
    const exteriorsTrainee = { email: "exteriors-trainee-qa@example.test", name: "Exteriors Trainee QA" };
    await internalStorage.saveInternalUser({ ...trainee, role: "qa", is_qa_trainee: true });
    await internalStorage.saveInternalUser({ ...experienced, role: "qa", is_qa_trainee: false });
    assert.equal((await internalStorage.readInternalUser(trainee.email))?.is_qa_trainee, true);
    assert.equal((await internalStorage.readInternalUser(experienced.email))?.is_qa_trainee, false);
    // FM-523: "Trainee Exteriors QA" sends only full exterior orders to a manager.
    await internalStorage.saveInternalUser({ ...exteriorsTrainee, role: "qa", is_qa_trainee_exteriors: true, can_qa_full_house: true });
    assert.equal((await internalStorage.readInternalUser(exteriorsTrainee.email))?.is_qa_trainee_exteriors, true);
    assert.equal((await internalStorage.readInternalUser(experienced.email))?.is_qa_trainee_exteriors, false);
    // Exteriors reach a manager who is qualified to QA them, as manager sign-off requires.
    await internalStorage.saveInternalUser({ email: "manager@example.test", name: "Manager", role: "manager", can_qa_full_house: true });

    const saveClaimedProject = async (id: string, qa: typeof trainee, isVip: boolean, extra: Record<string, unknown> = {}) => {
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
        timestamps: { created_at: now, queued_at: now, updated_at: now },
        ...extra
      } as unknown as ProjectManifest);
      // Approval requires a previously reviewed PDF. This test covers routing,
      // not rendering, and background workers remain disabled.
      await storage.saveStoredPdf(id, "main", Buffer.from("%PDF-1.4\nsynthetic routing fixture\n%%EOF"));
    };

    await saveClaimedProject("trainee-standard-project", trainee, false);
    await saveClaimedProject("experienced-vip-project", experienced, true);
    const exteriorId = "exteriors_0123456789abcdef0123456789abcdef";
    await saveClaimedProject(exteriorId, exteriorsTrainee, false, { measurement_scope: "full_house", include_gutter_measurements: true });
    {
      // A full exterior is approved only against a completed full-house PDF sync.
      const pdf = Buffer.from("%PDF-1.4\nsynthetic full exterior fixture\n%%EOF");
      const revision = "reviewed-full-exterior";
      const snapshot = { folderId: exteriorId, report: { lines: [{ type: "eave" }] }, exteriorReport: { walls: [{ id: "wall", gross: 100 }], roof: [{ id: "roof" }], totals: { gross: 100 } }, exteriorSettings: { include: true }, gutterSettings: { stories: { north: "1", south: "1", east: "1", west: "1" } } };
      const sync = await jobs.enqueueFirstMeasureJob("pdf.sync", { project_id: exteriorId, revision, snapshot, outputs: [{ slot: "main", mode: "full", persist: true }] });
      const claimed = await jobs.claimNextFirstMeasureJob("fixture-worker", ["pdf.sync"]);
      assert.ok(claimed);
      await storage.saveStoredPdf(exteriorId, "main", pdf);
      await jobs.completeFirstMeasureJob(sync, { outputs: [{ slot: "main", mode: "full", sha256: createHash("sha256").update(pdf).digest("hex") }] }, claimed);
      await storage.patchManifest(exteriorId, { pdf_sync: { latest_job_id: sync, latest_revision: revision, status: "completed", checksum_match: true } });
    }
    await saveClaimedProject("exteriors-trainee-roof-project", exteriorsTrainee, false);

    const app = await buildApp();
    await app.ready();
    // Each reviewer calls with their own staff session; their QA records above say who is a trainee.
    const { staffInjector } = await import("./helpers/security-fixture.js");
    const staffInject = staffInjector(app, { "manager@example.test": { role: "manager" } });
    try {
      const approve = (id: string, actor: typeof trainee) => staffInject({
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

      const exteriorApproval = await approve(exteriorId, exteriorsTrainee);
      assert.equal(exteriorApproval.statusCode, 200, exteriorApproval.body);
      assert.equal(exteriorApproval.json().manifest.status, "awaiting_manager_review");
      assert.equal(exteriorApproval.json().manifest.manager_review_required, true);
      assert.deepEqual(exteriorApproval.json().manifest.manager_review_reasons, ["qa_trainee_exteriors"]);
      assert.equal(exteriorApproval.json().manifest.qa_reviewer_was_trainee, true);

      const roofApproval = await approve("exteriors-trainee-roof-project", exteriorsTrainee);
      assert.equal(roofApproval.statusCode, 200, roofApproval.body);
      assert.notEqual(roofApproval.json().manifest.status, "awaiting_manager_review");
      assert.equal(roofApproval.json().manifest.manager_review_required, false);
      assert.deepEqual(roofApproval.json().manifest.manager_review_reasons, []);
      assert.equal(roofApproval.json().manifest.qa_reviewer_was_trainee, false);

      // The approval response is not what the manager queue renders. Exercise
      // its compact bootstrap projection, which previously dropped the reasons.
      const bootstrap = await staffInject({
        method: "POST", url: "/v1/firstmeasure/qa/bootstrap",
        payload: { actor: { email: "manager@example.test", roles: ["manager"] } }
      });
      assert.equal(bootstrap.statusCode, 200, bootstrap.body);
      const managerRows = bootstrap.json().manager;
      const traineeRow = managerRows.find((row: { id: string }) => row.id === "trainee-standard-project");
      const vipRow = managerRows.find((row: { id: string }) => row.id === "experienced-vip-project");
      assert.deepEqual(traineeRow.manager_review_reasons, ["qa_trainee"]);
      assert.equal(traineeRow.qa_reviewer_was_trainee, true);
      assert.deepEqual(vipRow.manager_review_reasons, ["vip"]);
      const exteriorRow = managerRows.find((row: { id: string }) => row.id === exteriorId);
      assert.deepEqual(exteriorRow.manager_review_reasons, ["qa_trainee_exteriors"]);
      assert.equal(exteriorRow.qa_reviewer_was_trainee, true);
      assert.equal(managerRows.some((row: { id: string }) => row.id === "exteriors-trainee-roof-project"), false);
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
