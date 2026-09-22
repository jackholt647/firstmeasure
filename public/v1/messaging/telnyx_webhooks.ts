import { createPublicKey, randomUUID, verify } from "node:crypto";

import { env } from "../src/config/env.js";
import {
  createCommunicationEvent,
  createConversationRecord,
  createMessageRecord,
  createUsageEvent,
  createWebhookInboxEvent,
  claimWebhookInboxEvent,
  claimPhoneNumberOwnership,
  findDeliveryById,
  findDeliveryByProviderMessageId,
  findBillingCommitment,
  findPhoneNumberOwner,
  findSenderIdentityByAddress,
  findSmsConversationRecord,
  listWebhookInboxEventsForObject,
  listPendingWebhookInboxEvents,
  markWebhookInboxEventProcessed,
  markProviderOperationFailed,
  readMessageRecord,
  suspendOrganizationSmsDeliveries,
  suppressPendingSmsDeliveries,
  touchConversationForMessage,
  updateDeliveryRecord,
  updateMessageRecord,
  upsertSmsConsent,
  type CommunicationsJson
} from "./communications_storage.js";
import { publishWorkCommunicationEvent } from "./communications_service.js";
import { refreshParentMessageStatus, scheduleSmsDeliveryQueue } from "./delivery_worker.js";
import {
  ensureMessagingOrganization,
  findSmsComplianceProfileByProviderReference,
  mutateSmsComplianceProfileAtomically,
  readSmsComplianceProfile,
  setDefaultSmsComplianceProfile,
  type SmsComplianceProfile
} from "./storage.js";
import { smsAutoresponsesReady } from "./autoresponses.js";

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);
const webhookProcessorId = `telnyx_webhook_${process.pid}_${randomUUID().slice(0, 8)}`;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): CommunicationsJson {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as CommunicationsJson) } : {};
}

function providerTimestampNanoseconds(value: unknown) {
  const timestamp = cleanText(value);
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i);
  if (match) {
    const wholeSecondMs = Date.parse(`${match[1]}${match[3]}`);
    if (Number.isFinite(wholeSecondMs)) {
      const fractionalNanoseconds = BigInt((match[2] || "").padEnd(9, "0") || "0");
      return (BigInt(wholeSecondMs) * 1_000_000n) + fractionalNanoseconds;
    }
  }
  return null;
}

function phone(value: unknown) {
  return cleanText(asObject(value).phone_number || value);
}

function publicKeyObject(value: string) {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) return createPublicKey(trimmed);
  const raw = /^[a-f0-9]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (raw.length !== 32) throw new Error("The Telnyx webhook public key must be a PEM, 32-byte base64, or 64-character hex Ed25519 key.");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

export function isTelnyxWebhookPublicKeyValid(value = env.telnyxWebhookPublicKey) {
  try {
    publicKeyObject(value);
    return true;
  } catch {
    return false;
  }
}

