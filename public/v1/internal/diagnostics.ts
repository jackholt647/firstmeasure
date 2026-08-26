import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { env } from "../src/config/env.js";
import { getFirstMeasureJobRuntimeStatus, resolveFirstMeasureJobWorkerSizing } from "../firstmeasure/job_runtime.js";
import {
  closeCapacityMonitor,
  getCapacityReport,
  installCapacityMonitor,
  recordCapacityRequest,
  recordCapacityRuntime
} from "./capacity_monitor.js";

type JsonObject = Record<string, unknown>;

type RequestSample = {
  trace_id: string;
  at: string;
  app_area: string;
  route_group: string;
  method: string;
  url: string;
  route: string;
  action: string;
  status_code: number;
  duration_ms: number;
  request_bytes: number;
  response_bytes: number;
  actor_email: string;
  actor_org_id: string;
  slow: boolean;
};

type RuntimeSample = {
  at: string;
  uptime_s: number;
  pid: number;
  node_version: string;
  cpu_percent: number;
  loadavg_1m: number;
  memory_rss_mb: number;
  memory_heap_used_mb: number;
  memory_heap_total_mb: number;
  memory_external_mb: number;
  memory_system_used_percent: number;
  firstmeasure_job_workers: number;
  firstmeasure_job_worker_mode: string;
  firstmeasure_job_available_cpus: number;
  web_worker_id: number | null;
  web_worker_count: number;
  event_loop_delay_p50_ms: number;
  event_loop_delay_p95_ms: number;
  event_loop_delay_max_ms: number;
  active_requests: number;
  diagnostics_dropped_events: number;
};

type BrowserSample = {
  at: string;
  app_area: string;
  page: string;
  view: string;
  url: string;
  load_ms: number | null;
  fcp_ms: number | null;
  long_tasks: number | null;
  fetch_count: number | null;
  slow_fetch_count: number | null;
};

type ErrorSample = {
  at: string;
  trace_id: string;
  app_area: string;
  method: string;
  url: string;
  route: string;
  message: string;
  name: string;
};

class RingBuffer<T> {
  private readonly values: T[] = [];
  private index = 0;

  constructor(private readonly capacity: number) {}

  push(value: T) {
    if (this.values.length < this.capacity) {
      this.values.push(value);
      return;
    }
    this.values[this.index] = value;
    this.index = (this.index + 1) % this.capacity;
  }

  snapshot() {
    if (this.values.length < this.capacity || this.index === 0) return [...this.values];
    return [...this.values.slice(this.index), ...this.values.slice(0, this.index)];
  }

  latest(limit: number) {
    return this.snapshot().slice(-Math.max(0, limit)).reverse();
  }

  get length() {
    return this.values.length;
  }
}

const REQUEST_SAMPLE_LIMIT = 2500;
const SLOW_REQUEST_LIMIT = 600;
const RUNTIME_SAMPLE_LIMIT = 720;
const BROWSER_SAMPLE_LIMIT = 800;
const ERROR_SAMPLE_LIMIT = 300;
const SLOW_REQUEST_MS = 750;
const MAX_RUM_BODY_BYTES = 32 * 1024;

const requestStarts = new WeakMap<FastifyRequest, { startedAtMs: number; requestBytes: number }>();
const requests = new RingBuffer<RequestSample>(REQUEST_SAMPLE_LIMIT);
const slowRequests = new RingBuffer<RequestSample>(SLOW_REQUEST_LIMIT);
const runtimeSamples = new RingBuffer<RuntimeSample>(RUNTIME_SAMPLE_LIMIT);
const browserSamples = new RingBuffer<BrowserSample>(BROWSER_SAMPLE_LIMIT);
const errorSamples = new RingBuffer<ErrorSample>(ERROR_SAMPLE_LIMIT);

let installed = false;
let activeRequests = 0;
let droppedEvents = 0;
let runtimeTimer: NodeJS.Timeout | null = null;
let lastCpuUsage = process.cpuUsage();
let lastCpuAt = performance.now();
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

