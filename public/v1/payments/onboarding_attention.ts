import { isAppFlagEnabled } from "../platform/app_flags.js";
import { registerAttentionSource } from "../platform/attention.js";
import type { JsonObject } from "../platform/storage.js";
import { env } from "../src/config/env.js";

import { refreshBoardingForReadiness, syncBoardingFromProvider } from "./boarding_sync.js";
import { getMerchantConfigForOps, type MerchantConfig } from "./merchant_config.js";
import { forwardConfigured } from "./providers/forward.js";
import { getBoardingProvider } from "./providers/index.js";
import type { ProviderApplication } from "./providers/types.js";

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
 *  - APPROVED, processing or payouts off at Forward
 *                         -> waiting, notification only, saying which.
 *  - APPROVED + processing and payouts on -> no entries (the one-time
 *                            "payments are on" notification says it).
 * Whatever Forward reports is recorded first (syncBoardingFromProvider), so
 * the feed and the stored config never disagree.
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

  let config = await getMerchantConfigForOps(orgId);
  const hostedSandbox = config?.provider === "forward" && forwardConfigured() && env.forwardApiBase.includes("sandbox");
  const setupAction = (route: JsonObject) => hostedSandbox
    ? { kind: "open_payment_setup", route }
    : { route };
  const applicationId = cleanText(config?.forward.application_id);
  const settled = (forward: MerchantConfig["forward"] | undefined) => cleanText(forward?.boarding_status).toUpperCase() === "APPROVED"
    && forward?.processing_enabled === true && forward?.payouts_enabled === true;
  // A hosted submission or an approval can precede webhook delivery (or have
  // no webhook at all, as on development). Record what Forward says — the
  // sync stores it and sends the "payments are on" notification — so this
  // feed never shows a state our stored config and notifications disagree with.
  if (applicationId && !settled(config?.forward) && !["DECLINED", "CANCELLED"].includes(cleanText(config?.forward.boarding_status).toUpperCase())) {
    try {
      if (await refreshBoardingForReadiness(orgId)) config = await getMerchantConfigForOps(orgId);
    } catch { /* retain the tracked status when Forward is unavailable */ }
  }
  const forward = config?.forward;
  let status = cleanText(forward?.boarding_status).toUpperCase();
  let application: ProviderApplication | null = null;
  // The sync above runs at most once a minute; between runs, check Forward
  // before offering a draft-only Continue action, even if our stored status is stale.
  if (applicationId && (!status || status === "DRAFT" || status === "NEED_INFORMATION")) {
    try {
      const boarding = await getBoardingProvider(orgId);
      application = boarding ? await boarding.getApplication(applicationId) : null;
      status = cleanText(application?.status || status).toUpperCase();
    } catch { /* retain the tracked status when Forward is unavailable */ }
    if (status === "APPROVED" && cleanText(forward?.boarding_status).toUpperCase() !== "APPROVED") {
      // Approved since the last sync: record it now rather than guessing at
      // processing and payouts from a config that predates the approval.
      try {
        await syncBoardingFromProvider(orgId);
        config = await getMerchantConfigForOps(orgId);
      } catch { /* fall through with what we have */ }
    }
  }
  const live = config?.forward;
  const approved = status === "APPROVED" || (!!cleanText(live?.account_id) && !status);

  const base = {
    id: MONEY_ONBOARDING_ATTENTION_ID,
    source: MONEY_ONBOARDING_ATTENTION_SOURCE,
    key: "money_onboarding",
    // The user wants these persistent until onboarding is done: every surface
    // is non-dismissible (notification rows never dismiss anyway).
    dismissible: { topbar: false, sidebar: false }
  };

  if (approved) {
    // Only what Forward reports: the "payments are on" notification covers
    // the finished case, so nothing shows once processing and payouts are on.
    if (live?.processing_enabled !== true) {
      return [{
        ...base,
        priority: 60,
        surfaces: ["notification"],
        state: "waiting",
        tone: "orange",
        title: "Approved — processing isn't on yet",
        body: "Your merchant account is approved, but Forward hasn't turned on processing yet. You can take payments as soon as it does.",
        cta_label: "View status",
        frontend_action: { route: { ...PAYMENTS_PANE_ROUTE } }
      }];
    }
    if (live?.payouts_enabled === true) return [];
    return [{
      ...base,
      priority: 60,
      surfaces: ["notification"],
      state: "waiting",
      tone: "orange",
      title: "Payouts aren't on yet",
      body: "You can take payments now. Forward hasn't turned on payouts to your bank account yet. We'll update this when it does.",
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
  if (applicationId && !application) {
    try {
      const boarding = await getBoardingProvider(orgId);
      application = boarding ? await boarding.getApplication(applicationId) : null;
    } catch { /* use the tracked state */ }
  }
  resumeStep = moneyOnboardingResumeStep(application?.raw);
  // "Complete" = every wizard-collected section filled AND a plan chosen;
  // signatures and final submission happen on Forward's hosted application.
  wizardComplete = resumeStep === "review" && !!cleanText(application?.processing_plan_id);
  const linkOffered = status === "DRAFT" && (wizardComplete || !!cleanText(forward?.application_link_url));

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
      frontend_action: { route: { ...PAYMENTS_PANE_ROUTE } }
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
