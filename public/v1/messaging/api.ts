import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import "./instructions.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { badRequest, conflict, forbidden, notFound, PlatformError } from "../platform/errors.js";
import { env } from "../src/config/env.js";
import { createTelnyxClient, TelnyxError, verifyTelnyxDeliveryWebhookToken, type TelnyxAutorespConfig } from "./telnyx.js";
import { normalizeTelnyxAutoresponseOp, smsAutoresponseFieldsChanged, smsAutoresponsePlan, smsAutoresponsesReady, type DesiredSmsAutoresponse } from "./autoresponses.js";
import { beginProviderOperation, claimPhoneNumberOwnership, closeCommunicationsDatabase, createUsageEvent, endBillingCommitment, findPhoneNumberOwner, findProviderOperation, findUnresolvedProviderOperationByPrefix, finishProviderOperation, listBillingCommitments, listSmsConsentEvents, listSmsConsents, listUsageEvents, listUsageSummaryRows, markProviderOperationFailed, releasePhoneNumberOwnership, resetProviderOperationForRetry, suspendOrganizationSmsDeliveries, updateProviderOperationContext, upsertBillingCommitment, upsertSmsConsent, verifyCommunicationsDatabaseWritable, webhookInboxStats } from "./communications_storage.js";
import {
  communicationCapabilities,
  conversationDetail,
  createConversation,
  listConversations,
  listMessages,
  messageDetail,
  sendCommunication,
  ensureDefaultSenderIdentities,
  simulateInboundCommunication,
  simulateMessageStatus
} from "./communications_service.js";
import { renderCommunicationsDeveloperPage } from "./developer_page.js";
import {
  createConversationSchema,
  sendCommunicationSchema,
  smsConsentSchema,
  simulateCommunicationStatusSchema,
  simulateInboundCommunicationSchema
} from "./schemas.js";
import {
  appendSmsComplianceEvent,
  commitSmsComplianceProviderSuccess,
  createSmsComplianceProfile,
  ensureMessagingOrganization,
  listSmsComplianceProfiles,
  publicMessagingOrganization,
  publicSmsComplianceProfile,
  readSmsComplianceProfile,
  mutateSmsComplianceProfileAtomically,
  setDefaultSmsComplianceProfile,
  updateSmsComplianceProfile,
  type JsonObject,
  type SmsComplianceProfile
} from "./storage.js";
import { refreshParentMessageStatus, startSmsDeliveryWorker, stopSmsDeliveryWorker } from "./delivery_worker.js";
import { acceptTelnyxWebhook, isTelnyxWebhookPublicKeyValid, verifyTelnyxWebhook } from "./telnyx_webhooks.js";

const objectBodySchema = z.object({}).passthrough();
const LIVE_MODE = () => env.communicationsDeliveryMode === "live";

const BRAND_ENTITY_TYPES = ["PRIVATE_PROFIT", "PUBLIC_PROFIT", "NON_PROFIT", "GOVERNMENT", "SOLE_PROPRIETOR"] as const;
const BRAND_VERTICALS = [
  "AGRICULTURE",
  "COMMUNICATION",
  "CONSTRUCTION",
  "EDUCATION",
  "ENERGY",
  "ENTERTAINMENT",
  "FINANCIAL",
  "GAMBLING",
  "GOVERNMENT",
  "HEALTHCARE",
  "HOSPITALITY",
  "HUMAN_RESOURCES",
  "INSURANCE",
  "LEGAL",
  "MANUFACTURING",
  "NGO",
  "POLITICAL",
  "POSTAL",
  "PROFESSIONAL",
  "REAL_ESTATE",
  "RETAIL",
  "TECHNOLOGY",
  "TRANSPORTATION"
] as const;
const STOCK_EXCHANGES = ["NONE", "NASDAQ", "NYSE", "AMEX", "AMX", "ASX", "B3", "BME", "BSE", "FRA", "ICEX", "JPX", "JSE", "KRX", "LON", "NSE", "OMX", "SEHK", "SSE", "STO", "SWX", "SZSE", "TSX", "TWSE", "VSE"] as const;

const CAMPAIGN_USECASES = [
  "AGENTS_FRANCHISES",
  "ACCOUNT_NOTIFICATION",
  "CUSTOMER_CARE",
  "DELIVERY_NOTIFICATION",
  "FRAUD_ALERT",
  "HIGHER_EDUCATION",
  "MARKETING",
  "MIXED",
  "POLLING_VOTING",
  "PUBLIC_SERVICE_ANNOUNCEMENT",
  "SECURITY_ALERT",
  "2FA",
  "SOLE_PROPRIETOR"
] as const;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function providerOperationResponse(operation: unknown) {
  const value = asObject(operation);
  if (value.response && typeof value.response === "object") return asObject(value.response);
  try {
    return asObject(JSON.parse(cleanText(value.response_json) || "{}"));
  } catch {
    return {};
  }
}

function pickFields(value: unknown, fields: readonly string[]) {
  const source = asObject(value);
  return Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(source, field)).map((field) => [field, source[field]]));
}

function payloadHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const EDITABLE_BRAND_FIELDS = [
  "country", "displayName", "email", "entityType", "vertical", "companyName", "ein", "phone", "mobilePhone",
  "street", "city", "state", "postalCode", "website", "firstName", "lastName", "businessContactEmail",
  "stockSymbol", "stockExchange", "isReseller", "formattedAddress", "addressAutocompleteSelected", "addressComponents", "lat", "lng"
] as const;
const EDITABLE_CAMPAIGN_FIELDS = [
  "usecase", "description", "messageFlow", "sample1", "sample2", "sample3", "sample4", "sample5",
  "subscriberOptin", "subscriberOptout", "subscriberHelp", "optinKeywords", "optinMessage", "optoutKeywords",
  "optoutMessage", "helpKeywords", "helpMessage", "embeddedLink", "embeddedLinkSample", "embeddedPhone",
  "numberPool", "directLending", "ageGated", "termsAndConditions", "termsAndConditionsLink", "privacyPolicyLink",
  "autoRenewal", "enabledFeatures", "featuresConfirmed", "consentAcknowledged", "standardizationVersion",
  "messageFlowConfirmed", "selectedNumberSearch", "selectedNumberAreaCode"
] as const;

function editableBrand(value: unknown) {
  const editable = { ...pickFields(value, EDITABLE_BRAND_FIELDS), ...(!LIVE_MODE() ? pickFields(value, ["mock"]) : {}) };
  // Public profiles intentionally expose only ***last4. Wizard autosave sends
  // its whole visible model, so a mask must never overwrite encrypted legal data.
  if (/^\*{3,}\d{4}$/.test(cleanText(editable.ein))) delete editable.ein;
  return editable;
}

function editableCampaign(value: unknown) {
  return { ...pickFields(value, EDITABLE_CAMPAIGN_FIELDS), ...(!LIVE_MODE() ? pickFields(value, ["brandId", "mock"]) : {}) };
}

function changesStoredFields(current: unknown, patch: JsonObject) {
  const stored = asObject(current);
  return Object.entries(patch).some(([key, value]) => JSON.stringify(stored[key] ?? null) !== JSON.stringify(value ?? null));
}

function param(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function normalizeEnum(value: unknown, allowed: readonly string[], fallback = "") {
  const raw = cleanText(value).toUpperCase();
  return allowed.includes(raw) ? raw : fallback;
}

function normalizeBoolean(value: unknown, fallback = false) {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function nonEmpty(value: unknown) {
  return cleanText(value).length > 0;
}

function addDecimal(left: string, right: string) {
  const parts = [left, right].map((value) => cleanText(value || "0").match(/^(-?)(\d+)(?:\.(\d+))?$/));
  if (!parts[0] || !parts[1]) return left || right || "0";
  const scale = Math.max(parts[0][3]?.length || 0, parts[1][3]?.length || 0);
  const integer = (match: RegExpMatchArray) => {
    const sign = match[1] === "-" ? -1n : 1n;
    return sign * BigInt(`${match[2]}${(match[3] || "").padEnd(scale, "0")}`);
  };
  const total = integer(parts[0]) + integer(parts[1]);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  if (!scale) return `${negative ? "-" : ""}${digits}`;
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") || "0";
}

function normalizeWebsite(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}

const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

export type PolicyUrlResolvedAddress = {
  address: string;
  family: 4 | 6;
};

type PolicyUrlResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
type PolicyUrlRequester = (url: URL, pinnedAddress: PolicyUrlResolvedAddress) => Promise<number>;
type HttpsRequestImplementation = (options: HttpsRequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export type PolicyUrlVerificationDependencies = {
  resolve?: PolicyUrlResolver;
  request?: PolicyUrlRequester;
};

export function isPublicPolicyAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_IPV4.check(address, "ipv4");
  if (family === 6) return !NON_PUBLIC_IPV6.check(address, "ipv6");
  return false;
}

export function requestPinnedPolicyUrl(
  url: URL,
  pinnedAddress: PolicyUrlResolvedAddress,
  requestImpl: HttpsRequestImplementation = httpsRequest as HttpsRequestImplementation
) {
  return new Promise<number>((resolve, reject) => {
    const pinnedLookup = (hostname: string, options: unknown, callbackValue?: unknown) => {
      const callback = (typeof options === "function" ? options : callbackValue) as (...args: unknown[]) => void;
      const lookupOptions = typeof options === "object" && options != null ? options as { all?: boolean } : {};
      if (hostname.toLowerCase() !== url.hostname.toLowerCase()) {
        const error = Object.assign(new Error("Pinned policy request attempted to resolve a different hostname."), { code: "ENOTFOUND" });
        callback(error);
        return;
      }
      if (lookupOptions.all) {
        callback(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }]);
        return;
      }
      callback(null, pinnedAddress.address, pinnedAddress.family);
    };

    let request: ClientRequest;
    try {
      request = requestImpl({
        protocol: "https:",
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        rejectUnauthorized: true,
        agent: false,
        family: pinnedAddress.family,
        lookup: pinnedLookup,
        signal: AbortSignal.timeout(8_000),
        headers: {
          Host: url.host,
          Range: "bytes=0-1024",
          "User-Agent": "FirstMate-10DLC-Policy-Validator/1.0"
        }
      }, (response) => {
        const statusCode = Number(response.statusCode || 0);
        resolve(statusCode);
        response.destroy();
      });
    } catch (error) {
      reject(error);
      return;
    }
    request.once("error", reject);
    request.end();
  });
}

export async function verifyPublicPolicyUrl(
  value: unknown,
  website: unknown,
  label: string,
  dependencies: PolicyUrlVerificationDependencies = {}
) {
  const normalized = normalizeWebsite(value);
  const businessWebsite = normalizeWebsite(website);
  if (!normalized || !businessWebsite) throw badRequest("policy_url_invalid", `${label} and the business website must be valid public HTTPS URLs.`);
  const url = new URL(normalized);
  const websiteUrl = new URL(businessWebsite);
  if (url.protocol !== "https:" || websiteUrl.protocol !== "https:" || url.hostname !== websiteUrl.hostname
    || url.username || url.password || websiteUrl.username || websiteUrl.password) {
    throw badRequest("policy_url_invalid", `${label} must use HTTPS on the registered business website.`);
  }
  try {
    const resolver = dependencies.resolve || (async (hostname: string) => await lookup(hostname, { all: true, verbatim: true }));
    const resolved = await resolver(url.hostname);
    const addresses = resolved.map((entry) => {
      const family = isIP(entry.address);
      return { address: entry.address, family };
    });
    if (!addresses.length || addresses.some((entry) => (entry.family !== 4 && entry.family !== 6) || !isPublicPolicyAddress(entry.address))) {
      throw badRequest("policy_url_invalid", `${label} must resolve to a public internet address.`);
    }
    const pinnedAddress = addresses[0] as PolicyUrlResolvedAddress;
    const requester = dependencies.request || requestPinnedPolicyUrl;
    const status = await requester(url, pinnedAddress);
    if (status < 200 || status >= 300) {
      throw badRequest("policy_url_unreachable", `${label} must be publicly accessible before campaign submission.`, { status });
    }
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw badRequest("policy_url_unreachable", `${label} could not be verified as publicly accessible.`);
  }
}

function normalizePhone(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  const isValidNanp = (digits: string) => /^[2-9]\d{9}$/.test(digits);
  const compact = raw.replace(/[^\d+]/g, "");
  if (/^\+1\d{10}$/.test(compact)) return isValidNanp(compact.slice(2)) ? compact : "";
  if (/^\+[2-9]\d{7,14}$/.test(compact)) return compact;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return isValidNanp(digits) ? `+1${digits}` : "";
  if (digits.length === 11 && digits.startsWith("1")) return isValidNanp(digits.slice(1)) ? `+${digits}` : "";
  return "";
}

function normalizeAreaCode(value: unknown) {
  const digits = cleanText(value).replace(/\D/g, "");
  return /^[2-9]\d{2}$/.test(digits) ? digits : "";
}

function mockAvailableNumbers(areaCode: string) {
  const cityByAreaCode: Record<string, string> = {
    "201": "Jersey City",
    "202": "Washington",
    "206": "Seattle",
    "212": "New York",
    "213": "Los Angeles",
    "312": "Chicago",
    "415": "San Francisco",
    "512": "Austin",
    "602": "Phoenix",
    "702": "Las Vegas",
    "801": "Salt Lake City"
  };
  const city = cityByAreaCode[areaCode] || "Local";
  return [204, 237, 268, 329, 374, 428].map((prefix, index) => {
    const line = String(1000 + (index * 137)).padStart(4, "0");
    const phoneNumber = `+1${areaCode}${prefix}${line}`;
    return {
      phone_number: phoneNumber,
      display_number: `(${areaCode}) ${prefix}-${line}`,
      locality: city,
      region: "US",
      country_code: "US",
      features: ["sms", "mms"],
      monthly_cost: "1.00",
      setup_cost: "0.00",
      mock: true
    };
  });
}

function providerData(payload: unknown) {
  const obj = asObject(payload);
  return asObject(obj.data || obj);
}

function providerId(payload: unknown, keys: string[]) {
  const data = providerData(payload);
  for (const key of keys) {
    const value = cleanText(data[key]);
    if (value) return value;
  }
  return "";
}

function providerStatus(payload: unknown, keys: string[], fallback = "") {
  const data = providerData(payload);
  for (const key of keys) {
    const value = cleanText(data[key]);
    if (value) return value.toLowerCase();
  }
  return fallback;
}

function brandReadyForCampaignStatus(status: unknown) {
  return ["verified", "vetted_verified", "ok", "approved"].includes(cleanText(status).toLowerCase());
}

function smsComplianceProfileIsMock(profile: SmsComplianceProfile) {
  void profile;
  return !LIVE_MODE();
}

function telnyxErrorDetails(error: unknown) {
  return error instanceof TelnyxError
    ? { message: error.message, statusCode: error.statusCode, details: error.details }
    : { message: error instanceof Error ? error.message : String(error) };
}

function comparableBrandField(key: string, value: unknown) {
  if (["phone", "mobilePhone"].includes(key)) return normalizePhone(value);
  if (key === "website") return normalizeWebsite(value).toLowerCase();
  if (key === "ein") return cleanText(value).replace(/\D/g, "");
  if (["email", "businessContactEmail"].includes(key)) return cleanText(value).toLowerCase();
  if (["country", "entityType", "vertical", "state", "stockSymbol", "stockExchange"].includes(key)) return cleanText(value).toUpperCase();
  if (key === "isReseller") return normalizeBoolean(value, false);
  return cleanText(value);
}

async function reconcileAmbiguousBrand(client: ReturnType<typeof createTelnyxClient>, payload: JsonObject, operation: JsonObject) {
  const listed = await client.list10DlcBrands(cleanText(payload.displayName), cleanText(payload.entityType));
  const createdCutoff = Date.parse(cleanText(operation.created_at)) - 10 * 60_000;
  const keys = ["country", "displayName", "email", "entityType", "vertical", "companyName", "ein", "phone", "mobilePhone", "street", "city", "state", "postalCode", "website", "firstName", "lastName", "businessContactEmail", "stockSymbol", "stockExchange", "isReseller"];
  const matches: unknown[] = [];
  for (const summary of listed) {
    const summaryCreated = Date.parse(cleanText(summary.createdAt));
    if (Number.isFinite(summaryCreated) && Number.isFinite(createdCutoff) && summaryCreated < createdCutoff) continue;
    const brandId = providerId(summary, ["brandId", "id"]);
    if (!brandId) continue;
    const response = await client.get10DlcBrand(brandId);
    const candidate = providerData(response);
    const exact = keys.every((key) => {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return true;
      return comparableBrandField(key, candidate[key]) === comparableBrandField(key, payload[key]);
    });
    if (exact) matches.push(response);
  }
  return matches.length === 1 ? matches[0] : null;
}

