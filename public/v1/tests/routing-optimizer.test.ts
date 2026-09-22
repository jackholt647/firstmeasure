import assert from "node:assert/strict";
import test from "node:test";

import { haversineKm, optimizeRoutes, type RoutingStop } from "../routing/optimizer.js";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 3, 15, 0, 0); // arbitrary fixed anchor

function stop(id: string, startHours: number, durationHours = 2, locked = ""): RoutingStop {
  return {
    id,
    start_ms: T0 + startHours * HOUR,
    end_ms: T0 + (startHours + durationHours) * HOUR,
    ...(locked ? { locked_subject_id: locked } : {})
  };
}

test("assigns overlapping stops to different subjects", () => {
  const stops = [stop("a", 0), stop("b", 0), stop("c", 0)];
  const result = optimizeRoutes(stops, [{ id: "u1" }, { id: "u2" }, { id: "u3" }], () => 10);
  assert.equal(result.unassigned.length, 0);
  const nonEmpty = result.routes.filter((route) => route.stop_ids.length);
  assert.equal(nonEmpty.length, 3);
});

test("respects travel feasibility in tight gaps", () => {
  // b starts 30 minutes after a ends; travel a->b is 45 minutes, so one
  // subject cannot take both.
  const stops = [stop("a", 0, 2), stop("b", 2.5, 2)];
  const result = optimizeRoutes(stops, [{ id: "u1" }, { id: "u2" }], () => 45);
  assert.equal(result.unassigned.length, 0);
  for (const route of result.routes) assert.ok(route.stop_ids.length <= 1);
});

test("minimizes travel by clustering nearby stops", () => {
  // Two geographic clusters, two subjects, two time slots. Optimal: each
  // subject stays inside one cluster (5 min legs), never crosses (60 min).
  const near = new Map([
    ["a1|a2", 5], ["a2|a1", 5],
    ["b1|b2", 5], ["b2|b1", 5]
  ]);
  const travel = (from: string, to: string) => near.get(`${from}|${to}`) ?? 60;
  const stops = [stop("a1", 0), stop("b1", 0), stop("a2", 3), stop("b2", 3)];
  const result = optimizeRoutes(stops, [{ id: "u1" }, { id: "u2" }], travel);
  assert.equal(result.unassigned.length, 0);
  assert.equal(result.total_travel_minutes, 10);
});

test("pinned stops stay with their subject", () => {
  const stops = [stop("a", 0, 2, "u2"), stop("b", 3)];
  const result = optimizeRoutes(stops, [{ id: "u1" }, { id: "u2" }], () => 5);
  const routeU2 = result.routes.find((route) => route.subject_id === "u2");
  assert.ok(routeU2?.stop_ids.includes("a"));
});

test("reports stops nobody can take", () => {
  const stops = [stop("a", 0), stop("b", 0)];
  const result = optimizeRoutes(stops, [{ id: "u1" }], () => 10);
  assert.equal(result.unassigned.length, 1);
  assert.equal(result.unassigned[0]?.reason, "no_feasible_subject");
});

test("haversine distance is sane for Seattle geography", () => {
  // Space Needle -> Pike Place Market is roughly 1.7 km.
  const km = haversineKm(47.6205, -122.3493, 47.6097, -122.3422);
  assert.ok(km > 1 && km < 2.5, `expected ~1.7km, got ${km}`);
});
