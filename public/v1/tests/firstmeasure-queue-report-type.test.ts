import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectManifest } from "../firstmeasure/storage.js";

// FM-335: the internal portal's Queue Monitor filters by report type. The
// queue is counted and paged on the server, so queue/counts and queue/bucket
// filter before counting and paging: a full exterior report is a customer
// full-house order (an exteriors_ id), every other report is a roof.
test("queue counts and buckets filter by report type", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-queue-report-type-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_STORAGE_ROOT = root;
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "projects-index.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");

  try {
    const storage = await import("../firstmeasure/storage.js");
    const index = await import("../firstmeasure/project_index.js");
    const { buildApp } = await import("../src/app.js");
    await index.ensureFirstMeasureProjectIndexReady();

    const saveProject = async (id: string, extra: Record<string, unknown> = {}) => {
      const now = new Date().toISOString();
      await storage.saveManifest(id, {
        id,
        schema_version: 2,
        status: "queued",
        address: `${id} Test Way`,
        priority_level: 3,
        workflow: { assigned_to: null, reserved_to: null, correction_to: null, qa_claim: null, history: [] },
        timestamps: { created_at: now, queued_at: now, updated_at: now },
        ...extra
      } as unknown as ProjectManifest);
    };

    const exteriorOrder = `exteriors_${"a1".repeat(16)}`;
    const secondExteriorOrder = `exteriors_${"b2".repeat(16)}`;
    await saveProject("roof-one");
    await saveProject("roof-two");
    await saveProject("exteriors_not-an-order");
    await saveProject(exteriorOrder, { measurement_scope: "full_house" });
    await saveProject(secondExteriorOrder, { measurement_scope: "full_house" });

    const app = await buildApp();
    await app.ready();
    const { staffInjector } = await import("./helpers/security-fixture.js");
    const staffInject = staffInjector(app, {
      "manager@example.test": { role: "manager", name: "Manager" }
    }, { role: "manager", email: "manager@example.test" });
    const queued = async (reportType?: string, limit = 50, offset = 0) => {
      const extra = reportType ? { report_type: reportType } : {};
      const counts = await staffInject({ method: "POST", url: "/v1/firstmeasure/queue/counts", payload: { include_all: true, ...extra } });
      assert.equal(counts.statusCode, 200, counts.body);
      const bucket = await staffInject({
        method: "POST",
        url: "/v1/firstmeasure/queue/bucket",
        payload: { group: "queued", view: "card", include_all: true, limit, offset, ...extra }
      });
      assert.equal(bucket.statusCode, 200, bucket.body);
      const body = bucket.json();
      return {
        count: counts.json().counts.queued as number,
        total: body.pagination.total_count as number,
        hasMore: body.pagination.has_more as boolean,
        ids: (body.projects as Array<Record<string, unknown>>).map((row) => String(row.id)).sort()
      };
    };
    try {
      const all = await queued();
      assert.deepEqual(all.ids, [exteriorOrder, secondExteriorOrder, "exteriors_not-an-order", "roof-one", "roof-two"].sort());
      assert.equal(all.count, 5);

      const roofs = await queued("roof");
      assert.deepEqual(roofs.ids, ["exteriors_not-an-order", "roof-one", "roof-two"]);
      assert.equal(roofs.count, 3, "the Queued count counts only roofs");
      assert.equal(roofs.total, 3);

      const exteriors = await queued("full_house");
      assert.deepEqual(exteriors.ids, [exteriorOrder, secondExteriorOrder].sort());
      assert.equal(exteriors.count, 2, "the Queued count counts only full exterior reports");
      assert.equal(exteriors.total, 2);

      const firstPage = await queued("roof", 2, 0);
      assert.equal(firstPage.ids.length, 2);
      assert.equal(firstPage.hasMore, true, "pages are cut from the filtered rows");
      const secondPage = await queued("roof", 2, 2);
      assert.equal(secondPage.ids.length, 1);
      assert.equal(secondPage.hasMore, false);
      assert.deepEqual([...firstPage.ids, ...secondPage.ids].sort(), roofs.ids);

      assert.deepEqual((await queued("all")).ids, all.ids, "an unknown or 'all' report type does not filter");
      assert.equal(index.normalizeQueueReportType("Full exterior"), "full_house");
      assert.equal(index.normalizeQueueReportType("roofs"), "roof");
    } finally {
      await app.close();
      await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
    }
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("firstmeasure-queue-report-type-test-")) {
      throw new Error(`Refusing to remove unexpected test path '${resolved}'.`);
    }
    await rm(resolved, { recursive: true, force: true });
  }
});
