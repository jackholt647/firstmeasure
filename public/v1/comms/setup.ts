import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { forbidden } from "../platform/errors.js";
import { hasPermission } from "../platform/auth.js";
import { isCapabilityEnabled, saveCapabilityValues } from "../platform/capabilities.js";
import { ensureOrgEmailInbox } from "../email/engine.js";
import { listSenderIdentities } from "../messaging/communications_storage.js";
import { findSmsComplianceProfiles, type SmsComplianceProfile } from "../messaging/storage.js";
import { voiceSettings } from "./calls/settings.js";
import { completeDevelopmentOnboarding, developmentCallStatus } from "./calls/development.js";
import * as voice from "./calls/storage.js";

/**
 * The Communications setup (guided experience `comms.setup`, docs/architecture/guided-experiences.md, FM-491): the
 * first visit to Communications introduces texts, calls and email, then turns on the one the person picks. Texts and
 * calls turn on the organization's Texts and SMS settings; the setup then runs carrier registration (10DLC), the same
 * workflow as Phone Settings (settings/sms-registration.js, FM-510), and the status says where it stands. Email turns on
 * the Email inbox and creates the company's FirstMate Mail address. Billing is the platform billing SMS plan, bought in
 * the browser through the existing quote and checkout.
 */
const channel = z.enum(["phone", "email"]);
const startInput = z.object({ channel }).strict();
const completeInput = z.object({ comms_setup: z.array(channel).max(2).optional() }).passthrough();

const PHONE_SWITCHES = { "comms.sms": true, "apps.messaging": true, "platform.sms_settings": true } as const;
const EMAIL_SWITCHES = { "comms.email": true } as const;

type RegistrationState = "none" | "draft" | "attention" | "submitted" | "approved";
const text = (value: unknown) => String(value ?? "").trim().toLowerCase();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Where one registration stands, as Phone Settings reads it: approved (an active campaign, or a simulated one on
 * development), submitted (carriers are reviewing it), attention (rejected, failed or suspended), else a draft.
 */
export function smsRegistrationState(profile: SmsComplianceProfile | null | undefined): RegistrationState {
  if (!profile) return "none";
  const refs = record(profile.provider_refs), brand = record(profile.brand), campaign = record(profile.campaign);
  const statuses = [profile.status, profile.brand_status, profile.campaign_status, profile.phone_number_status].map(text);
  if (statuses.some((value) => /fail|reject|unverified|suspend|expire|cancel/.test(value))) return "attention";
  const hasCampaign = !!(refs.telnyx_campaign_id || refs.tcr_campaign_id);
  const mock = brand.mock === true || campaign.mock === true || (Array.isArray(profile.events) && profile.events.some((event) => record(event).mock === true));
  if (hasCampaign && (mock || (statuses[0] === "active" && statuses[2] === "mno_provisioned"))) return "approved";
  if (refs.telnyx_brand_id || refs.tcr_brand_id || campaign.brandId || hasCampaign || ["brand_pending", "brand_submitted", "campaign_submitted", "active"].includes(statuses[0] || "")) return "submitted";
  return "draft";
}
const STATE_ORDER: RegistrationState[] = ["none", "draft", "attention", "submitted", "approved"];
async function registrationState(orgId: string): Promise<RegistrationState> {
  const profiles = await findSmsComplianceProfiles(orgId).catch(() => []);
  return profiles.map(smsRegistrationState).reduce((best, state) => STATE_ORDER.indexOf(state) > STATE_ORDER.indexOf(best) ? state : best, "none" as RegistrationState);
}

function requireManager(ctx: PublicationContext) {
  if (!ctx.auth || ctx.auth.orgId !== ctx.organizationId || !hasPermission(ctx.auth, "manage_company_settings")) {
    throw forbidden("comms_setup_denied", "Company settings access is required to set up communications.");
  }
  return ctx.auth;
}

