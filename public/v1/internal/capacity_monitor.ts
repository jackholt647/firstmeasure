import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled, queryPostgres } from "../src/database/postgres.js";
import { listSharedDocuments, readSharedDocument, replaceSharedDocument } from "../src/database/shared_documents.js";

type WorkerMinuteSnapshot = {
  schema: 1;
  at: string;
  ended_at_ms: number;
  worker_id: string;
  pid: number;
  request_count: number;
  error_count: number;
  slow_count: number;
  duration_sum_ms: number;
  duration_max_ms: number;
  duration_histogram: number[];
  event_loop_p95_ms: number;
  event_loop_max_ms: number;
  active_requests_peak: number;
};

export type CapacityMinuteBucket = {
  schema: 1;
  at: string;
  cpu_count: number;
  cpu_busy_avg_percent: number;
  cpu_busy_p95_percent: number;
  cpu_busy_max_percent: number;
  cpu_iowait_p95_percent: number;
  cpu_steal_p95_percent: number;
  cpu_pressure_p95_percent: number;
  io_pressure_p95_percent: number;
  load_1m_p95: number;
  memory_used_p95_percent: number;
  disk_used_percent: number;
  web_workers_seen: number;
  web_workers_expected: number;
  request_count: number;
  error_count: number;
  slow_count: number;
  request_p95_ms: number;
  request_max_ms: number;
  event_loop_p95_ms: number;
  event_loop_max_ms: number;
  active_requests_peak: number;
};

export type CapacityWindowReport = {
  window: "24h" | "7d";
  sample_count: number;
  coverage_percent: number;
  data_span_hours: number;
  cpu_count: number;
  cpu_avg_percent: number;
  cpu_p95_percent: number;
  cpu_p99_percent: number;
  busy_cores_p95: number;
  cpu_pressure_p95_percent: number;
  iowait_p95_percent: number;
  steal_p95_percent: number;
  load_p95: number;
  memory_p95_percent: number;
  disk_latest_percent: number;
  request_count: number;
  error_count: number;
  slow_count: number;
  request_p95_ms: number;
  event_loop_p95_ms: number;
  recommended_vcpus: number;
  minimum_vcpus_at_target: number;
  status: "collecting" | "healthy" | "watch" | "resize" | "investigate_io" | "investigate_memory";
  reason: string;
};

export type CapacityReport = {
  schema: 1;
  generated_at: string;
  storage: string;
  sampling: {
    host_interval_seconds: number;
    aggregate_interval_seconds: number;
    retention_days: number;
    target_peak_cpu_percent: number;
  };
  current_vcpus: number;
  action: "collecting" | "no_purchase" | "watch" | "resize" | "investigate";
  action_label: string;
  action_reason: string;
  recommended_vcpus: number;
  confidence: "low" | "medium" | "high";
  windows: {
    last_24_hours: CapacityWindowReport;
    last_7_days: CapacityWindowReport;
  };
  daily: Array<{
    date: string;
    cpu_p95_percent: number;
    pressure_p95_percent: number;
    request_count: number;
    request_p95_ms: number;
    recommended_vcpus: number;
    status: CapacityWindowReport["status"];
  }>;
};

type RequestAccumulator = {
  started_at_ms: number;
  request_count: number;
  error_count: number;
  slow_count: number;
  duration_sum_ms: number;
  duration_max_ms: number;
  duration_histogram: number[];
  event_loop_p95_ms: number;
  event_loop_max_ms: number;
  active_requests_peak: number;
};

type HostObservation = {
  cpu_busy_percent: number;
  cpu_iowait_percent: number;
  cpu_steal_percent: number;
  cpu_pressure_percent: number;
  io_pressure_percent: number;
  load_1m: number;
  memory_used_percent: number;
  disk_used_percent: number;
};

type CpuTimes = {
  total: number;
  idle: number;
  iowait: number;
  steal: number;
};

const HOST_SAMPLE_INTERVAL_MS = 15_000;
const AGGREGATE_INTERVAL_MS = 60_000;
const RETENTION_DAYS = 8;
const TARGET_PEAK_CPU_PERCENT = 70;
const SLOW_REQUEST_MS = 750;
const HISTOGRAM_LIMITS_MS = [10, 25, 50, 100, 250, 500, 750, 1_000, 2_000, 5_000, 10_000, 30_000, Number.POSITIVE_INFINITY];
const COMMON_VCPU_SIZES = [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 160, 192, 256];

