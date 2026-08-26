import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyPluginAsync } from "fastify";

const v1Root = process.cwd();

export const rootRoutes: FastifyPluginAsync = async (app) => {
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
