import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

let running = 0;

/** Whether an export is being built in this process (one at a time: each holds a few hundred MB). */
export function acquisitionExportRunning() {
  return running > 0;
}

/**
 * The acquisition export as a stream of zip bytes, built on a worker thread. Its reads are
 * synchronous SQLite queries over every row; on production's referrals database, larger than the
 * compatibility host's page cache, they held the HTTP thread for over 30 seconds and the cluster
 * watchdog killed the worker mid-request (FM-393). Here the HTTP thread only passes chunks on.
 */
export function acquisitionExportStream(input: Record<string, unknown>, onError: (error: Error) => void) {
  const output = new PassThrough();
  const compiled = new URL("./acquisition-export-thread.js", import.meta.url);
  const source = new URL("./acquisition-export-thread.ts", import.meta.url);
  // A production-sized export peaks near 250 MB of heap; past the cap the thread fails, not the host.
  const options = { workerData: { input }, resourceLimits: { maxOldGenerationSizeMb: 1024 } };
  // tsx registers inside the worker in source/test mode; production uses compiled JS.
  const worker = existsSync(fileURLToPath(compiled))
    ? new Worker(compiled, options)
    : new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)}))`, { ...options, eval: true });
  running += 1;
  let settled = false;
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    running -= 1;
    if (error) {
      onError(error);
      output.destroy(error);
    } else {
      output.end();
    }
    void worker.terminate();
  };

  let owed = 0;
  output.on("drain", () => {
    for (; owed > 0; owed -= 1) worker.postMessage({ type: "ack" });
  });
  worker.on("message", (message: { type?: string; chunk?: Uint8Array; message?: string; stack?: string }) => {
    if (settled) return;
    if (message?.type === "data" && message.chunk) {
      if (output.write(Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength))) worker.postMessage({ type: "ack" });
      else owed += 1;
    } else if (message?.type === "end") {
      settle();
    } else if (message?.type === "error") {
      const error = new Error(String(message.message || "The acquisition export failed."));
      if (message.stack) error.stack = message.stack;
      settle(error);
    }
  });
  worker.on("error", (error) => settle(error));
  worker.on("exit", () => settle(new Error("The acquisition export stopped before it finished.")));
  // The download was closed: stop reading.
  output.on("close", () => {
    if (settled) return;
    settled = true;
    running -= 1;
    void worker.terminate();
  });
  return output;
}
