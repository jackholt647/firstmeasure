import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../src/config/env.js";
import { PlatformError } from "../../platform/errors.js";
import * as referrals from "./referrals.js";

// CRM is deliberately still a single-writer compatibility service. Platform
// routes run on every web node; calling its SQLite implementation there creates
// empty campaigns and loses the bonus configuration maintained by staff.
const operations = {
  acquisitionBonusOfferForCampaignToken: referrals.acquisitionBonusOfferForCampaignToken,
  acquisitionBonusOfferForOrganization: referrals.acquisitionBonusOfferForOrganization,
  acquisitionBonusQuoteForOrganization: referrals.acquisitionBonusQuoteForOrganization,
  completeAcquisitionSignup: referrals.completeAcquisitionSignup,
  customerReferralEvent: referrals.customerReferralEvent,
  customerReferralStatus: referrals.customerReferralStatus,
  publicAcquisitionLookup: referrals.publicAcquisitionLookup,
  publicReferralLookup: referrals.publicReferralLookup,
  trackAcquisitionEvent: referrals.trackAcquisitionEvent
};
type Operation = keyof typeof operations;
type ServiceConfig = Pick<typeof env, "deploymentTopology" | "clusterNodeRole" | "legacyServiceUrl" | "legacyProxySecret">;

export function createReferralService(config: ServiceConfig, request = fetch) {
  const remote = config.deploymentTopology === "cluster" && config.clusterNodeRole === "web";
  const wrap = <K extends Operation>(operation: K) => async (...args: Parameters<typeof operations[K]>): Promise<Awaited<ReturnType<typeof operations[K]>>> => {
    if (!remote) return await (operations[operation] as Function)(...args);
    if (!config.legacyServiceUrl || !config.legacyProxySecret) {
      throw new PlatformError("referral_service_unavailable", 503, "The campaign service is not configured.");
    }
    const response = await request(new URL(`/v1/private/referrals/${operation}`, config.legacyServiceUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "x-firstmeasure-legacy-proxy": config.legacyProxySecret },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      // Never fall back to a node-local ledger. That appears successful while
      // silently dropping the advertised offer and splitting campaign totals.
      throw new PlatformError("referral_service_unavailable", 503, "The campaign service is temporarily unavailable.");
    }
    return await response.json() as Awaited<ReturnType<typeof operations[K]>>;
  };
  return {
    acquisitionBonusOfferForCampaignToken: wrap("acquisitionBonusOfferForCampaignToken"),
    acquisitionBonusOfferForOrganization: wrap("acquisitionBonusOfferForOrganization"),
    acquisitionBonusQuoteForOrganization: wrap("acquisitionBonusQuoteForOrganization"),
    completeAcquisitionSignup: wrap("completeAcquisitionSignup"),
    customerReferralEvent: wrap("customerReferralEvent"),
    customerReferralStatus: wrap("customerReferralStatus"),
    publicAcquisitionLookup: wrap("publicAcquisitionLookup"),
    publicReferralLookup: wrap("publicReferralLookup"),
    trackAcquisitionEvent: wrap("trackAcquisitionEvent")
  };
}

export const {
  acquisitionBonusOfferForCampaignToken, acquisitionBonusOfferForOrganization,
  acquisitionBonusQuoteForOrganization, completeAcquisitionSignup,
  customerReferralEvent, customerReferralStatus, publicAcquisitionLookup,
  publicReferralLookup, trackAcquisitionEvent
} = createReferralService(env);

export function referralServiceRoutes(secret: string): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      const received = Buffer.from(String(request.headers["x-firstmeasure-legacy-proxy"] || ""));
      const expected = Buffer.from(secret);
      if (!expected.length || received.length !== expected.length || !timingSafeEqual(received, expected)) {
        return reply.code(403).send({ ok: false, error: "legacy_proxy_required" });
      }
    });
    for (const operation of Object.keys(operations) as Operation[]) {
      app.post(`/${operation}`, async (request, reply) => {
        const args = (request.body as { args?: unknown } | null)?.args;
        if (!Array.isArray(args) || args.length > 5) return reply.code(400).send({ ok: false, error: "invalid_referral_arguments" });
        return await (operations[operation] as Function)(...args);
      });
    }
  };
}
