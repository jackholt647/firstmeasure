import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("manager review is durable, blind to reviewers, and identity-gated for results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-review-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects-index.sqlite");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");

  try {
    const [{ buildApp }, storage, internalStorage] = await Promise.all([
      import("../src/app.js"),
      import("../firstmeasure/storage.js"),
      import("../internal/storage.js")
    ]);
    await internalStorage.saveInternalUser({
      email: "reviewer@example.test",
      name: "Blind Reviewer",
      role: "reviewer",
      permissions: { perform_manager_review: true }
    });
    await internalStorage.saveInternalUser({
      email: "admin@example.test",
      name: "Results Admin",
      role: "admin",
      is_admin: true,
      permissions: { view_manager_review_results: true }
    });
    await internalStorage.saveInternalUser({
      email: "employee@example.test",
      name: "Ordinary Employee",
      role: "technician",
      permissions: {}
    });
    await internalStorage.saveInternalUser({
      email: "qa@example.test",
      name: "Named QA",
      role: "qa",
      team_id: "quality-west",
      permissions: { manage_qa: true }
    });
    await internalStorage.saveInternalUser({
      email: "manager@example.test",
      name: "Quality Manager",
      role: "manager",
      permissions: {}
    });

    const today = new Date().toISOString().slice(0, 10);
    const yesterdayValue = new Date(`${today}T12:00:00.000Z`);
    yesterdayValue.setUTCDate(yesterdayValue.getUTCDate() - 1);
    const yesterday = yesterdayValue.toISOString().slice(0, 10);
    const twoDaysAgoValue = new Date(`${today}T12:00:00.000Z`);
    twoDaysAgoValue.setUTCDate(twoDaysAgoValue.getUTCDate() - 2);
    const twoDaysAgo = twoDaysAgoValue.toISOString().slice(0, 10);
    await internalStorage.saveInternalDocument("manager_review_config", "settings", { data: { daily_target: 1 } }, { replace: true });
    await internalStorage.saveInternalDocument("manager_review_samples", twoDaysAgo, {
      data: { sample_date: twoDaysAgo, configured_target: 1, entries: [] }
    }, { replace: true });

    await storage.createProject({
      id: "blind-sample-1",
      address: "1 Blind Sample Way",
      status: "completed",
      project_type: "commercial",
      complexity: "complex"
    });
    await storage.patchManifest("blind-sample-1", {
      status: "completed",
      assigned_to_email: "technician@example.test",
      assigned_to_name: "Named Technician",
      qa_reviewed_by: "qa@example.test",
      qa_reviewed_by_name: "Named QA",
      timestamps: { completed_at: `${yesterday} 12:00:00` },
      work_history: [{
        event: "qa_approved",
        ts: "2026-08-15T11:00:00.000Z",
        qa_email: "qa@example.test",
        qa_name: "Named QA"
      }],
      workflow: {
        assigned_to: { email: "technician@example.test", name: "Named Technician" },
        history: [{ event: "qa_approved", qa_email: "qa@example.test", qa_name: "Named QA" }]
      }
    });
    await storage.saveAppMetadata("blind-sample-1", { geometry: { preserved: true } });

    await storage.createProject({
      id: "blind-sample-2",
      address: "2 Blind Sample Way",
      status: "completed",
      project_type: "commercial",
      complexity: "complex"
    });
    await storage.patchManifest("blind-sample-2", {
      status: "completed",
      assigned_to_email: "technician@example.test",
      assigned_to_name: "Named Technician",
      qa_reviewed_by: "qa@example.test",
      qa_reviewed_by_name: "Named QA",
      timestamps: { completed_at: `${yesterday} 13:00:00` },
      workflow: { assigned_to: { email: "technician@example.test", name: "Named Technician" } }
    });

    const app = await buildApp();
    await app.ready();
    const legacy = (action: string, actor: string, extra: Record<string, unknown> = {}) => app.inject({
      method: "POST",
      url: "/v1/internal/legacy-action",
      payload: { action, actor: { email: actor }, ...extra }
    });

    const forbiddenQueue = await legacy("manager_review_data", "employee@example.test");
    assert.equal(forbiddenQueue.statusCode, 403);
    const managerWithoutReviewPosition = await legacy("manager_review_data", "manager@example.test");
    assert.equal(managerWithoutReviewPosition.statusCode, 403);

    const blindQueue = await legacy("manager_review_data", "reviewer@example.test");
    assert.equal(blindQueue.statusCode, 200);
    assert.equal(blindQueue.json().sample.selected, 2);
    assert.equal(blindQueue.json().sample.remaining, 2);
    assert.equal(blindQueue.json().sample.backlog_remaining, 1);
    assert.equal(blindQueue.json().sample.sample_days, 2);
    const blindProjects = blindQueue.json().projects as Array<Record<string, unknown>>;
    assert.equal(blindProjects.length, 2);
    assert.equal(blindProjects[0]?.sample_date, yesterday);
    const blindProject = blindProjects.find((project) => project.id === "blind-sample-1");
    assert.ok(blindProject);
    assert.equal("qa_reviewer_email" in blindProject, false);
    assert.equal("assigned_to_email" in blindProject, false);

    const blindBundle = await legacy("manager_review_project_bundle", "reviewer@example.test", { folder: "blind-sample-1" });
    assert.equal(blindBundle.statusCode, 200);
    const bundleManifest = blindBundle.json().manifest as Record<string, unknown>;
    assert.equal("workflow" in bundleManifest, false);
    assert.equal("qa_reviewed_by" in bundleManifest, false);

    const annotationSave = await legacy("manager_review_annotations_save", "reviewer@example.test", {
      folder: "blind-sample-1",
      annotations: { "0": { strokes: [{ type: "text", text: "Check area" }] } }
    });
    assert.equal(annotationSave.statusCode, 200);
    const metadataAfterAnnotation = await storage.readAppMetadata("blind-sample-1") as Record<string, unknown>;
    assert.deepEqual(metadataAfterAnnotation.geometry, { preserved: true });
    assert.ok(metadataAfterAnnotation.manager_review_annotations);

    await storage.saveArtifact("blind-sample-1", "manager-review-test-roof.png", Buffer.from("review screenshot"));
    const marked = await legacy("manager_audit_mark", "reviewer@example.test", {
      folder: "blind-sample-1",
      audit_status: "flagged",
      issue_categories: ["missing_section", "missing_skylight_chimney", "wrong_line_types"],
      note: "Synthetic missed measurement.",
      attachments: [{ name: "manager-review-test-roof.png", original_name: "roof problem.png" }],
      annotations: { "0": { strokes: [{ type: "text", text: "Check area" }] } }
    });
    assert.equal(marked.statusCode, 200);
    assert.equal(marked.json().manager_audit_quality_score, 0);

    const persisted = await storage.readManifest("blind-sample-1") as Record<string, unknown>;
    assert.equal(persisted.manager_audit_status, "flagged");
    assert.equal(persisted.manager_audit_quality_score, 0);
    assert.deepEqual(persisted.manager_audit_issue_categories, ["missing_section", "missing_skylight_chimney", "wrong_line_types"]);
    assert.deepEqual(persisted.manager_audit_attachments, [{ name: "manager-review-test-roof.png", original_name: "roof problem.png" }]);
    assert.equal((persisted.manager_audit_history as unknown[]).length, 1);
    assert.equal((persisted.work_history as unknown[]).length, 2);

    const reviewerResults = await legacy("manager_review_results", "reviewer@example.test");
    assert.equal(reviewerResults.statusCode, 403);
    const adminResults = await legacy("manager_review_results", "admin@example.test");
    assert.equal(adminResults.statusCode, 200);
    const resultsJson = adminResults.json();
    assert.equal("projects" in resultsJson, false);
    assert.equal(resultsJson.results[0].project_id, "blind-sample-1");
    assert.deepEqual(resultsJson.results[0].issue_categories, ["missing_section", "missing_skylight_chimney", "wrong_line_types"]);
    assert.deepEqual(resultsJson.results[0].attachments, [{ name: "manager-review-test-roof.png", original_name: "roof problem.png" }]);
    assert.equal(resultsJson.summary.eligible, 2);
    assert.equal(resultsJson.summary.reviewed, 1);
    assert.equal(resultsJson.summary.issues, 1);
    assert.equal(resultsJson.groups.qa[0].key, "qa@example.test");
    assert.equal(resultsJson.groups.qa[0].average_quality, 0);
    assert.equal(resultsJson.groups.team[0].key, "quality-west");
    assert.equal(resultsJson.pagination.page_size, 25);

    const qaResults = await legacy("manager_review_results", "qa@example.test", { qa_email: "someone-else@example.test" });
    assert.equal(qaResults.statusCode, 200);
    assert.equal(qaResults.json().access.can_view_all, false);
    assert.equal(qaResults.json().filters.qa_email, "qa@example.test");

    const excluded = await legacy("manager_review_override", "manager@example.test", { folder: "blind-sample-1", excluded: true });
    assert.equal(excluded.statusCode, 200);
    const excludedResults = await legacy("manager_review_results", "manager@example.test");
    assert.equal(excludedResults.json().summary.excluded, 1);
    assert.equal(excludedResults.json().summary.pass_rate, null);
    assert.equal(excludedResults.json().results[0].score_excluded, true);
    const qaOverride = await legacy("manager_review_override", "qa@example.test", { folder: "blind-sample-1", excluded: false });
    assert.equal(qaOverride.statusCode, 403);

    const reviewerSettingsSave = await legacy("manager_review_settings_save", "reviewer@example.test", { daily_target: 75 });
    assert.equal(reviewerSettingsSave.statusCode, 403);
    const adminSettingsSave = await legacy("manager_review_settings_save", "admin@example.test", { daily_target: 75 });
    assert.equal(adminSettingsSave.statusCode, 200);
    assert.equal(adminSettingsSave.json().settings.daily_target, 75);

    const reviewerRawState = await app.inject({
      method: "GET",
      url: "/v1/internal/state/manager_audit?actor_email=reviewer@example.test"
    });
    assert.equal(reviewerRawState.statusCode, 403);
    const qaRawState = await app.inject({
      method: "GET",
      url: "/v1/internal/state/manager_audit?actor_email=qa@example.test"
    });
    assert.equal(qaRawState.statusCode, 403);
    const adminRawState = await app.inject({
      method: "GET",
      url: "/v1/internal/state/manager_audit?actor_email=admin@example.test"
    });
    assert.equal(adminRawState.statusCode, 200);
    const reviewerSampleState = await app.inject({
      method: "GET",
      url: "/v1/internal/state/manager_review_samples?actor_email=reviewer@example.test"
    });
    assert.equal(reviewerSampleState.statusCode, 403);

    await app.close();
  } finally {
    await (await import("../firstmeasure/project_index.js")).closeFirstMeasureProjectIndex().catch(() => undefined);
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("manager-review-test-")) {
      throw new Error(`Refusing to remove unexpected test path '${resolved}'.`);
    }
    await rm(resolved, { recursive: true, force: true });
  }
});
