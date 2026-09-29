import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";

test("presence requires authentication and organization access, and streams the authenticated name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "presence-api-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  for (const key of ["PLATFORM", "CHANNELS", "CRM", "DOCUMENTS", "FIRSTMEASURE", "PRICEBOOK", "MESSAGING", "INTERNAL", "CALLS"]) process.env[`${key}_STORAGE_ROOT`] = path.join(root, key);
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "FIRSTMEASURE", "index.sqlite");
  const { buildApp } = await import("../src/app.js");
  const { upsertDocument } = await import("../platform/storage.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const app = await buildApp();
  try {
    const registration = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
      phone: nextTestPhone(), email: "presence@example.test", password: "correct horse battery staple", name: "Bill", company: "Presence test", organization_id: "org_presence_test"
    } });
    assert.equal(registration.statusCode, 201, registration.body);
    const data = registration.json();
    const org = String(data.organization.id);
    await enableExpandedPlatformFixture(org);
    const cookies = registration.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies || ""]).map(value => value.split(";")[0]).join("; ");
    await upsertDocument(org, "projects", { id: "project_presence", data: { title: "Presence" } });
    const url = `/v1/platform/organizations/${org}/presence/project%3Aproject_presence`;
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    const outsider = await app.inject({ method: "GET", url: url.replace(org, "org_other"), headers: { cookie } });
    assert.ok([403, 404].includes(outsider.statusCode), outsider.body);
    const missing = await app.inject({ method: "GET", url: url.replace("project_presence", "missing"), headers: { cookie } });
    assert.equal(missing.statusCode, 404, missing.body);
    const invalid = await app.inject({ method: "GET", url: url.replace("project%3Aproject_presence", "invalid"), headers: { cookie } });
    assert.equal(invalid.statusCode, 400, invalid.body);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`, { headers: { cookie }, signal: controller.signal });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      const first = await response.body!.getReader().read();
      const event = new TextDecoder().decode(first.value);
      assert.match(event, /event: presence/);
      assert.match(event, /Bill/);
    } finally { controller.abort(); }
  } finally {
    await app.close();
    await closePlatformFixtureStores();
    await closeSqlStoresForTests();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
