// The shared PDF runtime hands the project snapshot to Chrome, and gets each PDF back, in pieces.
// Chrome closes its DevTools pipe (and the browser) on a message over 100 MB: on production a project with
// many photos (a 65-100 MB snapshot) failed every pdf.sync with "page.evaluate: Target page, context or
// browser has been closed" (FM-380 rollback, 2026-11-10).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright-core";

import { readStringFromPage, sendJsonToPage, PAGE_TRANSFER_CHUNK_CHARS } from "../firstmeasure/pdf_runtime.js";

const CHROME_DEVTOOLS_MESSAGE_LIMIT = 100 * 1024 * 1024;

/** A page that runs evaluate in this process and refuses any argument or result over `limit` characters. */
function cappedPage(limit: number) {
  const store: Record<string, unknown> = {};
  let largest = 0;
  const measure = (value: unknown) => {
    const size = JSON.stringify(value ?? null).length;
    largest = Math.max(largest, size);
    if (size > limit) throw new Error(`message of ${size} characters is over the ${limit} limit`);
  };
  const page = {
    async evaluate(fn: (arg: unknown) => unknown, arg?: unknown) {
      measure(arg);
      const previous = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = store;
      try {
        const result = await fn(arg);
        measure(result);
        return result;
      } finally {
        (globalThis as Record<string, unknown>).window = previous;
      }
    }
  };
  return { page: page as unknown as Page, store, largest: () => largest };
}

test("a snapshot reaches the page whole, in pieces no bigger than the chunk size", async () => {
  const snapshot = {
    folderId: "p1",
    labels: ["Solin de mur en amont", "Firstwandanschlussblech", "😀 emoji 🏠", "é".repeat(13)],
    photos: Array.from({ length: 5 }, (_, i) => `data:image/jpeg;base64,${"A".repeat(40 + i)}`)
  };
  const json = JSON.stringify(snapshot);
  // Every chunk size from 2 to 30 puts a boundary inside some surrogate pair of the emoji.
  for (let chunk = 2; chunk <= 30; chunk += 1) {
    const { page, store, largest } = cappedPage(chunk + 200);
    const key = await sendJsonToPage(page, snapshot, chunk);
    assert.equal(store[key], json, `chunk ${chunk}`);
    assert.deepEqual(JSON.parse(String(store[key])), snapshot);
    assert.ok(largest() <= chunk + 200);
  }
});

test("a PDF comes back from the page in pieces and the page lets go of it", async () => {
  const { page, store } = cappedPage(64);
  const base64 = Buffer.from(Array.from({ length: 999 }, (_, i) => i % 256)).toString("base64");
  store.__fmPdfOutput0 = base64;
  assert.equal(await readStringFromPage(page, "__fmPdfOutput0", 16), base64);
  assert.equal("__fmPdfOutput0" in store, false);
});

test("renderSharedProjectPdfs never passes the snapshot or a PDF as one evaluate message", () => {
  const source = readFileSync(new URL("../firstmeasure/pdf_runtime.ts", import.meta.url), "utf8");
  const render = source.slice(source.indexOf("export async function renderSharedProjectPdfs"), source.indexOf("export const PAGE_TRANSFER_CHUNK_CHARS"));
  assert.match(render, /sendJsonToPage\(page, request\.snapshot\)/);
  assert.doesNotMatch(render, /snapshot:\s*request\.snapshot/);
  assert.match(render, /readStringFromPage\(page,/);
  assert.doesNotMatch(render, /^\s*base64\s*$/m);
  // A 4M-character chunk stays far under Chrome's limit even if every character were escaped to \uXXXX.
  assert.ok(PAGE_TRANSFER_CHUNK_CHARS * 6 < CHROME_DEVTOOLS_MESSAGE_LIMIT);
});

function chromeExecutable() {
  for (const candidate of [process.env.CHROME_PATH, process.env.FIRSTMEASURE_PDF_BROWSER]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (cache && existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((name) => name.startsWith("chromium-")).sort().reverse()) {
      const candidate = path.join(cache, dir, "chrome-linux64", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((candidate) => existsSync(candidate)) || null;
}

test("Chrome receives a snapshot bigger than its 100 MB DevTools message limit", { timeout: 120_000 }, async (t) => {
  const executablePath = chromeExecutable();
  if (!executablePath) {
    t.skip("no Chrome (set CHROME_PATH)");
    return;
  }
  const photo = "B".repeat(4 * 1024 * 1024);
  const snapshot = { folderId: "big", photos: Array.from({ length: 28 }, (_, i) => `${photo}${i}`) };
  assert.ok(JSON.stringify(snapshot).length > CHROME_DEVTOOLS_MESSAGE_LIMIT);
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const key = await sendJsonToPage(page, snapshot);
    const received = await page.evaluate((key) => {
      const store = window as unknown as Record<string, unknown>;
      const value = JSON.parse(String(store[key])) as { folderId: string; photos: string[] };
      store.__fmPdfOutput0 = btoa("%PDF-1.7 " + value.photos.length);
      return { folderId: value.folderId, count: value.photos.length, last: String(value.photos[27]).slice(-3), total: value.photos.reduce((sum, item) => sum + item.length, 0) };
    }, key);
    assert.deepEqual(received, { folderId: "big", count: 28, last: "B27", total: 28 * photo.length + 46 });
    assert.equal(Buffer.from(await readStringFromPage(page, "__fmPdfOutput0"), "base64").toString(), "%PDF-1.7 28");
    assert.equal(browser.isConnected(), true);
  } finally {
    await browser.close();
  }
});
