import { availableParallelism, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { setTimeout as sleep } from "node:timers/promises";

import { env } from "../src/config/env.js";
import { getFirstMeasureProcessRole, shouldRunFirstMeasureBackgroundProcessor } from "./background_role.js";
import {
  claimNextFirstMeasureJob,
  completeFirstMeasureJob,
  failFirstMeasureJob,
  recordFirstMeasureWorkerHeartbeat,
  renewFirstMeasureJobLease,
  reapExhaustedFirstMeasureJobs,
  type FirstMeasureJobRow
} from "./job_queue.js";
import { runWithJobLease } from "./job_lease.js";

type Logger = {
  info?: (value: unknown, message?: string) => void;
  warn?: (value: unknown, message?: string) => void;
  error?: (value: unknown, message?: string) => void;
};

type FirstMeasureJobHandler = (
  job: FirstMeasureJobRow,
  logger?: Logger
) => Promise<Record<string, unknown>>;

const registeredJobHandlers = new Map<string, FirstMeasureJobHandler>();

let runtimeStarted = false;
let runtimeStopping = false;
let dispatcher: Promise<void> | null = null;
const activeJobs = new Set<Promise<void>>();
const runtimeId = `${hostname()}:${process.pid}:${randomUUID()}`;
const JOB_LEASE_MS = 300_000;
const requestedMaxRuntime = Number(process.env.FIRSTMEASURE_JOB_MAX_RUNTIME_MS ?? 30 * 60_000);
const MAX_JOB_RUNTIME_MS = Number.isFinite(requestedMaxRuntime)
  ? Math.max(60_000, Math.min(6 * 60 * 60_000, requestedMaxRuntime)) : 30 * 60_000;
let runtimeHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let runtimeState = {
  workerCount: 0,
  workerSizing: resolveFirstMeasureJobWorkerSizing(),
  startedAt: "",
  heartbeatAt: "",
  claimed: 0,
  completed: 0,
  failed: 0
};

export function resolveFirstMeasureJobWorkerSizing() {
  const availableCpus = Math.max(1, availableParallelism());
  const maxWorkers = Math.max(1, availableCpus - 1);
  const configured = env.firstmeasureJobWorkers;
  const clusterWorkerId = String(process.env.V1_CLUSTER_WORKER ?? "").trim();
  if (configured === 0) {
    return {
      mode: "disabled",
      configured: 0,
      available_cpus: availableCpus,
      max_workers: maxWorkers,
      auto_target: 0,
      resolved_workers: 0
    };
  }
  // Dedicated worker processes are independent from the HTTP cluster. In the
  // backwards-compatible combined role, only logical slot 1 owns background
  // processing so an explicit worker count is not multiplied by every web fork.
  if (!shouldRunFirstMeasureBackgroundProcessor(getFirstMeasureProcessRole(), clusterWorkerId)) {
    return {
      mode: "disabled",
      configured,
      available_cpus: availableCpus,
      max_workers: maxWorkers,
      auto_target: 0,
      resolved_workers: 0
    };
  }
  const autoTarget = Math.min(maxWorkers, Math.max(1, Math.floor(availableCpus * 0.75)));
  const requested = configured ?? autoTarget;
  return {
    mode: configured == null ? "auto" : "configured",
    configured,
    available_cpus: availableCpus,
    max_workers: maxWorkers,
    auto_target: autoTarget,
    resolved_workers: Math.min(Math.max(0, Math.floor(requested)), maxWorkers)
  };
}

export function registerFirstMeasureJobHandler(type: string, handler: FirstMeasureJobHandler) {
  const normalized = String(type ?? "").trim();
  if (!normalized) throw new Error("FirstMeasure job handler type is required.");
  registeredJobHandlers.set(normalized, handler);
}

function runWorkerThread(job: FirstMeasureJobRow) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const worker = new Worker(new URL("./job_worker.js", import.meta.url), {
      workerData: {
        id: job.id,
        type: job.type,
        payload: job.payload
      }
    });
    worker.once("message", (message: unknown) => {
      const payload = message && typeof message === "object" ? message as Record<string, unknown> : {};
      if (payload.ok) {
        resolve((payload.result && typeof payload.result === "object") ? payload.result as Record<string, unknown> : {});
      } else {
        reject(new Error(String(payload.error || "Worker job failed.")));
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      // If a result already arrived this reject is harmless. Even exit(0)
      // without a result must release the occupied job slot.
      reject(new Error(`Worker exited with code ${code} without a result.`));
    });
  });
}

