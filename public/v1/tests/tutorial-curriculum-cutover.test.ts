import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    const recoveryCourse = "software-update-refresh";
    const oldUser = path.join(retained, "courses", recoveryCourse, "student@example.test");
    const recoveredUser = path.join(primary, "users", "student@example.test", "courses", recoveryCourse);
    const projectId = "tutorial_0123456789abcdef";
    await json(path.join(oldUser, "progress.json"), {
      completed_videos: ["retained-video"], completed_projects: [projectId], current_chapter: 4,
      test_attempts: { exam: [{ id: "attempt-1", completed: true, passed: true }] }
    });
    await json(path.join(oldUser, "projects", projectId, "manifest.json"), { id: projectId, student_email: "student@example.test" });
    await json(path.join(oldUser, "projects", projectId, "metadata.json"), { geometry: { points: [{ x: 42, y: 21 }] } });
    await json(path.join(oldUser, "projects", projectId, "artifacts", "proof.json"), { saved: true });
    const app = await buildApp();
    try {
      const fetch = (course_id = "default") => app.inject({ method: "POST", url: "/v1/internal/legacy-action", payload: { action: "fetch_curriculum", course_id, actor: { email: "student@example.test" } } });
      const restored = await fetch();
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json().curriculum.chapters[0].title, "Recovered course");
      assert.deepEqual(restored.json().progress.completed_videos, ["new-video"]);
      assert.equal(restored.json().progress.current_chapter, 3);
      assert.equal((await fetch("software-update-refresh")).json().curriculum.chapters[0].title, "Refresh");
      const recovered = JSON.parse(await readFile(path.join(recoveredUser, "progress.json"), "utf8"));
      assert.deepEqual(recovered.completed_videos, ["retained-video"]);
      assert.equal(recovered.test_attempts.exam[0].id, "attempt-1");
      const listed = await app.inject({ method: "POST", url: "/v1/internal/legacy-action", payload: {
        action: "list_tutorial_projects", course_id: recoveryCourse, actor: { email: "student@example.test" }
      } });
      assert.equal(listed.statusCode, 200, listed.body);
      assert.equal(listed.json().projects[0].id, projectId);
      if (spawnSync("php", ["-v"]).status === 0) {
        const php = execFileSync("php", ["-r", `
          require $argv[1];
          $progress = fm_tutorial_read_progress('software-update-refresh', 'student@example.test');
          $project = fm_tutorial_find_project('tutorial_0123456789abcdef', 'student@example.test', 'software-update-refresh');
          $progress['completed_videos'][] = 'php-completion';
          fm_tutorial_write_progress('software-update-refresh', 'student@example.test', $progress);
          echo json_encode(['progress' => $progress, 'project' => $project['manifest']['id'] ?? null]);
        `, fileURLToPath(new URL("../../measure/internal/_tutorials.php", import.meta.url))], { encoding: "utf8" });
        assert.equal(JSON.parse(php).project, projectId);
        assert.deepEqual((await fetch(recoveryCourse)).json().progress.completed_videos, ["retained-video", "php-completion"]);
      }
      assert.deepEqual(JSON.parse(await readFile(path.join(recoveredUser, "projects", projectId, "artifacts", "proof.json"), "utf8")), { saved: true });
      await json(path.join(recoveredUser, "progress.json"), { completed_videos: [], current_chapter: 1 });
      await json(path.join(recoveredUser, "projects", projectId, "metadata.json"), { revised: true });
      await fetch(recoveryCourse);
      assert.deepEqual(JSON.parse(await readFile(path.join(recoveredUser, "progress.json"), "utf8")).completed_videos, []);
      assert.deepEqual(JSON.parse(await readFile(path.join(recoveredUser, "projects", projectId, "metadata.json"), "utf8")), { revised: true });
      assert.equal(JSON.parse(await readFile(path.join(oldUser, "projects", projectId, "metadata.json"), "utf8")).geometry.points[0].x, 42);
      const removedProject = path.resolve(root, "removed-project");
      const currentProject = path.resolve(recoveredUser, "projects", projectId);
      for (const target of [removedProject, currentProject]) assert.ok(target.startsWith(path.resolve(root) + path.sep));
      await rename(currentProject, removedProject);
      const afterDeletion = await app.inject({ method: "POST", url: "/v1/internal/legacy-action", payload: {
        action: "list_tutorial_projects", course_id: recoveryCourse, actor: { email: "student@example.test" }
      } });
      assert.deepEqual(afterDeletion.json().projects, [], "completed recovery must not resurrect subsequently deleted projects");
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
