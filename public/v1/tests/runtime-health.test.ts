import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";
import { createArtifactStorageProbe } from "../src/runtime_health.js";

test("load-balancer liveness and readiness endpoints identify the instance", async () => {
  const app = await buildApp();
  try {
    const live = await app.inject({ method: "GET", url: "/v1/health/live" });
    assert.equal(live.statusCode, 200);
    assert.equal(live.json().ok, true);
    assert.equal(typeof live.json().instance_id, "string");

    const ready = await app.inject({ method: "GET", url: "/v1/health/ready" });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().state, "ready");
    assert.equal(ready.json().checks.accepting_traffic, true);
  } finally {
    await app.close();
  }
});

// FM-500: one hung Spaces request no longer makes a node not ready (and the load balancer take dev's only node out).
test("artifact storage readiness retries, and a recent answer outlasts a brief outage", async () => {
  let clock = 1_000_000;
  let failures = 0;
  const check = async () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("Request aborted");
    }
  };
  const probe = createArtifactStorageProbe(check, { attempts: 3, graceMs: 120_000, now: () => clock });

  // Never reached yet (a start preflight): retried, then failed.
  failures = 3;
  assert.deepEqual(await probe(), { ok: false, error: "Request aborted" });

  failures = 2;
  const retried = await probe();
  assert.equal(retried.ok, true);
  assert.match(retried.warning ?? "", /attempt 3 of 3/);

  // Reached a minute ago: a failed check is a warning, not a node taken out.
  clock += 60_000;
  failures = 3;
  const grace = await probe();
  assert.equal(grace.ok, true);
  assert.match(grace.warning ?? "", /did not answer \(Request aborted\); it last answered 60 s ago/);

  // Unreachable for longer than the grace period: not ready.
  clock += 61_000;
  failures = 3;
  assert.deepEqual(await probe(), { ok: false, error: "Request aborted" });
});
