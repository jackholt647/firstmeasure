import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError, badRequest } from "../platform/errors.js";
import { env } from "../src/config/env.js";
import {
  connection,
  definition,
  listConnections,
  saveConnection,
  activate,
  pause,
  execute,
  manage,
} from "./service.js";
import {
  credentialRequest,
  createCredentialRequest,
  submitCredentials,
} from "./credentials.js";
import {
  searchLibrary,
  savePlaybook,
  savePackage,
  installPackage,
} from "./library.js";
import {
  saveAutomation,
  syncResource,
  startIntegrationScheduler,
} from "./jobs.js";
import {
  ensureConnectionConversation,
  inspectConnection,
} from "./assistant.js";
import { beginOAuth, completeOAuth } from "./oauth.js";
import { object } from "./contracts.js";
import { save } from "./storage.js";

export const registerIntegrationsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "integration_input",
        message: "Some connection settings are invalid.",
        issues: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    if (error instanceof PlatformError)
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message });
    // No raw provider errors or request bodies in logs or responses.
    return reply.code(400).send({
      error: "integration_failed",
      message:
        "The connection operation failed. Check its configuration and run history.",
    });
  });
  const prefix = "/organizations/:orgId";
  await app.register(async (webhookApp) => {
    webhookApp.removeContentTypeParser("application/json");
    webhookApp.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: 1000000 },
      (_request, body, done) => done(null, body),
    );
    webhookApp.post("/webhooks/:orgId/:connectionId", async (r) =>
      (await import("./webhooks.js")).receiveWebhook(
        String(object(r.params).orgId),
        String(object(r.params).connectionId),
        String(r.body),
        r.headers,
      ),
    );
  });
  const auth = async (request: FastifyRequest) =>
    requirePlatformAuth(request, {
      orgId: String(object(request.params).orgId),
      permission: "manage_company_settings",
      capability: "platform.connections",
      csrf: request.method !== "GET",
      application: false,
    });
  const key = (r: FastifyRequest) => String(object(r.params).connectionId);
  app.get(`${prefix}/connections`, async (r) => ({
    connections: await listConnections(await auth(r)),
  }));
  app.post(`${prefix}/connections`, async (r) => ({
    connection: await saveConnection(await auth(r), object(r.body)),
  }));
  app.get(`${prefix}/connections/:connectionId`, async (r) =>
    inspectConnection(await auth(r), key(r)),
  );
  app.post(`${prefix}/connections/:connectionId/activate`, async (r) => {
    const b = z
      .object({
        expectedRevision: z.number().int(),
        operations: z.array(z.string()).max(60),
        grants: z.record(z.unknown()).default({}),
      })
      .parse(r.body);
    return {
      connection: await activate(
        await auth(r),
        key(r),
        b.expectedRevision,
        b.operations,
        b.grants,
      ),
    };
  });
  app.post(`${prefix}/connections/:connectionId/pause`, async (r) => ({
    connection: await pause(
      await auth(r),
      key(r),
      Number(object(r.body).expectedRevision),
      object(r.body).disconnect === true,
    ),
  }));
  app.post(`${prefix}/connections/:connectionId/preview`, async (r) => {
    const a = await auth(r),
      b = object(r.body);
    return {
      sample: await execute(a, key(r), String(b.operation), object(b.input), {
        preview: true,
      }),
    };
  });
  app.post(`${prefix}/connections/:connectionId/sync`, async (r) => ({
    result: await syncResource(
      await auth(r),
      key(r),
      String(object(r.body).resource),
    ),
  }));
  app.post(`${prefix}/connections/:connectionId/conversation`, async (r) => ({
    thread: await ensureConnectionConversation(await auth(r), key(r)),
  }));
  app.post(`${prefix}/connections/:connectionId/credentials`, async (r) => {
    const a = await auth(r),
      c = await connection(a, key(r));
    return {
      request: await createCredentialRequest(
        a.orgId,
        a.userId,
        c.id,
        await definition(a.orgId, c, c.draftVersion),
      ),
    };
  });
  app.get(`${prefix}/credential-requests/:requestId`, async (r) => {
    const a = await auth(r),
      request = await credentialRequest(
        a.orgId,
        a.userId,
        String(object(r.params).requestId),
      ),
      c = await connection(a, request.connection),
      d = await definition(a.orgId, c, c.draftVersion);
    return {
      request: {
        id: request.id,
        connectionId: c.id,
        name: c.name,
        destination: new URL(d.baseUrl).origin,
        fields: d.credentialFields,
        expiresAt: request.expiresAt,
      },
    };
  });
  app.post(`${prefix}/credential-requests/:requestId`, async (r) => {
    const a = await auth(r),
      request = await credentialRequest(
        a.orgId,
        a.userId,
        String(object(r.params).requestId),
      ),
      c = await connection(a, request.connection),
      d = await definition(a.orgId, c, c.draftVersion);
    return submitCredentials(
      a.orgId,
      a.userId,
      request.id,
      d,
      object(object(r.body).values),
    );
  });
  app.get(`${prefix}/library`, async (r) => {
    const a = await auth(r);
    return {
      entries: await searchLibrary(a.orgId, String(object(r.query).q || "")),
    };
  });
  app.post(`${prefix}/library`, async (r) => ({
    entry: await savePlaybook(await auth(r), r.body),
  }));
  app.post(`${prefix}/packages`, async (r) => ({
    package: await savePackage(await auth(r), r.body),
  }));
  app.post(`${prefix}/packages/install`, async (r) => ({
    connection: await installPackage(
      await auth(r),
      String(object(r.body).reference),
    ),
  }));
  app.post(`${prefix}/automations`, async (r) => ({
    automation: await saveAutomation(await auth(r), r.body),
  }));
  app.post(`${prefix}/connections/:connectionId/oauth`, async (r) => {
    const a = await auth(r);
    const publicOrigin = String(
      process.env.CONNECTIONS_PUBLIC_ORIGIN || "",
    ).replace(/\/$/, "");
    if (!/^https:\/\//.test(publicOrigin))
      throw badRequest(
        "oauth_origin",
        "Configure CONNECTIONS_PUBLIC_ORIGIN with the public HTTPS portal origin.",
      );
    return beginOAuth(
      a,
      key(r),
      `${publicOrigin}/v1/integrations/organizations/${encodeURIComponent(a.orgId)}/oauth/callback`,
    );
  });
  app.get(`${prefix}/oauth/callback`, async (r, reply) => {
    const a = await auth(r);
    await completeOAuth(
      a,
      String(object(r.query).state || ""),
      String(object(r.query).code || ""),
    );
    return reply
      .type("text/html")
      .send(
        "<!doctype html><title>Connection authorized</title><p>Connection authorized. You can close this window and return to Connections.</p>",
      );
  });
  app.post(`${prefix}/connections/:connectionId/appearance`, async (r) => {
    const a = await auth(r);
    manage(a);
    const c = await connection(a, key(r)),
      b = object(r.body);
    let logo = c.logo || "";
    if (b.logo) {
      const match = String(b.logo).match(
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match || match[2]!.length > 1_400_000)
        throw badRequest(
          "connection_logo",
          "Upload a PNG, JPEG or WebP under 1 MB.",
        );
      const sharp = (await import("sharp")).default;
      logo = `data:image/png;base64,${(await sharp(Buffer.from(match[2]!, "base64"), { limitInputPixels: 16_000_000 }).resize(128, 128, { fit: "inside" }).png().toBuffer()).toString("base64")}`;
    }
    return {
      connection: await save(
        a.orgId,
        "connection",
        c.id,
        { ...c, name: String(b.name || c.name).slice(0, 120), logo },
        Number(b.expectedRevision),
      ),
    };
  });
  const stop = startIntegrationScheduler();
  app.addHook("onClose", async () => stop());
};
