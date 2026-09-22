// Contact-book parsing for the contacts import system.
//
// Two families cover effectively every consumer export:
//   - vCard (.vcf) — the interchange standard Apple Contacts, Google Contacts,
//     Outlook, and phone SIM tools all emit. Versions 2.1 (quoted-printable,
//     bare params), 3.0, and 4.0 are handled.
//   - Delimited text (.csv/.tsv) — Google CSV, Outlook CSV, Yahoo CSV, and
//     generic spreadsheets. The delimiter is sniffed and headers are matched
//     through an alias table; callers may override the mapping per column.
//
// Output is a uniform row shape the preview/commit pipeline consumes.

export type ImportedContactRow = {
  name: string;
  email: string;
  phone: string;
  address: string;
  company: string;
  notes: string;
  birthday: string;
  tags: string[];
  extra_emails: string[];
  extra_phones: string[];
};

export type ContactParseResult = {
  format: "vcard" | "csv";
  rows: ImportedContactRow[];
  headers: string[];
  mapping: Record<string, string>;
  delimiter: string;
  warnings: string[];
};

export const CONTACT_IMPORT_ROW_LIMIT = 25_000;

// Canonical mapping targets offered to the client for manual column mapping.
export const CONTACT_IMPORT_FIELDS = [
  "name", "first_name", "middle_name", "last_name",
  "email", "phone", "address", "street", "city", "state", "postal_code", "country",
  "company", "notes", "birthday", "tags", "ignore"
] as const;

type MappedField = (typeof CONTACT_IMPORT_FIELDS)[number];

function text(value: unknown) {
  return String(value ?? "").trim();
}

function collapseSpace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Shared row helpers

function cleanTag(value: string) {
  return collapseSpace(value).replace(/^\*\s*/, "").slice(0, 80);
}

const IGNORED_TAGS = new Set(["mycontacts", "my contacts", "starred", "imported", "contacts", ""]);

function pushTag(tags: string[], value: string) {
  const tag = cleanTag(value);
  if (IGNORED_TAGS.has(tag.toLowerCase())) return;
  if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
  tags.push(tag);
}

function emptyRow(): ImportedContactRow {
  return { name: "", email: "", phone: "", address: "", company: "", notes: "", birthday: "", tags: [], extra_emails: [], extra_phones: [] };
}

function rowHasIdentity(row: ImportedContactRow) {
  return !!(row.name || row.email || row.phone);
}

function addEmail(row: ImportedContactRow, value: string, preferred = false) {
  const email = text(value).toLowerCase();
  if (!email || !email.includes("@")) return;
  if (row.email === email || row.extra_emails.includes(email)) return;
  if (!row.email) {
    row.email = email;
    return;
  }
  if (preferred) {
    row.extra_emails.unshift(row.email);
    row.email = email;
  } else {
    row.extra_emails.push(email);
  }
}

function addPhone(row: ImportedContactRow, value: string, preferred = false) {
  const phone = collapseSpace(text(value));
  if (!phone || phone.replace(/\D+/g, "").length < 5) return;
  const digits = phone.replace(/\D+/g, "");
  const known = [row.phone, ...row.extra_phones].map((entry) => entry.replace(/\D+/g, ""));
  if (known.includes(digits)) return;
  if (!row.phone) {
    row.phone = phone;
    return;
  }
  if (preferred) {
    row.extra_phones.unshift(row.phone);
    row.phone = phone;
  } else {
    row.extra_phones.push(phone);
  }
}

// ---------------------------------------------------------------------------
// vCard

function decodeQuotedPrintable(value: string) {
  const source = value.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
      bytes.push(parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
    else for (const byte of new TextEncoder().encode(ch)) bytes.push(byte);
  }
  const buffer = Uint8Array.from(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // Not valid UTF-8 - treat the bytes as latin-1.
    return String.fromCharCode(...bytes);
  }
}

