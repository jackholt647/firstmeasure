import { createHash, randomUUID } from "node:crypto";

import { badRequest, conflict, PlatformError } from "../platform/errors.js";
import { env } from "../src/config/env.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import {
  createCommunicationEvent,
  countSmsDeliveriesSince,
  countEmailDeliveriesSince,
  createConversationRecord,
  createDeliveryRecord,
  createMessageRecord,
  findPhoneNumberOwner,
  listCommunicationEvents,
  listConversationRecords,
  listDeliveryRecords,
  listMessageRecords,
  listSenderIdentities,
  readConversationRecord,
  readMessageRecord,
  readSmsConsent,
  touchConversationForMessage,
  updateDeliveryRecord,
  updateMessageRecord,
  upsertSenderIdentity,
  withCommunicationsTransaction,
  type CommunicationsJson
} from "./communications_storage.js";
import { requireActiveEmailTenant } from "../email/tenants.js";
import type { CreateConversationInput, SendCommunicationInput } from "./schemas.js";
import { ensureMessagingOrganization, listSmsComplianceProfiles } from "./storage.js";
import { scheduleSmsDeliveryQueue } from "./delivery_worker.js";
import { outboundSmsComplianceIssue, smsConsentPurposesAllow } from "./compliance_rules.js";
import { smsAutoresponsesReady } from "./autoresponses.js";
import { activeEmailProvider } from "../email/providers.js";

const CAPTURE_SMS_NUMBER = "+12065550199";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): CommunicationsJson {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as CommunicationsJson) } : {};
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

function normalizeAddress(channel: string, value: unknown) {
  return channel === "sms" ? normalizePhone(value) : normalizeEmail(value);
}

function providerForChannel(channel: string) {
  if (channel === "sms") return "telnyx";
  return env.emailDeliveryMode === "capture" ? "firstmate_mail_mock" : "ses";
}

function consentAllowsPurpose(consent: CommunicationsJson, purpose: string) {
  const rawPurposes = asObject(consent.evidence).purposes;
  return smsConsentPurposesAllow(rawPurposes, purpose);
}

function publicSender(identity: CommunicationsJson) {
  return {
    identity_id: identity.id,
    address: identity.address,
    name: identity.display_name,
    reply_to: identity.reply_to
  };
}

function publicDelivery(delivery: CommunicationsJson) {
  return {
    id: delivery.id,
    message_id: delivery.message_id,
    channel: delivery.channel,
    recipient: delivery.recipient,
    status: delivery.status,
    attempts: delivery.attempts,
    queued_at: delivery.queued_at,
    sent_at: delivery.sent_at,
    delivered_at: delivery.delivered_at,
    failed_at: delivery.failed_at,
    created_at: delivery.created_at,
    updated_at: delivery.updated_at
  };
}

function publicMetadata(value: unknown) {
  const metadata = asObject(value);
  delete metadata.transport_mode;
  delete metadata.capture;
  delete metadata.captured;
  delete metadata.request_hash;
  return metadata;
}

function publicMessage(message: CommunicationsJson, deliveries: CommunicationsJson[] = []) {
  return {
    id: message.id,
    organization_id: message.organization_id,
    branch_id: message.branch_id,
    conversation_id: message.conversation_id,
    direction: message.direction,
    channel: message.channel,
    purpose: message.purpose,
    status: message.status,
    content: {
      subject: message.subject,
      text: message.text_body,
      html: message.html_body
    },
    sender: message.sender,
    recipients: message.recipients,
    context: message.context,
    source: message.source,
    tags: message.tags,
    metadata: publicMetadata(message.metadata),
    idempotency_key: message.idempotency_key,
    scheduled_for: message.scheduled_for,
    queued_at: message.queued_at,
    sent_at: message.sent_at,
    delivered_at: message.delivered_at,
    failed_at: message.failed_at,
    created_at: message.created_at,
    updated_at: message.updated_at,
    deliveries: deliveries.map(publicDelivery)
  };
}

function developerMessage(message: CommunicationsJson, deliveries: CommunicationsJson[], events: CommunicationsJson[]) {
  return {
    ...publicMessage(message, deliveries),
    developer: {
      captured: deliveries.some((delivery) => delivery.transport_mode === "capture") || asObject(message.metadata).transport_mode === "capture",
      deliveries,
      events
    }
  };
}

