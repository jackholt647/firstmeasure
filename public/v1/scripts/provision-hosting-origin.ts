import { isIP } from "node:net";

import { createCloudflareClient, type CloudflareDnsRecord } from "../domains/cloudflare.js";
import { env } from "../src/config/env.js";

function clean(value: unknown) { return String(value ?? "").trim().toLowerCase().replace(/\.+$/, ""); }

const zoneName = clean(process.env.HOSTING_ORIGIN_ZONE || "firstmatehosting.com");
const hostname = clean(process.env.HOSTING_ORIGIN_HOST || env.cloudflareWebsiteTarget || "sites.firstmatehosting.com");
const type = clean(process.env.HOSTING_ORIGIN_TYPE || "A").toUpperCase() as "A" | "AAAA" | "CNAME";
const content = clean(process.env.HOSTING_ORIGIN_VALUE);

if (!zoneName || !hostname.endsWith(`.${zoneName}`)) throw new Error("HOSTING_ORIGIN_HOST must be inside HOSTING_ORIGIN_ZONE.");
if (!(["A", "AAAA", "CNAME"] as string[]).includes(type)) throw new Error("HOSTING_ORIGIN_TYPE must be A, AAAA, or CNAME.");
if (!content) throw new Error("HOSTING_ORIGIN_VALUE is required.");
if (type === "A" && isIP(content) !== 4) throw new Error("HOSTING_ORIGIN_VALUE must be an IPv4 address when HOSTING_ORIGIN_TYPE=A.");
if (type === "AAAA" && isIP(content) !== 6) throw new Error("HOSTING_ORIGIN_VALUE must be an IPv6 address when HOSTING_ORIGIN_TYPE=AAAA.");

const cloudflare = createCloudflareClient();
const { zone } = await cloudflare.ensureZone(zoneName);
const record: CloudflareDnsRecord = { type, name: hostname, content, proxied: true };
await cloudflare.replaceProxyRecord(zone.id, record);
console.log(JSON.stringify({ ok: true, zone: zoneName, hostname, type, proxied: true }, null, 2));
