import { normalizeIdentityPhone } from "../platform/identity_phone.js";
import { guardDevelopmentSms } from "../src/environment_safety.js";

export type TelnyxVerifyClientOptions = {
  apiKey?: string;
  profileId?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type TelnyxVerificationResult =
  | "accepted"
  | "rejected"
  | "expired"
  | "max_attempts_exceeded"
  | string;

export class TelnyxVerifyError extends Error {
  readonly statusCode: number;
  readonly details: unknown;

  constructor(message: string, statusCode: number, details: unknown = null) {
    super(message);
    this.name = "TelnyxVerifyError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Normalize North American local numbers or already international numbers to E.164. */
export function normalizeE164Phone(value: unknown) {
  return normalizeIdentityPhone(value);
}

export function maskPhoneNumber(phone: string) {
  const normalized = normalizeE164Phone(phone);
  if (!normalized) return "your phone";
  return `phone ending in ${normalized.slice(-4)}`;
}

export class TelnyxVerifyClient {
  private readonly apiKey: string;
  private readonly profileId: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelnyxVerifyClientOptions = {}) {
    this.apiKey = cleanText(options.apiKey ?? process.env.TELNYX_API_KEY);
    this.profileId = cleanText(options.profileId ?? process.env.TELNYX_VERIFY_PROFILE_ID);
    this.baseUrl = cleanText(options.baseUrl ?? process.env.TELNYX_BASE_URL ?? "https://api.telnyx.com/v2").replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured() {
    return Boolean(this.apiKey && this.profileId);
  }

  private async request(path: string, body: Record<string, unknown>) {
    if (!this.configured) {
      throw new TelnyxVerifyError("Telnyx Verify is not configured.", 503, { code: "telnyx_verify_not_configured" });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (error) {
      throw new TelnyxVerifyError("Telnyx Verify could not be reached.", 502, {
        code: "telnyx_verify_network_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const responseText = await response.text();
    let payload: unknown = null;
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }
    }
    if (!response.ok) {
      throw new TelnyxVerifyError("Telnyx Verify rejected the request.", response.status, payload);
    }
    return asRecord(payload);
  }

  async startSms(phoneNumber: string) {
    const phone = normalizeE164Phone(phoneNumber);
    if (!phone) throw new TelnyxVerifyError("A valid mobile phone number is required.", 400, { code: "invalid_phone_number" });
    const guard = guardDevelopmentSms(phone);
    if (!guard.allowed) {
      throw new TelnyxVerifyError("SMS delivery is blocked by the development safety policy.", 403, { code: guard.reason });
    }
    const payload = await this.request("/verifications/sms", {
      phone_number: phone,
      verify_profile_id: this.profileId
    });
    const data = asRecord(payload.data);
    return {
      id: cleanText(data.id),
      phone_number: cleanText(data.phone_number) || phone,
      status: cleanText(data.status),
      timeout_secs: Number(data.timeout_secs || 0)
    };
  }

  async verifySms(phoneNumber: string, code: string) {
    const phone = normalizeE164Phone(phoneNumber);
    const otp = cleanText(code);
    if (!phone || !/^\d{4,10}$/.test(otp)) return "rejected" as TelnyxVerificationResult;
    const guard = guardDevelopmentSms(phone);
    if (!guard.allowed) return "rejected" as TelnyxVerificationResult;
    const payload = await this.request(`/verifications/by_phone_number/${encodeURIComponent(phone)}/actions/verify`, {
      code: otp,
      verify_profile_id: this.profileId
    });
    return cleanText(asRecord(payload.data).response_code) as TelnyxVerificationResult;
  }
}

export function createTelnyxVerifyClient(options: TelnyxVerifyClientOptions = {}) {
  return new TelnyxVerifyClient(options);
}
