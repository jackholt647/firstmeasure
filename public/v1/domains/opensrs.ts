import { createHash } from "node:crypto";

import { XMLParser } from "fast-xml-parser";

import { env } from "../src/config/env.js";

export type OpenSrsEnvironment = "live" | "test";
export type OpenSrsValue = string | number | boolean | null | OpenSrsValue[] | { [key: string]: OpenSrsValue };
export type OpenSrsRecord = { [key: string]: OpenSrsValue };

export class OpenSrsError extends Error {
  readonly responseCode: string;
  readonly responseText: string;
  readonly details: OpenSrsRecord;
  readonly outcomeUnknown: boolean;

  constructor(message: string, options: {
    responseCode?: string;
    responseText?: string;
    details?: OpenSrsRecord;
    outcomeUnknown?: boolean;
  } = {}) {
    super(message);
    this.name = "OpenSrsError";
    this.responseCode = options.responseCode ?? "";
    this.responseText = options.responseText ?? "";
    this.details = options.details ?? {};
    this.outcomeUnknown = options.outcomeUnknown === true;
  }
}

function xmlEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeValue(value: OpenSrsValue): string {
  if (Array.isArray(value)) {
    return `<dt_array>${value.map((item, index) => `<item key="${index}">${encodeValue(item)}</item>`).join("")}</dt_array>`;
  }
  if (value && typeof value === "object") {
    return `<dt_assoc>${Object.entries(value).map(([key, item]) => (
      `<item key="${xmlEscape(key)}">${encodeValue(item)}</item>`
    )).join("")}</dt_assoc>`;
  }
  return xmlEscape(value === null ? "" : value);
}

