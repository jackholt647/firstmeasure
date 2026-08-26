import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("API key organization search is lightweight, searchable, and admin-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-key-org-search-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects-index.sqlite");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");

  const [{ buildApp }, internalStorage, platformStorage, publicKeys] = await Promise.all([
    import("../src/app.js"),
    import("../internal/storage.js"),
    import("../platform/storage.js"),
    import("../public-firstmeasure/keys.js")
  ]);

  try {
    await internalStorage.saveInternalUser({
      email: "admin@example.test",
      name: "Admin",
      role: "admin",
      is_admin: true,
      permissions: {}
    });
    await internalStorage.saveInternalUser({
      email: "tech@example.test",
      name: "Technician",
      role: "technician",
      permissions: {}
    });
    await platformStorage.createOrganization({ id: "legacy_internal", name: "Internal Staff" });
    await platformStorage.createOrganization({ id: "org_acme", name: "Acme Roofing" });
    await platformStorage.createOrganization({
      id: "org_test", name: "Sandbox Roofing", metadata: { is_test: true }
    });
    await platformStorage.createOrganization({ id: "org_plain", name: "Plain Siding" });
    await publicKeys.createPublicFirstMeasureApiKey({
      orgId: "org_acme",
      name: "Acme Partner Integration",
      mode: "test"
    });
    await publicKeys.createPublicFirstMeasureApiKey({
      orgId: "org_test",
      name: "Sandbox Integration",
      mode: "test"
    });

    const app = await buildApp();
    await app.ready();

    const missingActor = await app.inject({
      method: "GET",
      url: "/v1/internal/admin/firstmeasure-api-key-organizations"
    });
    assert.equal(missingActor.statusCode, 401);

    const denied = await app.inject({
      method: "GET",
      url: "/v1/internal/admin/firstmeasure-api-key-organizations",
      headers: { "x-internal-user-email": "tech@example.test" }
    });
    assert.equal(denied.statusCode, 403);

    const response = await app.inject({
      method: "GET",
      url: "/v1/internal/admin/firstmeasure-api-key-organizations?q=integration&key_filter=active&page=1&per_page=1",
      headers: { "x-internal-user-email": "admin@example.test" }
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.total, 2);
    assert.equal(payload.count, 1);
    assert.equal(payload.organizations.length, 1);
    assert.deepEqual(Object.keys(payload.organizations[0]).sort(), [
      "active_key_count", "id", "is_test", "latest_key_at", "name", "status", "total_key_count"
    ]);
    assert.equal(payload.pagination.total_pages, 2);
    assert.equal(payload.organizations[0].active_key_count, 1);
    assert.notEqual(payload.organizations[0].id, "legacy_internal");

    const sandbox = await app.inject({
      method: "GET",
      url: "/v1/internal/admin/firstmeasure-api-key-organizations?q=sandbox",
      headers: { "x-internal-user-email": "admin@example.test" }
    });
    assert.equal(sandbox.statusCode, 200);
    assert.equal(sandbox.json().organizations[0].id, "org_test");
    assert.equal(sandbox.json().organizations[0].is_test, true);

    const withoutKeys = await app.inject({
      method: "GET",
      url: "/v1/internal/admin/firstmeasure-api-key-organizations?key_filter=none",
      headers: { "x-internal-user-email": "admin@example.test" }
    });
    assert.equal(withoutKeys.statusCode, 200);
    assert.deepEqual(withoutKeys.json().organizations.map((organization: { id: string }) => organization.id), ["org_plain"]);

    await app.close();
  } finally {
    // SQLite can retain the index WAL briefly on Windows after Fastify closes.
    // The OS temp root is disposable, so clean the stores this test directly exercises.
    for (const directory of ["internal", "platform"]) {
      await rm(path.join(root, directory), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});
