// Match an inbound address (email or phone) to a project contact so inbound
// messages land on the right project. Used by the email engine, the Telnyx
// inbound webhook, and the comms simulator.

import { listDocuments } from "../platform/storage.js";

type Json = Record<string, unknown>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeEmail(value: unknown) {
  const email = cleanText(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function normalizePhone(value: unknown) {
  const raw = cleanText(value);
  const compact = raw.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

export type ProjectContactMatch = {
  project_id: string;
  contact_id: string;
  contact_name: string;
  project_updated_at: string;
};

/**
 * Scan the org's projects for a contact with the given email/phone. When more
 * than one project matches (repeat customers), the most recently updated
 * non-archived project wins — that is almost always the active conversation.
 */
export async function matchProjectContact(
  organizationId: string,
  address: { email?: string; phone?: string }
): Promise<ProjectContactMatch | null> {
  const email = normalizeEmail(address.email);
  const phone = normalizePhone(address.phone);
  if (!email && !phone) return null;
  let projects: Json[] = [];
  try {
    projects = (await listDocuments(organizationId, "projects")) as Json[];
  } catch {
    return null;
  }
  const matches: ProjectContactMatch[] = [];
  for (const document of projects) {
    const data = asObject(document.data);
    const status = cleanText(data.status).toLowerCase();
    if (status === "archived" || status === "deleted") continue;
    for (const rawContact of asArray(data.contacts)) {
      const contact = asObject(rawContact);
      const contactEmail = normalizeEmail(contact.email);
      const contactPhone = normalizePhone(contact.phone || contact.phone_number || contact.mobile);
      if ((email && contactEmail === email) || (phone && contactPhone === phone)) {
        matches.push({
          project_id: cleanText(document.id),
          contact_id: cleanText(contact.id) || cleanText(contact.contact_id),
          contact_name: cleanText(contact.name || `${cleanText(contact.first_name)} ${cleanText(contact.last_name)}`),
          project_updated_at: cleanText(data.updated_at || document.updated_at)
        });
        break;
      }
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => (a.project_updated_at < b.project_updated_at ? 1 : -1));
  return matches[0] ?? null;
}