export function buildOpenSrsXml(action: string, object: string, attributes: OpenSrsRecord): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><OPS_envelope><header><version>0.9</version></header><body><data_block><dt_assoc>${[
    ["protocol", "XCP"],
    ["action", action.toUpperCase()],
    ["object", object.toUpperCase()],
    ["attributes", attributes]
  ].map(([key, value]) => `<item key="${key}">${encodeValue(value as OpenSrsValue)}</item>`).join("")}</dt_assoc></data_block></body></OPS_envelope>`;
}

export function openSrsSignature(xml: string, apiKey: string) {
  const inner = createHash("md5").update(xml + apiKey, "utf8").digest("hex");
  return createHash("md5").update(inner + apiKey, "utf8").digest("hex");
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true
});

function itemList(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [value as Record<string, unknown>];
}

function decodeContainer(container: unknown, arrayMode = false): OpenSrsValue {
  const source = container && typeof container === "object" ? container as Record<string, unknown> : {};
  const items = itemList(source.item);
  if (arrayMode) {
    return items
      .sort((a, b) => Number(a["@_key"] ?? 0) - Number(b["@_key"] ?? 0))
      .map(decodeItem);
  }
  const out: OpenSrsRecord = {};
  for (const item of items) out[String(item["@_key"] ?? "")] = decodeItem(item);
  return out;
}

function decodeItem(item: Record<string, unknown>): OpenSrsValue {
  if (item.dt_assoc !== undefined) return decodeContainer(item.dt_assoc);
  if (item.dt_array !== undefined) return decodeContainer(item.dt_array, true);
  const value = item["#text"];
  return value === undefined || value === null ? "" : String(value);
}

export function parseOpenSrsXml(xml: string): OpenSrsRecord {
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new OpenSrsError("OpenSRS returned malformed XML.", { outcomeUnknown: true });
  }
  const envelope = parsed.OPS_envelope as Record<string, unknown> | undefined;
  const body = envelope?.body as Record<string, unknown> | undefined;
  const dataBlock = body?.data_block as Record<string, unknown> | undefined;
  const decoded = decodeContainer(dataBlock?.dt_assoc);
  return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as OpenSrsRecord : {};
}

function record(value: OpenSrsValue | undefined): OpenSrsRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as OpenSrsRecord : {};
}

function text(value: OpenSrsValue | undefined) {
  return String(value ?? "").trim();
}

export type OpenSrsClientOptions = {
  username?: string;
  apiKey?: string;
  environment?: OpenSrsEnvironment;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createOpenSrsClient(options: OpenSrsClientOptions = {}) {
  const environment = options.environment ?? env.domainsDeliveryMode;
  const username = options.username ?? (environment === "live" ? env.openSrsLiveUsername : env.openSrsTestUsername);
  const apiKey = options.apiKey ?? (environment === "live" ? env.openSrsLiveApiKey : env.openSrsTestApiKey);
  const endpoint = options.endpoint ?? (environment === "live" ? env.openSrsLiveEndpoint : env.openSrsTestEndpoint);
  const timeoutMs = options.timeoutMs ?? env.openSrsRequestTimeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(action: string, attributes: OpenSrsRecord) {
    if (!username || !apiKey) throw new OpenSrsError("OpenSRS is not configured.");
    const xml = buildOpenSrsXml(action, "domain", attributes);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml",
          "X-Username": username,
          "X-Signature": openSrsSignature(xml, apiKey)
        },
        body: xml,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new OpenSrsError(error instanceof Error ? error.message : "OpenSRS request failed.", { outcomeUnknown: true });
    }
    const responseXml = await response.text();
    if (!response.ok) {
      throw new OpenSrsError(`OpenSRS returned HTTP ${response.status}.`, { outcomeUnknown: response.status >= 500 });
    }
    const payload = parseOpenSrsXml(responseXml);
    const responseCode = text(payload.response_code);
    const responseText = text(payload.response_text);
    const responseAttributes = record(payload.attributes);
    if (text(payload.is_success) !== "1") {
      throw new OpenSrsError(responseText || "OpenSRS rejected the request.", {
        responseCode,
        responseText,
        details: responseAttributes
      });
    }
    return { responseCode, responseText, attributes: responseAttributes };
  }

  return {
    environment,
    async lookup(domain: string) {
      const result = await request("lookup", { domain, no_cache: 1 });
      return {
        available: text(result.attributes.status).toLowerCase() === "available" && result.responseCode === "210",
        status: text(result.attributes.status).toLowerCase(),
        premium: text(result.attributes.reason).toLowerCase() === "premium name",
        reason: text(result.attributes.reason),
        responseCode: result.responseCode,
        responseText: result.responseText
      };
    },
    async getPrice(domain: string, period = 1, registrationType: "new" | "transfer" = "new") {
      const result = await request("get_price", { domain, period, reg_type: registrationType });
      return {
        price: text(result.attributes.price),
        premium: text(result.attributes.is_registry_premium) === "1",
        premiumGroup: text(result.attributes.registry_premium_group)
      };
    },
    async belongsToReseller(domain: string) {
      const result = await request("belongs_to_rsp", { domain });
      return {
        belongs: text(result.attributes.belongs_to_rsp) === "1",
        expiresAt: text(result.attributes.domain_expdate)
      };
    },
    async register(input: {
      domain: string;
      period: number;
      registrantUsername: string;
      registrantPassword: string;
      contact: OpenSrsRecord;
      premiumPrice?: string;
    }) {
      const result = await request("sw_register", {
        domain: input.domain,
        reg_type: "new",
        reg_username: input.registrantUsername,
        reg_password: input.registrantPassword,
        period: input.period,
        handle: "process",
        auto_renew: 1,
        f_lock_domain: 1,
        f_whois_privacy: 1,
        custom_nameservers: 0,
        custom_tech_contact: 1,
        link_domains: 0,
        contact_set: {
          owner: input.contact,
          admin: input.contact,
          billing: input.contact,
          tech: input.contact
        },
        ...(input.premiumPrice ? { premium_price_to_verify: input.premiumPrice } : {})
      });
      return {
        orderId: text(result.attributes.id),
        domainId: text(result.attributes.domain_id),
        registrationCode: text(result.attributes.registration_code || result.responseCode),
        registrationText: text(result.attributes.registration_text || result.responseText),
        privacyState: text(result.attributes.whois_privacy_state)
      };
    },
    async transfer(input: {
      domain: string;
      authCode: string;
      registrantUsername: string;
      registrantPassword: string;
      contact: OpenSrsRecord;
      premiumPrice?: string;
    }) {
      const result = await request("sw_register", {
        domain: input.domain,
        reg_type: "transfer",
        reg_username: input.registrantUsername,
        reg_password: input.registrantPassword,
        auth_info: input.authCode,
        period: 1,
        handle: "process",
        auto_renew: 1,
        f_lock_domain: 1,
        f_whois_privacy: 1,
        custom_nameservers: 0,
        custom_transfer_nameservers: 0,
        custom_tech_contact: 1,
        link_domains: 0,
        contact_set: {
          owner: input.contact,
          admin: input.contact,
          billing: input.contact,
          tech: input.contact
        },
        ...(input.premiumPrice ? { premium_price_to_verify: input.premiumPrice } : {})
      });
      return {
        orderId: text(result.attributes.id),
        transferId: text(result.attributes.transfer_id),
        domainId: text(result.attributes.domain_id),
        privacyState: text(result.attributes.whois_privacy_state)
      };
    },
    async registrantVerificationStatus(domain: string) {
      const result = await request("get_registrant_verification_status", { domain });
      const status = text(result.attributes.registrant_verification_status);
      return { status: status || "not_required" };
    },
    async sendRegistrantVerificationEmail(domain: string) {
      const result = await request("send_registrant_verification_email", { domain });
      return { sent: true, responseCode: result.responseCode };
    },
    async setAutoRenew(domain: string, enabled: boolean) {
      const result = await request("modify", {
        domain,
        affect_domains: 0,
        data: "expire_action",
        auto_renew: enabled ? 1 : 0,
        let_expire: 0
      });
      return { updated: true, responseCode: result.responseCode };
    },
    async setDomainLock(domain: string, locked: boolean) {
      const result = await request("modify", {
        domain,
        affect_domains: 0,
        data: "status",
        lock_state: locked ? 1 : 0
      });
      return { updated: true, responseCode: result.responseCode };
    },
    async setWhoisPrivacy(domain: string, enabled: boolean) {
      const result = await request("modify", {
        domain,
        affect_domains: 0,
        data: "whois_privacy_state",
        state: enabled ? "enable" : "disable"
      });
      return { updated: true, responseCode: result.responseCode };
    },
    async updateNameservers(domain: string, nameservers: string[]) {
      const result = await request("advanced_update_nameservers", {
        domain,
        op_type: "assign",
        assign_ns: nameservers
      });
      return { updated: true, responseCode: result.responseCode };
    },
    async sendTransferAuthCode(domain: string) {
      const result = await request("send_authcode", { domain_name: domain });
      return { sent: true, responseCode: result.responseCode };
    }
  };
}