async function smsDefaultAddress(organizationId: string) {
  const messagingOrganization = await ensureMessagingOrganization(organizationId);
  const profiles = await listSmsComplianceProfiles(messagingOrganization.id);
  const preferred = profiles.find((profile) => profile.id === messagingOrganization.default_sms_compliance_profile_id) || profiles[0];
  const campaign = asObject(preferred?.campaign);
  const refs = asObject(preferred?.provider_refs);
  const selectedNumber = normalizePhone(campaign.selectedNumber);
  const owner = selectedNumber ? (await findPhoneNumberOwner(selectedNumber)) : null;
  const ownsNumber = owner && cleanText(owner.organization_id) === organizationId
    && cleanText(owner.compliance_profile_id) === cleanText(preferred?.id)
    && cleanText(owner.messaging_profile_id) === cleanText(refs.telnyx_messaging_profile_id)
    && cleanText(owner.status) === "active";
  const liveReady = cleanText(preferred?.campaign_status).toLowerCase() === "mno_provisioned"
    && cleanText(preferred?.status).toLowerCase() === "active"
    && smsAutoresponsesReady(preferred)
    && ["verified", "vetted_verified", "ok", "approved"].includes(cleanText(preferred?.brand_status).toLowerCase())
    && ["success", "active", "purchased"].includes(cleanText(preferred?.phone_number_status).toLowerCase())
    && cleanText(preferred?.phone_number_campaign_status).toLowerCase() === "assigned"
    && Boolean(cleanText(refs.telnyx_campaign_id))
    && cleanText(preferred?.phone_number_campaign_id) === cleanText(refs.telnyx_campaign_id)
    && Boolean(normalizePhone(campaign.selectedNumber))
    && Boolean(cleanText(refs.telnyx_messaging_profile_id))
    && Boolean(ownsNumber)
    && Boolean(env.telnyxWebhookPublicKey);
  const capture = env.communicationsDeliveryMode !== "live";
  return {
    address: normalizePhone(campaign.selectedNumber) || (capture ? CAPTURE_SMS_NUMBER : ""),
    profileId: cleanText(refs.telnyx_messaging_profile_id || (capture ? env.telnyxMessagingProfileId : "")),
    complianceProfileId: cleanText(preferred?.id),
    registrationStatus: cleanText(preferred?.status || (capture ? "capture_ready" : "not_configured")),
    active: capture || liveReady
  };
}

export async function ensureDefaultSenderIdentities(organizationId: string, branchId = "default") {
  const existing = (await listSenderIdentities(organizationId, branchId));
  const sms = await smsDefaultAddress(organizationId);
  const branchSuffix = branchId === "default" ? "" : `_${createHash("sha256").update(branchId).digest("hex").slice(0, 10)}`;
  const smsIdentityId = `default_sms${branchSuffix}`;
  const currentSms = existing.find((identity) => identity.id === smsIdentityId);
  if (!currentSms || asObject(currentSms.metadata).managed_by === "telnyx_setup") {
    (await upsertSenderIdentity({
      id: smsIdentityId,
      organization_id: organizationId,
      branch_id: branchId,
      channel: "sms",
      provider: "telnyx",
      address: sms.address,
      provider_profile_id: sms.profileId,
      status: sms.active ? "active" : "inactive",
      is_default: true,
      capabilities: { sms: true, mms: false },
      metadata: { managed_by: "telnyx_setup", compliance_profile_id: sms.complianceProfileId, registration_status: sms.registrationStatus }
    }));
  }
  const managedEmail = existing.find((identity) => {
    if (identity.channel !== "email" || identity.status !== "active") return false;
    const managedBy = cleanText(asObject(identity.metadata).managed_by);
    return managedBy === "firstmate_mail" || managedBy === "firstmate_domain";
  });
  if (!managedEmail) {
    // Dynamic import avoids a module cycle: the mail engine sends through this
    // service, while this fallback ensures generic communication paths also
    // receive the collision-safe FirstMate Mail identity.
    const { ensureOrgEmailInbox } = await import("../email/engine.js");
    await ensureOrgEmailInbox(organizationId, branchId);
  }
  return (await listSenderIdentities(organizationId, branchId));
}

