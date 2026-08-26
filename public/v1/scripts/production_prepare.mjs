import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadDeploymentEnv, runProductionPreflight } from "./production_preflight.mjs";

const v1Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = await loadDeploymentEnv(v1Root);

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: v1Root,
    env: { ...environment, ...extraEnv },
    stdio: "inherit",
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}.`);
}

function runNpm(args) {
  const npmEntrypoint = String(environment.npm_execpath || "").trim();
  if (npmEntrypoint && existsSync(npmEntrypoint)) {
    run(process.execPath, [npmEntrypoint, ...args]);
    return;
  }
  if (process.platform === "win32") {
    const command = ["npm.cmd", ...args].join(" ");
    run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command]);
    return;
  }
  run("npm", args);
}

function assertReport(report, phase) {
  if (report.ok) return;
  const failed = report.checks.filter((entry) => !entry.ok).map((entry) => entry.name).join(", ");
  throw new Error(`Production ${phase} preflight failed: ${failed}. Run npm run preflight for details.`);
}

const offline = await runProductionPreflight({ v1Root, envOverrides: environment, checkDatabase: false });
assertReport(offline, "offline");

const lockPath = path.join(v1Root, "package-lock.json");
const lockHash = createHash("sha256").update(await readFile(lockPath)).digest("hex");
const markerPath = path.join(v1Root, "node_modules", ".firstmeasure-package-lock.sha256");
const installedHash = existsSync(markerPath) ? String(await readFile(markerPath, "utf8")).trim() : "";
const dependenciesPresent = existsSync(path.join(v1Root, "node_modules", "pg"))
  && existsSync(path.join(v1Root, "node_modules", "google-auth-library"))
  && existsSync(path.join(v1Root, "node_modules", "typescript", "bin", "tsc"));

if (environment.FIRSTMEASURE_SKIP_DEPENDENCY_INSTALL !== "1" && (!dependenciesPresent || installedHash !== lockHash)) {
  runNpm(["ci", "--include=dev"]);
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${lockHash}\n`, { encoding: "utf8", mode: 0o600 });
}

runNpm(["run", "build", "--ignore-scripts"]);

if (environment.FIRSTMEASURE_PREFLIGHT_OFFLINE !== "1") {
  const online = await runProductionPreflight({ v1Root, envOverrides: environment, checkDatabase: true });
  assertReport(online, "database");
}

process.stdout.write("FirstMeasure production preparation complete.\n");
