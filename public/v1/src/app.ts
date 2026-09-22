import { registerWorkforceApi } from "../workforce/api.js";
import { registerWorkApi } from "../work/api.js";
import { registerWebsitesApi } from "../websites/api.js";
import { registerTrainingApi } from "../training/api.js";
import { registerStatsApi } from "../stats/api.js";
import { registerSignupSandboxApi } from "../signup-sandbox/api.js";
import { registerScopesApi } from "../scopes/api.js";
import { registerRoutingApi } from "../routing/api.js";
import { registerPublicLinksApi } from "../public-links/api.js";
import { registerPayrollApi } from "../payroll/api.js";
import { registerMessagingApi } from "../messaging/api.js";
import { registerFinancialsApi } from "../financials/api.js";
import { registerFeedbackApi } from "../feedback/api.js";
import { registerEquipmentApi } from "../equipment/api.js";
import { registerDomainsApi } from "../domains/api.js";
import { registerDocumentsApi } from "../documents/api.js";
import { registerConnectionsApi } from "../connections/api.js";
import { registerCommsApi } from "../comms/api.js";
import { registerChatApi } from "../chat/api.js";
import { registerChannelsApi } from "../channels/api.js";
import { registerCallsApi } from "../calls/api.js";
import { registerAssistantApi } from "../assistant/api.js";
import { registerAppointmentsApi } from "../appointments/api.js";
import { registerAgentsApi } from "../agents/api.js";
import { registerAudioNotesApi } from "../audio-notes/api.js";
import { installFullHouseAccess } from '../firstmeasure/full_house.js';
import cors from "@fastify/cors";
import { installStaffTracking } from "../staff_tracking/api.js";
import multipart from "@fastify/multipart";
import type { FastifyReplyFromHooks } from "@fastify/reply-from";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { IncomingHttpHeaders } from "node:http";

import { registerCanvassingApi } from "../canvassing/api.js";
import { registerCommunicationsApi } from "../communications/api.js";
import { registerCodeReportsApi } from "../code-reports/api.js";
import { registerPlatformCallListApi } from "../internal/crm/platform_call_list_api.js";
import { registerCrmApi } from "../internal/crm/api.js";
import { referralServiceRoutes } from "../internal/crm/referrals_service.js";
import { registerFirstMeasureApi } from "../firstmeasure/api.js";
import { installPricingContext } from "../firstmeasure/pricing_config.js";
import { registerPricingAdmin } from "../firstmeasure/pricing_admin.js";
import { registerFirstMeasureRemoteApi } from "../firstmeasure-remote/api.js";
import { registerEmailApi } from "../email/api.js";
import { registerInternalApi } from "../internal/api.js";
import { installDiagnostics } from "../internal/diagnostics.js";
import { registerLeadIntakeApi } from "../lead-intake/api.js";
import { registerLaborApi } from "../labor/api.js";
import { registerMaterialsApi } from "../materials/api.js";
import { registerPaymentsApi } from "../payments/api.js";
import { registerPlatformApi } from "../platform/api.js";
import { registerMobileApi } from "../mobile/api.js";
import { registerProposalsApi } from "../proposals/api.js";
import { registerPublicFirstMeasureApi } from "../public-firstmeasure/api.js";
import { registerWeatherApi } from "../weather/api.js";
import { env } from "./config/env.js";
import { devConsoleRoutes } from "./routes/dev_console.js";
import { rootRoutes } from "./routes/root.js";

