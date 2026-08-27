import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  getFirstMeasureProcessRole,
  shouldRunFirstMeasureBackgroundProcessor
} from "../firstmeasure/background_role.js";
import { takeClusterWorkerSlot } from "../src/cluster_worker_slots.js";

test("background process roles do not depend on a web cluster worker id", () => {
  assert.equal(getFirstMeasureProcessRole("worker"), "worker");
  assert.equal(getFirstMeasureProcessRole("web"), "web");
  assert.equal(getFirstMeasureProcessRole("unexpected"), "combined");
  assert.equal(shouldRunFirstMeasureBackgroundProcessor("worker", "45"), true);
  assert.equal(shouldRunFirstMeasureBackgroundProcessor("web", "1"), false);
  assert.equal(shouldRunFirstMeasureBackgroundProcessor("combined", "1"), true);
  assert.equal(shouldRunFirstMeasureBackgroundProcessor("combined", "45"), false);
});

test("cluster services default to exactly one dedicated background role", () => {
  const previousTopology = process.env.DEPLOYMENT_TOPOLOGY;
  const previousNodeRole = process.env.CLUSTER_NODE_ROLE;
  const previousProcessRole = process.env.FIRSTMEASURE_PROCESS_ROLE;
  try {
    delete process.env.FIRSTMEASURE_PROCESS_ROLE;
    process.env.DEPLOYMENT_TOPOLOGY = "cluster";
    process.env.CLUSTER_NODE_ROLE = "web";
    assert.equal(getFirstMeasureProcessRole(), "web");
    assert.equal(shouldRunFirstMeasureBackgroundProcessor(), false);
    process.env.CLUSTER_NODE_ROLE = "legacy";
    assert.equal(getFirstMeasureProcessRole(), "web");
    process.env.CLUSTER_NODE_ROLE = "worker";
    assert.equal(getFirstMeasureProcessRole(), "worker");
    assert.equal(shouldRunFirstMeasureBackgroundProcessor(), true);
  } finally {
    if (previousTopology === undefined) delete process.env.DEPLOYMENT_TOPOLOGY;
    else process.env.DEPLOYMENT_TOPOLOGY = previousTopology;
    if (previousNodeRole === undefined) delete process.env.CLUSTER_NODE_ROLE;
    else process.env.CLUSTER_NODE_ROLE = previousNodeRole;
    if (previousProcessRole === undefined) delete process.env.FIRSTMEASURE_PROCESS_ROLE;
    else process.env.FIRSTMEASURE_PROCESS_ROLE = previousProcessRole;
  }
});

test("a crashed cluster worker is restarted in its original logical slot", () => {
  const slots = new Map<number, number>([
    [101, 1],
    [102, 2]
  ]);
  assert.equal(takeClusterWorkerSlot(slots, 101), 1);
  assert.equal(slots.has(101), false);
  assert.equal(slots.get(102), 2);
});

test("PostgreSQL distributed locks do not hold the application pool connection", async () => {
  const source = await readFile(path.resolve("firstmeasure/locks_postgres.ts"), "utf8");
  assert.doesNotMatch(source, /getPostgresPool\(\)\.connect\(\)/);
  assert.doesNotMatch(source, /pg_try_advisory_lock/);
  assert.match(source, /INSERT INTO firstmeasure_locks/);
  assert.match(source, /expires_at_ms <=/);
  assert.match(source, /DELETE FROM firstmeasure_locks/);
});

test("SQLite production mode is capped at one supervised HTTP writer", async () => {
  const source = await readFile(path.resolve("src/server.ts"), "utf8");
  assert.match(source, /firstmeasureDatabaseMode === "sqlite" \? 1 : requestedWorkers/);
  assert.match(source, /const superviseSingleWorker/);
  assert.match(source, /capped at one for SQLite write safety/);
});

test("background jobs use one SQLite dispatcher while retaining parallel execution slots", async () => {
  const source = await readFile(path.resolve("firstmeasure/job_runtime.ts"), "utf8");
  assert.match(source, /dispatcherLoop\(workerCount, logger\)/);
  assert.match(source, /active\.size >= workerCount/);
  assert.doesNotMatch(source, /for \(let slot = 0; slot < workerCount/);

  const queueSource = await readFile(path.resolve("firstmeasure/job_queue.ts"), "utf8");
  const candidateRead = queueSource.indexOf("const candidate = db.prepare");
  const writeLock = queueSource.indexOf('db.exec("BEGIN IMMEDIATE")', candidateRead);
  assert.ok(candidateRead >= 0 && writeLock > candidateRead, "job claims should check for work before taking a write lock");
});
