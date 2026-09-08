// This process owns FirstMeasure background work without opening an HTTP port.
// Keeping it outside the web cluster means an HTTP worker OOM cannot silently
// remove PDF, delivery, scheduled-release, refund, or cleanup processing.
process.env.FIRSTMEASURE_PROCESS_ROLE = "worker";

const [{ default: Fastify }, { registerFirstMeasureApi }, { env }] = await Promise.all([
  import("fastify"),
  import("../firstmeasure/api.js"),
  import("./config/env.js")
]);

const { validateRuntimeTopology, inspectRuntimeReadiness } = await import("./runtime_health.js");
validateRuntimeTopology();
const readiness = await inspectRuntimeReadiness({ fresh: true });
if (!readiness.ok) throw new Error(`Worker dependency preflight failed: ${readiness.error || JSON.stringify(readiness.checks)}`);

const app = Fastify({
  logger: { level: env.logLevel }
});

await app.register(registerFirstMeasureApi, { prefix: "/v1/firstmeasure" });
await app.ready();
const { stopFirstMeasureJobRuntime } = await import("../firstmeasure/job_runtime.js");
const { startWorkerSupervision } = await import("./worker_supervision.js");
const stopSupervision = await startWorkerSupervision();

app.log.info({
  pid: process.pid,
  jobWorkers: env.firstmeasureJobWorkers
}, "FirstMeasure dedicated background worker is ready.");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "Stopping FirstMeasure dedicated background worker.");
    // Leave time for systemd's 60-second stop deadline. If draining cannot
    // finish, the next process recovers the remaining job after lease expiry.
    const deadline = setTimeout(() => process.exit(1), 55_000);
    deadline.unref();
    void stopFirstMeasureJobRuntime().then(async (drained) => {
      if (!drained) app.log.warn("Worker drain deadline reached; outstanding leases will recover after expiry.");
      await app.close();
      stopSupervision();
      process.exit(0);
    }).catch((error) => {
      app.log.error(error, "Worker shutdown failed.");
      process.exit(1);
    });
  });
}
