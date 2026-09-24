import { platformBackgroundAllowed } from "../platform/runtime.js";
import { randomUUID } from "node:crypto";

import { env } from "../src/config/env.js";
import {
  claimNextSmsDelivery,
  claimNextSmsCancellation,
  createCommunicationEvent,
  findPhoneNumberOwner,
  listDeliveryRecords,
  listSmsDeliveriesForReconciliation,
  readDeliveryRecord,
  readMessageRecord,
  readSmsConsent,
  recoverExpiredSmsDeliveryLeases,
  updateDeliveryRecord,
  updateMessageRecord,
  upsertSmsConsent,
  type CommunicationsJson
} from "./communications_storage.js";
import { listSmsComplianceProfiles, ensureMessagingOrganization } from "./storage.js";
import { createTelnyxClient, telnyxDeliveryWebhookUrl, TelnyxError } from "./telnyx.js";
import { outboundSmsComplianceIssue, smsConsentPurposesAllow } from "./compliance_rules.js";
import { smsAutoresponsesReady } from "./autoresponses.js";
import { audioMediaPublicUrl } from "../audio-notes/links.js";

const workerId = `sms_worker_${process.pid}_${randomUUID().slice(0, 8)}`;
let timer: ReturnType<typeof setInterval> | null = null;
let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let reconciling = false;
let deliveryRunPromise: Promise<unknown> | null = null;
let reconciliationRunPromise: Promise<unknown> | null = null;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): CommunicationsJson {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as CommunicationsJson) } : {};
}

function providerData(value: unknown) {
  const payload = asObject(value);
  return asObject(payload.data || payload);
}

function consentAllowsPurpose(consent: CommunicationsJson, purpose: string) {
  const rawPurposes = asObject(consent.evidence).purposes;
  return smsConsentPurposesAllow(rawPurposes, purpose);
}

export function deliveryAggregateStatus(deliveries: CommunicationsJson[]) {
  const statuses = deliveries.map((entry) => cleanText(entry.status));
  if (statuses.length && statuses.every((status) => status === "delivered")) return "delivered";
  if (statuses.some((status) => status === "sent")) return "sent";
  if (statuses.some((status) => status === "scheduled")) return "scheduled";
  if (statuses.some((status) => ["queued", "retry_pending", "submitting", "cancel_pending", "cancelling"].includes(status))) return "queued";
  const failureStatuses = new Set(["failed", "cancel_failed", "submission_unknown", "delivery_unconfirmed"]);
  if (statuses.some((status) => status === "delivered") && statuses.some((status) => failureStatuses.has(status))) return "partially_delivered";
  if (statuses.some((status) => ["submission_unknown", "delivery_unconfirmed"].includes(status))) return "delivery_unconfirmed";
  if (statuses.length && statuses.every((status) => failureStatuses.has(status))) return "failed";
  return "failed";
}

export async function refreshParentMessageStatus(organizationId: string, messageId: string) {
  const message = (await readMessageRecord(organizationId, messageId));
  const deliveries = (await listDeliveryRecords(organizationId, messageId));
  const status = deliveryAggregateStatus(deliveries);
  const now = new Date().toISOString();
  return (await updateMessageRecord(organizationId, messageId, {
    status,
    ...(status === "sent" ? { sent_at: cleanText(message.sent_at) || now } : {}),
    ...(status === "delivered" ? { delivered_at: cleanText(message.delivered_at) || now } : {}),
    ...(status === "failed" ? { failed_at: cleanText(message.failed_at) || now } : {})
  }));
}

