import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { managerReviewCsv } from "../internal/manager_review_export.js";

test("CSV preserves quoted/multiline Unicode notes and neutralizes formulas", () => {
  const csv = managerReviewCsv([{ address: '=HYPERLINK("bad")', note: 'Roof, "north"\nÉtage', issue_categories: ["geometry", "pitch"], severity: "minor", audit_status: "flagged", score_exclusion_reason: "minor" }]);
  assert.ok(csv.startsWith('\uFEFF"Project ID"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"Roof, ""north""\nÉtage"'));
  assert.ok(csv.includes('"geometry; pitch"'));
});

test("export includes all filtered pages and enforces the viewer's result access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-export-"));
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "sqlite", FIRSTMEASURE_JOB_WORKERS: "0", PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_STORAGE_ROOT: path.join(root, "projects"), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "projects", "index.sqlite"), INTERNAL_STORAGE_ROOT: path.join(root, "internal"), PLATFORM_STORAGE_ROOT: path.join(root, "platform") });
  const [{ buildApp }, storage, index] = await Promise.all([import("../src/app.js"), import("../internal/storage.js"), import("../firstmeasure/project_index.js")]);
  const app = await buildApp();
  try {
    for (const [email, role] of [["admin@example.test", "admin"], ["qa@example.test", "qa"], ["other@example.test", "qa"], ["tech@example.test", "technician"]]) await storage.saveInternalUser({ email, role });
    const entries = Array.from({ length: 125 }, (_, i) => ({ project_id: `project-${i}`, address: `Address ${i}`, qa_email: i < 120 ? "qa@example.test" : "other@example.test", qa_name: "QA", team_id: "west" }));
    await storage.saveInternalDocument("manager_review_samples", "2026-09-01", { data: { sample_date: "2026-09-01", entries } }, { replace: true });
    await storage.saveInternalDocument("manager_review_samples", "2026-08-01", { data: { sample_date: "2026-08-01", entries: [{ project_id: "out-of-range", address: "Out of range", qa_email: "qa@example.test" }] } }, { replace: true });
    await storage.saveInternalDocument("manager_audit", "project-0", { data: { project_id: "project-0", status: "flagged", severity: "minor", note: "Minor issue", issue_categories: ["geometry"] } }, { replace: true });
    const call = (email: string, extra = {}) => app.inject({ method: "POST", url: "/v1/internal/legacy-action", payload: { action: "manager_review_results_export", actor: { email }, date_start: "2026-09-01", date_end: "2026-09-01", page: 2, page_size: 10, ...extra } });
    const admin = await call("admin@example.test");
    assert.equal(admin.statusCode, 200, admin.body);
    assert.equal(admin.json().count, 125);
    assert.ok(admin.json().csv.includes('"Address 124"'));
    assert.ok(!admin.json().csv.includes("Out of range"));
    const own = await call("qa@example.test", { qa_email: "other@example.test" });
    assert.equal(own.json().count, 120, own.body);
    assert.ok(!own.json().csv.includes("other@example.test"));
    const minor = await call("admin@example.test", { severity: "minor" });
    assert.equal(minor.json().count, 1);
    assert.ok(minor.json().csv.includes('"Minor issue"'));
    assert.equal((await call("tech@example.test")).statusCode, 403);
    assert.equal((await call("admin@example.test", { date_end: "2026-08-31" })).statusCode, 400);
    assert.equal((await call("admin@example.test", { team_id: "none" })).json().count, 0);
  } finally {
    await app.close(); await index.closeFirstMeasureProjectIndex();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