export async function recordBrandRegistrationFee(organizationId: string, brandId: string, profileId: string, entityType = "", soleProprietorVerified = false) {
  if (!LIVE_MODE() || !brandId) return;
  const soleProprietor = cleanText(entityType).toUpperCase() === "SOLE_PROPRIETOR";
  if (soleProprietor && !soleProprietorVerified) return;
  const amount = soleProprietor
    ? env.telnyxSoleProprietorBrandRegistrationFeeUsd
    : env.telnyxStandardBrandRegistrationFeeUsd;
  (await createUsageEvent({
    organization_id: organizationId, provider: "telnyx", provider_message_id: brandId,
    direction: "brand_registration", segments: 0, amount, currency: "USD",
    event_key: `telnyx:brand_registration:${brandId}`,
    metadata: {
      compliance_profile_id: profileId,
      charge_kind: "10dlc_brand_registration",
      entity_type: soleProprietor ? "SOLE_PROPRIETOR" : cleanText(entityType).toUpperCase(),
      source: "telnyx_documented_fee"
    }
  }));
}

export async function recordCampaignRegistrationFee(organizationId: string, campaignId: string, profileId: string, qualification: unknown, cost: unknown) {
  if (!LIVE_MODE() || !campaignId) return;
  const qualificationData = providerData(qualification);
  const costData = providerData(cost);
  const amount = cleanText(qualificationData.quarterlyFee || costData.upFrontCost);
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new Error("Telnyx did not return the campaign's upfront registration cost; the charge cannot be metered safely.");
  (await createUsageEvent({
    organization_id: organizationId, provider: "telnyx", provider_message_id: campaignId,
    direction: "campaign_subscription_initial", segments: 0, amount, currency: "USD",
    event_key: `telnyx:campaign_registration:${campaignId}`,
    metadata: {
      compliance_profile_id: profileId, charge_kind: "10dlc_campaign_subscription_initial_quarter",
      monthly_fee: qualificationData.monthlyFee || costData.monthlyCost,
      quarterly_fee: qualificationData.quarterlyFee,
      annual_fee: qualificationData.annualFee,
      prepaid_months: 3
    }
  }));
  (await createUsageEvent({
    organization_id: organizationId, provider: "telnyx", provider_message_id: campaignId,
    direction: "campaign_review", segments: 0, amount: env.telnyxCampaignReviewFeeUsd, currency: "USD",
    event_key: `telnyx:campaign_review:initial:${campaignId}`,
    metadata: { compliance_profile_id: profileId, charge_kind: "10dlc_campaign_review", review_kind: "initial" }
  }));
  const monthlyAmount = cleanText(qualificationData.monthlyFee || costData.monthlyCost);
  if (/^\d+(?:\.\d+)?$/.test(monthlyAmount)) {
    const recurringStartsAt = new Date();
    recurringStartsAt.setUTCMonth(recurringStartsAt.getUTCMonth() + 3);
    (await upsertBillingCommitment({
      organization_id: organizationId, provider: "telnyx", resource_type: "campaign", resource_id: campaignId,
      amount: monthlyAmount, currency: "USD", billing_interval: "month", status: "active",
      starts_at: recurringStartsAt.toISOString(),
      metadata: {
        compliance_profile_id: profileId,
        provider_price_source: "10dlc_qualification",
        initial_quarter_prepaid: true,
        requires_invoice_reconciliation: true
      }
    }));
  }
}

function validateBrandDraft(brandInput: JsonObject) {
  const entityType = normalizeEnum(brandInput.entityType || brandInput.entity_type, BRAND_ENTITY_TYPES, "");
  const missing = [];
  if (!entityType) missing.push("entityType");
  for (const key of ["displayName", "email", "vertical", "country"]) {
    if (!nonEmpty(brandInput[key])) missing.push(key);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanText(brandInput.email))) missing.push("emailFormat");
  if (!/^[A-Z]{2}$/.test(cleanText(brandInput.country).toUpperCase())) missing.push("countryFormat");
  if (!normalizeEnum(brandInput.vertical, BRAND_VERTICALS, "")) missing.push("vertical");
  for (const [key, max] of [["displayName", 100], ["email", 100], ["companyName", 100], ["firstName", 100], ["lastName", 100], ["street", 100], ["city", 100], ["website", 100]] as const) {
    if (cleanText(brandInput[key]).length > max) missing.push(`${key}MaxLength`);
  }
  if (cleanText(brandInput.state) && !/^[A-Za-z]{2}$/.test(cleanText(brandInput.state))) missing.push("stateFormat");
  if (cleanText(brandInput.postalCode) && !/^\d{5}(?:-\d{4})?$/.test(cleanText(brandInput.postalCode))) missing.push("postalCodeFormat");
  if (entityType && entityType !== "SOLE_PROPRIETOR") {
    for (const key of ["companyName", "ein", "street", "city", "state", "postalCode"]) {
      if (!nonEmpty(brandInput[key])) missing.push(key);
    }
    if (!normalizePhone(brandInput.phone)) missing.push("phone");
    if (!normalizeWebsite(brandInput.website)) missing.push("website");
    if (!/^\d{2}-?\d{7}$/.test(cleanText(brandInput.ein))) missing.push("einFormat");
  }
  if (entityType === "SOLE_PROPRIETOR") {
    for (const key of ["firstName", "lastName", "street", "city", "state", "postalCode"]) {
      if (!nonEmpty(brandInput[key])) missing.push(key);
    }
    if (!normalizePhone(brandInput.phone)) missing.push("phone");
    if (!normalizePhone(brandInput.mobilePhone)) missing.push("mobilePhone");
  }
  if (entityType === "PUBLIC_PROFIT" && !nonEmpty(brandInput.businessContactEmail)) {
    missing.push("businessContactEmail");
  }
  if (entityType === "PUBLIC_PROFIT" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanText(brandInput.businessContactEmail))) missing.push("businessContactEmailFormat");
  if (entityType === "PUBLIC_PROFIT") {
    if (!nonEmpty(brandInput.stockSymbol)) missing.push("stockSymbol");
    if (!normalizeEnum(brandInput.stockExchange, STOCK_EXCHANGES, "") || cleanText(brandInput.stockExchange).toUpperCase() === "NONE") missing.push("stockExchange");
  }
  return {
    ok: missing.length === 0,
    missing,
    entity_type: entityType
  };
}

function validateCampaignDraft(campaignInput: JsonObject) {
  const usecase = normalizeEnum(campaignInput.usecase, CAMPAIGN_USECASES, "");
  const missing = [];
  for (const key of ["description", "messageFlow", "sample1", "sample2", "helpMessage", "optoutMessage", "privacyPolicyLink", "termsAndConditionsLink"]) {
    if (!nonEmpty(campaignInput[key])) missing.push(key);
  }
  if (!usecase) missing.push("usecase");
  const enabledFeatures = Array.isArray(campaignInput.enabledFeatures) ? campaignInput.enabledFeatures.map(cleanText) : [];
  if (["AGENTS_FRANCHISES", "MIXED", "SOLE_PROPRIETOR"].includes(usecase) && enabledFeatures.length === 0) missing.push("enabledFeatures");
  if (enabledFeatures.includes("customer_growth") && !["AGENTS_FRANCHISES", "MIXED", "MARKETING", "SOLE_PROPRIETOR"].includes(usecase)) missing.push("usecaseFeatureMismatch");
  if (enabledFeatures.includes("operations") && !["AGENTS_FRANCHISES", "MIXED", "SOLE_PROPRIETOR"].includes(usecase)) missing.push("usecaseFeatureMismatch");
  if (normalizeBoolean(campaignInput.subscriberOptin, true) && !nonEmpty(campaignInput.optinMessage)) {
    missing.push("optinMessage");
  }
  if (normalizeBoolean(campaignInput.embeddedLink, false) && !nonEmpty(campaignInput.embeddedLinkSample)) {
    missing.push("embeddedLinkSample");
  }
  if (LIVE_MODE() && campaignInput.consentAcknowledged !== true) missing.push("consentAcknowledged");
  if (LIVE_MODE() && campaignInput.messageFlowConfirmed !== true) missing.push("messageFlowConfirmed");
  if (campaignInput.featuresConfirmed !== true) missing.push("featuresConfirmed");
  if (campaignInput.termsAndConditions !== true) missing.push("termsAndConditions");
  if (campaignInput.subscriberOptout !== true) missing.push("subscriberOptout");
  if (campaignInput.subscriberHelp !== true) missing.push("subscriberHelp");
  if (!/\bSTOP\b/i.test(cleanText(campaignInput.optoutKeywords))) missing.push("optoutKeywords");
  if (!/\bHELP\b/i.test(cleanText(campaignInput.helpKeywords))) missing.push("helpKeywords");
  const optinMessage = cleanText(campaignInput.optinMessage);
  const optoutMessage = cleanText(campaignInput.optoutMessage);
  const helpMessage = cleanText(campaignInput.helpMessage);
  const rates = /\b(?:msg|msgs|message|messages)\.?\s*(?:&|and)\s*data rates may apply/i;
  const frequency = /(?:message|msg)\s*(?:frequency|freq)|(?:messages?|msgs?)\s+(?:per|each)|frequency varies|(?:up to\s+)?\d+\s*(?:messages?|msgs?)\s*(?:\/|per)\s*[a-z]+/i;
  const support = /[^\s@]+@[^\s@]+\.[^\s@]+/i;
  const supportPhone = /\+?\d[\d().\s-]{7,}\d/;
  if (!/\bSTOP\b/i.test(optinMessage) || !/\bHELP\b/i.test(optinMessage) || !rates.test(optinMessage) || !frequency.test(optinMessage)) missing.push("optinMessageCompliance");
  if (!/\bSTART\b/i.test(optoutMessage) || !/unsubscribed|opted out|no (?:more|further) messages/i.test(optoutMessage)) missing.push("optoutMessageCompliance");
  if (!/\bSTOP\b/i.test(helpMessage) || (!support.test(helpMessage) && !supportPhone.test(helpMessage)) || !rates.test(helpMessage) || !frequency.test(helpMessage)) missing.push("helpMessageCompliance");
  for (const key of ["sample1", "sample2", "sample3", "sample4", "sample5", "helpMessage", "optinMessage", "optoutMessage"]) {
    if (cleanText(campaignInput[key]).length > 255) missing.push(`${key}MaxLength`);
  }
  if (cleanText(campaignInput.messageFlow).length > 2048) missing.push("messageFlowMaxLength");
  return {
    ok: missing.length === 0,
    missing,
    usecase
  };
}

function brandPayload(profile: SmsComplianceProfile) {
  const brand = asObject(profile.brand);
  const payload: JsonObject = {
    country: cleanText(brand.country || "US").toUpperCase(),
    displayName: cleanText(brand.displayName),
    email: cleanText(brand.email),
    entityType: normalizeEnum(brand.entityType || brand.entity_type, BRAND_ENTITY_TYPES, ""),
    vertical: normalizeEnum(brand.vertical, BRAND_VERTICALS, ""),
    companyName: cleanText(brand.companyName),
    ein: cleanText(brand.ein),
    phone: normalizePhone(brand.phone),
    mobilePhone: normalizePhone(brand.mobilePhone),
    street: cleanText(brand.street),
    city: cleanText(brand.city),
    state: cleanText(brand.state).toUpperCase(),
    postalCode: cleanText(brand.postalCode),
    website: normalizeWebsite(brand.website),
    firstName: cleanText(brand.firstName),
    lastName: cleanText(brand.lastName),
    businessContactEmail: cleanText(brand.businessContactEmail),
    stockSymbol: cleanText(brand.stockSymbol).toUpperCase(),
    stockExchange: normalizeEnum(brand.stockExchange, STOCK_EXCHANGES, ""),
    isReseller: normalizeBoolean(brand.isReseller, false),
    webhookURL: env.telnyxWebhookUrl,
    ...(env.telnyxWebhookFailoverUrl ? { webhookFailoverURL: env.telnyxWebhookFailoverUrl } : {}),
    ...(LIVE_MODE() ? {} : { mock: true })
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === "" || payload[key] == null) delete payload[key];
  }
  return payload;
}

function brandSubmissionContext(profile: SmsComplianceProfile, payload: JsonObject) {
  const refs = asObject(profile.provider_refs);
  const existingBrandId = cleanText(refs.telnyx_brand_id);
  const revision = payloadHash(payload).slice(0, 12);
  if (existingBrandId && /failed|rejected|unverified/.test(cleanText(profile.brand_status).toLowerCase())) {
    return { existingBrandId, correcting: true, revision, operationType: `brand_update_${revision}` };
  }
  const storedOperationType = cleanText(refs.telnyx_brand_submission_operation_type);
  const storedRevision = cleanText(refs.telnyx_brand_submission_revision);
  if (existingBrandId && storedOperationType && storedRevision) {
    return {
      existingBrandId,
      correcting: storedOperationType.startsWith("brand_update_"),
      revision: storedRevision,
      operationType: storedOperationType
    };
  }
  return { existingBrandId, correcting: false, revision, operationType: "brand_submission" };
}

function campaignPayload(profile: SmsComplianceProfile, referenceRevision = "initial") {
  const campaign = asObject(profile.campaign);
  const providerRefs = asObject(profile.provider_refs);
  const brandId = cleanText(campaign.brandId || providerRefs.telnyx_brand_id || providerRefs.tcr_brand_id);
  const payload: JsonObject = {
    brandId,
    usecase: cleanText(campaign.usecase || "CUSTOMER_CARE").toUpperCase(),
    description: cleanText(campaign.description),
    messageFlow: cleanText(campaign.messageFlow),
    sample1: cleanText(campaign.sample1),
    sample2: cleanText(campaign.sample2),
    sample3: cleanText(campaign.sample3),
    sample4: cleanText(campaign.sample4),
    sample5: cleanText(campaign.sample5),
    subscriberOptin: normalizeBoolean(campaign.subscriberOptin, true),
    subscriberOptout: normalizeBoolean(campaign.subscriberOptout, true),
    subscriberHelp: normalizeBoolean(campaign.subscriberHelp, true),
    optinKeywords: cleanText(campaign.optinKeywords || "START"),
    optinMessage: cleanText(campaign.optinMessage),
    optoutKeywords: cleanText(campaign.optoutKeywords || "STOP"),
    optoutMessage: cleanText(campaign.optoutMessage),
    helpKeywords: cleanText(campaign.helpKeywords || "HELP"),
    helpMessage: cleanText(campaign.helpMessage),
    embeddedLink: normalizeBoolean(campaign.embeddedLink, false),
    embeddedLinkSample: cleanText(campaign.embeddedLinkSample),
    embeddedPhone: normalizeBoolean(campaign.embeddedPhone, false),
    numberPool: normalizeBoolean(campaign.numberPool, false),
    directLending: normalizeBoolean(campaign.directLending, false),
    ageGated: normalizeBoolean(campaign.ageGated, false),
    termsAndConditions: normalizeBoolean(campaign.termsAndConditions, true),
    termsAndConditionsLink: cleanText(campaign.termsAndConditionsLink),
    privacyPolicyLink: cleanText(campaign.privacyPolicyLink),
    referenceId: `fm_${payloadHash(`${profile.external_organization_id}:${profile.id}`).slice(0, 16)}_${cleanText(referenceRevision).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "initial"}`,
    autoRenewal: normalizeBoolean(campaign.autoRenewal, true),
    webhookURL: env.telnyxWebhookUrl,
    ...(env.telnyxWebhookFailoverUrl ? { webhookFailoverURL: env.telnyxWebhookFailoverUrl } : {})
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === "" || payload[key] == null) delete payload[key];
  }
  return payload;
}

function campaignSubmissionContext(profile: SmsComplianceProfile) {
  const refs = asObject(profile.provider_refs);
  const previousCampaignId = cleanText(refs.telnyx_campaign_id);
  const adverse = /failed|rejected|expired/.test(cleanText(profile.campaign_status).toLowerCase());
  if (previousCampaignId && adverse) {
    const comparable = campaignPayload(profile, "replacement");
    delete comparable.referenceId;
    const revision = payloadHash({ previous_campaign_id: previousCampaignId, campaign: comparable }).slice(0, 12);
    return {
      replacement: true,
      previousCampaignId,
      revision,
      operationType: `campaign_replacement_${revision}`,
      payload: campaignPayload(profile, revision)
    };
  }
  const storedOperationType = cleanText(refs.telnyx_campaign_submission_operation_type);
  const storedRevision = cleanText(refs.telnyx_campaign_submission_revision);
  if (previousCampaignId && storedOperationType && storedRevision) {
    return {
      replacement: storedOperationType.startsWith("campaign_replacement_"),
      previousCampaignId: cleanText(refs.telnyx_campaign_submission_previous_campaign_id),
      revision: storedRevision,
      operationType: storedOperationType,
      payload: campaignPayload(profile, storedRevision)
    };
  }
  return { replacement: false, previousCampaignId: "", revision: "initial", operationType: "campaign_submission", payload: campaignPayload(profile) };
}

