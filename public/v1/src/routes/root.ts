import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyPluginAsync } from "fastify";

import { inspectRuntimeReadiness, runtimeIdentity } from "../runtime_health.js";

const v1Root = process.cwd();

export const rootRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/health/live", async () => ({
    ok: true,
    state: "live",
    ...runtimeIdentity(),
    checked_at: new Date().toISOString()
  }));

  app.get("/v1/health/ready", async (_request, reply) => {
    const readiness = await inspectRuntimeReadiness();
    if (!readiness.ok) reply.code(503);
    return readiness;
  });

  app.get("/v1", async () => {
    return {
      ok: true,
      service: "v1-host",
      mountedApis: ["firstmeasure", "platform"]
    };
  });

  app.get("/v1/test-client.html", async (_request, reply) => {
    const htmlPath = path.join(v1Root, "test-client.html");
    const html = await readFile(htmlPath, "utf8");
    reply.type("text/html; charset=utf-8");
    return html;
  });
};
