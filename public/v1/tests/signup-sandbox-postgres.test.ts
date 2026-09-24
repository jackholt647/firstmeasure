import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();

test("signup sandbox documents use shared PostgreSQL storage", { skip: !databaseUrl }, async (t) => {
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_AUTO_MIGRATE = "false";
  process.env.PLATFORM_SESSION_SECRET = "sandbox-postgres-test-secret";

  const { sandboxStore } = await import("../signup-sandbox/storage.js");
  const { closePostgresPools } = await import("../src/database/postgres.js");
  t.after(closePostgresPools);

  const first = { id: "swf_shared_first", created_at: "2026-01-01T00:00:00Z", title: "First" };
  const second = { id: "swf_shared_second", created_at: "2026-01-02T00:00:00Z", title: "Second" };
  await Promise.all([sandboxStore.saveWorkflow(first), sandboxStore.saveWorkflow(second)]);
  assert.deepEqual((await sandboxStore.listWorkflows()).map((item) => item.id), [first.id, second.id]);
  assert.deepEqual(await sandboxStore.readWorkflow(first.id), first);

  await sandboxStore.deleteWorkflow(first.id);
  assert.equal(await sandboxStore.readWorkflow(first.id), null);
  assert.deepEqual((await sandboxStore.listWorkflows()).map((item) => item.id), [second.id]);
});