function campaignSubmissionProfilePatch(
  profile: SmsComplianceProfile,
  context: ReturnType<typeof campaignSubmissionContext>,
  telnyxCampaignId: string,
  tcrCampaignId = ""
) {
  const refs = asObject(profile.provider_refs);
  const previousTelnyxIds = Array.isArray(refs.previous_telnyx_campaign_ids) ? refs.previous_telnyx_campaign_ids.map(cleanText).filter(Boolean) : [];
  const previousTcrIds = Array.isArray(refs.previous_tcr_campaign_ids) ? refs.previous_tcr_campaign_ids.map(cleanText).filter(Boolean) : [];
  const oldTcrCampaignId = cleanText(refs.tcr_campaign_id);
  return {
    status: "campaign_submitted",
    campaign_status: "submitted",
    phone_number_campaign_status: context.replacement ? "replacement_pending" : "unassigned",
    phone_number_campaign_id: context.replacement ? cleanText(profile.phone_number_campaign_id || context.previousCampaignId) : "",
    provider_refs: {
      telnyx_campaign_id: telnyxCampaignId,
      tcr_campaign_id: tcrCampaignId,
      telnyx_campaign_submission_operation_type: context.operationType,
      telnyx_campaign_submission_revision: context.revision,
      telnyx_campaign_submission_previous_campaign_id: context.previousCampaignId,
      ...(context.replacement ? {
        previous_telnyx_campaign_ids: [...new Set([...previousTelnyxIds, context.previousCampaignId].filter(Boolean))],
        previous_tcr_campaign_ids: [...new Set([...previousTcrIds, oldTcrCampaignId].filter(Boolean))]
      } : {})
    }
  };
}

function profileValidation(profile: SmsComplianceProfile) {
  const brand = validateBrandDraft(asObject(profile.brand));
  const campaign = validateCampaignDraft(asObject(profile.campaign));
  const selectedNumber = asObject(profile.campaign).selectedNumber;
  return {
    brand,
    campaign,
    number: {
      ok: Boolean(normalizePhone(selectedNumber)),
      selected_number: normalizePhone(selectedNumber)
    },
    ready_for_brand_submission: brand.ok,
    ready_for_campaign_submission: brand.ok && campaign.ok && Boolean(normalizePhone(selectedNumber)) && Boolean(cleanText(asObject(profile.provider_refs).telnyx_brand_id || asObject(profile.provider_refs).tcr_brand_id))
  };
}

function validateCampaignContent(profile: SmsComplianceProfile) {
  const campaign = asObject(profile.campaign);
  const brandName = cleanText(asObject(profile.brand).displayName || asObject(profile.brand).companyName).toLowerCase();
  const samples = [campaign.sample1, campaign.sample2, campaign.sample3, campaign.sample4, campaign.sample5].map(cleanText).filter(Boolean);
  const issues: string[] = [];
  if (brandName && samples.some((sample) => !sample.toLowerCase().includes(brandName))) issues.push("Every sample message must identify the registered business display name.");
  if (samples.some((sample) => !/\bSTOP\b/i.test(sample))) issues.push("Every sample message must explain how to opt out with STOP.");
  if (!/opt[ -]?in|consent|agree/i.test(cleanText(campaign.messageFlow))) issues.push("The message flow must clearly explain how recipients opt in or consent.");
  const autoresponses = smsAutoresponsePlan(profile);
  if (!autoresponses.ok) issues.push(`START/STOP/HELP response requirements are incomplete: ${autoresponses.issues.join(", ")}.`);
  return { ok: issues.length === 0, issues };
}

async function requireSmsSettingsAccess(request: Parameters<typeof requirePlatformAuth>[0], orgId: string, csrf = false) {
  const context = await requirePlatformAuth(request, { orgId, csrf, permission: "manage_company_settings" });
  if (!(await isAppFlagEnabled(orgId, "platform", "sms_settings"))) {
    throw forbidden("app_flag_disabled", "SMS settings are not enabled for this organization.");
  }
  return context;
}

async function profileForRequest(orgId: string, profileId: string) {
  const organization = await ensureMessagingOrganization(orgId);
  const profile = await readSmsComplianceProfile(organization.id, profileId);
  return { organization, profile };
}

function providerProfileName(profile: SmsComplianceProfile) {
  return `FirstMate ${profile.external_organization_id} ${profile.id}`.slice(0, 128);
}

