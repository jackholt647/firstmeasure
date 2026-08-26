import cluster from "node:cluster";
import { availableParallelism } from "node:os";

import { buildApp } from "./app.js";
import { takeClusterWorkerSlot } from "./cluster_worker_slots.js";
import { env } from "./config/env.js";

type WorkerHealthMessage = {
  type: "v1-worker-health";
  state: "ready" | "heartbeat";
  at: number;
};

type WorkerState = {
  slot: number;
  forkedAt: number;
  lastHeartbeatAt: number | null;
  consecutiveCrashes: number;
};

type WebWorkerSizing = {
  mode: "disabled" | "auto" | "configured";
  configured: number | null;
  available_cpus: number;
  resolved_workers: number;
};

function isCompiledProductionEntrypoint() {
  const entrypoint = String(process.argv[1] ?? "").replace(/\\/g, "/");
  return env.isProduction || entrypoint.endsWith("dist/src/server.js");
}

export function resolveWebWorkerSizing(): WebWorkerSizing {
  const availableCpus = Math.max(1, availableParallelism());
  const configured = env.webWorkers;
  if (configured === 0) {
    return {
      mode: "disabled",
      configured,
      available_cpus: availableCpus,
      resolved_workers: 1
    };
  }

  const autoTarget = isCompiledProductionEntrypoint()
    ? Math.max(1, Math.min(44, availableCpus - 1))
    : 1;
  const requested = configured ?? autoTarget;
  const requestedWorkers = Math.max(1, Math.min(availableCpus, Math.floor(requested)));
  return {
    mode: configured == null ? "auto" : "configured",
    configured,
    available_cpus: availableCpus,
    // The SQLite index is one shared writable file. Multiple Node processes
    // have separate in-memory mutation queues and can contend on BEGIN
    // IMMEDIATE, so horizontal HTTP concurrency requires PostgreSQL.
    resolved_workers: env.firstmeasureDatabaseMode === "sqlite" ? 1 : requestedWorkers
  };
}

