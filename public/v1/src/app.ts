import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { IncomingHttpHeaders } from "node:http";

import { registerCanvassingApi } from "../canvassing/api.js";
import { registerCommunicationsApi } from "../communications/api.js";
import { registerCodeReportsApi } from "../code-reports/api.js";
import { registerCrmApi } from "../internal/crm/api.js";
import { registerFirstMeasureApi } from "../firstmeasure/api.js";
import { registerFirstMeasureRemoteApi } from "../firstmeasure-remote/api.js";
import { registerEmailApi } from "../email/api.js";
import { registerInternalApi } from "../internal/api.js";
import { installDiagnostics } from "../internal/diagnostics.js";
import { registerLeadIntakeApi } from "../lead-intake/api.js";
import { registerLaborApi } from "../labor/api.js";
import { registerMaterialsApi } from "../materials/api.js";
import { registerPaymentsApi } from "../payments/api.js";
import { registerPlatformApi } from "../platform/api.js";
import { registerProposalsApi } from "../proposals/api.js";
import { registerPublicFirstMeasureApi } from "../public-firstmeasure/api.js";
import { registerWeatherApi } from "../weather/api.js";
import { env } from "./config/env.js";
import { devConsoleRoutes } from "./routes/dev_console.js";
import { rootRoutes } from "./routes/root.js";

export async function buildApp() {
  const app = Fastify({
    bodyLimit: 128 * 1024 * 1024,
    logger: {
      level: env.logLevel
    }
  });
  installDiagnostics(app);

  if (env.clusterNodeRole === "legacy" && env.legacyProxySecret) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith("/v1/health/")) return;
      if (request.url.split("?", 1)[0] === "/v1/platform/auth/session") return;
      if (String(request.headers["x-firstmeasure-legacy-proxy"] ?? "") !== env.legacyProxySecret) {
        return reply.code(403).send({ ok: false, error: "legacy_proxy_required" });
      }
    });
  }

  void app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization", "Idempotency-Key", "Cache-Control", "Pragma", "X-Requested-With", "X-Platform-CSRF", "X-CSRF-Token", "X-FirstMeasure-Debug", "X-Internal-User-Email", "X-Internal-User-Name", "X-Internal-User-Role", "X-Internal-User-Department"],
    exposedHeaders: ["X-FirstMeasure-Debug-Trace"]
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (error) {
      done(error as Error);
    }
  });

  if (!app.hasContentTypeParser("multipart/form-data")) {
    await app.register(multipart, {
      limits: {
        fileSize: 128 * 1024 * 1024,
        files: 8,
        fields: 64
      }
    });
  }

  try {
    const { default: compress } = await import("@fastify/compress");
    await app.register(compress, {
      global: true,
      encodings: ["br", "gzip", "deflate"],
      threshold: 1024
    });
  } catch (error) {
    app.log.warn({ err: error }, "Response compression is unavailable; continuing without it.");
  }

  void app.register(devConsoleRoutes);
  void app.register(rootRoutes);
  void app.register(registerCanvassingApi, { prefix: "/v1/canvassing" });
  void app.register(registerCodeReportsApi, { prefix: "/v1/code-reports" });
  const proxyLegacyState = env.deploymentTopology === "cluster" && env.clusterNodeRole === "web" && Boolean(env.legacyServiceUrl);
  if (proxyLegacyState) {
    const { default: httpProxy } = await import("@fastify/http-proxy");
    const proxyOptions = (prefix: string) => ({
      upstream: env.legacyServiceUrl,
      prefix,
      rewritePrefix: prefix,
      http2: false as const,
      replyOptions: {
        rewriteRequestHeaders: (_request: unknown, headers: IncomingHttpHeaders) => ({
          ...headers,
          "x-firstmeasure-legacy-proxy": env.legacyProxySecret
        })
      }
    });
    void app.register(httpProxy, proxyOptions("/v1/communications"));
    void app.register(httpProxy, proxyOptions("/v1/internal"));
  } else {
    void app.register(registerCommunicationsApi, { prefix: "/v1/communications" });
    void app.register(registerCrmApi, { prefix: "/v1/internal/crm" });
    void app.register(registerInternalApi, { prefix: "/v1/internal" });
  }
  void app.register(registerEmailApi, { prefix: "/v1/email" });
  void app.register(registerFirstMeasureApi, { prefix: "/v1/firstmeasure" });
  void app.register(registerFirstMeasureRemoteApi, { prefix: "/v1/firstmeasure-remote" });
  void app.register(registerLeadIntakeApi, { prefix: "/v1/lead-intake" });
  void app.register(registerLaborApi, { prefix: "/v1/labor" });
  void app.register(registerMaterialsApi, { prefix: "/v1/materials" });
  void app.register(registerPaymentsApi, { prefix: "/v1/payments" });
  void app.register(registerPlatformApi, { prefix: "/v1/platform" });
  void app.register(registerProposalsApi, { prefix: "/v1/proposals" });
  void app.register(registerPublicFirstMeasureApi, { prefix: "/v1/public/firstmeasure" });
  void app.register(registerWeatherApi, { prefix: "/v1/weather" });

  return app;
}