export function installDiagnostics(app: FastifyInstance) {
  if (installed) return;
  installed = true;
  installCapacityMonitor();

  app.addHook("onRequest", async (request, reply) => {
    const traceId = String(request.id || "");
    reply.header("X-FirstMate-Trace-Id", traceId);
    activeRequests += 1;
    requestStarts.set(request, {
      startedAtMs: performance.now(),
      requestBytes: numberHeader(request.headers["content-length"])
    });
  });

  app.addHook("onError", async (request, _reply, error) => {
    if (shouldSkipUrl(request.url)) return;
    errorSamples.push({
      at: new Date().toISOString(),
      trace_id: String(request.id || ""),
      app_area: appAreaForUrl(request.url),
      method: request.method,
      url: cleanUrl(request.url),
      route: routeForRequest(request),
      message: String(error?.message || error || "unknown_error").slice(0, 500),
      name: String(error?.name || "Error")
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    try {
      activeRequests = Math.max(0, activeRequests - 1);
      if (shouldSkipUrl(request.url)) return;
      const started = requestStarts.get(request);
      const durationMs = started ? performance.now() - started.startedAtMs : 0;
      const sample: RequestSample = {
        trace_id: String(request.id || ""),
        at: new Date().toISOString(),
        app_area: appAreaForUrl(request.url),
        route_group: routeGroupForUrl(request.url),
        method: request.method,
        url: cleanUrl(request.url),
        route: routeForRequest(request),
        action: actionForRequest(request),
        status_code: reply.statusCode,
        duration_ms: round(durationMs, 1),
        request_bytes: started?.requestBytes ?? 0,
        response_bytes: responseBytes(reply),
        actor_email: actorValue(request, "email"),
        actor_org_id: actorValue(request, "org_id"),
        slow: durationMs >= SLOW_REQUEST_MS
      };
      requests.push(sample);
      if (sample.slow || sample.status_code >= 500) slowRequests.push(sample);
      recordCapacityRequest(durationMs, sample.status_code);
    } catch {
      droppedEvents += 1;
    }
  });

  runtimeTimer = setInterval(recordRuntimeSample, 5000);
  runtimeTimer.unref?.();
  recordRuntimeSample();

  app.addHook("onClose", async () => {
    if (runtimeTimer) clearInterval(runtimeTimer);
    runtimeTimer = null;
    eventLoopDelay.disable();
    closeCapacityMonitor();
  });
}

export const registerDiagnosticsApi: FastifyPluginAsync = async (app) => {
  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderDiagnosticsPage();
  });

  app.get("/summary", async () => buildSummary());

  app.get("/requests", async (request) => {
    const query = asObject(request.query);
    const limit = clampInt(query.limit, 100, 1, 1000);
    const area = String(query.area ?? "").trim();
    const onlySlow = String(query.slow ?? "") === "1" || String(query.slow ?? "").toLowerCase() === "true";
    const source = onlySlow ? slowRequests.snapshot() : requests.snapshot();
    return {
      ok: true,
      success: true,
      requests: source
        .filter((entry) => !area || entry.app_area === area || entry.route_group === area)
        .slice(-limit)
        .reverse()
    };
  });

  app.get("/runtime", async (request) => {
    const limit = clampInt(asObject(request.query).limit, 120, 1, RUNTIME_SAMPLE_LIMIT);
    return { ok: true, success: true, samples: runtimeSamples.latest(limit) };
  });

  app.get("/errors", async (request) => {
    const limit = clampInt(asObject(request.query).limit, 100, 1, ERROR_SAMPLE_LIMIT);
    return { ok: true, success: true, errors: errorSamples.latest(limit) };
  });

  app.get("/browser", async (request) => {
    const limit = clampInt(asObject(request.query).limit, 100, 1, BROWSER_SAMPLE_LIMIT);
    return { ok: true, success: true, browser: browserSamples.latest(limit) };
  });

  app.post("/rum", { bodyLimit: MAX_RUM_BODY_BYTES }, async (request) => {
    try {
      browserSamples.push(normalizeBrowserSample(asObject(request.body)));
      return { ok: true, success: true };
    } catch {
      droppedEvents += 1;
      return { ok: false, success: false, error: "invalid_rum_payload" };
    }
  });
};

