/**
 * Fetch a URL a person or a stored record supplied
 * (docs/architecture/request-security.md#fetching-urls).
 *
 * Only http(s) on ports 80/443 (or an explicit allowed port), every resolved
 * address checked against private, loopback, link-local, metadata, CGNAT,
 * multicast and reserved ranges (IPv4 and IPv6, mapped forms included), the
 * socket connected to the address that was checked (no DNS rebinding),
 * redirects followed by hand and re-checked, with size and time limits.
 */
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
] as const) blocked.addSubnet(network, prefix, "ipv6");

/** Whether an address literal may be connected to. */
export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, "ipv6");
  }
  return !blocked.check(address, "ipv4");
}

export class SafeFetchError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Content types accepted, as prefixes ("image/"). Anything else is refused. */
  accept?: string[];
  allowPorts?: number[];
};

export type SafeFetchResult = { url: string; status: number; contentType: string; body: Buffer };

const checkedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    const list = Array.isArray(addresses) ? addresses : [];
    const unsafe = list.find((entry) => !isPublicAddress(entry.address));
    if (!list.length || unsafe) {
      return callback(new SafeFetchError("address_not_public", `${hostname} does not resolve to a public address.`) as NodeJS.ErrnoException, "", 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

function checkUrl(raw: string, allowPorts: number[]) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SafeFetchError("invalid_url", "The address is not a valid URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("protocol_not_allowed", "Only http and https addresses can be fetched.");
  if (url.username || url.password) throw new SafeFetchError("credentials_not_allowed", "Addresses with credentials cannot be fetched.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (![80, 443, ...allowPorts].includes(port)) throw new SafeFetchError("port_not_allowed", "That port cannot be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new SafeFetchError("address_not_public", "That address is not public.");
  if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) throw new SafeFetchError("address_not_public", "That address is not public.");
  return url;
}

function requestOnce(url: URL, options: Required<Pick<SafeFetchOptions, "maxBytes" | "timeoutMs">> & SafeFetchOptions) {
  return new Promise<{ status: number; location: string; contentType: string; body: Buffer }>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "GET",
      lookup: checkedLookup,
      headers: { "user-agent": "FirstMate-Fetch/1.0", accept: "*/*", ...(options.headers ?? {}) },
      timeout: options.timeoutMs
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = String(response.headers.location ?? "");
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      if (status >= 300 && status < 400 && location) {
        response.resume();
        return resolve({ status, location, contentType, body: Buffer.alloc(0) });
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > options.maxBytes) {
        response.destroy();
        return reject(new SafeFetchError("too_large", "The file is too large."));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          response.destroy();
          reject(new SafeFetchError("too_large", "The file is too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, location: "", contentType, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new SafeFetchError("timeout", "The address took too long to answer.")));
    request.on("error", reject);
    request.end();
  });
}

export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const settings = { maxBytes: 10 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3, ...options };
  let url = checkUrl(raw, settings.allowPorts ?? []);
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestOnce(url, settings);
    if (response.location) {
      if (redirects >= settings.maxRedirects) throw new SafeFetchError("too_many_redirects", "The address redirected too many times.");
      url = checkUrl(new URL(response.location, url).href, settings.allowPorts ?? []);
      continue;
    }
    if (settings.accept?.length && !settings.accept.some((prefix) => response.contentType.startsWith(prefix))) {
      throw new SafeFetchError("content_type_not_allowed", "The address did not return an accepted file type.");
    }
    return { url: url.href, status: response.status, contentType: response.contentType, body: response.body };
  }
}
