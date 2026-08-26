#!/usr/bin/env node
/**
 * TEST-ONLY helper.
 *
 * Runs repeated dry lead extraction over captured Postmark payloads and local
 * email-lead raw payloads. It does not create customers/projects/notifications.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ORG_ID = process.env.PLATFORM_TEST_ORG_ID || "06a71ab1357a7a41aa6ee80a";
const RUNS_PER_LEAD = Math.max(1, Number(process.env.RUNS_PER_LEAD || 10));
const MODEL = process.env.OPENAI_LEAD_MODEL || "gpt-5-nano";
const API_KEY = process.env.OPENAI_API_KEY || "";
const rootDir = process.cwd();
const resultsDir = path.join(rootDir, "email", "testing", "results");

function cleanText(value) {
  return String(value ?? "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function inboundEmailText(payload) {
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

function hashText(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function normalizeOrdinalSpacing(value) {
  return value.replace(/\b(\d+)\s+(st|nd|rd|th)\b/gi, (_match, number, suffix) => `${number}${String(suffix).toLowerCase()}`);
}

function cleanLeadAddress(value) {
  let address = cleanText(value)
    .replace(/<https?:\/\/[^>\s]+>/gi, "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  address = address.replace(/^(address|property address|job address|project address|address of site|site address|streetaddress|street address|property location)\s*[:=-]\s*/i, "");
  address = normalizeOrdinalSpacing(address).replace(/\s+,/g, ",").replace(/,\s*,+/g, ",").trim();
  address = address.replace(/^(.*?),\s*([A-Za-z .'-]+)\s+([A-Z]{2}),?\s+(\d{5}(?:-\d{4})?)(?:\s+.*)?$/i, (_match, street, city, state, zip) => {
    return `${String(street).trim()}, ${String(city).trim()}, ${String(state).toUpperCase()} ${String(zip).trim()}`;
  });
  return titleCaseAddress(address);
}

