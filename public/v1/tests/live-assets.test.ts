import assert from "node:assert/strict";
import test from "node:test";

import { liveChanges, parseLiveManifest } from "../platform/live_assets.js";

// docs/architecture/live-layer.md: what an open page is told when the live layer's manifest changes.

test("a page is told about written files and files that went back to the release, not about released ones", () => {
  const before = parseLiveManifest(JSON.stringify({ gen: 4, files: { "libraries/a.css": { sha: "1" }, "libraries/b.js": { sha: "2" }, "libraries/c.js": { sha: "3" } } }));
  const after = parseLiveManifest(JSON.stringify({
    gen: 5,
    files: { "libraries/a.css": { sha: "9" }, "libraries/d.svg": { sha: "4" } },
    retired: { "libraries/b.js": { reason: "released", gen: 5 }, "libraries/c.js": { reason: "conflict", gen: 5 } }
  }));
  assert.deepEqual(liveChanges(before, after), [
    { path: "libraries/a.css", sha: "9" },
    { path: "libraries/c.js", sha: null },
    { path: "libraries/d.svg", sha: "4" }
  ]);
  assert.deepEqual(liveChanges(after, after), []);
});

test("an unreadable manifest is an empty layer", () => {
  assert.deepEqual(parseLiveManifest("{"), { gen: 0, files: {} });
  assert.deepEqual(parseLiveManifest(JSON.stringify({ gen: 2, files: { "a.js": { sha: 5 } } })).files, {});
});
