import { createHash, randomBytes } from "node:crypto";

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import "./instructions.js";
import { sendPlatformTransactionalEmail } from "./outbound.js";
import { ensureOrgEmailInbox } from "./engine.js";
import { inboundEmailSchema, processInboundEmail, type InboundEmailInput } from "./inbound.js";
import { importLead, leadDeliveries, leadStore, recordLeadRejection, reviewLeadDelivery } from "../leads/intake.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { badRequest, forbidden, notFound, PlatformError, unauthorized } from "../platform/errors.js";
import {
  listDocuments,
  listOrganizations,
  readBranchModule,
  saveBranchModule,
  type JsonObject
} from "../platform/storage.js";
import { env } from "../src/config/env.js";
import { parseOpenAIJsonOutput, requestOpenAIResponse } from "../src/openai/responses.js";

const objectBodySchema = z.object({}).passthrough();
const LEAD_IMPORT_MODULE_ID = "lead_import";
const SCHEDULING_MODULE_ID = "scheduling";
const VARIABLE_MAPPING_MODULE_ID = "variable_mappings";
const NEW_LEAD_STAGE_ID = "new_lead";
const DEFAULT_BRANCH_ID = "default";
const DEFAULT_NOTIFICATION_ROLES = ["inside_sales", "sales_appointments"];

type LeadImportAssignment = {
  orgId: string;
  branchId: string;
  module: JsonObject;
  data: JsonObject;
  email: string;
  localPart: string;
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function normalizeEmail(value: unknown) {
  const email = cleanText(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function sanitizeToken(value: unknown, fallback = "lead") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || fallback;
}

function sanitizeDomain(value: unknown, fallback = "1m8.ai") {
  const domain = cleanText(value)
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9.-]+/g, "")
    .replace(/\.+/g, ".")
    .replace(/^-+|-+$/g, "");
  return domain.includes(".") ? domain : fallback;
}

function assignedEmail(orgId: string, branchId: string) {
  const domain = sanitizeDomain(env.firstmateMailDomain, "firstmatemail.com");
  const orgToken = createHash("sha256").update(orgId).digest("hex").slice(0, 8);
  const branchToken = sanitizeToken(branchId || DEFAULT_BRANCH_ID, "default").slice(0, 18);
  const nonce = randomBytes(3).toString("hex");
  const localPart = `leads-${branchToken}-${orgToken}-${nonce}`.toLowerCase();
  return {
    domain,
    localPart,
    email: `${localPart}@${domain}`
  };
}

async function requireEmailLeadFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "email", "inbound_lead_import"))) {
    throw forbidden("app_flag_disabled", "Email lead import is not enabled for this organization.");
  }
}

async function requireWebsiteEmbedFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "website_embed_import"))) {
    throw forbidden("app_flag_disabled", "Website lead embeds are not enabled for this organization.");
  }
}

async function hasAnyLeadImportFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "lead_import"))) return false;
  return (await isAppFlagEnabled(orgId, "email", "inbound_lead_import"))
    || (await isAppFlagEnabled(orgId, "platform", "website_embed_import"));
}

async function readBranchModuleDataOrNull(orgId: string, branchId: string, moduleId: string) {
  try {
    const module = await readBranchModule(orgId, branchId, moduleId);
    return asObject(module.data);
  } catch {
    return null;
  }
}

export async function ensureLeadImportSettings(orgId: string, branchId = DEFAULT_BRANCH_ID) {
  return leadStore().transaction(()=>ensureLeadImportSettingsUnlocked(orgId,branchId),`lead-inbox:${orgId}:${branchId}`);
}
async function ensureLeadImportSettingsUnlocked(orgId:string,branchId:string){
  let existing: JsonObject | null = null;
  try {
    existing = await readBranchModule(orgId, branchId, LEAD_IMPORT_MODULE_ID);
  } catch {
    existing = null;
  }
  const currentData = asObject(existing?.data);
  const currentEmail = normalizeEmail(currentData.inbound_email);
  const targetDomain = sanitizeDomain(env.firstmateMailDomain, "firstmatemail.com");
  const currentUsesFirstMateMail = currentEmail.endsWith(`@${targetDomain}`);
  const generated = currentUsesFirstMateMail
    ? { email: currentEmail, localPart: currentEmail.split("@")[0], domain: currentEmail.split("@")[1] }
    : assignedEmail(orgId, branchId);
  const legacyInboundEmails = [...new Set([
    ...asArray(currentData.legacy_inbound_emails).map(normalizeEmail).filter(Boolean),
    ...(!currentUsesFirstMateMail && currentEmail ? [currentEmail] : [])
  ])];
  const now = nowIso();
  const data = {
    schema_version: 1,
    enabled: currentData.enabled !== false,
    inbound_email: generated.email,
    legacy_inbound_emails: legacyInboundEmails,
    local_part: generated.localPart,
    domain: generated.domain,
    project_stage_id: cleanText(currentData.project_stage_id) || NEW_LEAD_STAGE_ID,
    notification_target_role_ids: Array.isArray(currentData.notification_target_role_ids)
      ? currentData.notification_target_role_ids
      : DEFAULT_NOTIFICATION_ROLES,
    created_at: cleanText(currentData.created_at) || now,
    updated_at: now
  };
  const module = await saveBranchModule(orgId, branchId, LEAD_IMPORT_MODULE_ID, {
    data,
    metadata: { kind: "branch_lead_import", source: "email_api" }
  }, { replace: true });
  return { module, data };
}

