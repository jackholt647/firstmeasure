import { parentPort, workerData } from "node:worker_threads";
import { writeAcquisitionExport } from "./referrals.js";
import { ZipStream } from "./zip-stream.js";

/**
 * Builds the acquisition export on its own thread (started by acquisition-export.ts) and posts the
 * zip to the HTTP thread chunk by chunk. At most MAX_UNACKED chunks are in flight; the zip waits
 * for the HTTP thread to acknowledge them, so a slow download slows the export instead of
 * filling memory.
 */
const MAX_UNACKED = 16;

const port = parentPort;
if (!port) throw new Error("acquisition-export-thread runs as a worker thread.");
const input = (workerData as { input?: Record<string, unknown> } | null)?.input ?? {};

const zip = new ZipStream();
let unacked = 0;
zip.output.on("data", (chunk: Buffer) => {
  const bytes = new Uint8Array(chunk);
  port.postMessage({ type: "data", chunk: bytes }, [bytes.buffer]);
  unacked += 1;
  if (unacked >= MAX_UNACKED) zip.output.pause();
});
zip.output.on("end", () => port.postMessage({ type: "end" }));
port.on("message", (message: { type?: string }) => {
  if (message?.type !== "ack") return;
  unacked -= 1;
  if (unacked < MAX_UNACKED) zip.output.resume();
});

writeAcquisitionExport(input, zip).catch((error) => {
  port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "" });
});
