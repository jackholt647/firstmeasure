import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";

let app: any, root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publication-api-"));
  Object.assign(process.env, { NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", CUSTOMER_CALL_WORKER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", V1_LOG_LEVEL: "error" });
  for (const key of ["PLATFORM", "MESSAGING", "CHANNELS", "CRM", "FIRSTMEASURE", "PRICEBOOK"]) process.env[`${key}_STORAGE_ROOT`] = path.join(root, key.toLowerCase());
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "index.sqlite");
  app = await (await import("../src/app.js")).buildApp();
  await app.ready();
});
after(async () => {
  await app?.close(); await closePlatformFixtureStores();
  // The existing FirstMeasure background worker can reopen its index during
  // full-app teardown on Windows. Preserve that isolated fixture if still open.
  await rm(root, { recursive: true, force: true }).catch(error => {
    if (!["EBUSY", "EPERM"].includes(error?.code)) throw error;
  });
});

test("publication API shares auth, CSRF, typed dataset actions and project isolation", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/v1/publication/organizations/no-session/catalog" })).statusCode, 401);
  const response = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
    phone: nextTestPhone(), email: "publication@example.test", password: "correct horse battery staple", name: "Publication Owner", company: "Publication Test", organization_id: "org_publication"
  } });
  assert.equal(response.statusCode, 201, response.body);
  const cookies: string[] = (Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]]).filter(Boolean).map((s: string) => s.split(";")[0]!);
  const csrf = decodeURIComponent(cookies.find(s => s.startsWith("fm_platform_session_csrf="))!.split("=")[1]!);
  const orgId = response.json().organization.id;
  await enableExpandedPlatformFixture(orgId);
  const storage = await import("../platform/storage.js");
  await storage.upsertDocument(orgId, "projects", { id: "project", data: { name: "Move" } });
  const headers = { cookie: cookies.join("; "), "x-platform-csrf": csrf };
  const prefix = `/v1/publication/organizations/${orgId}`;
  const catalog = await app.inject({ method: "GET", url: `${prefix}/catalog?scope=project&projectId=project`, headers });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.ok(catalog.json().providers.some((p: any) => p.id === "datasets"));
  assert.ok(catalog.json().actions.some((a: any) => a.id === "datasets.save"));
  const target = { scope: "project", organizationId: orgId, projectId: "project" };
  const payload = { action: "datasets.save", target, idempotencyKey: "cube-create", input: { name: "Cube sheet", type: "inventory", schemaVersion: "1", value: { items: [{ id: "sofa", name: "Sofa", quantity: 2, volume: 30, volumeUnit: "ft3" }] } } };
  const missingCsrf = await app.inject({ method: "POST", url: `${prefix}/actions/invoke`, headers: { cookie: headers.cookie }, payload });
  assert.equal(missingCsrf.statusCode, 403);
  const created = await app.inject({ method: "POST", url: `${prefix}/actions/invoke`, headers, payload });
  assert.equal(created.statusCode, 200, created.body);
  const replay = await app.inject({ method: "POST", url: `${prefix}/actions/invoke`, headers, payload });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().receipt.replayed, true);
  const source = { provider: "datasets", export: "value", target: { ...target, id: created.json().value.id } };
  const read = await app.inject({ method: "POST", url: `${prefix}/data/read`, headers, payload: source });
  assert.equal(read.json().status, "ready", read.body);
  assert.equal(read.json().value.items[0].quantity, 2);
  const denied = await app.inject({ method: "POST", url: `${prefix}/data/read`, headers, payload: { ...source, target: { ...source.target, organizationId: "other" } } });
  assert.equal(denied.json().status, "denied", denied.body);
});
