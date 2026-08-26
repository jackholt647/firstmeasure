import { parentPort, workerData } from "node:worker_threads";

type WorkerInput = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

function runSyntheticCpuJob(payload: Record<string, unknown>) {
  const requestedIterations = Math.floor(Number(payload.iterations ?? 8_000_000));
  const requestedDurationMs = Math.floor(Number(payload.duration_ms ?? 0));
  const iterations = Math.max(1, Math.min(250_000_000, requestedIterations));
  const durationMs = Math.max(0, Math.min(120_000, requestedDurationMs));
  const startedAt = Date.now();
  let acc = 0;
  let loops = 0;

  while (loops < iterations || (durationMs > 0 && Date.now() - startedAt < durationMs)) {
    const x = (loops % 100_000) + 1;
    acc += Math.sqrt(x) * Math.sin(x / 97) * Math.cos(x / 193);
    loops += 1;
  }

  const elapsedMs = Date.now() - startedAt;
  return {
    iterations: loops,
    elapsed_ms: elapsedMs,
    iterations_per_second: elapsedMs > 0 ? Math.round((loops / elapsedMs) * 1000) : loops,
    checksum: Math.round(acc * 1_000_000) / 1_000_000,
    worker_pid: process.pid
  };
}

async function runJob(input: WorkerInput) {
  if (input.type === "stress.cpu") {
    return runSyntheticCpuJob(input.payload || {});
  }
  throw new Error(`Unsupported FirstMeasure job type '${input.type}'.`);
}

runJob(workerData as WorkerInput)
  .then((result) => {
    parentPort?.postMessage({ ok: true, result });
  })
  .catch((error) => {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  });