async function resolveSender(organizationId: string, branchId: string, channel: string, requested: CommunicationsJson) {
  const identities = await ensureDefaultSenderIdentities(organizationId, branchId);
  const requestedId = cleanText(requested.identity_id);
  const identity = identities.find((item) => requestedId && item.id === requestedId)
    || identities.find((item) => item.channel === channel && item.is_default === true)
    || identities.find((item) => item.channel === channel);
  if (!identity) throw badRequest("sender_identity_missing", `No ${channel} sender is configured for this organization.`);
  if (cleanText(identity.status) !== "active") throw badRequest("sender_identity_inactive", "The selected communications sender is not active.");
  const explicitAddress = normalizeAddress(channel, requested.address);
  if (explicitAddress && explicitAddress !== cleanText(identity.address)) {
    throw badRequest("sender_address_not_configured", "Select a configured organization sender identity instead of supplying a different address.");
  }
  return {
    ...publicSender(identity),
    ...(explicitAddress ? { address: explicitAddress } : {}),
    ...(cleanText(requested.name) ? { name: cleanText(requested.name) } : {}),
    ...(channel === "email" && normalizeEmail(requested.reply_to) ? { reply_to: normalizeEmail(requested.reply_to) } : {})
  };
}

function normalizeRecipients(channel: string, recipients: Array<Record<string, unknown>>): CommunicationsJson[] {
  const normalized = recipients.map((recipient) => {
    const address = normalizeAddress(channel, recipient.address);
    if (!address) throw badRequest("invalid_recipient", `Enter a valid ${channel === "sms" ? "phone number" : "email address"}.`, { recipient });
    return {
      ...recipient,
      address,
      type: channel === "email" ? cleanText(recipient.type || "to") || "to" : "to"
    };
  });
  const addresses = normalized.map((recipient) => cleanText(recipient.address));
  if (new Set(addresses).size !== addresses.length) {
    throw badRequest("duplicate_recipient", "A recipient can only appear once in a communication request.");
  }
  return normalized;
}

async function hydrateMessage(organizationId: string, message: CommunicationsJson, developer = false) {
  const deliveries = (await listDeliveryRecords(organizationId, cleanText(message.id)));
  return developer
    ? developerMessage(message, deliveries, (await listCommunicationEvents(organizationId, cleanText(message.id))))
    : publicMessage(message, deliveries);
}

export async function publishWorkCommunicationEvent(type: string, message: CommunicationsJson, payload: CommunicationsJson = {}) {
  const context = asObject(message.context);
  let projectId = cleanText(context.project_id || message.project_id);
  const planId = cleanText(context.work_plan_id);
  const nodeId = cleanText(context.work_node_id);
  if (!projectId) {
    // Inbound customer messages usually arrive with no work context. The
    // conversation row carries a project id when one is known — a cheap,
    // indexed lookup. When even that yields nothing, the event is still
    // emitted org-scoped so automations and activity feeds observe it.
    const conversationId = cleanText(message.conversation_id);
    if (conversationId) {
      try {
        const conversation = (await readConversationRecord(cleanText(message.organization_id), conversationId));
        projectId = cleanText(conversation.project_id || asObject(conversation.context).project_id);
      } catch {
        // Emit org-scoped below.
      }
    }
  }
  const { emitWorkEvent } = await import("../work/engine.js");
  await emitWorkEvent({
    organization_id: message.organization_id,
    branch_id: message.branch_id,
    ...(projectId ? { project_id: projectId } : {}),
    plan_id: planId,
    node_id: nodeId,
    type,
    idempotency_key: `${type}:${cleanText(message.id)}:${cleanText(payload.status || "created")}`,
    payload: {
      message_id: message.id,
      conversation_id: message.conversation_id,
      channel: message.channel,
      direction: message.direction,
      status: message.status,
      contact_id: context.contact_id,
      sender_address: cleanText(asObject(message.sender).address),
      work_plan_id: planId,
      work_node_id: nodeId,
      ...payload
    },
    context: { source: "communications" }
  });
}

export async function createConversation(organizationId: string, input: CreateConversationInput, ctx?: Partial<PlatformAuthContext>) {
  return (await createConversationRecord({
    ...input,
    organization_id: organizationId,
    branch_id: cleanText(input.branch_id || ctx?.branchId || "default") || "default",
    created_by_user_id: cleanText(ctx?.userId)
  }));
}

export async function listConversations(organizationId: string, options: CommunicationsJson = {}) {
  return (await listConversationRecords(organizationId, options));
}

