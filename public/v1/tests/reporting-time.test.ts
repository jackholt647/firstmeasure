import assert from "node:assert/strict";
import test from "node:test";

import { MANAGEMENT_TIME_ZONE, managementDateKey, managementDayBounds } from "../firstmeasure/reporting_time.js";

test("management date uses the Pacific calendar day", () => {
  assert.equal(MANAGEMENT_TIME_ZONE, "America/Los_Angeles");
  assert.equal(managementDateKey(new Date("2026-08-18T06:59:59.999Z")), "2026-08-17");
  assert.equal(managementDateKey(new Date("2026-08-18T07:00:00.000Z")), "2026-08-18");
  assert.equal(managementDateKey(new Date("2026-01-15T07:59:59.999Z")), "2026-01-14");
  assert.equal(managementDateKey(new Date("2026-01-15T08:00:00.000Z")), "2026-01-15");
});

test("management day bounds follow daylight-saving transitions", () => {
  const summer = managementDayBounds("2026-08-18");
  assert.equal(new Date(summer.startMs).toISOString(), "2026-08-18T07:00:00.000Z");
  assert.equal(new Date(summer.endExclusiveMs).toISOString(), "2026-08-19T07:00:00.000Z");

  const winter = managementDayBounds("2026-01-15");
  assert.equal(new Date(winter.startMs).toISOString(), "2026-01-15T08:00:00.000Z");
  assert.equal(new Date(winter.endExclusiveMs).toISOString(), "2026-01-16T08:00:00.000Z");

  const springForward = managementDayBounds("2026-03-08");
  assert.equal(springForward.endExclusiveMs - springForward.startMs, 23 * 60 * 60 * 1000);

  const fallBack = managementDayBounds("2026-11-01");
  assert.equal(fallBack.endExclusiveMs - fallBack.startMs, 25 * 60 * 60 * 1000);
});

