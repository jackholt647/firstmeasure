import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The config library never keeps a process alive (2026-10-28: dev's cluster primary stayed up after SIGTERM until
// systemd killed it, because importing the app had started the library's store sync and opened the database).
// Importing the app, as the cluster primary does, must not start the sync; a started sync's poll is unref'd and
// stops when the app closes.
const dir = await mkdtemp(path.join(os.tmpdir(), "config-library-shutdown-"));
const environment = { ...process.env, NODE_ENV: "test", FIRSTMEASURE_DATA_ENVIRONMENT: "development", CONFIG_LIBRARY_SOURCE: "store", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), INTERNAL_STORAGE_ROOT: path.join(dir, "internal"), PLATFORM_HEARTBEAT_DISABLED: "1" };
after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

function run(code: string) {
  return new Promise<{ code: number | null; ms: number; out: string }>((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--experimental-sqlite", "--import", "tsx", "--input-type=module", "-e", code], { cwd: path.resolve(import.meta.dirname, ".."), env: environment });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", (exitCode) => { clearTimeout(kill); resolve({ code: exitCode, ms: Date.now() - started, out }); });
  });
}

test("importing the app and reading the library never starts the store sync", async () => {
  const result = await run(`
    await import("./src/app.ts");
    const library = await import("./config-library/library.ts");
    library.libraryEntries("capability_defaults"); library.libraryData("terminology_namespace", "scope");
    console.log(JSON.stringify(library.librarySyncState()));`);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /\{"started":false,"polling":false,"holdsProcess":false\}/);
});

test("a started sync's poll never holds the process open, and the process ends on its own", async () => {
  const result = await run(`
    const library = await import("./config-library/library.ts");
    await library.startLibrarySync();
    console.log(JSON.stringify(library.librarySyncState()));
    const { closeSqlStores } = await import("./platform/sql_store.ts");
    await closeSqlStores();`);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /\{"started":true,"polling":true,"holdsProcess":false\}/);
  assert.ok(result.ms < 30_000, `exited after ${result.ms} ms`);
});
