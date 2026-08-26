import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(target));
    else output.push(target);
  }
  return output;
}

const files = await walk(docsRoot);
const textFiles = files.filter((file) => /\.(?:html|css|js|mjs|json|xml|md)$/.test(file));
const textByFile = new Map(await Promise.all(textFiles.map(async (file) => [file, await readFile(file, "utf8")])));

test("documentation contains no private development base URLs", () => {
  const forbidden = [
    ["local", "host"].join(""),
    ["127", "0", "0", "1"].join("."),
    [31, 1].join("0"),
    ["Local", "Testing"].join(" ")
  ];
  for (const [file, source] of textByFile) {
    for (const needle of forbidden) {
      assert.equal(source.includes(needle), false, `${path.relative(docsRoot, file)} contains forbidden marker ${needle}`);
    }
  }
});

test("every HTML id is unique and every relative href resolves", async () => {
  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  for (const file of htmlFiles) {
    const source = textByFile.get(file);
    const ids = [...source.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${path.relative(docsRoot, file)} has duplicate ids`);

    const hrefs = [...source.matchAll(/\shref="([^"]+)"/g)].map((match) => match[1]);
    for (const href of hrefs) {
      if (/^(?:https?:|mailto:|#)/.test(href)) {
        if (href.startsWith("#")) assert.ok(ids.includes(href.slice(1)), `${href} is missing in ${file}`);
        continue;
      }
      const [relativeTarget, fragment] = href.split("#");
      let target = path.resolve(path.dirname(file), relativeTarget);
      const targetInfo = await stat(target).catch(() => null);
      if (targetInfo?.isDirectory()) target = path.join(target, "index.html");
      assert.ok(await stat(target).catch(() => null), `${href} from ${path.relative(docsRoot, file)} does not resolve`);
      if (fragment && target.endsWith(".html")) {
        const targetSource = textByFile.get(target) ?? await readFile(target, "utf8");
        assert.match(targetSource, new RegExp(`\\sid=["']${fragment}["']`), `${href} points to a missing id`);
      }
    }
  }
});

test("sandbox explorer enforces its security and workflow contract", () => {
  const source = textByFile.get(path.join(docsRoot, "app.js"));
  assert.match(source, /startsWith\("fmk_test_"\)/);
  assert.match(source, /Live keys are refused before any network request/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  assert.match(source, /headers\["Idempotency-Key"\] = state\.idempotencyKey/);
  assert.match(source, /idempotent_replay/);
  assert.match(source, /POLL_DELAYS/);
  assert.match(source, /downloadResponse/);
  assert.match(source, /pagehide/);
  assert.doesNotMatch(source, /normalizeDocumentedReportOptions/);
});

test("reference describes sandbox limits and authoritative launch pricing", () => {
  const source = textByFile.get(path.join(docsRoot, "apis", "firstmeasure", "index.html"));
  assert.match(source, /amount_charged<\/code> is always <code>0/);
  assert.match(source, /no outbound completion webhook/i);
  assert.match(source, /Residential full report<\/td><td>\$7/);
  assert.match(source, /Commercial or multifamily full report<\/td><td>\$12/);
  assert.doesNotMatch(source, /gutter/i);
  assert.doesNotMatch(source, /weather report/i);
  assert.match(source, /Request echo diagnostic/);
});
