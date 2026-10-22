import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();

// 1M8-225: a customer-list page reads its organizations in batches; the rows must equal the per-organization reads.
test("batched customer summary rows equal per-organization rows", { skip: !databaseUrl }, async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "customer-summary-batch-"));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.end();
  Object.assign(process.env, {
    FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl, DATABASE_ADMIN_URL: databaseUrl,
    FIRSTMEASURE_STORAGE_ROOT: storageRoot, INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), POSTGRES_AUTO_MIGRATE: "true", FIRSTMEASURE_JOB_WORKERS: "0"
  });

  const orgIds = ["org_batch_a", "org_batch_b", "org_batch_c", "org_batch_empty"];
  const projects: Array<[string, string, Record<string, unknown>]> = [
    ["proj-a-1", "org_batch_a", { address: "1 Rue de Rivoli, Paris, France", report_property_country: "FR" }],
    ["proj-a-2", "org_batch_a", { address: "2 Main St, Austin, TX 78701, USA" }],
    ["proj-a-3", "org_batch_a", { address: "3 Instant Ln, Austin, TX, USA", instant_only: true }],
    ["fullhouse_a-4", "org_batch_a", { address: "4 Hidden Rd, Austin, TX, USA" }],
    ["proj-b-1", "org_batch_b", { address: "5 High St, London, UK" }],
    ["proj-c-1", "org_batch_c", { address: "6 Elm St, Denver, CO, USA" }],
    ["proj-x-1", "org_other", { address: "7 Other Ave, Reno, NV, USA" }]
  ];
  const baseTime = Date.now() - 100_000;
  for (const [index, [id, organizationId, extra]] of projects.entries()) {
    const directory = path.join(storageRoot, "projects", id);
    await mkdir(directory, { recursive: true });
    const timestamp = new Date(baseTime + index * 1_000).toISOString();
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
      id, schema_version: 2, status: "completed", organization_id: organizationId, owner_email: `${organizationId}@example.test`,
      timestamps: { created_at: timestamp, queued_at: timestamp, updated_at: timestamp }, ...extra
    }), "utf8");
  }

  const storage = await import("../platform/storage.js");
  const index = await import("../firstmeasure/project_index.js");
  const api = await import("../internal/api.js");
  await index.ensureFirstMeasureProjectIndexReady();

  await storage.createOrganization({ id: "org_batch_a", name: "Atlas", global: { contact: { address: { country: "FR" } }, credits_ledger: [{ amount: 5 }] } });
  await storage.createOrganization({ id: "org_batch_b", name: "Bristol", global: { sales_owner_email: "rep@example.test" } });
  await storage.createOrganization({ id: "org_batch_c", name: "Cascade" });
  await storage.createOrganization({ id: "org_batch_empty", name: "Empty" });
  await storage.upsertDocument("org_batch_a", "users", { id: "user-a-1", data: { email: "org_batch_a@example.test", name: "Ada" } });
  await storage.upsertDocument("org_batch_a", "users", { id: "user-a-2", data: { email: "second@example.test", name: "Bea" } });
  await storage.upsertDocument("org_batch_b", "users", { id: "user-b-1", data: { email: "org_batch_b@example.test" } });
  await storage.upsertDocument("org_batch_c", "projects", { id: "platform-c-1", data: { title: "Platform project", owner_email: "org_batch_c@example.test" } });

  const manifestsByOrg = await index.queryIndexedProjectManifestsByOrganization([...orgIds, " org_batch_a "], { limit: 20_000, includeInstantOnly: true });
  for (const orgId of orgIds) {
    const single = await index.queryIndexedProjectManifests({ organization_id: orgId, limit: 20_000, includeInstantOnly: true });
    assert.deepEqual(manifestsByOrg.get(orgId), single.projects, orgId);
  }
  assert.deepEqual(manifestsByOrg.get("org_batch_a")?.map((manifest) => manifest.id), ["proj-a-3", "proj-a-2", "proj-a-1"]);
  const limited = await index.queryIndexedProjectManifestsByOrganization(["org_batch_a"], { limit: 1, includeInstantOnly: false });
  assert.deepEqual(limited.get("org_batch_a")?.map((manifest) => manifest.id), ["proj-a-2"]);

  const organizations = (await storage.listOrganizations()).filter((org) => orgIds.includes(String(org.id)));
  const strip = (row: Record<string, unknown>) => JSON.parse(JSON.stringify(row, (key, value) => key === "days_since_last_order" ? null : value));
  const perOrganization = await Promise.all(organizations.map((org) => api.buildOrganizationSummaryRow(org, true)));
  const batched = await api.buildOrganizationSummaryRows(organizations, true);
  assert.deepEqual(batched.map(strip), perOrganization.map(strip));
  assert.equal(batched.find((row) => row.id === "org_batch_a")?.lifetimeOrders, 3);
  assert.equal(batched.find((row) => row.id === "org_batch_a")?.user_count, 2);
});
