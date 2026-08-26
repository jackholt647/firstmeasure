import { createHash, randomBytes } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import {
  ensureLeadIntakeSettings,
  patchLeadIntakeSettings,
  publicFormAvailabilityById,
  publicFormConfigById,
  submitPublicFormById
} from "../lead-intake/api.js";
import { sendTransactionalEmail } from "./outbound.js";
import { createPlatformLead } from "../platform/api.js";
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

const objectBodySchema = z.object({}).passthrough();
const LEAD_IMPORT_MODULE_ID = "lead_import";
const SCHEDULING_MODULE_ID = "scheduling";
const STAGES_MODULE_ID = "stages";
const VARIABLE_MAPPING_MODULE_ID = "variable_mappings";
const NEW_LEAD_STAGE_ID = "new_lead";
const DEFAULT_BRANCH_ID = "default";
const DEFAULT_NOTIFICATION_ROLES = ["inside_sales", "sales_appointments"];
const DEFAULT_WEBSITE_FORM_FONT = "Montserrat";
const WEBSITE_FORM_FONTS = ["Montserrat", "Inter", "Roboto", "Open Sans", "Lato", "Poppins", "Source Sans 3"];

type LeadImportAssignment = {
  orgId: string;
  branchId: string;
  module: JsonObject;
  data: JsonObject;
  email: string;
  localPart: string;
};

