import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import EmbeddedPostgres from "embedded-postgres";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 55432;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const port = await availablePort();
const databaseDir = path.resolve(".tmp", `embedded-postgres-${process.pid}`);
const user = "postgres";
const password = "firstmeasure-local-test";
const database = "firstmeasure_test";
const postgres = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: false,
  onLog: () => undefined,
  onError: (value) => process.stderr.write(`[embedded-postgres] ${String(value)}\n`)
});

let exitCode = 1;
try {
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase(database);
  const databaseUrl = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  const testFiles = process.argv.slice(2);
  const child = spawn(process.execPath, [
    "--import", "tsx", "--test", "--test-concurrency=1", "--test-force-exit", ...(testFiles.length ? testFiles : ["tests/firstmeasure-postgres.test.ts"])
  ], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_POSTGRES_URL: databaseUrl },
    stdio: "inherit"
  });
  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`PostgreSQL test exited with ${signal}.`)) : resolve(code ?? 1));
  });
} finally {
  await Promise.race([
    postgres.stop().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 10_000))
  ]);
  await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
}

process.exit(exitCode);
