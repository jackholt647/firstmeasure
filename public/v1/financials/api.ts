import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { hasPermission, requirePlatformAuth } from "../platform/auth.js";
import { badRequest, PlatformError } from "../platform/errors.js";
import { cashFlowFinancials, projectFinancials, type FinancialReadOptions } from "./read_model.js";

const querySchema = z.object({
  branch_id: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
  clearing_hours: z.coerce.number().int().min(0).max(336).optional(),
  opening_balance_cents: z.coerce.number().int().optional()
}).passthrough();

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  const source = params && typeof params === "object" ? params as Record<string, unknown> : {};
  return cleanText(source[key]);
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function defaultPeriod() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const through = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: dateKey(from), through: dateKey(through) };
}

function readOptions(request: FastifyRequest, options: { cashFlow?: boolean } = {}): FinancialReadOptions {
  const query = querySchema.parse(request.query ?? {});
  const defaults = defaultPeriod();
  const from = query.from || defaults.from;
  const through = query.through || defaults.through;
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const throughTime = Date.parse(`${through}T00:00:00.000Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(throughTime) || throughTime <= fromTime) {
    throw badRequest("financial_period_invalid", "Financial periods require a valid exclusive through date after the from date.");
  }
  const maximumDays = options.cashFlow ? 366 : 3_660;
  if ((throughTime - fromTime) / 86_400_000 > maximumDays) {
    throw badRequest("financial_period_too_large", `Financial periods are limited to ${maximumDays} days.`);
  }
  return {
    branchId: cleanText(query.branch_id),
    from,
    through,
    limit: query.limit,
    cursor: cleanText(query.cursor),
    clearingHours: query.clearing_hours,
    openingBalance: query.opening_balance_cents
  };
}

export const registerFinancialsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected financial reporting error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "financials",
    endpoints: {
      overview: "/organizations/:orgId/overview",
      projects: "/organizations/:orgId/projects",
      cash_flow: "/organizations/:orgId/cash-flow"
    }
  }));

  app.get("/organizations/:orgId/overview", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_projects|manage_company_settings" });
    const options = readOptions(request);
    return { ok: true, ...(await projectFinancials(orgId, { ...options, limit: Math.min(20, Number(options.limit || 20)) })) };
  });

  app.get("/organizations/:orgId/projects", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_projects|manage_company_settings" });
    return { ok: true, ...(await projectFinancials(orgId, readOptions(request))) };
  });

  app.get("/organizations/:orgId/cash-flow", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_projects|manage_company_settings" });
    const includePayroll = hasPermission(ctx, "manage_payroll|manage_company_settings");
    return { ok: true, ...(await cashFlowFinancials(orgId, { ...readOptions(request, { cashFlow: true }), includePayroll })) };
  });
};
