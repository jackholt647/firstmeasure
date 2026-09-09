import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../measure/internal/portal_scripts/manager_review.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("  function renderResultsBody(){"), source.indexOf("  async function toggleResultOverride("));
const esc = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

test("results distinguish minor no-score reviews from passed, major, and manually skipped reviews", () => {
  const body = { innerHTML: "", querySelectorAll: () => [] };
  const context = vm.createContext({
    document: { getElementById: (id: string) => id === "mraResultsBody" ? body : null },
    esc, fmArtifactUrl: () => "/artifact.png", categoryLabel: String, fmtShort: String,
    resultsData: {
      access: { can_override: true },
      summary: { reviewed: 5, issues: 1, excluded: 3, minor_excluded: 2, pass_rate: 50 },
      results: [
        { project_id: "minor", audit_status: "flagged", severity: "minor", score_exclusion_reason: "minor", attachments: [{ name: "image.png" }] },
        { project_id: "minor-manual", audit_status: "flagged", severity: "minor", score_excluded: true, score_exclusion_reason: "minor" },
        { project_id: "major", audit_status: "flagged", severity: "major" },
        { project_id: "pass", audit_status: "reviewed" },
        { project_id: "skip", audit_status: "reviewed", score_excluded: true, score_exclusion_reason: "manual" }
      ]
    }
  });
  vm.runInContext(render + "\nrenderResultsBody();", context);
  assert.equal((body.innerHTML.match(/Minor · not counted in quality score/g) || []).length, 2);
  assert.match(body.innerHTML, /<div class="v">1<\/div><div class="l">Passed/);
  assert.match(body.innerHTML, /<div class="v">2<\/div><div class="l">Minor · not scored/);
  assert.doesNotMatch(body.innerHTML, /data-id="minor(?:-manual)?"/);
  assert.match(body.innerHTML, /data-id="skip" data-excluded="1">Restore/);
  assert.match(body.innerHTML, /class="mra-result-image" data-image-src="\/artifact.png"/);
  assert.doesNotMatch(body.innerHTML, /target="_blank"/);
});

test("review image opens an accessible modal and closes without navigation", () => {
  let appended: any, clicked: (() => void) | undefined;
  const listeners: Record<string, (event?: unknown) => void> = {};
  const dialog = {
    innerHTML: "", shown: false, removed: false,
    setAttribute(key: string, value: string) { assert.equal(key, "aria-labelledby"); assert.equal(value, "mraReviewImageTitle"); },
    querySelector: () => ({ addEventListener(_event: string, callback: () => void) { clicked = callback; } }),
    addEventListener(event: string, callback: () => void) { listeners[event] = callback; },
    showModal() { this.shown = true; },
    close() { listeners.close?.(); },
    remove() { this.removed = true; }
  };
  const context = vm.createContext({ esc, document: {
    getElementById: () => null, createElement: (tag: string) => { assert.equal(tag, "dialog"); return dialog; },
    body: { appendChild(element: unknown) { appended = element; } }
  } });
  vm.runInContext(render + '\nshowReviewImageModal("/artifact.png", "<review>");', context);
  assert.equal(appended, dialog);
  assert.equal(dialog.shown, true);
  assert.match(dialog.innerHTML, /&lt;review>/);
  assert.match(dialog.innerHTML, /autofocus aria-label="Close screenshot"/);
  clicked?.();
  assert.equal(dialog.removed, true);
});