type WebsiteFormAssignment = {
  orgId: string;
  branchId: string;
  data: JsonObject;
  form: JsonObject;
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
  const domain = sanitizeDomain(env.emailInboundDomain);
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

function generatedFormId(orgId: string, branchId: string) {
  const orgToken = createHash("sha256").update(`${orgId}:${branchId}:${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 18);
  return `form_${orgToken}`;
}

function normalizeHexColor(value: unknown, fallback: string) {
  const raw = cleanText(value);
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
}

function defaultWebsiteForm(orgId: string, branchId: string, input: JsonObject = {}) {
  const id = cleanText(input.id) || generatedFormId(orgId, branchId);
  const mode = ["appointment", "call"].includes(cleanText(input.mode)) ? cleanText(input.mode) : "appointment";
  const copy = asObject(input.copy);
  const style = asObject(input.style);
  const scheduling = asObject(input.scheduling);
  const now = nowIso();
  return {
    schema_version: 1,
    id,
    enabled: input.enabled !== false,
    name: cleanText(input.name) || (mode === "call" ? "Website Call Request" : "Website Appointment Form"),
    tracking_key: sanitizeToken(input.tracking_key || input.name || id, "website-lead"),
    mode,
    copy: {
      headline: cleanText(copy.headline) || (mode === "call" ? "Schedule a quick call" : "Schedule an appointment"),
      subheadline: cleanText(copy.subheadline) || "Tell us where to reach you and we will confirm the next step.",
      submit_label: cleanText(copy.submit_label) || (mode === "call" ? "Request Call" : "Request Appointment"),
      fine_print: cleanText(copy.fine_print) || "By submitting, you agree to be contacted about your request.",
      success_title: cleanText(copy.success_title) || "Request received",
      success_body: cleanText(copy.success_body) || "We have your information and will follow up shortly."
    },
    style: {
      primary_color: normalizeHexColor(style.primary_color, "#d93025"),
      secondary_color: normalizeHexColor(style.secondary_color, "#111827"),
      background_color: normalizeHexColor(style.background_color, "#ffffff"),
      text_color: normalizeHexColor(style.text_color, "#111827"),
      font_family: WEBSITE_FORM_FONTS.includes(cleanText(style.font_family)) ? cleanText(style.font_family) : DEFAULT_WEBSITE_FORM_FONT,
      use_company_colors: style.use_company_colors !== false,
      logo_enabled: style.logo_enabled === true,
      logo_url: cleanText(style.logo_url)
    },
    scheduling: {
      event_type_default_id: cleanText(scheduling.event_type_default_id) || (mode === "call" ? "contact_call" : "sales_appointment"),
      duration_minutes: Math.max(15, Math.min(240, Number(scheduling.duration_minutes || (mode === "call" ? 30 : 60)) || 60)),
      slot_minutes: Math.max(15, Math.min(120, Number(scheduling.slot_minutes || 30) || 30)),
      buffer_minutes: Math.max(0, Math.min(240, Number(scheduling.buffer_minutes || scheduling.travel_buffer_minutes || 30) || 0)),
      min_notice_minutes: Math.max(0, Math.min(10080, Number(scheduling.min_notice_minutes || 120) || 0)),
      available_days: Array.isArray(scheduling.available_days) && scheduling.available_days.length
        ? scheduling.available_days.map((day) => Number(day)).filter((day) => day >= 0 && day <= 6)
        : [1, 2, 3, 4, 5],
      start_time: /^\d{2}:\d{2}$/.test(cleanText(scheduling.start_time)) ? cleanText(scheduling.start_time) : "09:00",
      end_time: /^\d{2}:\d{2}$/.test(cleanText(scheduling.end_time)) ? cleanText(scheduling.end_time) : "17:00",
      required_role_ids: Array.isArray(scheduling.required_role_ids) ? scheduling.required_role_ids.map(cleanText).filter(Boolean) : [],
      allowed_role_ids: Array.isArray(scheduling.allowed_role_ids) && scheduling.allowed_role_ids.length
        ? scheduling.allowed_role_ids.map(cleanText).filter(Boolean)
        : [mode === "call" ? "inside_sales" : "sales_appointments"]
    },
    created_at: cleanText(input.created_at) || now,
    updated_at: now
  };
}

function normalizeWebsiteForms(orgId: string, branchId: string, value: unknown) {
  return asArray(value).map((entry) => defaultWebsiteForm(orgId, branchId, asObject(entry)));
}

async function readBranchModuleDataOrNull(orgId: string, branchId: string, moduleId: string) {
  try {
    const module = await readBranchModule(orgId, branchId, moduleId);
    return asObject(module.data);
  } catch {
    return null;
  }
}

async function ensureNewLeadStage(orgId: string, branchId: string) {
  const stagesRaw = asObject(await readBranchModuleDataOrNull(orgId, branchId, STAGES_MODULE_ID));
  const stages = asObject(stagesRaw.stages);
  const order = Array.isArray(stagesRaw.order) ? stagesRaw.order.map((item) => cleanText(item)).filter(Boolean) : [];
  if (!stages[NEW_LEAD_STAGE_ID]) {
    stages[NEW_LEAD_STAGE_ID] = { id: NEW_LEAD_STAGE_ID, status: "active", color: "#0f766e" };
  }
  const nextOrder = order.includes(NEW_LEAD_STAGE_ID) ? order : [NEW_LEAD_STAGE_ID, ...order];
  await saveBranchModule(orgId, branchId, STAGES_MODULE_ID, {
    data: { schema_version: 1, ...stagesRaw, order: nextOrder, stages },
    metadata: { kind: "branch_stages", source: "email_lead_import" }
  }, { replace: true });

  const mappingsRaw = asObject(await readBranchModuleDataOrNull(orgId, branchId, VARIABLE_MAPPING_MODULE_ID));
  const labels = asObject(mappingsRaw.labels);
  const stageLabels = asObject(labels.stages);
  if (!stageLabels[NEW_LEAD_STAGE_ID]) stageLabels[NEW_LEAD_STAGE_ID] = "New Lead";
  await saveBranchModule(orgId, branchId, VARIABLE_MAPPING_MODULE_ID, {
    data: {
      schema_version: 1,
      ...mappingsRaw,
      labels: {
        ...labels,
        stages: stageLabels
      }
    },
    metadata: { kind: "branch_variable_mappings", source: "email_lead_import" }
  }, { replace: true });
}

async function ensureLeadImportSettings(orgId: string, branchId = DEFAULT_BRANCH_ID) {
  let existing: JsonObject | null = null;
  try {
    existing = await readBranchModule(orgId, branchId, LEAD_IMPORT_MODULE_ID);
  } catch {
    existing = null;
  }
  const currentData = asObject(existing?.data);
  const currentEmail = normalizeEmail(currentData.inbound_email);
  const generated = currentEmail
    ? { email: currentEmail, localPart: currentEmail.split("@")[0], domain: currentEmail.split("@")[1] }
    : assignedEmail(orgId, branchId);
  const now = nowIso();
  const data = {
    schema_version: 1,
    enabled: currentData.enabled !== false,
    inbound_email: generated.email,
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
  await ensureNewLeadStage(orgId, branchId);
  return { module, data };
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
  const contacts = fallbackContacts.length ? fallbackContacts : modelContacts;
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
  const leadWords = /\b(roof|roofing|service request|phone lead|webform lead|lead id|homeowner|property type|job type|project details|campaign name)\b/i.test(inboundEmailText(payload));
  const isLead = Boolean(leadWords && (tentativeAddress || contactSignal));
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
  const fields = { ...keyValueFields(lines), ...inlineKeyValueFields(text) };
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

function parseOpenAIResponse(data: JsonObject) {
  const outputText = cleanText(data.output_text)
    || asArray(data.output).map((item) => asArray(asObject(item).content).map((content) => cleanText(asObject(content).text)).join("\n")).join("\n");
  if (!outputText) return null;
  try {
    return asObject(JSON.parse(outputText));
  } catch {
    return null;
  }
}

async function extractLead(payload: JsonObject) {
  if (process.env.EMAIL_LEAD_AI_DISABLED === "1" || !env.openaiApiKey) return fallbackLeadExtraction(payload);
  const text = inboundEmailText(payload);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
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
              "You standardize inbound roofing lead-provider emails for FirstMate.",
              "Return schema-valid JSON only.",
              "Set is_lead=false for invoices, newsletters, platform notifications, meeting summaries, generic marketing, or any email that is not a customer service/roofing lead. When false, address must be '', contacts must be [], fields may preserve useful diagnostics, and rejection_reason must explain why.",
              "Set is_lead=true for webform leads, phone leads, service requests, quote requests, and marketplace roofing leads even if the address is missing.",
              "Address rules: address and address_parts are only the customer/job-site/property address. Strip labels like 'Address:', 'StreetAddress:', 'Address of site:', 'Property Location:', markdown asterisks, map URLs, and provider boilerplate. Fill address_parts.street_line_1, city, state, and postal_code separately when known. If street/city/state/zip are available, address should be 'Street, City, ST ZIP'. Fix ordinal spacing such as '3 rd' -> '3rd'. Do not include customer names, labels, phone numbers, or URLs in address. If no site address exists, use '' and empty address_parts strings.",
              "Contact rules: contacts are customer/homeowner/caller contacts only. Do not use provider support emails, account managers, dashboard links, billing contacts, or sender addresses unless the sender is clearly the customer. Normalize US phones as +1XXXXXXXXXX when possible. Avoid duplicate phones.",
              "Provider should be the lead source/provider name if clear, such as Inquirly, QuinStreet, Service Direct, Angi, HomeAdvisor, Thumbtack, or the sender domain.",
              "Preserve provider-specific keys like lead id, product, campaign, job type, material, homeowner, comments, and original city/state/zip in fields as an array of {key,value} pairs using snake_case keys."
            ].join(" ")
          },
          { role: "user", content: text }
        ]
      })
    });
    if (!response.ok) return fallbackLeadExtraction(payload);
    const fallback = fallbackLeadExtraction(payload);
    const parsed = parseOpenAIResponse(asObject(await response.json()));
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
        if (data.enabled === false || !email || !recipientSet.has(email)) continue;
        if (!(await isAppFlagEnabled(orgId, "email", "inbound_lead_import"))) continue;
        return { orgId, branchId, module, data, email, localPart: email.split("@")[0] || "" };
      } catch {
        // Missing lead import module for this branch is normal.
      }
    }
  }
  return null;
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
  if (!contacts.length && fromEmail) contacts.push({ name: cleanText(asObject(payload.FromFull).Name || payload.FromName), email: fromEmail, phones: [] });
  return contacts;
}

async function createProjectFromLead(assignment: LeadImportAssignment, payload: JsonObject, extracted: JsonObject) {
  const contacts = normalizeContacts(extracted, payload);
  const stageId = cleanText(assignment.data.project_stage_id) || NEW_LEAD_STAGE_ID;
  const address = cleanText(extracted.address);
  const targetRoleIds = Array.isArray(assignment.data.notification_target_role_ids)
    ? assignment.data.notification_target_role_ids.map((role) => cleanText(role)).filter(Boolean)
    : DEFAULT_NOTIFICATION_ROLES;
  return await createPlatformLead(assignment.orgId, {
    branch_id: assignment.branchId,
    stage_id: stageId,
    source_kind: "email_lead",
    address,
    title: address || cleanText(extracted.summary) || cleanText(payload.Subject) || "New email lead",
    summary: cleanText(extracted.summary),
    contacts,
    provider: cleanText(extracted.provider),
    confidence: Number(extracted.confidence || 0),
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
    metadata: {
      postmark_message_id: cleanText(payload.MessageID || payload.MessageId)
    },
    notification: {
      source: "email_lead_import",
      target_role_ids: targetRoleIds,
      context: {
        inbound_email: assignment.email
      }
    }
  });
}

async function findWebsiteFormAssignment(formId: string): Promise<WebsiteFormAssignment | null> {
  const targetId = cleanText(formId);
  if (!targetId) return null;
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
        const form = asArray(data.website_forms).map(asObject).find((entry) => cleanText(entry.id) === targetId);
        if (!form) continue;
        return { orgId, branchId, data, form };
      } catch {
        // Missing lead import module for this branch is normal.
      }
    }
  }
  return null;
}

function publicWebsiteForm(form: JsonObject) {
  const normalized = defaultWebsiteForm("", DEFAULT_BRANCH_ID, form);
  return {
    id: normalized.id,
    enabled: normalized.enabled,
    name: normalized.name,
    tracking_key: normalized.tracking_key,
    mode: normalized.mode,
    copy: normalized.copy,
    style: normalized.style,
    scheduling: normalized.scheduling,
    fields: {
      name: { required: true },
      email: { required: false },
      phone: { required: true },
      address: { required: false },
      message: { required: false },
      preferred_start_at: { required: false }
    }
  };
}

function normalizeStringArray(value: unknown) {
  return [...new Set(asArray(value).map(cleanText).filter(Boolean))];
}

function minutesFromTime(value: unknown) {
  const match = cleanText(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  return Math.max(0, Math.min(24 * 60, Number(match[1]) * 60 + Number(match[2])));
}

function timeFromMinutes(value: number) {
  const mins = Math.max(0, Math.min(24 * 60 - 1, Number(value) || 0));
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function dateInput(value: unknown) {
  const date = new Date(cleanText(value) || Date.now());
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateAtTime(date: string, time: string) {
  return new Date(`${date}T${time}:00`);
}

function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date) {
  return startA < endB && startB < endA;
}

async function readSchedulingData(orgId: string, branchId: string) {
  try {
    const module = await readBranchModule(orgId, branchId, SCHEDULING_MODULE_ID);
    return asObject(module.data);
  } catch {
    return {};
  }
}

function eventTypeFromScheduling(schedulingData: JsonObject, form: JsonObject) {
  const formScheduling = asObject(form.scheduling);
  const formMode = cleanText(form.mode) || "appointment";
  const eventTypeId = cleanText(formScheduling.event_type_default_id) || (formMode === "call" ? "contact_call" : "sales_appointment");
  const eventTypes = asObject(schedulingData.event_types);
  const eventType = asObject(eventTypes[eventTypeId]);
  const requiredRoleIds = normalizeStringArray(eventType.required_role_ids || formScheduling.required_role_ids || eventType.role_ids || formScheduling.role_ids || (eventTypeId === "sales_appointment" ? ["sales_appointments"] : []));
  const allowedRoleIds = normalizeStringArray(eventType.allowed_role_ids || formScheduling.allowed_role_ids || eventType.role_ids || formScheduling.role_ids || requiredRoleIds);
  const duration = Math.max(15, Math.min(240, Number(eventType.duration_minutes || asObject(schedulingData.availability).sales_appointment_duration_minutes || formScheduling.duration_minutes || (formMode === "call" ? 30 : 60)) || 60));
  const slotMinutes = Math.max(15, Math.min(120, Number(eventType.slot_minutes || asObject(schedulingData.availability).sales_appointment_slot_minutes || formScheduling.slot_minutes || 30) || 30));
  const bufferMinutes = Math.max(0, Math.min(240, Number(eventType.buffer_minutes || asObject(schedulingData.availability).sales_appointment_buffer_minutes || formScheduling.buffer_minutes || 30) || 0));
  return { id: eventTypeId, requiredRoleIds, allowedRoleIds, duration, slotMinutes, bufferMinutes };
}

function branchAvailabilityWindow(schedulingData: JsonObject, form: JsonObject, date: string, eventTypeId: string) {
  const availability = asObject(schedulingData.availability);
  const formScheduling = asObject(form.scheduling);
  const targetDay = dateAtTime(date, "12:00").getDay();
  const workingHours = asArray(availability.working_hours).map(asObject);
  const matching = workingHours.find((entry) => asArray(entry.days).map(Number).includes(targetDay)) || workingHours[0] || {};
  const eventWindows = asObject(availability.event_type_windows);
  const eventWindow = asObject(eventWindows[eventTypeId]);
  const startRaw = cleanText(eventWindow.start || eventWindow.start_time || matching.start || matching.start_time || availability[`${eventTypeId}_start_time`] || availability.sales_appointment_start_time || formScheduling.start_time || "09:00");
  const endRaw = cleanText(eventWindow.end || eventWindow.end_time || matching.end || matching.end_time || availability[`${eventTypeId}_end_time`] || availability.sales_appointment_end_time || formScheduling.end_time || "17:00");
  const days = asArray(matching.days).length ? asArray(matching.days).map(Number) : (Array.isArray(formScheduling.available_days) ? formScheduling.available_days.map(Number) : [1, 2, 3, 4, 5]);
  return {
    start: timeFromMinutes(minutesFromTime(startRaw || "09:00")),
    end: timeFromMinutes(minutesFromTime(endRaw || "17:00")),
    days
  };
}

function normalizeUserForAvailability(document: JsonObject) {
  const data = asObject(document.data || document);
  const roles = normalizeStringArray(data.roles);
  const role = cleanText(data.role || data.permission_level).toLowerCase();
  const adminRoles = ["owner", "admin", "super_admin"].includes(role) ? ["sales_appointments", "inside_sales"] : [];
  return {
    id: cleanText(document.id || data.id),
    name: cleanText(data.name || data.full_name || data.email),
    email: cleanText(data.email),
    status: cleanText(data.status),
    roles: roles.length ? roles : adminRoles
  };
}

function normalizeEventForAvailability(event: JsonObject, project: JsonObject) {
  const start = new Date(cleanText(event.start_at || event.start || event.starts_at));
  const duration = Math.max(1, Number(event.duration_minutes || event.duration || 60));
  const assignedUserIds = normalizeStringArray([event.assigned_user_id, event.user_id, ...asArray(event.assigned_user_ids), ...asArray(event.user_ids)]);
  const requiredRoleIds = normalizeStringArray(event.required_role_ids || event.role_ids || event.roles);
  const allowedRoleIds = normalizeStringArray(event.allowed_role_ids || event.role_ids || event.roles || requiredRoleIds);
  return {
    id: cleanText(event.id),
    start,
    end: new Date(start.getTime() + duration * 60000),
    assignedUserIds,
    requiredRoleIds,
    allowedRoleIds,
    projectId: cleanText(project.id)
  };
}

function roleAvailability(users: ReturnType<typeof normalizeUserForAvailability>[], events: ReturnType<typeof normalizeEventForAvailability>[], roleId: string, start: Date, duration: number, bufferMinutes = 0) {
  const end = new Date(start.getTime() + duration * 60000);
  const conflictStart = new Date(start.getTime() - Math.max(0, bufferMinutes) * 60000);
  const conflictEnd = new Date(end.getTime() + Math.max(0, bufferMinutes) * 60000);
  const roleUsers = users.filter((user) => user.status !== "disabled" && user.roles.includes(roleId));
  const overlapping = events.filter((event) => Number.isFinite(event.start.getTime()) && intervalsOverlap(conflictStart, conflictEnd, event.start, event.end));
  const busyAssigned = new Set(overlapping.flatMap((event) => event.assignedUserIds));
  const unassignedRoleConflicts = overlapping.filter((event) => !event.assignedUserIds.length && [...event.requiredRoleIds, ...event.allowedRoleIds].includes(roleId)).length;
  const availableUsers = roleUsers.filter((user) => !busyAssigned.has(user.id));
  return {
    role_id: roleId,
    available_count: Math.max(0, availableUsers.length - unassignedRoleConflicts),
    eligible_count: roleUsers.length,
    available_user_ids: availableUsers.map((user) => user.id)
  };
}

async function websiteFormAvailability(assignment: WebsiteFormAssignment, query: JsonObject) {
  const form = defaultWebsiteForm(assignment.orgId, assignment.branchId, assignment.form);
  const schedulingData = await readSchedulingData(assignment.orgId, assignment.branchId);
  const eventType = eventTypeFromScheduling(schedulingData, form);
  const date = dateInput(query.date);
  const window = branchAvailabilityWindow(schedulingData, form, date, eventType.id);
  const stepMinutes = eventType.slotMinutes;
  const minNoticeMinutes = Math.max(0, Math.min(10080, Number(asObject(form.scheduling).min_notice_minutes || 120) || 0));
  const minTime = Date.now() + minNoticeMinutes * 60000;
  const users = (await listDocuments(assignment.orgId, "users")).map(normalizeUserForAvailability);
  const projects = await listDocuments(assignment.orgId, "projects");
  const events = projects.flatMap((document) => {
    const project = asObject({ ...asObject(document.data), id: cleanText(document.id) });
    return asArray(project.events).map(asObject).map((event) => normalizeEventForAvailability(event, project));
  });
  const slots = [];
  if (window.days.includes(dateAtTime(date, "12:00").getDay())) {
    for (let minute = minutesFromTime(window.start); minute + eventType.duration <= minutesFromTime(window.end); minute += stepMinutes) {
      const time = timeFromMinutes(minute);
      const start = dateAtTime(date, time);
      if (start.getTime() <= minTime) continue;
      const required = eventType.requiredRoleIds.map((roleId) => roleAvailability(users, events, roleId, start, eventType.duration, eventType.bufferMinutes));
      const allowed = eventType.allowedRoleIds.map((roleId) => roleAvailability(users, events, roleId, start, eventType.duration, eventType.bufferMinutes));
      const requiredOk = required.every((entry) => entry.available_count > 0);
      const allowedOk = allowed.length ? allowed.some((entry) => entry.available_count > 0) : true;
      const available = required.length ? requiredOk : allowedOk;
      slots.push({
        start: start.toISOString(),
        time,
        label: start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        available,
        hasAvailability: available,
        eligible_count: Math.max(...allowed.map((entry) => entry.eligible_count), ...required.map((entry) => entry.eligible_count), 0),
        available_count: Math.max(...allowed.map((entry) => entry.available_count), ...required.map((entry) => entry.available_count), 0)
      });
    }
  }
  return {
    ok: true,
    form_id: form.id,
    date,
    event_type_id: eventType.id,
    duration_minutes: eventType.duration,
    slot_minutes: eventType.slotMinutes,
    buffer_minutes: eventType.bufferMinutes,
    window,
    slots
  };
}

function normalizePreferredStart(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function websiteLeadEvents(form: JsonObject, body: JsonObject, schedulingData: JsonObject = {}) {
  const preferredStart = normalizePreferredStart(body.preferred_start_at || body.preferredStartAt);
  if (!preferredStart) return [];
  const scheduling = asObject(form.scheduling);
  const mode = cleanText(form.mode) || "appointment";
  const eventType = eventTypeFromScheduling(schedulingData, form);
  return [{
    id: `event_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
    event_type_default_id: eventType.id,
    type_id: eventType.id,
    title: eventType.id.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
    start_at: preferredStart,
    duration_minutes: eventType.duration,
    buffer_minutes: eventType.bufferMinutes,
    required_role_ids: eventType.requiredRoleIds,
    allowed_role_ids: eventType.allowedRoleIds,
    assigned_user_ids: [],
    status: "requested",
    source: "website_embed"
  }];
}

