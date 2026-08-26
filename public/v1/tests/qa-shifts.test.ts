import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQaShiftLeaderboard,
  QA_SHIFT_INACTIVITY_GAP_MS,
  QA_SHIFT_TIME_ZONE,
  qaShiftDateKey,
  qaShiftQueryWindow
} from "../firstmeasure/qa_shifts.js";

test("QA shift points stay with the local date when a shift crosses midnight", () => {
  const events = [
    { email: "a@example.test", name: "A QA", occurredAtMs: Date.parse("2026-08-21T05:00:00Z"), points: 2 }, // 10 PM Pacific
    { email: "a@example.test", name: "A QA", occurredAtMs: Date.parse("2026-08-21T08:00:00Z"), points: 3 }, // 1 AM Pacific
    { email: "a@example.test", name: "A QA", occurredAtMs: Date.parse("2026-08-21T13:30:00Z"), points: 10 }, // 6:30 AM Pacific, new shift
    { email: "b@example.test", name: "B QA", occurredAtMs: Date.parse("2026-08-21T06:00:00Z"), points: 6 }
  ];

  const thursday = buildQaShiftLeaderboard(events, "2026-08-20");
  assert.equal(thursday.timezone, QA_SHIFT_TIME_ZONE);
  assert.equal(thursday.shift_gap_hours, QA_SHIFT_INACTIVITY_GAP_MS / 3_600_000);
  assert.deepEqual(thursday.leaderboard.map((row) => [row.email, row.points, row.approved_count]), [
    ["b@example.test", 6, 1],
    ["a@example.test", 5, 2]
  ]);
  assert.equal(thursday.leaderboard[1]!.shift_count, 1);
  assert.equal(thursday.leaderboard[1]!.shifts[0]!.date, "2026-08-20");
  assert.equal(thursday.leaderboard[1]!.shifts[0]!.ended_at, "2026-08-21T08:00:00.000Z");

  const friday = buildQaShiftLeaderboard(events, "2026-08-21");
  assert.equal(friday.leaderboard.length, 1);
  assert.equal(friday.leaderboard[0]!.points, 10);
  assert.equal(friday.leaderboard[0]!.shift_start_at, "2026-08-21T13:30:00.000Z");
});

test("QA default date stays on the current Pacific day", () => {
  assert.equal(qaShiftDateKey(new Date("2026-08-21T02:00:00Z")), "2026-08-20");
});

test("QA shift query windows include a lookback and the following overnight work", () => {
  const window = qaShiftQueryWindow("2026-08-20");
  assert.equal(new Date(window.startMs).toISOString(), "2026-08-20T07:00:00.000Z");
  assert.equal(window.startMs - window.queryStartMs, QA_SHIFT_INACTIVITY_GAP_MS);
  assert.equal(window.queryEndMs - window.endExclusiveMs, 24 * 60 * 60 * 1000);
});
