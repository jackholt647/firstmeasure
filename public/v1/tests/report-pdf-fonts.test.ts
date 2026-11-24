// Report PDFs embed one font, and jsPDF prints nothing for a letter that font lacks. Montserrat has no Greek, so
// Greek reports lost their legend, page titles and most labels (FM-632). pdf.js (pdfReportFontFiles) sets Greek
// reports in Noto Sans, which the shared PDF runtime serves beside Montserrat. Every report language's words must
// be in the font its report uses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getSharedPdfRuntimeAsset } from "../firstmeasure/pdf_runtime.js";

const v1 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.resolve(v1, "..");

/** The code points a TrueType font maps (cmap formats 4 and 12). */
function fontCodePoints(file: string) {
  const font = readFileSync(file);
  const tables = font.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i += 1) {
    if (font.toString("latin1", 12 + i * 16, 16 + i * 16) === "cmap") cmap = font.readUInt32BE(20 + i * 16);
  }
  assert.ok(cmap >= 0, `${file} has no cmap`);
  const points = new Set<number>();
  for (let i = 0; i < font.readUInt16BE(cmap + 2); i += 1) {
    const sub = cmap + font.readUInt32BE(cmap + 8 + i * 8);
    const format = font.readUInt16BE(sub);
    if (format === 4) {
      const segments = font.readUInt16BE(sub + 6) / 2;
      const ends = sub + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, offsets = deltas + segments * 2;
      for (let s = 0; s < segments; s += 1) {
        const start = font.readUInt16BE(starts + s * 2), end = font.readUInt16BE(ends + s * 2);
        const delta = font.readInt16BE(deltas + s * 2), offset = font.readUInt16BE(offsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          const glyph = offset === 0
            ? (c + delta) & 0xffff
            : font.readUInt16BE(offsets + s * 2 + offset + (c - start) * 2);
          if (glyph !== 0) points.add(c);
        }
      }
    } else if (format === 12) {
      for (let g = 0; g < font.readUInt32BE(sub + 12); g += 1) {
        const at = sub + 16 + g * 12;
        for (let c = font.readUInt32BE(at); c <= font.readUInt32BE(at + 4); c += 1) points.add(c);
      }
    }
  }
  return points;
}

function fontPair(regular: string, bold: string) {
  const a = fontCodePoints(path.join(publicRoot, "fonts", regular)), b = fontCodePoints(path.join(publicRoot, "fonts", bold));
  return new Set([...a].filter((point) => b.has(point)));
}

function reportCatalog(): Record<string, Record<string, unknown>> {
  const dir = path.join(publicRoot, "libraries", "platform-language", "catalogs");
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  return JSON.parse(readFileSync(path.join(dir, manifest.namespaces.reports), "utf8")).namespaces.reports;
}

function missingLetters(entries: Record<string, unknown>, covered: Set<number>) {
  const missing = new Set<string>();
  for (const value of Object.values(entries)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const char of text) if (!/\s/.test(char) && !covered.has(char.codePointAt(0)!)) missing.add(char);
  }
  return [...missing].join("");
}

const montserrat = fontPair("Montserrat-Regular.ttf", "Montserrat-Bold.ttf");
const noto = fontPair("NotoSans-Regular.ttf", "NotoSans-Bold.ttf");
// Locales pdf.js sets in Noto Sans (pdfReportFontFiles).
const notoLocale = (locale: string) => /^el\b/i.test(locale);
// No embeddable font has these yet: a Japanese one is several MB and needs its own decision.
const NO_FONT_YET = new Set(["ja-JP"]);

test("Montserrat has no Greek, Noto Sans has it all", () => {
  assert.equal(missingLetters({ el: "Κορυφογραμμή" }, montserrat).length > 0, true);
  assert.equal(missingLetters({ el: "Κορυφογραμμή Λαμαρίνα σύνδεσης με ανώτερο τοίχο ΪΫ ΐ" }, noto), "");
});

for (const [locale, entries] of Object.entries(reportCatalog())) {
  if (NO_FONT_YET.has(locale)) {
    test.todo(`${locale} report PDFs: no embedded font has its letters`);
    continue;
  }
  test(`${locale} report words are all in the ${notoLocale(locale) ? "Noto Sans" : "Montserrat"} the PDF embeds`, () => {
    assert.equal(missingLetters(entries, notoLocale(locale) ? noto : montserrat), "");
  });
}

test("the shared PDF runtime serves Noto Sans beside Montserrat", async () => {
  for (const [name, fileName] of [["font-noto-regular", "NotoSans-Regular.ttf"], ["font-noto-bold", "NotoSans-Bold.ttf"]] as const) {
    const asset = await getSharedPdfRuntimeAsset(name);
    assert.equal(path.basename(asset.filePath), fileName);
    assert.equal(asset.contentType, "font/ttf");
  }
  // GET /v1/firstmeasure/pdf-runtime/fonts/:name is how pdf.js reaches them on the worker and in the portal.
  const api = readFileSync(path.join(v1, "firstmeasure", "api.ts"), "utf8");
  assert.match(api, /fontName === "notosans-regular\.ttf" \? "font-noto-regular"/);
  assert.match(api, /fontName === "notosans-bold\.ttf" \? "font-noto-bold"/);
});
