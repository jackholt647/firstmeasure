import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../measure/internal/portal_scripts/qa.js", import.meta.url), "utf8");
const start = source.indexOf("  function managerReviewReasonInfo(");
const end = source.indexOf("  function managerReviewReasonPill", start);
assert.ok(start > 0 && end > start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const reason = context.managerReviewReasonInfo as (item: Record<string, unknown>) => { key: string; label: string; title: string };

test("manager sign-off distinguishes VIP and new-QA reasons", () => {
  assert.equal(reason({ manager_review_reasons: ["vip"] }).label, "VIP project");
  assert.equal(reason({ manager_review_reasons: ["qa_trainee"] }).label, "New QA reviewer");
  assert.equal(reason({ manager_review_reasons: ["vip", "qa_trainee"] }).label, "VIP + New QA");
});

test("manager sign-off derives reasons for older queued records", () => {
  assert.equal(reason({ is_vip: true }).key, "vip");
  assert.equal(reason({ qa_reviewer_was_trainee: true }).key, "trainee");
  assert.equal(reason({}).key, "other");
});

test("manager queue and both inspectors render the reason label", () => {
  assert.ok((source.match(/managerReviewReasonPill\(/g) || []).length >= 3);
  assert.ok((source.match(/Manager Sign-off \(\$\{reason\.label\}\)/g) || []).length >= 3);
});
