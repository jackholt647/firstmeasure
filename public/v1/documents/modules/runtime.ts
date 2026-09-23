import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { badRequest } from "../../platform/errors.js";
import { jsonClone } from "../../platform/publication/validation.js";

export type ModuleBroker = {
  read(name: string): Promise<unknown>;
  invoke(name: string, input: unknown): Promise<unknown>;
};
export type ModuleRunInput = {
  source: string;
  inputs: Record<string, unknown>;
  state?: Record<string, unknown>;
  mode: "evaluate" | "command";
  now?: string;
  limits?: Partial<{ milliseconds: number; memoryBytes: number; stackBytes: number; calls: number; bytes: number }>;
};
export type ModuleRunOutput = { outputs: Record<string, unknown>; privateState?: Record<string, unknown>; view?: Record<string, unknown> };

/** No caller-controlled worker source or exec arguments. Guest code only enters QuickJS. */
export async function runModuleCode(input: ModuleRunInput, broker: ModuleBroker): Promise<ModuleRunOutput> {
  if (typeof input.source !== "string" || Buffer.byteLength(input.source) > 128_000) throw badRequest("module_source_limit", "Module source must be at most 128 KB.");
  const limits = {
    milliseconds: Math.min(10_000, Math.max(50, input.limits?.milliseconds ?? 3000)),
    memoryBytes: Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, input.limits?.memoryBytes ?? 16 * 1024 * 1024)),
    stackBytes: Math.min(1024 * 1024, Math.max(64 * 1024, input.limits?.stackBytes ?? 256 * 1024)),
    calls: Math.min(64, Math.max(0, input.limits?.calls ?? 32)),
    bytes: Math.min(2_000_000, Math.max(1024, input.limits?.bytes ?? 1_000_000))
  };
  const payload = jsonClone({ source: input.source, inputs: input.inputs, state: input.state || {}, mode: input.mode, now: input.now || new Date().toISOString(), limits });
  const compiled = new URL("./sandbox-worker.js", import.meta.url);
  const source = new URL("./sandbox-worker.ts", import.meta.url);
  const isCompiled = existsSync(fileURLToPath(compiled));
  // tsx registers inside the worker in source/test mode; production uses compiled JS.
  const worker = isCompiled
    ? new Worker(compiled, { workerData: payload })
    : new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)}))`, { eval: true, workerData: payload });
  return await new Promise<ModuleRunOutput>((resolve, reject) => {
    let finished = false;
    let calls = 0;
    let pending = 0;
    let pendingActions = 0;
    let guestReturned = false;
    let candidate: ModuleRunOutput | undefined;
    let lateFailure: Error | undefined;
    const finish = (error?: Error, result?: ModuleRunOutput) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(pendingActions
      ? badRequest("module_effect_uncertain", "Module deadline elapsed with an action in progress; inspect action receipts before retrying.")
      : badRequest("module_deadline", "Module execution exceeded its time limit.")), limits.milliseconds + 1500);
    const drain = () => { if (guestReturned && pending === 0) finish(lateFailure, candidate); };
    const failedWorker = (error: Error) => finish(pendingActions
      ? badRequest("module_effect_uncertain", "Module worker failed with an action in progress; inspect action receipts before retrying.")
      : error);
    worker.on("error", failedWorker);
    worker.on("exit", code => { if (!finished && !guestReturned) failedWorker(badRequest("module_worker_exit", `Module worker exited before completing (${code}).`)); });
    worker.on("message", async message => {
      if (finished) return;
      if (message.type === "result") {
        try { candidate = jsonClone(message.value, limits.bytes); guestReturned = true; drain(); } catch (error) { failedWorker(error as Error); }
      } else if (message.type === "error") finish(badRequest(pendingActions ? "module_effect_uncertain" : "module_execution_failed", pendingActions ? "Module failed with an action in progress; inspect action receipts before retrying." : String(message.message).slice(0, 1000)));
      else if (message.type === "call") {
        if (guestReturned) return;
        pending++;
        if (message.kind === "invoke") pendingActions++;
        try {
          if (++calls > limits.calls) throw new Error("Module capability call limit exceeded.");
          if (typeof message.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(message.name)) throw new Error("Invalid binding name.");
          const result = message.kind === "read" ? await broker.read(message.name)
            : message.kind === "invoke" ? await broker.invoke(message.name, jsonClone(message.input, limits.bytes))
            : (() => { throw new Error("Unknown capability."); })();
          if (!finished && !guestReturned) worker.postMessage({ type: "reply", id: message.id, value: jsonClone(result, limits.bytes) });
        } catch (error) {
          if (guestReturned) lateFailure = error instanceof Error ? error : new Error("An unawaited capability failed.");
          else if (!finished) worker.postMessage({ type: "reply", id: message.id, error: error instanceof Error ? error.message.slice(0, 1000) : "Capability failed." });
        } finally {
          pending--;
          if (message.kind === "invoke") pendingActions--;
          drain();
        }
      }
    });
  });
}