let installed = false;
let flushTimer: NodeJS.Timeout | null = null;
let hostTimer: NodeJS.Timeout | null = null;
let requestAccumulator = freshRequestAccumulator();
let hostObservations: HostObservation[] = [];
let previousCpuTimes: CpuTimes | null = null;
let history: CapacityMinuteBucket[] = [];
let latestReport: CapacityReport | null = null;
let reportFileCache: { loaded_at_ms: number; report: CapacityReport | null } = { loaded_at_ms: 0, report: null };
let aggregateRunning = false;

export function installCapacityMonitor() {
  if (installed) return;
  if ((process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) && process.env.CAPACITY_MONITOR_TEST_ENABLED !== "1") return;
  installed = true;

  if (!isFirstMeasurePostgresEnabled()) void mkdir(workerStorageDir(), { recursive: true });
  if (isCoordinator()) {
    void initializeCoordinator();
    hostTimer = setInterval(() => void sampleHost(), HOST_SAMPLE_INTERVAL_MS);
    hostTimer.unref?.();
  }

  flushTimer = setInterval(() => void flushWorkerMinute(), AGGREGATE_INTERVAL_MS);
  flushTimer.unref?.();
}

export function closeCapacityMonitor() {
  if (flushTimer) clearInterval(flushTimer);
  if (hostTimer) clearInterval(hostTimer);
  flushTimer = null;
  hostTimer = null;
  installed = false;
}

export function recordCapacityRequest(durationMs: number, statusCode: number) {
  const duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  requestAccumulator.request_count += 1;
  requestAccumulator.duration_sum_ms += duration;
  requestAccumulator.duration_max_ms = Math.max(requestAccumulator.duration_max_ms, duration);
  if (statusCode >= 500) requestAccumulator.error_count += 1;
  if (duration >= SLOW_REQUEST_MS) requestAccumulator.slow_count += 1;
  const index = HISTOGRAM_LIMITS_MS.findIndex((limit) => duration <= limit);
  requestAccumulator.duration_histogram[Math.max(0, index)] = (requestAccumulator.duration_histogram[Math.max(0, index)] ?? 0) + 1;
}

export function recordCapacityRuntime(eventLoopP95Ms: number, eventLoopMaxMs: number, activeRequests: number) {
  requestAccumulator.event_loop_p95_ms = Math.max(requestAccumulator.event_loop_p95_ms, finite(eventLoopP95Ms));
  requestAccumulator.event_loop_max_ms = Math.max(requestAccumulator.event_loop_max_ms, finite(eventLoopMaxMs));
  requestAccumulator.active_requests_peak = Math.max(requestAccumulator.active_requests_peak, Math.floor(finite(activeRequests)));
}

export async function getCapacityReport(): Promise<CapacityReport> {
  if (latestReport) return latestReport;
  if (Date.now() - reportFileCache.loaded_at_ms < 10_000 && reportFileCache.report) return reportFileCache.report;
  if (isFirstMeasurePostgresEnabled()) {
    const parsed = await readSharedDocument<CapacityReport>({ namespace: "diagnostics", collection: "capacity_summary", id: "current" });
    if (parsed) {
      reportFileCache = { loaded_at_ms: Date.now(), report: parsed };
      return parsed;
    }
    return buildCapacityReport([], Date.now());
  }
  try {
    const parsed = JSON.parse(await readFile(summaryPath(), "utf8")) as CapacityReport;
    reportFileCache = { loaded_at_ms: Date.now(), report: parsed };
    return parsed;
  } catch {
    const report = buildCapacityReport([], Date.now());
    reportFileCache = { loaded_at_ms: Date.now(), report };
    return report;
  }
}

async function initializeCoordinator() {
  try {
    if (!isFirstMeasurePostgresEnabled()) await mkdir(capacityStorageRoot(), { recursive: true });
    history = await loadHistory();
    latestReport = buildCapacityReport(history, Date.now());
    await writeSummary(latestReport);
    await sampleHost();
  } catch {
    // Diagnostics must never interfere with application startup or request handling.
  }
}

