// The DNS records a customer's own domain needs for FirstMate email (FM-516), and the check that finds them.
//
// Mail on a customer domain runs through Cloudflare: Email Routing receives it (root MX and SPF, catch-all to the
// shared Email Worker) and Email Sending sends it (MX, SPF and DKIM on the `cf-bounce` return-path subdomain). DMARC
// starts at p=none. Both services need the domain to be a Cloudflare zone, so a domain that stays at its registrar is
// pointed at the zone's nameservers there; Cloudflare then serves every record below.
//
// The check is a public DNS lookup. It never calls Cloudflare, so it runs the same in capture and live mode.

import { resolveMx, resolveNs, resolveTxt } from "node:dns/promises";

import type { JsonObject } from "../platform/storage.js";

export const CLOUDFLARE_MAIL_EXCHANGERS = ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"];
export const CLOUDFLARE_SPF_INCLUDE = "include:_spf.mx.cloudflare.net";

export type DomainEmailRecord = {
  key: string;
  purpose: "receive" | "send" | "policy";
  type: "MX" | "TXT";
  name: string;
  content: string;
  priority?: number;
  /** Who writes it: Cloudflare Email Routing or Sending, or FirstMate. */
  source: "email_routing" | "email_sending" | "firstmate";
  /** A value Cloudflare issues when the domain is onboarded (DKIM keys); unknown until then. */
  issued_by_provider?: boolean;
};

export type DomainEmailRecordCheck = DomainEmailRecord & {
  status: "found" | "missing" | "conflict";
  found: string[];
};

export type DnsResolver = {
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(name: string): Promise<string[][]>;
  resolveNs(name: string): Promise<string[]>;
};

export const systemResolver: DnsResolver = { resolveMx, resolveTxt, resolveNs };

function clean(value: unknown) { return String(value ?? "").trim(); }
function host(value: unknown) { return clean(value).toLowerCase().replace(/\.+$/, ""); }

/** The records FirstMate expects for email on `domain`, before Cloudflare has issued its DKIM keys. */
export function domainEmailRecords(domain: string): DomainEmailRecord[] {
  const name = host(domain);
  const bounce = `cf-bounce.${name}`;
  const exchangers = (key: string, at: string, purpose: DomainEmailRecord["purpose"], source: DomainEmailRecord["source"]) =>
    CLOUDFLARE_MAIL_EXCHANGERS.map((exchange, index) => ({ key: `${key}_${index + 1}`, purpose, type: "MX" as const, name: at, content: exchange, priority: (index + 1) * 10, source }));
  return [
    ...exchangers("mx", name, "receive", "email_routing"),
    { key: "spf", purpose: "receive", type: "TXT", name, content: `v=spf1 ${CLOUDFLARE_SPF_INCLUDE} ~all`, source: "email_routing" },
    ...exchangers("bounce_mx", bounce, "send", "email_sending"),
    { key: "bounce_spf", purpose: "send", type: "TXT", name: bounce, content: `v=spf1 ${CLOUDFLARE_SPF_INCLUDE} ~all`, source: "email_sending" },
    { key: "dkim", purpose: "send", type: "TXT", name: `cf-bounce._domainkey.${name}`, content: "", source: "email_sending", issued_by_provider: true },
    { key: "dmarc", purpose: "policy", type: "TXT", name: `_dmarc.${name}`, content: "v=DMARC1; p=none;", source: "firstmate" }
  ];
}

/**
 * Fold the records Cloudflare reports for the zone (Email Routing's and Email Sending's DNS lists) into the expected
 * list: a reported record replaces the expected one at the same name and type (MX by exchange), so issued DKIM keys and
 * assigned MX priorities are what the person sees and what is checked. Anything else Cloudflare reports is added.
 */
