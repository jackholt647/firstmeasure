import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const databaseUrl = process.env.TEST_POSTGRES_URL;

test("PostgreSQL creates immutable records atomically and shares frozen captures and action receipts", { skip: !databaseUrl }, async t => {
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl, POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false", FIRSTMEASURE_ARTIFACT_STORAGE: "local" });
  const storage = await import("../platform/storage.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const providers = await import("../platform/publication/providers.js");
  const bindings = await import("../platform/publication/bindings.js");
  const actions = await import("../platform/publication/actions.js");
  t.after(async () => {
    await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
    await (await import("../src/database/postgres.js")).closePostgresPools();
  });
  const org = `publication_${randomUUID().replaceAll("-", "")}`;
  await storage.createOrganization({ id: org, name: "Publication PostgreSQL test" });
  const creates = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => storage.upsertDocument(org, "publication_executions", { id: "only-one", data: { n } }, { createOnly: true })));
  assert.equal(creates.filter(r => r.status === "fulfilled").length, 1);
  await assert.rejects(storage.upsertDocument(org, "publication_executions", { id: "missing", data: {}, expected_revision: 2 }), { code: "revision_conflict" });
  const ctx = systemPublicationContext({ kind: "work", organizationId: org, operations: ["pg-test.value", "pg-test.write"], mode: "command" });
  const target = { scope: "organization" as const, organizationId: org };
  const policy = { scopes: ["organization"] as const, permissions: [], systemKinds: ["work"] as const };
  let reads = 0;
  providers.registerDataProvider({ id: "pg-test", version: "1", apps: [], exports: { value: { schema: { type: "number" }, schemaVersion: "1", description: "test", access: policy, read: async () => ({ value: ++reads }) } } });
  const binding = { kind: "data" as const, policy: "frozen" as const, source: { provider: "pg-test", export: "value", target } };
  const captures = await Promise.all(Array.from({ length: 8 }, () => bindings.resolveDataBinding(ctx, "consumer", "value", binding)));
  for (const capture of captures) assert.deepEqual(capture, captures[0]);
  let effects = 0;
  actions.registerAction({ id: "pg-test.write", version: "1", implementation: "test", domain: "test", description: "test", inputSchema: { type: "object" }, outputSchema: { type: "number" }, effect: "write", executionKinds: ["work"], policy, idempotency: "required", execute: async () => ++effects });
  const ref = { action: "pg-test.write", target };
  const invoked = await Promise.allSettled(Array.from({ length: 8 }, () => actions.invokeAction(ctx, ref, {}, { idempotencyKey: "one" })));
  assert.ok(invoked.some(r => r.status === "fulfilled"));
  assert.equal(effects, 1);
  assert.equal((await actions.invokeAction(ctx, ref, {}, { idempotencyKey: "one" })).receipt.replayed, true);
});