async function flushWorkerMinute() {
  const endedAt = Date.now();
  const snapshot = requestAccumulator;
  requestAccumulator = freshRequestAccumulator(endedAt);
  const payload: WorkerMinuteSnapshot = {
    schema: 1,
    at: new Date(endedAt).toISOString(),
    ended_at_ms: endedAt,
    worker_id: workerId(),
    pid: process.pid,
    request_count: snapshot.request_count,
    error_count: snapshot.error_count,
    slow_count: snapshot.slow_count,
    duration_sum_ms: round(snapshot.duration_sum_ms, 1),
    duration_max_ms: round(snapshot.duration_max_ms, 1),
    duration_histogram: snapshot.duration_histogram,
    event_loop_p95_ms: round(snapshot.event_loop_p95_ms, 1),
    event_loop_max_ms: round(snapshot.event_loop_max_ms, 1),
    active_requests_peak: snapshot.active_requests_peak
  };
  try {
    if (isFirstMeasurePostgresEnabled()) {
      await replaceSharedDocument({ namespace: "diagnostics", scope: capacityInstanceId(), collection: "capacity_workers", id: workerId() }, payload);
    } else {
      await mkdir(workerStorageDir(), { recursive: true });
      await writeFile(workerSnapshotPath(), `${JSON.stringify(payload)}\n`, "utf8");
    }
  } catch {
    return;
  }
  if (isCoordinator()) {
    const timer = setTimeout(() => void aggregateMinute(), 2_000);
    timer.unref?.();
  }
}

async function aggregateMinute() {
  if (aggregateRunning) return;
  aggregateRunning = true;
  try {
    const now = Date.now();
    const workerSnapshots = await readFreshWorkerSnapshots(now);
    const observations = hostObservations;
    hostObservations = [];
    const bucket = buildMinuteBucket(now, observations, workerSnapshots);
    history.push(bucket);
    history = history.filter((entry) => Date.parse(entry.at) >= now - RETENTION_DAYS * 86_400_000);
    if (isFirstMeasurePostgresEnabled()) {
      const minuteId = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
      await replaceSharedDocument({ namespace: "diagnostics", scope: capacityInstanceId(), collection: "capacity_minutes", id: minuteId }, bucket);
      history = await loadHistory();
    } else {
      await appendFile(historyPath(now), `${JSON.stringify(bucket)}\n`, "utf8");
    }
    await cleanupOldHistory(now);
    latestReport = buildCapacityReport(history, now);
    await writeSummary(latestReport);
  } catch {
    // A missing monitoring sample is preferable to adding latency to production.
  } finally {
    aggregateRunning = false;
  }
}

async function sampleHost() {
  try {
    const currentTimes = await readCpuTimes();
    if (!previousCpuTimes) {
      previousCpuTimes = currentTimes;
      return;
    }
    const totalDelta = Math.max(1, currentTimes.total - previousCpuTimes.total);
    const idleDelta = Math.max(0, currentTimes.idle - previousCpuTimes.idle);
    const iowaitDelta = Math.max(0, currentTimes.iowait - previousCpuTimes.iowait);
    const stealDelta = Math.max(0, currentTimes.steal - previousCpuTimes.steal);
    previousCpuTimes = currentTimes;
    const memory = await readMemoryUsedPercent();
    const disk = await readDiskUsedPercent();
    hostObservations.push({
      cpu_busy_percent: clampPercent(((totalDelta - idleDelta - iowaitDelta - stealDelta) / totalDelta) * 100),
      cpu_iowait_percent: clampPercent((iowaitDelta / totalDelta) * 100),
      cpu_steal_percent: clampPercent((stealDelta / totalDelta) * 100),
      cpu_pressure_percent: await readPressurePercent("cpu"),
      io_pressure_percent: await readPressurePercent("io"),
      load_1m: finite(os.loadavg()[0] ?? 0),
      memory_used_percent: memory,
      disk_used_percent: disk
    });
    if (hostObservations.length > 12) hostObservations = hostObservations.slice(-12);
  } catch {
    // Host-level metrics are best effort and have portable fallbacks.
  }
}

