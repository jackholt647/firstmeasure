import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test("platform transactions share the one-slot core pool and recover nested schema rollback", { skip: !process.env.TEST_POSTGRES_URL }, async t => {
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: process.env.TEST_POSTGRES_URL,
    POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const { openSqlStore } = await import("../platform/sql_store.js");
  const core = await import("../src/database/postgres.js");
  const storage = await import("../platform/storage.js");
  const org = await storage.createOrganization({ name: "Atomic core transaction fixture" });
  const suffix = randomUUID().replaceAll("-", "");
  const table = `fixture_${suffix}`;
  const outer = openSqlStore({ id: `outer_${suffix}`, filename: "unused", initialize: async () => {} });
  const nested = openSqlStore({ id: `inner_${suffix}`, filename: "unused", initialize: async db => { await db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`); } });
  t.after(async () => { await outer.close(); await nested.close(); await core.queryPostgres(`DROP TABLE IF EXISTS ${table}`); await core.closePostgresPools(); });
  await assert.rejects(outer.transaction(async () => {
    await nested.prepare(`INSERT INTO ${table}(id) VALUES(?)`).run("rollback");
    assert.equal((await core.queryPostgres(`SELECT id FROM ${table}`)).rows[0]!.id, "rollback");
    await core.withPostgresTransaction(async client => { assert.equal((await client.query(`SELECT count(*) FROM ${table}`)).rows[0]!.count, "1"); });
    await storage.mutateGlobal(String(org.id), () => ({ data: { transaction_marker: "rolled-back" } }));
    await storage.upsertDocument(String(org.id), "projects", { id: "rollback_project", data: { title: "Rollback" } });
    throw new Error("rollback fixture");
  }), /rollback fixture/);
  assert.equal((await nested.prepare(`SELECT * FROM ${table}`).all()).length, 0);
  assert.equal((await storage.readGlobal(String(org.id))).data.transaction_marker, undefined);
  await assert.rejects(storage.readDocument(String(org.id), "projects", "rollback_project"));
  await nested.prepare(`INSERT INTO ${table}(id) VALUES(?)`).run("committed");
  assert.equal((await core.queryPostgres(`SELECT id FROM ${table}`)).rows[0]!.id, "committed");
});
