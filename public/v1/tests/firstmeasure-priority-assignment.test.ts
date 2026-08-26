import assert from "node:assert/strict";
import test from "node:test";

import {
  isRecentlyOnlineTechnician,
  technicianCanClaimPriorityLevel
} from "../firstmeasure/queue.js";

test("P1 prefers an available senior but falls back to a standard technician", () => {
  assert.equal(technicianCanClaimPriorityLevel("senior", 1, true), true);
  assert.equal(technicianCanClaimPriorityLevel("standard", 1, true), false);
  assert.equal(technicianCanClaimPriorityLevel("standard", 1, false), true);
});

test("junior technicians cannot claim P1 under the legacy rank fallback", () => {
  assert.equal(technicianCanClaimPriorityLevel("junior", 1, true), false);
  assert.equal(technicianCanClaimPriorityLevel("junior", 1, false), false);
  assert.equal(technicianCanClaimPriorityLevel("junior", 2, true), true);
});

test("explicit priority eligibility overrides rank while missing flags retain legacy behavior", () => {
  assert.equal(technicianCanClaimPriorityLevel("junior", 1, true, true), true);
  assert.equal(technicianCanClaimPriorityLevel("senior", 1, false, false), false);
  assert.equal(technicianCanClaimPriorityLevel("junior", 2, false, undefined, false), false);
  assert.equal(technicianCanClaimPriorityLevel("junior", 2, false, undefined, true), true);
  assert.equal(technicianCanClaimPriorityLevel("junior", 3, false, false, false), true);
});

test("senior availability only considers recently active, non-offline technicians", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  assert.equal(isRecentlyOnlineTechnician({ last_activity_at: "2026-08-24T11:59:00.000Z" }, now), true);
  assert.equal(isRecentlyOnlineTechnician({ last_activity_at: "2026-08-24T11:57:00.000Z" }, now), false);
  assert.equal(isRecentlyOnlineTechnician({
    last_activity_at: "2026-08-24T11:59:00.000Z",
    availability_status: "offline"
  }, now), false);
  assert.equal(isRecentlyOnlineTechnician({
    last_activity_at: "2026-08-24T11:59:00.000Z",
    disabled: true
  }, now), false);
});
