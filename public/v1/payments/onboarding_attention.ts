import { isAppFlagEnabled } from "../platform/app_flags.js";
import { registerAttentionSource } from "../platform/attention.js";
import type { JsonObject } from "../platform/storage.js";
import { env } from "../src/config/env.js";

import { getMerchantConfigForOps } from "./merchant_config.js";
import { forwardConfigured } from "./providers/forward.js";
import { getBoardingProvider } from "./providers/index.js";

/**
 * Money onboarding attention source.
 *
 * Computes the org-wide "finish setting up payments" banner entries from
 * capabilities + merchant config + boarding application state. Emits only
 * when BOTH platform.money and money.merchant_processing resolve on.
 *
 * States:
 *  - none/DRAFT           -> active, all three surfaces, non-dismissible,
 *                            deep link resumes the wizard at the first
 *                            incomplete step. When every wizard step is
 *                            complete but the application is still DRAFT the
 *                            merchant must finish on FORWARD'S HOSTED
 *                            application (signatures included — API submission
 *                            is not available to partners), so the copy flips
 *                            to "finish on Forward's secure page" and the CTA
 *                            lands on the Payments pane, which offers the
 *                            hosted link.
 *  - NEED_INFORMATION     -> active, all three surfaces, non-dismissible,
 *                            CTA lands on the Payments pane (documents are
 *                            uploaded on Forward's hosted form).
 *  - UNDER_REVIEW (and the other in-flight underwriting statuses)
 *                         -> waiting, notification surface only, lands on the
 *                            Payments pane status tracker (no workflow keys).
 *  - APPROVED, payouts_enabled false
 *                         -> waiting, notification only.
 *  - APPROVED + payouts_enabled true -> no entries.
 * DECLINED/CANCELLED intentionally emit nothing (the status card carries the
 * explanation; a nagging banner cannot fix a declined application).
 */

export const MONEY_ONBOARDING_ATTENTION_SOURCE = "money_onboarding";
export const MONEY_ONBOARDING_ATTENTION_ID = "attention_money_onboarding";

const WIZARD_STEP_IDS = ["business", "owners", "volumes", "bank", "review"] as const;
export type MoneyOnboardingStep = (typeof WIZARD_STEP_IDS)[number];

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * First incomplete wizard step, derived from the draft application record so
 * banner clicks resume where the user left off. Mirrors (loosely) the
 * client-side step validation; a heuristic is fine here — the wizard
 * re-validates on every Continue.
 */
export function moneyOnboardingResumeStep(applicationRaw: JsonObject | null | undefined): MoneyOnboardingStep {
  const raw = asObject(applicationRaw);
  const company = asObject(raw.company);
  const address = asObject(raw.address);
  if (!cleanText(company.legal_name || company.name) || !cleanText(company.ein) || !cleanText(address.address1)) {
    return "business";
  }
  const owners = asArray(raw.owners).map(asObject);
  const ownersComplete = owners.length > 0
    && owners.every((owner) => cleanText(owner.name) && Number(owner.ownership_percent) > 0)
    && owners.filter((owner) => owner.signer === true).length === 1;
  if (!ownersComplete) return "owners";
  const volumes = asObject(raw.volumes);
  if (!(Number(volumes.annual_volume) > 0) || !(Number(volumes.avg_ticket) > 0)) return "volumes";
  const bank = asObject(raw.bank_account && Object.keys(asObject(raw.bank_account)).length
    ? raw.bank_account
    : asObject(raw.user_fields).bank_account);
  if (!cleanText(bank.routing_number) || !cleanText(bank.account_number)) return "bank";
  return "review";
}

const PAYMENTS_PANE_ROUTE = { tab: "company_settings", sub: "money", settingsView: "payments" } as const;

function wizardRoute(step: MoneyOnboardingStep): JsonObject {
  return { ...PAYMENTS_PANE_ROUTE, workflow: "money_onboarding", workflow_step: step };
}

const IN_FLIGHT_STATUSES = ["UNDER_REVIEW", "UNDERWRITING", "CREDIT_PENDED", "CONDITIONALLY_APPROVED", "SUBMITTED"];

