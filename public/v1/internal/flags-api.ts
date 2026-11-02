import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import { libraryDevEnvironment } from "../config-library/access.js";
import { forbidden, notFound, unauthorized } from "../platform/errors.js";
import {
  bearerFlagKey, createFlagKey, enrollFlagKey, flagCoverage, listFlagAudit, listFlagKeys, listFlags, readFlagAuditEntry, readOrganizationFlags, recordFlagAudit, resolveOrganizationList,
  revokeFlagKey, searchFlagOrganizations, setFlagForOrganizations, setFlagRollout, verifyFlagKey, type FlagActor
} from "../platform/flag-console.js";
import { requestPrincipal, type Principal } from "../platform/security/principal.js";

/**
 * The feature flag console's API (docs/architecture/feature-flags.md). The routes that accept an access key are
 * declared public in internal/route-access.ts because a key is its own proof, as with the other key-carrying routes:
 * the preHandler below covers this whole plugin, so nothing here runs without a verified platform administrator,
 * a staff member who may read flags, or a live key.
 */
const actors = new WeakMap<FastifyRequest, FlagActor>();

export function flagActorFromPrincipal(principal: Principal): FlagActor {
  if (principal.kind === "system") return { kind: "system", label: "system", can_write: true };
  if (principal.kind === "anonymous") throw unauthorized("authentication_required", "Sign in, or send an access key as Authorization: Bearer <key>.");
  if (principal.kind !== "staff") throw forbidden("flag_console_staff_only", "The feature flag console is for platform staff.");
  const { staff, impersonator } = principal;
  if (!staff.admin && !staff.permissions.manage_users && !staff.permissions.manage_sales_users) throw forbidden("platform_admin_required", "Only platform administrators can use the feature flag console.");
  return { kind: "staff", label: impersonator ? `${staff.email} (acted as by ${impersonator.email})` : staff.email, can_write: staff.admin };
}

async function resolveActor(request: FastifyRequest): Promise<FlagActor> {
  const bearer = bearerFlagKey(request.headers.authorization);
  if (bearer) {
    const key = await verifyFlagKey(bearer);
    if (!key) throw unauthorized("invalid_flag_key", "That access key is not valid, has expired or was revoked.");
    return { kind: "key", label: `key ${key.name} (${key.prefix}, created by ${key.created_by})`, can_write: key.scope === "write" };
  }
  return flagActorFromPrincipal(await requestPrincipal(request));
}

const actorOf = (request: FastifyRequest) => actors.get(request)!;
function writer(request: FastifyRequest) {
  const actor = actorOf(request);
  if (!actor.can_write) throw forbidden("platform_admin_required", actor.kind === "key" ? "This access key can read flags, not change them." : "Only platform administrators can change flags.");
  return actor;
}
/** Key management never accepts a key: a person with an administrator's session only. */
async function keyManager(request: FastifyRequest) {
  const actor = actorOf(request);
  if (actor.kind === "key") throw forbidden("session_required", "Access keys cannot manage access keys.");
  if (!actor.can_write) throw forbidden("platform_admin_required", "Only platform administrators can manage access keys.");
  return actor;
}

const param = (params: unknown, name: string) => String((params as Record<string, unknown>)[name] ?? "").trim();
const flagValue = z.union([z.boolean(), z.null()]);
const note = z.string().trim().max(500).optional();

/**
 * An agent machine's own dev key, proven by its listed SSH key. Outside the plugin below: the signature is the
 * credential. The key is the response body and nothing else, never logged or shown. Development only.
 */
export const registerFlagEnrollApi: FastifyPluginAsync = async (app) => {
  app.post("/keys/enroll", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!libraryDevEnvironment()) throw notFound("not_found", "Not found.");
    const body = z.object({ machine: z.string().max(80), timestamp: z.number().int(), nonce: z.string().max(64), signature: z.string().max(8000) }).strict().parse(request.body ?? {});
    const signature = /BEGIN SSH SIGNATURE/.test(body.signature) ? body.signature : Buffer.from(body.signature, "base64").toString("utf8");
    const created = await enrollFlagKey({ ...body, signature });
    request.log.info({ flag_key: created.id, machine: created.name }, "Feature flag key enrolled for an agent machine");
    reply.header("Cache-Control", "no-store").header("X-Flag-Key-Id", created.id);
    return reply.type("text/plain; charset=utf-8").send(created.key);
  });
};