export async function conversationDetail(organizationId: string, conversationId: string) {
  const conversation = (await readConversationRecord(organizationId, conversationId));
  const messages = (await Promise.all((await listMessageRecords(organizationId, { conversation_id: conversationId, limit: 500 }))
    .reverse()
    .map(async (message) => (await hydrateMessage(organizationId, message)))));
  return { ...conversation, messages };
}

export async function sendCommunication(organizationId: string, input: SendCommunicationInput, ctx?: Partial<PlatformAuthContext>) {
  const branchId = cleanText(ctx?.branchId || input.branch_id || "default") || "default";
  const recipients = normalizeRecipients(input.channel, input.recipients as Array<Record<string, unknown>>);
  const sender = await resolveSender(organizationId, branchId, input.channel, asObject(input.sender));
  const context = asObject(input.context);
  if (input.conversation_id) (await readConversationRecord(organizationId, input.conversation_id));
  const now = new Date().toISOString();
  const requestedSource = asObject(input.source);
  const source = {
    ...requestedSource,
    type: ctx?.userId ? "user" : cleanText(requestedSource.type || "system"),
    user_id: cleanText(ctx?.userId || requestedSource.user_id)
  };
  const requestHash = createHash("sha256").update(JSON.stringify({
    branchId, channel: input.channel, purpose: input.purpose || "customer_care", recipients,
    content: input.content, sender, context, source, tags: input.tags || [], scheduled_for: input.scheduled_for || ""
  })).digest("hex");
  const liveSms = input.channel === "sms" && env.communicationsDeliveryMode === "live";
  const deliverEmail = input.channel === "email" && env.emailDeliveryMode !== "capture";
  const emailTenant = deliverEmail ? await requireActiveEmailTenant(organizationId) : null;
  if (liveSms) {
    const messagingOrganization = await ensureMessagingOrganization(organizationId);
    const profiles = await listSmsComplianceProfiles(messagingOrganization.id);
    const activeProfile = profiles.find((profile) => profile.id === messagingOrganization.default_sms_compliance_profile_id) || profiles[0];
    const issue = outboundSmsComplianceIssue(activeProfile, input.purpose || "customer_care", input.content.text);
    if (issue) throw badRequest(issue.code, issue.message);
  }
  if (liveSms && env.smsRequireConsent) {
    for (const recipient of recipients) {
      const consent = (await readSmsConsent(organizationId, cleanText(recipient.address)));
      const consentId = cleanText(recipient.consent_id);
      if (!consent || cleanText(consent.status) !== "opted_in" || (consentId && cleanText(consent.consent_id) !== consentId) || !consentAllowsPurpose(consent, input.purpose || "customer_care")) {
        throw badRequest("sms_consent_required", "Active organization-scoped SMS consent is required before sending.", { recipient: recipient.address });
      }
    }
  }
  let createdResult: Awaited<ReturnType<typeof createMessageRecord>> | null = null;

  (await withCommunicationsTransaction(async () => {
    if (liveSms) {
      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      if ((await countSmsDeliveriesSince(organizationId, since)) + recipients.length > env.smsOrganizationDailyLimit) {
        throw new PlatformError("sms_organization_rate_limit", 429, "This organization has reached its rolling 24-hour SMS safety limit.");
      }
      const recipientLimit = input.purpose === "marketing" ? env.smsMarketingRecipientDailyLimit : env.smsRecipientDailyLimit;
      for (const recipient of recipients) {
        if ((await countSmsDeliveriesSince(organizationId, since, cleanText(recipient.address))) >= recipientLimit) {
          throw new PlatformError("sms_recipient_rate_limit", 429, "This recipient has reached the rolling 24-hour SMS safety limit.", { recipient: recipient.address });
        }
      }
    }
    if (deliverEmail) {
      const hour = new Date(Date.now() - 60 * 60_000).toISOString();
      const day = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      if ((await countEmailDeliveriesSince(organizationId, hour)) + recipients.length > env.emailOrganizationHourlyLimit) {
        throw new PlatformError("email_organization_hourly_limit", 429, "This organization has reached its rolling hourly email safety limit.");
      }
      if ((await countEmailDeliveriesSince(organizationId, day)) + recipients.length > env.emailOrganizationDailyLimit) {
        throw new PlatformError("email_organization_daily_limit", 429, "This organization has reached its rolling 24-hour email safety limit.");
      }
    }
    const requestedMetadata = asObject(input.metadata);
    const requestedEmailMetadata = asObject(requestedMetadata.email);
    const attachmentSummaries = input.channel === "email"
      ? (input.content.attachments || []).map((attachment) => ({ name: attachment.name, content_type: attachment.content_type }))
      : [];
    createdResult = (await createMessageRecord({
      id: input.id,
      organization_id: organizationId,
      branch_id: branchId,
      conversation_id: input.conversation_id,
      direction: "outbound",
      channel: input.channel,
      purpose: input.purpose || "customer_care",
      subject: input.content.subject,
      text_body: input.content.text,
      html_body: input.content.html,
      sender,
      recipients,
      context,
      source,
      tags: input.tags || [],
      metadata: {
        ...requestedMetadata,
        request_hash: requestHash,
        ...((deliverEmail || attachmentSummaries.length) ? {
          email: {
            ...requestedEmailMetadata,
            ...(deliverEmail ? { tenant_id: cleanText(emailTenant?.tenant_name) } : {}),
            ...(attachmentSummaries.length ? { attachments: attachmentSummaries } : {})
          }
        } : {})
      },
      idempotency_key: input.idempotency_key,
      scheduled_for: input.scheduled_for,
      created_by_user_id: cleanText(ctx?.userId)
    }));
    if (!createdResult.created) return;
    const message = createdResult.message;
    const scheduled = message.status === "scheduled";
    (await createCommunicationEvent({
      organization_id: organizationId,
      message_id: message.id,
      type: scheduled ? "message.scheduled" : "message.queued",
      payload: scheduled ? { scheduled_for: message.scheduled_for } : { channel: input.channel, recipient_count: recipients.length }
    }));
    for (const recipient of recipients) {
      const provider = providerForChannel(input.channel);
      const capture = !(liveSms || deliverEmail);
      const delivery = (await createDeliveryRecord({
        organization_id: organizationId,
        message_id: message.id,
        channel: input.channel,
        recipient_address: recipient.address,
        recipient,
        provider,
        transport_mode: capture ? "capture" : input.channel === "email" ? env.emailDeliveryMode : "live",
        provider_message_id: capture && !scheduled ? `${provider}_capture_${randomUUID().replace(/-/g, "")}` : "",
        status: scheduled ? "scheduled" : capture ? "sent" : "queued",
        attempts: capture && !scheduled ? 1 : 0,
        response: capture && !scheduled ? { accepted: true, captured_at: now } : {},
        sent_at: capture && !scheduled ? now : "",
        next_attempt_at: liveSms || deliverEmail ? now : ""
      }));
      if (capture && !scheduled) {
        (await createCommunicationEvent({
          organization_id: organizationId, message_id: message.id, delivery_id: delivery.id,
          type: "provider.accepted", provider, payload: { status: "accepted" }, occurred_at: now
        }));
      }
    }
    if (!scheduled && !liveSms && !deliverEmail) {
      (await updateMessageRecord(organizationId, cleanText(message.id), {
        status: "sent", sent_at: now, metadata: { ...asObject(message.metadata), transport_mode: "capture" }
      }));
    }
    (await touchConversationForMessage(organizationId, cleanText(message.conversation_id), now));
  }));

  const created = createdResult!;
  if (!created.created) {
    if (cleanText(asObject(created.message.metadata).request_hash) !== requestHash) {
      throw conflict("idempotency_conflict", "This idempotency key was already used for a different communication request.");
    }
    return { message: (await hydrateMessage(organizationId, created.message)), created: false, idempotent_replay: true };
  }
  if (liveSms) scheduleSmsDeliveryQueue(Math.min(recipients.length, 25));
  if (deliverEmail && cleanText(created.message.status) !== "scheduled") {
    const message = (await readMessageRecord(organizationId, cleanText(created.message.id)));
    const messageSender = asObject(message.sender);
    const messageMetadata = asObject(message.metadata);
    const emailMetadata = asObject(messageMetadata.email);
    const completedAt = new Date().toISOString();
    const outcomes: Array<{ delivery: CommunicationsJson; result: Awaited<ReturnType<ReturnType<typeof activeEmailProvider>["send"]>> }> = [];
    for (const delivery of (await listDeliveryRecords(organizationId, cleanText(message.id)))) {
      const recipient = asObject(delivery.recipient);
      const result = await activeEmailProvider().send({
        organization_id: organizationId,
        branch_id: branchId,
        message_id: cleanText(message.id),
        rfc_message_id: cleanText(emailMetadata.message_id) || `<${cleanText(message.id)}@${env.firstmateMailDomain}>`,
        in_reply_to: cleanText(emailMetadata.in_reply_to) || undefined,
        references: Array.isArray(emailMetadata.references) ? emailMetadata.references.map(cleanText).filter(Boolean) : undefined,
        from: {
          address: cleanText(messageSender.address),
          name: cleanText(messageSender.name) || undefined,
          reply_to: normalizeEmail(messageSender.reply_to) || undefined
        },
        to: [{ address: cleanText(delivery.recipient_address), name: cleanText(recipient.name) || undefined, type: "to" }],
        subject: cleanText(message.subject),
        text: cleanText(message.text_body) || undefined,
        html: cleanText(message.html_body) || undefined,
        attachments: input.content.attachments,
        tenant_id: cleanText(emailMetadata.tenant_id)
      });
      outcomes.push({ delivery, result });
    }
    const accepted = outcomes.filter((outcome) => outcome.result.accepted).length;
    const status = accepted === outcomes.length ? "sent" : accepted > 0 ? "sent" : "failed";
    (await withCommunicationsTransaction(async () => {
      for (const { delivery, result } of outcomes) {
        const deliveryStatus = result.accepted ? "sent" : "failed";
        (await updateDeliveryRecord(organizationId, cleanText(delivery.id), {
          status: deliveryStatus,
          attempts: Number(delivery.attempts || 0) + 1,
          provider_message_id: result.provider_message_id,
          response: {
            accepted: result.accepted,
            recipient_rewritten: result.recipient_rewritten === true
          },
          ...(result.accepted ? { sent_at: completedAt } : {
            failed_at: completedAt,
            error: { reason: result.error || "cloudflare_email_send_failed" }
          })
        }));
        (await createCommunicationEvent({
          organization_id: organizationId,
          message_id: cleanText(message.id),
          delivery_id: cleanText(delivery.id),
          type: result.accepted ? "provider.accepted" : "provider.failed",
          provider: result.provider,
          payload: {
            status: deliveryStatus,
            recipient_rewritten: result.recipient_rewritten === true,
            ...(result.error ? { error: result.error } : {})
          },
          occurred_at: completedAt
        }));
      }
      (await updateMessageRecord(organizationId, cleanText(message.id), {
        status,
        ...(accepted ? { sent_at: completedAt } : { failed_at: completedAt }),
        metadata: {
          ...messageMetadata,
          transport_mode: env.emailDeliveryMode,
          accepted_recipient_count: accepted,
          failed_recipient_count: outcomes.length - accepted
        }
      }));
    }));
  }
  const current = (await readMessageRecord(organizationId, cleanText(created.message.id)));
  await publishWorkCommunicationEvent(
    current.status === "scheduled" ? "communication.scheduled" : current.status === "sent" ? "communication.sent" : "communication.queued",
    current,
    { status: current.status }
  );
  return { message: (await hydrateMessage(organizationId, current)), created: true, idempotent_replay: false };
}

