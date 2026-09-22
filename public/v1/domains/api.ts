import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import {
  attachDomainResourcesSchema,
  connectExistingDomainSchema,
  domainActionConfirmationSchema,
  quoteDomainsSchema,
  registerDomainSchema,
  transferDomainSchema,
  updateDomainManagementSchema
} from "./schemas.js";
import {
  attachDomainResources,
  connectExistingDomain,
  disconnectDomainFromFirstMate,
  domainsConfiguration,
  organizationDomains,
  provisionExistingDomainInfrastructure,
  quoteDomains,
  refreshDomainVerification,
  registerQuotedDomain,
  resendDomainVerification,
  requestDomainTransferOut,
  transferQuotedDomain,
  updateDomainManagement
} from "./service.js";

function param(params: unknown, key: string) {
  return String((params as Record<string, unknown> | undefined)?.[key] ?? "").trim();
}

const requestFieldLabels: Record<string, string> = {
  quote_id: "Quote",
  domain: "Domain",
  first_name: "First name",
  last_name: "Last name",
  org_name: "Organization",
  address1: "Street address",
  address2: "Address line 2",
  city: "City",
  state: "State / province",
  postal_code: "Postal code",
  country: "Country code",
  phone: "Phone",
  email: "Registrant email",
  accept_price: "Accepted price",
  attestation: "Confirmation",
  auth_code: "Transfer authorization code"
};

function validationIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String),
    message: issue.message
  }));
}

export const registerDomainsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const issues = validationIssues(error);
      const summary = issues.slice(0, 4).map((issue) => {
        const key = issue.path.at(-1) ?? "";
        return `${requestFieldLabels[key] || key.replace(/_/g, " ") || "Request"}: ${issue.message}`;
      }).join(" ");
      reply.code(400).send({
        ok: false,
        error: "invalid_request",
        message: summary || "Please review the highlighted domain information.",
        details: { ...error.flatten(), issues }
      });
      return;
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details });
      return;
    }
    const providerError = error as Error & { responseCode?: string; responseText?: string };
    if (providerError.name === "OpenSrsError") {
      reply.code(502).send({
        ok: false,
        error: "domain_registry_error",
        message: "The domain registry could not complete the request. Please review the information and try again.",
        details: providerError.responseCode ? { response_code: providerError.responseCode } : undefined
      });
      return;
    }
    reply.send(error);
  });

  app.get("/", async () => ({ ok: true, service: "domains" }));

  app.get("/config", async (request) => {
    await requirePlatformAuth(request, { permission: "manage_company_settings" });
    return { ok: true, ...domainsConfiguration() };
  });

  app.get("/organizations/:orgId", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    return { ok: true, domains: await organizationDomains(orgId) };
  });

  app.post("/organizations/:orgId/quotes", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = quoteDomainsSchema.parse(request.body ?? {});
    const quote = await quoteDomains(orgId, body.domains, body.period, body.acquisition_type);
    reply.code(201);
    return { ok: true, quote };
  });

  app.post("/organizations/:orgId/registrations", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = registerDomainSchema.parse(request.body ?? {});
    const result = await registerQuotedDomain({
      orgId,
      quoteId: body.quote_id,
      domain: body.domain,
      contact: body.contact,
      acceptPrice: body.accept_price,
      allowPremium: body.allow_premium,
      actorUserId: context.userId
    });
    reply.code(result.idempotent_replay ? 200 : 201);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/transfers", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = transferDomainSchema.parse(request.body ?? {});
    const result = await transferQuotedDomain({
      orgId,
      quoteId: body.quote_id,
      domain: body.domain,
      authCode: body.auth_code,
      contact: body.contact,
      acceptPrice: body.accept_price,
      allowPremium: body.allow_premium,
      actorUserId: context.userId
    });
    reply.code(result.idempotent_replay ? 200 : 201);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/connections", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = connectExistingDomainSchema.parse(request.body ?? {});
    const result = await connectExistingDomain({ orgId, domain: body.domain, actorUserId: context.userId });
    reply.code(result.idempotent_replay ? 200 : 201);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/domains/:domain/verification/check", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    return { ok: true, registration: await refreshDomainVerification(orgId, param(request.params, "domain").toLowerCase()) };
  });

  app.post("/organizations/:orgId/domains/:domain/verification/resend", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    return { ok: true, registration: await resendDomainVerification(orgId, param(request.params, "domain").toLowerCase()) };
  });

  app.post("/organizations/:orgId/domains/:domain/resources", async (request) => {
    const orgId = param(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = attachDomainResourcesSchema.parse(request.body ?? {});
    return {
      ok: true,
      ...(await attachDomainResources({
        orgId,
        domain: param(request.params, "domain").toLowerCase(),
        website: body.website,
        defaultEmailLocalPart: body.default_email_local_part,
        context
      }))
    };
  });

  app.post("/organizations/:orgId/domains/:domain/provisioning", async (request) => {
    const orgId = param(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    domainActionConfirmationSchema.parse(request.body ?? {});
    return {
      ok: true,
      ...(await provisionExistingDomainInfrastructure({
        orgId,
        domain: param(request.params, "domain").toLowerCase(),
        actorUserId: context.userId
      }))
    };
  });

  app.patch("/organizations/:orgId/domains/:domain/management", async (request) => {
    const orgId = param(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = updateDomainManagementSchema.parse(request.body ?? {});
    return {
      ok: true,
      registration: await updateDomainManagement({
        orgId,
        domain: param(request.params, "domain").toLowerCase(),
        autoRenew: body.auto_renew,
        locked: body.locked,
        nameservers: body.nameservers,
        actorUserId: context.userId
      })
    };
  });

  app.post("/organizations/:orgId/domains/:domain/transfer-out", async (request) => {
    const orgId = param(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    domainActionConfirmationSchema.parse(request.body ?? {});
    return {
      ok: true,
      registration: await requestDomainTransferOut({
        orgId,
        domain: param(request.params, "domain").toLowerCase(),
        actorUserId: context.userId
      })
    };
  });

  app.post("/organizations/:orgId/domains/:domain/disconnect", async (request) => {
    const orgId = param(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    domainActionConfirmationSchema.parse(request.body ?? {});
    return {
      ok: true,
      registration: await disconnectDomainFromFirstMate({
        orgId,
        domain: param(request.params, "domain").toLowerCase(),
        context
      })
    };
  });
};