/** What is on: read only. Nothing is created (the inbox address is shown once email is on and has one). */
export async function commsSetupStatus(ctx: PublicationContext) {
  const orgId = ctx.organizationId;
  const [texts, email, settings, numbers, smsNumbers, development, registration] = await Promise.all([
    isCapabilityEnabled(orgId, "comms.sms"),
    isCapabilityEnabled(orgId, "comms.email"),
    voiceSettings(orgId),
    voice.resources(orgId, "number"),
    listSenderIdentities(orgId, ctx.auth?.branchId || "default", "sms"),
    developmentCallStatus(orgId),
    registrationState(orgId)
  ]);
  const inbox = email ? (await listSenderIdentities(orgId, ctx.auth?.branchId || "default", "email")).find((identity) => identity.status !== "disabled" && identity.address) : null;
  const activeNumbers = numbers.filter((number) => number.status === "active");
  return {
    phone: {
      texts,
      calls: settings.enabled === true && activeNumbers.length > 0,
      numbers: activeNumbers.map((number) => String(number.phone_number || number.id || "")),
      texting_numbers: smsNumbers.filter((identity) => identity.status === "active").map((identity) => identity.address),
      // On development, "fully onboarded" is a simulated approval (Phone Settings shows its registration as done).
      registration: development?.onboarded ? "approved" : registration,
      ...(development ? { development: { onboarded: development.onboarded } } : {})
    },
    email: { on: email, address: inbox?.address || "" },
    done: { phone: texts, email }
  };
}

export async function startCommsSetup(ctx: PublicationContext, value: unknown) {
  const auth = requireManager(ctx);
  const input = startInput.parse(value);
  if (input.channel === "email") {
    await saveCapabilityValues(ctx.organizationId, EMAIL_SWITCHES);
    // The company inbox is the FirstMate Mail identity; creating it here is the same call the inbox read makes.
    await ensureOrgEmailInbox(ctx.organizationId, auth.branchId || "default");
  } else {
    await saveCapabilityValues(ctx.organizationId, PHONE_SWITCHES);
    // On development there is no carrier: registration is simulated, and once it is submitted the shared test line
    // stands in for the number (as Phone Settings' "Skip to fully onboarded"). Before that, the setup runs the workflow.
    const development = await developmentCallStatus(ctx.organizationId);
    if (development && !development.onboarded && ["submitted", "approved"].includes(await registrationState(ctx.organizationId))) {
      await completeDevelopmentOnboarding(auth).catch(() => null);
    }
  }
  return commsSetupStatus(ctx);
}

export function registerCommsSetupPublication() {
  const base = { version: "1", domain: "comms", implementation: backendImplementationDigest(), outputSchema: { type: "object" }, executionKinds: ["api", "agent", "module"] as const };
  const policy = { scopes: ["organization" as const], permissions: ["manage_company_settings"], capabilities: ["apps.comms"] };
  registerAction({ ...base, id: "comms.setup.status", description: "Read which communication channels (texts and calls, email) the organization has set up, and where carrier registration (10DLC) stands.",
    inputSchema: { type: "object" }, policy, effect: "read", idempotency: "none",
    execute: (ctx) => commsSetupStatus(ctx) });
  registerAction({ ...base, id: "comms.setup.start", description: "Turn on texts and calls (phone) or the email inbox (email) for the organization, as the Communications setup does. Carrier registration (10DLC) is the Phone Settings workflow; on development, starting phone again after it is submitted connects the shared test line.",
    inputSchema: zodToJsonSchema(startInput, { $refStrategy: "none" }) as Record<string, unknown>,
    policy, effect: "write", idempotency: "required",
    validateInput: (input) => { startInput.parse(input); },
    execute: (ctx, _target, input) => startCommsSetup(ctx, input) });
  registerAction({ ...base, id: "comms.setup.complete", description: "Finish the Communications setup: report what is set up. Turning channels on is comms.setup.start.",
    inputSchema: zodToJsonSchema(completeInput, { $refStrategy: "none" }) as Record<string, unknown>,
    policy, effect: "write", idempotency: "required",
    execute: (ctx) => { requireManager(ctx); return commsSetupStatus(ctx); } });
}