function recordRuntimeSample() {
  try {
    const now = performance.now();
    const currentCpu = process.cpuUsage();
    const elapsedUs = Math.max(1, (now - lastCpuAt) * 1000);
    const usedUs = (currentCpu.user - lastCpuUsage.user) + (currentCpu.system - lastCpuUsage.system);
    lastCpuUsage = currentCpu;
    lastCpuAt = now;
    const memory = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const firstMeasureJobs = getFirstMeasureJobRuntimeStatus();
    const firstMeasureJobSizing = firstMeasureJobs.workerSizing ?? resolveFirstMeasureJobWorkerSizing();
    const runtimeSample: RuntimeSample = {
      at: new Date().toISOString(),
      uptime_s: round(process.uptime(), 1),
      pid: process.pid,
      node_version: process.version,
      cpu_percent: round((usedUs / elapsedUs) * 100, 1),
      loadavg_1m: round(os.loadavg()[0] ?? 0, 2),
      memory_rss_mb: bytesToMb(memory.rss),
      memory_heap_used_mb: bytesToMb(memory.heapUsed),
      memory_heap_total_mb: bytesToMb(memory.heapTotal),
      memory_external_mb: bytesToMb(memory.external),
      memory_system_used_percent: round(((totalMem - freeMem) / Math.max(1, totalMem)) * 100, 1),
      firstmeasure_job_workers: Number(firstMeasureJobs.workerCount ?? firstMeasureJobSizing.resolved_workers ?? 0),
      firstmeasure_job_worker_mode: String(firstMeasureJobSizing.mode ?? "unknown"),
      firstmeasure_job_available_cpus: Number(firstMeasureJobSizing.available_cpus ?? os.cpus().length),
      web_worker_id: nullableNumber(process.env.V1_CLUSTER_WORKER),
      web_worker_count: Number(process.env.V1_CLUSTER_WORKER_COUNT ?? env.webWorkers ?? 1) || 1,
      event_loop_delay_p50_ms: nsToMs(eventLoopDelay.percentile(50)),
      event_loop_delay_p95_ms: nsToMs(eventLoopDelay.percentile(95)),
      event_loop_delay_max_ms: nsToMs(eventLoopDelay.max),
      active_requests: activeRequests,
      diagnostics_dropped_events: droppedEvents
    };
    runtimeSamples.push(runtimeSample);
    recordCapacityRuntime(runtimeSample.event_loop_delay_p95_ms, runtimeSample.event_loop_delay_max_ms, activeRequests);
    eventLoopDelay.reset();
  } catch {
    droppedEvents += 1;
  }
}

async function buildSummary() {
  const requestList = requests.snapshot();
  const slowList = slowRequests.snapshot();
  const runtime = runtimeSamples.latest(1)[0] ?? null;
  return {
    ok: true,
    success: true,
    generated_at: new Date().toISOString(),
    config: {
      storage: "memory",
      web_workers: {
        configured: env.webWorkers,
        worker_id: nullableNumber(process.env.V1_CLUSTER_WORKER),
        worker_count: Number(process.env.V1_CLUSTER_WORKER_COUNT ?? env.webWorkers ?? 1) || 1
      },
      request_sample_limit: REQUEST_SAMPLE_LIMIT,
      slow_request_ms: SLOW_REQUEST_MS,
      runtime_sample_interval_ms: 5000,
      firstmeasure_jobs: getFirstMeasureJobRuntimeStatus()
    },
    totals: {
      requests: requestList.length,
      slow_requests: slowList.length,
      errors: errorSamples.length,
      browser_samples: browserSamples.length,
      dropped_events: droppedEvents
    },
    capacity: await getCapacityReport(),
    runtime,
    latency: latencySummary(requestList),
    by_area: groupRequestSummary(requestList, "app_area"),
    by_route_group: groupRequestSummary(requestList, "route_group"),
    slowest: slowList.slice(-20).reverse(),
    recent_errors: errorSamples.latest(20),
    recent_browser: browserSamples.latest(20)
  };
}