async function start() {
  const app = await buildApp();

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "Stopping v1 HTTP worker gracefully.");
    void app.close()
      .then(() => process.exit(0))
      .catch((error) => {
        app.log.error({ err: error }, "Graceful v1 HTTP worker shutdown failed.");
        process.exit(1);
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await app.listen({
      host: env.host,
      port: env.port
    });
    if (process.send) {
      const sendHealth = (state: WorkerHealthMessage["state"]) => {
        if (!process.connected) return;
        process.send?.({ type: "v1-worker-health", state, at: Date.now() } satisfies WorkerHealthMessage);
      };
      sendHealth("ready");
      const heartbeat = setInterval(() => sendHealth("heartbeat"), env.webWorkerHeartbeatIntervalMs);
      heartbeat.unref();
    }
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

function startCluster() {
  const sizing = resolveWebWorkerSizing();
  if (!cluster.isPrimary) {
    void start();
    return;
  }

  // Keep one SQLite HTTP worker behind a primary in compiled production so a
  // crash or event-loop stall can still be replaced without waiting for the
  // outer service monitor. V1_WEB_WORKERS=0 remains an explicit no-cluster
  // escape hatch, and source-mode development stays single-process.
  const superviseSingleWorker = sizing.resolved_workers === 1
    && sizing.mode !== "disabled"
    && isCompiledProductionEntrypoint();
  if (sizing.resolved_workers <= 1 && !superviseSingleWorker) {
    void start();
    return;
  }

  console.log(
    `Starting v1 HTTP cluster with ${sizing.resolved_workers} workers ` +
    `(${sizing.mode}, ${sizing.available_cpus} CPUs available` +
    `${env.firstmeasureDatabaseMode === "sqlite" ? ", capped at one for SQLite write safety" : ""}).`
  );

  const workerSlots = new Map<number, number>();
  const workerStates = new Map<number, WorkerState>();
  const slotCrashCounts = new Map<number, number>();
  const crashTimes: number[] = [];
  const restartTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopping = false;

  const forkSlot = (slot: number) => {
    if (stopping) return;
    const worker = cluster.fork({
      V1_CLUSTER_WORKER: String(slot),
      V1_CLUSTER_WORKER_COUNT: String(sizing.resolved_workers)
    });
    workerSlots.set(worker.id, slot);
    workerStates.set(worker.id, {
      slot,
      forkedAt: Date.now(),
      lastHeartbeatAt: null,
      consecutiveCrashes: slotCrashCounts.get(slot) ?? 0
    });
    worker.on("message", (message: unknown) => {
      const health = message as Partial<WorkerHealthMessage> | null;
      if (health?.type !== "v1-worker-health") return;
      if (health.state !== "ready" && health.state !== "heartbeat") return;
      const state = workerStates.get(worker.id);
      if (!state) return;
      state.lastHeartbeatAt = Date.now();
      if (health.state === "ready") {
        state.consecutiveCrashes = 0;
        slotCrashCounts.set(state.slot, 0);
      }
    });
  };

  for (let index = 0; index < sizing.resolved_workers; index += 1) {
    forkSlot(index + 1);
  }

  cluster.on("exit", (worker, code, signal) => {
    const slot = takeClusterWorkerSlot(workerSlots, worker.id);
    const state = workerStates.get(worker.id);
    workerStates.delete(worker.id);
    if (stopping) return;

    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length && crashTimes[0]! < now - env.webWorkerCrashWindowMs) crashTimes.shift();
    console.error(
      `v1 HTTP worker ${worker.process.pid ?? "unknown"} exited ` +
      `(slot=${slot}, code=${code ?? "null"}, signal=${signal ?? "null"}); restarting.`
    );
    if (crashTimes.length >= env.webWorkerCrashLimit) {
      console.error(
        `v1 HTTP cluster observed ${crashTimes.length} worker exits in ` +
        `${env.webWorkerCrashWindowMs}ms; exiting so the service supervisor can perform a clean restart.`
      );
      stopping = true;
      for (const timer of restartTimers) clearTimeout(timer);
      for (const remaining of Object.values(cluster.workers ?? {})) remaining?.kill("SIGTERM");
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 5_000).unref();
      return;
    }

    const consecutiveCrashes = (state?.consecutiveCrashes ?? 0) + 1;
    slotCrashCounts.set(slot, consecutiveCrashes);
    const delay = Math.min(
      env.webWorkerRestartMaxDelayMs,
      env.webWorkerRestartBaseDelayMs * (2 ** Math.min(10, Math.max(0, consecutiveCrashes - 1)))
    );
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      forkSlot(slot);
    }, delay);
    restartTimers.add(timer);
  });

  const watchdog = setInterval(() => {
    if (stopping) return;
    const now = Date.now();
    for (const [workerId, state] of workerStates) {
      const deadline = state.lastHeartbeatAt == null
        ? state.forkedAt + env.webWorkerStartupTimeoutMs
        : state.lastHeartbeatAt + env.webWorkerHeartbeatTimeoutMs;
      if (now <= deadline) continue;
      const worker = cluster.workers?.[workerId];
      if (!worker || worker.isDead()) continue;
      console.error(
        `v1 HTTP worker ${worker.process.pid ?? "unknown"} missed its ` +
        `${state.lastHeartbeatAt == null ? "startup" : "heartbeat"} deadline (slot=${state.slot}); terminating.`
      );
      worker.kill("SIGKILL");
    }
  }, Math.max(1_000, Math.min(env.webWorkerHeartbeatIntervalMs, 5_000)));
  watchdog.unref();

  const stopCluster = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    clearInterval(watchdog);
    for (const timer of restartTimers) clearTimeout(timer);
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill(signal);
  };
  process.once("SIGINT", stopCluster);
  process.once("SIGTERM", stopCluster);
}

startCluster();
