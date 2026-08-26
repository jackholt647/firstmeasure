import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { setTimeout as sleep } from "node:timers/promises";

import { env } from "../src/config/env.js";
import { getFirstMeasureProcessRole, shouldRunFirstMeasureBackgroundProcessor } from "./background_role.js";
import {
  claimNextFirstMeasureJob,
  completeFirstMeasureJob,
  failFirstMeasureJob,
  recordFirstMeasureWorkerHeartbeat,
  type FirstMeasureJobRow
} from "./job_queue.js";

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
      if (code !== 0) reject(new Error(`Worker exited with code ${code}.`));
    });
  });
}

async function executeClaimedJob(job: FirstMeasureJobRow, logger?: Logger) {
  runtimeState.claimed += 1;
  try {
    const handler = registeredJobHandlers.get(job.type);
    const result = handler
      ? await handler(job, logger)
      : await runWorkerThread(job);
    await completeFirstMeasureJob(job.id, result);
    runtimeState.completed += 1;
  } catch (error) {
    await failFirstMeasureJob(job.id, error);
    runtimeState.failed += 1;
    logger?.warn?.({ err: error, jobId: job.id, type: job.type }, "FirstMeasure job failed.");
  }
}

async function dispatcherLoop(workerCount: number, logger?: Logger) {
  const workerId = `${process.pid}:fm-job-dispatcher`;
  const active = new Set<Promise<void>>();
  while (true) {
    try {
      if (active.size >= workerCount) {
        await Promise.race(active);
        continue;
      }
      const jobTypes = ["stress.cpu", ...registeredJobHandlers.keys()];
      const job = await claimNextFirstMeasureJob(workerId, jobTypes, 300_000);
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
  void dispatcherLoop(workerCount, logger);
  const workerId = `${process.pid}:fm-runtime`;
  const recordHeartbeat = async () => {
    try {
      const heartbeatAtMs = await recordFirstMeasureWorkerHeartbeat(
        workerId,
        workerCount,
        runtimeState.startedAt
      );
      runtimeState.heartbeatAt = new Date(heartbeatAtMs).toISOString();
    } catch (error) {
      logger?.error?.({ err: error, workerId }, "FirstMeasure worker heartbeat failed.");
    }
  };
  void recordHeartbeat();
  runtimeHeartbeatTimer = setInterval(() => void recordHeartbeat(), 30_000);
  runtimeHeartbeatTimer.unref?.();
  logger?.info?.({ workerCount }, "FirstMeasure job runtime started.");
  return runtimeState;
}

export function getFirstMeasureJobRuntimeStatus() {
  return { ...runtimeState };
}
