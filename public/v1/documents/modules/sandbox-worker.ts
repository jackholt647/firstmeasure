import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS, type QuickJSHandle } from "quickjs-emscripten";

const port = parentPort!;
const input = workerData;
const engine = await getQuickJS();
const runtime = engine.newRuntime();
runtime.setMemoryLimit(input.limits.memoryBytes);
runtime.setMaxStackSize(input.limits.stackBytes);
const deadline = Date.now() + input.limits.milliseconds;
runtime.setInterruptHandler(() => Date.now() > deadline);
runtime.setModuleLoader(() => { throw new Error("Module imports are disabled."); });
const context = runtime.newContext();
let disposed = false;
let nextId = 0;
const pending = new Map<number, ReturnType<typeof context.newPromise>>();
let executionPromise: QuickJSHandle | undefined;
const pump = () => {
  if (disposed) return;
  const result = runtime.executePendingJobs(100);
  if (result.error) { const message = String(context.dump(result.error)); result.error.dispose(); fail(message); }
  else if (runtime.hasPendingJob()) setImmediate(pump);
};
function fail(message: string) { if (!disposed) port.postMessage({ type: "error", message }); }
const bridge = context.newFunction("capability", (kind, name, json) => {
  if (pending.size >= input.limits.calls) throw new Error("Too many pending capability calls.");
  const id = ++nextId;
  const deferred = context.newPromise();
  pending.set(id, deferred);
  port.postMessage({ type: "call", id, kind: context.getString(kind), name: context.getString(name), input: JSON.parse(context.getString(json)) });
  return deferred.handle;
});
context.setProp(context.global, "__capability", bridge);
bridge.dispose();
const argument = context.newString(JSON.stringify({ inputs: input.inputs, state: input.state, now: input.now, mode: input.mode }));
context.setProp(context.global, "__input", argument);
argument.dispose();
port.on("message", message => {
  if (disposed || message.type !== "reply") return;
  const deferred = pending.get(message.id);
  if (!deferred) return;
  pending.delete(message.id);
  const handle = context.newString(message.error ? String(message.error) : JSON.stringify(message.value));
  if (message.error) deferred.reject(handle); else deferred.resolve(handle);
  handle.dispose();
  deferred.dispose();
  pump();
});
try {
  // Serialization occurs in the guest under its CPU/heap budget. No host objects cross.
  const setup = context.evalCode(`
    globalThis.__runInput = JSON.parse(__input); delete globalThis.__input;
    globalThis.api = Object.freeze({
      data: Object.freeze({ read: async name => JSON.parse(await __capability('read', name, 'null')) }),
      actions: Object.freeze({ invoke: async (name, value) => JSON.parse(await __capability('invoke', name, JSON.stringify(value))) }),
      now: __runInput.now, mode: __runInput.mode
    });
    globalThis.Date = undefined; Math.random = () => { throw new Error('Use captured inputs instead of ambient randomness.'); };
  `);
  context.unwrapResult(setup).dispose();
  const evaluated = context.evalCode(`(async () => { 'use strict'; const inputs = __runInput.inputs; const state = __runInput.state;
    const run = async () => { ${input.source}\n };
    const value = await run();
    function check(v, seen = new Set(), depth = 0) {
      if (depth > 64) throw new Error('Output nesting limit exceeded.');
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
      if (typeof v !== 'object' || seen.has(v)) throw new Error('Output must be finite JSON without cycles.');
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Output must contain plain objects.');
      seen.add(v); for (const [k, child] of Object.entries(v)) { if (['__proto__','constructor','prototype'].includes(k)) throw new Error('Reserved output key.'); check(child, seen, depth + 1); } seen.delete(v);
    }
    check(value); const json = JSON.stringify(value); if (json.length > ${input.limits.bytes}) throw new Error('Output size limit exceeded.'); return json;
  })()`, "document-module.js");
  if (evaluated.error) { const error = context.dump(evaluated.error); evaluated.error.dispose(); throw new Error(typeof error === "object" && error ? String(error.message || error) : String(error)); }
  executionPromise = evaluated.value;
  const resolved = context.resolvePromise(executionPromise);
  pump();
  const result = await resolved;
  if (result.error) { const error = context.dump(result.error); result.error.dispose(); throw new Error(typeof error === "object" && error ? String(error.message || error) : String(error)); }
  const value = result.value;
  port.postMessage({ type: "result", value: JSON.parse(context.getString(value)) });
  value.dispose();
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
finally {
  disposed = true;
  for (const deferred of pending.values()) deferred.dispose();
  pending.clear();
  executionPromise?.dispose();
  context.dispose(); runtime.dispose(); port.close();
}