async function executeClaimedJob(job: FirstMeasureJobRow, logger?: Logger) {
  runtimeState.claimed += 1;
  try {
    const handler = registeredJobHandlers.get(job.type);
    const result = await runWithJobLease({
      execute: () => handler ? handler(job, logger) : runWorkerThread(job),
      renew: () => renewFirstMeasureJobLease(job.id, job, JOB_LEASE_MS),
      leaseUntilMs: job.lease_until_ms,
      leaseMs: JOB_LEASE_MS,
      intervalMs: 10_000,
      safetyMarginMs: 30_000,
      maxRuntimeMs: MAX_JOB_RUNTIME_MS,
      warn: (err) => logger?.warn?.({ err, jobId: job.id }, "Job lease renewal failed; retrying before expiry."),
      fatal: (reason) => {
        logger?.error?.({ reason, jobId: job.id }, "Worker stopping to prevent unsafe job execution; supervisor will restart it.");
        process.exit(1);
      }
    });
    if (!await completeFirstMeasureJob(job.id, result, job)) throw new Error("Job completion rejected: claim is no longer owned.");
    runtimeState.completed += 1;
  } catch (error) {
    await failFirstMeasureJob(job.id, error, job);
    runtimeState.failed += 1;
    logger?.warn?.({ err: error, jobId: job.id, type: job.type }, "FirstMeasure job failed.");
  }
}

async function dispatcherLoop(workerCount: number, logger?: Logger) {
  const workerId = `${runtimeId}:dispatcher`;
  const active = activeJobs;
  let nextReapAt = 0;
  while (!runtimeStopping) {
    try {
      const registeredTypes = ["stress.cpu", ...registeredJobHandlers.keys()];
      const allowedTypes = String(process.env.FIRSTMEASURE_JOB_TYPES ?? "")
        .split(",").map((type) => type.trim()).filter(Boolean);
      const jobTypes = allowedTypes.length
        ? registeredTypes.filter((type) => allowedTypes.includes(type))
        : registeredTypes;
      if (Date.now() >= nextReapAt) {
        const reaped = await reapExhaustedFirstMeasureJobs(jobTypes);
        if (reaped) logger?.warn?.({ count: reaped }, "Expired final-attempt jobs marked failed; operator review required.");
        nextReapAt = Date.now() + 30_000;
      }
      if (active.size >= workerCount) {
        await Promise.race([...active, sleep(250)]);
        continue;
      }
      const job = await claimNextFirstMeasureJob(workerId, jobTypes, JOB_LEASE_MS);
      if (!job) {
        if (active.size > 0) {
          await Promise.race([Promise.race(active), sleep(250)]);
        } else {
          await sleep(250);
        }
        continue;
      }
      const execution = executeClaimedJob(job, logger).catch((error) => {
        logger?.error?.({ err: error, jobId: job.id, type: job.type }, "FirstMeasure job completion update failed.");
      });
      active.add(execution);
      void execution.then(() => active.delete(execution));
    } catch (error) {
      logger?.error?.({ err: error, workerId }, "FirstMeasure job worker loop failed.");
      await sleep(1000);
    }
  }
}

export function startFirstMeasureJobRuntime(logger?: Logger) {
  if (runtimeStarted) return runtimeState;
  runtimeStarted = true;
  const workerSizing = resolveFirstMeasureJobWorkerSizing();
  const workerCount = workerSizing.resolved_workers;
  runtimeState = {
    workerCount,
    workerSizing,
    startedAt: new Date().toISOString(),
    heartbeatAt: "",
    claimed: 0,
    completed: 0,
    failed: 0
  };
  if (workerCount <= 0) {
    logger?.info?.({ workerCount }, "FirstMeasure job runtime disabled.");
    return runtimeState;
  }
  dispatcher = dispatcherLoop(workerCount, logger);
  const workerId = `${runtimeId}:runtime`;
  let heartbeatPending = false;
  const recordHeartbeat = async () => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    try {
      const heartbeatAtMs = await recordFirstMeasureWorkerHeartbeat(
        workerId,
        workerCount,
        runtimeState.startedAt
      );
      runtimeState.heartbeatAt = new Date(heartbeatAtMs).toISOString();
    } catch (error) {
      logger?.error?.({ err: error, workerId }, "FirstMeasure worker heartbeat failed.");
    } finally { heartbeatPending = false; }
  };
  void recordHeartbeat();
  runtimeHeartbeatTimer = setInterval(() => void recordHeartbeat(), 30_000);
  runtimeHeartbeatTimer.unref?.();
  logger?.info?.({ workerCount }, "FirstMeasure job runtime started.");
  return runtimeState;
}

export function getFirstMeasureJobRuntimeStatus() {
  return { ...runtimeState, activeJobs: activeJobs.size, stopping: runtimeStopping };
}

export async function stopFirstMeasureJobRuntime(timeoutMs = 45_000) {
  runtimeStopping = true;
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      (async () => { await dispatcher; await Promise.allSettled([...activeJobs]); return true; })(),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timeout!);
    if (runtimeHeartbeatTimer) clearInterval(runtimeHeartbeatTimer);
  }
}