async function readCpuTimes(): Promise<CpuTimes> {
  if (process.platform === "linux") {
    try {
      const firstLine = (await readFile("/proc/stat", "utf8")).split(/\r?\n/, 1)[0] ?? "";
      const values = firstLine.trim().split(/\s+/).slice(1).map(Number);
      if (values.length >= 8 && values.every(Number.isFinite)) {
        return {
          // guest and guest_nice are already included in user/nice on Linux.
          total: values.slice(0, 8).reduce((sum, value) => sum + value, 0),
          idle: values[3] ?? 0,
          iowait: values[4] ?? 0,
          steal: values[7] ?? 0
        };
      }
    } catch {
      // Fall through to Node's portable CPU counters.
    }
  }
  const times = os.cpus().map((cpu) => cpu.times);
  return {
    total: times.reduce((sum, value) => sum + value.user + value.nice + value.sys + value.idle + value.irq, 0),
    idle: times.reduce((sum, value) => sum + value.idle, 0),
    iowait: 0,
    steal: 0
  };
}

async function readPressurePercent(kind: "cpu" | "io") {
  if (process.platform !== "linux") return 0;
  try {
    const line = (await readFile(`/proc/pressure/${kind}`, "utf8")).split(/\r?\n/).find((entry) => entry.startsWith("some ")) ?? "";
    return clampPercent(Number(/avg10=([0-9.]+)/.exec(line)?.[1] ?? 0));
  } catch {
    return 0;
  }
}

async function readMemoryUsedPercent() {
  if (process.platform === "linux") {
    try {
      const text = await readFile("/proc/meminfo", "utf8");
      const total = Number(/^MemTotal:\s+(\d+)/m.exec(text)?.[1] ?? 0);
      const available = Number(/^MemAvailable:\s+(\d+)/m.exec(text)?.[1] ?? 0);
      if (total > 0) return clampPercent(((total - available) / total) * 100);
    } catch {
      // Fall through to os.freemem().
    }
  }
  return clampPercent(((os.totalmem() - os.freemem()) / Math.max(1, os.totalmem())) * 100);
}

async function readDiskUsedPercent() {
  try {
    const stats = await statfs(process.cwd());
    const blocks = Number(stats.blocks);
    const available = Number(stats.bavail);
    return blocks > 0 ? clampPercent(((blocks - available) / blocks) * 100) : 0;
  } catch {
    return 0;
  }
}

async function readFreshWorkerSnapshots(now: number) {
  if (isFirstMeasurePostgresEnabled()) {
    const rows = await listSharedDocuments<WorkerMinuteSnapshot>({
      namespace: "diagnostics", scope: capacityInstanceId(), collection: "capacity_workers", limit: 2_000
    });
    return rows.filter((row) => row.schema === 1 && now - row.ended_at_ms <= AGGREGATE_INTERVAL_MS * 2.5);
  }
  const snapshots: WorkerMinuteSnapshot[] = [];
  let names: string[] = [];
  try {
    names = await readdir(workerStorageDir());
  } catch {
    return snapshots;
  }
  for (const name of names) {
    if (!/^worker-[a-zA-Z0-9_.-]+\.json$/.test(name)) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(workerStorageDir(), name), "utf8")) as WorkerMinuteSnapshot;
      if (parsed.schema === 1 && now - parsed.ended_at_ms <= AGGREGATE_INTERVAL_MS * 2.5) snapshots.push(parsed);
    } catch {
      // Ignore a snapshot while another worker is replacing it.
    }
  }
  return snapshots;
}