function unescapeVcardValue(value: string) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// Splits on a separator, honouring backslash escapes.
function splitUnescaped(value: string, separator: string) {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      current += ch + value[i + 1];
      i += 1;
      continue;
    }
    if (ch === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

type VcardProperty = {
  name: string;
  params: Map<string, string[]>;
  value: string;
};

function parseVcardLine(line: string): VcardProperty | null {
  const colon = findUnquoted(line, ":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  let value = line.slice(colon + 1);
  const segments = splitParamSegments(head);
  if (!segments.length) return null;
  let name = segments.shift()!.trim().toUpperCase();
  const dot = name.lastIndexOf(".");
  if (dot >= 0) name = name.slice(dot + 1); // drop grouping prefix (item1.EMAIL)
  const params = new Map<string, string[]>();
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    const key = (eq >= 0 ? segment.slice(0, eq) : "TYPE").trim().toUpperCase();
    const raw = eq >= 0 ? segment.slice(eq + 1) : segment;
    const values = raw.split(",").map((entry) => entry.trim().replace(/^"|"$/g, "").toUpperCase()).filter(Boolean);
    params.set(key, [...(params.get(key) || []), ...values]);
  }
  const encoding = (params.get("ENCODING") || []).join(",");
  if (/QUOTED-PRINTABLE/i.test(encoding)) value = decodeQuotedPrintable(value);
  return { name, params, value };
}

function findUnquoted(line: string, target: string) {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === target && !quoted) return i;
  }
  return -1;
}

function splitParamSegments(head: string) {
  const segments: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of head) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === ";" && !quoted) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

function propertyTypes(property: VcardProperty) {
  return new Set(property.params.get("TYPE") || []);
}

function isPreferred(property: VcardProperty) {
  if (propertyTypes(property).has("PREF")) return true;
  const pref = property.params.get("PREF");
  return !!pref && pref.some((entry) => Number(entry) === 1);
}

function formatVcardAddress(value: string) {
  // ADR: pobox;extended;street;locality;region;postal;country
  const parts = splitUnescaped(value, ";").map((part) => collapseSpace(unescapeVcardValue(part)));
  const [pobox, extended, street, locality, region, postal, country] = parts;
  const line1 = [pobox, extended, street].filter(Boolean).join(", ");
  const line2 = [locality, region].filter(Boolean).join(", ");
  const line3 = [postal, country].filter(Boolean).join(" ");
  return collapseSpace([line1, line2, line3].filter(Boolean).join(", "));
}

function parseVcardBlock(lines: string[]): ImportedContactRow {
  const row = emptyRow();
  let fallbackName = "";
  let structuredName = "";
  let bestAddress = "";
  let bestAddressPreferred = false;
  for (const line of lines) {
    const property = parseVcardLine(line);
    if (!property || !text(property.value)) continue;
    const types = propertyTypes(property);
    const preferred = isPreferred(property);
    switch (property.name) {
      case "FN":
        fallbackName = collapseSpace(unescapeVcardValue(property.value));
        break;
      case "N": {
        const [family = "", given = "", middle = "", prefix = "", suffix = ""] = splitUnescaped(property.value, ";").map((part) => collapseSpace(unescapeVcardValue(part)));
        structuredName = collapseSpace([prefix, given, middle, family, suffix].filter(Boolean).join(" "));
        break;
      }
      case "EMAIL":
        addEmail(row, unescapeVcardValue(property.value), preferred);
        break;
      case "TEL": {
        const mobile = types.has("CELL") || types.has("MOBILE");
        addPhone(row, unescapeVcardValue(property.value), preferred || (mobile && !row.phone.length));
        break;
      }
      case "ADR": {
        const formatted = formatVcardAddress(property.value);
        if (formatted && (!bestAddress || (preferred && !bestAddressPreferred))) {
          bestAddress = formatted;
          bestAddressPreferred = preferred;
        }
        break;
      }
      case "LABEL":
        if (!bestAddress) bestAddress = collapseSpace(unescapeVcardValue(property.value));
        break;
      case "ORG":
        row.company = collapseSpace(unescapeVcardValue(splitUnescaped(property.value, ";")[0] || ""));
        break;
      case "NOTE":
        row.notes = row.notes ? `${row.notes}\n${unescapeVcardValue(property.value).trim()}` : unescapeVcardValue(property.value).trim();
        break;
      case "BDAY":
        row.birthday = text(property.value);
        break;
      case "CATEGORIES":
        for (const tag of splitUnescaped(property.value, ",")) pushTag(row.tags, unescapeVcardValue(tag));
        break;
      default:
        break;
    }
  }
  row.name = fallbackName || structuredName;
  row.address = bestAddress;
  return row;
}