async function activeConfiguration(organizationId: string) {
  const organization = await ensureMessagingOrganization(organizationId);
  const profiles = await listSmsComplianceProfiles(organization.id);
  const profile = profiles.find((entry) => entry.id === organization.default_sms_compliance_profile_id) || profiles[0];
  if (!profile) return null;
  const refs = asObject(profile.provider_refs);
  const campaign = asObject(profile.campaign);
  const campaignStatus = cleanText(profile.campaign_status).toLowerCase();
  const numberStatus = cleanText(profile.phone_number_status).toLowerCase();
  const assignmentStatus = cleanText(profile.phone_number_campaign_status).toLowerCase();
  const campaignId = cleanText(refs.telnyx_campaign_id);
  const assignmentCampaignId = cleanText(profile.phone_number_campaign_id);
  const active = campaignStatus === "mno_provisioned"
    && cleanText(profile.status).toLowerCase() === "active"
    && smsAutoresponsesReady(profile)
    && ["verified", "vetted_verified", "ok", "approved"].includes(cleanText(profile.brand_status).toLowerCase())
    && ["success", "active", "purchased"].includes(numberStatus)
    && assignmentStatus === "assigned"
    && Boolean(campaignId)
    && assignmentCampaignId === campaignId;
  if (!active) return null;
  const phoneNumber = cleanText(campaign.selectedNumber);
  const messagingProfileId = cleanText(refs.telnyx_messaging_profile_id);
  const owner = phoneNumber ? (await findPhoneNumberOwner(phoneNumber)) : null;
  const owned = owner && cleanText(owner.organization_id) === organizationId
    && cleanText(owner.compliance_profile_id) === cleanText(profile.id)
    && cleanText(owner.messaging_profile_id) === messagingProfileId
    && cleanText(owner.status) === "active";
  return phoneNumber && messagingProfileId && owned ? { phoneNumber, messagingProfileId, profile } : null;
}

