import cluster, { type Worker } from "node:cluster";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { Server } from "node:net";
import { availableParallelism } from "node:os";
import path from "node:path";

import { takeClusterWorkerSlot } from "./cluster_worker_slots.js";
import { env } from "./config/env.js";
import { beginRuntimeDrain, validateRuntimeTopology } from "./runtime_health.js";

const SHUTDOWN_GRACE_MS = 10_000;
// A retiring worker finishes its connections (up to SHUTDOWN_GRACE_MS), then stops (up to
// SHUTDOWN_GRACE_MS + 5 s more) and exits by itself; the primary signals only as a backstop.
const RETIRE_TERM_MS = SHUTDOWN_GRACE_MS * 3;
const RETIRE_KILL_MS = SHUTDOWN_GRACE_MS * 4.5;
// deploy/digitalocean/activate-release.sh looks for this string in the server.js the running
// primary started from: only a primary that has it replaces its workers on SIGHUP (FM-389).
const ROLLING_REPLACE = "v1-rolling-replace";

type WorkerHealthMessage = {
  type: "v1-worker-health";
  state: "ready" | "heartbeat";
  at: number;
};

type WorkerRetireMessage = { type: "v1-worker-retire" };

type WorkerState = {
  slot: number;
  forkedAt: number;
  lastHeartbeatAt: number | null;
  consecutiveCrashes: number;
  // Which release settings it was forked with; a rolling replace moves every slot to the newest.
  generation: number;
  // serving: an ordinary worker. candidate: a replacement not yet ready (its exit restarts nothing).
  // retiring: being stopped after its replacement became ready.
  role: "serving" | "candidate" | "retiring";
  onReady?: () => void;
  onExit?: (code: number | null, signal: string | null) => void;
};