export function parseVcards(input: string): ContactParseResult {
  const normalized = input.replace(/^﻿/, "");
  const rawLines = normalized.split(/\r\n|\r|\n/);
  // Unfold continuation lines (RFC 6350) and quoted-printable soft breaks
  // (vCard 2.1 lines ending in "=").
  const lines: string[] = [];
  for (const rawLine of rawLines) {
    if (!lines.length) {
      lines.push(rawLine);
      continue;
    }
    const previous = lines[lines.length - 1]!;
    if (rawLine.startsWith(" ") || rawLine.startsWith("\t")) {
      lines[lines.length - 1] = previous + rawLine.slice(1);
      continue;
    }
    if (/ENCODING=QUOTED-PRINTABLE/i.test(previous) && previous.endsWith("=")) {
      lines[lines.length - 1] = previous.slice(0, -1) + rawLine;
      continue;
    }
    lines.push(rawLine);
  }

  const rows: ImportedContactRow[] = [];
  const warnings: string[] = [];
  let block: string[] | null = null;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VCARD") {
      block = [];
      continue;
    }
    if (upper === "END:VCARD") {
      if (block) {
        const row = parseVcardBlock(block);
        if (rowHasIdentity(row)) rows.push(row);
      }
      block = null;
      continue;
    }
    if (block) block.push(line);
  }
  if (block) warnings.push("The file ended inside a vCard block; the final entry was ignored.");
  if (rows.length > CONTACT_IMPORT_ROW_LIMIT) {
    warnings.push(`The file holds more than ${CONTACT_IMPORT_ROW_LIMIT.toLocaleString()} contacts; extra entries were ignored.`);
  }
  return { format: "vcard", rows: rows.slice(0, CONTACT_IMPORT_ROW_LIMIT), headers: [], mapping: {}, delimiter: "", warnings };
}

// ---------------------------------------------------------------------------
// CSV / delimited text