export async function listMessages(organizationId: string, options: CommunicationsJson = {}, developer = false) {
  return (await Promise.all((await listMessageRecords(organizationId, options)).map(async (message) => (await hydrateMessage(organizationId, message, developer)))));
}

export async function messageDetail(organizationId: string, messageId: string, developer = false) {
  return (await hydrateMessage(organizationId, (await readMessageRecord(organizationId, messageId)), developer));
}

export async function simulateMessageStatus(organizationId: string, messageId: string, input: CommunicationsJson) {
  const message = (await readMessageRecord(organizationId, messageId));
  const deliveries = (await listDeliveryRecords(organizationId, messageId));
  const selected = cleanText(input.delivery_id)
    ? deliveries.filter((delivery) => delivery.id === cleanText(input.delivery_id))
    : deliveries;
  if (!selected.length) throw badRequest("delivery_not_found", "No matching delivery exists for this message.");
  const status = cleanText(input.status);
  const now = new Date().toISOString();
  (await withCommunicationsTransaction(async () => {
    for (const delivery of selected) {
      (await updateDeliveryRecord(organizationId, cleanText(delivery.id), {
        status,
        ...(status === "sent" ? { sent_at: now } : {}),
        ...(status === "delivered" || status === "opened" || status === "clicked" ? { delivered_at: cleanText(delivery.delivered_at) || now } : {}),
        ...(status === "failed" || status === "bounced" ? { failed_at: now, error: { reason: cleanText(input.reason || status) } } : {}),
        response: { ...asObject(delivery.response), simulation: asObject(input.metadata) }
      }));
      (await createCommunicationEvent({
        organization_id: organizationId,
        message_id: messageId,
        delivery_id: delivery.id,
        type: `delivery.${status}`,
        provider: delivery.provider,
        payload: { reason: cleanText(input.reason), ...asObject(input.metadata) },
        occurred_at: now
      }));
    }
    (await updateMessageRecord(organizationId, messageId, {
      status,
      ...(status === "sent" ? { sent_at: now } : {}),
      ...(status === "delivered" || status === "opened" || status === "clicked" ? { delivered_at: cleanText(message.delivered_at) || now } : {}),
      ...(status === "failed" || status === "bounced" ? { failed_at: now } : {})
    }));
  }));
  const updated = (await readMessageRecord(organizationId, messageId));
  await publishWorkCommunicationEvent(
    status === "sent" ? "communication.sent" : "communication.delivery_updated",
    updated,
    { status, reason: cleanText(input.reason) }
  );
  return (await messageDetail(organizationId, messageId, true));
}

