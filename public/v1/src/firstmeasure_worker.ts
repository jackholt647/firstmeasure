// This process owns FirstMeasure background work without opening an HTTP port.
// Keeping it outside the web cluster means an HTTP worker OOM cannot silently
// remove PDF, delivery, scheduled-release, refund, or cleanup processing.
process.env.FIRSTMEASURE_PROCESS_ROLE = "worker";

const [{ default: Fastify }, { registerFirstMeasureApi }, { env }] = await Promise.all([
  import("fastify"),
  import("../firstmeasure/api.js"),
  import("./config/env.js")
]);

const { validateRuntimeTopology } = await import("./runtime_health.js");
validateRuntimeTopology();

const app = Fastify({
  logger: { level: env.logLevel }
});

await app.register(registerFirstMeasureApi, { prefix: "/v1/firstmeasure" });
await app.ready();

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
    void app.close().finally(() => process.exit(0));
  });
}
