import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeFileAtomic } from "../firstmeasure/storage.js";

test("concurrent atomic writes to one project file stay complete and leave no temp files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-atomic-write-"));
  const target = path.join(root, "manifest.json");

  try {
    await Promise.all(Array.from({ length: 250 }, (_, index) => {
      return writeFileAtomic(target, JSON.stringify({ index, payload: "x".repeat(4096) }));
    }));

    const saved = JSON.parse(await readFile(target, "utf8")) as { index: number; payload: string };
    assert.equal(saved.index, 249);
    assert.equal(saved.payload.length, 4096);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("firstmeasure-atomic-write-")) {
      throw new Error(`Refusing to remove unexpected test path '${resolved}'.`);
    }
    await rm(resolved, { recursive: true, force: true });
  }
});