export function mergeProviderRecords(records: DomainEmailRecord[], reported: Array<Record<string, unknown>>, source: DomainEmailRecord["source"]) {
  const next = records.map((record) => ({ ...record }));
  for (const entry of reported) {
    const type = clean(entry.type).toUpperCase();
    if (type !== "MX" && type !== "TXT") continue;
    const name = host(entry.name);
    const content = type === "MX" ? host(entry.content) : clean(entry.content).replace(/^"|"$/g, "");
    if (!name || !content) continue;
    const priority = Number(entry.priority);
    const index = next.findIndex((record) => record.type === type && record.name === name && (type === "TXT"
      ? txtKind(record.content || (record.issued_by_provider ? "v=DKIM1" : "")) === txtKind(content)
      : record.content === content));
    if (index >= 0) {
      const { issued_by_provider: _issued, ...expected } = next[index]!;
      next[index] = { ...expected, content, ...(Number.isFinite(priority) && type === "MX" ? { priority } : {}) };
    } else {
      next.push({ key: `${source}_${type.toLowerCase()}_${next.length + 1}`, purpose: name.startsWith("cf-bounce") ? "send" : "receive", type, name, content, ...(Number.isFinite(priority) && type === "MX" ? { priority } : {}), source });
    }
  }
  // Email Sending issued its DKIM key under its own selector: the placeholder for it is no longer expected.
  const issuedDkim = source === "email_sending" && next.some((record) => record.source === "email_sending" && txtKind(record.content) === "dkim");
  return issuedDkim ? next.filter((record) => !(record.issued_by_provider && !record.content)) : next;
}

function txtKind(value: string) {
  const text = clean(value).toLowerCase();
  if (text.startsWith("v=spf1")) return "spf";
  if (text.startsWith("v=dkim1")) return "dkim";
  if (text.startsWith("v=dmarc1")) return "dmarc";
  return text;
}

/** Does a published TXT value satisfy the expected one? SPF needs Cloudflare's include, DKIM the issued key, DMARC any policy. */
function txtMatches(expected: DomainEmailRecord, value: string) {
  const kind = txtKind(expected.content || (expected.issued_by_provider ? "v=DKIM1" : ""));
  const actual = clean(value);
  if (kind !== txtKind(actual)) return false;
  if (kind === "spf") return actual.toLowerCase().split(/\s+/).includes(CLOUDFLARE_SPF_INCLUDE);
  if (kind === "dkim") {
    const key = /\bp=([^;\s]+)/i.exec(expected.content)?.[1];
    return key ? actual.replace(/\s+/g, "").includes(`p=${key}`) : /\bp=[^;\s]+/i.test(actual);
  }
  if (kind === "dmarc") return true;
  return actual === clean(expected.content);
}

async function lookup<T>(run: () => Promise<T>, empty: T) {
  try { return await run(); } catch { return empty; }
}

/**
 * Look every record up in public DNS. MX is found when the name's exchangers include the expected host, and a
 * conflict when the name also has exchangers that are not Cloudflare's (mail would be split between servers). A
 * second SPF record at a name is a conflict too (receivers reject both).
 */
export async function checkDomainEmailRecords(records: DomainEmailRecord[], resolver: DnsResolver = systemResolver): Promise<DomainEmailRecordCheck[]> {
  const mx = new Map<string, string[]>();
  const txt = new Map<string, string[]>();
  for (const record of records) {
    if (record.type === "MX" && !mx.has(record.name)) mx.set(record.name, (await lookup(() => resolver.resolveMx(record.name), [])).map((entry) => host(entry.exchange)));
    if (record.type === "TXT" && !txt.has(record.name)) txt.set(record.name, (await lookup(() => resolver.resolveTxt(record.name), [])).map((parts) => parts.join("")));
  }
  return records.map((record) => {
    if (record.type === "MX") {
      const found = mx.get(record.name) ?? [];
      const foreign = found.filter((exchange) => !CLOUDFLARE_MAIL_EXCHANGERS.includes(exchange));
      const status = !found.includes(host(record.content)) ? "missing" : foreign.length ? "conflict" : "found";
      return { ...record, status, found };
    }
    const values = txt.get(record.name) ?? [];
    const kind = txtKind(record.content || (record.issued_by_provider ? "v=DKIM1" : ""));
    const found = values.filter((value) => txtKind(value) === kind);
    const status = !found.some((value) => txtMatches(record, value)) ? "missing" : kind === "spf" && found.length > 1 ? "conflict" : "found";
    return { ...record, status, found };
  });
}

/** Whether the domain answers with the zone's nameservers (a domain that stays at its registrar has to be pointed there). */
export async function checkNameservers(domain: string, expected: string[], resolver: DnsResolver = systemResolver) {
  const assigned = expected.map(host).filter(Boolean);
  const found = (await lookup(() => resolver.resolveNs(host(domain)), [] as string[])).map(host);
  return { expected: assigned, found, status: assigned.length && assigned.every((name) => found.includes(name)) ? "found" as const : "missing" as const };
}

export function storedEmailRecords(registration: JsonObject, domain: string): DomainEmailRecord[] {
  const stored = Array.isArray(registration.email_records) ? registration.email_records as DomainEmailRecord[] : [];
  return stored.length ? stored.map((record) => ({ ...record })) : domainEmailRecords(domain);
}
