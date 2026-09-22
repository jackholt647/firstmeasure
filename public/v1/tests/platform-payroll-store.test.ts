import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("payroll protects revisions, earnings, concurrent batches, artifacts and automation outbox", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-payroll-store-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root,
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "", POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const store = await import("../payroll/storage.js");
  const service = await import("../payroll/service.js");
  const database = await import("../src/database/postgres.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await database.closePostgresPools(); await rm(root, { recursive: true, force: true }); });
  const org = `payroll_${randomUUID()}`;
  const schedule = await store.createPayrollSchedule(org, { name: "Weekly", recurrence: { frequency: "weekly", weekday: 5 } });
  const changes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.patchPayrollSchedule(org, schedule.id, { name: `Revision ${i}`, expected_revision: 1 })));
  assert.equal(changes.filter(result => result.status === "fulfilled").length, 1);
  await assert.rejects(store.readPayrollSchedule("another_org", schedule.id));
  const input = { payee: { type: "organization_user" as const, id: "alice", name: "Alice" }, schedule_id: schedule.id,
    kind: "commission" as const, amount_cents: 10000, source_event_id: "fixture-commission", worked_at: "2026-09-01T12:00:00.000Z" };
  await Promise.all(Array.from({ length: 12 }, () => service.recordPayrollLedgerEntries(org, [input])));
  assert.equal((await store.listPayrollLedgerEntries(org)).length, 1);
  const batches = await Promise.allSettled(Array.from({ length: 12 }, () => service.createPayrollBatch(org, {
    schedule_id: schedule.id, run_type: "off_cycle", pay_date: "2026-09-19", period_start: "2026-09-01", period_end: "2026-09-19"
  }, "alice")));
  assert.equal(batches.filter(result => result.status === "fulfilled").length, 1);
  const batch = (await store.listPayrollBatches(org))[0]!;
  const detail = await store.readPayrollBatch(org, String(batch.id));
  assert.equal(detail.total_cents, 10000);
  await service.applyPayrollBatchAction(org, String(batch.id), { action: "submit_approval", actor_user_id: "alice", approvers: [{ user_id: "alice", name: "Alice" }] });
  await service.applyPayrollBatchAction(org, String(batch.id), { action: "approve", actor_user_id: "alice" });
  await service.applyPayrollBatchAction(org, String(batch.id), { action: "finalize", actor_user_id: "alice" });
  const paid = await service.applyPayrollBatchAction(org, String(batch.id), { action: "paid", actor_user_id: "alice" });
  assert.equal(paid.status, "paid");
  assert.equal((await store.getPayrollDatabase().prepare("SELECT id FROM payroll_work_outbox WHERE id LIKE ?").all(`${org}:%`)).length, 1);
  await import("../platform/capability_defs.js");
  const core = await import("../platform/storage.js");
  if (url) {
    const { preparePlatformIndexes } = await import("../scripts/prepare-platform-indexes.js");
    assert.equal((await preparePlatformIndexes()).ready, true);
    assert.equal((await preparePlatformIndexes()).ready, true);
  }
  const live = await core.createOrganization({ name: "Outbox delivery fixture" });
  await (await import("../platform/capabilities.js")).saveCapabilityValues(String(live.id), { "platform.expanded_access": true });
  const outbox = store.getPayrollDatabase();
  const payload = { organization_id: live.id, type: "payroll.batch.paid", idempotency_key: `fixture:${org}`, payload: {} };
  await outbox.prepare("INSERT INTO payroll_work_outbox(id,payload_json,created_at) VALUES(?,?,?)").run(`healthy:${org}`, JSON.stringify(payload), new Date().toISOString());
  assert.equal(await service.drainPayrollWorkEvents(), 1);
  assert.equal((await outbox.prepare("SELECT state FROM payroll_work_outbox WHERE id LIKE ?").get(`${org}:%`))?.state, "blocked");
  assert.equal(await outbox.prepare("SELECT id FROM payroll_work_outbox WHERE id=?").get(`healthy:${org}`), undefined);
  await (await import("../platform/capabilities.js")).saveCapabilityValues(String(live.id), { "platform.expanded_access": false });
  await outbox.prepare("INSERT INTO payroll_work_outbox(id,payload_json,created_at) VALUES(?,?,?)").run(`paused:${org}`, JSON.stringify({ ...payload, idempotency_key: `paused:${org}` }), new Date().toISOString());
  assert.equal(await service.drainPayrollWorkEvents(), 0);
  const paused = await outbox.prepare("SELECT state,retry_at FROM payroll_work_outbox WHERE id=?").get(`paused:${org}`);
  assert.equal(paused?.state, "pending");
  assert.ok(String(paused?.retry_at) > new Date().toISOString());
  const artifact = await store.createPayrollArtifact(org, { file_name: "test.csv", content_type: "text/csv", content: Buffer.from("payee,amount\nAlice,100\n"), artifact_type: "export", report_type: "payroll" });
  assert.equal(Buffer.from((await store.readPayrollArtifact(org, String(artifact.id), true)).content as Uint8Array).toString(), "payee,amount\nAlice,100\n");
});