function retryDelayMs(error: TelnyxError, attempts: number) {
  const retryAfter = Number(error.headers["retry-after"] || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(60_000, retryAfter * 1000);
  const base = Math.min(60_000, 1000 * (2 ** Math.max(0, attempts - 1)));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function providerErrorCode(error: TelnyxError) {
  const details = asObject(error.details);
  const errors = Array.isArray(details.errors) ? details.errors.map(asObject) : [];
  return cleanText(errors[0]?.code || details.code);
}

export function scheduleForProvider(value: unknown) {
  const timestamp = Date.parse(cleanText(value));
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return "";
  if (timestamp < Date.now() + 5 * 60_000) return "wait";
  if (timestamp > Date.now() + 5 * 24 * 60 * 60_000) return "later";
  return new Date(timestamp).toISOString();
}

async function dispatchClaimedDelivery(delivery: CommunicationsJson) {
  const organizationId = cleanText(delivery.organization_id);
  const deliveryId = cleanText(delivery.id);
  const messageId = cleanText(delivery.message_id);
  const message = (await readMessageRecord(organizationId, messageId));
  const recipient = asObject(delivery.recipient);
  const recipientAddress = cleanText(delivery.recipient_address);
  const scheduledFor = scheduleForProvider(message.scheduled_for);

  if (scheduledFor === "later") {
    const nextAttempt = new Date(Date.parse(cleanText(message.scheduled_for)) - (5 * 24 * 60 * 60_000) + 60_000).toISOString();
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status: "scheduled", attempts: Math.max(0, Number(delivery.attempts || 1) - 1), next_attempt_at: nextAttempt, lease_owner: "", lease_until: ""
    }));
    return;
  }
  if (scheduledFor === "wait") {
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status: "scheduled", attempts: Math.max(0, Number(delivery.attempts || 1) - 1),
      next_attempt_at: cleanText(message.scheduled_for), lease_owner: "", lease_until: ""
    }));
    return;
  }

  const configuration = await activeConfiguration(organizationId);
  if (!configuration) {
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status: "failed", failed_at: new Date().toISOString(), lease_owner: "", lease_until: "",
      error: { code: "sms_not_provisioned", message: "The organization SMS sender is not fully provisioned." }
    }));
    (await refreshParentMessageStatus(organizationId, messageId));
    return;
  }

  const complianceIssue = outboundSmsComplianceIssue(configuration.profile, message.purpose, message.text_body);
  if (complianceIssue) {
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status: "failed", failed_at: new Date().toISOString(), lease_owner: "", lease_until: "",
      error: complianceIssue
    }));
    (await refreshParentMessageStatus(organizationId, messageId));
    return;
  }

  if (env.smsRequireConsent) {
    const consent = (await readSmsConsent(organizationId, recipientAddress));
    const requestedConsentId = cleanText(recipient.consent_id);
    if (!consent || cleanText(consent.status) !== "opted_in" || (requestedConsentId && cleanText(consent.consent_id) !== requestedConsentId) || !consentAllowsPurpose(consent, cleanText(message.purpose || "customer_care"))) {
      (await updateDeliveryRecord(organizationId, deliveryId, {
        status: "failed", failed_at: new Date().toISOString(), lease_owner: "", lease_until: "",
        error: { code: "sms_consent_required", message: "Active organization-scoped SMS consent is required." }
      }));
      (await refreshParentMessageStatus(organizationId, messageId));
      return;
    }
  }

  const { reserveSms, releaseSms } = await import("../platform-billing/allowances.js");
  if (!await reserveSms(organizationId, deliveryId)) {
    await updateDeliveryRecord(organizationId, deliveryId, {
      status: "retry_pending", attempts: Math.max(0, Number(delivery.attempts || 1) - 1),
      next_attempt_at: new Date(Date.now() + 300000).toISOString(), lease_owner: "", lease_until: "",
      error: { code: "billing_sms_allowance", message: "SMS allowance reached. Upgrade in Billing or wait for renewal; this message is paused." }
    });
    await refreshParentMessageStatus(organizationId, messageId);
    return;
  }
  try {
    const audioNote = asObject(asObject(message.metadata).audio_note);
    const audioMediaId = cleanText(audioNote.media_id);
    const response = await createTelnyxClient().sendMessage({
      from: configuration.phoneNumber,
      to: recipientAddress,
      messaging_profile_id: configuration.messagingProfileId,
      text: cleanText(message.text_body),
      type: audioMediaId ? "MMS" : "SMS",
      ...(audioMediaId ? { media_urls: [audioMediaPublicUrl(organizationId, audioMediaId)] } : {}),
      encoding: "auto",
      auto_detect: true,
      use_profile_webhooks: false,
      webhook_url: telnyxDeliveryWebhookUrl(deliveryId),
      ...(env.telnyxWebhookFailoverUrl ? { webhook_failover_url: telnyxDeliveryWebhookUrl(deliveryId, env.telnyxWebhookFailoverUrl) } : {}),
      ...(scheduledFor ? { send_at: scheduledFor } : {})
    });
    const data = providerData(response);
    const now = new Date().toISOString();
    const acceptedStatus = scheduledFor ? "scheduled" : (["sent", "delivered"].includes(cleanText(data.to && Array.isArray(data.to) ? asObject(data.to[0]).status : data.status).toLowerCase()) ? "sent" : "queued");
    const currentDelivery = (await readDeliveryRecord(organizationId, deliveryId));
    const currentStatus = cleanText(currentDelivery.status);
    const status = ["sent", "delivered", "failed", "delivery_unconfirmed"].includes(currentStatus) ? currentStatus : acceptedStatus;
    const responseStatusAt = cleanText(data.sent_at || data.created_at || now);
    const currentStatusAt = cleanText(currentDelivery.provider_status_at);
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status,
      provider_message_id: cleanText(data.id),
      response: { ...asObject(currentDelivery.response), provider_acceptance: data },
      sent_at: status === "sent" ? cleanText(currentDelivery.sent_at) || now : cleanText(currentDelivery.sent_at),
      next_attempt_at: "",
      lease_owner: "",
      lease_until: "",
      provider_status_at: Date.parse(currentStatusAt) > Date.parse(responseStatusAt) ? currentStatusAt : responseStatusAt
    }));
    (await createCommunicationEvent({
      organization_id: organizationId,
      message_id: messageId,
      delivery_id: deliveryId,
      type: scheduledFor ? "provider.scheduled" : "provider.accepted",
      provider: "telnyx",
      occurred_at: now,
      payload: { provider_message_id: cleanText(data.id), status }
    }));
    (await refreshParentMessageStatus(organizationId, messageId));
    if (cleanText(data.id)) {
      const { retryTelnyxWebhookEventsForObject } = await import("./telnyx_webhooks.js");
      await retryTelnyxWebhookEventsForObject(cleanText(data.id));
    }
  } catch (error) {
    const now = new Date().toISOString();
    if (!(error instanceof TelnyxError)) throw error;
    const details = asObject(error.details);
    const submissionUnknown = details.submission_unknown === true;
    if (!submissionUnknown) await releaseSms(organizationId, deliveryId);
    const attempts = Number(delivery.attempts || 1);
    const code = providerErrorCode(error);
    if (code === "40300") {
      (await upsertSmsConsent({ organization_id: organizationId, phone_number: recipientAddress, status: "opted_out", source: "telnyx_provider_block", evidence: { code } }));
    }
    const retry = error.retryable && !submissionUnknown && attempts < env.smsDeliveryMaxAttempts;
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status: submissionUnknown ? "submission_unknown" : retry ? "retry_pending" : "failed",
      failed_at: retry ? "" : now,
      next_attempt_at: retry ? new Date(Date.now() + retryDelayMs(error, attempts)).toISOString() : "",
      lease_owner: "",
      lease_until: "",
      error: { message: error.message, status_code: error.statusCode, code, details: error.details, submission_unknown: submissionUnknown }
    }));
    (await createCommunicationEvent({
      organization_id: organizationId, message_id: messageId, delivery_id: deliveryId,
      type: submissionUnknown ? "provider.submission_unknown" : retry ? "provider.retry_scheduled" : "provider.rejected",
      provider: "telnyx", occurred_at: now,
      payload: { status_code: error.statusCode, code, retry }
    }));
    (await refreshParentMessageStatus(organizationId, messageId));
  }
}

