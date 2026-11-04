import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectManifest } from "../firstmeasure/storage.js";

// FM-333: the staff dashboard draws each technician's active project from the
// compat overview's in_progress bucket. It must hold exactly what the queue
// shows as In Progress, including a claimed project that is still "ready".
test("compat overview in_progress matches the queue's In Progress group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-overview-in-progress-test-"));
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

    const saveProject = async (id: string, status: string, assignee: { email: string; name: string } | null) => {
      const now = new Date().toISOString();
      await storage.saveManifest(id, {
        id,
        schema_version: 2,
        status,
        address: `${id} Test Way`,
        priority_level: 3,
        ...(assignee ? { assigned_to_email: assignee.email, assigned_to_name: assignee.name } : {}),
        workflow: { assigned_to: assignee, reserved_to: null, correction_to: null, qa_claim: null, history: [] },
        timestamps: { created_at: now, queued_at: now, started_at: now, updated_at: now }
      } as unknown as ProjectManifest);
    };

    const claimedTech = { email: "claimed-tech@example.test", name: "Claimed Tech" };
    const workingTech = { email: "working-tech@example.test", name: "Working Tech" };
    await saveProject("claimed-ready", "ready", claimedTech);
    await saveProject("working-in-progress", "in_progress", workingTech);
    await saveProject("unclaimed-ready", "ready", null);

    const app = await buildApp();
    await app.ready();
    const { staffInjector } = await import("./helpers/security-fixture.js");
    const staffInject = staffInjector(app, {
      "manager@example.test": { role: "manager", name: "Manager" }
    }, { role: "manager", email: "manager@example.test" });
    try {
      const overview = await staffInject({
        method: "POST",
        url: "/v1/firstmeasure/queue/admin/overview/compat",
        payload: { view: "card", team: "all", include: ["in_progress"], bucket_limit: 250 }
      });
      assert.equal(overview.statusCode, 200, overview.body);
      const body = overview.json();
      const rows = body.in_progress as Array<Record<string, unknown>>;
      const byId = new Map(rows.map((row) => [String(row.id), row]));

      assert.ok(byId.has("claimed-ready"),
        "a project a technician has claimed is In Progress even while its status is still ready");
      assert.equal(String(byId.get("claimed-ready")?.assigned_to_email ?? "").toLowerCase(), claimedTech.email);
      assert.ok(byId.has("working-in-progress"));
      assert.ok(!byId.has("unclaimed-ready"), "an unclaimed ready project is queued, not in progress");
      assert.equal(rows.length, body.queue_meta.total_counts.in_progress,
        "the dashboard's in_progress rows must equal the queue's In Progress count");

      const bucket = await staffInject({
        method: "POST",
        url: "/v1/firstmeasure/queue/bucket",
        payload: { group: "in_progress", limit: 50, view: "card" }
      });
      assert.equal(bucket.statusCode, 200, bucket.body);
      const bucketIds = (bucket.json().projects as Array<Record<string, unknown>>).map((row) => String(row.id)).sort();
      assert.deepEqual([...byId.keys()].sort(), bucketIds);
    } finally {
      await app.close();
      await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
    }
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("firstmeasure-overview-in-progress-test-")) {
      throw new Error(`Refusing to remove unexpected test path '${resolved}'.`);
    }
    await rm(resolved, { recursive: true, force: true });
  }
});
