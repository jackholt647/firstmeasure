import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const url = String(process.env.TEST_POSTGRES_URL ?? "");
test("bounded heartbeat coordinates sessions without occupying the single request connection", { skip: !url }, async () => {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname), "isolated local test database only");
  assert.equal(parsed.pathname, "/firstmeasure_test");
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = url;
  process.env.POSTGRES_POOL_MAX = "1";
  process.env.POSTGRES_CONNECTION_TIMEOUT_MS = "500";
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  await setup.query("CREATE TABLE platform_documents (organization_id text, collection text, id text, document jsonb, PRIMARY KEY (organization_id, collection, id))");
  await setup.query(`INSERT INTO platform_documents SELECT 'org', 'projects', lpad(n::text, 3, '0'),
    jsonb_build_object('id',n::text,'data',jsonb_build_object('events',jsonb_build_array(jsonb_build_object('start_at','2026-01-01')))) FROM generate_series(1,65) n`);
  await setup.query(`INSERT INTO platform_documents VALUES
    ('empty','projects','none','{"data":{"events":[]}}'),
    ('object','projects','none','{"data":{"events":{}}}'),
    ('missing','projects','none','{}'),
    ('other','customers','none','{"data":{"events":[{}]}}')`);
  const database = await import("../src/database/postgres.js");
  const { runPostgresPlatformHeartbeat } = await import("../platform/heartbeat_postgres.js");
  const visited: string[] = [];
  const processProject = async (org: string, doc: Record<string, unknown>) => {
    assert.equal(org, "org");
    await database.queryPostgres("SELECT 1");
    visited.push(String(doc.id));
  };
  const unexpected = (error: unknown) => { throw error; };
  try {
    await setup.query("SELECT pg_advisory_lock(1179471169, 1)");
    await runPostgresPlatformHeartbeat(processProject, unexpected);
    assert.equal(visited.length, 0, "another session owns the heartbeat");
    await setup.query("SELECT pg_advisory_unlock(1179471169, 1)");
    await runPostgresPlatformHeartbeat(processProject, unexpected);
    assert.equal(visited.length, 64, "one tick is bounded");
    await runPostgresPlatformHeartbeat(processProject, unexpected);
    assert.equal(visited.length, 65, "next tick advances without scanning organizations");
    assert.equal(new Set(visited).size, 65);

    await assert.rejects(runPostgresPlatformHeartbeat(async () => { throw new Error("fixture failure"); }, unexpected), /fixture failure/);
    const acquired = await setup.query("SELECT pg_try_advisory_lock(1179471169, 1) AS acquired");
    assert.equal(acquired.rows[0].acquired, true, "failure closes the lock session");
    await setup.query("SELECT pg_advisory_unlock(1179471169, 1)");

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const start = new Promise<void>(resolve => { entered = resolve; });
    const first = runPostgresPlatformHeartbeat(async () => { entered(); await gate; }, unexpected);
    await start;
    let competing = 0;
    await runPostgresPlatformHeartbeat(async () => { competing++; }, unexpected);
    assert.equal(competing, 0, "concurrent process session skips the owned batch");
    release();
    await first;
  } finally {
    await setup.end();
    await database.closePostgresPools();
  }
});