export const registerFlagConsoleApi: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    actors.set(request, await resolveActor(request));
  });

  app.get("/me", async (request) => {
    const actor = actorOf(request);
    return { ok: true, actor: actor.label, kind: actor.kind, can_write: actor.can_write, can_manage_keys: actor.kind !== "key" && actor.can_write };
  });

  app.get("/catalog", async (request) => {
    const query = request.query as Record<string, unknown>;
    return { ok: true, ...(await listFlags(query.fresh === "1")) };
  });

  // How many organizations a percentage would cover, before saving it.
  app.get("/catalog/:key/coverage", async (request) => {
    const percent = z.coerce.number().min(0).max(100).parse((request.query as Record<string, unknown>).percent);
    return { ok: true, ...(await flagCoverage(param(request.params, "key"), percent)) };
  });

  app.put("/catalog/:key/rollout", async (request) => {
    const actor = writer(request);
    const body = z.object({ percent: z.number().min(0).max(100).optional(), killed: z.boolean().optional(), introduce: z.boolean().optional(), note }).strict().parse(request.body ?? {});
    return { ok: true, ...(await setFlagRollout(param(request.params, "key"), body, actor)) };
  });

  app.get("/orgs", async (request) => {
    const query = request.query as Record<string, unknown>;
    return { ok: true, ...(await searchFlagOrganizations(String(query.q ?? ""), Math.min(50, Number(query.limit) || 25))) };
  });

  app.get("/orgs/:orgId", async (request) => ({ ok: true, ...(await readOrganizationFlags(param(request.params, "orgId"))) }));

  app.put("/orgs/:orgId/flags/:key", async (request) => {
    const actor = writer(request);
    const body = z.object({ value: flagValue, introduce: z.boolean().optional(), note }).strict().parse(request.body ?? {});
    const result = await setFlagForOrganizations({ flag: param(request.params, "key"), value: body.value, ...(body.introduce ? { introduce: true } : {}), org_ids: [param(request.params, "orgId")], ...(body.note ? { note: body.note } : {}) }, actor);
    if (result.failed.length) throw notFound("organization_not_found", result.failed[0]!.error);
    return { ok: true, ...result };
  });

  // Reads only: a preview of what a pasted list means. Applying it is POST /bulk, with the ids chosen from this.
  app.post("/resolve", { bodyLimit: 512 * 1024 }, async (request) => {
    const body = z.object({ text: z.string().max(400_000) }).strict().parse(request.body ?? {});
    return { ok: true, ...(await resolveOrganizationList(body.text)) };
  });

  app.post("/bulk", { bodyLimit: 1024 * 1024 }, async (request) => {
    const actor = writer(request);
    const body = z.object({ flag: z.string().trim().min(1).max(120), value: flagValue, introduce: z.boolean().optional(), org_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(5000), note }).strict().parse(request.body ?? {});
    return { ok: true, ...(await setFlagForOrganizations({ flag: body.flag, value: body.value, ...(body.introduce ? { introduce: true } : {}), org_ids: body.org_ids, ...(body.note ? { note: body.note } : {}) }, actor)) };
  });

  app.get("/audit", async (request) => {
    const query = request.query as Record<string, unknown>;
    const entries = await listFlagAudit({
      ...(query.flag ? { flag: String(query.flag) } : {}), ...(query.org ? { org: String(query.org) } : {}),
      ...(Number(query.before) ? { before: Number(query.before) } : {}), ...(Number(query.limit) ? { limit: Number(query.limit) } : {})
    });
    return { ok: true, entries };
  });

  app.get("/audit/:id", async (request) => ({ ok: true, entry: await readFlagAuditEntry(param(request.params, "id")) }));

  app.get("/keys", async (request) => {
    await keyManager(request);
    return { ok: true, keys: await listFlagKeys() };
  });

  // The key appears in this response and nowhere else.
  app.post("/keys", async (request) => {
    const actor = await keyManager(request);
    const body = z.object({ name: z.string().trim().min(1).max(120), scope: z.enum(["read", "write"]).default("read"), days: z.number().int().min(1).max(365).optional() }).strict().parse(request.body ?? {});
    const created = await createFlagKey({ name: body.name, scope: body.scope, createdBy: actor.label, ...(body.days ? { days: body.days } : {}) });
    await recordFlagAudit(actor, { action: "key_created", summary: `Access key "${created.name}" (${created.scope}) created`, after: { id: created.id, name: created.name, prefix: created.prefix, scope: created.scope, expires_at: created.expires_at } });
    return { ok: true, ...created };
  });

  app.delete("/keys/:keyId", async (request) => {
    const actor = await keyManager(request);
    const id = param(request.params, "keyId");
    const revoked = await revokeFlagKey(id, actor.label);
    if (revoked) await recordFlagAudit(actor, { action: "key_revoked", summary: `Access key ${id} revoked`, before: { id } });
    return { ok: true, revoked };
  });
};
