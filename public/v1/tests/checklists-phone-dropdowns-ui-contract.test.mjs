import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const publicRoot = path.resolve(import.meta.dirname, "..", "..");
const source = await readFile(path.join(publicRoot, "libraries/apps/checklists/app.js"), "utf8");

// FM-446: on a phone the Completes and customer access panels ran past the card (and off the screen),
// and the two switches in the Completes panel touched each other.
test("checklist Completes switches keep a gap and wrap", () => {
  assert.match(source, /\.fmcl-assignment-top\{[^}]*flex-wrap:wrap;[^}]*gap:/);
});

test("on phones the checklist dropdowns span the card instead of overflowing it", () => {
  const phone = source.match(/@media\(max-width:760px\)\{(.*)\}/)?.[1] || "";
  assert.match(phone, /\.fmcl-card-actions\{[^}]*position:relative/);
  assert.match(phone, /\.fmcl-card-actions \.fmcl-menu-wrap\{position:static\}/);
  assert.match(phone, /\.fmcl-assignment,\.fmcl-customer\{right:0;width:auto;box-sizing:border-box\}/);
});
