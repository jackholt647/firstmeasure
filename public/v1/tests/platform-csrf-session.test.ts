import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";

test("development-session admin writes require the matching CSRF token", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmate-csrf-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_SESSION_COOKIE_NAME = "fm_platform_session_development";
  process.env.V1_LOG_LEVEL = "error";
  for (const name of ["PLATFORM", "CRM", "FIRSTMEASURE", "PRICEBOOK", "MESSAGING", "INTERNAL"]) {
    process.env[`${name}_STORAGE_ROOT`] = path.join(root, name.toLowerCase());
  }
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects_index.sqlite");
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp();
  t.after(async () => {
    await app.close();
    await closePlatformFixtureStores();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const registered = await app.inject({ method:"POST", url:"/v1/platform/auth/register", payload:{
    phone:nextTestPhone(), email:"csrf-admin@example.test", password:"correct horse battery staple",
    name:"CSRF Admin", company:"CSRF Test", organization_id:"csrf_test"
  } });
  assert.equal(registered.statusCode, 201, registered.body);
  const values = registered.headers["set-cookie"] || [];
  const pairs = (Array.isArray(values) ? values : [values]).map(value => value.split(";")[0]!);
  const cookie = pairs.join("; ") + "; fm_platform_session_csrf=stale-production-token";
  const csrf = decodeURIComponent(pairs.find(value => value.startsWith("fm_platform_session_development_csrf="))!.split("=").slice(1).join("="));
  for (const token of ["", "stale-production-token"]) {
    const rejected = await app.inject({ method:"PATCH", url:"/v1/platform/me/preferences",
      headers:{ cookie, "x-platform-csrf":token }, payload:{ language:"en-US" } });
    assert.equal(rejected.statusCode, 403, rejected.body);
    assert.equal(rejected.json().error, "csrf_required");
  }
  const accepted = await app.inject({ method:"PATCH", url:"/v1/platform/me/preferences",
    headers:{ cookie, "x-platform-csrf":csrf }, payload:{ language:"en-US" } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const { renderCommunicationsDeveloperPage } = await import("../messaging/developer_page.js");
  assert.match(renderCommunicationsDeveloperPage("csrf_test"), /fm_platform_session_development_csrf=/);
});
