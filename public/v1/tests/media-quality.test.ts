import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { mediaQuality } from "../platform/media_variants.js";

// Browser code sends the upload's compression quality as a fraction (0.88).
// Read as a percentage it rounded to 1 and was raised to the lowest quality
// allowed, so every display rendition was encoded at WebP quality 35.

let root = "";
let storage: typeof import("../platform/storage.js");
const org = "media_quality_test";

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "media-quality-"));
  process.env.PLATFORM_STORAGE_ROOT = root;
  storage = await import("../platform/storage.js");
  await storage.createOrganization({ id: org, name: "Media quality test" });
});

after(async () => {
  try { const { closeSqlStoresForTests } = await import("../platform/sql_store.js"); await closeSqlStoresForTests(); } catch {}
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

test("a quality of 1 or less is a fraction of 100", () => {
  assert.equal(mediaQuality(0.88, 82, 35, 98), 88);
  assert.equal(mediaQuality(0.9, 82, 35, 98), 90);
  assert.equal(mediaQuality(".92", 82, 35, 98), 92);
  assert.equal(mediaQuality(1, 82, 35, 98), 98);
  assert.equal(mediaQuality(0.2, 82, 35, 98), 35);
});

test("a percentage is kept, limited to the allowed range", () => {
  assert.equal(mediaQuality(88, 82, 35, 98), 88);
  assert.equal(mediaQuality(100, 82, 35, 98), 98);
  assert.equal(mediaQuality(10, 82, 35, 98), 35);
  assert.equal(mediaQuality(0, 82, 35, 98), 35);
});

test("a missing or unreadable quality is the default", () => {
  assert.equal(mediaQuality(undefined, 82, 35, 98), 82);
  assert.equal(mediaQuality(null, 82, 35, 98), 82);
  assert.equal(mediaQuality("", 78, 35, 95), 78);
  assert.equal(mediaQuality("high", 78, 35, 95), 78);
});

test("a photo uploaded with quality 0.88 gets its display rendition at 88", async () => {
  const sharp = (await import("sharp")).default;
  // Noise, so the encoder's quality shows in the size of the result.
  const width = 2600, height = 1800;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 2654435761) >>> 24;
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const upload = (quality: unknown) => storage.storeMediaUpload(org, {
    ownerType: "organization", ownerId: org, slot: "photos", fileName: "roof.jpg", contentType: "image/jpeg", bytes,
    thumbnails: false, compression: { quality, max_width: 2400, max_height: 2400 }
  }) as Promise<any>;

  const asFraction = await upload(0.88);
  assert.equal(asFraction.processing.compression.quality, 88);
  assert.ok(asFraction.variants.display_2400, "the display rendition is made");

  const asPercent = await upload(88);
  assert.equal(asPercent.variants.display_2400.size_bytes, asFraction.variants.display_2400.size_bytes, "0.88 and 88 encode the same file");

  const lowest = await upload(35);
  assert.ok(asFraction.variants.display_2400.size_bytes > lowest.variants.display_2400.size_bytes, "and not the lowest quality's file");
});
