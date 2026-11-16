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
      // jump_start imports the records the domain already serves, so pointing a registrar at the zone keeps them.
      body: JSON.stringify({ name: domain, account: { id: accountId }, type: "full", jump_start: true })
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

  async function listDnsRecords(zoneId: string, type: CloudflareDnsRecord["type"], name: string) {
    return await request<CloudflareRecord[]>(`/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
  }

  /** Add a record only when the name has none of its kind yet (a customer's own DMARC policy is kept). */
  async function addDnsRecordIfMissing(zoneId: string, record: CloudflareDnsRecord, sameKind: (existing: CloudflareRecord) => boolean) {
    const existing = (await listDnsRecords(zoneId, record.type, record.name)).find(sameKind);
    if (existing) return { record: existing, created: false };
    const created = await request<CloudflareRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: record.type, name: record.name, content: record.content, ttl: record.ttl ?? 1 })
    });
    return { record: created, created: true };
  }

  // Email Routing (inbound, FM-516): enabling it adds and locks the root MX and SPF records; the catch-all rule sends
  // every address at the domain to the shared Email Worker, which posts it to FirstMate's inbound endpoint.
  async function enableEmailRouting(zoneId: string, domain: string) {
    return await request<Record<string, unknown>>(`/zones/${encodeURIComponent(zoneId)}/email/routing/dns`, {
      method: "POST",
      body: JSON.stringify({ name: domain })
    });
  }

  async function emailRoutingDnsRecords(zoneId: string) {
    const result = await request<unknown>(`/zones/${encodeURIComponent(zoneId)}/email/routing/dns`);
    return dnsList(result);
  }

  async function routeAllMailToWorker(zoneId: string, workerName: string) {
    return await request<Record<string, unknown>>(`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`, {
      method: "PUT",
      body: JSON.stringify({ name: "FirstMate inbox", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [workerName] }] })
    });
  }

  // Email Sending (outbound): a sending subdomain per domain; its DNS list carries the cf-bounce MX/SPF and DKIM key.
  async function ensureEmailSendingDomain(zoneId: string, domain: string) {
    const base = `/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`;
    const existing = dnsList(await request<unknown>(base)).find((entry) => String(entry.name ?? "").toLowerCase() === domain.toLowerCase());
    if (existing && existing.enabled !== false) return existing;
    return await request<Record<string, unknown>>(base, { method: "POST", body: JSON.stringify({ name: domain }) });
  }

  async function emailSendingDnsRecords(zoneId: string, tag: string) {
    const result = await request<unknown>(`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(tag)}/dns`);
    return dnsList(result);
  }

  return {
    ensureZone, findZone, upsertDnsRecord, replaceProxyRecord, upsertWebsiteCname, listDnsRecords, addDnsRecordIfMissing,
    enableEmailRouting, emailRoutingDnsRecords, routeAllMailToWorker, ensureEmailSendingDomain, emailSendingDnsRecords
  };
}

/** Cloudflare returns DNS lists either as an array or wrapped (`{ record: [...] }`, `{ records: [...] }`). */
function dnsList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === "object") as Array<Record<string, unknown>>;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["record", "records", "result"]) if (Array.isArray(object[key])) return dnsList(object[key]);
  }
  return [];
}
