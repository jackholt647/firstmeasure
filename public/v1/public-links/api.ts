import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import {
  createPublicLink,
  listPublicLinks,
  publicLinkDestination,
  recordPublicLinkAccess,
  revokePublicLink
} from "./service.js";

const createSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  resource_type: z.string().trim().min(1).max(80),
  resource_id: z.string().trim().min(1).max(240),
  destination_path: z.string().trim().min(1).max(1000),
  allowed_actions: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
  expires_at: z.string().trim().max(80).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

function param(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

function view(document: Record<string, unknown>) {
  const data = document.data && typeof document.data === "object" ? document.data as Record<string, unknown> : {};
  const { token_hash: _tokenHash, ...safeData } = data;
  return { ...safeData, revision: document.revision };
}

export const registerPublicLinksApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message });
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/v1/public-links", async () => ({
    ok: true,
    api: "public-links",
    endpoints: {
      create: "/v1/public-links/organizations/:orgId/links",
      list: "/v1/public-links/organizations/:orgId/links",
      revoke: "/v1/public-links/organizations/:orgId/links/:linkId/revoke",
      open: "/l/:token"
    }
  }));

  app.get("/v1/public-links/organizations/:orgId/links", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    return { ok: true, links: (await listPublicLinks(orgId)).map((entry) => view(entry as Record<string, unknown>)) };
  });

  app.post("/v1/public-links/organizations/:orgId/links", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const actor = await requirePlatformAuth(request, { orgId, permission: "manage_company_settings", csrf: true });
    const body = createSchema.parse(request.body ?? {});
    const created = await createPublicLink(orgId, { ...body, created_by: String(actor.identity?.email ?? actor.identity?.id ?? "") });
    return reply.code(201).send({ ok: true, link: view(created.document as Record<string, unknown>), token: created.token, url: created.url });
  });

  app.post("/v1/public-links/organizations/:orgId/links/:linkId/revoke", async (request) => {
    const orgId = param(request.params, "orgId");
    const actor = await requirePlatformAuth(request, { orgId, permission: "manage_company_settings", csrf: true });
    const document = await revokePublicLink(orgId, param(request.params, "linkId"), String(actor.identity?.email ?? actor.identity?.id ?? ""));
    return { ok: true, link: view(document as Record<string, unknown>) };
  });

  app.get("/l/:token", async (request, reply) => {
    const token = param(request.params, "token");
    const resolved = await recordPublicLinkAccess(token);
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    return reply.redirect(publicLinkDestination(resolved.data, token), 302);
  });
};
