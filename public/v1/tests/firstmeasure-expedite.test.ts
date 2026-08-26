import assert from "node:assert/strict";
import test from "node:test";

import { buildReportExpediteOptions, reportExpediteBaseUnitPrice } from "../firstmeasure/expedite.js";

test("standard reports disclose and predict the one-hour delay without changing rush windows", () => {
  const quote = buildReportExpediteOptions({ now: new Date("2026-08-16T08:00:00.000Z") });
  const standard = quote.options.find((option) => option.key === "standard_3_6");
  const priorityOne = quote.options.find((option) => option.key === "rush_under_1");
  const priorityTwo = quote.options.find((option) => option.key === "rush_1_3");

  assert.equal(standard?.label, "4-7 hrs");
  assert.equal(standard?.base_start_minutes, 240);
  assert.equal(standard?.base_end_minutes, 420);
  assert.equal(standard?.estimated_wait_minutes, 240);
  assert.equal(priorityOne?.base_end_minutes, 60);
  assert.equal(priorityTwo?.base_end_minutes, 180);
});

test("only the expedite surcharge increases by fifteen percent", () => {
  assert.equal(reportExpediteBaseUnitPrice("residential", "standard_3_6", 240), 7);
  assert.equal(reportExpediteBaseUnitPrice("residential", "rush_1_3", 240), 8.15);
  assert.equal(reportExpediteBaseUnitPrice("residential", "rush_under_1", 240), 10.45);
  assert.equal(reportExpediteBaseUnitPrice("residential", "rush_1_3", 420), 10.45);
  assert.equal(reportExpediteBaseUnitPrice("residential", "rush_under_1", 420), 17.35);
  assert.equal(reportExpediteBaseUnitPrice("residential", "rush_1_3", 249), 8.27);
  assert.equal(reportExpediteBaseUnitPrice("residential", "rush_under_1", 249), 10.8);

  assert.equal(reportExpediteBaseUnitPrice("commercial", "standard_3_6", 240), 12);
  assert.equal(reportExpediteBaseUnitPrice("commercial", "rush_1_3", 240), 13.97);
});
