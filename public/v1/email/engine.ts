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
//
// A company's own domain (FM-516) has its own identity (info@theirdomain). It sends once the domain's email records
// check out (domains/email-records.ts): setOrgDomainEmailSending makes it the default sender, and until then, or
// whenever its records go missing, mail is sent from FirstMate Mail. Inbound mail for any address at a verified domain
// lands in that identity's inbox.

import { createHash, randomUUID } from "node:crypto";

import { badRequest } from "../platform/errors.js";
import { readOrganization } from "../platform/storage.js";
import { env } from "../src/config/env.js";
import {
  getCommunicationsDatabase,
  listSenderIdentities,
  senderIdentityFromRow,
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

export function domainEmailIdentityId(domain: string) {
  return `domain_email_${createHash("sha256").update(cleanText(domain).toLowerCase()).digest("hex").slice(0, 16)}`;
}

function isDomainIdentity(identity: Json) {
  return asObject(identity.metadata).managed_by === "firstmate_domain";
}

/** A domain identity sends only once its domain's email records check out. */
export function domainIdentitySends(identity: Json) {
  return isDomainIdentity(identity) && cleanText(identity.status) === "active" && asObject(identity.metadata).email_status === "active";
}

/** A domain identity receives once the domain's ownership is verified (mail can only reach it through the domain's MX). */
function domainIdentityReceives(identity: Json) {
  const metadata = asObject(identity.metadata);
  return metadata.domain_verified === true || metadata.email_status === "active";
}

/**
 * Global lookup: which org owns this inbox address? Email sender identities
 * are per-org rows, so inbound routing needs a cross-org query. An address
 * with no identity of its own, at a company's verified domain, goes to that
 * domain's identity (the domain's catch-all routes every address here).
 */
export async function findEmailInboxOwner(address: string) {
  const normalized = normalizeEmailAddress(address);
  if (!normalized) return null;
  const db = getCommunicationsDatabase();
  let row = (await db
    .prepare("SELECT * FROM communication_sender_identities WHERE channel = 'email' AND address = ? AND status = 'active' LIMIT 1")
    .get(normalized)) as Json | undefined;
  if (row && isDomainIdentity(senderIdentityFromRow(row)) && !domainIdentityReceives(senderIdentityFromRow(row))) row = undefined;
  const domain = normalized.split("@").pop() || "";
  if (!row && domain && domain !== env.firstmateMailDomain.toLowerCase()) {
    const candidates = (await db
      .prepare("SELECT * FROM communication_sender_identities WHERE channel = 'email' AND status = 'active' AND address LIKE ? ORDER BY is_default DESC, created_at ASC")
      .all(`%@${domain}`)) as Json[];
    row = candidates.find((candidate) => {
      const identity = senderIdentityFromRow(candidate);
      return cleanText(identity.address).endsWith(`@${domain}`) && isDomainIdentity(identity) && domainIdentityReceives(identity);
    });
  }
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
  const identities = await listSenderIdentities(organizationId, branchId, "email");
  const existing = identities.find((identity) => cleanText(identity.id) === FIRSTMATE_MAIL_IDENTITY_ID);
  if (existing && cleanText(existing.address)) {
    await ensureEmailTenant({ organizationId, identityDomains: [env.firstmateMailDomain] });
    return existing;
  }

  // FirstMate Mail is the default sender only while nothing else sends: never take the flag from a domain that does.
  const isDefault = !identities.some((identity) => identity.is_default === true && cleanText(identity.status) === "active"
    && (!isDomainIdentity(identity) || domainIdentitySends(identity)));
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
        is_default: isDefault,
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
    is_default: isDefault,
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
  /** Ownership proved: inbound mail for the domain may land in this inbox. */
  verified?: boolean;
}) {
  const domain = cleanText(input.domain).toLowerCase();
  const localPart = cleanText(input.localPart).toLowerCase();
  const address = normalizeEmailAddress(`${localPart}@${domain}`);
  if (!address) throw badRequest("invalid_domain_email", "Enter a valid default email address for this domain.");
  const organization = await readOrganization(input.organizationId).catch(() => ({} as Json));
  const orgName = cleanText(organization.name || organization.display_name) || input.organizationId;
  const id = domainEmailIdentityId(domain);
  // It sends (and is the default) only once the domain's records check out; a new address on a domain that already
  // sends keeps sending.
  const previous = (await listSenderIdentities(input.organizationId, "", "email")).find((identity) => identity.id === id);
  const sends = Boolean(previous && domainIdentitySends(previous));
  const identity = (await upsertSenderIdentity({
    id,
    organization_id: input.organizationId,
    branch_id: cleanText(input.branchId || "default") || "default",
    channel: "email",
    provider: "cloudflare_email",
    address,
    display_name: orgName,
    reply_to: address,
    status: "active",
    is_default: sends,
    capabilities: { transactional: true, conversational: true, html: true, inbound: true },
    metadata: {
      managed_by: "firstmate_domain",
      domain,
      tenant_name: emailTenantName(input.organizationId),
      delivery_mode: env.emailDeliveryMode,
      email_status: sends ? "active" : "pending",
      domain_verified: input.verified === true || asObject(previous?.metadata).domain_verified === true
    }
  }));
  await ensureEmailTenant({ organizationId: input.organizationId, identityDomains: [env.firstmateMailDomain, domain] });
  return identity;
}