function buildMinuteBucket(now: number, observations: HostObservation[], workers: WorkerMinuteSnapshot[]): CapacityMinuteBucket {
  const cpuValues = observations.map((entry) => entry.cpu_busy_percent);
  const histogram = new Array(HISTOGRAM_LIMITS_MS.length).fill(0) as number[];
  for (const worker of workers) {
    worker.duration_histogram.forEach((count, index) => {
      histogram[index] = (histogram[index] ?? 0) + finite(count);
    });
  }
  return {
    schema: 1,
    at: new Date(now).toISOString(),
    cpu_count: availableCpuCount(),
    cpu_busy_avg_percent: round(average(cpuValues), 1),
    cpu_busy_p95_percent: round(percentile(cpuValues, 95), 1),
    cpu_busy_max_percent: round(max(cpuValues), 1),
    cpu_iowait_p95_percent: round(percentile(observations.map((entry) => entry.cpu_iowait_percent), 95), 1),
    cpu_steal_p95_percent: round(percentile(observations.map((entry) => entry.cpu_steal_percent), 95), 1),
    cpu_pressure_p95_percent: round(percentile(observations.map((entry) => entry.cpu_pressure_percent), 95), 1),
    io_pressure_p95_percent: round(percentile(observations.map((entry) => entry.io_pressure_percent), 95), 1),
    load_1m_p95: round(percentile(observations.map((entry) => entry.load_1m), 95), 2),
    memory_used_p95_percent: round(percentile(observations.map((entry) => entry.memory_used_percent), 95), 1),
    disk_used_percent: round(observations.at(-1)?.disk_used_percent ?? 0, 1),
    web_workers_seen: workers.length,
    web_workers_expected: expectedWorkerCount(),
    request_count: sum(workers.map((entry) => entry.request_count)),
    error_count: sum(workers.map((entry) => entry.error_count)),
    slow_count: sum(workers.map((entry) => entry.slow_count)),
    request_p95_ms: histogramPercentile(histogram, 95),
    request_max_ms: round(max(workers.map((entry) => entry.duration_max_ms)), 1),
    event_loop_p95_ms: round(max(workers.map((entry) => entry.event_loop_p95_ms)), 1),
    event_loop_max_ms: round(max(workers.map((entry) => entry.event_loop_max_ms)), 1),
    active_requests_peak: max(workers.map((entry) => entry.active_requests_peak))
  };
}

export function buildCapacityReport(entries: CapacityMinuteBucket[], now = Date.now()): CapacityReport {
  const retained = entries
    .filter((entry) => Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) >= now - RETENTION_DAYS * 86_400_000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last24 = buildWindowReport(retained.filter((entry) => Date.parse(entry.at) >= now - 86_400_000), "24h", 1_440);
  const last7d = buildWindowReport(retained.filter((entry) => Date.parse(entry.at) >= now - 7 * 86_400_000), "7d", 10_080);
  const currentVcpus = retained.at(-1)?.cpu_count ?? availableCpuCount();
  const sufficient24h = last24.sample_count >= 360;
  const sufficient7d = last7d.sample_count >= 4_320;
  const investigation = [last24.status, last7d.status].some((status) => status === "investigate_io" || status === "investigate_memory");
  const recommended = Math.max(currentVcpus, last24.recommended_vcpus, last7d.recommended_vcpus);
  const resizeEvidence = (sufficient24h && last24.status === "resize") || (sufficient7d && last7d.status === "resize");
  const resize = resizeEvidence && recommended > currentVcpus;
  const watch = last24.status === "watch" || last7d.status === "watch" || last24.status === "resize" || last7d.status === "resize";
  let action: CapacityReport["action"] = "collecting";
  let actionLabel = "COLLECTING BASELINE";
  let actionReason = "Collect at least six hours before making a purchase decision.";
  if (investigation && sufficient24h) {
    action = "investigate";
    actionLabel = "INVESTIGATE BEFORE BUYING CPU";
    actionReason = last24.reason;
  } else if (resize) {
    action = "resize";
    actionLabel = `RESIZE TO ${recommended} vCPU`;
    actionReason = `Sustained peak demand is above the ${TARGET_PEAK_CPU_PERCENT}% headroom target. ${last24.reason}`;
  } else if (sufficient24h && watch) {
    action = "watch";
    actionLabel = "WATCH CAPACITY";
    actionReason = last24.reason;
  } else if (sufficient24h) {
    action = "no_purchase";
    actionLabel = "NO CPU PURCHASE NEEDED";
    actionReason = `The rolling 24-hour peak remains within the ${TARGET_PEAK_CPU_PERCENT}% planning target.`;
  }
  return {
    schema: 1,
    generated_at: new Date(now).toISOString(),
    storage: "one-minute aggregates; eight-day retention",
    sampling: {
      host_interval_seconds: HOST_SAMPLE_INTERVAL_MS / 1_000,
      aggregate_interval_seconds: AGGREGATE_INTERVAL_MS / 1_000,
      retention_days: RETENTION_DAYS,
      target_peak_cpu_percent: TARGET_PEAK_CPU_PERCENT
    },
    current_vcpus: currentVcpus,
    action,
    action_label: actionLabel,
    action_reason: actionReason,
    recommended_vcpus: recommended,
    confidence: sufficient7d ? "high" : sufficient24h ? "medium" : "low",
    windows: { last_24_hours: last24, last_7_days: last7d },
    daily: buildDailyReports(retained)
  };
}