export function verifyTelnyxWebhook(rawBody: Buffer, signatureValue: unknown, timestampValue: unknown, nowMs = Date.now()) {
  if (!env.telnyxWebhookPublicKey) return { ok: false, reason: "webhook_public_key_missing" };
  const signature = cleanText(signatureValue);
  const timestamp = cleanText(timestampValue);
  if (!signature || !/^\d+$/.test(timestamp)) return { ok: false, reason: "webhook_signature_missing" };
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > env.telnyxWebhookToleranceSeconds * 1000) {
    return { ok: false, reason: "webhook_timestamp_invalid" };
  }
  try {
    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}|`, "utf8"), rawBody]);
    const valid = verify(null, signedPayload, publicKeyObject(env.telnyxWebhookPublicKey), Buffer.from(signature, "base64"));
    return valid ? { ok: true } : { ok: false, reason: "webhook_signature_invalid" };
  } catch {
    return { ok: false, reason: "webhook_signature_invalid" };
  }
}

function webhookEnvelope(body: unknown) {
  const root = asObject(body);
  const data = asObject(root.data);
  return {
    eventId: cleanText(data.id),
    eventType: cleanText(data.event_type),
    occurredAt: cleanText(data.occurred_at),
    payload: asObject(data.payload),
    correlatedDeliveryId: cleanText(root._firstmate_delivery_id)
  };
}

function inboundKeyword(payload: CommunicationsJson) {
  const autoresponse = cleanText(payload.autoresponse_type).toUpperCase().replace(/_/g, " ");
  if (autoresponse.includes("STOP")) return "STOP";
  if (autoresponse.includes("START")) return "START";
  if (autoresponse.includes("HELP") || autoresponse.includes("INFO")) return "HELP";
  return cleanText(payload.text).toUpperCase().replace(/\s+/g, " ");
}

async function recordUsage(
  organizationId: string,
  messageId: string,
  deliveryId: string,
  eventId: string,
  payload: CommunicationsJson,
  metadata: CommunicationsJson = {}
) {
  const cost = asObject(payload.cost);
  const amount = cleanText(cost.amount);
  if (!amount && !payload.parts) return;
  (await createUsageEvent({
    organization_id: organizationId,
    message_id: messageId,
    delivery_id: deliveryId,
    provider: "telnyx",
    provider_message_id: cleanText(payload.id),
    direction: cleanText(payload.direction || "outbound"),
    segments: Number(payload.parts || 0),
    amount: amount || "0",
    currency: cleanText(cost.currency || "USD"),
    event_key: `telnyx:message:${cleanText(payload.id) || eventId}:${cleanText(payload.direction || "outbound")}:final_cost`,
    occurred_at: cleanText(payload.completed_at || payload.received_at || new Date().toISOString()),
    metadata: { cost_breakdown: payload.cost_breakdown, type: payload.type, encoding: payload.encoding, ...metadata }
  }));
}

async function processInbound(eventId: string, occurredAt: string, payload: CommunicationsJson) {
  occurredAt = cleanText(occurredAt) || new Date().toISOString();
  const fromAddress = phone(payload.from);
  const toValues = Array.isArray(payload.to) ? payload.to.map(asObject) : [asObject(payload.to)];
  const toAddress = phone(toValues[0]);
  const messagingProfileId = cleanText(payload.messaging_profile_id);
  const owner = (await findPhoneNumberOwner(toAddress));
  if (!owner || (messagingProfileId && cleanText(owner.messaging_profile_id) !== messagingProfileId)) {
    throw new Error(`No matching organization ownership record exists for inbound number ${toAddress}.`);
  }
  const identity = (await findSenderIdentityByAddress(toAddress, messagingProfileId)) || (await findSenderIdentityByAddress(toAddress));
  const organizationId = cleanText(owner.organization_id);
  const branchId = cleanText(identity?.branch_id || "default");
  let conversation = (await findSmsConversationRecord(organizationId, fromAddress));
  // Attach the sender to a project/contact when their number is on file, so
  // the message lands in the project comms tab and routes notifications.
  let matchedProjectId = cleanText(conversation?.project_id);
  let matchedContactId = cleanText(conversation?.contact_id);
  if (!matchedProjectId || !matchedContactId) {
    try {
      const { matchProjectContact } = await import("../comms/matching.js");
      const match = await matchProjectContact(organizationId, { phone: fromAddress });
      if (match) {
        matchedProjectId = matchedProjectId || match.project_id;
        matchedContactId = matchedContactId || match.contact_id;
      }
    } catch {
      // Matching is best-effort; the message still lands org-scoped.
    }
  }
  if (!conversation) {
    conversation = (await createConversationRecord({
      organization_id: organizationId,
      branch_id: branchId,
      channel_strategy: "sms",
      participants: [{ address: fromAddress, ...(matchedContactId ? { contact_id: matchedContactId } : {}) }],
      subject: `SMS conversation with ${fromAddress}`,
      context: {
        ...(matchedProjectId ? { project_id: matchedProjectId } : {}),
        ...(matchedContactId ? { contact_id: matchedContactId } : {})
      },
      metadata: { created_from: "telnyx_webhook" }
    }));
  }

  const keyword = inboundKeyword(payload);
  if (STOP_KEYWORDS.has(keyword)) {
    (await upsertSmsConsent({ organization_id: organizationId, phone_number: fromAddress, status: "opted_out", source: "inbound_stop", occurred_at: occurredAt, evidence: { provider_event_id: eventId, keyword } }));
    for (const delivery of (await suppressPendingSmsDeliveries(organizationId, fromAddress, occurredAt))) {
      (await createCommunicationEvent({
        organization_id: organizationId, message_id: delivery.message_id, delivery_id: delivery.id,
        type: "delivery.suppressed", provider: "telnyx", occurred_at: occurredAt,
        payload: { reason: "recipient_opted_out", provider_event_id: eventId }
      }));
      (await refreshParentMessageStatus(organizationId, cleanText(delivery.message_id)));
    }
  } else if (START_KEYWORDS.has(keyword)) {
    (await upsertSmsConsent({ organization_id: organizationId, phone_number: fromAddress, status: "opted_in", source: "inbound_start", consent_id: `telnyx_${eventId}`, occurred_at: occurredAt, evidence: { provider_event_id: eventId, keyword, purposes: ["customer_care"] } }));
  }

  const created = (await createMessageRecord({
    id: `telnyx_${eventId}`,
    organization_id: organizationId,
    branch_id: branchId,
    conversation_id: conversation.id,
    direction: "inbound",
    channel: "sms",
    purpose: "customer_care",
    status: "delivered",
    text_body: cleanText(payload.text),
    sender: { address: fromAddress, ...(matchedContactId ? { contact_id: matchedContactId } : {}) },
    recipients: [{ address: toAddress }],
    context: {
      ...(matchedProjectId ? { project_id: matchedProjectId } : {}),
      ...(matchedContactId ? { contact_id: matchedContactId } : {})
    },
    source: { type: "webhook", id: eventId },
    metadata: { provider: "telnyx", provider_message_id: cleanText(payload.id), media: payload.media, keyword: HELP_KEYWORDS.has(keyword) ? "HELP" : STOP_KEYWORDS.has(keyword) ? "STOP" : START_KEYWORDS.has(keyword) ? "START" : "" }
  }));
  const messageId = cleanText(created.message.id);
  if (created.created) {
    (await createCommunicationEvent({ organization_id: organizationId, message_id: messageId, type: "message.received", provider: "telnyx", occurred_at: occurredAt, payload: { provider_event_id: eventId, provider_message_id: payload.id } }));
    (await updateMessageRecord(organizationId, messageId, { status: "delivered", delivered_at: occurredAt }));
    (await touchConversationForMessage(organizationId, cleanText(conversation.id), occurredAt));
    await publishWorkCommunicationEvent("communication.received", (await readMessageRecord(organizationId, messageId)), { status: "delivered" });
    // Comms notification routing + optional AI auto-response (best-effort).
    try {
      const { onInboundCommunication } = await import("../comms/notifications.js");
      await onInboundCommunication(organizationId, messageId);
    } catch (error) {
      console.error("comms inbound hook failed", error);
    }
  }
  (await recordUsage(organizationId, messageId, "", eventId, payload));
}

function normalizedDeliveryStatus(eventType: string, payload: CommunicationsJson) {
  const toValues = Array.isArray(payload.to) ? payload.to.map(asObject) : [];
  const raw = cleanText(toValues[0]?.status || payload.status).toLowerCase();
  if (eventType === "message.sent") return "sent";
  if (raw === "delivered") return "delivered";
  if (["delivery_failed", "sending_failed", "failed", "expired"].includes(raw)) return "failed";
  if (raw === "delivery_unconfirmed") return "delivery_unconfirmed";
  return raw || "sent";
}

async function processOutbound(eventId: string, eventType: string, occurredAt: string, payload: CommunicationsJson, correlatedDeliveryId = "") {
  occurredAt = cleanText(occurredAt) || new Date().toISOString();
  const providerMessageId = cleanText(payload.id);
  let delivery = (await findDeliveryByProviderMessageId("telnyx", providerMessageId));
  if (!delivery) {
    const candidate = (await findDeliveryById(correlatedDeliveryId));
    if (candidate && cleanText(candidate.provider) === "telnyx" && cleanText(candidate.channel) === "sms"
      && (!cleanText(candidate.provider_message_id) || cleanText(candidate.provider_message_id) === providerMessageId)) {
      delivery = candidate;
    }
  }
  if (!delivery) {
    // Telnyx sends STOP/START/HELP responses itself. If those provider-managed
    // messages emit normal outbound lifecycle events, they have no FirstMate
    // delivery row but still belong in the organization's provider-cost ledger.
    const fromAddress = phone(payload.from);
    const messagingProfileId = cleanText(payload.messaging_profile_id);
    const owner = (await findPhoneNumberOwner(fromAddress));
    const owned = owner && (!messagingProfileId || cleanText(owner.messaging_profile_id) === messagingProfileId);
    if (owned) {
      if (eventType === "message.finalized") {
        (await recordUsage(cleanText(owner.organization_id), "", "", eventId, payload, {
          provider_managed: true,
          source: "telnyx_provider_managed_outbound",
          messaging_profile_id: messagingProfileId,
          from_address: fromAddress
        }));
      }
      return;
    }
  }
  if (!delivery) throw new Error(`No delivery matches Telnyx message ${cleanText(payload.id)}.`);
  const organizationId = cleanText(delivery.organization_id);
  const deliveryId = cleanText(delivery.id);
  const messageId = cleanText(delivery.message_id);
  const currentEventAt = Date.parse(cleanText(delivery.provider_status_at));
  const nextEventAt = Date.parse(occurredAt);
  const status = normalizedDeliveryStatus(eventType, payload);
  const currentStatus = cleanText(delivery.status);
  const providerErrors = Array.isArray(payload.errors) ? payload.errors.map(asObject) : [];
  if (eventType === "message.finalized" && providerErrors.some((error) => cleanText(error.code) === "40300")) {
    (await upsertSmsConsent({
      organization_id: organizationId,
      phone_number: cleanText(delivery.recipient_address),
      status: "opted_out",
      source: "telnyx_provider_block",
      occurred_at: occurredAt,
      event_key: `telnyx_provider_block:${eventId}`,
      evidence: { provider_event_id: eventId, provider_message_id: providerMessageId, code: "40300" }
    }));
  }
  const terminalDowngrade = ["delivered", "failed", "delivery_unconfirmed"].includes(currentStatus) && ["queued", "sent", "sending"].includes(status);
  const stale = terminalDowngrade || (Number.isFinite(currentEventAt) && Number.isFinite(nextEventAt) && nextEventAt < currentEventAt);
  if (!stale) {
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status,
      provider_message_id: providerMessageId,
      response: { ...asObject(delivery.response), latest_webhook: payload },
      provider_status_at: occurredAt,
      ...(status === "sent" ? { sent_at: occurredAt } : {}),
      ...(status === "delivered" ? { delivered_at: occurredAt } : {}),
      ...(status === "failed" ? { failed_at: occurredAt, error: { errors: payload.errors } } : {})
    }));
    (await refreshParentMessageStatus(organizationId, messageId));
  }
  (await createCommunicationEvent({
    organization_id: organizationId, message_id: messageId, delivery_id: deliveryId,
    type: `delivery.${status}`, provider: "telnyx", occurred_at: occurredAt,
    payload: { provider_event_id: eventId, stale, errors: payload.errors }
  }));
  if (eventType === "message.finalized") (await recordUsage(organizationId, messageId, deliveryId, eventId, payload));
  (await readMessageRecord(organizationId, messageId));
}

const BRAND_REFERENCE_KEYS = ["telnyx_brand_id", "tcr_brand_id"] as const;
const CAMPAIGN_REFERENCE_KEYS = ["telnyx_campaign_id", "tcr_campaign_id"] as const;

function tenDlcBrandId(payload: CommunicationsJson) {
  return cleanText(payload.brandId || payload.brand_id);
}

function tenDlcCampaignId(payload: CommunicationsJson) {
  return cleanText(payload.campaignId || payload.telnyxCampaignId || payload.campaign_id);
}

function tenDlcPhoneNumber(payload: CommunicationsJson) {
  return cleanText(payload.phoneNumber || payload.phone_number);
}

function isCampaignBilledEvent(eventType: string, payload: CommunicationsJson) {
  return eventType === "10dlc.campaign.update"
    && cleanText(payload.type).toUpperCase() === "TCR_EVENT"
    && cleanText(payload.eventType).toUpperCase() === "CAMPAIGN_BILLED";
}

function canonicalReferenceId(profile: SmsComplianceProfile | null, incomingId: string, keys: readonly string[]) {
  if (!profile || !incomingId) return incomingId;
  const refs = asObject(profile.provider_refs);
  const knownIds = keys.map((key) => cleanText(refs[key])).filter(Boolean);
  if (!knownIds.includes(incomingId)) return incomingId;
  return knownIds[0] || incomingId;
}

function tenDlcStateKey(eventType: string, payload: CommunicationsJson, profile: SmsComplianceProfile | null = null) {
  if (isCampaignBilledEvent(eventType, payload)) return "";
  if (eventType === "10dlc.brand.update") {
    return `brand:${canonicalReferenceId(profile, tenDlcBrandId(payload), BRAND_REFERENCE_KEYS)}`;
  }
  if (eventType === "10dlc.campaign.update") {
    return `campaign:${canonicalReferenceId(profile, tenDlcCampaignId(payload), CAMPAIGN_REFERENCE_KEYS)}`;
  }
  if (eventType === "10dlc.phone_number.update") {
    const campaignId = canonicalReferenceId(profile, tenDlcCampaignId(payload), CAMPAIGN_REFERENCE_KEYS);
    return `phone:${tenDlcPhoneNumber(payload)}:campaign:${campaignId}`;
  }
  return "";
}

function storedTenDlcStateKey(event: CommunicationsJson, profile: SmsComplianceProfile) {
  const canonical = tenDlcStateKey(cleanText(event.provider_event_type), asObject(event.payload), profile);
  return canonical || cleanText(event.provider_state_key);
}

const CANONICAL_CAMPAIGN_STATUSES = new Set([
  "TCR_PENDING", "TCR_SUSPENDED", "TCR_EXPIRED", "TCR_ACCEPTED", "TCR_FAILED",
  "TELNYX_ACCEPTED", "TELNYX_FAILED", "MNO_PENDING", "MNO_ACCEPTED", "MNO_REJECTED",
  "MNO_PROVISIONED", "MNO_PROVISIONING_FAILED"
]);

function campaignStatusFromWebhook(payload: CommunicationsJson, currentStatus: unknown) {
  const updateType = cleanText(payload.type).toUpperCase();
  const providerEventType = cleanText(payload.eventType).toUpperCase();
  const providerStatus = cleanText(payload.campaignStatus || payload.status).toUpperCase();
  const current = cleanText(currentStatus).toLowerCase() || "pending";

  // Telnyx documents VERIFIED as the final webhook proving that every MNO has
  // provisioned the campaign. Review approvals remain non-sendable until then.
  if (updateType === "VERIFIED") return "mno_provisioned";

  const tcrEvent = updateType === "TCR_EVENT" ? providerEventType : updateType;
  const tcrEventStatuses: Record<string, string> = {
    CAMPAIGN_ADD: "tcr_accepted",
    CAMPAIGN_EXPIRED: "tcr_expired",
    CAMPAIGN_NUDGE: "tcr_accepted",
    CAMPAIGN_RESUBMISSION: "tcr_pending",
    CAMPAIGN_UPDATE: "tcr_accepted",
    MNO_CAMPAIGN_OPERATION_APPROVED: "mno_accepted",
    MNO_CAMPAIGN_OPERATION_REJECTED: "mno_rejected",
    MNO_CAMPAIGN_OPERATION_REVIEW: "mno_pending",
    MNO_CAMPAIGN_OPERATION_SUSPENDED: "tcr_suspended",
    MNO_CAMPAIGN_OPERATION_UNSUSPENDED: "mno_pending"
  };
  if (tcrEventStatuses[tcrEvent]) return tcrEventStatuses[tcrEvent];

  if (updateType === "REGISTRATION") {
    if (/failed|rejected/.test(providerStatus.toLowerCase())) return "tcr_failed";
    if (/success|accepted/.test(providerStatus.toLowerCase())) return "tcr_pending";
  }
  if (updateType === "TELNYX_REVIEW") {
    if (providerStatus === "ACCEPTED") return "telnyx_accepted";
    if (/failed|rejected/.test(providerStatus.toLowerCase())) return "telnyx_failed";
    return "telnyx_review";
  }
  if (updateType === "MNO_REVIEW") {
    if (providerStatus === "ACCEPTED") return "mno_accepted";
    if (/failed|rejected/.test(providerStatus.toLowerCase())) return "mno_rejected";
    return "mno_pending";
  }
  if (updateType === "TELNYX_EVENT" && (providerEventType === "DORMANT" || providerStatus === "DORMANT")) {
    return "tcr_suspended";
  }
  if (CANONICAL_CAMPAIGN_STATUSES.has(providerStatus)) {
    const normalized = providerStatus.toLowerCase();
    return normalized === "mno_provisioned" && current !== "mno_provisioned" ? "mno_pending" : normalized;
  }
  return providerStatus.toLowerCase() || current;
}

function tenDlcEventReducesReadiness(current: SmsComplianceProfile, eventType: string, payload: CommunicationsJson) {
  if (eventType === "10dlc.campaign.update") {
    if (cleanText(current.campaign_status).toLowerCase() === "tcr_expired") return true;
    return campaignStatusFromWebhook(payload, current.campaign_status) !== "mno_provisioned";
  }
  if (eventType === "10dlc.brand.update") {
    const status = cleanText(payload.status).toLowerCase();
    const identityStatus = cleanText(payload.identityStatus).toLowerCase();
    const readyIdentity = ["verified", "vetted_verified", "ok", "approved"];
    return /failed|rejected|suspended|expired/.test(status)
      || Boolean(identityStatus && !readyIdentity.includes(identityStatus));
  }
  if (eventType === "10dlc.phone_number.update") {
    const providerStatus = cleanText(payload.assignmentStatus || payload.status).toLowerCase();
    const updateType = cleanText(payload.type).toLowerCase();
    const assigned = (providerStatus === "success" && updateType === "assignment")
      || (updateType === "status_update" && providerStatus === "added");
    return !assigned;
  }
  return false;
}

async function resolveTenDlcProfile(eventType: string, payload: CommunicationsJson) {
  if (eventType === "10dlc.brand.update") {
    const brandId = tenDlcBrandId(payload);
    const profile = await findSmsComplianceProfileByProviderReference(brandId, BRAND_REFERENCE_KEYS);
    if (!profile) throw new Error(`No SMS compliance profile matches Telnyx brand ${brandId}.`);
    return profile;
  }
  if (eventType === "10dlc.campaign.update") {
    const campaignId = tenDlcCampaignId(payload);
    const profile = await findSmsComplianceProfileByProviderReference(campaignId, CAMPAIGN_REFERENCE_KEYS);
    if (!profile) throw new Error(`No SMS compliance profile matches Telnyx campaign ${campaignId}.`);
    return profile;
  }
  if (eventType === "10dlc.phone_number.update") {
    const phoneNumber = tenDlcPhoneNumber(payload);
    const owner = (await findPhoneNumberOwner(phoneNumber));
    if (!owner) throw new Error(`No current FirstMate ownership record matches Telnyx number ${phoneNumber}.`);
    const organization = await ensureMessagingOrganization(cleanText(owner.organization_id));
    return await readSmsComplianceProfile(organization.id, cleanText(owner.compliance_profile_id));
  }
  throw new Error(`Unsupported Telnyx 10DLC event type ${eventType}.`);
}

async function assertCurrentTenDlcBinding(profile: SmsComplianceProfile, eventType: string, payload: CommunicationsJson) {
  const refs = asObject(profile.provider_refs);
  const expectedBrandIds = BRAND_REFERENCE_KEYS.map((key) => cleanText(refs[key])).filter(Boolean);
  const expectedCampaignIds = CAMPAIGN_REFERENCE_KEYS.map((key) => cleanText(refs[key])).filter(Boolean);
  const brandId = tenDlcBrandId(payload);
  const campaignId = tenDlcCampaignId(payload);

  if (eventType === "10dlc.brand.update" && (!brandId || !expectedBrandIds.includes(brandId))) {
    throw new Error(`Telnyx brand event ${brandId || "(missing)"} no longer matches compliance profile ${profile.id}.`);
  }
  if (eventType === "10dlc.campaign.update" && (!campaignId || !expectedCampaignIds.includes(campaignId))) {
    throw new Error(`Telnyx campaign event ${campaignId || "(missing)"} no longer matches compliance profile ${profile.id}.`);
  }
  if (brandId && expectedBrandIds.length && !expectedBrandIds.includes(brandId)) {
    throw new Error(`Telnyx event brand ${brandId} does not match compliance profile ${profile.id}.`);
  }
  if (eventType !== "10dlc.phone_number.update") return;

  const selectedNumber = cleanText(asObject(profile.campaign).selectedNumber);
  const expectedCampaignId = cleanText(refs.telnyx_campaign_id);
  const messagingProfileId = cleanText(refs.telnyx_messaging_profile_id);
  const phoneNumber = tenDlcPhoneNumber(payload);
  const owner = (await findPhoneNumberOwner(phoneNumber));
  const ownsNumber = owner
    && cleanText(owner.organization_id) === profile.external_organization_id
    && cleanText(owner.compliance_profile_id) === profile.id
    && cleanText(owner.messaging_profile_id) === messagingProfileId;
  if (!phoneNumber || phoneNumber !== selectedNumber || !ownsNumber) {
    throw new Error(`Telnyx phone-number event no longer matches current ownership for compliance profile ${profile.id}.`);
  }
  if (!campaignId || !expectedCampaignId || campaignId !== expectedCampaignId) {
    throw new Error(`Telnyx phone-number event campaign ${campaignId || "(missing)"} does not match current campaign ${expectedCampaignId || "(missing)"}.`);
  }
}

type TenDlcMutationResult = {
  active: boolean;
  applied: boolean;
  billed: boolean;
  campaign_id: string;
  duplicate?: boolean;
  stale?: boolean;
  previously_active?: boolean;
};

export async function processTenDlcEvent(eventId: string, eventType: string, occurredAt: string, payload: CommunicationsJson) {
  if (providerTimestampNanoseconds(occurredAt) == null) {
    throw new Error(`Telnyx ${eventType} event ${eventId} is missing a valid RFC 3339 occurred_at timestamp.`);
  }
  if (isCampaignBilledEvent(eventType, payload)) {
    const campaignId = tenDlcCampaignId(payload);
    const commitment = (await findBillingCommitment("telnyx", "campaign", campaignId));
    if (!campaignId || !commitment) {
      throw new Error(`No FirstMate billing commitment matches Telnyx campaign charge ${campaignId || "(missing)"}.`);
    }
    const commitmentValue = asObject(commitment);
    const commitmentMetadata = asObject(commitmentValue.metadata);
    (await createUsageEvent({
      organization_id: commitmentValue.organization_id, provider: "telnyx", provider_message_id: campaignId,
      direction: "campaign_billing_notice", segments: 0, amount: "0", currency: commitmentValue.currency,
      event_key: `telnyx:campaign_billing_notice:${eventId}`, occurred_at: occurredAt,
      metadata: {
        compliance_profile_id: cleanText(commitmentMetadata.compliance_profile_id),
        provider_event_id: eventId,
        provider_event_type: "CAMPAIGN_BILLED",
        charge_kind: "10dlc_campaign_billing_notice",
        commitment_status: cleanText(commitmentValue.status),
        unpriced: true,
        reconciliation_required: true,
        monetary_usage_recorded: false
      }
    }));
    return {
      profile: null,
      result: { active: false, applied: true, billed: true, campaign_id: campaignId }
    };
  }
  const profile = await resolveTenDlcProfile(eventType, payload);
  const stateKey = tenDlcStateKey(eventType, payload, profile);
  const incomingAt = providerTimestampNanoseconds(occurredAt);
  const billed = isCampaignBilledEvent(eventType, payload);
  const mutation = await mutateSmsComplianceProfileAtomically<TenDlcMutationResult>(profile, async (current) => {
    (await assertCurrentTenDlcBinding(current, eventType, payload));
    if (current.events.some((event) => cleanText(event.provider_event_id) === eventId)) {
      return { result: { active: cleanText(current.status) === "active", applied: false, billed, campaign_id: tenDlcCampaignId(payload), duplicate: true } };
    }

    const previousAt = stateKey
      ? current.events.reduce<bigint | null>((latest, event) => {
          if (storedTenDlcStateKey(event, current) !== stateKey) return latest;
          const candidate = providerTimestampNanoseconds(event.occurred_at);
          return candidate != null && (latest == null || candidate > latest) ? candidate : latest;
        }, null)
      : null;
    const older = previousAt != null && incomingAt != null && incomingAt < previousAt;
    const equalButNotFailClosed = previousAt != null && incomingAt != null && incomingAt === previousAt
      && !tenDlcEventReducesReadiness(current, eventType, payload);
    if (stateKey && (older || equalButNotFailClosed)) {
      return {
        event: {
          type: "provider_webhook_received", provider: "telnyx", provider_event_id: eventId,
          provider_event_type: eventType, provider_state_key: stateKey, occurred_at: occurredAt, stale: true, payload
        },
        result: { active: cleanText(current.status) === "active", applied: false, billed, campaign_id: tenDlcCampaignId(payload), stale: true }
      };
    }

    const patch: CommunicationsJson = {};
    if (eventType === "10dlc.brand.update") {
      const identityStatus = cleanText(payload.identityStatus).toLowerCase();
      const operationStatus = cleanText(payload.status).toLowerCase();
      patch.brand_status = /failed|rejected|suspended|expired/.test(operationStatus)
        ? operationStatus
        : identityStatus || cleanText(current.brand_status).toLowerCase() || "pending";
      if (/failed|rejected/.test(cleanText(patch.brand_status))) {
        (await markProviderOperationFailed(current.external_organization_id, current.id, "brand_submission", { provider_status: patch.brand_status, provider_event_id: eventId }));
      }
    } else if (eventType === "10dlc.campaign.update" && !billed) {
      patch.campaign_status = cleanText(current.campaign_status).toLowerCase() === "tcr_expired"
        ? "tcr_expired"
        : campaignStatusFromWebhook(payload, current.campaign_status);
      if (/failed|rejected|suspended|expired/.test(cleanText(patch.campaign_status))) {
        (await markProviderOperationFailed(current.external_organization_id, current.id, "campaign_submission", { provider_status: patch.campaign_status, provider_event_id: eventId }));
      }
    } else if (eventType === "10dlc.phone_number.update") {
      const providerStatus = cleanText(payload.assignmentStatus || payload.status || current.phone_number_campaign_status).toLowerCase();
      const updateType = cleanText(payload.type).toLowerCase();
      const assigned = (providerStatus === "success" && updateType === "assignment")
        || (updateType === "status_update" && providerStatus === "added");
      const unassigned = providerStatus === "success" && updateType === "deletion";
      patch.phone_number_campaign_status = assigned ? "assigned" : unassigned ? "unassigned" : providerStatus || updateType;
      patch.phone_number_campaign_id = assigned ? cleanText(asObject(current.provider_refs).telnyx_campaign_id) : "";
    }

    let active = false;
    if (!billed) {
      const refs = asObject(current.provider_refs);
      const expectedCampaignId = cleanText(refs.telnyx_campaign_id);
      const selectedNumber = cleanText(asObject(current.campaign).selectedNumber);
      const messagingProfileId = cleanText(refs.telnyx_messaging_profile_id);
      const nextBrandStatus = cleanText(patch.brand_status || current.brand_status).toLowerCase();
      const nextCampaignStatus = cleanText(patch.campaign_status || current.campaign_status).toLowerCase();
      const nextAssignmentStatus = cleanText(patch.phone_number_campaign_status || current.phone_number_campaign_status).toLowerCase();
      const nextAssignmentCampaignId = Object.prototype.hasOwnProperty.call(patch, "phone_number_campaign_id")
        ? cleanText(patch.phone_number_campaign_id)
        : cleanText(current.phone_number_campaign_id);
      const owner = selectedNumber ? (await findPhoneNumberOwner(selectedNumber)) : null;
      const administrativelyDisabled = ["deactivation_pending", "deactivated"].includes(cleanText(current.status).toLowerCase());
      const ownsNumber = owner
        && cleanText(owner.organization_id) === current.external_organization_id
        && cleanText(owner.compliance_profile_id) === current.id
        && cleanText(owner.messaging_profile_id) === messagingProfileId;
      active = !administrativelyDisabled && Boolean(selectedNumber && messagingProfileId && expectedCampaignId && ownsNumber)
        && ["verified", "vetted_verified", "ok", "approved"].includes(nextBrandStatus)
        && nextCampaignStatus === "mno_provisioned"
        && smsAutoresponsesReady(current)
        && ["success", "active", "purchased"].includes(cleanText(current.phone_number_status).toLowerCase())
        && nextAssignmentStatus === "assigned"
        && nextAssignmentCampaignId === expectedCampaignId;
      if (active) {
        const ownership = (await claimPhoneNumberOwnership({
          phone_number: selectedNumber, organization_id: current.external_organization_id,
          compliance_profile_id: current.id, messaging_profile_id: messagingProfileId,
          provider_phone_number_id: cleanText(owner?.provider_phone_number_id), status: "active"
        }));
        active = ownership.claimed;
      }
      patch.status = active ? "active" : cleanText(current.status) === "active" ? "provider_update_pending" : current.status;
    }

    return {
      event: {
        type: "provider_webhook_received", provider: "telnyx", provider_event_id: eventId,
        provider_event_type: eventType, provider_state_key: stateKey, occurred_at: occurredAt, payload
      },
      patch,
      result: {
        active,
        applied: true,
        billed,
        campaign_id: tenDlcCampaignId(payload),
        previously_active: cleanText(current.status).toLowerCase() === "active"
      }
    };
  });

  const saved = mutation.profile;
  if (!mutation.result.active) {
    for (const delivery of (await suspendOrganizationSmsDeliveries(saved.external_organization_id, "sms_provider_compliance_not_ready"))) {
      (await refreshParentMessageStatus(saved.external_organization_id, cleanText(delivery.message_id)));
    }
    scheduleSmsDeliveryQueue();
  }
  const isReviewResubmission = eventType === "10dlc.campaign.update"
    && cleanText(payload.type).toUpperCase() === "TCR_EVENT"
    && cleanText(payload.eventType).toUpperCase() === "CAMPAIGN_RESUBMISSION";
  if (isReviewResubmission) {
    const campaignId = mutation.result.campaign_id;
    (await createUsageEvent({
      organization_id: saved.external_organization_id,
      provider: "telnyx",
      provider_message_id: campaignId,
      direction: "campaign_review",
      segments: 0,
      amount: env.telnyxCampaignReviewFeeUsd,
      currency: "USD",
      event_key: `telnyx:campaign_review:resubmission:${eventId}`,
      occurred_at: occurredAt,
      metadata: {
        compliance_profile_id: saved.id,
        provider_event_id: eventId,
        charge_kind: "10dlc_campaign_review",
        review_kind: "resubmission"
      }
    }));
  }
  if (mutation.result.active) await setDefaultSmsComplianceProfile(saved);
  return mutation;
}

export async function acceptTelnyxWebhook(body: unknown, correlatedDeliveryId = "") {
  const storedBody = correlatedDeliveryId ? { ...asObject(body), _firstmate_delivery_id: correlatedDeliveryId } : body;
  const envelope = webhookEnvelope(storedBody);
  if (!envelope.eventId || !envelope.eventType) throw new Error("Telnyx webhook is missing data.id or data.event_type.");
  const accepted = (await createWebhookInboxEvent({
    provider: "telnyx", event_id: envelope.eventId, event_type: envelope.eventType,
    provider_object_id: cleanText(envelope.payload.id), payload: storedBody, occurred_at: envelope.occurredAt
  }));
  const claimed = (await claimWebhookInboxEvent("telnyx", envelope.eventId, webhookProcessorId));
  if (!claimed) return { duplicate: !accepted.created, in_progress: true, event_id: envelope.eventId };
  const claimedEnvelope = webhookEnvelope(claimed.payload);
  try {
    if (claimedEnvelope.eventType === "message.received") await processInbound(claimedEnvelope.eventId, claimedEnvelope.occurredAt, claimedEnvelope.payload);
    else if (claimedEnvelope.eventType === "message.sent" || claimedEnvelope.eventType === "message.finalized") (await processOutbound(claimedEnvelope.eventId, claimedEnvelope.eventType, claimedEnvelope.occurredAt, claimedEnvelope.payload, claimedEnvelope.correlatedDeliveryId));
    else if (claimedEnvelope.eventType.startsWith("10dlc.")) await processTenDlcEvent(claimedEnvelope.eventId, claimedEnvelope.eventType, claimedEnvelope.occurredAt, claimedEnvelope.payload);
    (await markWebhookInboxEventProcessed("telnyx", claimedEnvelope.eventId));
    return { duplicate: !accepted.created, event_id: claimedEnvelope.eventId };
  } catch (error) {
    (await markWebhookInboxEventProcessed("telnyx", claimedEnvelope.eventId, error instanceof Error ? error.message : String(error)));
    return { duplicate: !accepted.created, event_id: claimedEnvelope.eventId, orphaned: true };
  }
}

export async function retryTelnyxWebhookEventsForObject(providerObjectId: string) {
  const rows = (await listWebhookInboxEventsForObject("telnyx", providerObjectId));
  let processed = 0;
  for (const row of rows) {
    const claimed = (await claimWebhookInboxEvent("telnyx", cleanText(asObject(row).event_id), webhookProcessorId));
    if (!claimed) continue;
    const envelope = webhookEnvelope(claimed.payload);
    try {
      if (envelope.eventType === "message.received") await processInbound(envelope.eventId, envelope.occurredAt, envelope.payload);
      else if (envelope.eventType === "message.sent" || envelope.eventType === "message.finalized") (await processOutbound(envelope.eventId, envelope.eventType, envelope.occurredAt, envelope.payload, envelope.correlatedDeliveryId));
      else if (envelope.eventType.startsWith("10dlc.")) await processTenDlcEvent(envelope.eventId, envelope.eventType, envelope.occurredAt, envelope.payload);
      (await markWebhookInboxEventProcessed("telnyx", envelope.eventId));
      processed += 1;
    } catch {
      // Leave the durable orphan marker for reconciliation/alerting.
    }
  }
  return processed;
}

export async function retryPendingTelnyxWebhookEvents(limit = 25) {
  const rows = (await listPendingWebhookInboxEvents("telnyx", limit));
  let processed = 0;
  for (const row of rows) {
    const claimed = (await claimWebhookInboxEvent("telnyx", cleanText(asObject(row).event_id), webhookProcessorId));
    if (!claimed) continue;
    const envelope = webhookEnvelope(claimed.payload);
    try {
      if (envelope.eventType === "message.received") await processInbound(envelope.eventId, envelope.occurredAt, envelope.payload);
      else if (envelope.eventType === "message.sent" || envelope.eventType === "message.finalized") (await processOutbound(envelope.eventId, envelope.eventType, envelope.occurredAt, envelope.payload, envelope.correlatedDeliveryId));
      else if (envelope.eventType.startsWith("10dlc.")) await processTenDlcEvent(envelope.eventId, envelope.eventType, envelope.occurredAt, envelope.payload);
      (await markWebhookInboxEventProcessed("telnyx", envelope.eventId));
      processed += 1;
    } catch (error) {
      (await markWebhookInboxEventProcessed("telnyx", envelope.eventId, error instanceof Error ? error.message : String(error)));
    }
  }
  return processed;
}
