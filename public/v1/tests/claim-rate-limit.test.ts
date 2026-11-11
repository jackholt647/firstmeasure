import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { FastifyInstance } from "fastify";

import {
  CLAIM_LIMIT,
  LONG_BLOCK_MS,
  SHORT_BLOCK_MS,
  recordClaimAttempt,
  resetClaimRateLimits,
  stepClaimLimit,
  type ClaimLimitState
} from "../firstmeasure/claim-rate-limit.js";

// FM-387: claim-next flood protection. The PostgreSQL store is covered by claim-rate-limit-postgres.test.ts.

function run(times: number[]) {
  let state: ClaimLimitState = { attempts: [], blockedUntil: 0 };
  return times.map((now) => {
    const step = stepClaimLimit(state, now);
    state = step.state;
    return step;
  });
}

test("ten claims in five seconds are allowed; the eleventh blocks for five seconds", () => {
  const steps = run(Array.from({ length: 11 }, (_, index) => 1_000 + index * 100));
  assert.deepEqual(steps.slice(0, CLAIM_LIMIT).map((step) => step.allowed), Array(CLAIM_LIMIT).fill(true));
  assert.equal(steps[10]!.allowed, false);
  assert.deepEqual(steps[10]!.started, { blockMs: SHORT_BLOCK_MS, attempts: 11 });
  assert.equal(steps[10]!.state.blockedUntil, 2_000 + SHORT_BLOCK_MS);
});

test("the window slides: claims older than five seconds no longer count", () => {
  // Ten at once, then one every 600 ms: each new claim pushes the oldest out of the window.
  const times = [...Array(10).fill(0), 5_001, 5_601, 6_201];
  assert.ok(run(times).every((step) => step.allowed));
  // A person clicking Next every half second for a minute is never blocked.
  assert.ok(run(Array.from({ length: 120 }, (_, index) => index * 500 + 1)).every((step) => step.allowed));
});

test("a block has a fixed end: refused attempts are not counted and do not extend it", () => {
  const burst = Array.from({ length: 11 }, (_, index) => index);
  const during = Array.from({ length: 200 }, (_, index) => 11 + index * 20);
  const steps = run([...burst, ...during, 10 + SHORT_BLOCK_MS]);
  assert.equal(steps[10]!.state.blockedUntil, 10 + SHORT_BLOCK_MS);
  for (const step of steps.slice(11, -1)) {
    assert.equal(step.allowed, false);
    assert.equal(step.started, undefined, "one block, one start");
    assert.equal(step.state.blockedUntil, 10 + SHORT_BLOCK_MS);
  }
  assert.equal(steps.at(-1)!.allowed, true, "allowed again the moment the block ends");
});

test("a second block within a minute of the last one lasts a minute; a later one is short again", () => {
  let state: ClaimLimitState = { attempts: [], blockedUntil: 0 };
  const burst = (start: number) => {
    let started;
    for (let index = 0; index < 11; index += 1) {
      const step = stepClaimLimit(state, start + index);
      state = step.state;
      started ??= step.started;
    }
    return started;
  };
  assert.equal(burst(0)?.blockMs, SHORT_BLOCK_MS);
  // Ends at 5 010; the next burst right after it.
  assert.equal(burst(5_010)?.blockMs, LONG_BLOCK_MS);
  // A looping script stays on one-minute blocks.
  assert.equal(burst(state.blockedUntil)?.blockMs, LONG_BLOCK_MS);
  // More than a minute after the last block ended: a short block again.
  assert.equal(burst(state.blockedUntil + 60_001)?.blockMs, SHORT_BLOCK_MS);
});