function titleCaseAddress(value) {
  return cleanText(value).split(",").map((part) => part.trim().split(/\s+/).map((word) => {
    if (/^[A-Z]{2}$/.test(word)) return word;
    if (/^\d+(st|nd|rd|th)$/i.test(word)) return word.toLowerCase();
    if (/^\d+$/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(" ")).join(", ");
}

function usableStreet(value) {
  return /\d/.test(value) ? value : "";
}

function normalizeProviderName(value) {
  const provider = cleanText(value);
  const key = provider.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const known = {
    quinstreet: "QuinStreet",
    inquirly: "Inquirly",
    servicedirect: "Service Direct",
    fixr: "Fixr",
    networx: "Networx"
  };
  return known[key] || provider;
}

function normalizeEmail(value) {
  const email = cleanText(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function normalizePhone(value) {
  const raw = cleanText(value);
  const phoneMatch = raw.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  const digits = (phoneMatch ? phoneMatch[0] : raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+1${digits.slice(1)}`;
  if (digits.length === 10) return `+1${digits}`;
  return "";
}

function unique(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

const INLINE_FIELD_LABELS = {
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

function keyValueFields(lines) {
  const fields = {};
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 /_-]{1,44})\s*:\s*(.+)$/);
    if (!match) continue;
    const key = String(match[1] || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const value = String(match[2] || "").trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

function inlineKeyValueFields(text) {
  const fields = {};
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

function cityStateZipLine(value) {
  const line = cleanText(value);
  return /^[A-Za-z .'-]+,\s*[A-Z]{2},?\s+\d{5}(?:-\d{4})?$/i.test(line) ? line.replace(/,\s*([A-Z]{2}),?\s+/i, ", $1 ") : "";
}

function fallbackForPayload(payload) {
  const text = inboundEmailText(payload);
  const from = normalizeEmail(payload.From || asObject(payload.FromFull).Email);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = { ...keyValueFields(lines), ...inlineKeyValueFields(text) };
  const labeledPhones = unique([fields.primarynumber, fields.phone, fields.workphone].map(normalizePhone)).sort();
  const phones = labeledPhones.length
    ? labeledPhones
    : unique([...text.matchAll(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g)].map((match) => normalizePhone(match[0]))).sort();
  const labeledEmail = normalizeEmail(fields.email);
  const scannedEmails = [...new Set([...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0].toLowerCase()).filter((email) => email !== from))];
  const emails = labeledEmail ? [labeledEmail] : scannedEmails;
  let address = cleanLeadAddress(fields.streetaddress || fields.street_address || fields.address || fields.property_address || fields.job_address || fields.project_address || fields.address_of_site || fields.site_address);
  if (address) {
    const city = cleanText(fields.city);
    const state = cleanText(fields.state).toUpperCase();
    const zip = cleanText(fields.zip || fields.zip_code || fields.postal_code);
    const tail = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    address = tail ? `${address}, ${titleCaseAddress(tail)}` : address;
  }
  if (!address) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] || "";
      if (!/\d{2,} .+ (st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|way|blvd|circle|cir|place|pl|nw|ne|sw|se)\b/i.test(line)) continue;
      const next = cityStateZipLine(lines[i + 1]);
      address = next ? `${cleanLeadAddress(line)}, ${titleCaseAddress(next)}` : cleanLeadAddress(line);
      break;
    }
  }
  const nameLine = lines.find((line) => /^(name|customer|contact)\s*[:=-]/i.test(line));
  const requestedBy = cleanText(fields.requested_by).split(/\s+-\s+/)[0] || "";
  const name = nameLine ? nameLine.replace(/^[^:=-]+[:=-]\s*/, "").trim() : [fields.first_name || fields.firstname, fields.last_name || fields.lastname].filter(Boolean).join(" ") || requestedBy;
  return {
    address,
    contacts: [{ name, email: emails[0] || "", phones }].filter((contact) => contact.name || contact.email || contact.phones.length),
    fields
  };
}

function normalizeOutput(raw, payload) {
  const fallback = fallbackForPayload(payload);
  const modelContacts = (Array.isArray(raw.contacts) ? raw.contacts : []).map((entry) => {
    const contact = asObject(entry);
    return {
      name: cleanText(contact.name).replace(/\s+/g, " "),
      email: normalizeEmail(contact.email),
      phones: unique(Array.isArray(contact.phones) ? contact.phones.map(normalizePhone) : []).sort()
    };
  }).filter((contact) => contact.name || contact.email || contact.phones.length)
    .sort((a, b) => `${a.name}|${a.email}`.localeCompare(`${b.name}|${b.email}`));
  const fallbackContacts = fallback.contacts.map((contact) => ({
    name: cleanText(contact.name).replace(/\s+/g, " "),
    email: normalizeEmail(contact.email),
    phones: unique(Array.isArray(contact.phones) ? contact.phones.map(normalizePhone) : []).sort()
  })).filter((contact) => contact.name || contact.email || contact.phones.length)
    .sort((a, b) => `${a.name}|${a.email}`.localeCompare(`${b.name}|${b.email}`));
  const contacts = fallbackContacts.length ? fallbackContacts : modelContacts;
  const parts = asObject(raw.address_parts);
  const street = usableStreet(cleanLeadAddress(parts.street_line_1));
  const city = cleanText(parts.city).replace(/\s+/g, " ");
  const state = cleanText(parts.state).toUpperCase();
  const postalCode = cleanText(parts.postal_code);
  const addressFromParts = street ? [street, titleCaseAddress(city), [state, postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  const rawAddress = usableStreet(cleanLeadAddress(raw.address));
  const fallbackAddressValue = usableStreet(cleanLeadAddress(fallback.address));
  const tentativeAddress = fallbackAddressValue || addressFromParts || rawAddress;
  const contactSignal = contacts.some((contact) => contact.email || contact.phones.length);
  const leadWords = /\b(roof|roofing|service request|phone lead|webform lead|lead id|homeowner|property type|job type|project details|campaign name)\b/i.test(inboundEmailText(payload));
  const isLead = Boolean(leadWords && (tentativeAddress || contactSignal));
  const address = isLead ? tentativeAddress : "";
  const fields = Object.fromEntries(Object.entries(asObject(fallback.fields)).sort(([a], [b]) => a.localeCompare(b)));
  return {
    is_lead: isLead,
    provider: isLead ? normalizeProviderName(raw.provider) : "",
    confidence: isLead ? (address && contactSignal ? 0.95 : contactSignal ? 0.8 : 0.55) : 0.1,
    address,
    summary: cleanText(payload.Subject),
    contacts: isLead ? contacts : [],
    fields: isLead ? fields : {},
    rejection_reason: isLead ? "" : "Email does not contain a lead/service request with usable contact or job-site information."
  };
}

function parseOpenAIResponse(data) {
  const outputText = cleanText(data.output_text)
    || (Array.isArray(data.output) ? data.output.map((item) => (Array.isArray(item?.content) ? item.content.map((content) => cleanText(content.text)).join("\n") : "")).join("\n") : "");
  return outputText ? JSON.parse(outputText) : {};
}

function schema() {
  return {
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
  };
}

function systemPrompt() {
  return [
    "You standardize inbound roofing lead-provider emails for FirstMate.",
    "Return schema-valid JSON only.",
    "Set is_lead=false for invoices, newsletters, platform notifications, meeting summaries, generic marketing, or any email that is not a customer service/roofing lead. When false, address must be '', contacts must be [], fields may preserve useful diagnostics, and rejection_reason must explain why.",
    "Set is_lead=true for webform leads, phone leads, service requests, quote requests, and marketplace roofing leads even if the address is missing.",
    "Address rules: address and address_parts are only the customer/job-site/property address. Strip labels like 'Address:', 'StreetAddress:', 'Address of site:', 'Property Location:', markdown asterisks, map URLs, and provider boilerplate. Fill address_parts.street_line_1, city, state, and postal_code separately when known. If street/city/state/zip are available, address should be 'Street, City, ST ZIP'. Fix ordinal spacing such as '3 rd' -> '3rd'. Do not include customer names, labels, phone numbers, or URLs in address. If no site address exists, use '' and empty address_parts strings.",
    "Contact rules: contacts are customer/homeowner/caller contacts only. Do not use provider support emails, account managers, dashboard links, billing contacts, or sender addresses unless the sender is clearly the customer. Normalize US phones as +1XXXXXXXXXX when possible. Avoid duplicate phones.",
    "Provider should be the lead source/provider name if clear, such as Inquirly, QuinStreet, Service Direct, Angi, HomeAdvisor, Thumbtack, or the sender domain.",
    "Preserve provider-specific keys like lead id, product, campaign, job type, material, homeowner, comments, and original city/state/zip in fields as an array of {key,value} pairs using snake_case keys."
  ].join(" ");
}

async function extract(payload) {
  if (!API_KEY) throw new Error("OPENAI_API_KEY is required for variation testing.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: "minimal" },
      max_output_tokens: 1200,
      text: {
        format: {
          type: "json_schema",
          name: "lead_email_extraction",
          strict: true,
          schema: schema()
        }
      },
      input: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: inboundEmailText(payload) }
      ]
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI failed ${response.status}: ${text}`);
  return parseOpenAIResponse(JSON.parse(text));
}

async function loadFixturePayloads() {
  const fixtureDir = path.join(rootDir, "email", "testing", "fixtures");
  const payloads = [];
  try {
    const files = (await readdir(fixtureDir)).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const data = JSON.parse((await readFile(path.join(fixtureDir, file), "utf8")).replace(/^\uFEFF/, ""));
      for (const message of Array.isArray(data.messages) ? data.messages : []) {
        if (message?.json) payloads.push({ source: file, payload: message.json });
      }
    }
  } catch {}
  return payloads;
}

async function loadLocalImportedPayloads() {
  const projectDir = path.join(rootDir, "storage", "platform", "organizations", ORG_ID, "projects");
  const payloads = [];
  try {
    const files = (await readdir(projectDir)).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const doc = JSON.parse(await readFile(path.join(projectDir, file), "utf8"));
      if (doc?.data?.source !== "email_lead") continue;
      const raw = doc?.data?.lead_source?.raw_email;
      if (!raw) continue;
      payloads.push({
        source: file,
        payload: {
          From: raw.from,
          To: raw.to,
          Subject: raw.subject,
          TextBody: raw.text_body,
          HtmlBody: raw.html_body,
          Headers: raw.headers
        }
      });
    }
  } catch {}
  return payloads;
}

const rawPayloads = [...await loadFixturePayloads(), ...await loadLocalImportedPayloads()];
const seen = new Set();
const payloads = [];
for (const item of rawPayloads) {
  const key = hashText(inboundEmailText(item.payload));
  if (seen.has(key)) continue;
  seen.add(key);
  payloads.push({ ...item, key, subject: cleanText(item.payload.Subject) || "(no subject)" });
}

await mkdir(resultsDir, { recursive: true });
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const summaries = [];
const details = [];

for (const item of payloads) {
  const variants = new Map();
  for (let run = 1; run <= RUNS_PER_LEAD; run += 1) {
    const output = normalizeOutput(await extract(item.payload), item.payload);
    const key = canonical(output);
    variants.set(key, { output, count: (variants.get(key)?.count || 0) + 1 });
    details.push({ payload_key: item.key, subject: item.subject, run, output });
    process.stdout.write(".");
  }
  process.stdout.write(` ${item.subject} -> ${variants.size} variant(s)\n`);
  summaries.push({
    payload_key: item.key,
    source: item.source,
    subject: item.subject,
    runs: RUNS_PER_LEAD,
    variants: variants.size,
    variant_counts: [...variants.values()].map((entry) => entry.count),
    representative: [...variants.values()][0]?.output || null
  });
}

const result = {
  model: MODEL,
  runs_per_lead: RUNS_PER_LEAD,
  payload_count: payloads.length,
  generated_at: new Date().toISOString(),
  summaries,
  details
};

const jsonPath = path.join(resultsDir, `lead-extraction-variation-${runStamp}.json`);
await writeFile(jsonPath, JSON.stringify(result, null, 2));

const csvRows = [
  ["payload_key", "source", "subject", "runs", "variants", "variant_counts", "is_lead", "address", "contacts", "rejection_reason"].join(",")
];
for (const row of summaries) {
  const rep = row.representative || {};
  csvRows.push([
    row.payload_key,
    row.source,
    row.subject,
    row.runs,
    row.variants,
    row.variant_counts.join("|"),
    rep.is_lead,
    rep.address,
    JSON.stringify(rep.contacts || []),
    rep.rejection_reason
  ].map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","));
}
const csvPath = path.join(resultsDir, `lead-extraction-variation-${runStamp}.csv`);
await writeFile(csvPath, csvRows.join("\n"));

console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${csvPath}`);