export async function saveLeadImportSettings(orgId:string,branchId:string,raw:unknown){
  if(!await hasAnyLeadImportFlag(orgId))throw forbidden("app_flag_disabled","Lead import is disabled.");
  return leadStore().transaction(async()=>{
    const body = z.object({enabled:z.boolean().optional(),regenerate:z.boolean().optional(),notification_target_role_ids:z.array(z.string().max(120)).max(50).optional()}).strict().parse(raw);
    if ((body.regenerate === true || body.enabled !== undefined || body.notification_target_role_ids !== undefined) && !(await isAppFlagEnabled(orgId, "email", "inbound_lead_import"))) {
      throw forbidden("app_flag_disabled", "Email lead import is not enabled for this organization.");
    }
    const { data: current } = await ensureLeadImportSettingsUnlocked(orgId, branchId);
    const next = {
      ...current,
      enabled: body.enabled === undefined ? current.enabled : body.enabled !== false,
      notification_target_role_ids: Array.isArray(body.notification_target_role_ids) ? body.notification_target_role_ids : current.notification_target_role_ids,
      updated_at: nowIso()
    };
    if (body.regenerate === true) {
      const generated = assignedEmail(orgId, branchId);
      next.inbound_email = generated.email;
      next.local_part = generated.localPart;
      next.domain = generated.domain;
      next.legacy_inbound_emails = [];
    }
    const module = await saveBranchModule(orgId, branchId, LEAD_IMPORT_MODULE_ID, {
      data: next,
      metadata: { kind: "branch_lead_import", source: "email_api" }
    }, { replace: true });
    return { ok: true, settings: next, module };
  },`lead-inbox:${orgId}:${branchId}`);
}

function headersObject(headers: unknown) {
  const result: Record<string, string> = {};
  for (const item of asArray(headers)) {
    const obj = asObject(item);
    const name = cleanText(obj.Name || obj.name);
    if (!name) continue;
    result[name.toLowerCase()] = cleanText(obj.Value || obj.value);
  }
  return result;
}

function emailsFromAddressList(value: unknown) {
  const found = new Set<string>();
  const add = (email: unknown) => {
    const normalized = normalizeEmail(email);
    if (normalized) found.add(normalized);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      const obj = asObject(item);
      add(obj.Email || obj.email || item);
    }
  } else {
    const text = cleanText(value);
    for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) add(match[0]);
  }
  return [...found];
}

function postmarkRecipients(payload: JsonObject) {
  const headers = headersObject(payload.Headers);
  const recipients = new Set<string>();
  [
    payload.OriginalRecipient,
    payload.To,
    payload.Cc,
    payload.Bcc,
    headers["x-original-to"],
    headers["delivered-to"]
  ].forEach((value) => emailsFromAddressList(value).forEach((email) => recipients.add(email)));
  [payload.ToFull, payload.CcFull, payload.BccFull, payload.Recipients].forEach((value) => {
    emailsFromAddressList(value).forEach((email) => recipients.add(email));
  });
  return [...recipients];
}

function inboundEmailText(payload: JsonObject) {
  return [
    `Subject: ${cleanText(payload.Subject)}`,
    `From: ${cleanText(payload.FromName || asObject(payload.FromFull).Name)} <${cleanText(payload.From || asObject(payload.FromFull).Email)}>`,
    "",
    cleanText(payload.TextBody),
    "",
    cleanText(payload.StrippedTextReply),
    "",
    cleanText(payload.HtmlBody).replace(/<[^>]+>/g, " ")
  ].join("\n").replace(/[ \t]+/g, " ").slice(0, 20000);
}

