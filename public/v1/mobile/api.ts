import type { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { requirePlatformAuth } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { PlatformError, forbidden, notFound } from "../platform/errors.js";
import { developmentDownloadsAllowed, mobileConfiguration } from "./config.js";
import { registerMobileAuth } from "./auth.js";

export const registerMobileApi: FastifyPluginAsync = async app => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: "mobile_unavailable", message: "Mobile services are temporarily unavailable." });
  });
  app.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "private, no-store"); });
  registerMobileAuth(app);
  app.get<{ Params: { orgId: string } }>("/organizations/:orgId/config", async request => {
    await requirePlatformAuth(request, { orgId: request.params.orgId });
    if (!await isAppFlagEnabled(request.params.orgId, "mobile", "app_download")) throw forbidden("mobile_disabled", "App downloads are disabled for this organization.");
    return { ok: true, ...await mobileConfiguration(request.params.orgId) };
  });
  app.get<{ Params: { orgId: string } }>("/organizations/:orgId/downloads/android", async (request, reply) => {
    await requirePlatformAuth(request, { orgId: request.params.orgId });
    if (!developmentDownloadsAllowed() || !await isAppFlagEnabled(request.params.orgId, "mobile", "app_download")
      || !await isAppFlagEnabled(request.params.orgId, "mobile", "developer_downloads")) throw forbidden("developer_download_disabled", "Test downloads are not enabled.");
    const file = process.env.MOBILE_ANDROID_TEST_APK_PATH || "";
    if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".apk") throw notFound("build_unavailable", "No Android test build has been published.");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw notFound("build_unavailable", "No Android test build has been published.");
    reply.header("Content-Type", "application/vnd.android.package-archive");
    reply.header("Content-Disposition", 'attachment; filename="FirstMate.apk"');
    reply.header("Content-Length", info.size);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(createReadStream(file));
  });
};
