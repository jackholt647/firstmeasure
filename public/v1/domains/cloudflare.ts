import { env } from "../src/config/env.js";

export type CloudflareDnsRecord = {
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT";
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
};

type CloudflareZone = { id: string; name: string; status: string; name_servers?: string[] };
type CloudflareRecord = CloudflareDnsRecord & { id: string };
type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
};

export class CloudflareError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = "CloudflareError";
  }
}

function recordCanProxy(type: CloudflareDnsRecord["type"]) {
  return type === "A" || type === "AAAA" || type === "CNAME";
}

export function createCloudflareClient(options: {
  accountId?: string;
  apiToken?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}) {
  const accountId = options.accountId ?? env.cloudflareAccountId;
  const apiToken = options.apiToken ?? env.cloudflareApiToken;
  const apiBaseUrl = (options.apiBaseUrl ?? env.cloudflareApiBaseUrl).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init: RequestInit = {}) {
    if (!accountId || !apiToken) throw new CloudflareError("Cloudflare provisioning is not configured.", 503);
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        ...init.headers
      }
    });
    const body = await response.json().catch(() => null) as CloudflareEnvelope<T> | null;
    if (!response.ok || !body?.success) {
      const detail = body?.errors?.map((error) => error.message).filter(Boolean).join(" ");
      throw new CloudflareError(detail || `Cloudflare returned HTTP ${response.status}.`, response.status || 502);
    }
    return body.result;
  }

  async function findZone(domain: string) {
    const zones = await request<CloudflareZone[]>(`/zones?name=${encodeURIComponent(domain)}&account.id=${encodeURIComponent(accountId)}`);
    return zones.find((zone) => zone.name.toLowerCase() === domain.toLowerCase()) ?? null;
  }

  async function ensureZone(domain: string) {
    const existing = await findZone(domain);
    if (existing) return { zone: existing, created: false };
    const zone = await request<CloudflareZone>("/zones", {
      method: "POST",
      body: JSON.stringify({ name: domain, account: { id: accountId }, type: "full" })
    });
    return { zone, created: true };
  }

  async function upsertDnsRecord(zoneId: string, record: CloudflareDnsRecord) {
    const query = `/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}`;
    const existing = (await request<CloudflareRecord[]>(query))[0];
    const payload = {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl ?? 1,
      ...(record.priority == null ? {} : { priority: record.priority }),
      ...(recordCanProxy(record.type) ? { proxied: record.proxied === true } : {})
    };
    if (existing) {
      return await request<CloudflareRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing.id)}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
    }
    return await request<CloudflareRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async function replaceProxyRecord(zoneId: string, record: CloudflareDnsRecord) {
    if (!recordCanProxy(record.type)) throw new CloudflareError("Only A, AAAA, or CNAME records can be used for a website origin.", 400);
    const name = record.name;
    const query = `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}`;
    const existing = await request<CloudflareRecord[]>(query);
    for (const candidate of existing) {
      if (["A", "AAAA", "CNAME"].includes(candidate.type) && candidate.type !== record.type) {
        await request(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(candidate.id)}`, { method: "DELETE" });
      }
    }
    return await upsertDnsRecord(zoneId, { ...record, proxied: true });
  }

  async function upsertWebsiteCname(zoneId: string, name: string, content: string) {
    return await replaceProxyRecord(zoneId, { type: "CNAME", name, content, proxied: true });
  }

  return { ensureZone, findZone, upsertDnsRecord, replaceProxyRecord, upsertWebsiteCname };
}