function sourceProviderFromEmail(email: string) {
  const domain = email.split("@")[1] || "";
  return domain ? domain.replace(/^www\./, "") : "unknown";
}

function normalizeOrdinalSpacing(value: string) {
  return value.replace(/\b(\d+)\s+(st|nd|rd|th)\b/gi, (_match, number, suffix) => `${number}${String(suffix).toLowerCase()}`);
}

function cleanLeadAddress(value: unknown) {
  let address = cleanText(value)
    .replace(/<https?:\/\/[^>\s]+>/gi, "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  address = address.replace(/^(address|property address|job address|project address|address of site|site address|streetaddress|street address|property location)\s*[:=-]\s*/i, "");
  address = normalizeOrdinalSpacing(address);
  address = address.replace(/\s+,/g, ",").replace(/,\s*,+/g, ",").replace(/\s{2,}/g, " ").trim();
  address = address.replace(/^(.*?),\s*([A-Za-z .'-]+)\s+([A-Z]{2}),?\s+(\d{5}(?:-\d{4})?)(?:\s+.*)?$/i, (_match, street, city, state, zip) => {
    return `${String(street).trim()}, ${String(city).trim()}, ${String(state).toUpperCase()} ${String(zip).trim()}`;
  });
  return titleCaseAddress(address);
}

function titleCaseAddress(value: string) {
  return value.split(",").map((part) => part.trim().split(/\s+/).map((word) => {
    if (/^[A-Z]{2}$/.test(word)) return word;
    if (/^\d+(st|nd|rd|th)$/i.test(word)) return word.toLowerCase();
    if (/^\d+$/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(" ")).join(", ");
}

function usableStreet(value: string) {
  return /\d/.test(value) ? value : "";
}

function normalizeProviderName(value: unknown) {
  const provider = cleanText(value);
  const key = provider.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const known: Record<string, string> = {
    quinstreet: "QuinStreet",
    inquirly: "Inquirly",
    servicedirect: "Service Direct",
    fixr: "Fixr",
    networx: "Networx"
  };
  return known[key] || provider;
}

function normalizePhone(value: unknown) {
  const raw = cleanText(value);
  const phoneMatch = raw.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  const digits = (phoneMatch ? phoneMatch[0] : raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+1${digits.slice(1)}`;
  if (digits.length === 10) return `+1${digits}`;
  return "";
}

function uniqueStringList(values: unknown[]) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

const INLINE_FIELD_LABELS: Record<string, string> = {
  "additional information": "additional_information",
  "address of site": "address_of_site",
  "best time to call": "best_time_to_call",
  campaign: "campaign",
  city: "city",
  "client name": "client_name",
  clk: "clk",
  email: "email",
  firstname: "firstname",
  first_name: "firstname",
  homeowner: "homeowner",
  industry: "industry",
  lastname: "lastname",
  last_name: "lastname",
  leadkey: "leadkey",
  "lead id": "lead_id",
  "lead sale type": "lead_sale_type",
  phone: "phone",
  primarynumber: "primarynumber",
  product: "product",
  "requested by": "requested_by",
  service: "service",
  state: "state",
  streetaddress: "streetaddress",
  "street address": "streetaddress",
  workphone: "workphone",
  zip: "zip"
};

function keyValueFields(lines: string[]) {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 /_-]{1,44})\s*:\s*(.+)$/);
    if (!match) continue;
    const key = String(match[1] || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const value = String(match[2] || "").trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

function inlineKeyValueFields(text: string) {
  const fields: Record<string, string> = {};
  const normalized = text.replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ");
  const labels = Object.keys(INLINE_FIELD_LABELS)
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");
  const pattern = new RegExp(`(?:^|\\s)(${labels})\\s*:\\s*(.*?)(?=\\s+(?:${labels})\\s*:|$)`, "gi");
  for (const match of normalized.matchAll(pattern)) {
    const label = cleanText(match[1]).toLowerCase().replace(/\s+/g, " ");
    const key = INLINE_FIELD_LABELS[label] || label.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const value = cleanText(match[2]).replace(/\s+/g, " ");
    if (key && value) fields[key] = value;
  }
  return fields;
}

function cityStateZipLine(value: unknown) {
  const line = cleanText(value);
  return /^[A-Za-z .'-]+,\s*[A-Z]{2},?\s+\d{5}(?:-\d{4})?$/i.test(line) ? line.replace(/,\s*([A-Z]{2}),?\s+/i, ", $1 ") : "";
}

function fallbackAddress(lines: string[], fields: Record<string, string>) {
  const street = cleanLeadAddress(fields.streetaddress || fields.street_address || fields.address || fields.property_address || fields.job_address || fields.project_address || fields.address_of_site || fields.site_address);
  const city = cleanText(fields.city);
  const state = cleanText(fields.state).toUpperCase();
  const zip = cleanText(fields.zip || fields.zip_code || fields.postal_code);
  if (street) {
    const tail = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return tail ? `${street}, ${tail}` : street;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    if (!/\d{2,} .+ (st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|way|blvd|circle|cir|place|pl|nw|ne|sw|se)\b/i.test(line)) continue;
    const cleaned = cleanLeadAddress(line);
    const next = cityStateZipLine(lines[i + 1]);
    return next ? `${cleaned}, ${next}` : cleaned;
  }
  return "";
}

function normalizeLeadExtraction(raw: Record<string, unknown>, payload: JsonObject, fallback: Record<string, unknown>) {
  const modelContacts = asArray(raw.contacts).map((entry) => {
    const contact = asObject(entry);
    return {
      name: cleanText(contact.name).replace(/\s+/g, " "),
      email: normalizeEmail(contact.email),
      phones: uniqueStringList(asArray(contact.phones).map(normalizePhone)).sort()
    };
  }).filter((contact) => contact.name || contact.email || contact.phones.length)
    .sort((a, b) => `${a.name}|${a.email}`.localeCompare(`${b.name}|${b.email}`));
  const fallbackContacts = asArray(fallback.contacts).map((entry) => {
    const contact = asObject(entry);
    return {
      name: cleanText(contact.name).replace(/\s+/g, " "),
      email: normalizeEmail(contact.email),
      phones: uniqueStringList(asArray(contact.phones).map(normalizePhone)).sort()
    };
  }).filter((contact) => contact.name || contact.email || contact.phones.length)
    .sort((a, b) => `${a.name}|${a.email}`.localeCompare(`${b.name}|${b.email}`));
  const contacts = modelContacts.length ? modelContacts : fallbackContacts;
  const parts = asObject(raw.address_parts);
  const street = usableStreet(cleanLeadAddress(parts.street_line_1));
  const city = cleanText(parts.city).replace(/\s+/g, " ");
  const state = cleanText(parts.state).toUpperCase();
  const postalCode = cleanText(parts.postal_code);
  const addressFromParts = street
    ? [street, titleCaseAddress(city), [state, postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : "";
  const rawAddress = usableStreet(cleanLeadAddress(raw.address));
  const fallbackAddressValue = usableStreet(cleanLeadAddress(fallback.address));
  const tentativeAddress = fallbackAddressValue || addressFromParts || rawAddress;
  const contactSignal = contacts.some((contact) => contact.email || contact.phones.length);
  const emailText = inboundEmailText(payload);
  const leadWords = /\b(roof|roofing|service request|phone lead|webform lead|lead id|homeowner|property type|job type|project details|campaign name|quote|estimate|repair|replace|replacement|install|installation|renovat|remodel|service|request|inquiry|enquiry|interested|need|looking for)\b/i.test(emailText);
  const nonLead = /\b(invoice|newsletter|unsubscribe|payment receipt|meeting summary|account statement)\b/i.test(emailText);
  const isLead = Boolean((raw.extraction_method === "openai" ? raw.is_lead === true : leadWords && !nonLead) && (tentativeAddress || contactSignal));
  const address = isLead ? tentativeAddress : "";
  const provider = isLead ? normalizeProviderName(cleanText(raw.provider) || cleanText(fallback.provider)) : "";
  const summary = cleanText(payload.Subject) || cleanText(raw.summary);
  const deterministicFields = Object.keys(asObject(fallback.fields)).length ? asObject(fallback.fields) : asObject(raw.fields);
  const fields = Object.fromEntries(Object.entries(deterministicFields).sort(([a], [b]) => a.localeCompare(b)));
  return {
    is_lead: isLead,
    provider,
    confidence: isLead ? (address && contactSignal ? 0.95 : contactSignal ? 0.8 : 0.55) : 0.1,
    address,
    summary,
    contacts: isLead ? contacts : [],
    fields: isLead ? fields : {},
    rejection_reason: isLead ? "" : "Email does not contain a lead/service request with usable contact or job-site information.",
    extraction_method: cleanText(raw.extraction_method) || cleanText(fallback.extraction_method)
  };
}

function fallbackLeadExtraction(payload: JsonObject) {
  const text = inboundEmailText(payload);
  const from = normalizeEmail(payload.From || asObject(payload.FromFull).Email);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = { ...inlineKeyValueFields(text), ...keyValueFields(lines) };
  const labeledPhones = uniqueStringList([fields.primarynumber, fields.phone, fields.workphone].map(normalizePhone));
  const phones = labeledPhones.length
    ? labeledPhones
    : uniqueStringList([...text.matchAll(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g)].map((match) => normalizePhone(match[0])));
  const labeledEmail = normalizeEmail(fields.email);
  const scannedEmails = [...new Set([...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0].toLowerCase()).filter((email) => email !== from))];
  const emails = labeledEmail ? [labeledEmail] : scannedEmails;
  const addressLine = fallbackAddress(lines, fields);
  const nameLine = lines.find((line) => /^(name|customer|contact)\s*[:=-]/i.test(line));
  const firstName = cleanText(fields.first_name || fields.firstname);
  const lastName = cleanText(fields.last_name || fields.lastname);
  const requestedBy = cleanText(fields.requested_by).split(/\s+-\s+/)[0] || "";
  const name = nameLine ? nameLine.replace(/^[^:=-]+[:=-]\s*/, "").trim() : [firstName, lastName].filter(Boolean).join(" ") || requestedBy;
  return normalizeLeadExtraction({
    is_lead: true,
    provider: sourceProviderFromEmail(from),
    confidence: addressLine || phones.length ? 0.62 : 0.35,
    address: addressLine,
    summary: cleanText(payload.Subject) || "Inbound email lead",
    contacts: [{
      name,
      email: emails[0] || "",
      phones
    }].filter((contact) => contact.name || contact.email || contact.phones.length),
    fields,
    extraction_method: "fallback_regex"
  }, payload, {});
}

async function extractLead(payload: JsonObject) {
  if (process.env.EMAIL_LEAD_AI_DISABLED === "1" || !env.openaiApiKey) return fallbackLeadExtraction(payload);
  const text = inboundEmailText(payload);
  try {
    const result = await requestOpenAIResponse({
        model: env.openaiLeadModel,
        reasoning: { effort: "minimal" },
        max_output_tokens: 1200,
        text: {
          format: {
            type: "json_schema",
            name: "lead_email_extraction",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["is_lead", "provider", "confidence", "address", "address_parts", "summary", "contacts", "fields", "rejection_reason"],
              properties: {
                is_lead: { type: "boolean" },
                provider: { type: "string" },
                confidence: { type: "number" },
                address: { type: "string" },
                address_parts: {
                  type: "object",
                  additionalProperties: false,
                  required: ["street_line_1", "city", "state", "postal_code"],
                  properties: {
                    street_line_1: { type: "string" },
                    city: { type: "string" },
                    state: { type: "string" },
                    postal_code: { type: "string" }
                  }
                },
                summary: { type: "string" },
                rejection_reason: { type: "string" },
                contacts: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "email", "phones"],
                    properties: {
                      name: { type: "string" },
                      email: { type: "string" },
                      phones: { type: "array", items: { type: "string" } }
                    }
                  }
                },
                fields: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["key", "value"],
                    properties: {
                      key: { type: "string" },
                      value: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        },
        input: [
          {
            role: "system",
            content: [
              "You standardize inbound customer lead-provider emails for FirstMate across all industries and services.",
              "Return schema-valid JSON only.",
              "Set is_lead=false for invoices, newsletters, platform notifications, meeting summaries, generic marketing, or any email that is not a customer inquiry or service lead. When false, address must be '', contacts must be [], fields may preserve useful diagnostics, and rejection_reason must explain why.",
              "Set is_lead=true for webform leads, phone leads, service requests, quote requests, and marketplace roofing leads even if the address is missing.",
              "Address rules: address and address_parts are only the customer/job-site/property address. Strip labels like 'Address:', 'StreetAddress:', 'Address of site:', 'Property Location:', markdown asterisks, map URLs, and provider boilerplate. Fill address_parts.street_line_1, city, state, and postal_code separately when known. If street/city/state/zip are available, address should be 'Street, City, ST ZIP'. Fix ordinal spacing such as '3 rd' -> '3rd'. Do not include customer names, labels, phone numbers, or URLs in address. If no site address exists, use '' and empty address_parts strings.",
              "Contact rules: contacts are customer/homeowner/caller contacts only. Do not use provider support emails, account managers, dashboard links, billing contacts, or sender addresses unless the sender is clearly the customer. Normalize US phones as +1XXXXXXXXXX when possible. Avoid duplicate phones.",
              "Provider should be the lead source/provider name if clear, such as Inquirly, QuinStreet, Service Direct, Angi, HomeAdvisor, Thumbtack, or the sender domain.",
              "Preserve provider-specific keys like lead id, product, campaign, job type, material, homeowner, comments, and original city/state/zip in fields as an array of {key,value} pairs using snake_case keys."
            ].join(" ")
          },
          { role: "user", content: text }
        ]
      }, { timeoutMs: 45_000 });
    if (!result.ok) return fallbackLeadExtraction(payload);
    const fallback = fallbackLeadExtraction(payload);
    const parsed = parseOpenAIJsonOutput(result.json);
    return parsed ? normalizeLeadExtraction({ ...parsed, extraction_method: "openai" }, payload, fallback) : fallback;
  } catch {
    return fallbackLeadExtraction(payload);
  }
}

async function findLeadAssignment(recipients: string[]): Promise<LeadImportAssignment | null> {
  const recipientSet = new Set(recipients.map((email) => email.toLowerCase()));
  const orgs = await listOrganizations();
  for (const org of orgs) {
    const orgId = cleanText(asObject(org).id);
    if (!orgId) continue;
    let branches: JsonObject[] = [];
    try {
      branches = await listDocuments(orgId, "branch");
    } catch {
      branches = [];
    }
    for (const branchDoc of branches) {
      const branchId = cleanText(branchDoc.id) || DEFAULT_BRANCH_ID;
      try {
        const module = await readBranchModule(orgId, branchId, LEAD_IMPORT_MODULE_ID);
        const data = asObject(module.data);
        const email = normalizeEmail(data.inbound_email);
        const aliases = asArray(data.legacy_inbound_emails).map(normalizeEmail).filter(Boolean);
        if (data.enabled === false || !email || ![email, ...aliases].some((address) => recipientSet.has(address))) continue;
        if (!(await isAppFlagEnabled(orgId, "platform", "lead_import")) || !(await isAppFlagEnabled(orgId, "email", "inbound_lead_import"))) continue;
        return { orgId, branchId, module, data, email, localPart: email.split("@")[0] || "" };
      } catch {
        // Missing lead import module for this branch is normal.
      }
    }
  }
  return null;
}

function normalizedLeadPayload(input: InboundEmailInput): JsonObject {
  const from = normalizeEmail(input.from.address);
  return {
    From: from,
    FromFull: { Email: from, Name: cleanText(input.from.name) },
    To: input.to.map((recipient) => normalizeEmail(recipient.address)).filter(Boolean).join(", "),
    ToFull: input.to.map((recipient) => ({ Email: normalizeEmail(recipient.address), Name: cleanText(recipient.name) })).filter((recipient) => recipient.Email),
    Subject: cleanText(input.subject),
    TextBody: cleanText(input.text),
    HtmlBody: cleanText(input.html),
    Headers: Object.entries(asObject(input.headers)).map(([Name, Value]) => ({ Name, Value: cleanText(Value) })),
    MessageID: cleanText(asObject(input.headers).message_id) || cleanText(input.provider_event_id),
    Date: cleanText(input.occurred_at)
  };
}

async function processLeadPayload(payload: JsonObject) {
  const recipients = postmarkRecipients(payload);
  if (!recipients.length) return null;
  const assignment = await findLeadAssignment(recipients);
  if (!assignment) return null;
  const externalId = cleanText(payload.MessageID || payload.MessageId) || createHash("sha256").update(JSON.stringify([payload.From,payload.Subject,payload.TextBody,payload.HtmlBody])).digest("hex");
  const identity = {source_id:`email:${assignment.branchId}`,external_id:externalId,branch_id:assignment.branchId};
  const extracted = asObject(await extractLead(payload));
  if (extracted.is_lead === false) {
    return { ...await recordLeadRejection(assignment.orgId,identity,"not_a_lead"), assignment: { org_id: assignment.orgId, branch_id: assignment.branchId } };
  }
  if (!normalizeContacts(extracted, payload).length && !cleanText(extracted.address)) {
    throw badRequest("lead_missing_contact_data", "The email matched a lead address but did not contain contact or address data.");
  }
  const created = await createProjectFromLead(assignment, payload, extracted, externalId);
  return {
    accepted: created.accepted,
    duplicate: created.duplicate,
    delivery_id: created.delivery_id,
    state: created.state,
    assignment: { org_id: assignment.orgId, branch_id: assignment.branchId, inbound_email: assignment.email },
    extraction: extracted,
    project: created.project,
    contacts: created.contacts,
    notification: created.notification
  };
}

/** Route a normalized FirstMate Mail event to a dedicated lead inbox. */
export async function processInboundLeadEmail(input: InboundEmailInput) {
  return processLeadPayload(normalizedLeadPayload(input));
}

function normalizeContacts(extracted: JsonObject, payload: JsonObject) {
  const fromEmail = normalizeEmail(payload.From || asObject(payload.FromFull).Email);
  const contacts = asArray(extracted.contacts).map((entry) => {
    const contact = asObject(entry);
    return {
      name: cleanText(contact.name),
      email: normalizeEmail(contact.email),
      phones: asArray(contact.phones).map((phone) => cleanText(phone)).filter(Boolean)
    };
  }).filter((contact) => contact.name || contact.email || contact.phones.length);
  return contacts;
}

async function createProjectFromLead(assignment: LeadImportAssignment, payload: JsonObject, extracted: JsonObject, externalId:string) {
  const contacts = normalizeContacts(extracted, payload);
  const address = cleanText(extracted.address);
  const targetRoleIds = Array.isArray(assignment.data.notification_target_role_ids)
    ? assignment.data.notification_target_role_ids.map((role) => cleanText(role)).filter(Boolean)
    : DEFAULT_NOTIFICATION_ROLES;
  return await importLead(assignment.orgId, {
    source_id:`email:${assignment.branchId}`,
    external_id:externalId,
    branch_id: assignment.branchId,
    source_kind: "email_lead",
    address,
    title: address || cleanText(extracted.summary) || cleanText(payload.Subject) || "New email lead",
    summary: cleanText(extracted.summary),
    contacts,
    provider: cleanText(extracted.provider),
    provider_fields: asObject(extracted.fields),
    lead_source: {
      kind: "email",
      provider: cleanText(extracted.provider),
      confidence: Number(extracted.confidence || 0),
      inbound_email: assignment.email,
      postmark_message_id: cleanText(payload.MessageID || payload.MessageId),
      from: normalizeEmail(payload.From || asObject(payload.FromFull).Email),
      to: postmarkRecipients(payload),
      subject: cleanText(payload.Subject),
      received_at: cleanText(payload.Date) || nowIso(),
      extraction_method: cleanText(extracted.extraction_method),
      provider_fields: asObject(extracted.fields),
      raw_email: {
        from: payload.From || payload.FromFull || "",
        to: payload.To || payload.ToFull || "",
        subject: payload.Subject || "",
        text_body: payload.TextBody || "",
        html_body: payload.HtmlBody || "",
        headers: payload.Headers || []
      }
    },
    notification_target_role_ids:targetRoleIds
  });
}

function verifyInboundWebhook(request: { headers: Record<string, unknown>; query: unknown }) {
  const configured = cleanText(env.emailInboundWebhookToken);
  if (!configured) {
    if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") return;
    throw unauthorized("webhook_not_configured", "Inbound email authentication is not configured.");
  }
  const query = asObject(request.query);
  const bearer = cleanText(request.headers.authorization).match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = cleanText(request.headers["x-email-webhook-token"] || request.headers["x-postmark-token"] || bearer || query.token);
  if (provided !== configured) throw unauthorized("invalid_webhook_token", "Invalid inbound email webhook token.");
}

export const registerEmailApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "email",
    inbound: {
      postmark: "/v1/email/inbound/postmark",
      leadImportSettings: "/v1/email/organizations/:orgId/branch/:branchId/lead-import"
    },
    outbound: {
      platformTransactional: "/v1/email/outbound/platform-transactional",
      legacyAlias: "/v1/email/outbound/transactional"
    }
  }));

  const sendPlatformTransactional = async (request: FastifyRequest) => {
    await requirePlatformAuth(request, { csrf: true, permission: "manage_company_settings|manage_organization|admin" });
    const body = objectBodySchema.parse(request.body ?? {});
    return await sendPlatformTransactionalEmail({
      to: cleanText(body.to),
      subject: cleanText(body.subject),
      textBody: cleanText(body.text_body || body.textBody),
      htmlBody: cleanText(body.html_body || body.htmlBody),
      from: cleanText(body.from),
      replyTo: cleanText(body.reply_to || body.replyTo),
      tag: cleanText(body.tag),
      metadata: asObject(body.metadata) as Record<string, string>
    });
  };
  app.post("/outbound/platform-transactional", sendPlatformTransactional);
  app.post("/outbound/transactional", sendPlatformTransactional);

  app.get("/organizations/:orgId/branch/:branchId/lead-import", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    if (!(await hasAnyLeadImportFlag(orgId))) throw forbidden("app_flag_disabled", "Lead import is not enabled for this organization.");
    const { module, data } = await ensureLeadImportSettings(orgId, branchId);
    return { ok: true, settings: data, module };
  });

  app.get("/organizations/:orgId/branch/:branchId/lead-import/deliveries", async request=>{
    const orgId=getParam(request.params,"orgId"),branchId=getParam(request.params,"branchId");
    await requirePlatformAuth(request,{orgId,permission:"manage_company_settings|manage_projects"});
    if(!await isAppFlagEnabled(orgId,"platform","lead_import"))throw forbidden("app_flag_disabled","Lead import is disabled.");
    const page=z.object({after:z.string().max(150).optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).parse(request.query);
    return {ok:true,...await leadDeliveries(orgId,{branchId,...page})};
  });
  app.post("/organizations/:orgId/lead-deliveries/:id/review",async request=>{
    const orgId=getParam(request.params,"orgId");
    const auth=await requirePlatformAuth(request,{orgId,csrf:true,permission:"manage_projects"});
    if(!await isAppFlagEnabled(orgId,"platform","lead_import"))throw forbidden("app_flag_disabled","Lead import is disabled.");
    return {ok:true,...await reviewLeadDelivery(orgId,getParam(request.params,"id"),auth.userId,request.body)};
  });

  app.patch("/organizations/:orgId/branch/:branchId/lead-import", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    if (!(await hasAnyLeadImportFlag(orgId))) throw forbidden("app_flag_disabled", "Lead import is not enabled for this organization.");
    return saveLeadImportSettings(orgId,branchId,request.body);
  });

  // The organization's FirstMate Mail inbox (provisions on first read).
  app.get("/organizations/:orgId/inbox", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_comms|view_projects|manage_projects|manage_company_settings" });
    const inbox = await ensureOrgEmailInbox(orgId, ctx.branchId || DEFAULT_BRANCH_ID);
    return {
      ok: true,
      inbox: {
        address: inbox.address,
        display_name: inbox.display_name,
        provider: inbox.provider,
        delivery_mode: env.emailDeliveryMode
      }
    };
  });

  // Normalized inbound email events for the FirstMate Mail engine. The
  // Cloudflare Email Worker (and the dev spool replayer) converts provider payloads into this
  // shape; simulation posts here too. 202 (not 4xx) for unroutable mail so
  // providers do not retry forever.
  app.post("/inbound/events", async (request, reply) => {
    verifyInboundWebhook({ headers: request.headers, query: request.query });
    const payload = inboundEmailSchema.parse(request.body ?? {});
    const lead = await processInboundLeadEmail(payload);
    if (lead) {
      if (!lead.accepted) reply.code(202);
      return { ok: true, ...lead };
    }
    try {
      const result = await processInboundEmail(payload);
      return { ok: true, accepted: true, created: result.created, message_id: asObject(result.message).id };
    } catch (error) {
      if (error instanceof PlatformError && error.code === "inbox_not_found") {
        reply.code(202);
        return { ok: true, accepted: false, reason: "no_matching_inbox" };
      }
      throw error;
    }
  });

  app.post("/inbound/postmark", async (request, reply) => {
    verifyInboundWebhook({ headers: request.headers, query: request.query });
    const payload = objectBodySchema.parse(request.body ?? {});
    const recipients = postmarkRecipients(payload);
    if (!recipients.length) {
      reply.code(202);
      return { ok: true, accepted: false, reason: "no_recipients" };
    }
    const result = await processLeadPayload(payload);
    if (!result) {
      reply.code(202);
      return { ok: true, accepted: false, reason: "no_matching_lead_import_address", recipients };
    }
    if (!result.accepted) reply.code(202);
    return { ok: true, ...result };
  });
};
