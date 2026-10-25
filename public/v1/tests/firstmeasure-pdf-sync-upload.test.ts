import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("multipart PDF sync uploads reassemble and enqueue the original snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-pdf-sync-upload-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_STORAGE_ROOT = root;
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "projects-index.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");

  const projectId = "multipart-pdf-sync-test";
  const uploadId = "pdf-multipart-test-upload";
  let app: Awaited<ReturnType<typeof import("../src/app.js").buildApp>> | null = null;
  try {
    const storage = await import("../firstmeasure/storage.js");
    const { buildApp } = await import("../src/app.js");
    const now = new Date().toISOString();
    await storage.saveManifest(projectId, {
      id: projectId,
      schema_version: 2,
      status: "ready",
      project_type: "multifamily",
      address: "10 Multipart Way",
      workflow: { assigned_to: null, reserved_to: null, correction_to: null, history: [] },
      timestamps: { created_at: now, queued_at: now, updated_at: now },
      artifacts: {}
    } as unknown as import("../firstmeasure/storage.js").ProjectManifest);

    app = await buildApp();
    // The editor syncs PDFs for a signed-in staff member.
    const { staffFixture } = await import("./helpers/security-fixture.js");
    const { headers } = await staffFixture({ role: "technician" });
    const payload = Buffer.from(JSON.stringify({
      source: "inline",
      snapshot: {
        folderId: projectId,
        pdfSyncRevision: "multipart-revision-1",
        pdfRenderDateLabel: "8/18/2026",
        geometry: { points: [], connections: [] },
        report: { lines: [] },
        testMultipartMarker: "preserved"
      },
      pdf_sync_revision: "multipart-revision-1",
      pdf_render_recipe_version: "2026-10-06.1",
      persist_files: true,
      update_status: false,
      outputs: [{ slot: "main", mode: "full", persist: true, update_status: false }]
    }));
    const chunks = [payload.subarray(0, 73), payload.subarray(73, 211), payload.subarray(211)];
    const init = await app.inject({
      method: "POST",
      url: `/v1/firstmeasure/projects/${projectId}/pdfs/sync/uploads`,
      headers,
      payload: {
        upload_id: uploadId,
        chunk_count: chunks.length,
        payload_bytes: payload.length,
        payload_sha256: createHash("sha256").update(payload).digest("hex")
      }
    });
    assert.equal(init.statusCode, 201, init.body);

    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const response: { statusCode: number; body: string } = await app.inject({
        method: "POST",
        url: `/v1/firstmeasure/projects/${projectId}/pdfs/sync/uploads/${uploadId}/chunks/${index}`,
        headers,
        payload: { chunk_base64: chunks[index]!.toString("base64") }
      });
      assert.equal(response.statusCode, 201, response.body);
    }

    const complete = await app.inject({
      method: "POST",
      url: `/v1/firstmeasure/projects/${projectId}/pdfs/sync/uploads/${uploadId}/complete`,
      headers,
      payload: {}
    });
    assert.equal(complete.statusCode, 202, complete.body);
    assert.equal(complete.json().revision, "multipart-revision-1");
    const saved = await storage.readPdfState(projectId) as Record<string, unknown>;
    assert.equal(saved.testMultipartMarker, "preserved");
    assert.equal(existsSync(path.join(storage.projectDir(projectId), ".pdf-sync-uploads", uploadId)), false);
  } finally {
    await app?.close();
    // Closes the platform SQLite stores (the staff session lives there) and the project index.
    await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
    await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }
});
