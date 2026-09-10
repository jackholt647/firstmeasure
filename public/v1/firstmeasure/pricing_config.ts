import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readInternalDocument } from "../internal/storage.js";

export const expeditePricingSchema = z.object({
  wait_min_minutes: z.number().int().min(0).max(1440),
  wait_max_minutes: z.number().int().min(1).max(2880),
  base_fee: z.number().min(0).max(100),
  busy_adder: z.number().min(0).max(100),
  fee_multiplier: z.number().min(0).max(20),
  fast_multiplier: z.number().min(1).max(20),
  rush_adder: z.number().min(0).max(100),
  fast_adder: z.number().min(0).max(100)
}).strict().refine(v => v.wait_max_minutes > v.wait_min_minutes, "Upper wait must exceed lower wait")
  .refine(v => v.fast_adder >= v.rush_adder, "Under-one-hour adder must be at least the 1–3-hour adder");
export type ExpeditePricingConfig = z.infer<typeof expeditePricingSchema>;
export const DEFAULT_EXPEDITE_PRICING: Readonly<ExpeditePricingConfig> = Object.freeze({
  wait_min_minutes: 240, wait_max_minutes: 420, base_fee: 1, busy_adder: 2,
  fee_multiplier: 1.15, fast_multiplier: 3, rush_adder: 0, fast_adder: 0
});
export const pricingContext = new AsyncLocalStorage<{ config: ExpeditePricingConfig; revision: number; now: Date }>();
export function currentExpeditePricing() { return pricingContext.getStore()?.config ?? DEFAULT_EXPEDITE_PRICING; }
export async function readExpeditePricing() {
  const document = await readInternalDocument("pricing_config", "expedite");
  // Only a missing record uses defaults. Corrupt/unavailable storage fails closed.
  return { config: document ? expeditePricingSchema.parse(document.data) : { ...DEFAULT_EXPEDITE_PRICING },
    revision: Number(document?.revision ?? 0), updated_at: document?.updated_at ?? null,
    updated_by: (document?.metadata as Record<string, unknown> | undefined)?.updated_by ?? null };
}
export function installPricingContext(app: FastifyInstance) {
  app.addHook("onRequest", (request, _reply, done) => {
    if (!/^\/v1\/(firstmeasure(?:\/|$)|platform(?:\/|$)|public\/firstmeasure(?:\/|$))/.test(request.url)) return done();
    // PDF/tile/image downloads and editor polling do not calculate charges.
    if (request.method === "GET" && request.url.startsWith("/v1/firstmeasure/") && !request.url.includes("/report-expedite-options")) return done();
    if (request.url.startsWith("/v1/platform/auth/")) return done();
    // One shared-storage snapshot per request, not a process cache. Quotes, charges,
    // and discounts retain the same config and clock even across an admin update.
    void readExpeditePricing().then(value => pricingContext.run({ ...value, now: new Date() }, done), done);
  });
}