async function createProjectFromWebsiteForm(assignment: WebsiteFormAssignment, payload: JsonObject) {
  const form = defaultWebsiteForm(assignment.orgId, assignment.branchId, assignment.form);
  const schedulingData = await readSchedulingData(assignment.orgId, assignment.branchId);
  const name = cleanText(payload.name || payload.customer_name);
  const email = normalizeEmail(payload.email);
  const phone = cleanText(payload.phone);
  const address = cleanText(payload.address);
  const message = cleanText(payload.message || payload.notes);
  const contacts = name || email || phone ? [{ name, email, phone, phones: phone ? [phone] : [] }] : [];
  const targetRoleIds = Array.isArray(assignment.data.notification_target_role_ids)
    ? assignment.data.notification_target_role_ids.map(cleanText).filter(Boolean)
    : DEFAULT_NOTIFICATION_ROLES;
  const preferredStart = normalizePreferredStart(payload.preferred_start_at || payload.preferredStartAt);
  return await createPlatformLead(assignment.orgId, {
    branch_id: assignment.branchId,
    stage_id: cleanText(assignment.data.project_stage_id) || NEW_LEAD_STAGE_ID,
    source_kind: "website_embed",
    address,
    title: address || name || cleanText(form.name) || "Website lead",
    summary: message,
    contacts,
    provider: "Website Embed",
    confidence: 1,
    events: websiteLeadEvents(form, payload, schedulingData),
    provider_fields: {
      form_id: form.id,
      form_name: form.name,
      tracking_key: form.tracking_key,
      mode: form.mode,
      preferred_start_at: preferredStart,
      page_url: cleanText(payload.page_url || payload.pageUrl),
      referrer: cleanText(payload.referrer)
    },
    lead_source: {
      kind: "website_embed",
      provider: "Website Embed",
      form_id: form.id,
      form_name: form.name,
      tracking_key: form.tracking_key,
      mode: form.mode,
      preferred_start_at: preferredStart,
      page_url: cleanText(payload.page_url || payload.pageUrl),
      referrer: cleanText(payload.referrer),
      raw: payload
    },
    project_data: {
      website_form: {
        id: form.id,
        name: form.name,
        tracking_key: form.tracking_key,
        mode: form.mode
      }
    },
    notification: {
      source: "website_embed_lead_import",
      title: form.mode === "call" ? "New website call request" : "New website appointment request",
      body: address || name || message || "A website lead form was submitted.",
      target_role_ids: targetRoleIds,
      context: {
        form_id: form.id,
        tracking_key: form.tracking_key,
        preferred_start_at: preferredStart
      }
    }
  });
}

