import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadDeploymentEnv } from "./production_preflight.mjs";

const v1Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(v1Root, "dist", "src", "server.js");
if (!existsSync(entrypoint)) throw new Error("Compiled server is missing after production preparation.");

const loaded = await loadDeploymentEnv(v1Root);
const environment = {
  ...loaded,
  NODE_ENV: loaded.NODE_ENV || "production",
  FIRSTMATE_ENV: loaded.FIRSTMATE_ENV || "production",
  V1_PORT: loaded.V1_PORT || "3101"
};
const port = Number(environment.V1_PORT);
const timeoutMs = Math.max(60_000, Number(environment.FIRSTMEASURE_STARTUP_TIMEOUT_MS || 30 * 60_000));
const healthUrl = `http://127.0.0.1:${port}/v1/health/ready`;

const child = spawn(process.execPath, ["--experimental-sqlite", entrypoint], {
  cwd: v1Root,
  env: environment,
  stdio: "inherit"
});

let exitResult = null;
let resolveChildExit;
const childExit = new Promise((resolve) => {
  resolveChildExit = resolve;
});
child.once("exit", (code, signal) => {
  exitResult = { code, signal };
  resolveChildExit(exitResult);
});
child.once("error", (error) => {
  process.stderr.write(`FirstMeasure server process failed: ${error.message}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

const startedAt = Date.now();
let healthy = false;
while (!healthy && !exitResult && Date.now() - startedAt < timeoutMs) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
    healthy = response.ok;
  } catch {
    // Startup includes the guarded PostgreSQL import, so a closed port is expected here.
  }
  if (!healthy && !exitResult) await new Promise((resolve) => setTimeout(resolve, 2_000));
}

if (!healthy) {
  if (!child.killed && !exitResult) child.kill("SIGTERM");
  throw new Error(exitResult
    ? `FirstMeasure server exited before becoming healthy (code=${exitResult.code}, signal=${exitResult.signal}).`
    : `FirstMeasure server did not become healthy within ${timeoutMs}ms.`);
}

process.stdout.write(`FirstMeasure is healthy on port ${port}.\n`);
const monitorIntervalMs = Math.max(5_000, Number(environment.V1_HEALTH_MONITOR_INTERVAL_MS || 15_000));
const monitorFailureLimit = Math.max(2, Number(environment.V1_HEALTH_MONITOR_FAILURE_LIMIT || 3));
let consecutiveHealthFailures = 0;
let forcedRestart = false;
let forwardingSignal = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    forwardingSignal = true;
  });
}

while (!exitResult) {
  await Promise.race([
    new Promise((resolve) => setTimeout(resolve, monitorIntervalMs)),
    childExit
  ]);
  if (exitResult || forwardingSignal) continue;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    consecutiveHealthFailures = response.ok ? 0 : consecutiveHealthFailures + 1;
  } catch {
    consecutiveHealthFailures += 1;
  }
  if (consecutiveHealthFailures < monitorFailureLimit) continue;

  forcedRestart = true;
  process.stderr.write(
    `FirstMeasure failed ${consecutiveHealthFailures} consecutive runtime health checks; ` +
    "terminating the server so the service supervisor can restart it.\n"
  );
  if (!child.killed) child.kill("SIGTERM");
  break;
}

if (forcedRestart && !exitResult) {
  const exitedGracefully = await Promise.race([
    childExit.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000))
  ]);
  if (!exitedGracefully && !exitResult) {
    process.stderr.write("FirstMeasure did not stop after SIGTERM; forcing the unhealthy process to exit.\n");
    child.kill("SIGKILL");
  }
}

const final = exitResult || await childExit;
if (forcedRestart) {
  process.exitCode = 1;
} else if (final.signal) {
  process.kill(process.pid, final.signal);
} else {
  process.exitCode = Number(final.code || 0);
}