/**
 * The domain's email records checked out (active) or went missing: its identity becomes the default sender, or
 * FirstMate Mail takes the flag back where the domain had it. Returns the domain identities changed.
 */
export async function setOrgDomainEmailSending(organizationId: string, domain: string, active: boolean) {
  const id = domainEmailIdentityId(domain);
  const identities = await listSenderIdentities(organizationId, "", "email");
  const changed: Json[] = [];
  for (const identity of identities.filter((entry) => entry.id === id)) {
    const metadata = asObject(identity.metadata);
    changed.push(await upsertSenderIdentity({
      ...identity,
      is_default: active && cleanText(identity.status) === "active",
      metadata: { ...metadata, email_status: active ? "active" : "pending", ...(active ? { domain_verified: true } : {}) }
    }));
    if (!active && identity.is_default === true) {
      const fallback = identities.find((entry) => entry.id === FIRSTMATE_MAIL_IDENTITY_ID && entry.branch_id === identity.branch_id);
      if (fallback) await upsertSenderIdentity({ ...fallback, is_default: true });
    }
  }
  return changed;
}

/** Stop a disconnected domain from sending or receiving. */
export async function retireOrgDomainEmailIdentity(organizationId: string, domain: string) {
  await setOrgDomainEmailSending(organizationId, domain, false);
  const id = domainEmailIdentityId(domain);
  for (const identity of (await listSenderIdentities(organizationId, "", "email")).filter((entry) => entry.id === id)) {
    await upsertSenderIdentity({ ...identity, status: "disabled", is_default: false });
  }
}

/** The identity customer mail is sent from: the company's domain once it sends, else FirstMate Mail. */
export async function resolveOrgEmailSender(organizationId: string, branchId = "default") {
  const identities = await listSenderIdentities(organizationId, branchId, "email");
  const domain = identities.find((identity) => domainIdentitySends(identity) && identity.is_default === true)
    || identities.find(domainIdentitySends);
  return domain || await ensureOrgEmailInbox(organizationId, branchId);
}

export function newRfcMessageId(domain = env.firstmateMailDomain) {
  return `<${randomUUID()}@${cleanText(domain) || env.firstmateMailDomain}>`;
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
  const inbox = await resolveOrgEmailSender(organizationId, branchId);
  if (!cleanText(input.subject)) throw badRequest("email_subject_required", "Email subject is required.");
  const rfcMessageId = newRfcMessageId(cleanText(inbox.address).split("@").pop());
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
