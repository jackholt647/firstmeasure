// Platform automation runs separately from FirstMeasure report workers and HTTP replicas.
// Import configuration only after selecting the process role.
process.env.PLATFORM_PROCESS_ROLE = "worker";

const [{ default: Fastify }, { env }, { runPlatformTask }] = await Promise.all([
  import("fastify"), import("./config/env.js"), import("../platform/worker_tasks.js")
]);
const { validateRuntimeTopology, inspectRuntimeReadiness } = await import("./runtime_health.js");
validateRuntimeTopology();
const readiness = await inspectRuntimeReadiness({ fresh: true });
if (!readiness.ok) throw new Error(`Platform worker dependencies are unavailable: ${readiness.error || "readiness check failed"}`);

// Initialize shared core schemas before a platform transaction borrows the
// bounded pool. This also works with one connection per process.
const { isFirstMeasurePostgresEnabled } = await import("./database/postgres.js");
if (isFirstMeasurePostgresEnabled()) {
  const { ensurePostgresPlatformStorage } = await import("../platform/storage_postgres.js");
  await ensurePostgresPlatformStorage();
}
const app = Fastify({ logger: { level: env.logLevel } });
const [work, payroll, channels, agents, appointments, stats, sms, calls] = await Promise.all([
  import("../work/scheduler.js"), import("../payroll/service.js"), import("../channels/service.js"),
  import("../channels/agent.js"), import("../appointments/service.js"), import("../stats/sync.js"),
  import("../messaging/delivery_worker.js"), import("../comms/calls/worker.js")
]);
// Voice and SMS already have item-level durable claims; their short polling loops
// remain responsive while reporting or an automation is doing longer work.
await Promise.all([import("../assistant/agent/definition.js"), import("../stats/agent/definition.js"), import("../scopes/agent/definition.js"), import("../insights/definition.js")]);
calls.startCallWorker(app);
sms.startSmsDeliveryWorker();

const jobs: Array<{ name: string; interval: number; run: () => Promise<unknown> }> = [
  { name: "payroll-outbox", interval: 2000, run: () => payroll.drainPayrollWorkEvents() },
  { name: "work-scheduler", interval: 5000, run: () => work.runWorkSchedulerTick() },
  { name: "scheduled-messages", interval: 15000, run: () => channels.deliverAllDueScheduledMessages() },
  { name: "appointment-confirmations", interval: 60000, run: () => appointments.runConfirmationTick() },
  { name: "reporting", interval: 10000, run: () => stats.runStatsSchedulerTick() },
  { name: "agent-jobs", interval: 1000, run: () => agents.drainChannelAgentJobs() },
  { name: "agent-awaits", interval: 60000, run: () => agents.sweepAgentAwaits() },
  { name: "agent-schedules", interval: 60000, run: () => agents.sweepAgentSchedules() }
];
let stopping = false;
let lastTickAt = Date.now();
const active = new Map<string, Promise<unknown>>();
function tick() {
  if (stopping) return;
  lastTickAt = Date.now();
  // Small independent lanes: a long report rebuild cannot stop the work queue.
  for (const job of jobs) {
    if (active.has(job.name)) continue;
    const running = runPlatformTask(job.name, job.interval, () => job.run())
      .catch(error => app.log.error({ error, task: job.name }, "Platform task failed"))
      .finally(() => active.delete(job.name));
    active.set(job.name, running);
  }
}
app.get("/health/live", async (_request, reply) => {
  const ok = !stopping && Date.now() - lastTickAt < 30000;
  return reply.code(ok ? 200 : 503).send({ ok, role: "platform-worker", pid: process.pid });
});
app.get("/health/ready", async (_request, reply) => {
  const dependencies = await inspectRuntimeReadiness();
  const ok = !stopping && dependencies.ok && Date.now() - lastTickAt < 30000;
  return reply.code(ok ? 200 : 503).send({ ...dependencies, ok, role: "platform-worker", active_tasks: [...active.keys()] });
});
// The worker has no public application routes. Bind monitoring to loopback.
await app.listen({ host: "127.0.0.1", port: Number(process.env.PLATFORM_WORKER_PORT ?? 3122) });
const timer = setInterval(tick, 1000);
tick();
app.log.info({ pid: process.pid, tasks: jobs.map(job => job.name) }, "Dedicated platform worker is ready");
process.send?.({ type: "platform-worker-ready", address: app.server.address() });

function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 55000);
  deadline.unref();
  void (async () => {
    await Promise.allSettled([...active.values(), sms.stopSmsDeliveryWorker(), app.close()]);
    await (await import("../platform/sql_store.js")).closeSqlStores();
    const { closePostgresPools } = await import("./database/postgres.js");
    await closePostgresPools();
    process.exit(0);
  })().catch(error => { app.log.error(error, "Platform worker shutdown failed"); process.exit(1); });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
process.on("message", message => { if ((message as { type?: string })?.type === "shutdown") stop(); });
