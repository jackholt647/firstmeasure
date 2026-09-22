import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("shared call lists deduplicate concurrent workflow entries and preserve their source nodes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-call-lists-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root,
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "",
    POSTGRES_POOL_MAX: "2", POSTGRES_AUTO_MIGRATE: "false", PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
  const core = await import("../platform/storage.js");
  const lists = await import("../internal/crm/call_lists.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { closePostgresPools } = await import("../src/database/postgres.js");
  t.after(async () => { await closeSqlStoresForTests(); await closePostgresPools(); await rm(root, { recursive: true, force: true }); });
  const org = await core.createOrganization({ id: `org_call_${randomUUID().replaceAll("-", "")}`, name: "Fixture" });
  const orgId = String(org.id);
  const first = await lists.ensureCallList(orgId, { key: "welcome", title: "Welcome calls" });
  const entries = await Promise.all(["node-a", "node-b"].map(work_node_id => lists.upsertCallListEntry(orgId, "welcome", {
    list: { create_only: true }, source_key: "project-1:welcome", project_id: "project-1", work_node_id, title: "Welcome" })));
  assert.equal(entries[0]!.id, entries[1]!.id);
  const queue = await lists.callListQueue(orgId);
  const welcome = queue.columns.find(column => column.id === first.id)!;
  assert.equal(welcome.tasks.length, 1);
  assert.deepEqual((welcome.tasks[0]!.work_node_ids as string[]).sort(), ["node-a", "node-b"]);
  assert.equal((await lists.removeCallListEntry(orgId, { entry_id: entries[0]!.id })).removed, 1);
  const next = await lists.callListQueue(orgId);
  assert.equal(next.columns.find(column => column.id === first.id)!.tasks.length, 0);
});
