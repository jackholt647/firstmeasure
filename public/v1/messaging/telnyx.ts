import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../src/config/env.js";

export type TelnyxClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type TelnyxMessagingProfileSummary = {
  id: string;
  name: string;
  enabled: boolean | null;
  webhook_url: string;
};

export type TelnyxAutorespConfig = {
  id: string;
  op: string;
  keywords: string[];
  country_code: string;
  resp_text: string;
};

export class TelnyxError extends Error {
  statusCode: number;
  details: unknown;
  headers: Record<string, string>;
  retryable: boolean;

  constructor(message: string, statusCode: number, details: unknown = null, headers: Record<string, string> = {}) {
    super(message);
    this.name = "TelnyxError";
    this.statusCode = statusCode;
    this.details = details;
    this.headers = headers;
    this.retryable = statusCode === 429 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504;
  }
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function deliveryWebhookToken(deliveryId: string) {
  if (!env.messagingEncryptionKey || !deliveryId) return "";
  return createHmac("sha256", env.messagingEncryptionKey).update(`telnyx-delivery:${deliveryId}`).digest("base64url");
}

export function telnyxDeliveryWebhookUrl(deliveryId: string, baseUrl = env.telnyxWebhookUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("delivery_id", deliveryId);
  url.searchParams.set("delivery_token", deliveryWebhookToken(deliveryId));
  return url.toString();
}

export function verifyTelnyxDeliveryWebhookToken(deliveryId: string, token: string) {
  const expected = deliveryWebhookToken(deliveryId);
  const received = cleanText(token);
  if (!expected || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export class TelnyxClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelnyxClientOptions = {}) {
    this.apiKey = options.apiKey ?? env.telnyxApiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? env.telnyxBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async request(path: string, init: RequestInit = {}) {
    if (!this.apiKey) {
      throw new TelnyxError("TELNYX_API_KEY is not configured.", 500, { code: "missing_telnyx_api_key" });
    }
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("Accept", "application/json");
    if (init.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const timeoutSignal = AbortSignal.timeout(env.telnyxRequestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers, signal });
    } catch (error) {
      const timedOut = timeoutSignal.aborted;
      throw new TelnyxError(
        timedOut ? "Telnyx request timed out." : "Telnyx request could not be completed.",
        502,
        { code: timedOut ? "telnyx_timeout" : "telnyx_network_error", message: error instanceof Error ? error.message : String(error), submission_unknown: init.method?.toUpperCase() === "POST" }
      );
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const method = cleanText(init.method || "GET").toUpperCase();
      const submissionUnknown = method === "POST" && response.status >= 500;
      const details = submissionUnknown
        ? { ...asRecord(payload), submission_unknown: true, provider_response: payload }
        : payload;
      throw new TelnyxError(`Telnyx request failed with ${response.status}.`, response.status, details, Object.fromEntries(response.headers.entries()));
    }
    return payload;
  }

  async tenDlcRequest(path: string, init: RequestInit = {}) {
    return await this.request(path, init);
  }

  async listMessagingProfiles(limit = 10): Promise<TelnyxMessagingProfileSummary[]> {
    const payload = asRecord(await this.request(`/messaging_profiles?page[size]=${Math.max(1, Math.min(100, Math.floor(limit)))}`));
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data.map((entry) => {
      const profile = asRecord(entry);
      return {
        id: cleanText(profile.id),
        name: cleanText(profile.name),
        enabled: typeof profile.enabled === "boolean" ? profile.enabled : null,
        webhook_url: cleanText(profile.webhook_url)
      };
    }).filter((profile) => profile.id);
  }

  async findMessagingProfileByName(name: string) {
    return (await this.listMessagingProfilesByName(name, 10))[0] || null;
  }

  async listMessagingProfilesByName(name: string, limit = 10): Promise<TelnyxMessagingProfileSummary[]> {
    const size = Math.max(1, Math.min(100, Math.floor(limit)));
    const payload = asRecord(await this.request(`/messaging_profiles?filter[name][eq]=${encodeURIComponent(name)}&page[size]=${size}`));
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data.map((entry) => {
      const profile = asRecord(entry);
      return {
        id: cleanText(profile.id),
        name: cleanText(profile.name),
        enabled: typeof profile.enabled === "boolean" ? profile.enabled : null,
        webhook_url: cleanText(profile.webhook_url)
      };
    }).filter((profile) => profile.id && profile.name === name);
  }

  async create10DlcBrand(payload: Record<string, unknown>) {
    return await this.tenDlcRequest("/10dlc/brand", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async get10DlcBrand(brandId: string) {
    return await this.tenDlcRequest(`/10dlc/brand/${encodeURIComponent(brandId)}`);
  }

  async update10DlcBrand(brandId: string, payload: Record<string, unknown>) {
    return await this.tenDlcRequest(`/10dlc/brand/${encodeURIComponent(brandId)}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  }

  async list10DlcBrands(displayName = "", entityType = "") {
    const query = new URLSearchParams({ page: "1", recordsPerPage: "500" });
    if (displayName) query.set("displayName", displayName);
    if (entityType) query.set("entityType", entityType);
    const payload = asRecord(await this.tenDlcRequest(`/10dlc/brand?${query.toString()}`));
    return Array.isArray(payload.records) ? payload.records.map(asRecord) : [];
  }

  async trigger10DlcBrandSmsOtp(brandId: string) {
    return await this.tenDlcRequest(`/10dlc/brand/${encodeURIComponent(brandId)}/smsOtp`, {
      method: "POST",
      body: JSON.stringify({
        pinSms: "Your FirstMate/Telnyx 10DLC verification code is @OTP_PIN@. It expires in 24 hours.",
        successSms: "Your FirstMate 10DLC business identity has been verified successfully."
      })
    });
  }

  async get10DlcBrandSmsOtp(referenceId: string) {
    return await this.tenDlcRequest(`/10dlc/brand/smsOtp/${encodeURIComponent(referenceId)}`);
  }

  async verify10DlcBrandSmsOtp(brandId: string, otpPin: string) {
    return await this.tenDlcRequest(`/10dlc/brand/${encodeURIComponent(brandId)}/smsOtp`, {
      method: "PUT",
      body: JSON.stringify({ otpPin })
    });
  }

  async qualify10DlcBrandByUsecase(brandId: string, usecase: string) {
    return await this.tenDlcRequest(`/10dlc/campaignBuilder/brand/${encodeURIComponent(brandId)}/usecase/${encodeURIComponent(usecase)}`);
  }

  async submit10DlcCampaign(payload: Record<string, unknown>) {
    return await this.tenDlcRequest("/10dlc/campaignBuilder", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async get10DlcCampaign(campaignId: string) {
    return await this.tenDlcRequest(`/10dlc/campaign/${encodeURIComponent(campaignId)}`);
  }

  async submit10DlcCampaignAppeal(campaignId: string, appealReason: string) {
    return await this.tenDlcRequest(`/10dlc/campaign/${encodeURIComponent(campaignId)}/appeal`, {
      method: "POST",
      body: JSON.stringify({ appeal_reason: appealReason })
    });
  }

  async list10DlcCampaigns(brandId: string) {
    const query = new URLSearchParams({ brandId, page: "1", recordsPerPage: "500" });
    const payload = asRecord(await this.tenDlcRequest(`/10dlc/campaign?${query.toString()}`));
    return Array.isArray(payload.records) ? payload.records.map(asRecord) : [];
  }

  async get10DlcCampaignUsecaseCost(usecase: string) {
    return await this.tenDlcRequest(`/10dlc/campaign/usecase_cost?usecase=${encodeURIComponent(usecase)}`);
  }

  async deactivate10DlcCampaign(campaignId: string) {
    return await this.tenDlcRequest(`/10dlc/campaign/${encodeURIComponent(campaignId)}`, { method: "DELETE" });
  }

  async createMessagingProfile(payload: Record<string, unknown>) {
    return await this.request("/messaging_profiles", { method: "POST", body: JSON.stringify(payload) });
  }

  async updateMessagingProfile(profileId: string, payload: Record<string, unknown>) {
    return await this.request(`/messaging_profiles/${encodeURIComponent(profileId)}`, { method: "PATCH", body: JSON.stringify(payload) });
  }

  async getMessagingProfile(profileId: string) {
    return await this.request(`/messaging_profiles/${encodeURIComponent(profileId)}`);
  }

  async listMessagingProfileAutorespConfigs(profileId: string, countryCode = "US"): Promise<TelnyxAutorespConfig[]> {
    const query = countryCode ? `?country_code=${encodeURIComponent(countryCode)}` : "";
    const payload = asRecord(await this.request(`/messaging_profiles/${encodeURIComponent(profileId)}/autoresp_configs${query}`));
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data.map((entry) => {
      const config = asRecord(entry);
      return {
        id: cleanText(config.id),
        op: cleanText(config.op).toLowerCase(),
        keywords: Array.isArray(config.keywords) ? config.keywords.map(cleanText).filter(Boolean) : [],
        country_code: cleanText(config.country_code).toUpperCase(),
        resp_text: cleanText(config.resp_text)
      };
    }).filter((config) => config.id);
  }

  async createMessagingProfileAutorespConfig(profileId: string, payload: Record<string, unknown>) {
    return await this.request(`/messaging_profiles/${encodeURIComponent(profileId)}/autoresp_configs`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async updateMessagingProfileAutorespConfig(profileId: string, configId: string, payload: Record<string, unknown>) {
    return await this.request(`/messaging_profiles/${encodeURIComponent(profileId)}/autoresp_configs/${encodeURIComponent(configId)}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  }

  async deleteMessagingProfileAutorespConfig(profileId: string, configId: string) {
    return await this.request(`/messaging_profiles/${encodeURIComponent(profileId)}/autoresp_configs/${encodeURIComponent(configId)}`, {
      method: "DELETE"
    });
  }

  async searchAvailablePhoneNumbers(areaCode: string, limit = 10) {
    const size = Math.max(1, Math.min(50, Math.floor(limit)));
    return await this.request(`/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=${encodeURIComponent(areaCode)}&filter[phone_number_type]=local&filter[features]=sms,mms&filter[limit]=${size}&filter[best_effort]=false&filter[exclude_held_numbers]=true`);
  }

  async findExactAvailablePhoneNumber(phoneNumber: string) {
    return await this.request(`/available_phone_numbers?filter[country_code]=US&filter[phone_number]=${encodeURIComponent(phoneNumber)}&filter[phone_number_type]=local&filter[features]=sms&filter[limit]=1&filter[best_effort]=false&filter[exclude_held_numbers]=true`);
  }

  async createNumberOrder(phoneNumber: string, messagingProfileId: string, customerReference: string) {
    return await this.request("/number_orders", {
      method: "POST",
      body: JSON.stringify({
        phone_numbers: [{ phone_number: phoneNumber }],
        messaging_profile_id: messagingProfileId,
        customer_reference: customerReference
      })
    });
  }

  async getNumberOrder(orderId: string) {
    return await this.request(`/number_orders/${encodeURIComponent(orderId)}`);
  }

  async findNumberOrdersByCustomerReference(customerReference: string) {
    const payload = asRecord(await this.request(`/number_orders?filter[customer_reference]=${encodeURIComponent(customerReference)}&page[size]=20`));
    return Array.isArray(payload.data) ? payload.data.map(asRecord) : [];
  }

  async assignPhoneNumberToCampaign(phoneNumber: string, campaignId: string) {
    return await this.tenDlcRequest("/10dlc/phone_number_campaigns", {
      method: "POST",
      body: JSON.stringify({ phoneNumber, campaignId })
    });
  }

  async getPhoneNumberCampaign(phoneNumber: string) {
    return await this.tenDlcRequest(`/10dlc/phone_number_campaigns/${encodeURIComponent(phoneNumber)}`);
  }

  async deletePhoneNumberCampaign(phoneNumber: string) {
    return await this.tenDlcRequest(`/10dlc/phone_number_campaigns/${encodeURIComponent(phoneNumber)}`, { method: "DELETE" });
  }

  async findOwnedPhoneNumber(phoneNumber: string) {
    const payload = asRecord(await this.request(`/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}&page[size]=10`));
    const data = Array.isArray(payload.data) ? payload.data.map(asRecord) : [];
    return data.find((entry) => cleanText(entry.phone_number) === phoneNumber) || null;
  }

  async getPhoneNumber(phoneNumberId: string) {
    return await this.request(`/phone_numbers/${encodeURIComponent(phoneNumberId)}`);
  }

  async deletePhoneNumber(phoneNumberId: string) {
    return await this.request(`/phone_numbers/${encodeURIComponent(phoneNumberId)}`, { method: "DELETE" });
  }

  async sendMessage(payload: Record<string, unknown>) {
    return await this.request("/messages", { method: "POST", body: JSON.stringify(payload) });
  }

  async getMessage(messageId: string) {
    return await this.request(`/messages/${encodeURIComponent(messageId)}`);
  }

  async cancelScheduledMessage(messageId: string) {
    return await this.request(`/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
  }
}

export function createTelnyxClient(options: TelnyxClientOptions = {}) {
  return new TelnyxClient(options);
}
