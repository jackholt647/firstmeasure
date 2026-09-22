import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("platform worker tasks exclude duplicate workers and fence expired owners", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-worker-tasks-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root,
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "", POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const tasks = await import("../platform/worker_tasks.js");
  const core = await import("../src/database/postgres.js");
  t.after(async () => { await tasks.getPlatformTasksDatabase().close(); await core.closePostgresPools(); await rm(root, { recursive: true, force: true }); });
  const name = `fixture:${randomUUID()}`;
  const claims = await Promise.all(Array.from({ length: 20 }, () => tasks.claimPlatformTask(name)));
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean)!;
  assert.equal(await tasks.renewPlatformTask(name, old), true);
  await tasks.getPlatformTasksDatabase().prepare("UPDATE platform_worker_tasks SET lease_until=? WHERE name=?").run("2000-01-01", name);
  const current = await tasks.claimPlatformTask(name);
  assert.ok(current);
  assert.equal(await tasks.renewPlatformTask(name, old), false);
  assert.equal(await tasks.finishPlatformTask(name, old, 10000), false);
  assert.equal(await tasks.finishPlatformTask(name, current, 10000), true);
  assert.equal(await tasks.claimPlatformTask(name), null);
  const failing = `${name}:failure`;
  await assert.rejects(tasks.runPlatformTask(failing, 0, async () => { throw new Error("temporary failure"); }), /temporary failure/);
  const record = await tasks.getPlatformTasksDatabase().prepare("SELECT * FROM platform_worker_tasks WHERE name=?").get(failing);
  assert.equal(record?.last_error, "temporary failure");
  assert.equal(record?.lease_owner, "");
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { resume = resolve; });
  let wrote = false;
  const fencedName = `${name}:fenced`;
  const inFlight = tasks.runPlatformTask(fencedName, 0, async () => {
    entered(); await proceed;
    await tasks.withPlatformTaskLease(async () => { wrote = true; });
  });
  await started;
  await tasks.getPlatformTasksDatabase().prepare("UPDATE platform_worker_tasks SET lease_owner='replacement' WHERE name=?").run(fencedName);
  const rejected = assert.rejects(inFlight, /lease lost/);
  resume(); await rejected;
  assert.equal(wrote, false, "an old worker cannot commit after a replacement owns the task");
});
