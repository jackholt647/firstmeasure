import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { badRequest } from "../platform/errors.js";
import type { Obj } from "./contracts.js";

// Test fixtures inject an exact loopback origin; there is no production private-network bypass.
const fixtureOrigins = new Set<string>();
export function allowFixtureOrigin(origin: string) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test only.");
  fixtureOrigins.add(origin);
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      address === "168.63.129.16" ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19].includes(b))
    );
  }
  if (isIP(address) === 6) {
    const [first = 0, second = 0] = address
      .split(":")
      .slice(0, 2)
      .map((part) => parseInt(part || "0", 16));
    // Exclude transition tunnels and special-use prefixes, including compressed forms.
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
  }
  return false;
}
export async function safeUrl(raw: string) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash)
    throw badRequest(
      "connection_url",
      "URLs cannot contain credentials or fragments.",
    );
  const fixture =
    process.env.NODE_ENV === "test" && fixtureOrigins.has(url.origin);
  if (!fixture && url.protocol !== "https:")
    throw badRequest("connection_https", "External connections require HTTPS.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    (!fixture && addresses.some((a) => !publicAddress(a.address)))
  )
    throw badRequest(
      "connection_destination",
      "This destination is not a public internet address.",
    );
  return { url, address: addresses[0]! };
}
export async function requestExternal(
  raw: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxBytes?: number;
  } = {},
) {
  const { url, address } = await safeUrl(raw);
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
    bytes: Buffer;
  }>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    let done = false;
    const fail = () => {
      if (!done) {
        done = true;
        reject(
          badRequest(
            "connection_request_failed",
            "The external request failed or exceeded its time or size limit.",
          ),
        );
      }
    };
    const req = client.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers,
        lookup: ((_host: any, _options: any, callback: any) =>
          _options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family)) as any,
      },
      (response) => {
        if (
          (response.statusCode || 0) >= 300 &&
          (response.statusCode || 0) < 400
        ) {
          response.destroy();
          fail();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > (options.maxBytes || 1_000_000)) {
            response.destroy();
            fail();
          } else chunks.push(Buffer.from(chunk));
        });
        response.on("error", fail);
        response.on("end", () => {
          if (!done) {
            done = true;
            const bytes = Buffer.concat(chunks);
            resolve({
              status: response.statusCode || 0,
              headers: response.headers,
              body: bytes.toString("utf8"),
              bytes,
            });
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      fail();
    }, 15000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", fail);
    if (options.body) req.write(options.body);
    req.end();
  });
}
export function redact(value: unknown, secrets: Obj): any {
  const values = Object.values(secrets).filter(
    (v) => typeof v === "string" && v.length > 0,
  ) as string[];
  const needles = values
    .flatMap((v) => [
      v,
      encodeURIComponent(v),
      Buffer.from(v).toString("base64"),
    ])
    .sort((a, b) => b.length - a.length);
  const clean = (v: any): any =>
    typeof v === "string"
      ? needles.reduce(
          (text, secret) => text.split(secret).join("[redacted]"),
          v,
        )
      : Array.isArray(v)
        ? v.map(clean)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, item]) => [clean(k), clean(item)]),
            )
          : v;
  return clean(value);
}
