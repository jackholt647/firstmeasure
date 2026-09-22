import { createHash } from "node:crypto";

import type { JsonObject, SmsComplianceProfile } from "./storage.js";

export type DesiredSmsAutoresponse = {
  op: "start" | "stop" | "info";
  keywords: string[];
  country_code: "US";
  resp_text: string;
};

const STANDARD_KEYWORDS: Record<DesiredSmsAutoresponse["op"], string[]> = {
  start: ["START", "UNSTOP"],
  stop: ["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"],
  info: ["HELP", "INFO"]
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function campaignKeywords(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : cleanText(value).split(/[,;\r\n]+/);
  return values.map((entry) => cleanText(entry).toUpperCase()).filter(Boolean);
}

function normalizedKeywords(op: DesiredSmsAutoresponse["op"], value: unknown) {
  return [...new Set([...STANDARD_KEYWORDS[op], ...campaignKeywords(value)])].sort((left, right) => left.localeCompare(right));
}

export function normalizeTelnyxAutoresponseOp(value: unknown) {
  const op = cleanText(value).toLowerCase();
  return op === "help" ? "info" : op;
}

export function smsAutoresponsePlan(profile: SmsComplianceProfile) {
  const campaign = asObject(profile.campaign);
  const brand = asObject(profile.brand);
  const brandName = cleanText(brand.displayName || brand.companyName);
  const configs: DesiredSmsAutoresponse[] = [
    {
      op: "start",
      keywords: normalizedKeywords("start", campaign.optinKeywords),
      country_code: "US",
      resp_text: cleanText(campaign.optinMessage)
    },
    {
      op: "stop",
      keywords: normalizedKeywords("stop", campaign.optoutKeywords),
      country_code: "US",
      resp_text: cleanText(campaign.optoutMessage)
    },
    {
      // The current Telnyx OpenAPI contract calls the HELP operation `info`.
      op: "info",
      keywords: normalizedKeywords("info", campaign.helpKeywords),
      country_code: "US",
      resp_text: cleanText(campaign.helpMessage)
    }
  ];
  const issues: string[] = [];
  for (const config of configs) {
    if (config.keywords.length > 20) issues.push(`${config.op}KeywordsMax20`);
    if (config.resp_text.length < 20) issues.push(`${config.op}MessageMin20`);
    if (config.resp_text.length > 255) issues.push(`${config.op}MessageMax255`);
  }
  const startMessage = configs[0]!.resp_text;
  const stopMessage = configs[1]!.resp_text;
  const helpMessage = configs[2]!.resp_text;
  const identifiesBrand = (message: string) => !brandName || message.toLowerCase().includes(brandName.toLowerCase());
  const hasRatesDisclosure = (message: string) => /\b(?:msg|msgs|message|messages)\.?\s*(?:&|and)\s*data rates may apply/i.test(message);
  const hasFrequencyDisclosure = (message: string) => /(?:message|msg)\s*(?:frequency|freq)|(?:messages?|msgs?)\s+(?:per|each)|frequency varies|(?:up to\s+)?\d+\s*(?:messages?|msgs?)\s*(?:\/|per)\s*[a-z]+/i.test(message);
  const hasSupportContact = (message: string) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(message) || /\+?\d[\d().\s-]{7,}\d/.test(message);
  if (!identifiesBrand(startMessage)) issues.push("startMessageBrand");
  if (!/\bSTOP\b/i.test(startMessage)) issues.push("startMessageStop");
  if (!/\bHELP\b/i.test(startMessage)) issues.push("startMessageHelp");
  if (!hasRatesDisclosure(startMessage)) issues.push("startMessageRates");
  if (!hasFrequencyDisclosure(startMessage)) issues.push("startMessageFrequency");
  if (!identifiesBrand(stopMessage)) issues.push("stopMessageBrand");
  if (!/\bSTART\b/i.test(stopMessage)) issues.push("stopMessageStart");
  if (!/unsubscribed|opted out|no (?:more|further) messages/i.test(stopMessage)) issues.push("stopMessageConfirmation");
  if (!identifiesBrand(helpMessage)) issues.push("helpMessageBrand");
  if (!/\bSTOP\b/i.test(helpMessage)) issues.push("helpMessageStop");
  if (!hasSupportContact(helpMessage)) issues.push("helpMessageSupportContact");
  if (!hasRatesDisclosure(helpMessage)) issues.push("helpMessageRates");
  if (!hasFrequencyDisclosure(helpMessage)) issues.push("helpMessageFrequency");
  const hash = createHash("sha256").update(JSON.stringify(configs)).digest("hex");
  return { ok: issues.length === 0, issues, configs, hash };
}

export function smsAutoresponsesReady(profile: SmsComplianceProfile | null | undefined) {
  if (!profile) return false;
  const plan = smsAutoresponsePlan(profile);
  const state = asObject(profile.autoresponse_state);
  const messagingProfileId = cleanText(asObject(profile.provider_refs).telnyx_messaging_profile_id);
  return plan.ok
    && cleanText(state.status).toLowerCase() === "configured"
    && Boolean(messagingProfileId)
    && cleanText(state.messaging_profile_id) === messagingProfileId
    && cleanText(state.desired_hash) === plan.hash
    && cleanText(state.applied_hash) === plan.hash;
}

export function smsAutoresponseFieldsChanged(currentCampaign: unknown, patch: unknown) {
  const current = asObject(currentCampaign);
  const changes = asObject(patch);
  return ["optinKeywords", "optinMessage", "optoutKeywords", "optoutMessage", "helpKeywords", "helpMessage"]
    .some((key) => Object.prototype.hasOwnProperty.call(changes, key)
      && JSON.stringify(current[key] ?? null) !== JSON.stringify(changes[key] ?? null));
}