function buildWindowReport(entries: CapacityMinuteBucket[], window: "24h" | "7d", expectedSamples: number): CapacityWindowReport {
  const cpuCount = entries.at(-1)?.cpu_count ?? availableCpuCount();
  const cpuP95 = percentile(entries.map((entry) => entry.cpu_busy_p95_percent), 95);
  const pressureP95 = percentile(entries.map((entry) => entry.cpu_pressure_p95_percent), 95);
  const iowaitP95 = percentile(entries.map((entry) => entry.cpu_iowait_p95_percent), 95);
  const memoryP95 = percentile(entries.map((entry) => entry.memory_used_p95_percent), 95);
  // Core-equivalent demand remains comparable when the Droplet is resized in
  // the middle of a reporting window; percentages alone do not.
  const busyCores = percentile(entries.map((entry) => entry.cpu_count * entry.cpu_busy_p95_percent / 100), 95);
  const minimum = Math.max(1, Math.ceil(busyCores / (TARGET_PEAK_CPU_PERCENT / 100)));
  const recommended = roundUpVcpuSize(minimum);
  const span = entries.length > 1 ? (Date.parse(entries.at(-1)?.at ?? "") - Date.parse(entries[0]?.at ?? "")) / 3_600_000 : 0;
  let status: CapacityWindowReport["status"] = entries.length < Math.min(expectedSamples, 360) ? "collecting" : "healthy";
  let reason = status === "collecting" ? "Not enough history has been collected for a reliable decision." : "CPU demand and pressure are within the planning target.";
  if (status !== "collecting") {
    if (iowaitP95 >= 10) {
      status = "investigate_io";
      reason = `I/O wait reached ${round(iowaitP95, 1)}% at p95; additional CPU may not remove this bottleneck.`;
    } else if (memoryP95 >= 90) {
      status = "investigate_memory";
      reason = `Available-memory pressure reached ${round(memoryP95, 1)}% used at p95; confirm RAM before purchasing CPU.`;
    } else if (cpuP95 >= 85 || pressureP95 >= 5) {
      status = "resize";
      reason = `CPU p95 is ${round(cpuP95, 1)}% and CPU-wait pressure p95 is ${round(pressureP95, 1)}%.`;
    } else if (cpuP95 >= 70 || pressureP95 >= 1) {
      status = "watch";
      reason = `CPU p95 is ${round(cpuP95, 1)}% and CPU-wait pressure p95 is ${round(pressureP95, 1)}%.`;
    }
  }
  return {
    window,
    sample_count: entries.length,
    coverage_percent: round(Math.min(100, entries.length / expectedSamples * 100), 1),
    data_span_hours: round(span, 1),
    cpu_count: cpuCount,
    cpu_avg_percent: round(average(entries.map((entry) => entry.cpu_busy_avg_percent)), 1),
    cpu_p95_percent: round(cpuP95, 1),
    cpu_p99_percent: round(percentile(entries.map((entry) => entry.cpu_busy_p95_percent), 99), 1),
    busy_cores_p95: round(busyCores, 1),
    cpu_pressure_p95_percent: round(pressureP95, 1),
    iowait_p95_percent: round(iowaitP95, 1),
    steal_p95_percent: round(percentile(entries.map((entry) => entry.cpu_steal_p95_percent), 95), 1),
    load_p95: round(percentile(entries.map((entry) => entry.load_1m_p95), 95), 1),
    memory_p95_percent: round(memoryP95, 1),
    disk_latest_percent: round(entries.at(-1)?.disk_used_percent ?? 0, 1),
    request_count: sum(entries.map((entry) => entry.request_count)),
    error_count: sum(entries.map((entry) => entry.error_count)),
    slow_count: sum(entries.map((entry) => entry.slow_count)),
    request_p95_ms: round(percentile(entries.map((entry) => entry.request_p95_ms).filter((value) => value > 0), 95), 1),
    event_loop_p95_ms: round(percentile(entries.map((entry) => entry.event_loop_p95_ms), 95), 1),
    recommended_vcpus: recommended,
    minimum_vcpus_at_target: minimum,
    status,
    reason
  };
}

