import assert from "node:assert/strict";
import test from "node:test";

process.env.FIRSTMEASURE_JOB_WORKERS = "0";

async function appAndEnv() {
  const [{ buildApp }, { env }] = await Promise.all([
    import("../src/app.js"),
    import("../src/config/env.js")
  ]);
  return { buildApp, env };
}

test("provider-backed routes reject anonymous callers", async (t) => {
  const { buildApp } = await appAndEnv();
  const app = await buildApp();
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/firstmeasure/projects/queue",
    headers: { "content-type": "application/json" },
    payload: {}
  });
  assert.equal(response.statusCode, 401);
});

test("the private internal service secret passes the provider-route auth gate", async (t) => {
  const { buildApp, env } = await appAndEnv();
  assert.ok(env.firstMeasureInternalApiSecret, "test deployment must configure application.internal_api_secret");
  const app = await buildApp();
  t.after(async () => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/firstmeasure/projects/queue",
    headers: {
      "content-type": "application/json",
      "x-firstmeasure-internal": env.firstMeasureInternalApiSecret
    },
    payload: {}
  });
  assert.notEqual(response.statusCode, 401);
});
