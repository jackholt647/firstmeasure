import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();
test("email permission edits keep stable IDs and canonical records win over legacy duplicates", { skip: !databaseUrl }, async (t) => {
  const reset = new pg.Client({ connectionString: databaseUrl });
  await reset.connect();
  await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
  await reset.query("CREATE SCHEMA public");
  await reset.end();
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_POOL_MAX = "4";
  process.env.POSTGRES_AUTO_MIGRATE = "false";
  const [storage, database] = await Promise.all([import("../internal/storage.js"), import("../src/database/postgres.js")]);
  t.after(async () => database.closePostgresPools());
  await storage.saveInternalUser({ id: "legacy-hash-id", email: "reviewer@example.test", role: "manager", permissions: { perform_manager_review: false } });
  const edited = await storage.saveInternalUser({ id: "reviewer@example.test", email: "reviewer@example.test", permissions: { perform_manager_review: true } });
  assert.equal(edited.id, "legacy-hash-id", "email-based edit must not create a second ID");
  assert.equal((await storage.listInternalUsers({ search: "reviewer@example.test" })).length, 1);
  assert.equal((await storage.readInternalUser("reviewer@example.test"))?.permissions.perform_manager_review, true);

  // Reproduce the migrated hash + later email-ID duplicate without production writes.
  await database.queryPostgres(`INSERT INTO internal_users_index
    SELECT 'reviewer-example-test', email, name, account_type, status, department, role, team_id,
      branch_id, queue_mode, training_complete, disabled, has_shift_schedule, '2026-09-08T00:00:00Z',
      'reviewer-example-test.json', user_json || '{"id":"reviewer-example-test","permissions":{"perform_manager_review":true}}'::jsonb,
      now() FROM internal_users_index WHERE id = 'legacy-hash-id'`);
  await database.queryPostgres(`UPDATE internal_users_index SET updated_at = '2026-09-09T00:00:00Z',
    user_json = user_json || '{"permissions":{"perform_manager_review":false}}'::jsonb WHERE id = 'legacy-hash-id'`);
  const current = await storage.readInternalUser("reviewer@example.test");
  assert.equal(current?.id, "reviewer-example-test");
  assert.equal(current?.permissions.perform_manager_review, true);
  await database.queryPostgres(`UPDATE internal_users_index SET updated_at = '2026-09-10T00:00:00Z',
    user_json = user_json || '{"permissions":{"perform_manager_review":true}}'::jsonb WHERE id = 'legacy-hash-id'`);
  const revoked = await storage.saveInternalUser({ id: "reviewer@example.test", email: "reviewer@example.test", permissions: { perform_manager_review: false } });
  assert.equal(revoked.id, "reviewer-example-test");
  assert.equal((await storage.readInternalUser("reviewer@example.test"))?.permissions.perform_manager_review, false, "revocations must not be unioned with old permissions");
  await storage.patchInternalUser("reviewer@example.test", { permissions: { perform_manager_review: true } });
  assert.equal((await storage.readInternalUser("reviewer@example.test"))?.permissions.perform_manager_review, true);
});
