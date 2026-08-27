import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();

test("cluster document stores remain atomic and visible across service modules", { skip: !databaseUrl }, async (t) => {
  const reset = new pg.Client({ connectionString: databaseUrl });
  await reset.connect();
  await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
  await reset.query("CREATE SCHEMA public");
  await reset.end();

  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_POOL_MAX = "16";
  process.env.POSTGRES_AUTO_MIGRATE = "false";
  process.env.FIRSTMEASURE_ARTIFACT_STORAGE = "local";

  const [documents, crm, pricebooks, database] = await Promise.all([
    import("../src/database/shared_documents.js"),
    import("../internal/crm/storage.js"),
    import("../pricebook/storage.js"),
    import("../src/database/postgres.js")
  ]);
  t.after(async () => database.closePostgresPools());

  const counterKey = { namespace: "test", scope: "cluster", collection: "counters", id: "atomic" };
  await documents.replaceSharedDocument(counterKey, { value: 0 });
  await Promise.all(Array.from({ length: 50 }, () => documents.mutateSharedDocument<{ value: number }>(
    counterKey,
    (current) => ({ value: current.value + 1 })
  )));
  assert.deepEqual(await documents.readSharedDocument(counterKey), { value: 50 });

  const crmRecord = await crm.upsertCrmDocument("organization", "settings", {
    id: "cluster-settings",
    data: { queue: "shared" }
  }, { orgId: "org-cluster" });
  assert.equal((await crm.readCrmDocument("organization", "settings", crmRecord.id, "org-cluster")).data.queue, "shared");

  const created = await pricebooks.createPricebook({ id: "cluster-pricebook", name: "Cluster Pricebook" });
  const revision = Number(created.manifest.revision);
  const writes = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => pricebooks.patchManifest(
    "cluster-pricebook",
    { metadata: { winner: index } },
    revision
  )));
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1, "one optimistic write should win");
  assert.equal((await pricebooks.readManifest("cluster-pricebook")).revision, revision + 1);
});