type ReplacementRelease = {
  generation: number;
  directory: string;
  exec: string;
  releaseId: string;
  env: Record<string, string>;
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

// The release.env beside a release (KEY=VALUE lines, as systemd's EnvironmentFile reads them).
function readReleaseEnvironment(file: string) {
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const value = match[2]!;
    values[match[1]!] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return values;
}

async function start() {
  validateRuntimeTopology();
  // Imported here so the cluster primary, which only supervises, never loads the application.
  const { buildApp } = await import("./app.js");
  const app = await buildApp();

  // Event streams (realtime, presence, collaboration) hijack their response and
  // never finish on their own, so app.close() waited on every open tab until
  // systemd killed the worker 55 s later; every release was a 30-55 s outage.
  // A stop now ends them at once (EventSource reconnects to the new process)
  // and gives ordinary requests SHUTDOWN_GRACE_MS before cutting them off.
  const openResponses = new Set<import("node:http").ServerResponse>();
  const inFlight = new Set<import("node:http").ServerResponse>();
  let retired = false;
  app.server.on("request", (request, response) => {
    // A retiring worker answers what still reaches it on a kept-alive connection and asks
    // the client to reconnect, which lands on a worker that is not retiring.
    if (retired) response.setHeader("Connection", "close");
    inFlight.add(response);
    response.on("close", () => inFlight.delete(response));
    if (!String(request.headers.accept ?? "").includes("text/event-stream")) return;
    openResponses.add(response);
    response.on("close", () => openResponses.delete(response));
  });
  const endStreams = () => {
    const streams = openResponses.size;
    for (const response of openResponses) {
      try { response.end(); } catch { /* already closed */ }
    }
    return streams;
  };

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    beginRuntimeDrain();
    app.log.info({ signal, retired }, "Stopping v1 HTTP worker gracefully.");
    // A retired worker already gets no new connections, so it has no load balancer to wait for.
    const drainMs = env.deploymentTopology === "cluster" && !retired ? env.rollingDrainMs : 0;
    const close = async () => {
      if (drainMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, drainMs));
      const startedAt = Date.now();
      const streams = endStreams();
      app.server.once("close", () => app.log.info({ ms: Date.now() - startedAt, streams }, "v1 HTTP listener closed."));
      setTimeout(() => {
        app.log.warn({ ms: Date.now() - startedAt }, "Closing connections still open after the shutdown grace period.");
        app.server.closeAllConnections();
      }, SHUTDOWN_GRACE_MS).unref();
      // Close hooks (outboxes, schedulers, database pools) get a few seconds more; a
      // stop never waits for systemd's kill.
      setTimeout(() => {
        app.log.error({ ms: Date.now() - startedAt }, "v1 HTTP worker shutdown did not finish; exiting.");
        process.exit(0);
      }, SHUTDOWN_GRACE_MS + 5_000).unref();
      await app.close();
      app.log.info({ ms: Date.now() - startedAt }, "v1 HTTP worker stopped.");
    };
    void close()
      .then(() => process.exit(0))
      .catch((error) => {
        app.log.error({ err: error }, "Graceful v1 HTTP worker shutdown failed.");
        process.exit(1);
      });
  };

  // Rolling replace (FM-389): the primary retires this worker once its replacement is ready.
  // Closing the listening socket stops the primary handing it connections. Its kept-alive
  // connections stay open: the next request on each is answered with Connection: close, so
  // the client reconnects to another worker. http.Server.close() would also destroy the idle
  // ones at once, and a client that had just sent a request on one gets ECONNRESET.
  const retire = () => {
    if (retired || stopping) return;
    retired = true;
    beginRuntimeDrain();
    for (const response of inFlight) {
      if (!response.headersSent) response.setHeader("Connection", "close");
    }
    const streams = endStreams();
    const startedAt = Date.now();
    app.log.info({ in_flight: inFlight.size, streams }, "Retiring v1 HTTP worker: its replacement is ready.");
    const finished = new Promise<void>((resolve) => {
      Server.prototype.close.call(app.server, () => resolve());
    });
    const limit = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    void Promise.race([finished, limit]).then(() => {
      app.log.info({ ms: Date.now() - startedAt, in_flight: inFlight.size }, "Retired v1 HTTP worker's connections are done.");
      stop("SIGTERM");
    });
  };
  process.on("message", (message: unknown) => {
    if ((message as Partial<WorkerRetireMessage> | null)?.type === "v1-worker-retire") retire();
  });

  // systemd may signal the cgroup while the primary also forwards its signal.
  // Keep handlers installed so a duplicate signal cannot bypass the drain.
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  // SIGHUP is the primary's: it replaces cluster workers one at a time. A worker that gets one
  // anyway (a signal to the whole service) ignores it; a process without a primary has no
  // warm worker to hand over to, so it stops gracefully and its supervisor starts it again.
  process.on("SIGHUP", () => {
    if (!process.send) stop("SIGHUP");
  });

  try {
    if (process.env.V1_WORKER_WARMUP === "1") {
      const { warmWorker } = await import("./worker_warmup.js");
      await warmWorker(app);
    }
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
  // What new workers run. It starts as the code and environment the primary started with; a
  // rolling replace points it at the release `current` names now (cluster.setupPrimary).
  const startDirectory = process.cwd();
  const entrypoint = path.relative(startDirectory, path.resolve(String(process.argv[1] ?? "")));
  let release: ReplacementRelease = {
    generation: 0,
    directory: startDirectory,
    exec: path.resolve(String(process.argv[1] ?? "")),
    releaseId: env.releaseId,
    env: {}
  };

  const forkSlot = (slot: number, role: WorkerState["role"] = "serving") => {
    if (stopping) return null;
    const worker = cluster.fork({
      ...release.env,
      V1_CLUSTER_WORKER: String(slot),
      V1_CLUSTER_WORKER_COUNT: String(sizing.resolved_workers),
      ...(role === "candidate" ? { V1_WORKER_WARMUP: "1" } : {})
    });
    workerSlots.set(worker.id, slot);
    workerStates.set(worker.id, {
      slot,
      forkedAt: Date.now(),
      lastHeartbeatAt: null,
      consecutiveCrashes: slotCrashCounts.get(slot) ?? 0,
      generation: release.generation,
      role
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
        state.onReady?.();
      }
    });
    return worker;
  };

  for (let index = 0; index < sizing.resolved_workers; index += 1) {
    forkSlot(index + 1);
  }

  // The slot a rolling replace is moving right now: its candidate takes over if the old worker dies.
  let replacingSlot: number | null = null;

  cluster.on("exit", (worker, code, signal) => {
    const slot = takeClusterWorkerSlot(workerSlots, worker.id);
    const state = workerStates.get(worker.id);
    workerStates.delete(worker.id);
    state?.onExit?.(code, signal);
    if (stopping) return;
    // A retired worker was meant to stop; a candidate that died is the rolling replace's failure.
    if (state?.role === "retiring" || state?.role === "candidate") return;
    if (slot === replacingSlot) {
      console.error(
        `v1 HTTP worker ${worker.process.pid ?? "unknown"} exited during its replacement ` +
        `(slot=${slot}, code=${code ?? "null"}, signal=${signal ?? "null"}); its replacement takes over.`
      );
      return;
    }

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
      if (state.role === "retiring") continue;
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

  const liveWorker = (slot: number, predicate: (state: WorkerState) => boolean) => {
    for (const [workerId, state] of workerStates) {
      const worker = cluster.workers?.[workerId];
      if (state.slot === slot && worker && !worker.isDead() && predicate(state)) return worker;
    }
    return null;
  };

  const waitUntilReady = (worker: Worker) => new Promise<void>((resolve, reject) => {
    const state = workerStates.get(worker.id);
    if (!state) return reject(new Error("the new worker exited at once"));
    // The watchdog kills a worker that misses its startup deadline, which lands here as an exit.
    state.onReady = resolve;
    state.onExit = (code, signal) => reject(new Error(
      `the new worker (pid ${worker.process.pid ?? "unknown"}) exited before it was ready (code=${code ?? "null"}, signal=${signal ?? "null"})`
    ));
  });

  const retire = (worker: Worker) => new Promise<void>((resolve) => {
    const state = workerStates.get(worker.id);
    if (!state || worker.isDead()) return resolve();
    state.role = "retiring";
    // The worker stops by itself within about 25 s of the message; these are backstops.
    const term = setTimeout(() => {
      if (!worker.isDead()) worker.process.kill("SIGTERM");
    }, RETIRE_TERM_MS);
    const kill = setTimeout(() => {
      if (!worker.isDead()) worker.process.kill("SIGKILL");
    }, RETIRE_KILL_MS);
    state.onExit = () => {
      clearTimeout(term);
      clearTimeout(kill);
      resolve();
    };
    try {
      worker.send({ type: "v1-worker-retire" } satisfies WorkerRetireMessage);
    } catch {
      worker.process.kill("SIGTERM");
    }
  });

  const resolveReplacementRelease = (): ReplacementRelease => {
    const configured = env.webWorkerReleaseDir && existsSync(env.webWorkerReleaseDir)
      ? env.webWorkerReleaseDir
      : startDirectory;
    // Workers keep reading files from the directory they start in, so they get the real path.
    const directory = realpathSync(configured);
    const exec = path.join(directory, entrypoint);
    if (!existsSync(exec)) throw new Error(`${exec} does not exist`);
    const releaseEnv = readReleaseEnvironment(path.resolve(directory, "..", "..", "release.env"));
    return {
      generation: release.generation + 1,
      directory,
      exec,
      releaseId: releaseEnv.RELEASE_ID ?? env.releaseId,
      env: releaseEnv
    };
  };

  const useRelease = (next: ReplacementRelease) => {
    release = next;
    cluster.setupPrimary({ exec: next.exec, cwd: next.directory });
  };

  // Replace every worker, one at a time, with one forked from the release `current` points at
  // now: start it (it warms up before it listens), wait until it is ready, then retire the old
  // one and wait for it to exit. There is never a moment without a warm worker, unlike a
  // restart, which stops them all and starts cold ones into the backlog (FM-389).
  const rollingReplace = async () => {
    const previous = release;
    const startedAt = Date.now();
    let next: ReplacementRelease;
    try {
      next = resolveReplacementRelease();
    } catch (error) {
      console.error(`v1 HTTP cluster rolling replace failed: ${(error as Error).message}; the workers keep running.`);
      return;
    }
    useRelease(next);
    console.log(
      `v1 HTTP cluster rolling replace started (${ROLLING_REPLACE}): release=${next.releaseId}, ` +
      `directory=${next.directory}, workers=${sizing.resolved_workers}.`
    );
    try {
      for (let slot = 1; slot <= sizing.resolved_workers; slot += 1) {
        if (stopping) throw new Error("the cluster is stopping");
        // None: it died and was restarted, which forked the new release already (or will).
        const old = liveWorker(slot, (state) => state.role === "serving" && state.generation < next.generation);
        if (!old) continue;
        replacingSlot = slot;
        const forkedAt = Date.now();
        const candidate = forkSlot(slot, "candidate");
        if (!candidate) throw new Error("the cluster is stopping");
        await waitUntilReady(candidate);
        const state = workerStates.get(candidate.id);
        if (state) {
          state.role = "serving";
          state.onReady = undefined;
          state.onExit = undefined;
        }
        replacingSlot = null;
        await retire(old);
        console.log(
          `v1 HTTP worker slot ${slot} replaced: pid ${old.process.pid ?? "unknown"} -> ${candidate.process.pid ?? "unknown"} ` +
          `(ready in ${Date.now() - forkedAt} ms).`
        );
      }
      console.log(`v1 HTTP cluster rolling replace complete: release=${next.releaseId} in ${Date.now() - startedAt} ms.`);
    } catch (error) {
      replacingSlot = null;
      // Restarts after a failure fork what was running before, not the release that failed.
      useRelease({ ...previous, generation: next.generation + 1 });
      for (let slot = 1; slot <= sizing.resolved_workers; slot += 1) {
        if (!liveWorker(slot, (state) => state.role === "serving")) forkSlot(slot);
      }
      console.error(
        `v1 HTTP cluster rolling replace failed: ${(error as Error).message}; ` +
        `the remaining workers keep release ${previous.releaseId}.`
      );
    }
  };

  let replacing: Promise<void> | null = null;
  let replaceAgain = false;
  process.on("SIGHUP", () => {
    if (stopping) return;
    if (replacing) {
      // `current` may have moved again: run once more when this one ends.
      replaceAgain = true;
      console.log("v1 HTTP cluster rolling replace already running; another follows it.");
      return;
    }
    replacing = (async () => {
      do {
        replaceAgain = false;
        await rollingReplace();
      } while (replaceAgain && !stopping);
    })().finally(() => {
      replacing = null;
    });
  });

  const stopCluster = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    clearInterval(watchdog);
    for (const timer of restartTimers) clearTimeout(timer);
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill(signal);
  };
  process.on("SIGINT", () => stopCluster("SIGINT"));
  process.on("SIGTERM", () => stopCluster("SIGTERM"));
}

startCluster();