async function cancelClaimedDelivery(delivery: CommunicationsJson) {
  const organizationId = cleanText(delivery.organization_id);
  const deliveryId = cleanText(delivery.id);
  const messageId = cleanText(delivery.message_id);
  const cancellationError = asObject(delivery.error);
  const cancellationCode = cleanText(cancellationError.code || "scheduled_delivery_cancelled");
  const cancellationMessage = cleanText(cancellationError.message || "Scheduled Telnyx message was cancelled before delivery.");
  try {
    await createTelnyxClient().cancelScheduledMessage(cleanText(delivery.provider_message_id));
    const now = new Date().toISOString();
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status: "failed", failed_at: now, lease_owner: "", lease_until: "", next_attempt_at: "",
      error: { code: cancellationCode, message: cancellationMessage }
    }));
    (await createCommunicationEvent({
      organization_id: organizationId, message_id: messageId, delivery_id: deliveryId,
      type: "provider.schedule_cancelled", provider: "telnyx", occurred_at: now,
      payload: { reason: cancellationCode }
    }));
    (await refreshParentMessageStatus(organizationId, messageId));
  } catch (error) {
    const telnyxError = error instanceof TelnyxError ? error : null;
    const retry = Boolean(telnyxError?.retryable) && Number(delivery.attempts || 0) < env.smsDeliveryMaxAttempts;
    (await updateDeliveryRecord(organizationId, deliveryId, {
      status: retry ? "cancel_pending" : "cancel_failed",
      next_attempt_at: retry ? new Date(Date.now() + retryDelayMs(telnyxError!, Number(delivery.attempts || 1))).toISOString() : "",
      lease_owner: "", lease_until: "",
      error: { code: "schedule_cancel_failed", message: error instanceof Error ? error.message : String(error) }
    }));
  }
}

export async function runSmsDeliveryQueue(limit = 25) {
  if (running || env.communicationsDeliveryMode !== "live") return 0;
  running = true;
  let processed = 0;
  try {
    for (const expired of (await recoverExpiredSmsDeliveryLeases())) {
      if (cleanText(expired.status) === "submitting") {
        (await createCommunicationEvent({
          organization_id: expired.organization_id, message_id: expired.message_id, delivery_id: expired.id,
          type: "provider.submission_unknown", provider: "telnyx",
          payload: { reason: "worker_lease_expired", automatic_resend: false }
        }));
        (await refreshParentMessageStatus(cleanText(expired.organization_id), cleanText(expired.message_id)));
      }
    }
    while (processed < limit) {
      const cancellation = (await claimNextSmsCancellation(workerId));
      if (cancellation) {
        await cancelClaimedDelivery(cancellation);
        processed += 1;
        continue;
      }
      const delivery = (await claimNextSmsDelivery(workerId, env.smsDeliveryMaxAttempts));
      if (!delivery) break;
      await dispatchClaimedDelivery(delivery);
      processed += 1;
    }
    return processed;
  } finally {
    running = false;
  }
}

