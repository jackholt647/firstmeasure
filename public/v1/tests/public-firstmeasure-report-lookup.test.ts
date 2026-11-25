import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// FM-640: report lookups by external_id, idempotency key and project id used to
// read the 500 newest public API reports across every organization and filter
// afterwards, so an older report stopped being found. Runs on file storage by
// default and on PostgreSQL through tests/run-embedded-postgres.mjs, which sets
// TEST_POSTGRES_URL.
test("public report lookups find an organization's older reports behind 500 newer ones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-report-lookup-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, {
    FIRSTMATE_ENV: "test",
    PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_STORAGE_ROOT: path.join(root, "platform"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, "fm"),
    INTERNAL_STORAGE_ROOT: path.join(root, "internal"),
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "sqlite"
  });
  if (url) Object.assign(process.env, { DATABASE_URL: url, DATABASE_ADMIN_URL: url, POSTGRES_AUTO_MIGRATE: "true" });
  try {
    const reports = await import("../public-firstmeasure/reports.js");
    const suffix = Date.now().toString(36);
    const orgId = `org_lookup_${suffix}`;
    const otherOrgId = `org_lookup_other_${suffix}`;
    const base = {
      charge_token: null,
      amount_charged: 0,
      created_by_key_id: "key_test",
      request: {},
      metadata: {}
    };
    const older = await reports.createPublicFirstMeasureReportRecord({
      ...base,
      report_id: reports.generatePublicReportId(),
      org_id: orgId,
      firstmeasure_project_id: `proj_old_${suffix}`,
      external_id: "job_old",
      idempotency_key_hash: `hash_old_${suffix}`
    });
    const testMode = await reports.createPublicFirstMeasureReportRecord({
      ...base,
      report_id: reports.generatePublicReportId(),
      org_id: orgId,
      mode: "test",
      firstmeasure_project_id: `proj_test_${suffix}`,
      external_id: "job_old",
      idempotency_key_hash: `hash_old_${suffix}`
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 510; index += 1) {
      await reports.createPublicFirstMeasureReportRecord({
        ...base,
        report_id: reports.generatePublicReportId(),
        org_id: index % 10 === 0 ? orgId : otherOrgId,
        firstmeasure_project_id: `proj_new_${index}_${suffix}`,
        external_id: `job_new_${index}`,
        idempotency_key_hash: `hash_new_${index}_${suffix}`
      });
    }

    const byExternal = await reports.listPublicFirstMeasureReports({ orgId, mode: "live", externalId: "job_old", limit: 1 });
    assert.deepEqual(byExternal.map((record) => record.report_id), [older.report_id]);
    const testByExternal = await reports.listPublicFirstMeasureReports({ orgId, mode: "test", externalId: "job_old" });
    assert.deepEqual(testByExternal.map((record) => record.report_id), [testMode.report_id]);
    assert.deepEqual(await reports.listPublicFirstMeasureReports({ orgId: otherOrgId, externalId: "job_old" }), []);

    assert.equal((await reports.findPublicFirstMeasureReportByIdempotency(orgId, `hash_old_${suffix}`, "live"))?.report_id, older.report_id);
    assert.equal((await reports.findPublicFirstMeasureReportByIdempotency(orgId, `hash_old_${suffix}`, "test"))?.report_id, testMode.report_id);
    assert.equal(await reports.findPublicFirstMeasureReportByIdempotency(otherOrgId, `hash_old_${suffix}`, "live"), null);
    assert.equal((await reports.findPublicFirstMeasureReportByProjectId(orgId, `proj_old_${suffix}`))?.report_id, older.report_id);
    assert.equal(await reports.findPublicFirstMeasureReportByProjectId(otherOrgId, `proj_old_${suffix}`), null);

    const listed = await reports.listPublicFirstMeasureReports({ orgId, mode: "live", limit: 500 });
    assert.equal(listed.length, 52);
    assert.ok(listed.every((record) => record.org_id === orgId && (record.mode ?? "live") === "live"));
    assert.deepEqual(listed.map((record) => record.created_at), [...listed.map((record) => record.created_at)].sort().reverse());
    assert.equal(listed.at(-1)?.report_id, older.report_id);
    assert.equal((await reports.listPublicFirstMeasureReports({ orgId, limit: 3 })).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