test("recordClaimAttempt logs one warning per block, with the email, length and count", async () => {
  resetClaimRateLimits();
  const warnings: Array<{ object: Record<string, any>; message: string }> = [];
  const log = { warn: (object: Record<string, any>, message: string) => warnings.push({ object, message }) } as any;
  const results = [];
  for (let index = 0; index < 30; index += 1) results.push(await recordClaimAttempt("Looper@Example.test", log, 1_000 + index * 10));
  assert.deepEqual(results.map((result) => result.allowed), [...Array(10).fill(true), ...Array(20).fill(false)]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.object.claim_rate_limit.email, "looper@example.test");
  assert.equal(warnings[0]!.object.claim_rate_limit.block_seconds, 5);
  assert.equal(warnings[0]!.object.claim_rate_limit.attempts, 11);
  // Another person is counted separately.
  assert.equal((await recordClaimAttempt("someone@example.test", log, 1_300)).allowed, true);
  assert.equal((await recordClaimAttempt("", log, 1_300)).allowed, true, "no identity, nothing to count");
  resetClaimRateLimits();
});

let app: FastifyInstance;
let root = "";
/** Every request the app handled, in-process ones included. */
const seen: string[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-claim-limit-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.MEASURE_INTERNAL_ROOT = path.join(root, "measure", "internal");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(root, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  app.addHook("onRequest", async (request) => { seen.push(request.url); });
  await app.ready();
});

after(async () => {
  await app?.close();
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
  if (root) {
    for (const directory of ["platform", "internal", "measure", "pricebook"]) {
      await rm(path.join(root, directory), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

test("every claim path refuses a flood with exactly the empty-queue answer, counted once per claim", async () => {
  resetClaimRateLimits();
  const { staffFixture } = await import("./helpers/security-fixture.js");
  const technician = await staffFixture({ role: "technician", training_complete: true, queue_mode: "hot_swap" });
  const admin = await staffFixture({ role: "admin" });
  const send = (url: string, payload: Record<string, unknown>, headers: Record<string, string>) =>
    app.inject({ method: "POST", url, payload, headers });
  const nextForMe = () => send("/v1/internal/legacy-action", { action: "claim_next_for_me", actor_email: "someone-else@example.test" }, technician.headers);

  // Ten claims: each asks the queue (empty) and gets its answer. The legacy action injects
  // /queue/claim-next/compat as our own code; if that counted too, the sixth would be refused.
  const real = [];
  for (let index = 0; index < CLAIM_LIMIT; index += 1) real.push(await nextForMe());
  for (const response of real) {
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().error, "queue_empty");
  }
  seen.length = 0;
  const refused = await nextForMe();
  assert.deepEqual(seen, ["/v1/internal/legacy-action"], "refused before the queue status read or the claim");
  assert.equal(refused.statusCode, real[0]!.statusCode);
  assert.equal(refused.body, real[0]!.body, "refused exactly like an empty queue");
  const hotSwap = await send("/v1/internal/legacy-action", { action: "execute_hot_swap", target_folder: "x" }, technician.headers);
  assert.equal(hotSwap.statusCode, 404);
  assert.equal(hotSwap.body, real[0]!.body);

  // The direct routes share the same person's count, whoever the body names.
  const compat = await send("/v1/firstmeasure/queue/claim-next/compat", { actor: { email: admin.email } }, technician.headers);
  assert.equal(compat.statusCode, 404);
  assert.deepEqual(compat.json(), { ok: false, error: "queue_empty", message: "No eligible project was found in the queue.", details: null });

  // Another person is not affected; the admin route answers its own empty queue, then refuses the same way.
  const adminReal = await send("/v1/firstmeasure/queue/claim-next", { actor: { email: admin.email } }, admin.headers);
  assert.equal(adminReal.statusCode, 404, adminReal.body);
  for (let index = 1; index < CLAIM_LIMIT; index += 1) await send("/v1/firstmeasure/queue/claim-next", {}, admin.headers);
  const adminRefused = await send("/v1/firstmeasure/queue/claim-next", {}, admin.headers);
  assert.equal(adminRefused.statusCode, adminReal.statusCode);
  assert.equal(adminRefused.body, adminReal.body);

  // Queue status polling is not limited.
  const status = await send("/v1/internal/legacy-action", { action: "my_active_projects" }, technician.headers);
  assert.equal(status.statusCode, 200, status.body);
  resetClaimRateLimits();
});