export async function computeMoneyOnboardingEntries(orgId: string): Promise<JsonObject[]> {
  const [moneyOn, processingOn] = await Promise.all([
    isAppFlagEnabled(orgId, "platform", "money"),
    isAppFlagEnabled(orgId, "money", "merchant_processing")
  ]);
  if (!moneyOn || !processingOn) return [];

  const config = await getMerchantConfigForOps(orgId);
  const hostedSandbox = config?.provider === "forward" && forwardConfigured() && env.forwardApiBase.includes("sandbox");
  const setupAction = (route: JsonObject) => hostedSandbox
    ? { kind: "open_payment_setup", route }
    : { route };
  const forward = config?.forward;
  const status = cleanText(forward?.boarding_status).toUpperCase();
  const approved = status === "APPROVED" || (!!cleanText(forward?.account_id) && !status);

  const base = {
    id: MONEY_ONBOARDING_ATTENTION_ID,
    source: MONEY_ONBOARDING_ATTENTION_SOURCE,
    key: "money_onboarding",
    // The user wants these persistent until onboarding is done: every surface
    // is non-dismissible (notification rows never dismiss anyway).
    dismissible: { topbar: false, sidebar: false }
  };

  if (approved) {
    if (forward?.payouts_enabled === true) return [];
    return [{
      ...base,
      priority: 60,
      surfaces: ["notification"],
      state: "waiting",
      tone: "orange",
      title: "Almost there — payouts are being enabled",
      body: "Your merchant account is approved. Payouts to your bank account are being switched on.",
      cta_label: "View status",
      frontend_action: { route: { ...PAYMENTS_PANE_ROUTE } }
    }];
  }

  if (status === "DECLINED" || status === "CANCELLED") return [];

  if (IN_FLIGHT_STATUSES.includes(status)) {
    return [{
      ...base,
      priority: 60,
      surfaces: ["notification"],
      state: "waiting",
      tone: "orange",
      title: "Your payments application is under review",
      body: "The underwriting team is reviewing your merchant application. Most decisions arrive within 1-2 business days.",
      cta_label: "View status",
      frontend_action: { route: { ...PAYMENTS_PANE_ROUTE } }
    }];
  }

  // none / DRAFT / NEED_INFORMATION: resolve the resume step from the draft
  // application when one exists. The extra provider read is local for mock and
  // guarded so a provider hiccup never breaks the attention feed.
  let resumeStep: MoneyOnboardingStep = "business";
  let wizardComplete = false;
  const applicationId = cleanText(forward?.application_id);
  if (applicationId) {
    try {
      const boarding = await getBoardingProvider(orgId);
      const application = boarding ? await boarding.getApplication(applicationId) : null;
      resumeStep = moneyOnboardingResumeStep(application?.raw);
      // "Complete" = every wizard-collected section filled AND a plan chosen;
      // what remains (signatures, bank verification, final submission) happens
      // on Forward's hosted application.
      wizardComplete = resumeStep === "review" && !!cleanText(application?.processing_plan_id);
    } catch {
      resumeStep = "business";
    }
  }
  const linkOffered = wizardComplete || !!cleanText(forward?.application_link_url);

  if (status === "NEED_INFORMATION") {
    // Documents get uploaded on Forward's hosted application form — the CTA
    // lands on the Payments pane, which offers the hosted link.
    return [{
      ...base,
      priority: 100,
      surfaces: ["topbar", "sidebar", "notification"],
      state: "active",
      tone: "orange",
      title: "Action needed on your payments application",
      body: "The underwriter needs more information. Review the request and provide the documents on Forward's secure application page.",
      cta_label: "Review request",
      frontend_action: setupAction({ ...PAYMENTS_PANE_ROUTE })
    }];
  }

  if (linkOffered) {
    // Everything we collect is filled in; the merchant now finishes on
    // Forward's hosted application (signatures + bank verification).
    return [{
      ...base,
      priority: 100,
      surfaces: ["topbar", "sidebar", "notification"],
      state: "active",
      tone: "orange",
      title: "Finish your application on Forward's secure page",
      body: "Your details are ready. Complete signatures and verification on Forward's secure application to submit for review.",
      cta_label: "Continue application",
      frontend_action: setupAction({ ...PAYMENTS_PANE_ROUTE })
    }];
  }

  // No application yet, or a draft in progress.
  return [{
    ...base,
    priority: 100,
    surfaces: ["topbar", "sidebar", "notification"],
    state: "active",
    tone: "orange",
    title: "Finish setting up payments",
    body: "Complete your onboarding to start taking payments.",
    cta_label: "Finish setup",
    frontend_action: setupAction(wizardRoute(resumeStep))
  }];
}

export function registerMoneyOnboardingAttentionSource() {
  registerAttentionSource(MONEY_ONBOARDING_ATTENTION_SOURCE, async (orgId) => {
    return computeMoneyOnboardingEntries(orgId);
  });
}
