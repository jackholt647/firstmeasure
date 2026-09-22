import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";

test("standalone platform worker starts, exposes local health, and drains before restart", { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-worker-runtime-"));
  const providerFile = path.join(root, "providers.json");
  await writeFile(providerFile, "{}");
  let child: ChildProcess | undefined;
  t.after(async () => { if (child && child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const url = process.env.TEST_POSTGRES_URL || "";
  const environment = { ...process.env, FIRSTMATE_ENV: "test", NODE_ENV: "test", DEPLOYMENT_TOPOLOGY: "single",
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "sqlite", DATABASE_URL: url, DATABASE_ADMIN_URL: url,
    POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false", PROVIDER_KEYS_PATH: providerFile,
    PLATFORM_WORKER_PORT: "0", V1_LOG_LEVEL: "error", PLATFORM_STORAGE_ROOT: path.join(root, "platform"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite"),
    INTERNAL_STORAGE_ROOT: path.join(root, "internal"), CRM_STORAGE_ROOT: path.join(root, "crm"),
    EMAIL_OUTBOUND_DISABLED: "1", CUSTOMER_CALL_WORKER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" };
  for (let attempt = 0; attempt < 2; attempt++) {
    let output = "";
    const compiled = process.env.TEST_COMPILED_PLATFORM_WORKER === "1";
    child = fork(compiled ? "dist/src/platform_worker.js" : "src/platform_worker.ts", [], {
      execArgv: compiled ? ["--experimental-sqlite"] : ["--experimental-sqlite", "--import", "tsx"], env: environment, silent: true
    });
    child.stdout!.on("data", data => { output += String(data); });
    child.stderr!.on("data", data => { output += String(data); });
    const exited = new Promise<number | null>(resolve => child!.once("exit", resolve));
    const ready = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker failed to become ready: ${output}`)), 15000);
      child!.once("error", error => { clearTimeout(timer); reject(error); });
      child!.once("exit", code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${output}`)); });
      child!.on("message", (message: any) => { if (message?.type === "platform-worker-ready") { clearTimeout(timer); resolve(message); } });
    });
    const base = `http://127.0.0.1:${ready.address.port}`;
    assert.equal(ready.address.address, "127.0.0.1");
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
    assert.equal((await fetch(`${base}/v1/platform/organizations`)).status, 404);
    child.send({ type: "shutdown" });
    assert.equal(await exited, 0, output);
    assert.doesNotMatch(output, /Platform task failed|shutdown failed/);
  }
});