function detectDelimiter(sample: string) {
  const candidates = [",", ";", "\t", "|"] as const;
  const firstLine = sample.split(/\r\n|\r|\n/).find((line) => line.trim()) || "";
  let best: string = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === candidate && !quoted) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function parseDelimitedRows(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const push = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    push();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };
  const chars = input.replace(/^﻿/, "");
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (quoted) {
      if (ch === '"') {
        if (chars[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      push();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    if (ch === "\r") {
      if (chars[i + 1] === "\n") i += 1;
      endRow();
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}

function normalizeHeader(header: string) {
  return text(header).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Alias table for automatic header mapping. Keys are normalized headers;
// covers Google Contacts (old + 2023 formats), Outlook, Yahoo, and generic
// spreadsheet conventions.
const HEADER_ALIASES: Record<string, MappedField> = {
  name: "name", full_name: "name", display_name: "name", contact_name: "name", customer_name: "name", contact: "name",
  first_name: "first_name", given_name: "first_name", first: "first_name",
  middle_name: "middle_name", additional_name: "middle_name",
  last_name: "last_name", family_name: "last_name", surname: "last_name", last: "last_name",
  email: "email", e_mail: "email", email_address: "email", e_mail_address: "email", email_1: "email", primary_email: "email",
  phone: "phone", phone_number: "phone", telephone: "phone", tel: "phone",
  mobile: "phone", mobile_phone: "phone", cell: "phone", cell_phone: "phone", mobile_number: "phone",
  home_phone: "phone", work_phone: "phone", business_phone: "phone", primary_phone: "phone", other_phone: "phone",
  address: "address", full_address: "address", street_address: "address", mailing_address: "address",
  home_address: "address", formatted_address: "address", customer_address: "address",
  street: "street", address_line_1: "street", address_1: "street", home_street: "street", business_street: "street", street_1: "street",
  city: "city", town: "city", home_city: "city", business_city: "city", locality: "city",
  state: "state", province: "state", region: "state", home_state: "state", business_state: "state",
  zip: "postal_code", zip_code: "postal_code", postal_code: "postal_code", postcode: "postal_code",
  home_postal_code: "postal_code", business_postal_code: "postal_code",
  country: "country", home_country: "country", home_country_region: "country", business_country_region: "country",
  company: "company", organization: "company", organisation: "company", organization_name: "company",
  company_name: "company", employer: "company", business: "company",
  notes: "notes", note: "notes", comments: "notes", description: "notes",
  birthday: "birthday", birth_date: "birthday", date_of_birth: "birthday", dob: "birthday", anniversary: "ignore",
  tags: "tags", labels: "tags", label: "tags", groups: "tags", group_membership: "tags", categories: "tags", category: "tags"
};

// Google-style repeated columns: "E-mail 1 - Value", "Phone 2 - Value",
// "Address 1 - Formatted", "Organization 1 - Name".
function googleHeaderField(normalized: string): MappedField | "" {
  let match = normalized.match(/^e_mail_(\d+)_value$/) || normalized.match(/^email_(\d+)_value$/);
  if (match) return "email";
  match = normalized.match(/^phone_(\d+)_value$/);
  if (match) return "phone";
  if (/^address_\d+_formatted$/.test(normalized)) return "address";
  if (/^address_\d+_street$/.test(normalized)) return "street";
  if (/^address_\d+_city$/.test(normalized)) return "city";
  if (/^address_\d+_region$/.test(normalized)) return "state";
  if (/^address_\d+_postal_code$/.test(normalized)) return "postal_code";
  if (/^address_\d+_country$/.test(normalized)) return "country";
  if (/^organization_\d+_name$/.test(normalized)) return "company";
  if (/^e_mail_\d+_type$/.test(normalized) || /^phone_\d+_type$/.test(normalized) || /^address_\d+_/.test(normalized) || /^organization_\d+_/.test(normalized)) return "ignore";
  if (/^(website|relation|event|custom_field|im)_\d+_/.test(normalized)) return "ignore";
  return "";
}

function autoMapHeader(header: string): MappedField | "" {
  const normalized = normalizeHeader(header);
  if (!normalized) return "ignore";
  if (HEADER_ALIASES[normalized]) return HEADER_ALIASES[normalized];
  const google = googleHeaderField(normalized);
  if (google) return google;
  // Outlook-style numbered emails: "E-mail 2 Address".
  if (/^e_mail_\d+_address$/.test(normalized)) return "email";
  if (/(^|_)fax($|_)/.test(normalized)) return "ignore";
  return "";
}

export function suggestCsvMapping(headers: string[]) {
  const mapping: Record<string, string> = {};
  headers.forEach((header, index) => {
    mapping[String(index)] = autoMapHeader(header) || "ignore";
  });
  return mapping;
}

export function parseContactCsv(input: string, mappingOverride: Record<string, unknown> = {}): ContactParseResult {
  const delimiter = detectDelimiter(input);
  const table = parseDelimitedRows(input, delimiter);
  const warnings: string[] = [];
  if (!table.length) return { format: "csv", rows: [], headers: [], mapping: {}, delimiter, warnings: ["The file has no rows."] };
  const headers = table[0]!.map((header) => text(header));
  const mapping = suggestCsvMapping(headers);
  for (const [key, value] of Object.entries(mappingOverride)) {
    const field = text(value) as MappedField;
    if (!CONTACT_IMPORT_FIELDS.includes(field)) continue;
    // Overrides may be keyed by column index or by header text.
    if (Object.prototype.hasOwnProperty.call(mapping, text(key))) {
      mapping[text(key)] = field;
      continue;
    }
    const headerIndex = headers.findIndex((header) => normalizeHeader(header) === normalizeHeader(text(key)));
    if (headerIndex >= 0) mapping[String(headerIndex)] = field;
  }
  const unmapped = headers.filter((_header, index) => mapping[String(index)] === "ignore" && autoMapHeader(headers[index]!) === "");
  if (unmapped.length) warnings.push(`Unrecognized columns were ignored: ${unmapped.slice(0, 8).join(", ")}${unmapped.length > 8 ? ", ..." : ""}.`);

  const rows: ImportedContactRow[] = [];
  for (const cells of table.slice(1, CONTACT_IMPORT_ROW_LIMIT + 1)) {
    const row = emptyRow();
    const nameParts: Record<string, string> = {};
    const addressParts: Record<string, string> = {};
    cells.forEach((cellValue, index) => {
      const field = (mapping[String(index)] || "ignore") as MappedField;
      const value = text(cellValue);
      if (!value || field === "ignore") return;
      switch (field) {
        case "name": if (!row.name) row.name = collapseSpace(value); break;
        case "first_name": case "middle_name": case "last_name": nameParts[field] = collapseSpace(value); break;
        case "email": addEmail(row, value); break;
        case "phone": addPhone(row, value); break;
        case "address": if (!row.address) row.address = collapseSpace(value); break;
        case "street": case "city": case "state": case "postal_code": case "country":
          if (!addressParts[field]) addressParts[field] = collapseSpace(value);
          break;
        case "company": if (!row.company) row.company = collapseSpace(value); break;
        case "notes": row.notes = row.notes ? `${row.notes}\n${value}` : value; break;
        case "birthday": if (!row.birthday) row.birthday = value; break;
        case "tags":
          // Google separates multiple group memberships with " ::: ".
          for (const tag of value.split(/\s*:::\s*|\s*[;,]\s*/)) pushTag(row.tags, tag);
          break;
        default: break;
      }
    });
    if (!row.name) {
      row.name = collapseSpace([nameParts.first_name, nameParts.middle_name, nameParts.last_name].filter(Boolean).join(" "));
    }
    if (!row.address) {
      const line2 = [addressParts.city, addressParts.state].filter(Boolean).join(", ");
      const line3 = [addressParts.postal_code, addressParts.country].filter(Boolean).join(" ");
      row.address = collapseSpace([addressParts.street, line2, line3].filter(Boolean).join(", "));
    }
    if (rowHasIdentity(row)) rows.push(row);
  }
  if (table.length - 1 > CONTACT_IMPORT_ROW_LIMIT) {
    warnings.push(`The file holds more than ${CONTACT_IMPORT_ROW_LIMIT.toLocaleString()} rows; extra rows were ignored.`);
  }
  return { format: "csv", rows, headers, mapping, delimiter, warnings };
}

// ---------------------------------------------------------------------------
// Entry point

export function detectContactFileFormat(fileName: string, content: string): "vcard" | "csv" {
  const head = content.replace(/^﻿/, "").slice(0, 2000).trim().toUpperCase();
  if (head.startsWith("BEGIN:VCARD") || /\.vcf$/i.test(text(fileName))) return "vcard";
  return "csv";
}

export function parseContactFile(fileName: string, content: string, mappingOverride: Record<string, unknown> = {}): ContactParseResult {
  return detectContactFileFormat(fileName, content) === "vcard"
    ? parseVcards(content)
    : parseContactCsv(content, mappingOverride);
}