function buildDailyReports(entries: CapacityMinuteBucket[]): CapacityReport["daily"] {
  const groups = new Map<string, CapacityMinuteBucket[]>();
  for (const entry of entries) {
    const date = entry.at.slice(0, 10);
    groups.set(date, [...(groups.get(date) ?? []), entry]);
  }
  return [...groups.entries()].slice(-7).map(([date, values]) => {
    const report = buildWindowReport(values, "24h", 1_440);
    return {
      date,
      cpu_p95_percent: report.cpu_p95_percent,
      pressure_p95_percent: report.cpu_pressure_p95_percent,
      request_count: report.request_count,
      request_p95_ms: report.request_p95_ms,
      recommended_vcpus: report.recommended_vcpus,
      status: report.status
    };
  }).reverse();
}

async function loadHistory() {
  if (isFirstMeasurePostgresEnabled()) {
    const entries = await listSharedDocuments<CapacityMinuteBucket>({
      namespace: "diagnostics", collection: "capacity_minutes", allScopes: true, limit: RETENTION_DAYS * 1_440 * 50
    });
    return combineClusterMinuteBuckets(entries);
  }
  let names: string[] = [];
  try {
    names = await readdir(capacityStorageRoot());
  } catch {
    return [];
  }
  const entries: CapacityMinuteBucket[] = [];
  for (const name of names.filter((entry) => /^capacity-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)).sort().slice(-RETENTION_DAYS)) {
    try {
      const text = await readFile(path.join(capacityStorageRoot(), name), "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as CapacityMinuteBucket;
        if (parsed.schema === 1) entries.push(parsed);
      }
    } catch {
      // Preserve all other days if one history file is damaged.
    }
  }
  return entries;
}

async function cleanupOldHistory(now: number) {
  if (isFirstMeasurePostgresEnabled()) {
    await queryPostgres(`
      DELETE FROM app_shared_documents
      WHERE namespace = 'diagnostics' AND collection IN ('capacity_minutes', 'capacity_workers')
        AND updated_at < to_timestamp($1 / 1000.0)
    `, [now - RETENTION_DAYS * 86_400_000]);
    return;
  }
  const cutoffDate = new Date(now - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  let names: string[] = [];
  try {
    names = await readdir(capacityStorageRoot());
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^capacity-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (match?.[1] && match[1] < cutoffDate) await rm(path.join(capacityStorageRoot(), name), { force: true });
  }
}

async function writeSummary(report: CapacityReport) {
  if (isFirstMeasurePostgresEnabled()) {
    await replaceSharedDocument({ namespace: "diagnostics", collection: "capacity_summary", id: "current" }, report);
    reportFileCache = { loaded_at_ms: Date.now(), report };
    return;
  }
  await mkdir(capacityStorageRoot(), { recursive: true });
  await writeFile(summaryPath(), `${JSON.stringify(report)}\n`, "utf8");
  reportFileCache = { loaded_at_ms: Date.now(), report };
}

function freshRequestAccumulator(startedAt = Date.now()): RequestAccumulator {
  return {
    started_at_ms: startedAt,
    request_count: 0,
    error_count: 0,
    slow_count: 0,
    duration_sum_ms: 0,
    duration_max_ms: 0,
    duration_histogram: new Array(HISTOGRAM_LIMITS_MS.length).fill(0) as number[],
    event_loop_p95_ms: 0,
    event_loop_max_ms: 0,
    active_requests_peak: 0
  };
}

function histogramPercentile(histogram: number[], target: number) {
  const total = sum(histogram);
  if (!total) return 0;
  const threshold = Math.ceil(total * target / 100);
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index] ?? 0;
    if (seen >= threshold) return Number.isFinite(HISTOGRAM_LIMITS_MS[index]) ? HISTOGRAM_LIMITS_MS[index] ?? 0 : 30_000;
  }
  return 30_000;
}

function roundUpVcpuSize(minimum: number) {
  return COMMON_VCPU_SIZES.find((size) => size >= minimum) ?? Math.ceil(minimum / 32) * 32;
}

