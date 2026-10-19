import { env } from "../src/config/env.js";
import { guardDevelopmentSms } from "../src/environment_safety.js";
import { smsConsentPurposesAllow, outboundSmsComplianceIssue } from "./compliance_rules.js";
import { createTelnyxClient, telnyxDeliveryWebhookUrl, TelnyxError } from "./telnyx.js";
import { createCommunicationEvent, listDeliveryRecords, readDeliveryRecord, readSmsConsent, updateDeliveryRecord, withCommunicationsTransaction, type CommunicationsJson } from "./communications_storage.js";
import { groupMmsMembers } from "./group_mms.js";
import { audioMediaPublicUrl } from "../audio-notes/links.js";
import { smsImagePublicUrl } from "../comms/sms-images.js";

const text = (value: unknown) => String(value || "").trim();
const object = (value: unknown) => (value || {}) as CommunicationsJson;

export async function dispatchGroupMms(leader: CommunicationsJson, message: CommunicationsJson, configuration: { phoneNumber: string; profile: CommunicationsJson } | null) {
  const org = text(message.organization_id);
  const rows = await listDeliveryRecords(org, text(message.id));
  const patchAll = async (status: string, error: CommunicationsJson, retryAt = "") => withCommunicationsTransaction(async () => {
    for (const row of rows) {
      const current = await readDeliveryRecord(org, text(row.id));
      if (current.provider_message_id || ["sent", "delivered", "delivery_unconfirmed"].includes(text(current.status))) continue;
      await updateDeliveryRecord(org, text(row.id), { status: status === "retry_pending" && row.id !== leader.id ? "group_pending" : status,
      error, next_attempt_at: row.id === leader.id ? retryAt : "", lease_owner: "", lease_until: "", failed_at: status === "failed" || status === "submission_unknown" ? new Date().toISOString() : "" });
    }
  });
  if (!configuration || configuration.phoneNumber !== object(message.sender).address) {
    await patchAll("failed", { code: "group_mms_sender_not_active", message: "The group's original sending line must still be fully provisioned." });
    return;
  }
  const recipients = (message.recipients || []) as CommunicationsJson[];
  const members = groupMmsMembers(configuration.phoneNumber, recipients.map(item => item.address));
  if (rows.length !== members.length || rows.some(row => row.status !== "submitting" || row.lease_owner !== leader.lease_owner)) {
    await patchAll("failed", { code: "group_mms_incomplete_claim", message: "The full group could not be claimed. No partial group will be sent." });
    return;
  }
  const issue = outboundSmsComplianceIssue(configuration.profile, message.purpose, message.text_body);
  if (issue) { await patchAll("failed", issue); return; }
  for (const recipient of recipients) {
    const address = text(recipient.address);
    const guard = guardDevelopmentSms(address);
    const consent = await readSmsConsent(org, address);
    if (!guard.allowed || (env.smsRequireConsent && (!consent || consent.status !== "opted_in" ||
      (recipient.consent_id && consent.consent_id !== recipient.consent_id) || !smsConsentPurposesAllow(object(consent.evidence).purposes, message.purpose)))) {
      await patchAll("failed", { code: guard.allowed ? "sms_consent_required" : guard.reason, recipient: address, message: "Every group member must be eligible and have active purpose-appropriate consent. No partial group will be sent." });
      return;
    }
  }
  const { reserveSms, releaseSms } = await import("../platform-billing/allowances.js");
  const reserved: string[] = [];
  for (const row of rows) {
    if (!await reserveSms(org, text(row.id))) {
      for (const id of reserved) await releaseSms(org, id);
      await patchAll("retry_pending", { code: "billing_sms_allowance", message: "Group delivery is paused until enough allowance is available for every recipient." }, new Date(Date.now() + 300000).toISOString());
      return;
    }
    reserved.push(text(row.id));
  }
  let attempted = false;
  try {
    const metadata = object(message.metadata);
    const imageId = text(object(metadata.sms_image).media_id);
    const audioId = text(object(metadata.audio_note).media_id);
    const media = [...(imageId ? [smsImagePublicUrl(org, imageId)] : []), ...(audioId ? [audioMediaPublicUrl(org, audioId)] : [])];
    attempted = true;
    const response = await createTelnyxClient().sendGroupMms({ from: configuration.phoneNumber, to: members,
      ...(text(message.text_body) ? { text: text(message.text_body) } : {}), ...(media.length ? { media_urls: media } : {}),
      use_profile_webhooks: false, webhook_url: telnyxDeliveryWebhookUrl(text(leader.id)),
      ...(env.telnyxWebhookFailoverUrl ? { webhook_failover_url: telnyxDeliveryWebhookUrl(text(leader.id), env.telnyxWebhookFailoverUrl) } : {}) });
    const data = object(object(response).data);
    const groupId = text(data.group_message_id || data.id);
    if (!groupId) throw new Error("Telnyx did not return a group-message identifier; automatic resend is disabled.");
    await withCommunicationsTransaction(async () => {
      for (const row of rows) {
        const current = await readDeliveryRecord(org, text(row.id));
        const to = (Array.isArray(data.to) ? data.to : []) as CommunicationsJson[];
        const recipient = to.find(item => item.phone_number === row.recipient_address);
        const accepted = text(recipient?.status).toLowerCase();
        const status = ["delivered", "failed", "delivery_unconfirmed", "sent"].includes(text(current.status)) ? current.status
          : accepted === "unknown" ? "delivery_unconfirmed" : ["failed", "delivery_failed", "sending_failed"].includes(accepted) ? "failed" : accepted === "delivered" ? "delivered" : accepted === "sent" ? "sent" : "queued";
        await updateDeliveryRecord(org, text(row.id), { status, provider_message_id: text(recipient?.id || recipient?.message_id || current.provider_message_id || groupId),
          response: { ...object(current.response), group_mms: true, group_message_id: groupId, provider_acceptance: data },
          lease_owner: "", lease_until: "", next_attempt_at: "", provider_status_at: text(current.provider_status_at) || new Date().toISOString() });
      }
    });
    await createCommunicationEvent({ organization_id: org, message_id: message.id, delivery_id: leader.id, type: "provider.group_accepted", provider: "telnyx", payload: { group_message_id: groupId, recipient_count: members.length } });
    const { retryTelnyxWebhookEventsForObject } = await import("./telnyx_webhooks.js");
    await retryTelnyxWebhookEventsForObject(groupId);
  } catch (error) {
    const provider = error instanceof TelnyxError ? error : null;
    const unknown = attempted && (!provider || object(provider.details).submission_unknown === true);
    if (!unknown) for (const id of reserved) await releaseSms(org, id);
    const retry = Boolean(provider?.retryable) && !unknown && Number(leader.attempts) < env.smsDeliveryMaxAttempts;
    await patchAll(unknown ? "submission_unknown" : retry ? "retry_pending" : "failed",
      { code: unknown ? "group_mms_submission_unknown" : "group_mms_rejected", message: error instanceof Error ? error.message : String(error), automatic_resend: retry },
      retry ? new Date(Date.now() + Math.min(60000, 1000 * 2 ** Number(leader.attempts))).toISOString() : "");
    await createCommunicationEvent({ organization_id: org, message_id: message.id, delivery_id: leader.id, type: unknown ? "provider.submission_unknown" : "provider.group_rejected", provider: "telnyx", payload: { retry } });
  }
}