function normalizedAutoresponseConfig(config: TelnyxAutorespConfig) {
  return {
    id: cleanText(config.id),
    op: normalizeTelnyxAutoresponseOp(config.op),
    keywords: [...new Set((Array.isArray(config.keywords) ? config.keywords : []).map((keyword) => cleanText(keyword).toUpperCase()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right)),
    country_code: cleanText(config.country_code).toUpperCase(),
    resp_text: cleanText(config.resp_text)
  };
}

function autoresponseConfigMatches(config: TelnyxAutorespConfig, desired: DesiredSmsAutoresponse) {
  const normalized = normalizedAutoresponseConfig(config);
  return normalized.op === desired.op
    && normalized.country_code === desired.country_code
    && normalized.resp_text === desired.resp_text
    && JSON.stringify(normalized.keywords) === JSON.stringify(desired.keywords);
}

function autoresponseOperationType(op: DesiredSmsAutoresponse["op"]) {
  return `messaging_autoresponse_${op}`;
}

async function listOrganizationAutoresponses(
  client: ReturnType<typeof createTelnyxClient>,
  messagingProfileId: string
) {
  return (await client.listMessagingProfileAutorespConfigs(messagingProfileId, "US"))
    .map((config) => normalizedAutoresponseConfig(config) as TelnyxAutorespConfig);
}

async function reconcileOrganizationAutoresponses(
  profile: SmsComplianceProfile,
  messagingProfileId: string,
  client: ReturnType<typeof createTelnyxClient>
) {
  const plan = smsAutoresponsePlan(profile);
  if (!plan.ok) {
    throw badRequest(
      "autoresponse_profile_incomplete",
      "START, STOP, and HELP responses must each contain 20–255 characters before the campaign can be submitted.",
      { missing: plan.issues }
    );
  }

  let currentConfigs = await listOrganizationAutoresponses(client, messagingProfileId);
  const configIds: Record<string, string> = {};

  for (const desired of plan.configs) {
    const operationType = autoresponseOperationType(desired.op);
    const requestHash = payloadHash({ messaging_profile_id: messagingProfileId, ...desired });
    let operation = (await beginProviderOperation({
      organization_id: profile.external_organization_id,
      compliance_profile_id: profile.id,
      operation_type: operationType,
      request_hash: requestHash
    }));
    if (operation.state === "conflict") {
      const previousStatus = cleanText(asObject(operation.operation).status);
      if (["succeeded", "failed"].includes(previousStatus)) {
        (await resetProviderOperationForRetry(profile.external_organization_id, profile.id, operationType, {
          code: "autoresponse_configuration_revised",
          message: "The registered auto-response copy changed before campaign submission."
        }));
        operation = (await beginProviderOperation({
          organization_id: profile.external_organization_id,
          compliance_profile_id: profile.id,
          operation_type: operationType,
          request_hash: requestHash
        }));
      }
    }
    if (operation.state === "conflict") {
      throw conflict("provider_operation_conflict", `A different ${desired.op.toUpperCase()} auto-response reconciliation is unresolved.`);
    }
    if (operation.state === "pending") {
      throw conflict("provider_operation_in_progress", `The ${desired.op.toUpperCase()} auto-response is already being reconciled.`);
    }

    let matches = currentConfigs.filter((config) => config.country_code === "US" && normalizeTelnyxAutoresponseOp(config.op) === desired.op);
    const operationId = cleanText(asObject(operation.operation).id);
    if (matches.length > 1) {
      (await finishProviderOperation(operationId, {
        status: "failed",
        error: { code: "duplicate_autoresponse_configs", op: desired.op, config_ids: matches.map((config) => config.id) }
      }));
      throw conflict(
        "duplicate_autoresponse_configs",
        `Multiple Telnyx ${desired.op.toUpperCase()} auto-response settings exist for this organization and require operator reconciliation.`
      );
    }

    let match = matches[0] || null;
    if (match && !autoresponseConfigMatches(match, desired)) {
      let updateError: unknown = null;
      try {
        await client.updateMessagingProfileAutorespConfig(messagingProfileId, match.id, desired);
      } catch (error) {
        updateError = error;
      }
      try {
        currentConfigs = await listOrganizationAutoresponses(client, messagingProfileId);
      } catch (error) {
        if (updateError) throw updateError;
        throw error;
      }
      matches = currentConfigs.filter((config) => config.country_code === "US" && normalizeTelnyxAutoresponseOp(config.op) === desired.op);
      match = matches.length === 1 && autoresponseConfigMatches(matches[0]!, desired) ? matches[0]! : null;
      if (!match) {
        (await finishProviderOperation(operationId, {
          status: "failed",
          error: updateError ? telnyxErrorDetails(updateError) : { code: "autoresponse_update_not_verified", op: desired.op }
        }));
        if (updateError) throw updateError;
        throw conflict("autoresponse_update_not_verified", `Telnyx did not confirm the updated ${desired.op.toUpperCase()} auto-response.`);
      }
    }

    if (!match) {
      if (operation.state === "outcome_unknown") {
        throw conflict(
          "provider_operation_outcome_unknown",
          `The prior ${desired.op.toUpperCase()} auto-response create request is still ambiguous. FirstMate will not create a duplicate.`
        );
      }
      if (operation.state === "succeeded") {
        (await resetProviderOperationForRetry(profile.external_organization_id, profile.id, operationType, {
          code: "autoresponse_config_missing",
          provider_id: cleanText(asObject(operation.operation).provider_id)
        }));
        operation = (await beginProviderOperation({
          organization_id: profile.external_organization_id,
          compliance_profile_id: profile.id,
          operation_type: operationType,
          request_hash: requestHash
        }));
      }
      const createOperationId = cleanText(asObject(operation.operation).id);
      let createError: unknown = null;
      try {
        await client.createMessagingProfileAutorespConfig(messagingProfileId, desired);
      } catch (error) {
        createError = error;
      }
      try {
        currentConfigs = await listOrganizationAutoresponses(client, messagingProfileId);
      } catch (error) {
        const unknown = !createError || (createError instanceof TelnyxError && asObject(createError.details).submission_unknown === true);
        (await finishProviderOperation(createOperationId, {
          status: unknown ? "outcome_unknown" : "failed",
          error: telnyxErrorDetails(createError || error)
        }));
        if (createError && !unknown) throw createError;
        throw conflict("provider_operation_outcome_unknown", `Telnyx accepted the ${desired.op.toUpperCase()} auto-response request but its result could not be verified.`);
      }
      matches = currentConfigs.filter((config) => config.country_code === "US" && normalizeTelnyxAutoresponseOp(config.op) === desired.op);
      match = matches.length === 1 && autoresponseConfigMatches(matches[0]!, desired) ? matches[0]! : null;
      if (!match) {
        const unknown = !createError || (createError instanceof TelnyxError && asObject(createError.details).submission_unknown === true);
        (await finishProviderOperation(createOperationId, {
          status: unknown ? "outcome_unknown" : "failed",
          error: createError ? telnyxErrorDetails(createError) : { code: "autoresponse_create_not_visible", op: desired.op }
        }));
        if (createError && !unknown) throw createError;
        throw conflict(
          "provider_operation_outcome_unknown",
          `The ${desired.op.toUpperCase()} auto-response create request could not be reconciled. FirstMate will not create a duplicate.`
        );
      }
    }

    (await finishProviderOperation(cleanText(asObject(operation.operation).id), {
      status: "succeeded",
      provider_id: match.id,
      response: { id: match.id, op: desired.op, country_code: desired.country_code, configuration_hash: requestHash }
    }));
    configIds[desired.op] = match.id;
  }

  return { ...plan, configIds };
}

export async function ensureOrganizationTelnyxAutoresponses(
  profile: SmsComplianceProfile,
  messagingProfileId: string,
  client: ReturnType<typeof createTelnyxClient> = createTelnyxClient()
) {
  if (!messagingProfileId) {
    throw badRequest("messaging_profile_missing", "Create the organization's Telnyx Messaging Profile before configuring keyword responses.");
  }
  const plan = smsAutoresponsePlan(profile);
  try {
    const reconciled = await reconcileOrganizationAutoresponses(profile, messagingProfileId, client);
    const syncedAt = new Date().toISOString();
    const mutation = await mutateSmsComplianceProfileAtomically(profile, (current) => {
      const currentPlan = smsAutoresponsePlan(current);
      if (!currentPlan.ok || currentPlan.hash !== reconciled.hash) {
        return {
          event: {
            type: "messaging_autoresponses_configuration_changed",
            provider: "telnyx",
            messaging_profile_id: messagingProfileId,
            reconciled_hash: reconciled.hash,
            current_hash: currentPlan.hash
          },
          patch: {
            autoresponse_state: {
              ...asObject(current.autoresponse_state),
              status: "pending",
              desired_hash: currentPlan.hash
            }
          },
          result: { configured: false }
        };
      }
      return {
        event: {
          type: "messaging_autoresponses_verified",
          provider: "telnyx",
          messaging_profile_id: messagingProfileId,
          configuration_hash: reconciled.hash,
          config_ids: reconciled.configIds
        },
        patch: {
          autoresponse_state: {
            status: "configured",
            messaging_profile_id: messagingProfileId,
            desired_hash: reconciled.hash,
            applied_hash: reconciled.hash,
            config_ids: reconciled.configIds,
            synced_at: syncedAt
          }
        },
        result: { configured: true }
      };
    });
    if (!mutation.result.configured) {
      throw conflict("autoresponse_configuration_changed", "Campaign keyword-response copy changed during Telnyx reconciliation. Retry with the latest draft.");
    }
    return mutation.profile;
  } catch (error) {
    const unknown = error instanceof PlatformError && error.code === "provider_operation_outcome_unknown";
    const changed = error instanceof PlatformError && error.code === "autoresponse_configuration_changed";
    await mutateSmsComplianceProfileAtomically(profile, (current) => ({
      event: {
        type: "messaging_autoresponses_sync_failed",
        provider: "telnyx",
        messaging_profile_id: messagingProfileId,
        error: telnyxErrorDetails(error)
      },
      patch: {
        autoresponse_state: {
          ...asObject(current.autoresponse_state),
          status: unknown ? "outcome_unknown" : changed ? "pending" : "failed",
          desired_hash: smsAutoresponsePlan(current).hash,
          last_error: telnyxErrorDetails(error)
        },
        status: cleanText(current.status).toLowerCase() === "active" ? "provider_update_pending" : current.status
      },
      result: { configured: false }
    }));
    throw error;
  }
}

export async function ensureOrganizationTelnyxProfile(
  profile: SmsComplianceProfile,
  client: ReturnType<typeof createTelnyxClient> = createTelnyxClient()
) {
  const existingId = cleanText(asObject(profile.provider_refs).telnyx_messaging_profile_id);
  const configuration = {
    name: providerProfileName(profile),
    enabled: true,
    webhook_url: env.telnyxWebhookUrl,
    ...(env.telnyxWebhookFailoverUrl ? { webhook_failover_url: env.telnyxWebhookFailoverUrl } : {}),
    webhook_api_version: "2",
    whitelisted_destinations: ["US"],
    smart_encoding: true,
    mms_transcoding: true,
    daily_spend_limit_enabled: true,
    daily_spend_limit: env.telnyxDailySpendLimit
  };
  if (existingId) {
    await client.updateMessagingProfile(existingId, configuration);
    return { profile, messagingProfileId: existingId };
  }
  const operation = (await beginProviderOperation({
    organization_id: profile.external_organization_id,
    compliance_profile_id: profile.id,
    operation_type: "messaging_profile_creation",
    request_hash: payloadHash(configuration)
  }));
  if (operation.state === "conflict") {
    throw conflict("provider_operation_conflict", "A different Messaging Profile operation already exists for this SMS registration.");
  }
  if (operation.state === "pending") {
    throw conflict("provider_operation_in_progress", "The organization Messaging Profile is already being created.");
  }

  const operationId = cleanText(asObject(operation.operation).id);
  let operationFinalized = operation.state === "succeeded";
  try {
    let messagingProfileId = "";
    let eventType = "messaging_profile_reconciled";

    if (operation.state === "succeeded") {
      messagingProfileId = cleanText(asObject(operation.operation).provider_id);
      if (!messagingProfileId) {
        throw conflict("provider_operation_incomplete", "The existing Messaging Profile operation is missing its provider identifier and requires operator reconciliation.");
      }
      await client.updateMessagingProfile(messagingProfileId, configuration);
      eventType = "messaging_profile_operation_replayed";
    } else {
      const matches = await client.listMessagingProfilesByName(configuration.name, 100);
      if (matches.length > 1) {
        (await finishProviderOperation(operationId, {
          status: "outcome_unknown",
          error: {
            code: "messaging_profile_reconciliation_ambiguous",
            deterministic_name: configuration.name,
            matching_profile_ids: matches.map((entry) => entry.id)
          }
        }));
        operationFinalized = true;
        throw conflict("provider_operation_outcome_unknown", "Multiple Telnyx Messaging Profiles match this organization. FirstMate will not choose one automatically.");
      }

      const existing = matches[0] || null;
      if (existing) {
        messagingProfileId = existing.id;
        await client.updateMessagingProfile(messagingProfileId, configuration);
        eventType = operation.state === "outcome_unknown" ? "messaging_profile_reconciled" : "messaging_profile_reused";
      } else {
        if (operation.state === "outcome_unknown") {
          throw conflict("provider_operation_outcome_unknown", "The interrupted Messaging Profile request is not yet visible in Telnyx. FirstMate will not create a duplicate automatically.");
        }
        const response = await client.createMessagingProfile(configuration);
        messagingProfileId = providerId(response, ["id"]);
        if (!messagingProfileId) {
          throw new TelnyxError("Telnyx accepted the Messaging Profile request without returning an ID.", 502, { submission_unknown: true });
        }
        eventType = "messaging_profile_created";
      }

      (await finishProviderOperation(operationId, {
        status: "succeeded",
        provider_id: messagingProfileId,
        response: { id: messagingProfileId, name: configuration.name }
      }));
      operationFinalized = true;
    }

    const saved = await appendSmsComplianceEvent(profile, {
      type: eventType,
      provider: "telnyx",
      messaging_profile_id: messagingProfileId,
      deterministic_name: configuration.name
    }, { provider_refs: { telnyx_messaging_profile_id: messagingProfileId } });
    return { profile: saved, messagingProfileId };
  } catch (error) {
    if (!operationFinalized && operation.state === "created") {
      const unknown = error instanceof TelnyxError && asObject(error.details).submission_unknown === true;
      (await finishProviderOperation(operationId, { status: unknown ? "outcome_unknown" : "failed", error: telnyxErrorDetails(error) }));
    }
    throw error;
  }
}

function availableNumberView(entry: unknown) {
  const number = asObject(entry);
  const regions = Array.isArray(number.region_information) ? number.region_information.map(asObject) : [];
  const features = Array.isArray(number.features) ? number.features.map((item) => cleanText(asObject(item).name || item)).filter(Boolean) : [];
  const costs = asObject(number.cost_information);
  const phoneNumber = normalizePhone(number.phone_number);
  return {
    phone_number: phoneNumber,
    display_number: phoneNumber,
    locality: cleanText(regions.find((item) => cleanText(item.region_type) === "locality")?.region_name),
    region: cleanText(regions.find((item) => ["administrative_area", "state"].includes(cleanText(item.region_type)))?.region_name || "US"),
    country_code: "US",
    features,
    monthly_cost: cleanText(costs.monthly_cost),
    setup_cost: cleanText(costs.upfront_cost),
    currency: cleanText(costs.currency || "USD"),
    reservable: number.reservable === true,
    quickship: number.quickship === true,
    mock: false
  };
}

function requireDeveloperMessagingSurface() {
  if (env.isProduction || LIVE_MODE()) throw notFound("route_not_found", "This developer messaging route is not available.");
}

export const registerMessagingApi: FastifyPluginAsync = async (app) => {
  app.addHook("onReady", async () => {
    if (LIVE_MODE()) {
      const missing = [
        !env.telnyxApiKey && "TELNYX_API_KEY",
        !env.telnyxWebhookPublicKey && "TELNYX_WEBHOOK_PUBLIC_KEY",
        env.telnyxWebhookPublicKey && !isTelnyxWebhookPublicKeyValid() && "TELNYX_WEBHOOK_PUBLIC_KEY (valid Ed25519 key)",
        env.messagingEncryptionKey.length < 32 && "MESSAGING_ENCRYPTION_KEY (at least 32 characters)",
        !env.smsRequireConsent && "SMS_REQUIRE_CONSENT=true",
        !env.telnyxWebhookUrl.startsWith("https://") && "TELNYX_WEBHOOK_URL (HTTPS)",
        env.isProduction && !process.env.PUBLIC_BASE_URL && "PUBLIC_BASE_URL",
        env.isProduction && (!process.env.PLATFORM_SESSION_SECRET || process.env.PLATFORM_SESSION_SECRET.length < 32) && "PLATFORM_SESSION_SECRET (explicit, at least 32 characters)",
        env.isProduction && !path.isAbsolute(env.messagingStorageRoot) && "MESSAGING_STORAGE_ROOT (absolute path)"
      ].filter(Boolean);
      if (missing.length) throw new Error(`Live SMS is not safely configured. Missing: ${missing.join(", ")}`);
      const storageHealth = await verifyCommunicationsDatabaseWritable();
      app.log.info({
        database_path: storageHealth.databasePath,
        wal_checkpoint: storageHealth.checkpoint
      }, "Messaging storage is writable and migrated");
      startSmsDeliveryWorker();
    }
  });
  app.addHook("onClose", async () => {
    await stopSmsDeliveryWorker();
    (await closeCommunicationsDatabase());
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.includes("/messaging/") || request.url.includes("/sms/")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof TelnyxError) {
      reply.code(error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502);
      return reply.send({ ok: false, error: "telnyx_error", message: error.message, details: error.details });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  await app.register(async (webhookApp) => {
    webhookApp.removeContentTypeParser("application/json");
    webhookApp.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 512 * 1024 }, (_request, body, done) => done(null, body));
    webhookApp.post("/webhooks/telnyx", { bodyLimit: 512 * 1024 }, async (request, reply) => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ""));
      const verification = verifyTelnyxWebhook(
        rawBody,
        request.headers["telnyx-signature-ed25519"],
        request.headers["telnyx-timestamp"]
      );
      if (!verification.ok) {
        reply.code(401);
        return { ok: false, error: verification.reason };
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        reply.code(400);
        return { ok: false, error: "invalid_json" };
      }
      const query = asObject(request.query);
      const deliveryId = cleanText(query.delivery_id);
      const correlatedDeliveryId = verifyTelnyxDeliveryWebhookToken(deliveryId, cleanText(query.delivery_token)) ? deliveryId : "";
      const result = await acceptTelnyxWebhook(body, correlatedDeliveryId);
      return { ok: true, ...result };
    });
  });

  app.get("/", async () => ({
    ok: true,
    api: "messaging",
    provider: "telnyx",
    routes: {
      telnyxConfig: "/telnyx/config",
      telnyxHealth: "/telnyx/health",
      setup: "/organizations/:orgId/sms/setup",
      complianceProfiles: "/organizations/:orgId/sms/compliance-profiles",
      capabilities: "/organizations/:orgId/capabilities",
      conversations: "/organizations/:orgId/conversations",
      messages: "/organizations/:orgId/messages",
      developerTestLog: "/developer/test-messages"
    }
  }));

  app.get("/organizations/:orgId/capabilities", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_projects|manage_sales|send_communications|manage_company_settings" });
    return { ok: true, ...(await communicationCapabilities(orgId, ctx.branchId)) };
  });

  app.get("/organizations/:orgId/sms/consents", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings|send_communications" });
    const query = asObject(request.query);
    return { ok: true, consents: (await listSmsConsents(orgId, cleanText(query.status), query.limit)) };
  });

  app.post("/organizations/:orgId/sms/consents", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings|send_communications" });
    const input = smsConsentSchema.parse(request.body ?? {});
    const phoneNumber = normalizePhone(input.phone_number);
    if (!phoneNumber) throw badRequest("invalid_phone_number", "Enter a valid E.164 SMS recipient number.");
    if (input.purposes.includes("marketing")) {
      if (!["web_form", "written", "imported_with_evidence"].includes(input.source)) {
        throw badRequest("marketing_written_consent_required", "Marketing SMS requires documented prior express written consent.");
      }
      const evidence = asObject(input.evidence);
      if (evidence.checkbox !== true && !cleanText(evidence.signed_document_id) && !cleanText(evidence.consent_record_url)) {
        throw badRequest("marketing_consent_evidence_required", "Marketing consent must include an affirmative checkbox, signed document, or durable consent-record reference.");
      }
      if (!cleanText(evidence.disclosure_text) || !Number.isFinite(Date.parse(cleanText(evidence.consent_obtained_at))) || evidence.not_condition_of_purchase !== true) {
        throw badRequest("marketing_consent_disclosure_required", "Marketing consent evidence must include the disclosure text, consent timestamp, and confirmation that consent was not a condition of purchase.");
      }
    }
    const consent = (await upsertSmsConsent({
      organization_id: orgId,
      phone_number: phoneNumber,
      status: input.status,
      consent_id: input.consent_id,
      contact_id: input.contact_id,
      source: input.source,
      evidence: {
        ...asObject(input.evidence),
        purposes: input.purposes,
        disclosure_version: input.disclosure_version,
        recorded_by_user_id: ctx.userId,
        recorded_from_ip: request.ip
      }
    }));
    reply.code(201);
    return { ok: true, consent };
  });

  app.get("/organizations/:orgId/sms/consent-events", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings|send_communications" });
    const query = asObject(request.query);
    const phoneNumber = cleanText(query.phone_number) ? normalizePhone(query.phone_number) : "";
    if (cleanText(query.phone_number) && !phoneNumber) throw badRequest("invalid_phone_number", "Enter a valid E.164 SMS recipient number.");
    return { ok: true, events: (await listSmsConsentEvents(orgId, phoneNumber, query.limit)) };
  });

  app.get("/organizations/:orgId/sms/usage", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    const query = asObject(request.query);
    const events = (await listUsageEvents(orgId, query));
    const byCurrency: Record<string, { amount: string; segments: number; events: number }> = {};
    const byDirection: Record<string, Record<string, { amount: string; segments: number; events: number }>> = {};
    for (const event of (await listUsageSummaryRows(orgId, query))) {
      const currency = cleanText(event.currency || "USD") || "USD";
      const current = byCurrency[currency] || { amount: "0", segments: 0, events: 0 };
      byCurrency[currency] = {
        amount: addDecimal(current.amount, cleanText(event.amount || "0")),
        segments: current.segments + Number(event.segments || 0),
        events: current.events + 1
      };
      const direction = cleanText(event.direction || "other") || "other";
      const directionCurrency = byDirection[direction] || {};
      const directionCurrent = directionCurrency[currency] || { amount: "0", segments: 0, events: 0 };
      directionCurrency[currency] = {
        amount: addDecimal(directionCurrent.amount, cleanText(event.amount || "0")),
        segments: directionCurrent.segments + Number(event.segments || 0),
        events: directionCurrent.events + 1
      };
      byDirection[direction] = directionCurrency;
    }
    return { ok: true, summary: { by_currency: byCurrency, by_direction: byDirection }, commitments: (await listBillingCommitments(orgId)), events };
  });

  app.get("/organizations/:orgId/conversations", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects|manage_sales|send_communications|manage_company_settings" });
    return { ok: true, conversations: (await listConversations(orgId, asObject(request.query))) };
  });

  app.post("/organizations/:orgId/conversations", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects|manage_sales|send_communications|manage_company_settings" });
    const conversation = (await createConversation(orgId, createConversationSchema.parse(request.body ?? {}), ctx));
    reply.code(201);
    return { ok: true, conversation };
  });

  app.get("/organizations/:orgId/conversations/:conversationId", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects|manage_sales|send_communications|manage_company_settings" });
    return { ok: true, conversation: (await conversationDetail(orgId, param(request.params, "conversationId"))) };
  });

  app.post("/organizations/:orgId/conversations/:conversationId/messages", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects|manage_sales|send_communications|manage_company_settings" });
    const input = sendCommunicationSchema.parse({ ...asObject(request.body), conversation_id: param(request.params, "conversationId") });
    const result = await sendCommunication(orgId, input, ctx);
    reply.code(result.created ? 202 : 200);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/messages", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects|manage_sales|send_communications|manage_company_settings" });
    return { ok: true, messages: (await listMessages(orgId, asObject(request.query))) };
  });

  app.post("/organizations/:orgId/messages", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects|manage_sales|send_communications|manage_company_settings" });
    const result = await sendCommunication(orgId, sendCommunicationSchema.parse(request.body ?? {}), ctx);
    reply.code(result.created ? 202 : 200);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/messages/:messageId", async (request) => {
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects|manage_sales|send_communications|manage_company_settings" });
    return { ok: true, message: (await messageDetail(orgId, param(request.params, "messageId"))) };
  });

  app.get("/developer/test-messages", async (request, reply) => {
    requireDeveloperMessagingSurface();
    const ctx = await requirePlatformAuth(request, { permission: "manage_company_settings" });
    const requestedOrgId = cleanText(asObject(request.query).organization_id || asObject(request.query).organizationId);
    if (requestedOrgId && requestedOrgId !== ctx.orgId) throw forbidden("organization_forbidden", "This session cannot access the requested organization.");
    reply.type("text/html; charset=utf-8");
    return renderCommunicationsDeveloperPage(ctx.orgId);
  });

  app.get("/developer/organizations/:orgId/messages", async (request) => {
    requireDeveloperMessagingSurface();
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    return { ok: true, messages: (await listMessages(orgId, asObject(request.query), true)) };
  });

  app.get("/developer/organizations/:orgId/messages/:messageId", async (request) => {
    requireDeveloperMessagingSurface();
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    return { ok: true, message: (await messageDetail(orgId, param(request.params, "messageId"), true)) };
  });

  app.post("/developer/organizations/:orgId/messages/:messageId/status", async (request) => {
    requireDeveloperMessagingSurface();
    const orgId = param(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const message = await simulateMessageStatus(orgId, param(request.params, "messageId"), simulateCommunicationStatusSchema.parse(request.body ?? {}));
    return { ok: true, message };
  });

  app.post("/developer/organizations/:orgId/inbound", async (request, reply) => {
    requireDeveloperMessagingSurface();
    const orgId = param(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const message = await simulateInboundCommunication(orgId, simulateInboundCommunicationSchema.parse(request.body ?? {}), ctx);
    reply.code(201);
    return { ok: true, message };
  });

  app.get("/telnyx/config", async (request) => {
    await requirePlatformAuth(request, { permission: "manage_company_settings" });
    return {
      ok: true,
      provider: "telnyx",
      configured: Boolean(env.telnyxApiKey),
      live_mode: LIVE_MODE(),
      webhook_url: env.telnyxWebhookUrl,
      webhook_public_key_configured: Boolean(env.telnyxWebhookPublicKey),
      encryption_configured: Boolean(env.messagingEncryptionKey)
    };
  });

  app.get("/telnyx/health", async (request) => {
    await requirePlatformAuth(request, { permission: "manage_company_settings" });
    const client = createTelnyxClient();
    const profiles = await client.listMessagingProfiles(10);
    return {
      ok: true,
      provider: "telnyx",
      connected: true,
      messaging_profile_count: profiles.length,
      webhooks: (await webhookInboxStats("telnyx"))
    };
  });

  app.get("/sms/10dlc/options", async () => ({
    ok: true,
    brand_entity_types: BRAND_ENTITY_TYPES,
    brand_verticals: BRAND_VERTICALS,
    stock_exchanges: STOCK_EXCHANGES,
    campaign_usecases: CAMPAIGN_USECASES,
    defaults: {
      brand: { country: "US", entityType: "PRIVATE_PROFIT", vertical: "CONSTRUCTION" },
      campaign: {
        usecase: "AGENTS_FRANCHISES",
        subscriberOptin: true,
        subscriberOptout: true,
        subscriberHelp: true,
        optinKeywords: "START",
        optoutKeywords: "STOP",
        helpKeywords: "HELP",
        termsAndConditions: true
      }
    }
  }));

  app.get("/organizations/:orgId/sms/setup", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId);
    const organization = await ensureMessagingOrganization(orgId);
    const profiles = await listSmsComplianceProfiles(organization.id);
    return {
      ok: true,
      organization: publicMessagingOrganization(organization),
      profiles: profiles.map((profile) => publicSmsComplianceProfile({
        ...profile,
        validation: profileValidation(profile)
      })),
      telnyx: {
        configured: Boolean(env.telnyxApiKey),
        live_mode: LIVE_MODE(),
        webhook_url: env.telnyxWebhookUrl,
        webhook_public_key_configured: Boolean(env.telnyxWebhookPublicKey),
        organization_profiles: true
      }
    };
  });

  app.post("/organizations/:orgId/sms/compliance-profiles", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId, true);
    const body = objectBodySchema.parse(request.body ?? {});
    const organization = await ensureMessagingOrganization(orgId);
    const profile = await createSmsComplianceProfile(organization, {
      brand: editableBrand(body.brand),
      campaign: editableCampaign(body.campaign),
      actor: { source: "platform_settings" }
    });
    const validation = profileValidation(profile);
    const saved = await updateSmsComplianceProfile(profile, { validation });
    reply.code(201);
    return { ok: true, organization: publicMessagingOrganization(organization), profile: publicSmsComplianceProfile(saved) };
  });

  app.get("/organizations/:orgId/sms/compliance-profiles/:profileId", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId);
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    return { ok: true, profile: publicSmsComplianceProfile({ ...profile, validation: profileValidation(profile) }) };
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/set-default", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId, true);
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    if (LIVE_MODE() && cleanText(profile.status).toLowerCase() !== "active") {
      throw conflict("sms_profile_not_active", "Only a fully provisioned SMS compliance profile can become the live default.");
    }
    const organization = await setDefaultSmsComplianceProfile(profile);
    await ensureDefaultSenderIdentities(orgId);
    return { ok: true, organization: publicMessagingOrganization(organization), profile: publicSmsComplianceProfile(profile) };
  });

  app.get("/organizations/:orgId/sms/compliance-profiles/:profileId/available-numbers", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId);
    await profileForRequest(orgId, param(request.params, "profileId"));
    const query = asObject(request.query);
    const areaCode = normalizeAreaCode(query.area_code || query.areaCode);
    if (!areaCode) {
      throw badRequest("invalid_area_code", "Enter a valid US/Canada three digit area code.");
    }
    if (!LIVE_MODE()) return { ok: true, mock: true, area_code: areaCode, numbers: mockAvailableNumbers(areaCode) };
    const response = asObject(await createTelnyxClient().searchAvailablePhoneNumbers(areaCode, 20));
    const numbers = (Array.isArray(response.data) ? response.data : [])
      .map(availableNumberView)
      .filter((number) => number.phone_number && number.features.includes("sms"));
    return { ok: true, mock: false, area_code: areaCode, numbers };
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/select-number", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId, true);
    const body = objectBodySchema.parse(request.body ?? {});
    const { profile: initialProfile } = await profileForRequest(orgId, param(request.params, "profileId"));
    const selectedNumber = normalizePhone(body.phone_number || body.phoneNumber);
    if (!selectedNumber) {
      throw badRequest("invalid_phone_number", "Select a valid US/Canada phone number.");
    }
    const existingRefs = asObject(initialProfile.provider_refs);
    const existingNumber = normalizePhone(asObject(initialProfile.campaign).selectedNumber);
    if (LIVE_MODE() && cleanText(existingRefs.telnyx_number_order_id)) {
      if (existingNumber !== selectedNumber) throw conflict("number_already_ordered", "This SMS registration already has a number order. Refresh its status before selecting another number.");
      return { ok: true, mock: false, profile: publicSmsComplianceProfile(initialProfile), idempotent_replay: true };
    }
    let profile = initialProfile;
    const campaignForSelection = (inventory: ReturnType<typeof availableNumberView> | null, acceptBodyMetadata: boolean) => {
      const stored = asObject(profile.campaign);
      const storedFeatures = Array.isArray(stored.selectedNumberFeatures) ? stored.selectedNumberFeatures.map(cleanText).filter(Boolean) : [];
      const bodyFeatures = Array.isArray(body.features) ? body.features.map(cleanText).filter(Boolean) : [];
      return {
        ...stored,
        selectedNumber,
        selectedNumberDisplay: inventory?.display_number || cleanText(stored.selectedNumberDisplay) || (acceptBodyMetadata ? cleanText(body.display_number || body.displayNumber) : "") || selectedNumber,
        selectedNumberAreaCode: normalizeAreaCode(inventory ? selectedNumber.slice(2, 5) : stored.selectedNumberAreaCode || (acceptBodyMetadata ? body.area_code || body.areaCode : "") || selectedNumber.slice(2, 5)),
        selectedNumberLocality: inventory?.locality || cleanText(stored.selectedNumberLocality) || (acceptBodyMetadata ? cleanText(body.locality) : ""),
        selectedNumberRegion: inventory?.region || cleanText(stored.selectedNumberRegion) || (acceptBodyMetadata ? cleanText(body.region) : "") || "US",
        selectedNumberFeatures: inventory?.features ?? (storedFeatures.length ? storedFeatures : (acceptBodyMetadata && bodyFeatures.length ? bodyFeatures : ["sms"])),
        selectedNumberMock: !LIVE_MODE(),
        selectedNumberMonthlyCost: inventory?.monthly_cost || cleanText(stored.selectedNumberMonthlyCost) || (acceptBodyMetadata ? cleanText(body.monthly_cost || body.monthlyCost) : ""),
        selectedNumberSetupCost: inventory?.setup_cost || cleanText(stored.selectedNumberSetupCost) || (acceptBodyMetadata ? cleanText(body.setup_cost || body.setupCost) : ""),
        selectedNumberCurrency: inventory?.currency || cleanText(stored.selectedNumberCurrency) || (acceptBodyMetadata ? cleanText(body.currency) : "") || "USD"
      };
    };
    if (!LIVE_MODE()) {
      const nextCampaign = campaignForSelection(null, true);
      const draft = { ...profile, campaign: nextCampaign };
      const saved = await appendSmsComplianceEvent(profile, {
      type: "mock_number_selected",
      source: "platform_settings",
      mock: true,
      phone_number: selectedNumber,
      display_number: nextCampaign.selectedNumberDisplay
    }, {
      campaign: nextCampaign,
      phone_number_status: "mock_selected",
      provider_refs: {
        mock_phone_number: selectedNumber
      },
      validation: profileValidation(draft)
    });
      return { ok: true, mock: true, profile: publicSmsComplianceProfile(saved) };
    }
    if (!env.telnyxWebhookPublicKey) {
      throw badRequest("webhook_public_key_missing", "Telnyx webhook verification must be configured before purchasing an organization number.");
    }
    const client = createTelnyxClient();
    const provisioned = await ensureOrganizationTelnyxProfile(profile, client);
    profile = provisioned.profile;
    const operation = (await beginProviderOperation({
      organization_id: orgId,
      compliance_profile_id: profile.id,
      operation_type: "number_order",
      request_hash: payloadHash({ selectedNumber, messagingProfileId: provisioned.messagingProfileId })
    }));
    if (operation.state === "conflict") {
      throw conflict("provider_operation_conflict", "A different number order already exists for this SMS registration.");
    }
    if (operation.state === "pending") throw conflict("provider_operation_in_progress", "The number order is already in progress.");
    const operationId = cleanText(asObject(operation.operation).id);
    const customerReference = `${profile.external_organization_id}:${profile.id}`.slice(0, 64);
    let response: unknown;
    let knownOrderId = "";
    let nextCampaign = campaignForSelection(null, false);
    if (operation.state === "outcome_unknown") {
      const orders = await client.findNumberOrdersByCustomerReference(customerReference);
      const matches = orders.filter((entry) => Array.isArray(entry.phone_numbers) && entry.phone_numbers.map(asObject).some((item) => normalizePhone(item.phone_number) === selectedNumber));
      if (matches.length !== 1) {
        throw conflict("provider_operation_outcome_unknown", matches.length
          ? "Multiple Telnyx number orders match the ambiguous request and require operator reconciliation."
          : "Telnyx has not exposed the ambiguous number order yet. Retry reconciliation shortly; FirstMate will not risk buying the number twice.");
      }
      knownOrderId = providerId(matches[0], ["id"]);
      response = { data: matches[0] };
    } else if (operation.state === "succeeded") {
      const providerIdValue = cleanText(asObject(operation.operation).provider_id);
      if (!providerIdValue) throw conflict("provider_operation_incomplete", "The existing number order is missing its provider identifier and requires operator reconciliation.");
      knownOrderId = providerIdValue;
      response = await client.getNumberOrder(providerIdValue);
    } else {
      let inventoryResponse: JsonObject;
      try {
        inventoryResponse = asObject(await client.findExactAvailablePhoneNumber(selectedNumber));
      } catch (error) {
        (await finishProviderOperation(operationId, { status: "failed", error: telnyxErrorDetails(error) }));
        throw error;
      }
      const confirmedInventory = (Array.isArray(inventoryResponse.data) ? inventoryResponse.data : [])
        .map(availableNumberView)
        .find((number) => number.phone_number === selectedNumber && number.features.includes("sms"));
      if (!confirmedInventory) {
        (await finishProviderOperation(operationId, { status: "failed", error: { code: "phone_number_unavailable", phone_number: selectedNumber } }));
        throw conflict("phone_number_unavailable", "That number is no longer available. Search again and select another number.");
      }
      nextCampaign = campaignForSelection(confirmedInventory, false);
      const ownership = (await claimPhoneNumberOwnership({
        phone_number: selectedNumber,
        organization_id: orgId,
        compliance_profile_id: profile.id,
        messaging_profile_id: provisioned.messagingProfileId,
        status: "pending"
      }));
      if (!ownership.claimed) {
        (await finishProviderOperation(operationId, { status: "failed", error: { code: "phone_number_owned", phone_number: selectedNumber } }));
        throw conflict("phone_number_owned", "This phone number is already assigned to another FirstMate organization.");
      }
      try {
        profile = await appendSmsComplianceEvent(profile, {
          type: "number_order_requested", provider: "telnyx", phone_number: selectedNumber,
          costs: { monthly: nextCampaign.selectedNumberMonthlyCost, setup: nextCampaign.selectedNumberSetupCost, currency: nextCampaign.selectedNumberCurrency }
        }, {
          campaign: nextCampaign,
          phone_number_status: "ordering",
          validation: profileValidation({ ...profile, campaign: nextCampaign })
        });
      } catch (error) {
        (await finishProviderOperation(operationId, { status: "failed", error: telnyxErrorDetails(error) }));
        (await releasePhoneNumberOwnership(selectedNumber, orgId));
        throw error;
      }
      try {
        response = await client.createNumberOrder(selectedNumber, provisioned.messagingProfileId, customerReference);
      } catch (error) {
        const unknown = error instanceof TelnyxError && asObject(error.details).submission_unknown === true;
        (await finishProviderOperation(operationId, { status: unknown ? "outcome_unknown" : "failed", error: telnyxErrorDetails(error) }));
        if (!unknown) (await releasePhoneNumberOwnership(selectedNumber, orgId));
        throw error;
      }
    }
    const orderId = providerId(response, ["id"]) || knownOrderId;
    if (!orderId) {
      if (operation.state === "created") {
        (await finishProviderOperation(operationId, { status: "outcome_unknown", error: { code: "number_order_id_missing", submission_unknown: true } }));
      }
      throw conflict("provider_operation_outcome_unknown", "Telnyx returned the number order without an identifier; operator reconciliation is required.");
    }
    (await finishProviderOperation(operationId, { status: "succeeded", provider_id: orderId, response: providerData(response) }));
    const orderedOwnership = (await claimPhoneNumberOwnership({
      phone_number: selectedNumber, organization_id: orgId, compliance_profile_id: profile.id,
      messaging_profile_id: provisioned.messagingProfileId, status: "ordered"
    }));
    if (!orderedOwnership.claimed) {
      throw conflict("phone_number_owned", "The purchased number conflicts with another FirstMate ownership record and requires operator reconciliation.");
    }
    const orderData = providerData(response);
    const orderStatus = cleanText(orderData.status || "pending").toLowerCase();
    const saved = await appendSmsComplianceEvent(profile, {
      type: operation.state === "created" ? "number_order_created" : "number_order_reconciled", provider: "telnyx", phone_number: selectedNumber, order_id: orderId,
      costs: { monthly: nextCampaign.selectedNumberMonthlyCost, setup: nextCampaign.selectedNumberSetupCost, currency: nextCampaign.selectedNumberCurrency }
    }, {
      campaign: nextCampaign,
      phone_number_status: orderStatus,
      provider_refs: { telnyx_number_order_id: orderId, telnyx_phone_number: selectedNumber },
      validation: profileValidation({ ...profile, campaign: nextCampaign })
    });
    (await createUsageEvent({
      organization_id: orgId,
      provider: "telnyx",
      provider_message_id: orderId,
      direction: "number_order",
      segments: 0,
      amount: cleanText(nextCampaign.selectedNumberSetupCost || "0") || "0",
      currency: cleanText(nextCampaign.selectedNumberCurrency || "USD"),
      event_key: `telnyx:number_order:${orderId || payloadHash({ orgId, selectedNumber })}`,
      metadata: {
        phone_number: selectedNumber,
        monthly_cost: nextCampaign.selectedNumberMonthlyCost,
        setup_cost: nextCampaign.selectedNumberSetupCost,
        compliance_profile_id: profile.id
      }
    }));
    if (cleanText(nextCampaign.selectedNumberMonthlyCost)) {
      (await upsertBillingCommitment({
        organization_id: orgId,
        provider: "telnyx",
        resource_type: "phone_number",
        resource_id: selectedNumber,
        amount: nextCampaign.selectedNumberMonthlyCost,
        currency: nextCampaign.selectedNumberCurrency,
        billing_interval: "month",
        status: "pending",
        metadata: { number_order_id: orderId, compliance_profile_id: profile.id, provider_price_source: "availability_inventory" }
      }));
    }
    return { ok: true, mock: false, ordered: true, profile: publicSmsComplianceProfile(saved) };
  });

  app.patch("/organizations/:orgId/sms/compliance-profiles/:profileId", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId, true);
    const body = objectBodySchema.parse(request.body ?? {});
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    const brandPatch = Object.prototype.hasOwnProperty.call(body, "brand") ? editableBrand(body.brand) : {};
    const campaignPatch = Object.prototype.hasOwnProperty.call(body, "campaign") ? editableCampaign(body.campaign) : {};
    const mutation = await mutateSmsComplianceProfileAtomically(profile, async (current) => {
      const refs = asObject(current.provider_refs);
      const brandChanged = changesStoredFields(current.brand, brandPatch);
      const campaignChanged = changesStoredFields(current.campaign, campaignPatch);
      const brandCanBeCorrected = /failed|rejected|unverified/.test(cleanText(current.brand_status).toLowerCase());
      const campaignCanBeCorrected = /failed|rejected|expired/.test(cleanText(current.campaign_status).toLowerCase());
      const brandOperation = (await findUnresolvedProviderOperationByPrefix(orgId, current.id, "brand"));
      const campaignOperation = (await findUnresolvedProviderOperationByPrefix(orgId, current.id, "campaign"));
      if (LIVE_MODE() && cleanText(refs.telnyx_brand_id) && !brandCanBeCorrected && brandChanged) {
        throw conflict("submitted_brand_locked", "Submitted legal brand fields cannot be changed locally. Resolve a rejection first or use a synchronized provider update workflow.");
      }
      if (LIVE_MODE() && cleanText(refs.telnyx_campaign_id) && !campaignCanBeCorrected && campaignChanged) {
        throw conflict("submitted_campaign_locked", "Submitted campaign fields cannot be changed locally because the registered carrier campaign is immutable.");
      }
      if (LIVE_MODE() && brandChanged && ["pending", "outcome_unknown"].includes(cleanText(brandOperation?.status))) {
        throw conflict("brand_submission_locked", "Brand fields cannot change while the Telnyx submission is in progress or awaiting reconciliation.");
      }
      if (LIVE_MODE() && campaignChanged && ["pending", "outcome_unknown"].includes(cleanText(campaignOperation?.status))) {
        throw conflict("campaign_submission_locked", "Campaign fields cannot change while the Telnyx submission is in progress or awaiting reconciliation.");
      }
      const nextBrand = { ...asObject(current.brand), ...brandPatch };
      const nextCampaign = { ...asObject(current.campaign), ...campaignPatch };
      const draft = { ...current, brand: nextBrand, campaign: nextCampaign };
      const autoresponseChanged = smsAutoresponseFieldsChanged(current.campaign, campaignPatch);
      return {
        event: { type: "profile_draft_updated", source: "platform_settings" },
        patch: {
          brand: nextBrand,
          campaign: nextCampaign,
          ...(autoresponseChanged ? {
            autoresponse_state: {
              ...asObject(current.autoresponse_state),
              status: "pending",
              desired_hash: ""
            }
          } : {}),
          validation: profileValidation(draft)
        },
        result: { updated: true }
      };
    });
    return { ok: true, profile: publicSmsComplianceProfile(mutation.profile) };
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/submit-brand", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requireSmsSettingsAccess(request, orgId, true);
    const body = objectBodySchema.parse(request.body ?? {});
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    const payload = brandPayload(profile);
    const isMock = !LIVE_MODE();
    const validation = validateBrandDraft(payload);
    if (!validation.ok) {
      throw badRequest("brand_profile_incomplete", "The 10DLC brand profile is missing required fields.", { missing: validation.missing });
    }
    if (body.submit !== true || body.dry_run === true) {
      const saved = await updateSmsComplianceProfile(profile, { validation: profileValidation(profile) });
      return { ok: true, dry_run: true, payload, profile: publicSmsComplianceProfile(saved) };
    }
    if (!isMock && asObject(profile.campaign).consentAcknowledged !== true) {
      throw badRequest("registration_attestation_required", "An authorized representative must acknowledge the SMS consent and opt-out requirements before submission.");
    }
    const submissionContext = brandSubmissionContext(profile, payload);
    const { existingBrandId, operationType } = submissionContext;
    const correctingExistingBrand = submissionContext.correcting;
    if (existingBrandId && operationType === "brand_submission" && !cleanText(asObject(profile.provider_refs).telnyx_brand_submission_operation_type)) {
      throw conflict("brand_already_registered", "This profile already references a Telnyx brand. Refresh its status before attempting another registration.");
    }
    const client = createTelnyxClient();
    const operation = (await beginProviderOperation({
      organization_id: orgId,
      compliance_profile_id: profile.id,
      operation_type: operationType,
      request_hash: payloadHash(payload),
      exclusive_operation_prefixes: ["brand_submission", "brand_update"],
      profile_updated_at: profile.updated_at
    }));
    if (operation.state === "profile_changed") throw conflict("profile_changed", "Business registration data changed before submission. Review the latest draft and retry.");
    if (operation.state === "conflict") throw conflict("provider_operation_conflict", "A different brand submission already exists for this SMS registration.");
    if (operation.state === "pending") throw conflict("provider_operation_in_progress", "The brand submission is already in progress.");
    let reconciledBrandResponse: unknown = null;
    if (operation.state === "outcome_unknown" && !correctingExistingBrand) {
      reconciledBrandResponse = await reconcileAmbiguousBrand(client, payload, asObject(operation.operation));
      if (!reconciledBrandResponse) {
        throw conflict("provider_operation_outcome_unknown", "The prior brand request has an ambiguous outcome and could not be matched safely. FirstMate will not create a second chargeable brand automatically.");
      }
    }
    if (operation.state === "succeeded") {
      const providerIdValue = cleanText(asObject(operation.operation).provider_id || existingBrandId);
      const storedResponse = providerOperationResponse(operation.operation);
      const storedStatus = cleanText(storedResponse.status || "pending").toLowerCase();
      let replayProfile = profile;
      if (providerIdValue && cleanText(asObject(profile.provider_refs).telnyx_brand_id) !== providerIdValue) {
        replayProfile = (await commitSmsComplianceProviderSuccess(profile, {
          operation_id: cleanText(asObject(operation.operation).id),
          provider_id: providerIdValue,
          operation_response: storedResponse,
          event: { type: correctingExistingBrand ? "brand_update_reconciled" : "brand_submission_reconciled", provider: "telnyx" },
          patch: {
            provider_refs: {
              telnyx_brand_id: providerIdValue,
              telnyx_brand_submission_operation_type: operationType,
              telnyx_brand_submission_revision: submissionContext.revision
            },
            brand_status: storedStatus,
            status: brandReadyForCampaignStatus(storedStatus) ? "brand_submitted" : "brand_pending"
          },
          side_effect: async () => {
            if (!correctingExistingBrand) (await recordBrandRegistrationFee(orgId, providerIdValue, profile.id, cleanText(asObject(profile.brand).entityType)));
          }
        }));
      } else if (!correctingExistingBrand) {
        (await recordBrandRegistrationFee(orgId, providerIdValue, profile.id, cleanText(asObject(profile.brand).entityType)));
      }
      return { ok: true, submitted: true, idempotent_replay: true, mock: isMock, profile: publicSmsComplianceProfile(replayProfile) };
    }
    let brandProviderAccepted = false;
    try {
      const response = reconciledBrandResponse || (correctingExistingBrand
        ? await client.update10DlcBrand(existingBrandId, payload)
        : await client.create10DlcBrand(payload));
      const responseData = providerData(response);
      const telnyxBrandId = providerId(response, ["brandId", "id", "referenceId"]) || existingBrandId;
      if (!telnyxBrandId) throw new TelnyxError("Telnyx accepted the brand request without returning a brand ID.", 502, { submission_unknown: true });
      const brandStatus = providerStatus(response, ["identityStatus", "status", "brandStatus"], "pending");
      brandProviderAccepted = true;
      const operationResponse = { brand_id: telnyxBrandId, status: brandStatus, provider_response: responseData };
      const saved = (await commitSmsComplianceProviderSuccess(profile, {
        operation_id: cleanText(operation.operation.id),
        provider_id: telnyxBrandId,
        operation_response: operationResponse,
        event: {
          type: correctingExistingBrand ? "brand_updated" : reconciledBrandResponse ? "brand_submission_reconciled" : "brand_submitted",
          provider: "telnyx",
          mock: isMock,
          attestation: { user_id: ctx.userId, ip: request.ip, disclosure_version: cleanText(asObject(profile.campaign).standardizationVersion || "firstmate-crm-10dlc-v2") },
          request: payload,
          response: responseData
        },
        patch: {
          status: brandReadyForCampaignStatus(brandStatus) ? "brand_submitted" : "brand_pending",
          brand_status: brandStatus,
          provider_refs: {
            telnyx_brand_id: telnyxBrandId,
            tcr_brand_id: providerId(response, ["tcrBrandId"]) || cleanText(asObject(profile.provider_refs).tcr_brand_id),
            telnyx_brand_submission_operation_type: operationType,
            telnyx_brand_submission_revision: submissionContext.revision
          },
          validation: profileValidation(profile)
        },
        side_effect: async () => {
          if (!correctingExistingBrand) (await recordBrandRegistrationFee(orgId, telnyxBrandId, profile.id, cleanText(asObject(profile.brand).entityType)));
        }
      }));
      return { ok: true, submitted: true, mock: isMock, provider_response: isMock ? response : { brandId: telnyxBrandId, status: brandStatus }, profile: publicSmsComplianceProfile(saved) };
    } catch (error) {
      if (brandProviderAccepted) throw error;
      const unknown = error instanceof TelnyxError && asObject(error.details).submission_unknown === true;
      (await finishProviderOperation(cleanText(operation.operation.id), { status: unknown ? "outcome_unknown" : "failed", error: telnyxErrorDetails(error) }));
      await appendSmsComplianceEvent(profile, {
        type: "brand_submit_failed",
        provider: "telnyx",
        mock: isMock,
        request: payload,
        error: error instanceof TelnyxError ? { message: error.message, statusCode: error.statusCode, details: error.details } : { message: error instanceof Error ? error.message : String(error) }
      }, {
        status: "brand_submit_failed",
        brand_status: "failed",
        validation: profileValidation(profile)
      });
      throw error;
    }
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/sole-proprietor/otp/request", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId, true);
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    if (cleanText(asObject(profile.brand).entityType).toUpperCase() !== "SOLE_PROPRIETOR") {
      throw badRequest("otp_not_applicable", "SMS OTP verification is only used for sole proprietor brands.");
    }
    const brandId = cleanText(asObject(profile.provider_refs).telnyx_brand_id);
    if (!brandId) throw badRequest("missing_brand_id", "Submit the sole proprietor brand before requesting its OTP.");
    const response = await createTelnyxClient().trigger10DlcBrandSmsOtp(brandId);
    const referenceId = providerId(response, ["referenceId"]);
    const saved = await appendSmsComplianceEvent(profile, {
      type: "sole_proprietor_otp_requested", provider: "telnyx", reference_id: referenceId
    }, {
      brand_status: "otp_pending",
      provider_refs: { telnyx_brand_otp_reference_id: referenceId }
    });
    return { ok: true, reference_id: referenceId, profile: publicSmsComplianceProfile(saved) };
  });

  app.get("/organizations/:orgId/sms/compliance-profiles/:profileId/sole-proprietor/otp/status", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId);
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    const referenceId = cleanText(asObject(profile.provider_refs).telnyx_brand_otp_reference_id);
    if (!referenceId) throw notFound("otp_not_requested", "No sole proprietor OTP has been requested for this registration.");
    const response = await createTelnyxClient().get10DlcBrandSmsOtp(referenceId);
    const data = providerData(response);
    const deliveryStatus = cleanText(data.deliveryStatus || data.status || "pending").toLowerCase();
    const saved = await appendSmsComplianceEvent(profile, {
      type: "sole_proprietor_otp_status_refreshed", provider: "telnyx", delivery_status: deliveryStatus
    }, { brand_status: deliveryStatus === "verified" ? "verified" : `otp_${deliveryStatus}` });
    return { ok: true, otp: data, profile: publicSmsComplianceProfile(saved) };
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/sole-proprietor/otp/verify", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId, true);
    const body = asObject(request.body);
    const otpPin = cleanText(body.otp_pin || body.otpPin);
    if (!/^\d{4,10}$/.test(otpPin)) throw badRequest("invalid_otp_pin", "Enter the 4–10 digit verification code sent by Telnyx.");
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    const brandId = cleanText(asObject(profile.provider_refs).telnyx_brand_id);
    if (!brandId) throw badRequest("missing_brand_id", "Submit the sole proprietor brand before verifying its OTP.");
    await createTelnyxClient().verify10DlcBrandSmsOtp(brandId, otpPin);
    const brandResponse = await createTelnyxClient().get10DlcBrand(brandId);
    const brandStatus = providerStatus(brandResponse, ["identityStatus", "status"], "verified");
    (await recordBrandRegistrationFee(orgId, brandId, profile.id, "SOLE_PROPRIETOR", true));
    const saved = await appendSmsComplianceEvent(profile, {
      type: "sole_proprietor_otp_verified", provider: "telnyx"
    }, { brand_status: brandStatus === "verified" ? "verified" : brandStatus });
    return { ok: true, profile: publicSmsComplianceProfile(saved) };
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/submit-campaign", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requireSmsSettingsAccess(request, orgId, true);
    const body = objectBodySchema.parse(request.body ?? {});
    let { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    const currentCampaignStatus = cleanText(profile.campaign_status).toLowerCase();
    if (body.submit === true && body.dry_run !== true && /suspended/.test(currentCampaignStatus)) {
      throw conflict("campaign_suspended", "A suspended campaign cannot be resubmitted or replaced automatically. Refresh its status and follow the carrier remediation instructions.", { campaign_status: currentCampaignStatus });
    }
    if (body.submit === true && body.dry_run !== true && cleanText(asObject(profile.provider_refs).telnyx_campaign_id)
      && /failed|rejected|expired/.test(currentCampaignStatus) && body.replace_rejected_campaign !== true) {
      if (["telnyx_failed", "mno_rejected"].includes(currentCampaignStatus)) {
        throw conflict("campaign_appeal_available", "This native campaign is eligible for manual appeal. Appeal it first, or explicitly authorize a new chargeable replacement campaign.", {
          campaign_status: currentCampaignStatus,
          appeal_endpoint: `/organizations/${orgId}/sms/compliance-profiles/${profile.id}/appeal-campaign`
        });
      }
      throw conflict("campaign_replacement_confirmation_required", "This carrier state requires a new chargeable campaign. Explicitly confirm the paid replacement before submitting it.", { campaign_status: currentCampaignStatus });
    }
    let submissionContext = campaignSubmissionContext(profile);
    let payload = submissionContext.payload;
    const validation = validateCampaignDraft(asObject(profile.campaign));
    const isMock = smsComplianceProfileIsMock(profile);
    if (!cleanText(payload.brandId)) {
      throw badRequest("missing_brand_id", "Submit the 10DLC brand before submitting a campaign.");
    }
    if (!validation.ok) {
      throw badRequest("campaign_profile_incomplete", "The 10DLC campaign profile is missing required fields.", { missing: validation.missing });
    }
    if (!isMock && asObject(profile.campaign).consentAcknowledged !== true) {
      throw badRequest("registration_attestation_required", "An authorized representative must acknowledge the SMS consent and opt-out requirements before submission.");
    }
    if (body.submit !== true || body.dry_run === true) {
      const saved = await updateSmsComplianceProfile(profile, { validation: profileValidation(profile) });
      return { ok: true, dry_run: true, payload, profile: publicSmsComplianceProfile(saved) };
    }
    if (!isMock && !brandReadyForCampaignStatus(profile.brand_status)) {
      const saved = await updateSmsComplianceProfile(profile, {
        status: "brand_pending",
        campaign_status: "waiting_on_brand",
        validation: profileValidation(profile)
      });
      throw badRequest("brand_registration_pending", "The 10DLC brand registration is still pending. Refresh status before submitting the campaign.", {
        brand_status: profile.brand_status || "pending",
        profile: publicSmsComplianceProfile(saved)
      });
    }
    if (!isMock) {
      const contentValidation = validateCampaignContent(profile);
      if (!contentValidation.ok) throw badRequest("campaign_content_noncompliant", "The campaign content does not meet FirstMate SMS compliance requirements.", { issues: contentValidation.issues });
    }
    if (!isMock) {
      const campaign = asObject(profile.campaign);
      await verifyPublicPolicyUrl(campaign.privacyPolicyLink, asObject(profile.brand).website, "Privacy policy");
      await verifyPublicPolicyUrl(campaign.termsAndConditionsLink, asObject(profile.brand).website, "Terms and conditions");
    }
    const client = createTelnyxClient();
    if (!isMock) {
      const messagingProfileId = cleanText(asObject(profile.provider_refs).telnyx_messaging_profile_id);
      const existingCampaignOperation = (await findProviderOperation(orgId, profile.id, submissionContext.operationType));
      try {
        profile = await ensureOrganizationTelnyxAutoresponses(profile, messagingProfileId, client);
      } catch (error) {
        // A campaign that Telnyx already accepted must never be reported as a
        // failed submission merely because its runtime HELP/STOP/START repair
        // still needs attention. Sending remains fail-closed via profile state.
        if (cleanText(existingCampaignOperation?.status) === "succeeded") {
          const providerIdValue = cleanText(existingCampaignOperation?.provider_id);
          let latest = (await profileForRequest(orgId, profile.id)).profile;
          if (providerIdValue && cleanText(asObject(latest.provider_refs).telnyx_campaign_id) !== providerIdValue) {
            latest = await appendSmsComplianceEvent(latest, {
              type: "campaign_submission_reconciled_setup_pending",
              provider: "telnyx",
              setup_error: error instanceof PlatformError ? error.code : "autoresponse_sync_failed"
            }, {
              ...campaignSubmissionProfilePatch(latest, submissionContext, providerIdValue),
              status: "provider_update_pending"
            });
          }
          return {
            ok: true,
            submitted: true,
            idempotent_replay: true,
            setup_pending: true,
            setup_error: {
              code: error instanceof PlatformError ? error.code : "autoresponse_sync_failed",
              message: error instanceof Error ? error.message : "Telnyx keyword-response setup still needs reconciliation."
            },
            profile: publicSmsComplianceProfile(latest)
          };
        }
        throw error;
      }
      const currentValidation = validateCampaignDraft(asObject(profile.campaign));
      if (!currentValidation.ok) {
        throw conflict("profile_changed", "Campaign data changed during compliance preflight. Review the latest draft and retry.", { missing: currentValidation.missing });
      }
      const currentContentValidation = validateCampaignContent(profile);
      if (!currentContentValidation.ok) {
        throw badRequest("campaign_content_noncompliant", "The current campaign content does not meet FirstMate SMS compliance requirements.", { issues: currentContentValidation.issues });
      }
      const currentCampaign = asObject(profile.campaign);
      if (!brandReadyForCampaignStatus(profile.brand_status)) {
        throw conflict("profile_changed", "The brand is no longer ready for campaign submission. Refresh its provider status before retrying.");
      }
      if (currentCampaign.consentAcknowledged !== true) {
        throw conflict("profile_changed", "The campaign attestation changed during compliance preflight. Review and retry.");
      }
      await verifyPublicPolicyUrl(currentCampaign.privacyPolicyLink, asObject(profile.brand).website, "Privacy policy");
      await verifyPublicPolicyUrl(currentCampaign.termsAndConditionsLink, asObject(profile.brand).website, "Terms and conditions");
    }
    submissionContext = campaignSubmissionContext(profile);
    payload = submissionContext.payload;
    let campaignOperation: Awaited<ReturnType<typeof beginProviderOperation>> | null = (await beginProviderOperation({
      organization_id: orgId,
      compliance_profile_id: profile.id,
      operation_type: submissionContext.operationType,
      request_hash: payloadHash(payload),
      exclusive_operation_prefixes: ["campaign_submission", "campaign_replacement", "campaign_appeal"],
      profile_updated_at: profile.updated_at
    }));
    if (campaignOperation.state === "profile_changed") throw conflict("profile_changed", "Campaign data changed before submission. Review the latest draft and retry.");
    if (campaignOperation.state === "conflict") throw conflict("provider_operation_conflict", "A different campaign submission already exists for this SMS registration.");
    if (campaignOperation.state === "pending") throw conflict("provider_operation_in_progress", "The campaign submission is already in progress.");
    let campaignProviderAccepted = false;
    try {
      const operationId = cleanText(asObject(campaignOperation.operation).id);
      const storedOperationResponse = providerOperationResponse(campaignOperation.operation);
      if (campaignOperation.state === "succeeded") {
        const providerIdValue = cleanText(asObject(campaignOperation.operation).provider_id);
        const acceptedQualification = asObject(storedOperationResponse.qualification);
        const acceptedUsecaseCost = asObject(storedOperationResponse.usecase_cost);
        if (!isMock && !/^\d+(?:\.\d+)?$/.test(cleanText(acceptedQualification.quarterlyFee || acceptedUsecaseCost.upFrontCost))) {
          throw conflict("campaign_fee_reconciliation_required", "The accepted campaign's immutable Telnyx price quote is missing. FirstMate will not infer a charge from today's price.");
        }
        let replayProfile = profile;
        if (providerIdValue && cleanText(asObject(profile.provider_refs).telnyx_campaign_id) !== providerIdValue) {
          const acceptedProviderResponse = asObject(storedOperationResponse.provider_response);
          replayProfile = (await commitSmsComplianceProviderSuccess(profile, {
            operation_id: operationId,
            provider_id: providerIdValue,
            operation_response: storedOperationResponse,
            event: {
              type: submissionContext.replacement ? "campaign_replacement_reconciled" : "campaign_submission_reconciled",
              provider: "telnyx",
              previous_campaign_id: submissionContext.previousCampaignId
            },
            patch: campaignSubmissionProfilePatch(profile, submissionContext, providerIdValue, providerId(acceptedProviderResponse, ["tcrCampaignId"])),
            side_effect: async () => (await recordCampaignRegistrationFee(orgId, providerIdValue, profile.id, acceptedQualification, acceptedUsecaseCost))
          }));
        } else {
          (await recordCampaignRegistrationFee(orgId, providerIdValue, profile.id, acceptedQualification, acceptedUsecaseCost));
        }
        return { ok: true, submitted: true, idempotent_replay: true, mock: isMock, profile: publicSmsComplianceProfile(replayProfile) };
      }

      let qualification: unknown = storedOperationResponse.qualification || null;
      let usecaseCost: unknown = storedOperationResponse.usecase_cost || null;
      let qualificationError: JsonObject | null = null;
      const storedUpfrontCost = cleanText(providerData(qualification).quarterlyFee || providerData(usecaseCost).upFrontCost);
      if (!storedUpfrontCost) {
        try {
          qualification = await client.qualify10DlcBrandByUsecase(cleanText(payload.brandId), cleanText(payload.usecase));
        } catch (error) {
          if (!isMock) throw error;
          qualificationError = telnyxErrorDetails(error);
        }
      }
      if (!isMock) {
        const qualificationData = providerData(qualification);
        if (!/^\d+(?:\.\d+)?$/.test(cleanText(qualificationData.quarterlyFee))) {
          usecaseCost = await client.get10DlcCampaignUsecaseCost(cleanText(payload.usecase));
        }
        const costData = providerData(usecaseCost);
        if (!/^\d+(?:\.\d+)?$/.test(cleanText(qualificationData.quarterlyFee || costData.upFrontCost))) {
          throw new Error("Telnyx did not provide the campaign's upfront cost, so FirstMate stopped before submitting a chargeable campaign.");
        }
      }
      const operationContext: JsonObject = {
        qualification: providerData(qualification),
        usecase_cost: providerData(usecaseCost),
        qualification_error: qualificationError
      };
      (await updateProviderOperationContext(operationId, operationContext));
      let reconciledCampaignResponse: unknown = null;
      if (campaignOperation.state === "outcome_unknown") {
        const records = await client.list10DlcCampaigns(cleanText(payload.brandId));
        const matches = records.filter((entry) => cleanText(entry.referenceId) === cleanText(payload.referenceId));
        const matchedCampaignId = matches.length === 1 ? providerId(matches[0], ["campaignId", "id"]) : "";
        if (matchedCampaignId) reconciledCampaignResponse = await client.get10DlcCampaign(matchedCampaignId);
        if (!reconciledCampaignResponse) {
          throw conflict("provider_operation_outcome_unknown", "The prior campaign request has an ambiguous outcome and could not be matched safely. FirstMate will not submit a second chargeable campaign automatically.");
        }
      }
      const response = reconciledCampaignResponse || await client.submit10DlcCampaign(payload);
      const telnyxCampaignId = providerId(response, ["campaignId", "id"]);
      if (!telnyxCampaignId) throw new TelnyxError("Telnyx accepted the campaign request without returning a campaign ID.", 502, { submission_unknown: true });
      campaignProviderAccepted = true;
      const operationResponse: JsonObject = {
        ...operationContext,
        campaign_id: telnyxCampaignId,
        status: providerStatus(response, ["campaignStatus", "status"], "submitted"),
        provider_response: providerData(response)
      };
      const saved = (await commitSmsComplianceProviderSuccess(profile, {
        operation_id: operationId,
        provider_id: telnyxCampaignId,
        operation_response: operationResponse,
        event: {
          type: submissionContext.replacement
            ? (reconciledCampaignResponse ? "campaign_replacement_reconciled" : "campaign_replacement_submitted")
            : (reconciledCampaignResponse ? "campaign_submission_reconciled" : "campaign_submitted"),
          provider: "telnyx",
          mock: isMock,
          previous_campaign_id: submissionContext.previousCampaignId,
          request: payload,
          qualification: qualification ? providerData(qualification) : null,
          qualification_error: qualificationError,
          response: providerData(response),
          attestation: { user_id: ctx.userId, ip: request.ip, disclosure_version: cleanText(asObject(profile.campaign).standardizationVersion || "firstmate-crm-10dlc-v2") }
        },
        patch: {
          ...campaignSubmissionProfilePatch(profile, submissionContext, telnyxCampaignId, providerId(response, ["tcrCampaignId"])),
          validation: profileValidation(profile)
        },
        side_effect: async () => (await recordCampaignRegistrationFee(orgId, telnyxCampaignId, profile.id, qualification, usecaseCost))
      }));
      return { ok: true, submitted: true, mock: isMock, qualification, qualification_error: qualificationError, provider_response: response, profile: publicSmsComplianceProfile(saved) };
    } catch (error) {
      if (campaignProviderAccepted) throw error;
      if (campaignOperation && campaignOperation.state !== "created") throw error;
      if (campaignOperation && campaignOperation.state === "created") {
        const unknown = error instanceof TelnyxError && asObject(error.details).submission_unknown === true;
        (await finishProviderOperation(cleanText(campaignOperation.operation.id), { status: unknown ? "outcome_unknown" : "failed", error: telnyxErrorDetails(error) }));
      }
      await appendSmsComplianceEvent(profile, {
        type: "campaign_submit_failed",
        provider: "telnyx",
        mock: isMock,
        request: payload,
        error: telnyxErrorDetails(error)
      }, {
        status: "campaign_submit_failed",
        campaign_status: "failed",
        validation: profileValidation(profile)
      });
      throw error;
    }
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/appeal-campaign", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requireSmsSettingsAccess(request, orgId, true);
    const body = objectBodySchema.parse(request.body ?? {});
    const appealReason = cleanText(body.appeal_reason || body.appealReason);
    if (appealReason.length < 20 || appealReason.length > 1000) {
      throw badRequest("invalid_appeal_reason", "Explain in 20-1000 characters what was corrected before requesting another compliance review.");
    }
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    if (smsComplianceProfileIsMock(profile)) throw badRequest("mock_campaign_not_appealable", "Mock campaigns do not enter Telnyx manual review.");
    const refs = asObject(profile.provider_refs);
    const campaignId = cleanText(refs.telnyx_campaign_id);
    if (!campaignId) throw badRequest("missing_campaign_id", "No Telnyx campaign is available to appeal.");
    const submittedOperationType = cleanText(refs.telnyx_campaign_submission_operation_type);
    const submittedRevision = cleanText(refs.telnyx_campaign_submission_revision || "initial");
    const submittedOperation = submittedOperationType ? (await findProviderOperation(orgId, profile.id, submittedOperationType)) : null;
    if (submittedOperation && cleanText(submittedOperation.request_hash) !== payloadHash(campaignPayload(profile, submittedRevision))) {
      throw conflict("campaign_changed_since_submission", "The registered campaign fields changed after the rejected submission. Appeal applies only to the unchanged campaign; explicitly create a corrected replacement instead.");
    }
    const status = cleanText(profile.campaign_status).toLowerCase();
    const appealable = ["telnyx_failed", "mno_rejected"].includes(status);
    const reasonHash = payloadHash({ campaign_id: campaignId, appeal_reason: appealReason }).slice(0, 16);
    const unresolvedAppeal = (await findUnresolvedProviderOperationByPrefix(orgId, profile.id, "campaign_appeal"));
    const unresolvedContext = providerOperationResponse(unresolvedAppeal);
    if (unresolvedAppeal && cleanText(unresolvedContext.appeal_reason_hash) && cleanText(unresolvedContext.appeal_reason_hash) !== reasonHash) {
      throw conflict("provider_operation_conflict", "A prior campaign appeal with a different remediation reason is unresolved.");
    }
    const latestCarrierEvent = [...profile.events].reverse().find((entry) => {
      const event = asObject(entry);
      return cleanText(event.provider_event_type) === "10dlc.campaign.update"
        || ["provider_status_refreshed", "provider_webhook_received"].includes(cleanText(event.type));
    });
    const storedAppealOperationType = cleanText(refs.telnyx_campaign_appeal_operation_type);
    const storedAppealReasonHash = cleanText(refs.telnyx_campaign_appeal_reason_hash);
    const storedAppealGeneration = cleanText(refs.telnyx_campaign_appeal_generation);
    const generation = unresolvedAppeal && cleanText(unresolvedContext.appeal_generation)
      ? cleanText(unresolvedContext.appeal_generation)
      : !appealable && storedAppealOperationType && storedAppealReasonHash === reasonHash
        ? storedAppealGeneration
        : payloadHash({
          campaign_id: campaignId,
          rejection_event: cleanText(asObject(latestCarrierEvent).provider_event_id || asObject(latestCarrierEvent).occurred_at || asObject(latestCarrierEvent).at || profile.updated_at)
        }).slice(0, 12);
    const operationType = unresolvedAppeal
      ? cleanText(unresolvedAppeal.operation_type)
      : !appealable && storedAppealOperationType && storedAppealReasonHash === reasonHash
        ? storedAppealOperationType
        : `campaign_appeal_${generation}_${reasonHash}`;
    const requestPayload = { campaign_id: campaignId, appeal_reason: appealReason, appeal_generation: generation };
    const operation = (await beginProviderOperation({
      organization_id: orgId,
      compliance_profile_id: profile.id,
      operation_type: operationType,
      request_hash: payloadHash(requestPayload),
      exclusive_operation_prefixes: ["campaign_submission", "campaign_replacement", "campaign_appeal"],
      profile_updated_at: profile.updated_at
    }));
    if (operation.state === "profile_changed") throw conflict("profile_changed", "Campaign status changed before the appeal was submitted. Review the latest status and retry.");
    if (operation.state === "conflict") throw conflict("provider_operation_conflict", "A different appeal attempt is unresolved for this campaign.");
    if (operation.state === "pending") throw conflict("provider_operation_in_progress", "This campaign appeal is already being submitted.");
    if (!appealable && !["succeeded", "outcome_unknown"].includes(operation.state)) {
      if (operation.state === "created") {
        (await finishProviderOperation(cleanText(asObject(operation.operation).id), {
          status: "failed",
          error: { code: "campaign_not_appealable", campaign_status: status }
        }));
      }
      throw conflict("campaign_not_appealable", "Only native campaigns in TELNYX_FAILED or MNO_REJECTED status can use this appeal flow.", { campaign_status: status });
    }

    const client = createTelnyxClient();
    const operationId = cleanText(asObject(operation.operation).id);
    if (operation.state === "created") {
      (await updateProviderOperationContext(operationId, {
        campaign_id: campaignId,
        campaign_status: status,
        appeal_reason_hash: reasonHash,
        appeal_generation: generation
      }));
    }
    if (operation.state === "succeeded") {
      const storedResponse = providerOperationResponse(operation.operation);
      let replayProfile = profile;
      if (appealable) {
        replayProfile = (await commitSmsComplianceProviderSuccess(profile, {
          operation_id: operationId,
          provider_id: campaignId,
          operation_response: storedResponse,
          event: { type: "campaign_appeal_reconciled", provider: "telnyx", campaign_id: campaignId },
          patch: {
            status: "provider_update_pending",
            campaign_status: cleanText(storedResponse.campaign_status || "tcr_accepted"),
            provider_refs: {
              telnyx_campaign_appeal_operation_type: operationType,
              telnyx_campaign_appeal_reason_hash: reasonHash,
              telnyx_campaign_appeal_generation: generation,
              telnyx_campaign_appeal_campaign_id: campaignId
            }
          }
        }));
      }
      (await suspendOrganizationSmsDeliveries(orgId, "sms_campaign_not_ready"));
      return { ok: true, appealed: true, idempotent_replay: true, profile: publicSmsComplianceProfile(replayProfile) };
    }

    let providerAccepted = false;
    try {
      let response: unknown = null;
      let reconciled = false;
      if (operation.state === "outcome_unknown") {
        const campaign = await client.get10DlcCampaign(campaignId);
        const providerCampaignStatus = providerStatus(campaign, ["campaignStatus", "status"], status);
        if (["telnyx_failed", "mno_rejected"].includes(providerCampaignStatus)) {
          throw conflict("provider_operation_outcome_unknown", "The prior appeal outcome is still ambiguous. FirstMate will not submit another appeal until Telnyx exposes its result.");
        }
        response = { ...providerData(campaign), reconciled_after_unknown_outcome: true };
        reconciled = true;
      } else {
        response = await client.submit10DlcCampaignAppeal(campaignId, appealReason);
      }
      providerAccepted = true;
      const operationResponse: JsonObject = {
        campaign_id: campaignId,
        campaign_status: "tcr_accepted",
        appeal_reason_hash: reasonHash,
        appeal_generation: generation,
        provider_response: providerData(response)
      };
      const saved = (await commitSmsComplianceProviderSuccess(profile, {
        operation_id: operationId,
        provider_id: campaignId,
        operation_response: operationResponse,
        event: {
          type: reconciled ? "campaign_appeal_reconciled" : "campaign_appealed",
          provider: "telnyx",
          campaign_id: campaignId,
          appeal_reason: appealReason,
          response: providerData(response),
          attestation: { user_id: ctx.userId, ip: request.ip }
        },
        patch: {
          status: "provider_update_pending",
          campaign_status: "tcr_accepted",
          provider_refs: {
            telnyx_campaign_appeal_operation_type: operationType,
            telnyx_campaign_appeal_reason_hash: reasonHash,
            telnyx_campaign_appeal_generation: generation,
            telnyx_campaign_appeal_campaign_id: campaignId
          }
        }
      }));
      (await suspendOrganizationSmsDeliveries(orgId, "sms_campaign_not_ready"));
      return { ok: true, appealed: true, reconciled, provider_response: response, profile: publicSmsComplianceProfile(saved) };
    } catch (error) {
      if (providerAccepted) throw error;
      if (operation.state === "created") {
        const unknown = error instanceof TelnyxError && asObject(error.details).submission_unknown === true;
        (await finishProviderOperation(operationId, { status: unknown ? "outcome_unknown" : "failed", error: telnyxErrorDetails(error) }));
      }
      await appendSmsComplianceEvent(profile, {
        type: "campaign_appeal_failed",
        provider: "telnyx",
        campaign_id: campaignId,
        error: telnyxErrorDetails(error)
      });
      throw error;
    }
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/refresh-status", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId, true);
    let { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    if (["deactivation_pending", "deactivated"].includes(cleanText(profile.status).toLowerCase())) {
      throw conflict("sms_service_deactivating", "Provider status repair is disabled while this SMS service is being deactivated.");
    }
    let refs = asObject(profile.provider_refs);
    const client = createTelnyxClient();
    const brandId = cleanText(refs.telnyx_brand_id || refs.tcr_brand_id);
    const campaignId = cleanText(refs.telnyx_campaign_id || refs.tcr_campaign_id);
    const numberOrderId = cleanText(refs.telnyx_number_order_id);
    if (!brandId && !campaignId && !numberOrderId) {
      throw notFound("provider_record_missing", "This compliance profile has not been submitted to Telnyx yet.");
    }
    const messagingProfileId = cleanText(refs.telnyx_messaging_profile_id);
    if (campaignId && messagingProfileId && !smsComplianceProfileIsMock(profile)) {
      profile = await ensureOrganizationTelnyxAutoresponses(profile, messagingProfileId, client);
      refs = asObject(profile.provider_refs);
    }
    const brandResponse = brandId ? await client.get10DlcBrand(brandId) : null;
    const campaignResponse = campaignId ? await client.get10DlcCampaign(campaignId) : null;
    const numberOrderResponse = numberOrderId ? await client.getNumberOrder(numberOrderId) : null;
    const brand = providerData(brandResponse);
    const campaign = providerData(campaignResponse);
    const brandStatus = cleanText(brand.identityStatus || brand.status || profile.brand_status || "pending").toLowerCase();
    const providerCampaignStatus = cleanText(campaign.campaignStatus || campaign.status || profile.campaign_status || "draft").toLowerCase();
    const campaignStatus = cleanText(profile.campaign_status).toLowerCase() === "tcr_expired"
      ? "tcr_expired"
      : providerCampaignStatus;
    const numberOrder = providerData(numberOrderResponse);
    const numberStatus = cleanText(numberOrder.status || profile.phone_number_status || "draft").toLowerCase();
    const selectedNumber = normalizePhone(asObject(profile.campaign).selectedNumber);
    const numberFailed = ["failure", "failed", "cancelled", "deleted"].includes(numberStatus);
    let assignmentResponse: unknown = null;
    let ownedPhoneNumber: JsonObject | null = null;
    let assignmentStatus = cleanText(profile.phone_number_campaign_status).toLowerCase();
    let deactivatedPreviousCampaignIds: string[] = [];
    if (selectedNumber && numberStatus === "success") {
      ownedPhoneNumber = asObject(await client.findOwnedPhoneNumber(selectedNumber));
      if (!cleanText(ownedPhoneNumber.id)) ownedPhoneNumber = null;
    }
    if (selectedNumber && campaignId && numberStatus === "success" && campaignStatus === "mno_provisioned") {
      const getAssignment = async () => {
        try {
          return await client.getPhoneNumberCampaign(selectedNumber);
        } catch (error) {
          if (error instanceof TelnyxError && error.statusCode === 404) return null;
          throw error;
        }
      };
      const assignmentCampaignIds = (value: unknown) => {
        const assignment = providerData(value);
        return [assignment.telnyxCampaignId, assignment.campaignId].map(cleanText).filter(Boolean);
      };
      const assignmentMatches = (value: unknown) => {
        const assignment = providerData(value);
        const status = cleanText(assignment.status || assignment.assignmentStatus || "success").toLowerCase();
        return ["success", "assigned", "active", "added"].includes(status) && assignmentCampaignIds(value).includes(campaignId);
      };
      assignmentResponse = await getAssignment();
      const oldCampaignIds = assignmentCampaignIds(assignmentResponse);
      if (!assignmentMatches(assignmentResponse) && oldCampaignIds.length && !oldCampaignIds.includes(campaignId)) {
        const detachRequest = { selectedNumber, campaign_ids: [...oldCampaignIds].sort() };
        const detachOperationType = `phone_campaign_detach_${payloadHash(detachRequest).slice(0, 16)}`;
        let detachOperation = (await beginProviderOperation({
          organization_id: orgId,
          compliance_profile_id: profile.id,
          operation_type: detachOperationType,
          request_hash: payloadHash(detachRequest)
        }));
        if (detachOperation.state === "conflict") throw conflict("provider_operation_conflict", "A different number-to-campaign detach is unresolved.");
        if (detachOperation.state === "pending") throw conflict("provider_operation_in_progress", "The prior campaign detach is already running.");
        if (detachOperation.state === "succeeded") {
          (await resetProviderOperationForRetry(orgId, profile.id, detachOperationType, { code: "old_assignment_reappeared", campaign_ids: oldCampaignIds }));
          detachOperation = (await beginProviderOperation({
            organization_id: orgId,
            compliance_profile_id: profile.id,
            operation_type: detachOperationType,
            request_hash: payloadHash(detachRequest)
          }));
        }
        let detachError: unknown = null;
        try {
          // DELETE is resource-idempotent. It is safe to repeat after an
          // unknown outcome while GET still proves the old binding exists.
          await client.deletePhoneNumberCampaign(selectedNumber);
        } catch (error) {
          detachError = error;
        }
        assignmentResponse = await getAssignment();
        if (!assignmentResponse || assignmentMatches(assignmentResponse)) {
          (await finishProviderOperation(cleanText(asObject(detachOperation.operation).id), {
            status: "succeeded",
            provider_id: oldCampaignIds.join(","),
            response: providerData(assignmentResponse)
          }));
        } else {
          const unknown = !detachError || (detachError instanceof TelnyxError && asObject(detachError.details).submission_unknown === true);
          (await finishProviderOperation(cleanText(asObject(detachOperation.operation).id), {
            status: unknown ? "outcome_unknown" : "failed",
            error: detachError ? telnyxErrorDetails(detachError) : { code: "old_campaign_assignment_still_present", campaign_ids: assignmentCampaignIds(assignmentResponse) }
          }));
          if (detachError && !unknown) throw detachError;
          throw conflict("campaign_assignment_still_present", "Telnyx still reports the number on the prior campaign; FirstMate will safely retry the idempotent detach.");
        }
      }

      if (!assignmentMatches(assignmentResponse) && !assignmentResponse) {
        const attachRequest = { selectedNumber, campaignId };
        const assignmentOperationType = `phone_campaign_assignment_${payloadHash(attachRequest).slice(0, 16)}`;
        let assignmentOperation = (await beginProviderOperation({
          organization_id: orgId,
          compliance_profile_id: profile.id,
          operation_type: assignmentOperationType,
          request_hash: payloadHash(attachRequest)
        }));
        if (assignmentOperation.state === "conflict") throw conflict("provider_operation_conflict", "A different number-to-campaign assignment is unresolved.");
        if (assignmentOperation.state === "pending") throw conflict("provider_operation_in_progress", "The number-to-campaign assignment is already running.");
        if (assignmentOperation.state === "succeeded") {
          (await resetProviderOperationForRetry(orgId, profile.id, assignmentOperationType, { code: "assignment_drifted", campaign_id: campaignId }));
          assignmentOperation = (await beginProviderOperation({
            organization_id: orgId,
            compliance_profile_id: profile.id,
            operation_type: assignmentOperationType,
            request_hash: payloadHash(attachRequest)
          }));
        }
        let assignmentError: unknown = null;
        try {
          // A phone number has one campaign binding. Repeating the exact same
          // target after GET proves it absent cannot create a second resource.
          await client.assignPhoneNumberToCampaign(selectedNumber, campaignId);
        } catch (error) {
          assignmentError = error;
        }
        assignmentResponse = await getAssignment();
        if (!assignmentMatches(assignmentResponse)) {
          const unknown = !assignmentError || (assignmentError instanceof TelnyxError && asObject(assignmentError.details).submission_unknown === true);
          (await finishProviderOperation(cleanText(asObject(assignmentOperation.operation).id), {
            status: unknown ? "outcome_unknown" : "failed",
            error: assignmentError ? telnyxErrorDetails(assignmentError) : { code: "campaign_assignment_not_visible" }
          }));
          if (assignmentError && !unknown) throw assignmentError;
          throw conflict("provider_operation_outcome_unknown", "The Telnyx number-to-campaign assignment could not be verified. FirstMate will reconcile the unique phone-number binding before activation.");
        }
        (await finishProviderOperation(cleanText(asObject(assignmentOperation.operation).id), {
          status: "succeeded",
          provider_id: campaignId,
          response: providerData(assignmentResponse)
        }));
      } else if (assignmentMatches(assignmentResponse)) {
        const assignmentOperationType = `phone_campaign_assignment_${payloadHash({ selectedNumber, campaignId }).slice(0, 16)}`;
        const existingAssignmentOperation = (await findProviderOperation(orgId, profile.id, assignmentOperationType));
        if (existingAssignmentOperation && ["pending", "outcome_unknown"].includes(cleanText(existingAssignmentOperation.status))) {
          (await finishProviderOperation(cleanText(existingAssignmentOperation.id), {
            status: "succeeded",
            provider_id: campaignId,
            response: providerData(assignmentResponse)
          }));
        }
      }
      const assignment = providerData(assignmentResponse);
      assignmentStatus = cleanText(assignment.status || assignment.assignmentStatus || "pending").toLowerCase();
      if (!assignmentStatus || assignmentStatus === "success") assignmentStatus = "assigned";
      const assignedCampaignIds = [assignment.telnyxCampaignId, assignment.campaignId].map(cleanText).filter(Boolean);
      if (assignmentStatus === "assigned" && (!assignedCampaignIds.length || !assignedCampaignIds.includes(campaignId))) {
        assignmentStatus = assignedCampaignIds.length ? "campaign_mismatch" : "pending_verification";
      }
      if (assignmentStatus === "assigned") {
        const previousCampaignIds = Array.isArray(refs.previous_telnyx_campaign_ids)
          ? refs.previous_telnyx_campaign_ids.map(cleanText).filter((id) => id && id !== campaignId)
          : [];
        const alreadyDeactivated = Array.isArray(refs.deactivated_telnyx_campaign_ids)
          ? refs.deactivated_telnyx_campaign_ids.map(cleanText).filter(Boolean)
          : [];
        for (const previousCampaignId of previousCampaignIds.filter((id) => !alreadyDeactivated.includes(id))) {
          try {
            await client.deactivate10DlcCampaign(previousCampaignId);
          } catch (error) {
            if (!(error instanceof TelnyxError) || error.statusCode !== 404) throw error;
          }
          (await endBillingCommitment("telnyx", "campaign", previousCampaignId));
          deactivatedPreviousCampaignIds.push(previousCampaignId);
        }
        deactivatedPreviousCampaignIds = [...new Set([...alreadyDeactivated, ...deactivatedPreviousCampaignIds])];
      }
    }
    const providerReady = ["ok", "verified", "vetted_verified", "approved"].includes(brandStatus)
      && campaignStatus === "mno_provisioned"
      && numberStatus === "success"
      && Boolean(ownedPhoneNumber)
      && assignmentStatus === "assigned"
      && smsAutoresponsesReady(profile)
      && !["deactivation_pending", "deactivated"].includes(cleanText(profile.status).toLowerCase());
    const mutation = await mutateSmsComplianceProfileAtomically(profile, async (current) => {
      if (cleanText(current.updated_at) !== cleanText(profile.updated_at)) {
        return { result: { conflict: true, active: false } };
      }
      let ownershipClaimed = false;
      if (selectedNumber && !numberFailed) {
        const ownership = (await claimPhoneNumberOwnership({
          phone_number: selectedNumber,
          organization_id: orgId,
          compliance_profile_id: current.id,
          messaging_profile_id: cleanText(asObject(current.provider_refs).telnyx_messaging_profile_id),
          provider_phone_number_id: cleanText(ownedPhoneNumber?.id),
          status: providerReady ? "active" : numberStatus || "pending"
        }));
        ownershipClaimed = ownership.claimed;
      }
      const active = providerReady && ownershipClaimed;
      return {
        event: {
          type: "provider_status_refreshed",
          provider: "telnyx",
          brand: brandResponse ? brand : null,
          campaign: campaignResponse ? campaign : null,
          number_order: numberOrderResponse ? numberOrder : null,
          number_campaign: assignmentResponse ? providerData(assignmentResponse) : null
        },
        patch: {
          status: active ? "active" : cleanText(current.status) === "active" ? "provider_update_pending" : current.status,
          brand_status: brandStatus || current.brand_status,
          campaign_status: campaignStatus || current.campaign_status,
          phone_number_status: numberStatus || current.phone_number_status,
          phone_number_campaign_status: assignmentStatus || current.phone_number_campaign_status,
          phone_number_campaign_id: assignmentStatus === "assigned" ? campaignId : "",
          ...(deactivatedPreviousCampaignIds.length ? { provider_refs: { deactivated_telnyx_campaign_ids: deactivatedPreviousCampaignIds } } : {}),
          ...(numberFailed ? { provider_refs: { telnyx_number_order_id: "", telnyx_phone_number: "" } } : {})
        },
        result: { conflict: false, active }
      };
    });
    if (mutation.result.conflict) {
      throw conflict("provider_state_changed", "Telnyx state changed while this refresh was running. Refresh again to use the newer carrier event.");
    }
    const saved = mutation.profile;
    const active = mutation.result.active;
    if (/failed|rejected/.test(brandStatus)) {
      (await markProviderOperationFailed(orgId, profile.id, "brand_submission", { provider_status: brandStatus, retry_requires_review: true }));
    }
    if (/failed|rejected|suspended/.test(campaignStatus)) {
      (await markProviderOperationFailed(orgId, profile.id, "campaign_submission", { provider_status: campaignStatus, retry_requires_review: true }));
    }
    if (numberFailed) {
      (await resetProviderOperationForRetry(orgId, profile.id, "number_order", { provider_status: numberStatus, retry_requires_new_inventory_selection: true }));
      if (selectedNumber) (await releasePhoneNumberOwnership(selectedNumber, orgId, true));
      if (selectedNumber) (await endBillingCommitment("telnyx", "phone_number", selectedNumber));
    } else if (selectedNumber && numberStatus === "success" && cleanText(asObject(saved.campaign).selectedNumberMonthlyCost)) {
      (await upsertBillingCommitment({
        organization_id: orgId, provider: "telnyx", resource_type: "phone_number", resource_id: selectedNumber,
        amount: cleanText(asObject(saved.campaign).selectedNumberMonthlyCost),
        currency: cleanText(asObject(saved.campaign).selectedNumberCurrency || "USD"),
        billing_interval: "month", status: "active",
        metadata: { number_order_id: numberOrderId, compliance_profile_id: profile.id, provider_price_source: "availability_inventory" }
      }));
    }
    if (active) await setDefaultSmsComplianceProfile(saved);
    await ensureDefaultSenderIdentities(orgId);
    return { ok: true, brand: brandResponse, campaign: campaignResponse, number_order: numberOrderResponse, number_campaign: assignmentResponse, profile: publicSmsComplianceProfile(saved) };
  });

  app.post("/organizations/:orgId/sms/compliance-profiles/:profileId/deactivate", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await requireSmsSettingsAccess(request, orgId, true);
    const body = asObject(request.body);
    if (body.confirm_irreversible !== true || typeof body.release_number !== "boolean") {
      throw badRequest("deactivation_confirmation_required", "Confirm campaign deactivation and choose whether to keep or release the business number. Keeping the number preserves its number rental charges.");
    }
    const { profile: current } = await profileForRequest(orgId, param(request.params, "profileId"));
    const refs = asObject(current.provider_refs);
    const phoneNumber = normalizePhone(asObject(current.campaign).selectedNumber);
    const releaseNumber = body.release_number === true;
    const { resource: voiceResource } = await import("../comms/calls/storage.js");
    const voiceLine = phoneNumber ? (await voiceResource(orgId, "number", phoneNumber)) : null;
    if (releaseNumber && voiceLine && voiceLine.status !== "disconnected") {
      throw conflict("number_used_by_voice", "This number is connected to FirstMate phone. Keep the number when disabling SMS, or disconnect its voice route before releasing it.");
    }
    const campaignId = cleanText(refs.telnyx_campaign_id);
    const messagingProfileId = cleanText(refs.telnyx_messaging_profile_id);
    const requestHash = payloadHash({ phoneNumber, campaignId, messagingProfileId, releaseNumber });
    const operation = (await beginProviderOperation({
      organization_id: orgId, compliance_profile_id: current.id,
      operation_type: "service_deactivation", request_hash: requestHash
    }));
    if (operation.state === "conflict") throw conflict("provider_operation_conflict", "A different SMS deactivation operation already exists.");
    if (operation.state === "pending") throw conflict("provider_operation_in_progress", "SMS deactivation is already in progress.");
    if (operation.state === "succeeded") {
      return { ok: true, idempotent_replay: true, profile: publicSmsComplianceProfile(current) };
    }
    const pending = await appendSmsComplianceEvent(current, {
      type: "service_deactivation_requested", provider: "telnyx",
      actor: { user_id: ctx.userId, ip: request.ip }, release_number: releaseNumber
    }, { status: "deactivation_pending" });
    for (const delivery of (await suspendOrganizationSmsDeliveries(orgId))) {
      (await refreshParentMessageStatus(orgId, cleanText(delivery.message_id)));
    }
    const client = createTelnyxClient();
    const ignoreMissing = async (call: () => Promise<unknown>) => {
      try { return await call(); } catch (error) {
        if (error instanceof TelnyxError && error.statusCode === 404) return null;
        throw error;
      }
    };
    try {
      if (messagingProfileId) await client.updateMessagingProfile(messagingProfileId, { enabled: false });
      if (phoneNumber && campaignId) await ignoreMissing(() => client.deletePhoneNumberCampaign(phoneNumber));
      if (campaignId) await ignoreMissing(() => client.deactivate10DlcCampaign(campaignId));
      if (phoneNumber && releaseNumber) {
        const ownership = (await findPhoneNumberOwner(phoneNumber));
        let phoneNumberId = cleanText(ownership?.provider_phone_number_id);
        if (phoneNumberId) {
          const ownedResponse = providerData(await client.getPhoneNumber(phoneNumberId));
          if (normalizePhone(ownedResponse.phone_number) !== phoneNumber) throw new Error("The stored Telnyx phone-number ID does not match the organization number.");
        } else {
          const ownedNumber = await client.findOwnedPhoneNumber(phoneNumber);
          phoneNumberId = cleanText(ownedNumber?.id);
        }
        if (!phoneNumberId && operation.state !== "outcome_unknown") {
          throw new Error("Telnyx did not return the owned phone-number record; recurring cost tracking remains active pending reconciliation.");
        }
        if (phoneNumberId) await ignoreMissing(() => client.deletePhoneNumber(phoneNumberId));
        (await releasePhoneNumberOwnership(phoneNumber, orgId, true));
        (await endBillingCommitment("telnyx", "phone_number", phoneNumber));
      }
      if (campaignId) (await endBillingCommitment("telnyx", "campaign", campaignId));
      (await finishProviderOperation(cleanText(asObject(operation.operation).id), { status: "succeeded", provider_id: campaignId, response: { phone_number_released: Boolean(phoneNumber) && releaseNumber, campaign_deactivated: Boolean(campaignId), messaging_profile_disabled: Boolean(messagingProfileId) } }));
      const saved = await appendSmsComplianceEvent(pending, {
        type: "service_deactivated", provider: "telnyx", phone_number_released: Boolean(phoneNumber) && releaseNumber, campaign_deactivated: Boolean(campaignId)
      }, {
        status: "deactivated", campaign_status: campaignId ? "deactivated" : pending.campaign_status,
        phone_number_status: phoneNumber && releaseNumber ? "released" : pending.phone_number_status,
        phone_number_campaign_status: phoneNumber && campaignId ? "unassigned" : pending.phone_number_campaign_status,
        phone_number_campaign_id: ""
      });
      await ensureDefaultSenderIdentities(orgId);
      return { ok: true, profile: publicSmsComplianceProfile(saved) };
    } catch (error) {
      const unknown = error instanceof TelnyxError && asObject(error.details).submission_unknown === true;
      (await finishProviderOperation(cleanText(asObject(operation.operation).id), { status: unknown ? "outcome_unknown" : "failed", error: telnyxErrorDetails(error) }));
      await appendSmsComplianceEvent(pending, { type: "service_deactivation_failed", provider: "telnyx", error: telnyxErrorDetails(error) }, { status: "deactivation_pending" });
      throw error;
    }
  });

  app.get("/organizations/:orgId/sms/compliance-profiles/:profileId/status", async (request) => {
    const orgId = param(request.params, "orgId");
    await requireSmsSettingsAccess(request, orgId);
    const { profile } = await profileForRequest(orgId, param(request.params, "profileId"));
    return {
      ok: true,
      status: profile.status,
      brand_status: profile.brand_status,
      campaign_status: profile.campaign_status,
      provider_refs: profile.provider_refs,
      validation: profileValidation(profile)
    };
  });
};