function capacityStorageRoot() {
  return path.resolve(process.cwd(), process.env.DIAGNOSTICS_STORAGE_ROOT ?? "./storage/internal/diagnostics");
}

function workerStorageDir() {
  return path.join(capacityStorageRoot(), "workers");
}

function workerSnapshotPath() {
  return path.join(workerStorageDir(), `worker-${workerId()}.json`);
}

function summaryPath() {
  return path.join(capacityStorageRoot(), "capacity-summary.json");
}

function historyPath(now: number) {
  return path.join(capacityStorageRoot(), `capacity-${new Date(now).toISOString().slice(0, 10)}.jsonl`);
}

function workerId() {
  return String(process.env.V1_CLUSTER_WORKER ?? `single-${process.pid}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function capacityInstanceId() {
  return String(env.instanceId || os.hostname()).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function combineClusterMinuteBuckets(entries: CapacityMinuteBucket[]) {
  const groups = new Map<string, CapacityMinuteBucket[]>();
  for (const entry of entries) {
    const time = Date.parse(entry.at);
    if (!Number.isFinite(time)) continue;
    const key = new Date(Math.floor(time / 60_000) * 60_000).toISOString();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([at, values]) => {
    const cores = Math.max(1, sum(values.map((entry) => entry.cpu_count)));
    const weightedCpu = sum(values.map((entry) => entry.cpu_busy_avg_percent * Math.max(1, entry.cpu_count))) / cores;
    return {
      schema: 1 as const,
      at,
      cpu_count: cores,
      cpu_busy_avg_percent: round(weightedCpu, 1),
      cpu_busy_p95_percent: round(max(values.map((entry) => entry.cpu_busy_p95_percent)), 1),
      cpu_busy_max_percent: round(max(values.map((entry) => entry.cpu_busy_max_percent)), 1),
      cpu_iowait_p95_percent: round(max(values.map((entry) => entry.cpu_iowait_p95_percent)), 1),
      cpu_steal_p95_percent: round(max(values.map((entry) => entry.cpu_steal_p95_percent)), 1),
      cpu_pressure_p95_percent: round(max(values.map((entry) => entry.cpu_pressure_p95_percent)), 1),
      io_pressure_p95_percent: round(max(values.map((entry) => entry.io_pressure_p95_percent)), 1),
      load_1m_p95: round(sum(values.map((entry) => entry.load_1m_p95)), 2),
      memory_used_p95_percent: round(max(values.map((entry) => entry.memory_used_p95_percent)), 1),
      disk_used_percent: round(max(values.map((entry) => entry.disk_used_percent)), 1),
      web_workers_seen: sum(values.map((entry) => entry.web_workers_seen)),
      web_workers_expected: sum(values.map((entry) => entry.web_workers_expected)),
      request_count: sum(values.map((entry) => entry.request_count)),
      error_count: sum(values.map((entry) => entry.error_count)),
      slow_count: sum(values.map((entry) => entry.slow_count)),
      request_p95_ms: max(values.map((entry) => entry.request_p95_ms)),
      request_max_ms: max(values.map((entry) => entry.request_max_ms)),
      event_loop_p95_ms: max(values.map((entry) => entry.event_loop_p95_ms)),
      event_loop_max_ms: max(values.map((entry) => entry.event_loop_max_ms)),
      active_requests_peak: sum(values.map((entry) => entry.active_requests_peak))
    } satisfies CapacityMinuteBucket;
  });
}

function isCoordinator() {
  const id = String(process.env.V1_CLUSTER_WORKER ?? "").trim();
  return !id || id === "1";
}

function expectedWorkerCount() {
  const value = Number(process.env.V1_CLUSTER_WORKER_COUNT ?? process.env.V1_WEB_WORKERS ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function availableCpuCount() {
  return Math.max(1, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length);
}

function percentile(values: number[], target: number) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * target / 100) - 1))] ?? 0;
}

function average(values: number[]) {
  return values.length ? sum(values) / values.length : 0;
}

function max(values: number[]) {
  return values.length ? Math.max(...values.map(finite)) : 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + finite(value), 0);
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function clampPercent(value: number) {
  return round(Math.max(0, Math.min(100, finite(value))), 2);
}

function round(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(finite(value) * factor) / factor;
}
