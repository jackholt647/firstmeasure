import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("stats SQL preserves aggregates, date buckets, custom fields, literal filters and cache versions", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-stats-store-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "", POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const store = await import("../stats/storage.js");
  const metrics = await import("../stats/metrics.js");
  const database = await import("../src/database/postgres.js");
  t.after(async () => { await store.closeStatsDatabase(); await database.closePostgresPools(); await rm(root, { recursive: true, force: true }); });
  const org = `stats_${randomUUID()}`;
  await store.upsertProjectFact({ organization_id: org, project_id: "one", title: "Offer 20%_!", source: "Offer 20%_!", status: "open", created_at: "2026-01-01T00:00:00.000Z", sold_at: "2026-01-03T00:00:00.000Z", contract_cents: 100, attrs: { area: 10 } });
  await store.upsertProjectFact({ organization_id: org, project_id: "two", title: "Another", status: "completed", created_at: "2026-02-01T00:00:00.000Z", sold_at: "2026-02-05T00:00:00.000Z", contract_cents: 300, attrs: { area: 20 } });
  await store.upsertProjectFact({ organization_id: "another_org", project_id: "three", contract_cents: 900 });
  assert.equal((await metrics.executeMetricSpec(org, { agg: "count" }))[0]!.value, 2);
  assert.equal((await metrics.executeMetricSpec(org, { agg: "sum", measure: "contract_cents" }))[0]!.value, 400);
  assert.equal((await metrics.executeMetricSpec(org, { agg: "sum", measure: "attr:area" }))[0]!.value, 30);
  for (const [bucket, expected] of Object.entries({ day: ["2026-01-01", "2026-02-01"], week: ["2025-12-29", "2026-01-26"], month: ["2026-01", "2026-02"], quarter: ["2026-Q1"], year: ["2026"] })) {
    const rows = await metrics.executeMetricSpec(org, { agg: "count", time: { bucket } });
    assert.deepEqual(rows.map(row => row.bucket), expected, bucket);
  }
  assert.equal((await metrics.executeMetricSpec(org, { agg: "count", filters: [{ field: "status", op: "contains", value: "OPEN" }] }))[0]!.value, 1);
  assert.equal((await metrics.executeMetricSpec(org, { agg: "count", filters: [{ field: "source", op: "contains", value: "%_!" }] }))[0]!.value, 1);
  assert.equal((await metrics.executeMetricSpec(org, { agg: "avg", measure: "days_to_sale" }))[0]!.value, 3);
  await store.ensureSyncState(org);
  await Promise.all(Array.from({ length: 12 }, () => store.bumpDataVersion(org)));
  assert.equal(Number((await store.readSyncState(org))!.data_version), 13);
  const queries = { total: { agg: "sum", measure: "contract_cents" } };
  const first = await metrics.executeStatsQueries(org, queries);
  const second = await metrics.executeStatsQueries(org, queries);
  assert.equal((first.results.total as any).cached, false);
  assert.equal((second.results.total as any).cached, true);
  await store.bumpDataVersion(org);
  assert.equal(((await metrics.executeStatsQueries(org, queries)).results.total as any).cached, false);
});
