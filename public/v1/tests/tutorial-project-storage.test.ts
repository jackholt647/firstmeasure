import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureTutorialProjectNodeWritable, writeJsonFileAtomic } from "../internal/tutorial_project_storage.js";

async function phpCreatedProject(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "fm-tutorial-storage-"));
  t.after(async () => {
    for (const entry of await readdir(path.join(root, "projects")).catch(() => [] as string[])) {
      await chmod(path.join(root, "projects", entry), 0o755).catch(() => undefined);
      await chmod(path.join(root, "projects", entry, "artifacts"), 0o755).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  });
  const projects = path.join(root, "projects");
  const dir = path.join(projects, "tutorial_c6d771f66032248562f721aa");
  await mkdir(path.join(dir, "artifacts"), { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ id: "tutorial_c6d771f66032248562f721aa" }));
  await writeFile(path.join(dir, "answer_key.json"), "{}");
  await writeFile(path.join(dir, "artifacts", "quad_crop.png"), "png");
  return { projects, dir };
}

test("a tutorial project the API service can write is left in place", async (t) => {
  const { projects, dir } = await phpCreatedProject(t);
  assert.equal(await ensureTutorialProjectNodeWritable(dir, async () => true), false);
  assert.deepEqual(await readdir(projects), ["tutorial_c6d771f66032248562f721aa"]);
});

test("a PHP-created tutorial project is taken over so an artifact upload can be written", async (t) => {
  const { projects, dir } = await phpCreatedProject(t);
  // Production: www-data owns the folder and the ACL gives the API service r-x.
  const phpOwned = new Set([dir, path.join(dir, "artifacts")]);
  assert.equal(await ensureTutorialProjectNodeWritable(dir, async (target) => !phpOwned.has(target)), true);

  assert.equal(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")).id, "tutorial_c6d771f66032248562f721aa");
  assert.equal(await readFile(path.join(dir, "artifacts", "quad_crop.png"), "utf8"), "png");
  await writeFile(path.join(dir, "artifacts", "editor-history-abc.bin"), "history");

  const entries = (await readdir(projects)).sort();
  assert.equal(entries.length, 2);
  const [retired = "", project = ""] = entries;
  assert.equal(project, "tutorial_c6d771f66032248562f721aa");
  assert.match(retired, /^\.php-owned-tutorial_c6d771f66032248562f721aa-\d+$/);
  assert.doesNotMatch(retired, /^tutorial_[a-f0-9]{16,64}$/i, "listings must not pick up the retired copy");
  assert.equal(await readFile(path.join(projects, retired, "artifacts", "quad_crop.png"), "utf8"), "png");
});

test("a read-only project folder is taken over using real filesystem permissions", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX permissions as a non-root user" : false
}, async (t) => {
  const { projects, dir } = await phpCreatedProject(t);
  await chmod(path.join(dir, "artifacts"), 0o555);
  await chmod(dir, 0o555);
  await assert.rejects(writeFile(path.join(dir, "artifacts", "editor-history-abc.bin"), "x"), { code: "EACCES" });

  assert.equal(await ensureTutorialProjectNodeWritable(dir), true);
  await writeFile(path.join(dir, "artifacts", "editor-history-abc.bin"), "history");
  assert.equal((await readdir(projects)).length, 2);
});

test("a manifest being rewritten is always readable whole (FM-318)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fm-tutorial-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, "manifest.json");
  const data = { id: "tutorial_c6d771f66032248562f721aa", padding: "x".repeat(200_000) };
  await writeJsonFileAtomic(manifest, data);
  let writing = true;
  const writers = Promise.all(Array.from({ length: 8 }, async () => {
    for (let i = 0; i < 40; i++) await writeJsonFileAtomic(manifest, data);
  })).finally(() => { writing = false; });
  let reads = 0;
  while (writing) {
    assert.equal(JSON.parse(await readFile(manifest, "utf8")).id, data.id);
    reads++;
  }
  await writers;
  assert.ok(reads > 0);
  assert.deepEqual(await readdir(root), ["manifest.json"], "no temporary file is left behind");
});

test("a rewritten file keeps its mode so PHP can still write it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fm-tutorial-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, "manifest.json");
  await writeFile(manifest, "{}");
  await chmod(manifest, 0o666);
  await writeJsonFileAtomic(manifest, { id: "a" });
  assert.equal((await stat(manifest)).mode & 0o777, 0o666);
});

test("a folder the service cannot create files in still gets the write", { skip: process.getuid?.() === 0 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fm-tutorial-storage-"));
  t.after(async () => { await chmod(root, 0o755); await rm(root, { recursive: true, force: true }); });
  const manifest = path.join(root, "manifest.json");
  await writeFile(manifest, "{}");
  await chmod(root, 0o555);
  await writeJsonFileAtomic(manifest, { id: "a" });
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).id, "a");
});
