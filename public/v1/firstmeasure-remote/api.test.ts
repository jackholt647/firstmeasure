import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerFirstMeasureRemoteApi, type FirstMeasureRemoteDataProvider } from "./api.js";

const key = "test-key-that-is-long-and-random-enough-for-the-test-only";
const hash = createHash("sha256").update(key).digest("hex");

async function testApp() {
  process.env.FIRSTMEASURE_REMOTE_API_KEY_SHA256 = hash;
  const app = Fastify({ logger: false });
  const provider: FirstMeasureRemoteDataProvider = {
    async summary() { return { ok: true, projects: { total: 12 }, queue: { queued: 3 } }; },
    async query(input) { return { ok: true, total: 2, received: input }; }
  };
  await app.register(registerFirstMeasureRemoteApi, { prefix: "/v1/firstmeasure-remote", dataProvider: provider });
  await app.ready();
  return app;
}

test("rejects requests without a key", async () => {
  const app = await testApp();
  const response = await app.inject({ method: "GET", url: "/v1/firstmeasure-remote/summary" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, "unauthorized");
  await app.close();
});

test("accepts a valid key and returns security headers", async () => {
  const app = await testApp();
  const response = await app.inject({ method: "GET", url: "/v1/firstmeasure-remote/summary", headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().projects.total, 12);
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
  assert.equal(response.headers["x-frame-options"], "DENY");
  await app.close();
});

test("rejects browser origins unless explicitly allowlisted", async () => {
  const app = await testApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/firstmeasure-remote/ping",
    headers: { authorization: `Bearer ${key}`, origin: "https://attacker.example" }
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "origin_forbidden");
  await app.close();
});

test("requires HTTPS for proxied external traffic", async () => {
  const app = await testApp();
  const response = await app.inject({
    method: "GET",
    url: "/v1/firstmeasure-remote/ping",
    headers: {
      authorization: `Bearer ${key}`,
      "x-forwarded-for": "203.0.113.5",
      "x-forwarded-proto": "http"
    }
  });
  assert.equal(response.statusCode, 426);
  assert.equal(response.json().error, "https_required");
  await app.close();
});

test("query accepts structured JSON only", async () => {
  const app = await testApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/firstmeasure-remote/query",
    headers: { authorization: `Bearer ${key}` },
    payload: { group_by: "status", statuses: ["completed"] }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().received.group_by, "status");
  await app.close();
});
