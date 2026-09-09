import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("manual requeue holds work while force kick returns it to drafting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'requeue-routing-'));
  Object.assign(process.env, {
    FIRSTMATE_ENV: 'test', FIRSTMEASURE_DATABASE_MODE: 'sqlite', FIRSTMEASURE_JOB_WORKERS: '0',
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, 'projects'),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(root, 'projects.sqlite'),
    INTERNAL_STORAGE_ROOT: path.join(root, 'internal'), PLATFORM_STORAGE_ROOT: path.join(root, 'platform')
  });
  const { buildApp } = await import('../src/app.js');
  const storage = await import('../firstmeasure/storage.js');
  const app = await buildApp();
  try {
    for (const destination of ['requeue', 'queued']) {
      const id = `routing-${destination}`;
      await storage.createProject({ id, address: 'Synthetic routing fixture', status: 'awaiting_review' });
      await storage.patchManifest(id, {
        workflow: { assigned_to: { email: 'tech@example.test' }, qa_claim: { email: 'qa@example.test' }, reserved_to: { email: 'tech@example.test' } }
      });
      const response = await app.inject({ method: 'POST', url: `/v1/firstmeasure/projects/${id}/requeue/force`, payload: {
        actor: { email: 'manager@example.test' }, ...(destination === 'requeue' ? { destination } : {})
      } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().success, true, response.body);
      const manifest = await storage.readManifest(id);
      assert.equal(manifest.status, destination);
      assert.equal(manifest.workflow?.assigned_to, null);
      assert.equal(manifest.workflow?.qa_claim, null);
      assert.equal(manifest.workflow?.reserved_to, null);
      assert.equal((manifest as any).force_kick?.email, 'tech@example.test');
      if (destination === 'requeue') {
        const release = await app.inject({ method: 'POST', url: `/v1/firstmeasure/projects/${id}/requeue/send-to-queue`, payload: { actor: { email: 'manager@example.test' } } });
        assert.equal(release.json().success, true);
        assert.equal((await storage.readManifest(id)).status, 'queued');
      }
    }
    await storage.createProject({ id: 'terminal-project', address: 'Synthetic completed fixture', status: 'completed' });
    const rejected = await app.inject({ method: 'POST', url: '/v1/firstmeasure/projects/terminal-project/requeue/force', payload: { destination: 'requeue' } });
    assert.equal(rejected.json().success, false);
    assert.equal((await storage.readManifest('terminal-project')).status, 'completed');
  } finally {
    await app.close();
    const index = await import('../firstmeasure/project_index.js');
    await index.closeFirstMeasureProjectIndex();
    await rm(root, { recursive: true, force: true });
  }
});

test("the admin UI describes force-kick as a return to regular drafting", async () => {
  const uiSource = await readFile(
    new URL("../../measure/internal/portal_scripts/projects.js", import.meta.url),
    "utf8"
  );

  assert.match(uiSource, /> Force Kick<\/button>/);
  assert.match(uiSource, /id="pmManualRequeueBtn"[^\n]+> Re-Queue<\/button>/);
  assert.match(uiSource, /Force Kick returns the project to the regular drafting queue/);
});
