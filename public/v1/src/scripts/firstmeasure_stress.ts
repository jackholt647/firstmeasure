type Stats = {
  count: number;
  ok: number;
  failed: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
};

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const raw = process.argv[index] ?? "";
  if (!raw.startsWith("--")) continue;
  const [key, value] = raw.slice(2).split("=", 2);
  if (key) args.set(key, value ?? "1");
}

const baseUrl = args.get("base") || "http://127.0.0.1:3111/v1/firstmeasure";
const jobCount = Math.max(1, Number(args.get("jobs") || 48));
const iterations = Math.max(1, Number(args.get("iterations") || 8_000_000));
const readRequests = Math.max(0, Number(args.get("reads") || 250));
const readConcurrency = Math.max(1, Number(args.get("readConcurrency") || 32));
const timeoutMs = Math.max(5_000, Number(args.get("timeoutMs") || 120_000));
const actor = {
  email: args.get("email") || "codex-stress@example.test",
  name: "Codex Stress",
  roles: ["admin", "firstmeasure_debugger"]
};

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function summarize(samples: Array<{ ok: boolean; ms: number }>): Stats {
  const times = samples.map((sample) => sample.ms);
  return {
    count: samples.length,
    ok: samples.filter((sample) => sample.ok).length,
    failed: samples.filter((sample) => !sample.ok).length,
    min: times.length ? Math.min(...times) : 0,
    max: times.length ? Math.max(...times) : 0,
    avg: times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : 0,
    p50: percentile(times, 50),
    p95: percentile(times, 95)
  };
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data as Record<string, unknown>;
}

async function timed(path: string, body: Record<string, unknown>) {
  const started = Date.now();
  try {
    await post(path, body);
    return { ok: true, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const startedAt = Date.now();
  console.log(`Stress target: ${baseUrl}`);
  console.log(`Enqueueing ${jobCount} CPU jobs (${iterations.toLocaleString()} iterations each)...`);

  const enqueue = await post("admin/jobs/enqueue-stress", {
    actor,
    count: jobCount,
    iterations,
    max_attempts: 1
  });
  const ids = Array.isArray(enqueue.ids) ? enqueue.ids.map(String) : [];
  console.log(`Enqueued ${ids.length} jobs.`);

  const readSamples: Array<{ ok: boolean; ms: number }> = [];
  const readPaths = ["qa/me/status", "queue/counts", "queue/bucket", "qa/queue/peek"];
  const readBodies: Record<string, Record<string, unknown>> = {
    "qa/me/status": { actor },
    "queue/counts": {},
    "queue/bucket": { group: "qa_waiting", limit: 10, view: "card" },
    "qa/queue/peek": { actor, limit: 10, live: false, release_stale: false }
  };
  const readWork = Array.from({ length: readRequests }, (_, index) => readPaths[index % readPaths.length] || "queue/counts");
  const readPromise = runPool(readWork, readConcurrency, async (path) => {
    readSamples.push(await timed(path, readBodies[path] || {}));
  });

  let completed = 0;
  let failed = 0;
  let stats: Record<string, unknown> = {};
  while (Date.now() - startedAt < timeoutMs) {
    const status = await post("admin/jobs/status", { actor, ids });
    stats = (status.stats && typeof status.stats === "object") ? status.stats as Record<string, unknown> : {};
    const jobs = Array.isArray(status.jobs) ? status.jobs as Array<Record<string, unknown>> : [];
    completed = jobs.filter((job) => job.status === "completed").length;
    failed = jobs.filter((job) => job.status === "failed").length;
    process.stdout.write(`\rJobs completed ${completed}/${ids.length}, failed ${failed}, queue stats ${JSON.stringify(stats)}       `);
    if (completed + failed >= ids.length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stdout.write("\n");
  await readPromise;

  const elapsedMs = Date.now() - startedAt;
  const readStats = summarize(readSamples);
  console.log(JSON.stringify({
    elapsed_ms: elapsedMs,
    job_count: ids.length,
    completed,
    failed,
    jobs_per_second: elapsedMs > 0 ? Math.round((completed / elapsedMs) * 1000 * 100) / 100 : completed,
    final_queue_stats: stats,
    read_stats: readStats
  }, null, 2));

  if (completed + failed < ids.length) {
    process.exitCode = 2;
  } else if (failed > 0 || readStats.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
