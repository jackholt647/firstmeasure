import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("QA reference image lightbox provides bounded zoom, reset, wheel, and drag pan", async () => {
  const source = await readFile(path.resolve(process.cwd(), "../measure/internal/portal_scripts/qa.js"), "utf8");

  assert.match(source, /data-lightbox-zoom="in"/);
  assert.match(source, /data-lightbox-zoom="out"/);
  assert.match(source, /data-lightbox-zoom="fit"/);
  assert.match(source, /clamp\(Number\(nextZoom\) \|\| 1, 1, 6\)/);
  assert.match(source, /addEventListener\('wheel'/);
  assert.match(source, /qaLightboxPanX = qaLightboxDragStart\.panX/);
  assert.match(source, /resetLightboxZoom\(\)/);
});
