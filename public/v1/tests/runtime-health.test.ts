import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";

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
