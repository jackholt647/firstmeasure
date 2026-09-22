import { createHash, randomBytes } from "node:crypto";

import {
  listDocuments,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";

export const DOMAIN_QUOTE_COLLECTION = "domain_quotes";
export const DOMAIN_REGISTRATION_COLLECTION = "domain_registrations";
export const DOMAIN_EVENT_COLLECTION = "domain_events";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function view(document: JsonObject): JsonObject {
  const data = document.data && typeof document.data === "object" && !Array.isArray(document.data)
    ? document.data as JsonObject
    : {};
  return {
    ...data,
    id: cleanText(data.id || document.id),
    revision: Number(document.revision || 0),
    created_at: cleanText(document.created_at || data.created_at),
    updated_at: cleanText(document.updated_at || data.updated_at)
  };
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function newQuoteId() {
  return `domain_quote_${randomBytes(12).toString("hex")}`;
}

export function newVerificationToken() {
  return randomBytes(24).toString("base64url");
}

export function registrationId(domain: string) {
  return stableId("domain", domain.toLowerCase());
}

export async function saveQuote(orgId: string, quote: JsonObject) {
  const saved = await upsertDocument(orgId, DOMAIN_QUOTE_COLLECTION, {
    id: cleanText(quote.id),
    data: quote,
    metadata: { kind: "domain_quote", expires_at: quote.expires_at }
  }, { replace: true });
  return view(saved);
}

export async function readQuote(orgId: string, quoteId: string) {
  const document = await readDocument(orgId, DOMAIN_QUOTE_COLLECTION, quoteId).catch(() => null);
  return document ? view(document) : null;
}

export async function readRegistration(orgId: string, domain: string) {
  const document = await readDocument(orgId, DOMAIN_REGISTRATION_COLLECTION, registrationId(domain)).catch(() => null);
  return document ? view(document) : null;
}

export async function saveRegistration(orgId: string, domain: string, data: JsonObject) {
  const id = registrationId(domain);
  const saved = await upsertDocument(orgId, DOMAIN_REGISTRATION_COLLECTION, {
    id,
    data: { ...data, id, domain: domain.toLowerCase() },
    metadata: { kind: "domain_registration", domain: domain.toLowerCase(), status: data.status }
  }, { replace: true });
  return view(saved);
}

export async function listRegistrations(orgId: string) {
  const documents = await listDocuments(orgId, DOMAIN_REGISTRATION_COLLECTION);
  return documents.map(view).sort((a, b) => cleanText(a.domain).localeCompare(cleanText(b.domain)));
}

export async function recordDomainEvent(orgId: string, type: string, data: JsonObject) {
  const id = `domain_event_${randomBytes(12).toString("hex")}`;
  await upsertDocument(orgId, DOMAIN_EVENT_COLLECTION, {
    id,
    data: { id, type, ...data, created_at: new Date().toISOString() },
    metadata: { kind: "domain_event", type, domain: data.domain }
  }, { replace: true });
}
