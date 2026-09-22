// FirstMate Mail engine — org email inboxes and outbound customer email.
//
// Every organization gets its own address at the FirstMate Mail domain
// (e.g. apexroofing@firstmatemail.com). The address is stored as the default
// email sender identity in the communications DB, so sendCommunication and
// the assistant/automation send paths pick it up automatically. Outbound
// customer email flows through sendCommunication (recorded + captured in test
// mode) with RFC 2822 threading metadata so inbound replies can be matched to
// their conversation. Delivery to the outside world is the provider adapter's
// job (providers.ts); in capture mode nothing leaves the building.

import { createHash, randomUUID } from "node:crypto";

import { badRequest } from "../platform/errors.js";
import { readOrganization } from "../platform/storage.js";
import { env } from "../src/config/env.js";
import {
  getCommunicationsDatabase,
  listSenderIdentities,
  upsertSenderIdentity
} from "../messaging/communications_storage.js";
import { sendCommunication, publishWorkCommunicationEvent } from "../messaging/communications_service.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { emailTenantName, ensureEmailTenant } from "./tenants.js";

type Json = Record<string, unknown>;

export const FIRSTMATE_MAIL_IDENTITY_ID = "firstmate_mail";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function normalizeEmailAddress(value: unknown) {
  const email = cleanText(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function slugForOrganizationName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
  return slug || "team";
}

/**
 * Global lookup: which org owns this inbox address? Email sender identities
 * are per-org rows, so inbound routing needs a cross-org query.
 */
export async function findEmailInboxOwner(address: string) {
  const normalized = normalizeEmailAddress(address);
  if (!normalized) return null;
  const row = (await getCommunicationsDatabase()
    .prepare("SELECT * FROM communication_sender_identities WHERE channel = 'email' AND address = ? AND status = 'active' LIMIT 1")
    .get(normalized));
  if (!row) return null;
  const record = row as Json;
  return {
    organization_id: cleanText(record.organization_id),
    branch_id: cleanText(record.branch_id) || "default",
    identity_id: cleanText(record.id),
    address: cleanText(record.address)
  };
}

async function emailAddressTaken(address: string) {
  const row = (await getCommunicationsDatabase()
    .prepare("SELECT id FROM communication_sender_identities WHERE channel = 'email' AND address = ? LIMIT 1")
    .get(address));
  return Boolean(row);
}

function isUniqueAddressCollision(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /UNIQUE constraint failed: communication_sender_identities\.address/i.test(message);
}

/**
 * Provision (or return) the organization's FirstMate Mail inbox. Idempotent:
 * the identity id is stable, and the allocated address survives org renames.
 */
export async function ensureOrgEmailInbox(organizationId: string, branchId = "default") {
  const existing = (await listSenderIdentities(organizationId, branchId, "email"))
    .find((identity) => cleanText(identity.id) === FIRSTMATE_MAIL_IDENTITY_ID);
  if (existing && cleanText(existing.address)) {
    await ensureEmailTenant({ organizationId, identityDomains: [env.firstmateMailDomain] });
    return existing;
  }

  const organization = await readOrganization(organizationId).catch(() => ({} as Json));
  const orgName = cleanText(organization.name || organization.display_name) || organizationId;
  const base = slugForOrganizationName(orgName);
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const suffix = attempt === 1 ? "" : String(attempt);
    const address = `${base}${suffix}@${env.firstmateMailDomain}`;
    if ((await emailAddressTaken(address))) continue;
    try {
      const identity = (await upsertSenderIdentity({
        id: FIRSTMATE_MAIL_IDENTITY_ID,
        organization_id: organizationId,
        branch_id: branchId,
        channel: "email",
        provider: "cloudflare_email",
        address,
        display_name: orgName,
        reply_to: address,
        status: "active",
        is_default: true,
        capabilities: { transactional: true, conversational: true, html: true, inbound: true },
        metadata: {
          managed_by: "firstmate_mail",
          domain: env.firstmateMailDomain,
          tenant_name: emailTenantName(organizationId),
          delivery_mode: env.emailDeliveryMode
        }
      }));
      await ensureEmailTenant({ organizationId, identityDomains: [env.firstmateMailDomain] });
      return identity;
    } catch (error) {
      // Another signup can claim the candidate between the lookup and insert.
      // The unique index is authoritative, so retry the next suffix.
      if (!isUniqueAddressCollision(error)) throw error;
    }
  }
  const fallback = `${base.slice(0, 30)}-${createHash("sha256").update(organizationId).digest("hex").slice(0, 8)}@${env.firstmateMailDomain}`;
  if ((await emailAddressTaken(fallback))) throw new Error("Unable to allocate a unique FirstMate Mail address for this organization.");
  const identity = (await upsertSenderIdentity({
    id: FIRSTMATE_MAIL_IDENTITY_ID,
    organization_id: organizationId,
    branch_id: branchId,
    channel: "email",
    provider: "firstmate_mail",
    address: fallback,
    display_name: orgName,
    reply_to: fallback,
    status: "active",
    is_default: true,
    capabilities: { transactional: true, conversational: true, html: true, inbound: true },
    metadata: {
      managed_by: "firstmate_mail",
      domain: env.firstmateMailDomain,
      tenant_name: emailTenantName(organizationId),
      delivery_mode: env.emailDeliveryMode
    }
  }));
  await ensureEmailTenant({ organizationId, identityDomains: [env.firstmateMailDomain] });
  return identity;
}

