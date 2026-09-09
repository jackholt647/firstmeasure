import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("cutover curriculum fallback preserves new progress and explicit primary curricula", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tutorial-cutover-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
  const primary = path.join(root, "tutorials");
  process.env.MEASURE_INTERNAL_TUTORIALS_ROOT = primary;
  const retained = path.join(root, "public-storage", "measure", "internal", "tutorials");
  const json = async (file: string, value: unknown) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  };
  try {
    const [{ buildApp }, internalStorage] = await Promise.all([import("../src/app.js"), import("../internal/storage.js")]);
    await internalStorage.saveInternalUser({ email: "student@example.test", role: "technician", permissions: {} });
    await json(path.join(retained, "master", "curriculum.json"), { chapters: [{ id: 1, title: "Recovered course" }] });
    await json(path.join(retained, "courses", "software-update-refresh", "master", "curriculum.json"), { chapters: [{ id: 2, title: "Refresh" }] });
    await json(path.join(primary, "users", "student@example.test", "courses", "default", "progress.json"), { completed_videos: ["new-video"], current_chapter: 3 });
    await json(path.join(retained, "users", "student@example.test", "courses", "default", "progress.json"), { completed_videos: ["old-video"], current_chapter: 1 });
    const app = await buildApp();
    try {
      const fetch = (course_id = "default") => app.inject({ method: "POST", url: "/v1/internal/legacy-action", payload: { action: "fetch_curriculum", course_id, actor: { email: "student@example.test" } } });
      const restored = await fetch();
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json().curriculum.chapters[0].title, "Recovered course");
      assert.deepEqual(restored.json().progress.completed_videos, ["new-video"]);
      assert.equal(restored.json().progress.current_chapter, 3);
      assert.equal((await fetch("software-update-refresh")).json().curriculum.chapters[0].title, "Refresh");
      await json(path.join(primary, "master", "curriculum.json"), { chapters: [] });
      assert.deepEqual((await fetch()).json().curriculum.chapters, []);
    } finally { await app.close(); }
  } finally {
    await (await import("../firstmeasure/project_index.js")).closeFirstMeasureProjectIndex().catch(() => undefined);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith("tutorial-cutover-"));
    await rm(root, { recursive: true, force: true });
  }
});
