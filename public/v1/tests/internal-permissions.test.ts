import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("shift editing is manager-only while statistics and bulk QA approval are full-admin-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "internal-permissions-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects-index.sqlite");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");

  const [{ buildApp }, internalStorage] = await Promise.all([
    import("../src/app.js"),
    import("../internal/storage.js")
  ]);

  const users = [
    { email: "admin@example.test", name: "Full Admin", role: "admin", is_admin: true, permissions: {} },
    { email: "manager@example.test", name: "Manager", role: "manager", permissions: {} },
    { email: "queue-manager@example.test", name: "Queue Manager", role: "technician", permissions: { manage_queue: true } },
    { email: "tech@example.test", name: "Technician", role: "technician", permissions: {} }
  ];

  try {
    for (const user of users) await internalStorage.saveInternalUser(user);

    const app = await buildApp();
    await app.ready();
    // Each staff member calls with their own session (identity headers no longer authenticate).
    const { staffFixture } = await import("./helpers/security-fixture.js");
    const sessions = new Map<string, Record<string, string>>();
    for (const user of users) sessions.set(user.email, (await staffFixture({ email: user.email })).headers);
    const as = (email: string) => sessions.get(email)!;
    const legacy = (action: string, actor: string, extra: Record<string, unknown> = {}) => app.inject({
      method: "POST",
      url: "/v1/internal/legacy-action",
      headers: as(actor),
      payload: { action, ...extra }
    });

    const technicianSchedules = await legacy("shift_get_schedules", "tech@example.test");
    assert.equal(technicianSchedules.statusCode, 200);
    assert.equal(technicianSchedules.json().edit_level, "none");

    for (const manager of ["manager@example.test", "queue-manager@example.test", "admin@example.test"]) {
      const schedules = await legacy("shift_get_schedules", manager);
      assert.equal(schedules.statusCode, 200);
      assert.equal(schedules.json().edit_level, "all");
    }

    const deniedShiftWrite = await legacy("shift_save_schedule", "tech@example.test", {
      target_email: "tech@example.test",
      recurring: JSON.stringify({ monday: { blocks: [{ start: "09:00", end: "17:00" }] } })
    });
    assert.equal(deniedShiftWrite.statusCode, 403);
    // Refused by the staff-level guard (LEGACY_ACTION_LEVELS) before the handler's own check.
    assert.equal(deniedShiftWrite.json().error, "staff_level_required");

    const managerShiftWrite = await legacy("shift_save_schedule", "manager@example.test", {
      target_email: "tech@example.test",
      recurring: JSON.stringify({ monday: { blocks: [{ start: "09:00", end: "17:00" }] } })
    });
    assert.equal(managerShiftWrite.statusCode, 200);
    assert.equal(managerShiftWrite.json().success, true);

    const managerStats = await legacy("stats_data", "manager@example.test");
    assert.equal(managerStats.statusCode, 403);
    const queueManagerStats = await legacy("stats_data", "queue-manager@example.test");
    assert.equal(queueManagerStats.statusCode, 403);
    const technicianStats = await legacy("stats_data", "tech@example.test");
    assert.equal(technicianStats.statusCode, 403);
    const adminStats = await legacy("stats_data", "admin@example.test");
    assert.equal(adminStats.statusCode, 200);

    const managerOverview = await app.inject({
      method: "GET",
      url: "/v1/internal/stats/overview",
      headers: as("manager@example.test")
    });
    assert.equal(managerOverview.statusCode, 403);
    const adminOverview = await app.inject({
      method: "GET",
      url: "/v1/internal/stats/overview",
      headers: as("admin@example.test")
    });
    assert.equal(adminOverview.statusCode, 200);

    const directShiftWrite = await app.inject({
      method: "POST",
      url: "/v1/internal/shifts/schedules/tech@example.test",
      headers: as("tech@example.test"),
      payload: { recurring: {} }
    });
    assert.equal(directShiftWrite.statusCode, 403);

    const managerBulkApprove = await app.inject({
      method: "POST",
      url: "/v1/firstmeasure/qa/bulk-approve",
      headers: as("manager@example.test"),
      payload: { project_ids: ["project-1"], actor: { email: "manager@example.test" } }
    });
    assert.equal(managerBulkApprove.statusCode, 403);
    // The route is declared admin-only, so the gate refuses a manager before the handler.
    assert.equal(managerBulkApprove.json().error, "access_denied");

    const adminBulkApprove = await app.inject({
      method: "POST",
      url: "/v1/firstmeasure/qa/bulk-approve",
      headers: as("admin@example.test"),
      payload: { project_ids: [], actor: { email: "admin@example.test" } }
    });
    assert.equal(adminBulkApprove.statusCode, 400);
    assert.equal(adminBulkApprove.json().error, "missing_projects");

    await app.close();
  } finally {
    // Close the platform SQLite stores so Windows can remove their files.
    await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
    // SQLite can keep its WAL briefly locked on Windows after Fastify closes.
    // Remove the non-database stores; the OS temp directory is disposable.
    for (const directory of ["internal", "platform"]) {
      await rm(path.join(root, directory), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});
