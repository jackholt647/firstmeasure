import assert from "node:assert/strict";
import test from "node:test";

process.env.FIRSTMEASURE_JOB_WORKERS = "0";
process.env.FIRSTMEASURE_INTERNAL_API_SECRET = "isolated-provider-route-secret";

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

test("a bare internal-secret header proves nothing; a signed service request passes the provider-route auth gate", async (t) => {
  const { buildApp, env } = await appAndEnv();
  assert.ok(env.firstMeasureInternalApiSecret, "test deployment must configure application.internal_api_secret");
  const app = await buildApp();
  t.after(async () => app.close());

  // The old shortcut: the secret itself in a header. It is no longer a credential
  // (docs/architecture/request-security.md#service-calls).
  const bare = await app.inject({
    method: "POST",
    url: "/v1/firstmeasure/projects/queue",
    headers: {
      "content-type": "application/json",
      "x-firstmeasure-internal": env.firstMeasureInternalApiSecret
    },
    payload: {}
  });
  assert.equal(bare.statusCode, 401, bare.body);

  // How PHP calls Node now: a request signed with the internal secret, here for unattended work.
  const { signedServiceHeaders } = await import("./helpers/security-fixture.js");
  const body = "{}";
  const response = await app.inject({
    method: "POST",
    url: "/v1/firstmeasure/projects/queue",
    headers: await signedServiceHeaders("POST", "/v1/firstmeasure/projects/queue", "system", body),
    payload: body
  });
  assert.notEqual(response.statusCode, 401, response.body);
});
