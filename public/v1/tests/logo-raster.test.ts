import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { rasterizeSvgLogo } from "../platform/logo_raster.js";

// Website logos are often SVGs; fetch_image draws them into a PNG so the onboarding wizard can read the brand
// colors and upload the logo, without ever handing the browser an SVG (GP-170).
test("an SVG logo is drawn into a PNG that keeps its colors", async () => {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="46" viewBox="0 0 200 46">
    <rect width="46" height="46" fill="#4AAC00"/><rect x="60" width="140" height="46" fill="#102610"/>
    <script>alert(1)</script></svg>`);
  const png = await rasterizeSvgLogo(svg);
  assert.ok(png);
  const image = sharp(png);
  const meta = await image.metadata();
  assert.equal(meta.format, "png");
  assert.equal(Math.max(meta.width!, meta.height!), 800);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
  assert.deepEqual(at(20, 20), [0x4a, 0xac, 0x00]);
  assert.deepEqual(at(500, 20), [0x10, 0x26, 0x10]);
});

test("anything that is not an SVG is refused", async () => {
  assert.equal(await rasterizeSvgLogo(Buffer.from("<html><body>hi</body></html>")), null);
  assert.equal(await rasterizeSvgLogo(Buffer.from("not an image")), null);
});

// The wizard reads its brand colors from that PNG: a green mark beside dark lettering is a green brand, not a
// near-black one, and a logo whose pixels cannot be read keeps the colors already chosen (no red default).
test("the onboarding wizard reads a green brand from a green logo with dark lettering", async () => {
  const source = await readFile(new URL("../../libraries/apps/onboarding/wizard.js", import.meta.url), "utf8");
  const start = source.indexOf("  function extractColors(imgEl){");
  const end = source.indexOf("\n  async function findBestLogo");
  assert.ok(start > 0 && end > start);
  const withPixels = (pixels: Uint8ClampedArray | null) => ({
    createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => { if (!pixels) throw new Error("tainted"); return { data: pixels }; } }) })
  });
  const extractColors = (pixels: Uint8ClampedArray | null) => new Function("document", `${source.slice(start, end)}\nreturn extractColors;`)(withPixels(pixels))({});
  // The LeafHome logo (GP-170): a green house beside "LeafHome" in a green so dark it reads as black.
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="46" viewBox="0 0 200 46">
    <path d="M4 20 L22 4 L40 20 V44 H4 Z" fill="#4AAC00"/><rect x="50" y="8" width="150" height="34" fill="#102610"/></svg>`);
  const png = await rasterizeSvgLogo(svg);
  const { data } = await sharp(png!).ensureAlpha().resize(64, 64, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const colors = await extractColors(new Uint8ClampedArray(data));
  // Scaling to 64 px blends a few edge pixels in, so each color is the logo's to within a few steps.
  const near = (hex: string, want: string) => [1, 3, 5].every((i) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= 6);
  assert.ok(near(colors.primary, "#4AAC00"), colors.primary);
  assert.ok(near(colors.secondary, "#102610"), colors.secondary);
  assert.equal(await extractColors(null), null);
  assert.equal(await extractColors(new Uint8ClampedArray(64 * 64 * 4)), null);
});
