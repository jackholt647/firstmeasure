import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformAuth } from "../platform/auth.js";
import { readInternalUser, saveInternalDocument } from "../internal/storage.js";
import { acquireFirstMeasureLock } from "./locks.js";
import { FirstMeasureError } from "./errors.js";
import { buildReportExpediteOptions, reportExpediteBaseUnitPrice } from "./expedite.js";
import { DEFAULT_EXPEDITE_PRICING, expeditePricingSchema, pricingContext, readExpeditePricing } from "./pricing_config.js";

async function requirePricingAdmin(request: FastifyRequest, csrf = false) {
  const auth = await requirePlatformAuth(request, { csrf });
  const user = await readInternalUser(String(auth.identity.email ?? ""));
  // Customer organization owners/admins and delegated queue/sales permissions do
  // not grant access. Never trust actor headers, body fields or session role alone.
  const permissions = user?.permissions ?? {};
  const fullAdmin = user && (["admin", "system_admin"].includes(String(user.role).toLowerCase()) || user.is_admin || permissions.is_admin_legacy || permissions.platform_admin);
  if (!user || user.disabled || user.status !== "active" || !fullAdmin) {
    throw new FirstMeasureError("pricing_admin_required", 403, "Only full internal admins can manage prices.");
  }
  return user;
}
export const registerPricingAdmin: FastifyPluginAsync = async app => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ success: false, error: "invalid_pricing", message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    const failure = error as { statusCode?: number; code?: string; message?: string };
    return reply.code(failure.statusCode ?? 500).send({ success: false, error: failure.code ?? "pricing_error", message: failure.statusCode && failure.statusCode < 500 ? failure.message : "Prices are temporarily unavailable." });
  });
  app.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.get("/", async request => {
    await requirePricingAdmin(request);
    return { success: true, ...await readExpeditePricing(), defaults: DEFAULT_EXPEDITE_PRICING };
  });
  app.post("/preview", async request => {
    await requirePricingAdmin(request, true);
    const config = expeditePricingSchema.parse(request.body);
    return pricingContext.run({ config, revision: -1, now: new Date() }, () => ({
      success: true, current: buildReportExpediteOptions(),
      samples: [config.wait_min_minutes, (config.wait_min_minutes + config.wait_max_minutes) / 2, config.wait_max_minutes].map(wait => ({
        wait_minutes: wait,
        residential: ["standard_3_6", "rush_1_3", "rush_under_1"].map(key => reportExpediteBaseUnitPrice("residential", key, wait)),
        commercial: ["standard_3_6", "rush_1_3", "rush_under_1"].map(key => reportExpediteBaseUnitPrice("commercial", key, wait))
      }))
    }));
  });
  app.put("/", async request => {
    const user = await requirePricingAdmin(request, true);
    const body = z.object({ revision: z.number().int().min(0), config: expeditePricingSchema }).strict().parse(request.body);
    const release = await acquireFirstMeasureLock("expedite-pricing-config", { waitMs: 5000 });
    try {
      const previous = await readExpeditePricing();
      if (previous.revision !== body.revision) throw new FirstMeasureError("pricing_changed", 409, "Another admin changed prices. Reload before saving.");
      await saveInternalDocument("pricing_config", "expedite", { data: body.config, metadata: {
        updated_by: user.email, previous_config: previous.config, previous_revision: previous.revision
      } }, { replace: true });
      return { success: true, ...await readExpeditePricing(), defaults: DEFAULT_EXPEDITE_PRICING };
    } finally { await release(); }
  });
};
