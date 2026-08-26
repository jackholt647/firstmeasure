import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import {
  cancelPaymentIntent,
  createDisbursement,
  createPayable,
  createPayment,
  createPaymentIntent,
  ensureReceivablesForSignedProposal,
  listLedger,
  listPayables,
  listPaymentEvents,
  listProjectObligations,
  listProjectPaymentSchedules,
  listProjectPayments,
  projectMoneySummary,
  readPayment,
  reallocatePayment,
  refundPayment
} from "./storage.js";
import {
  createDisbursementSchema,
  createPayableSchema,
  createPaymentIntentSchema,
  createPaymentSchema,
  refundPaymentSchema,
  reallocatePaymentSchema
} from "./schemas.js";

const objectBodySchema = z.object({}).passthrough();

export const registerPaymentsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      reply.code(Number((error as { statusCode: number }).statusCode));
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "payments",
    message: "payments API is mounted",
    endpoints: {
      projectSummary: "/organizations/:orgId/projects/:projectId/money-summary",
      projectSchedules: "/organizations/:orgId/projects/:projectId/payment-schedules",
      projectObligations: "/organizations/:orgId/projects/:projectId/obligations",
      projectPayments: "/organizations/:orgId/projects/:projectId/payments",
      payments: "/organizations/:orgId/payments",
      refunds: "/organizations/:orgId/payments/:paymentId/refunds",
      paymentIntents: "/organizations/:orgId/payment-intents",
      payables: "/organizations/:orgId/payables",
      disbursements: "/organizations/:orgId/disbursements",
      ledger: "/organizations/:orgId/ledger"
    }
  }));

  app.get("/ping", async (request) => ({
    ok: true,
    api: "payments",
    route: "/ping",
    method: request.method,
    receivedAt: new Date().toISOString()
  }));

  app.get("/organizations/:orgId/projects/:projectId/money-summary", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const summary = await projectMoneySummary(orgId, getParam(request.params, "projectId"));
    return { ok: true, summary };
  });

  app.get("/organizations/:orgId/projects/:projectId/payment-schedules", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const schedules = await listProjectPaymentSchedules(orgId, getParam(request.params, "projectId"));
    return { ok: true, schedules, count: schedules.length };
  });

  app.get("/organizations/:orgId/projects/:projectId/obligations", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const obligations = await listProjectObligations(orgId, getParam(request.params, "projectId"));
    return { ok: true, obligations, count: obligations.length };
  });

  app.get("/organizations/:orgId/projects/:projectId/payments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const payments = await listProjectPayments(orgId, getParam(request.params, "projectId"));
    return { ok: true, payments, count: payments.length };
  });

  app.post("/organizations/:orgId/payments", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createPaymentSchema.parse(request.body ?? {});
    const result = await createPayment(orgId, body, ctx);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/payments/:paymentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const payment = await readPayment(orgId, getParam(request.params, "paymentId"));
    return { ok: true, payment };
  });

  app.post("/organizations/:orgId/payments/:paymentId/refunds", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = refundPaymentSchema.parse(request.body ?? {});
    const result = await refundPayment(orgId, getParam(request.params, "paymentId"), body, ctx);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/payments/:paymentId/reallocate", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = reallocatePaymentSchema.parse(request.body ?? {});
    const result = await reallocatePayment(orgId, getParam(request.params, "paymentId"), body, ctx);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/payment-intents", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createPaymentIntentSchema.parse(request.body ?? {});
    const intent = await createPaymentIntent(orgId, body, ctx);
    reply.code(201);
    return { ok: true, intent };
  });

  app.post("/organizations/:orgId/payment-intents/:intentId/cancel", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const intent = await cancelPaymentIntent(orgId, getParam(request.params, "intentId"), ctx);
    return { ok: true, intent };
  });

  app.get("/organizations/:orgId/payables", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const payables = await listPayables(orgId, asObject(request.query));
    return { ok: true, payables, count: payables.length };
  });

  app.post("/organizations/:orgId/payables", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createPayableSchema.parse(request.body ?? {});
    const payable = await createPayable(orgId, body, ctx);
    reply.code(201);
    return { ok: true, payable };
  });

  app.post("/organizations/:orgId/disbursements", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createDisbursementSchema.parse(request.body ?? {});
    const result = await createDisbursement(orgId, body, ctx);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/ledger", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const ledger = await listLedger(orgId, asObject(request.query));
    return { ok: true, ledger, count: ledger.length };
  });

  app.get("/organizations/:orgId/events", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const events = await listPaymentEvents(orgId, asObject(request.query));
    return { ok: true, events, count: events.length };
  });

  app.post("/organizations/:orgId/proposals/:proposalId/sync-schedule", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await ensureReceivablesForSignedProposal(orgId, getParam(request.params, "proposalId"), cleanText(body.snapshot_id || body.snapshotId), body);
    reply.code(result.created ? 201 : 200);
    return { ok: true, ...result };
  });
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