export async function runSmsReconciliation(limit = 25) {
  if (env.communicationsDeliveryMode !== "live" || reconciling) return 0;
  reconciling = true;
  try {
  const { retryPendingTelnyxWebhookEvents } = await import("./telnyx_webhooks.js");
  await retryPendingTelnyxWebhookEvents(limit);
  const deliveries = (await listSmsDeliveriesForReconciliation(limit));
  let reconciled = 0;
  for (const delivery of deliveries) {
    const organizationId = cleanText(delivery.organization_id);
    const deliveryId = cleanText(delivery.id);
    try {
      const response = await createTelnyxClient().getMessage(cleanText(delivery.provider_message_id));
      const data = providerData(response);
      const to = Array.isArray(data.to) ? asObject(data.to[0]) : {};
      const status = cleanText(to.status || data.status).toLowerCase();
      const occurredAt = cleanText(data.completed_at || data.sent_at || data.updated_at || new Date().toISOString());
      (await updateDeliveryRecord(organizationId, deliveryId, { last_reconciled_at: new Date().toISOString() }));
      if (["sent", "delivered", "delivery_failed", "delivery_unconfirmed", "sending_failed", "failed"].includes(status)) {
        const eventType = status === "sent" ? "message.sent" : "message.finalized";
        const { acceptTelnyxWebhook } = await import("./telnyx_webhooks.js");
        await acceptTelnyxWebhook({
          data: {
            id: `reconcile:${cleanText(data.id)}:${occurredAt}:${status}`,
            event_type: eventType,
            occurred_at: occurredAt,
            payload: data
          }
        });
      }
      reconciled += 1;
    } catch (error) {
      (await updateDeliveryRecord(organizationId, deliveryId, {
        last_reconciled_at: new Date().toISOString(),
        error: { ...asObject(delivery.error), reconciliation_error: error instanceof Error ? error.message : String(error) }
      }));
    }
  }
  return reconciled;
  } finally {
    reconciling = false;
  }
}

function logWorkerError(scope: string, error: unknown) {
  console.error(`[messaging:${scope}]`, error instanceof Error ? error.message : String(error));
}

export function scheduleSmsDeliveryQueue(limit = 25) {
  if (env.deploymentTopology === "cluster" && process.env.PLATFORM_PROCESS_ROLE !== "worker") return;
  if (deliveryRunPromise || env.communicationsDeliveryMode !== "live") return;
  deliveryRunPromise = runSmsDeliveryQueue(limit)
    .catch((error) => logWorkerError("delivery-worker", error))
    .finally(() => { deliveryRunPromise = null; });
}

function scheduleSmsReconciliation(limit = 25) {
  if (reconciliationRunPromise || env.communicationsDeliveryMode !== "live") return;
  reconciliationRunPromise = runSmsReconciliation(limit)
    .catch((error) => logWorkerError("reconciliation-worker", error))
    .finally(() => { reconciliationRunPromise = null; });
}

export function startSmsDeliveryWorker() {
  if (!platformBackgroundAllowed()) return;
  if (timer || env.communicationsDeliveryMode !== "live") return;
  const clusterWorker = cleanText(process.env.V1_CLUSTER_WORKER);
  if (clusterWorker && clusterWorker !== "1") return;
  timer = setInterval(() => scheduleSmsDeliveryQueue(), 2_000);
  timer.unref?.();
  reconciliationTimer = setInterval(() => scheduleSmsReconciliation(), 60_000);
  reconciliationTimer.unref?.();
  scheduleSmsDeliveryQueue();
}

export async function stopSmsDeliveryWorker() {
  if (timer) clearInterval(timer);
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  timer = null;
  reconciliationTimer = null;
  await Promise.allSettled([deliveryRunPromise, reconciliationRunPromise].filter(Boolean) as Promise<unknown>[]);
}