function verifyInboundWebhook(request: { headers: Record<string, unknown>; query: unknown }) {
  const configured = cleanText(env.emailInboundWebhookToken);
  if (!configured) return;
  const query = asObject(request.query);
  const provided = cleanText(request.headers["x-email-webhook-token"] || request.headers["x-postmark-token"] || query.token);
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
      leadImportSettings: "/v1/email/organizations/:orgId/branch/:branchId/lead-import",
      publicWebsiteForm: "/v1/email/public/forms/:formId",
      publicWebsiteAvailability: "/v1/email/public/forms/:formId/availability",
      publicWebsiteSubmit: "/v1/email/public/forms/:formId/submit"
    },
    outbound: {
      transactional: "/v1/email/outbound/transactional"
    }
  }));

  app.post("/outbound/transactional", async (request) => {
    await requirePlatformAuth(request, { csrf: true, permission: "manage_company_settings|manage_organization|admin" });
    const body = objectBodySchema.parse(request.body ?? {});
    return await sendTransactionalEmail({
      to: cleanText(body.to),
      subject: cleanText(body.subject),
      textBody: cleanText(body.text_body || body.textBody),
      htmlBody: cleanText(body.html_body || body.htmlBody),
      from: cleanText(body.from),
      replyTo: cleanText(body.reply_to || body.replyTo),
      tag: cleanText(body.tag),
      metadata: asObject(body.metadata) as Record<string, string>
    });
  });

  app.get("/organizations/:orgId/branch/:branchId/lead-import", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    if (!(await hasAnyLeadImportFlag(orgId))) throw forbidden("app_flag_disabled", "Lead import is not enabled for this organization.");
    await ensureLeadIntakeSettings(orgId, branchId);
    const { module, data } = await ensureLeadImportSettings(orgId, branchId);
    return { ok: true, settings: data, module };
  });

  app.patch("/organizations/:orgId/branch/:branchId/lead-import", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    if (!(await hasAnyLeadImportFlag(orgId))) throw forbidden("app_flag_disabled", "Lead import is not enabled for this organization.");
    const body = objectBodySchema.parse(request.body ?? {});
    if ((body.regenerate === true || body.enabled !== undefined || body.notification_target_role_ids !== undefined) && !(await isAppFlagEnabled(orgId, "email", "inbound_lead_import"))) {
      throw forbidden("app_flag_disabled", "Email lead import is not enabled for this organization.");
    }
    if (body.website_forms !== undefined && !(await isAppFlagEnabled(orgId, "platform", "website_embed_import"))) {
      throw forbidden("app_flag_disabled", "Website lead embeds are not enabled for this organization.");
    }
    if (Array.isArray(body.website_forms)) {
      await patchLeadIntakeSettings(orgId, branchId, { forms: body.website_forms });
    }
    const { data: current } = await ensureLeadImportSettings(orgId, branchId);
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
    }
    const module = await saveBranchModule(orgId, branchId, LEAD_IMPORT_MODULE_ID, {
      data: next,
      metadata: { kind: "branch_lead_import", source: "email_api" }
    }, { replace: true });
    return { ok: true, settings: next, module };
  });

  app.get("/public/forms/:formId", async (request) => {
    return publicFormConfigById(getParam(request.params, "formId"));
  });

  app.get("/public/forms/:formId/availability", async (request) => {
    return publicFormAvailabilityById(getParam(request.params, "formId"), asObject(request.query));
  });

  app.post("/public/forms/:formId/submit", async (request, reply) => {
    const created = await submitPublicFormById(getParam(request.params, "formId"), objectBodySchema.parse(request.body ?? {}));
    reply.code(201);
    return created;
  });

  app.post("/inbound/postmark", async (request, reply) => {
    verifyInboundWebhook({ headers: request.headers, query: request.query });
    const payload = objectBodySchema.parse(request.body ?? {});
    const recipients = postmarkRecipients(payload);
    if (!recipients.length) {
      reply.code(202);
      return { ok: true, accepted: false, reason: "no_recipients" };
    }
    const assignment = await findLeadAssignment(recipients);
    if (!assignment) {
      reply.code(202);
      return { ok: true, accepted: false, reason: "no_matching_lead_import_address", recipients };
    }
    const extracted = asObject(await extractLead(payload));
    if (extracted.is_lead === false) {
      reply.code(202);
      return { ok: true, accepted: false, reason: "not_a_lead", assignment: { org_id: assignment.orgId, branch_id: assignment.branchId } };
    }
    if (!normalizeContacts(extracted, payload).length && !cleanText(extracted.address)) {
      throw badRequest("lead_missing_contact_data", "The email matched a lead address but did not contain contact or address data.");
    }
    const created = await createProjectFromLead(assignment, payload, extracted);
    return {
      ok: true,
      accepted: true,
      assignment: { org_id: assignment.orgId, branch_id: assignment.branchId, inbound_email: assignment.email },
      extraction: extracted,
      project: created.project,
      contacts: created.contacts,
      notification: created.notification
    };
  });
};
