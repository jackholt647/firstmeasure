import { registerAction } from "../platform/publication/actions.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { forbidden } from "../platform/errors.js";
import { hasPermission } from "../platform/auth.js";
import { isCapabilityEnabled, saveCapabilityValues } from "../platform/capabilities.js";
import { paymentsReadiness } from "./readiness.js";

/**
 * Starting Money's payment setup (docs/architecture/payments.md, GP-128): it turns on online processing
 * (`money.merchant_processing`) as the person, so Forward's application can open. Only someone who manages company
 * settings may, in an organization that has Money; the processor, the merchant account and its approval still come only
 * from Forward and Boarding Ops. The browser cannot do this with the capabilities route: that is operator only, and in
 * an ordinary organization it was refused, so the setup opened on "Merchant boarding is not available".
 */
const SWITCHES = { "money.take_payment": true, "money.merchant_processing": true } as const;

export async function startPaymentsSetup(ctx: PublicationContext) {
  if (!ctx.auth || ctx.auth.orgId !== ctx.organizationId || !hasPermission(ctx.auth, "manage_company_settings")) {
    throw forbidden("payments_setup_denied", "Company settings access is required to set up payments.");
  }
  const off = [];
  for (const key of Object.keys(SWITCHES)) if (!(await isCapabilityEnabled(ctx.organizationId, key))) off.push(key);
  if (off.length) await saveCapabilityValues(ctx.organizationId, Object.fromEntries(off.map((key) => [key, true])));
  return { started: true, readiness: await paymentsReadiness(ctx.organizationId) };
}

export function registerPaymentsSetupPublication() {
  registerAction({
    id: "payments.setup.start", version: "1", domain: "payments", implementation: backendImplementationDigest(),
    description: "Start the organization's payment setup: turn on taking payments online, so Forward's merchant application can open. Answers where payments stand (readiness).",
    inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object" },
    executionKinds: ["api", "agent"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.money"] },
    effect: "write", idempotency: "required",
    execute: (ctx) => startPaymentsSetup(ctx)
  });
}