export async function configureOrgDomainEmailIdentity(input: {
  organizationId: string;
  branchId?: string;
  domain: string;
  localPart: string;
}) {
  const domain = cleanText(input.domain).toLowerCase();
  const localPart = cleanText(input.localPart).toLowerCase();
  const address = normalizeEmailAddress(`${localPart}@${domain}`);
  if (!address) throw badRequest("invalid_domain_email", "Enter a valid default email address for this domain.");
  const organization = await readOrganization(input.organizationId).catch(() => ({} as Json));
  const orgName = cleanText(organization.name || organization.display_name) || input.organizationId;
  const identity = (await upsertSenderIdentity({
    id: `domain_email_${createHash("sha256").update(domain).digest("hex").slice(0, 16)}`,
    organization_id: input.organizationId,
    branch_id: cleanText(input.branchId || "default") || "default",
    channel: "email",
    provider: "cloudflare_email",
    address,
    display_name: orgName,
    reply_to: address,
    status: "active",
    is_default: true,
    capabilities: { transactional: true, conversational: true, html: true, inbound: true },
    metadata: { managed_by: "firstmate_domain", domain, tenant_name: emailTenantName(input.organizationId), delivery_mode: env.emailDeliveryMode }
  }));
  await ensureEmailTenant({ organizationId: input.organizationId, identityDomains: [env.firstmateMailDomain, domain] });
  return identity;
}

export function newRfcMessageId() {
  return `<${randomUUID()}@${env.firstmateMailDomain}>`;
}

/**
 * Send a customer email from the org inbox with conversation threading.
 * Recording, capture mode, idempotency, and events all come from
 * sendCommunication; this wrapper adds the inbox sender, the RFC Message-ID,
 * and In-Reply-To/References derived from the conversation's last message.
 */
export async function sendEngineEmail(
  organizationId: string,
  input: {
    branch_id?: string;
    conversation_id?: string;
    recipients: Array<Json>;
    subject: string;
    text?: string;
    html?: string;
    purpose?: "customer_care" | "transactional" | "appointment" | "project_update" | "billing" | "account_notification" | "delivery_notification";
    tags?: string[];
    context?: Json;
    source?: Json;
    metadata?: Json;
    idempotency_key?: string;
    in_reply_to?: string;
    references?: string[];
    attachments?: Array<{ name: string; content_type: string; content: Uint8Array | string }>;
  },
  ctx?: Partial<PlatformAuthContext>
) {
  const branchId = cleanText(input.branch_id || ctx?.branchId || "default") || "default";
  const inbox = await ensureOrgEmailInbox(organizationId, branchId);
  if (!cleanText(input.subject)) throw badRequest("email_subject_required", "Email subject is required.");
  const rfcMessageId = newRfcMessageId();
  const emailMeta: Json = {
    message_id: rfcMessageId,
    ...(cleanText(input.in_reply_to) ? { in_reply_to: cleanText(input.in_reply_to) } : {}),
    ...(Array.isArray(input.references) && input.references.length ? { references: input.references.slice(-20) } : {})
  };
  return await sendCommunication(organizationId, {
    branch_id: branchId,
    conversation_id: input.conversation_id,
    channel: "email",
    purpose: input.purpose || "customer_care",
    recipients: input.recipients as never,
    content: { subject: input.subject, text: input.text, html: input.html, attachments: input.attachments },
    sender: { identity_id: cleanText(inbox.id) },
    context: input.context as never,
    source: input.source as never,
    tags: input.tags,
    metadata: { ...asObject(input.metadata), email: emailMeta },
    idempotency_key: input.idempotency_key
  } as never, ctx);
}

export { publishWorkCommunicationEvent };
