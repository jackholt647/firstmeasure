import assert from "node:assert/strict";
import test from "node:test";

import { buildCapacityReport, type CapacityMinuteBucket } from "../internal/capacity_monitor.js";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

test("capacity report recommends the next practical CPU size after sustained saturation", () => {
  const report = buildCapacityReport(minutes(1_440, { cpu: 90, pressure: 8 }), NOW);

  assert.equal(report.action, "resize");
  assert.equal(report.current_vcpus, 48);
  assert.equal(report.recommended_vcpus, 64);
  assert.equal(report.windows.last_24_hours.minimum_vcpus_at_target, 62);
  assert.match(report.action_label, /64 vCPU/);
});

test("capacity report does not recommend a purchase when peak demand retains headroom", () => {
  const report = buildCapacityReport(minutes(1_440, { cpu: 55, pressure: 0 }), NOW);

  assert.equal(report.action, "no_purchase");
  assert.equal(report.recommended_vcpus, 48);
  assert.equal(report.windows.last_24_hours.status, "healthy");
});

test("capacity report directs operators to I/O before buying CPU", () => {
  const report = buildCapacityReport(minutes(1_440, { cpu: 88, pressure: 7, iowait: 14 }), NOW);

  assert.equal(report.action, "investigate");
  assert.equal(report.windows.last_24_hours.status, "investigate_io");
  assert.match(report.action_reason, /I\/O wait/);
});

test("capacity report waits for a meaningful baseline", () => {
  const report = buildCapacityReport(minutes(120, { cpu: 99, pressure: 20 }), NOW);

  assert.equal(report.action, "collecting");
  assert.equal(report.confidence, "low");
  assert.equal(report.windows.last_24_hours.status, "collecting");
});

test("an already-completed resize does not compound the old utilization percentage", () => {
  const oldCapacity = minutes(720, { cpu: 90, pressure: 8 });
  const newCapacity = minutes(720, { cpu: 68, pressure: 0 }).map((entry) => ({ ...entry, cpu_count: 64 }));
  const report = buildCapacityReport([...oldCapacity, ...newCapacity], NOW);

  assert.equal(report.current_vcpus, 64);
  assert.equal(report.recommended_vcpus, 64);
  assert.notEqual(report.action, "resize");
});

function minutes(count: number, options: { cpu: number; pressure: number; iowait?: number }) {
  return Array.from({ length: count }, (_, index): CapacityMinuteBucket => ({
    schema: 1,
    at: new Date(NOW - (count - index) * 60_000).toISOString(),
    cpu_count: 48,
    cpu_busy_avg_percent: options.cpu - 5,
    cpu_busy_p95_percent: options.cpu,
    cpu_busy_max_percent: Math.min(100, options.cpu + 5),
    cpu_iowait_p95_percent: options.iowait ?? 0,
    cpu_steal_p95_percent: 0,
    cpu_pressure_p95_percent: options.pressure,
    io_pressure_p95_percent: options.iowait ?? 0,
    load_1m_p95: 43,
    memory_used_p95_percent: 45,
    disk_used_percent: 70,
    web_workers_seen: 40,
    web_workers_expected: 40,
    request_count: 1_000,
    error_count: 0,
    slow_count: 3,
    request_p95_ms: 250,
    request_max_ms: 900,
    event_loop_p95_ms: 20,
    event_loop_max_ms: 60,
    active_requests_peak: 18
  }));
}