export function legacyProxyReplyOptions(
  request: Pick<FastifyRequest, "body" | "headers">,
  options: FastifyReplyFromHooks
): FastifyReplyFromHooks {
  const rawContentType = request.headers["content-type"];
  const contentType = String(Array.isArray(rawContentType) ? rawContentType[0] ?? "" : rawContentType ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return options;
  if (!request.body || typeof request.body !== "object" || Buffer.isBuffer(request.body)) return options;

  // The application-wide form parser has already converted the payload into an
  // object before @fastify/http-proxy sees it. Passing that object implicitly
  // makes reply-from treat it as raw form bytes and Buffer.byteLength throws.
  // Supplying it as an explicit body makes reply-from JSON-encode it and update
  // the upstream content type, which the compatibility API accepts.
  return { ...options, contentType: undefined, body: request.body };
}

export async function buildApp() {
  const app = Fastify({
    bodyLimit: 128 * 1024 * 1024,
    logger: {
      level: env.logLevel
    }
  });
  installFullHouseAccess(app);
  installDiagnostics(app);
  installPricingContext(app);
  installStaffTracking(app);
  void app.register(registerPricingAdmin, { prefix: "/v1/firstmeasure/admin/prices" });

  if (env.clusterNodeRole === "legacy" && env.legacyProxySecret) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith("/v1/health/")) return;
      if (request.url.split("?", 1)[0] === "/v1/platform/auth/session") return;
      // This exact private endpoint verifies its own signed PHP receipt.
      if (request.url.split("?", 1)[0] === "/v1/private/staff-tracking") return;
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
  void app.register(registerPlatformCallListApi, { prefix: "/v1/internal/crm" });
  const proxyLegacyState = env.deploymentTopology === "cluster" && env.clusterNodeRole === "web" && Boolean(env.legacyServiceUrl);
  if (proxyLegacyState) {
    const { default: httpProxy } = await import("@fastify/http-proxy");
    const proxyOptions = (prefix: string) => ({
      upstream: env.legacyServiceUrl,
      prefix,
      rewritePrefix: prefix,
      http2: false as const,
      handler: (
        request: FastifyRequest,
        reply: FastifyReply,
        destination: string,
        options: FastifyReplyFromHooks
      ) => reply.from(destination, legacyProxyReplyOptions(request, options)),
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
    // Not under /internal: that public proxy adds the service secret, so an RPC
    // placed there would let callers bypass platform authentication.
    if (env.clusterNodeRole === "legacy") {
      void app.register(referralServiceRoutes(env.legacyProxySecret), { prefix: "/v1/private/referrals" });
    }
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
  void app.register(registerMobileApi, { prefix: "/v1/mobile" });
  void app.register(registerProposalsApi, { prefix: "/v1/proposals" });
  void app.register(registerPublicFirstMeasureApi, { prefix: "/v1/public/firstmeasure" });
  void app.register(registerWeatherApi, { prefix: "/v1/weather" });


  // Platform APIs use the same host, auth context and runtime boundaries.
  void app.register(registerPublicLinksApi);
  void app.register(registerAudioNotesApi, { prefix: "/v1/audio-notes" });
  void app.register(registerAgentsApi, { prefix: "/v1/agents" });
  void app.register(registerAppointmentsApi, { prefix: "/v1/appointments" });
  void app.register(registerAssistantApi, { prefix: "/v1/assistant" });
  void app.register(registerCallsApi, { prefix: "/v1/calls" });
  void app.register(registerChannelsApi, { prefix: "/v1/channels" });
  void app.register(registerChatApi, { prefix: "/v1/chat" });
  void app.register(registerCommsApi, { prefix: "/v1/comms" });
  void app.register(registerConnectionsApi, { prefix: "/v1/connections" });
  void app.register(registerDocumentsApi, { prefix: "/v1/documents" });
  void app.register(registerDomainsApi, { prefix: "/v1/domains" });
  void app.register(registerEquipmentApi, { prefix: "/v1/equipment" });
  void app.register(registerFeedbackApi, { prefix: "/v1/feedback" });
  void app.register(registerFinancialsApi, { prefix: "/v1/financials" });
  void app.register(registerMessagingApi, { prefix: "/v1/messaging" });
  void app.register(registerPayrollApi, { prefix: "/v1/payroll" });
  void app.register(registerRoutingApi, { prefix: "/v1/platform" });
  void app.register(registerScopesApi, { prefix: "/v1/scopes" });
  void app.register(registerSignupSandboxApi, { prefix: "/v1/signup-sandbox" });
  void app.register(registerStatsApi, { prefix: "/v1/stats" });
  void app.register(registerTrainingApi, { prefix: "/v1/training" });
  void app.register(registerWebsitesApi, { prefix: "/v1/websites" });
  void app.register(registerWorkApi, { prefix: "/v1/work" });
  void app.register(registerWorkforceApi, { prefix: "/v1/workforce" });

  return app;
}
