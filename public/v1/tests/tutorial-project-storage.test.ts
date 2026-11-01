import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "../internal/tutorial_project_storage.js";

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