function latencySummary(entries: RequestSample[]) {
  const durations = entries.map((entry) => entry.duration_ms).sort((a, b) => a - b);
  return {
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    p99_ms: percentile(durations, 99),
    max_ms: durations.length ? durations[durations.length - 1] : 0
  };
}

function groupRequestSummary(entries: RequestSample[], key: "app_area" | "route_group") {
  const groups = new Map<string, RequestSample[]>();
  for (const entry of entries) {
    const value = entry[key] || "unknown";
    groups.set(value, [...(groups.get(value) ?? []), entry]);
  }
  return [...groups.entries()]
    .map(([name, values]) => ({
      name,
      count: values.length,
      slow_count: values.filter((entry) => entry.slow).length,
      error_count: values.filter((entry) => entry.status_code >= 500).length,
      avg_ms: round(values.reduce((sum, entry) => sum + entry.duration_ms, 0) / Math.max(1, values.length), 1),
      p95_ms: latencySummary(values).p95_ms
    }))
    .sort((a, b) => b.count - a.count);
}

function normalizeBrowserSample(body: JsonObject): BrowserSample {
  return {
    at: new Date().toISOString(),
    app_area: cleanShort(body.app_area ?? body.appArea ?? appAreaForUrl(String(body.url ?? "")), 60),
    page: cleanShort(body.page ?? "", 120),
    view: cleanShort(body.view ?? "", 120),
    url: cleanUrl(String(body.url ?? "")),
    load_ms: nullableNumber(body.load_ms ?? body.loadMs),
    fcp_ms: nullableNumber(body.fcp_ms ?? body.fcpMs),
    long_tasks: nullableNumber(body.long_tasks ?? body.longTasks),
    fetch_count: nullableNumber(body.fetch_count ?? body.fetchCount),
    slow_fetch_count: nullableNumber(body.slow_fetch_count ?? body.slowFetchCount)
  };
}

function appAreaForUrl(url: string) {
  const clean = cleanUrl(url);
  if (clean.startsWith("/v1/firstmeasure")) return "firstmeasure";
  if (clean.startsWith("/v1/platform")) return "platform-api";
  if (clean.startsWith("/v1/internal/crm")) return "crm-api";
  if (clean.startsWith("/v1/internal")) return "internal-api";
  if (clean.startsWith("/v1/email")) return "email-api";
  if (clean.startsWith("/v1/lead-intake")) return "lead-intake-api";
  if (clean.startsWith("/v1/canvassing")) return "canvassing-api";
  if (clean.includes("/measure/internal")) return "measure-internal";
  if (clean.includes("/measure/sales")) return "measure-sales";
  if (clean.includes("/platform")) return "platform-shell";
  if (clean.includes("/portal")) return "portal-shell";
  return clean.startsWith("/v1") ? "v1" : "web";
}

function routeGroupForUrl(url: string) {
  const clean = cleanUrl(url);
  const parts = clean.split("/").filter(Boolean);
  if (parts[0] === "v1" && parts[1]) {
    if (parts[1] === "internal" && parts[2] === "crm") return "/v1/internal/crm";
    if (parts[1] === "firstmeasure" && parts[2]) return `/v1/firstmeasure/${parts[2]}`;
    if (parts[1] === "platform" && parts[2]) return `/v1/platform/${parts[2]}`;
    return `/v1/${parts[1]}`;
  }
  return parts[0] ? `/${parts[0]}` : "/";
}

function routeForRequest(request: FastifyRequest) {
  const route = request.routeOptions?.url;
  return typeof route === "string" && route ? route : cleanUrl(request.url);
}

function actionForRequest(request: FastifyRequest) {
  const queryAction = asObject(request.query).action;
  if (queryAction) return cleanShort(queryAction, 80);
  const body = asObject(request.body);
  return cleanShort(body.action ?? body._action ?? "", 80);
}