export async function simulateInboundCommunication(organizationId: string, input: CommunicationsJson, ctx?: Partial<PlatformAuthContext>) {
  const channel = cleanText(input.channel);
  const from = asObject(input.from);
  const to = asObject(input.to);
  const fromAddress = normalizeAddress(channel, from.address);
  const toAddress = normalizeAddress(channel, to.address);
  if (!fromAddress || !toAddress) throw badRequest("invalid_inbound_address", "Inbound sender and recipient addresses must be valid.");
  if (cleanText(input.conversation_id)) (await readConversationRecord(organizationId, cleanText(input.conversation_id)));
  const content = asObject(input.content);
  const created = (await createMessageRecord({
    organization_id: organizationId,
    branch_id: cleanText(ctx?.branchId || "default") || "default",
    conversation_id: cleanText(input.conversation_id),
    direction: "inbound",
    channel,
    purpose: "customer_care",
    status: "delivered",
    subject: content.subject,
    text_body: content.text,
    html_body: content.html,
    sender: { ...from, address: fromAddress },
    recipients: [{ ...to, address: toAddress }],
    context: asObject(input.context),
    source: { type: "webhook", id: "developer_simulation" },
    metadata: { ...asObject(input.metadata), transport_mode: "capture" },
    created_by_user_id: cleanText(ctx?.userId)
  }));
  const now = new Date().toISOString();
  (await createCommunicationEvent({ organization_id: organizationId, message_id: created.message.id, type: "message.received", provider: providerForChannel(channel), occurred_at: now, payload: { simulated: true } }));
  (await updateMessageRecord(organizationId, cleanText(created.message.id), { status: "delivered", delivered_at: now }));
  (await touchConversationForMessage(organizationId, cleanText(created.message.conversation_id), now));
  const received = (await readMessageRecord(organizationId, cleanText(created.message.id)));
  await publishWorkCommunicationEvent("communication.received", received, { status: "delivered" });
  // Route through the same notification/auto-response hook as real inbound.
  try {
    const { onInboundCommunication } = await import("../comms/notifications.js");
    await onInboundCommunication(organizationId, cleanText(created.message.id));
  } catch (error) {
    console.error("comms inbound hook failed", error);
  }
  return (await messageDetail(organizationId, cleanText(created.message.id), true));
}

export async function communicationCapabilities(organizationId: string, branchId = "default") {
  const identities = await ensureDefaultSenderIdentities(organizationId, branchId);
  return {
    channels: {
      sms: {
        available: identities.some((identity) => identity.channel === "sms" && identity.status === "active"),
        senders: identities.filter((identity) => identity.channel === "sms").map(publicSender),
        supports: ["outbound", "inbound", "delivery_status", "scheduled"]
      },
      email: {
        available: identities.some((identity) => identity.channel === "email" && identity.status === "active"),
        senders: identities.filter((identity) => identity.channel === "email").map(publicSender),
        supports: ["outbound", "inbound", "delivery_status", "html", "scheduled"]
      }
    },
    limits: {
      recipients_per_message: 100,
      sms_text_characters: 1600,
      email_subject_characters: 998
    }
  };
}
