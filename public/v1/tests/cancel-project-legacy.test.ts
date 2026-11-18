import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// FM-561: staff "Cancel project" read the whole project detail (manifest plus app_metadata.json,
// pdf_state.json and branding_defaults.json) to look at the manifest. A big commercial roof's
// pdf_state.json is 500 MB on production, so every cancel of one ran the compat worker out of
// memory and the person saw "Internal Server Error". Cancel must read only the manifest.
test("cancel_project cancels without a refund and never loads the full project detail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cancel-project-legacy-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects-index.sqlite");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");

  try {
    const [{ buildApp }, storage, internalStorage] = await Promise.all([
      import("../src/app.js"),
      import("../firstmeasure/storage.js"),
      import("../internal/storage.js")
    ]);
    await internalStorage.saveInternalUser({
      email: "canceller@example.test",
      name: "Cancelling Manager",
      role: "manager",
      permissions: { cancel_projects: true }
    });
    await internalStorage.saveInternalUser({
      email: "technician@example.test",
      name: "Ordinary Technician",
      role: "technician",
      permissions: {}
    });

    await storage.createProject({ id: "cancel-big-roof", address: "624 Big Roof Ave", project_type: "commercial" });
    await storage.patchManifest("cancel-big-roof", {
      status: "requeue",
      amount_charged: 12,
      work_history: [{ event: "created", ts: "2026-11-16 22:52:00" }]
    });
    await storage.savePdfState("cancel-big-roof", { facesData: [{ sourceCalcPoints: [[0, 0, 0]] }] });

    const app = await buildApp();
    const detailReads: string[] = [];
    app.addHook("onRequest", async (request) => {
      if (request.method === "GET" && /^\/v1\/firstmeasure\/projects\/[^/?]+(\?|$)/.test(request.url)) detailReads.push(request.url);
    });
    await app.ready();
    const { staffInjector } = await import("./helpers/security-fixture.js");
    const staffInject = staffInjector(app);
    const cancel = (actor: string, extra: Record<string, unknown>) => staffInject({
      method: "POST",
      url: "/v1/internal/legacy-action",
      payload: { action: "cancel_project", actor: { email: actor }, ...extra }
    });

    const forbidden = await cancel("technician@example.test", { folder: "cancel-big-roof", refund_mode: "no_refund" });
    assert.equal(forbidden.statusCode, 403);

    const missing = await cancel("canceller@example.test", { folder: "no-such-project", refund_mode: "no_refund" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error, "Project not found");

    const cancelled = await cancel("canceller@example.test", { folder: "cancel-big-roof", refund_mode: "no_refund" });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().success, true);
    assert.equal(cancelled.json().refund_applied, false);
    assert.equal(cancelled.json().refund_amount, 0);
    assert.deepEqual(detailReads, [], "cancel must read only the manifest, not app_metadata/pdf_state");

    const manifest = await storage.readManifest("cancel-big-roof");
    assert.equal(manifest.status, "cancelled");
    assert.equal(manifest.cancellation_refund_decision, "not_refunded");
    assert.equal(manifest.cancellation_refunded, false);
    assert.equal(manifest.cancelled_by_email, "canceller@example.test");
    const history = manifest.work_history as Array<Record<string, unknown>>;
    assert.equal(history[0]?.event, "created", "earlier history is kept");
    assert.equal(history.at(-1)?.event, "cancelled_project");
    assert.equal(history.at(-1)?.refund_decision, "not_refunded");
    assert.ok(await storage.readPdfState("cancel-big-roof"), "the project's files are untouched");

    const again = await cancel("canceller@example.test", { folder: "cancel-big-roof", refund_mode: "no_refund" });
    assert.equal(again.statusCode, 400);
    assert.equal(again.json().error, "Only active projects can be cancelled");

    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