function actorValue(request: FastifyRequest, field: "email" | "org_id") {
  const header = field === "email" ? "x-internal-user-email" : "x-internal-org-id";
  const bodyKey = field === "email" ? "actor_email" : "actor_org_id";
  const query = asObject(request.query);
  const body = asObject(request.body);
  return cleanShort(request.headers[header] ?? query[bodyKey] ?? body[bodyKey] ?? "", 120).toLowerCase();
}

function shouldSkipUrl(url: string) {
  return cleanUrl(url).startsWith("/v1/internal/diagnostics");
}

function cleanUrl(url: string) {
  const value = String(url || "/");
  const withoutOrigin = value.replace(/^https?:\/\/[^/]+/i, "");
  return (withoutOrigin.split("?")[0] || "/").slice(0, 300);
}

function responseBytes(reply: FastifyReply) {
  const header = reply.getHeader("content-length");
  return numberHeader(Array.isArray(header) ? header[0] : header);
}

function numberHeader(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function cleanShort(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function nullableNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round(parsed, 1) : null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function bytesToMb(value: number) {
  return round(value / 1024 / 1024, 1);
}

function nsToMs(value: number) {
  return round(value / 1_000_000, 1);
}

function round(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[index] ?? 0, 1);
}

function renderDiagnosticsPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FirstMate Diagnostics</title>
    <style>
      :root{color-scheme:light;--bg:#f6f7f8;--panel:#fff;--ink:#182026;--muted:#64717d;--line:#d9dee3;--accent:#0f766e;--bad:#b42318;--warn:#b54708}
      *{box-sizing:border-box}
      body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
      h1{margin:0;font-size:17px}
      .actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:7px 10px;font:inherit;cursor:pointer}
      button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
      #copyState{color:var(--muted);min-width:86px}
      main{padding:16px;display:grid;gap:14px}
      .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
      .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}
      .capacity{display:grid;grid-template-columns:minmax(280px,1.2fr) minmax(0,2fr);gap:14px;padding:16px;border-width:2px}
      .capacity[data-action="no_purchase"]{border-color:#0f766e;background:#f0fdfa}
      .capacity[data-action="watch"],.capacity[data-action="collecting"]{border-color:#d97706;background:#fffbeb}
      .capacity[data-action="resize"]{border-color:#b42318;background:#fff4f2}
      .capacity[data-action="investigate"]{border-color:#7c3aed;background:#f5f3ff}
      .capacity-kicker{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
      .capacity-action{font-size:28px;font-weight:850;line-height:1.1;margin:5px 0 8px}
      .capacity-reason{color:var(--muted);max-width:760px}
      .capacity-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:13px}
      .capacity-meta>div{background:rgba(255,255,255,.7);border:1px solid var(--line);border-radius:6px;padding:8px}
      .capacity-meta strong{display:block;font-size:18px}.capacity-meta span{font-size:11px;color:var(--muted)}
      .capacity table td:first-child{font-weight:700}
      .metric{font-size:24px;font-weight:750;line-height:1.1}
      .label{color:var(--muted);font-size:12px;margin-top:4px}
      .ok{color:var(--accent)}.warn{color:var(--warn)}.bad{color:var(--bad)}
      table{width:100%;border-collapse:collapse}
      th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
      th{font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase}
      code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
      .wide{grid-column:1/-1}
      @media (max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.capacity{grid-template-columns:1fr}}
      @media (max-width:560px){.grid{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}}
    </style>
  </head>
  <body>
    <header>
      <h1>FirstMate Diagnostics</h1>
      <div class="actions">
        <button id="copy" class="primary">Copy For Codex</button>
        <button id="refresh">Refresh</button>
        <span id="copyState"></span>
      </div>
    </header>
    <main>
      <section class="panel capacity" id="capacity" data-action="collecting">
        <div>
          <div class="capacity-kicker">Server Capacity Decision</div>
          <div class="capacity-action" id="capacityAction">COLLECTING BASELINE</div>
          <div class="capacity-reason" id="capacityReason">Waiting for the first persisted capacity samples.</div>
          <div class="capacity-meta">
            <div><strong id="capacityCurrent">-</strong><span>Current vCPU</span></div>
            <div><strong id="capacityRecommended">-</strong><span>Recommended vCPU</span></div>
            <div><strong id="capacityConfidence">-</strong><span>Decision confidence</span></div>
          </div>
        </div>
        <div>
          <table><thead><tr><th>Window</th><th>Coverage</th><th>CPU avg</th><th>CPU p95</th><th>CPU pressure</th><th>I/O wait</th><th>Requests</th><th>Request p95</th><th>Target</th></tr></thead><tbody id="capacityWindows"></tbody></table>
          <div class="label">Sizing uses p95 busy-core demand with a 70% peak target. A purchase recommendation requires at least six hours of evidence; seven-day confidence requires three days.</div>
        </div>
      </section>
      <section class="grid" id="metrics"></section>
      <section class="panel wide">
        <h2>Seven-Day Capacity History</h2>
        <table><thead><tr><th>UTC day</th><th>Status</th><th>CPU p95</th><th>CPU pressure</th><th>Requests</th><th>Request p95</th><th>Capacity target</th></tr></thead><tbody id="capacityDays"></tbody></table>
      </section>
      <section class="panel wide">
        <h2>Traffic By Area</h2>
        <table><thead><tr><th>Area</th><th>Requests</th><th>Slow</th><th>Errors</th><th>Avg</th><th>P95</th></tr></thead><tbody id="areas"></tbody></table>
      </section>
      <section class="panel wide">
        <h2>Slowest Recent Requests</h2>
        <table><thead><tr><th>Time</th><th>Area</th><th>Route</th><th>Action</th><th>Status</th><th>Duration</th><th>Trace</th></tr></thead><tbody id="slow"></tbody></table>
      </section>
      <section class="panel wide">
        <h2>Recent Errors</h2>
        <table><thead><tr><th>Time</th><th>Area</th><th>Route</th><th>Message</th><th>Trace</th></tr></thead><tbody id="errors"></tbody></table>
      </section>
    </main>
    <script>
      const fmt = (v, unit = '') => (v === null || v === undefined ? '-' : String(v) + unit);
      const cell = (text) => '<td>' + String(text ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</td>';
      function metric(label, value, cls = '') {
        return '<div class="panel"><div class="metric ' + cls + '">' + value + '</div><div class="label">' + label + '</div></div>';
      }
      let latestSummary = null;
      async function fetchSummary() {
        latestSummary = await fetch('/v1/internal/diagnostics/summary', { cache: 'no-store' }).then(r => r.json());
        return latestSummary;
      }
      async function load() {
        const data = await fetchSummary();
        const rt = data.runtime || {};
        const fmJobs = data.config?.firstmeasure_jobs || {};
        const fmSizing = fmJobs.workerSizing || {};
        const capacity = data.capacity || {};
        const capacityPanel = document.getElementById('capacity');
        capacityPanel.dataset.action = capacity.action || 'collecting';
        document.getElementById('capacityAction').textContent = capacity.action_label || 'COLLECTING BASELINE';
        document.getElementById('capacityReason').textContent = capacity.action_reason || 'Waiting for capacity history.';
        document.getElementById('capacityCurrent').textContent = fmt(capacity.current_vcpus);
        document.getElementById('capacityRecommended').textContent = fmt(capacity.recommended_vcpus);
        document.getElementById('capacityConfidence').textContent = String(capacity.confidence || 'low').toUpperCase();
        const windows = capacity.windows || {};
        document.getElementById('capacityWindows').innerHTML = [
          ['Last 24 hours', windows.last_24_hours],
          ['Last 7 days', windows.last_7_days]
        ].map(item => {
          const row = item[1] || {};
          return '<tr>' + [item[0],fmt(row.coverage_percent,'%'),fmt(row.cpu_avg_percent,'%'),fmt(row.cpu_p95_percent,'%'),fmt(row.cpu_pressure_p95_percent,'%'),fmt(row.iowait_p95_percent,'%'),fmt(row.request_count),fmt(row.request_p95_ms,' ms'),fmt(row.recommended_vcpus,' vCPU')].map(cell).join('') + '</tr>';
        }).join('');
        document.getElementById('capacityDays').innerHTML = (capacity.daily || []).map(row =>
          '<tr>' + [row.date,String(row.status || '').replaceAll('_',' '),fmt(row.cpu_p95_percent,'%'),fmt(row.pressure_p95_percent,'%'),fmt(row.request_count),fmt(row.request_p95_ms,' ms'),fmt(row.recommended_vcpus,' vCPU')].map(cell).join('') + '</tr>'
        ).join('');
        document.getElementById('metrics').innerHTML = [
          metric('Active Requests', fmt(rt.active_requests), rt.active_requests > 10 ? 'warn' : 'ok'),
          metric('HTTP Worker', fmt(rt.web_worker_id ? rt.web_worker_id + ' / ' + rt.web_worker_count : 'single'), rt.web_worker_count > 1 ? 'ok' : 'warn'),
          metric('This HTTP Process CPU', fmt(rt.cpu_percent, '%'), rt.cpu_percent > 80 ? 'bad' : rt.cpu_percent > 50 ? 'warn' : 'ok'),
          metric('RSS Memory', fmt(rt.memory_rss_mb, ' MB')),
          metric('FirstMeasure Workers', fmt(fmJobs.workerCount ?? fmSizing.resolved_workers), fmSizing.mode === 'disabled' ? 'bad' : 'ok'),
          metric('FirstMeasure Worker Mode', fmt(fmSizing.mode)),
          metric('Available CPUs', fmt(fmSizing.available_cpus ?? rt.firstmeasure_job_available_cpus)),
          metric('Auto Worker Target', fmt(fmSizing.auto_target)),
          metric('Event Loop P95', fmt(rt.event_loop_delay_p95_ms, ' ms'), rt.event_loop_delay_p95_ms > 100 ? 'bad' : rt.event_loop_delay_p95_ms > 40 ? 'warn' : 'ok'),
          metric('Request P95', fmt(data.latency?.p95_ms, ' ms')),
          metric('Slow Requests', fmt(data.totals?.slow_requests), data.totals?.slow_requests ? 'warn' : 'ok'),
          metric('Errors', fmt(data.totals?.errors), data.totals?.errors ? 'bad' : 'ok'),
          metric('Dropped Diag Events', fmt(data.totals?.dropped_events), data.totals?.dropped_events ? 'warn' : 'ok')
        ].join('');
        document.getElementById('areas').innerHTML = (data.by_area || []).map(row =>
          '<tr>' + [row.name,row.count,row.slow_count,row.error_count,fmt(row.avg_ms,' ms'),fmt(row.p95_ms,' ms')].map(cell).join('') + '</tr>'
        ).join('');
        document.getElementById('slow').innerHTML = (data.slowest || []).map(row =>
          '<tr>' + [row.at,row.app_area,row.route,row.action,row.status_code,fmt(row.duration_ms,' ms'),row.trace_id].map(cell).join('') + '</tr>'
        ).join('');
        document.getElementById('errors').innerHTML = (data.recent_errors || []).map(row =>
          '<tr>' + [row.at,row.app_area,row.route,row.message,row.trace_id].map(cell).join('') + '</tr>'
        ).join('');
      }
      async function copyForCodex() {
        const state = document.getElementById('copyState');
        state.textContent = 'Copying...';
        try {
          const data = latestSummary || await fetchSummary();
          const payload = [
            'FirstMate diagnostics snapshot',
            'URL: ' + location.href,
            'Captured: ' + new Date().toISOString(),
            '',
            JSON.stringify(data, null, 2)
          ].join('\\n');
          await navigator.clipboard.writeText(payload);
          state.textContent = 'Copied';
          setTimeout(() => { state.textContent = ''; }, 1800);
        } catch {
          state.textContent = 'Copy failed';
        }
      }
      document.getElementById('refresh').addEventListener('click', load);
      document.getElementById('copy').addEventListener('click', copyForCodex);
      load();
      setInterval(load, 10000);
    </script>
  </body>
</html>`;
}
