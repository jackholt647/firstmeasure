import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { ensureFormConversation } from "./assistant.js";
import {
  createForm,
  deleteForm,
  duplicateForm,
  formInsights,
  formsContext,
  getForm,
  listFormSubmissions,
  listForms,
  previewAvailability,
  previewMeasurement,
  publicAvailability,
  publicForm,
  publicMeasurement,
  publishForm,
  recordPublicActivity,
  rotateFormKey,
  submitPublicForm,
  testForm,
  updateForm
} from "./service.js";

const body = z.object({}).passthrough();
const param = (request: FastifyRequest, key: string) => String((request.params as Record<string, unknown>)[key] ?? "").trim();
const record = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

// In-process fixed windows, matching the other public embed endpoints.
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function rateLimit(key: string, max: number, windowMs: number) {
  if (process.env.FORMS_RATE_LIMIT_DISABLED === "1") return;
  const now = Date.now();
  if (buckets.size > 20_000) {
    for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > max) {
    throw new PlatformError("rate_limited", 429, "Too many requests. Please try again in a moment.", {
      retry_after_seconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    });
  }
}

const PRIVATE_ADDRESS = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|::ffff:(127\.|10\.|192\.168\.)|f[cd][0-9a-f]{2}:|fe80:)/i;

/**
 * The visitor's address for rate limiting. The API sits behind our own proxies, which append to
 * X-Forwarded-For, so the right-most public entry is the last address we did not write ourselves;
 * anything left of it is client-supplied and ignored. A direct public connection is taken as-is.
 */
function visitor(request: FastifyRequest) {
  const direct = String(request.ip || "");
  if (!PRIVATE_ADDRESS.test(direct)) return direct;
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (let index = forwarded.length - 1; index >= 0; index -= 1) if (!PRIVATE_ADDRESS.test(forwarded[index]!)) return forwarded[index]!;
  return direct;
}

export const registerFormsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", message: error.issues[0]?.message || "Invalid request.", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      if (error.statusCode === 429) reply.header("Retry-After", String(record(error.details).retry_after_seconds ?? 5));
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  const auth = (request: FastifyRequest) => requirePlatformAuth(request, {
    orgId: param(request, "orgId"),
    permission: "manage_company_settings",
    csrf: !["GET", "HEAD"].includes(request.method)
  });

  app.get("/", async () => ({ ok: true, api: "forms" }));

  app.get("/organizations/:orgId/context", async (request) => ({ ok: true, ...(await formsContext(await auth(request))) }));
  app.get("/organizations/:orgId/forms", async (request) => ({ ok: true, forms: await listForms(await auth(request)) }));
  app.post("/organizations/:orgId/forms", async (request, reply) => {
    const input = z.object({ template: z.string().optional(), name: z.string().optional() }).parse(request.body ?? {});
    reply.code(201);
    return { ok: true, form: await createForm(await auth(request), input) };
  });
  app.get("/organizations/:orgId/forms/:formId", async (request) => ({ ok: true, form: await getForm(await auth(request), param(request, "formId")) }));
  app.patch("/organizations/:orgId/forms/:formId", async (request) => {
    const input = z.object({ name: z.string().optional(), definition: z.unknown().optional(), enabled: z.boolean().optional(), expected_revision: z.number().int().positive().optional() }).parse(request.body ?? {});
    return { ok: true, form: await updateForm(await auth(request), param(request, "formId"), input) };
  });
  app.delete("/organizations/:orgId/forms/:formId", async (request) => ({ ok: true, ...(await deleteForm(await auth(request), param(request, "formId"))) }));
  app.post("/organizations/:orgId/forms/:formId/publish", async (request) => {
    const input = z.object({ expected_revision: z.number().int().positive().optional() }).parse(request.body ?? {});
    return { ok: true, form: await publishForm(await auth(request), param(request, "formId"), input) };
  });
  app.post("/organizations/:orgId/forms/:formId/duplicate", async (request, reply) => {
    reply.code(201);
    return { ok: true, form: await duplicateForm(await auth(request), param(request, "formId")) };
  });
  app.post("/organizations/:orgId/forms/:formId/rotate-key", async (request) => ({ ok: true, form: await rotateFormKey(await auth(request), param(request, "formId")) }));
  app.get("/organizations/:orgId/forms/:formId/insights", async (request) => ({ ok: true, ...(await formInsights(await auth(request), param(request, "formId"))) }));
  // The editor's AI tab is the shared assistant in a private conversation about this form.
  app.post("/organizations/:orgId/forms/:formId/conversation", async (request) => ({ ok: true, thread: await ensureFormConversation(await auth(request), param(request, "formId")) }));
  app.get("/organizations/:orgId/forms/:formId/submissions", async (request) => ({ ok: true, submissions: await listFormSubmissions(await auth(request), param(request, "formId")) }));

  // Editor preview transport: the embed renders the unsaved draft against these.
  app.post("/organizations/:orgId/preview/measurement", async (request) => {
    const input = z.object({ source: z.string(), address: z.string(), tint: z.string().optional() }).parse(request.body ?? {});
    return { ok: true, ...(await previewMeasurement(await auth(request), input)) };
  });
  app.post("/organizations/:orgId/preview/availability", async (request) => {
    const input = z.object({ item: z.unknown(), date: z.string(), address: z.string().optional() }).parse(request.body ?? {});
    return { ok: true, ...(await previewAvailability(await auth(request), input)) };
  });
  app.post("/organizations/:orgId/preview/submit", async (request) => {
    const input = z.object({ definition: z.unknown(), answers: z.unknown().optional(), measurements: z.unknown().optional() }).parse(request.body ?? {});
    return testForm(await auth(request), input);
  });

  app.get("/public/:formKey", async (request) => {
    rateLimit(`cfg:${visitor(request)}`, 120, 60_000);
    return publicForm(param(request, "formKey"));
  });
  app.get("/public/:formKey/availability", async (request) => {
    rateLimit(`slots:${visitor(request)}`, 90, 60_000);
    return publicAvailability(param(request, "formKey"), record(request.query));
  });
  app.post("/public/:formKey/measurement", async (request) => {
    // Each call reaches a metered imagery provider.
    rateLimit(`measure:${visitor(request)}`, 8, 60_000);
    rateLimit(`measureday:${visitor(request)}`, 40, 24 * 3600_000);
    rateLimit(`measureform:${param(request, "formKey")}`, 120, 60_000);
    return publicMeasurement(param(request, "formKey"), body.parse(request.body ?? {}));
  });
  app.post("/public/:formKey/activity", async (request, reply) => {
    rateLimit(`activity:${visitor(request)}`, 60, 60_000);
    const input = z.object({ type: z.enum(["view", "start", "step"]), step_id: z.string().max(80).optional() }).parse(request.body ?? {});
    await recordPublicActivity(param(request, "formKey"), input).catch(() => undefined);
    reply.code(204);
    return null;
  });
  app.post("/public/:formKey/submit", async (request, reply) => {
    rateLimit(`submit:${visitor(request)}`, 6, 60_000);
    rateLimit(`submitday:${visitor(request)}`, 40, 24 * 3600_000);
    rateLimit(`submitform:${param(request, "formKey")}`, 120, 60_000);
    const { response, background } = await submitPublicForm(param(request, "formKey"), body.parse(request.body ?? {}), { ip: visitor(request), userAgent: String(request.headers["user-agent"] || "") });
    void background;
    reply.code(201);
    return response;
  });
};
