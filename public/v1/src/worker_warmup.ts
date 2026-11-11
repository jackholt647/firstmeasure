import type { FastifyInstance } from "fastify";

import { env } from "./config/env.js";
import { getPostgresPool, isFirstMeasurePostgresEnabled } from "./database/postgres.js";

const WARMUP_LIMIT_MS = 20_000;

// A replacement worker (FM-389) is handed traffic the moment it listens, while the worker
// it replaces retires. It opens its database connections and runs the readiness checks once
// first, so those requests do not queue behind TLS handshakes and cold code paths. A failure
// only logs: the worker still starts, as a worker that was never warmed would.
export async function warmWorker(app: FastifyInstance) {
  const startedAt = Date.now();
  const warm = async () => {
    await app.ready();
    const connections = isFirstMeasurePostgresEnabled()
      ? Math.max(0, Math.min(env.postgresPoolMax, env.webWorkerWarmupConnections))
      : 0;
    if (connections > 0) {
      const pool = getPostgresPool();
      // Held together so the pool opens that many distinct connections.
      const clients = await Promise.allSettled(Array.from({ length: connections }, () => pool.connect()));
      const opened = clients.flatMap((client) => client.status === "fulfilled" ? [client.value] : []);
      try {
        await Promise.all(opened.map((client) => client.query("SELECT 1")));
      } finally {
        for (const client of opened) client.release();
      }
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await app.inject({ method: "GET", url: "/v1/health/ready" });
    }
    return connections;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connections = await Promise.race([
      warm(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`warm-up took longer than ${WARMUP_LIMIT_MS} ms`)), WARMUP_LIMIT_MS);
      })
    ]);
    app.log.info({ ms: Date.now() - startedAt, connections }, "v1 HTTP worker warmed up.");
  } catch (error) {
    app.log.warn({ err: error, ms: Date.now() - startedAt }, "v1 HTTP worker warm-up failed; starting anyway.");
  } finally {
    clearTimeout(timer);
  }
}
