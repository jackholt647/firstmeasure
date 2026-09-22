import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let root = "";
let compliance: typeof import("../messaging/storage.js");
let communications: typeof import("../messaging/communications_storage.js");
let webhooks: typeof import("../messaging/telnyx_webhooks.js");

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "firstmate-telnyx-state-test-"));
  process.env.NODE_ENV = "test";
  process.env.FIRSTMATE_ENV = "test";
  process.env.MESSAGING_STORAGE_ROOT = path.join(root, "messaging");
  process.env.MESSAGING_ENCRYPTION_KEY = "telnyx-state-test-encryption-key";
  process.env.COMMUNICATIONS_DELIVERY_MODE = "capture";
  compliance = await import("../messaging/storage.js");
  communications = await import("../messaging/communications_storage.js");
  webhooks = await import("../messaging/telnyx_webhooks.js");
});

after(async () => {
  (await communications.closeCommunicationsDatabase());
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function provisionedProfile(input: {
  organizationId: string;
  phoneNumber: string;
  campaignId: string;
  assignmentCampaignId?: string;
  assignmentStatus?: string;
  campaignStatus?: string;
  status?: string;
}) {
  const organization = await compliance.ensureMessagingOrganization(input.organizationId);
  const created = await compliance.createSmsComplianceProfile(organization);
  const configured = await compliance.updateSmsComplianceProfile(created, {
    status: input.status || "campaign_submitted",
    brand_status: "verified",
    campaign_status: input.campaignStatus || "mno_provisioned",
    phone_number_status: "success",
    phone_number_campaign_status: input.assignmentStatus || "unassigned",
    phone_number_campaign_id: input.assignmentCampaignId || "",
    brand: { displayName: `${input.organizationId} Brand` },
    campaign: {
      selectedNumber: input.phoneNumber,
      usecase: "AGENTS_FRANCHISES",
      enabledFeatures: ["operations"],
      optinKeywords: "START",
      optinMessage: `${input.organizationId} Brand: You are subscribed. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.`,
      optoutKeywords: "STOP",
      optoutMessage: `${input.organizationId} Brand: You are unsubscribed. Reply START to resubscribe.`,
      helpKeywords: "HELP",
      helpMessage: `${input.organizationId} Brand: Help at support@example.test. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.`
    },
    provider_refs: {
      telnyx_brand_id: `brand_${input.organizationId}`,
      telnyx_campaign_id: input.campaignId,
      tcr_campaign_id: `TCR_${input.organizationId}`,
      telnyx_messaging_profile_id: `messaging_${input.organizationId}`
    }
  });
  const { smsAutoresponsePlan } = await import("../messaging/autoresponses.js");
  const plan = smsAutoresponsePlan(configured);
  assert.equal(plan.ok, true);
  return await compliance.updateSmsComplianceProfile(configured, {
    autoresponse_state: {
      status: "configured",
      messaging_profile_id: `messaging_${input.organizationId}`,
      desired_hash: plan.hash,
      applied_hash: plan.hash,
      config_ids: { start: "autoresp-start", stop: "autoresp-stop", info: "autoresp-info" }
    }
  });
}

async function claim(profile: Awaited<ReturnType<typeof provisionedProfile>>, status = "ordered") {
  return (await communications.claimPhoneNumberOwnership({
    phone_number: String(profile.campaign.selectedNumber),
    organization_id: profile.external_organization_id,
    compliance_profile_id: profile.id,
    messaging_profile_id: String(profile.provider_refs.telnyx_messaging_profile_id),
    provider_phone_number_id: `phone_${profile.external_organization_id}`,
    status
  }));
}

async function latest(profile: Awaited<ReturnType<typeof provisionedProfile>>) {
  return await compliance.readSmsComplianceProfile(profile.messaging_organization_id, profile.id);
}

test("10DLC state mutations recompute against current state when independent provider events overlap", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_atomic_overlap",
    phoneNumber: "+12065550101",
    campaignId: "campaign_atomic_overlap",
    campaignStatus: "submitted",
    assignmentStatus: "unassigned"
  });
  assert.equal((await claim(profile)).claimed, true);

  await Promise.all([
    webhooks.processTenDlcEvent("event_atomic_campaign", "10dlc.campaign.update", "2026-07-10T18:00:00.000Z", {
      brandId: profile.provider_refs.telnyx_brand_id,
      campaignId: profile.provider_refs.telnyx_campaign_id,
      type: "VERIFIED",
      campaignStatus: "accepted"
    }),
    webhooks.processTenDlcEvent("event_atomic_assignment", "10dlc.phone_number.update", "2026-07-10T18:00:00.100Z", {
      phoneNumber: profile.campaign.selectedNumber,
      telnyxCampaignId: profile.provider_refs.telnyx_campaign_id,
      type: "assignment",
      assignmentStatus: "success"
    })
  ]);

  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_provisioned");
  assert.equal(saved.phone_number_campaign_status, "assigned");
  assert.equal(saved.phone_number_campaign_id, profile.provider_refs.telnyx_campaign_id);
  assert.equal(saved.status, "active");
  assert.equal((await communications.findPhoneNumberOwner(String(profile.campaign.selectedNumber)))?.status, "active");
});

test("an older 10DLC state event cannot overwrite a newer adverse provider state", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_stale_campaign",
    phoneNumber: "+12065550102",
    campaignId: "campaign_stale_campaign",
    assignmentCampaignId: "campaign_stale_campaign",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);

  await webhooks.processTenDlcEvent("event_campaign_rejected", "10dlc.campaign.update", "2026-07-10T19:00:00.000Z", {
    brandId: profile.provider_refs.telnyx_brand_id,
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "MNO_REVIEW",
    campaignStatus: "rejected"
  });
  await webhooks.processTenDlcEvent("event_campaign_old_verified", "10dlc.campaign.update", "2026-07-10T18:59:59.000Z", {
    brandId: profile.provider_refs.telnyx_brand_id,
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED",
    campaignStatus: "accepted"
  });
  await webhooks.processTenDlcEvent("event_campaign_second_old_verified", "10dlc.campaign.update", "2026-07-10T18:59:59.500Z", {
    brandId: profile.provider_refs.telnyx_brand_id,
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED",
    campaignStatus: "accepted"
  });

  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_rejected");
  assert.equal(saved.status, "provider_update_pending");
  const stale = saved.events.find((event) => event.provider_event_id === "event_campaign_old_verified");
  assert.equal(stale?.stale, true);
  const secondStale = saved.events.find((event) => event.provider_event_id === "event_campaign_second_old_verified");
  assert.equal(secondStale?.stale, true, "a stale marker must not lower the campaign state high-water timestamp");
});

test("adverse and intermediate TCR event subtypes always downgrade an active campaign", async () => {
  const cases = [
    { eventType: "CAMPAIGN_EXPIRED", expected: "tcr_expired" },
    { eventType: "MNO_CAMPAIGN_OPERATION_REJECTED", expected: "mno_rejected" },
    { eventType: "MNO_CAMPAIGN_OPERATION_SUSPENDED", expected: "tcr_suspended" },
    { eventType: "MNO_CAMPAIGN_OPERATION_APPROVED", expected: "mno_accepted" },
    { eventType: "MNO_CAMPAIGN_OPERATION_REVIEW", expected: "mno_pending" },
    { eventType: "MNO_CAMPAIGN_OPERATION_UNSUSPENDED", expected: "mno_pending" },
    { eventType: "CAMPAIGN_RESUBMISSION", expected: "tcr_pending" }
  ];

  for (const [index, item] of cases.entries()) {
    const profile = await provisionedProfile({
      organizationId: `org_tcr_subtype_${index}`,
      phoneNumber: `+120655502${String(index).padStart(2, "0")}`,
      campaignId: `campaign_tcr_subtype_${index}`,
      assignmentCampaignId: `campaign_tcr_subtype_${index}`,
      assignmentStatus: "assigned",
      status: "active"
    });
    assert.equal((await claim(profile, "active")).claimed, true);
    await webhooks.processTenDlcEvent(`event_tcr_subtype_${index}`, "10dlc.campaign.update", `2026-07-10T19:1${index}:00.000Z`, {
      campaignId: profile.provider_refs.telnyx_campaign_id,
      type: "TCR_EVENT",
      eventType: item.eventType
    });
    const saved = await latest(profile);
    assert.equal(saved.campaign_status, item.expected, item.eventType);
    assert.equal(saved.status, "provider_update_pending", item.eventType);
  }
});

test("carrier rejection does not reopen an already accepted campaign POST for duplication", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_operation_accepted",
    phoneNumber: "+12065550219",
    campaignId: "campaign_operation_accepted",
    assignmentCampaignId: "campaign_operation_accepted",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);
  const operation = (await communications.beginProviderOperation({
    organization_id: profile.external_organization_id,
    compliance_profile_id: profile.id,
    operation_type: "campaign_submission",
    request_hash: "accepted-campaign-request"
  }));
  assert.equal(operation.state, "created");
  (await communications.finishProviderOperation(String(operation.operation.id), {
    status: "succeeded",
    provider_id: profile.provider_refs.telnyx_campaign_id,
    response: { campaignId: profile.provider_refs.telnyx_campaign_id }
  }));

  await webhooks.processTenDlcEvent("event_accepted_operation_rejected", "10dlc.campaign.update", "2026-07-10T19:29:00.000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "MNO_CAMPAIGN_OPERATION_REJECTED"
  });
  assert.equal((await communications.findProviderOperation(profile.external_organization_id, profile.id, "campaign_submission"))?.status, "succeeded");
});

test("readiness loss cancels messages already scheduled at Telnyx", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_scheduled_cancel",
    phoneNumber: "+12065550218",
    campaignId: "campaign_scheduled_cancel",
    assignmentCampaignId: "campaign_scheduled_cancel",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);
  const adversePayload = {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "MNO_CAMPAIGN_OPERATION_SUSPENDED"
  };
  await webhooks.processTenDlcEvent("event_scheduled_campaign_suspended", "10dlc.campaign.update", "2026-07-10T19:29:30.000Z", adversePayload);
  // Simulate a crash after the profile state commit but before its scheduled
  // delivery cancellation side effect. Duplicate webhook replay must repair it.
  const message = (await communications.createMessageRecord({
    organization_id: profile.external_organization_id,
    channel: "sms",
    purpose: "appointment",
    text_body: "Scheduled reminder",
    sender: { address: profile.campaign.selectedNumber },
    recipients: [{ address: "+12065550999" }],
    scheduled_for: "2026-07-11T20:00:00.000Z"
  })).message;
  const delivery = (await communications.createDeliveryRecord({
    organization_id: profile.external_organization_id,
    message_id: message.id,
    channel: "sms",
    recipient_address: "+12065550999",
    provider: "telnyx",
    transport_mode: "live",
    provider_message_id: "telnyx-scheduled-cancel-1",
    status: "scheduled"
  }));

  await webhooks.processTenDlcEvent("event_scheduled_campaign_suspended", "10dlc.campaign.update", "2026-07-10T19:29:30.000Z", adversePayload);
  const cancelled = (await communications.readDeliveryRecord(profile.external_organization_id, String(delivery.id)));
  assert.equal(cancelled.status, "cancel_pending");
  assert.equal((cancelled.error as Record<string, unknown>).code, "sms_provider_compliance_not_ready");
});

test("registration failure and TELNYX DORMANT events disable sending", async () => {
  const registration = await provisionedProfile({
    organizationId: "org_registration_failed_event",
    phoneNumber: "+12065550220",
    campaignId: "campaign_registration_failed_event",
    assignmentCampaignId: "campaign_registration_failed_event",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(registration, "active")).claimed, true);
  await webhooks.processTenDlcEvent("event_registration_failed", "10dlc.campaign.update", "2026-07-10T19:30:00.000Z", {
    campaignId: registration.provider_refs.telnyx_campaign_id,
    type: "REGISTRATION",
    status: "failed"
  });
  assert.equal((await latest(registration)).campaign_status, "tcr_failed");
  assert.equal((await latest(registration)).status, "provider_update_pending");

  const dormant = await provisionedProfile({
    organizationId: "org_telnyx_dormant_event",
    phoneNumber: "+12065550221",
    campaignId: "campaign_telnyx_dormant_event",
    assignmentCampaignId: "campaign_telnyx_dormant_event",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(dormant, "active")).claimed, true);
  await webhooks.processTenDlcEvent("event_telnyx_dormant", "10dlc.campaign.update", "2026-07-10T19:31:00.000Z", {
    campaignId: dormant.provider_refs.telnyx_campaign_id,
    type: "TELNYX_EVENT",
    eventType: "DORMANT"
  });
  assert.equal((await latest(dormant)).campaign_status, "tcr_suspended");
  assert.equal((await latest(dormant)).status, "provider_update_pending");
});

test("only VERIFIED can reactivate an MNO-approved or unsuspended campaign", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_verified_only_activation",
    phoneNumber: "+12065550222",
    campaignId: "campaign_verified_only_activation",
    assignmentCampaignId: "campaign_verified_only_activation",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);

  await webhooks.processTenDlcEvent("event_mno_approved_not_ready", "10dlc.campaign.update", "2026-07-10T19:32:00.000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "MNO_CAMPAIGN_OPERATION_APPROVED"
  });
  assert.equal((await latest(profile)).campaign_status, "mno_accepted");
  assert.equal((await latest(profile)).status, "provider_update_pending");

  await webhooks.processTenDlcEvent("event_verified_final_ready", "10dlc.campaign.update", "2026-07-10T19:33:00.000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED"
  });
  assert.equal((await latest(profile)).campaign_status, "mno_provisioned");
  assert.equal((await latest(profile)).status, "active");
});

test("TCR and Telnyx campaign aliases share one stale-event ordering domain", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_alias_ordering",
    phoneNumber: "+12065550223",
    campaignId: "campaign_alias_ordering",
    assignmentCampaignId: "campaign_alias_ordering",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);

  await webhooks.processTenDlcEvent("event_alias_expired_newer", "10dlc.campaign.update", "2026-07-10T19:40:00.000Z", {
    campaignId: profile.provider_refs.tcr_campaign_id,
    type: "TCR_EVENT",
    eventType: "CAMPAIGN_EXPIRED"
  });
  await webhooks.processTenDlcEvent("event_alias_verified_older", "10dlc.campaign.update", "2026-07-10T19:39:59.000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED"
  });

  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "tcr_expired");
  assert.equal(saved.status, "provider_update_pending");
  assert.equal(saved.events.find((event) => event.provider_event_id === "event_alias_verified_older")?.stale, true);
});

test("Telnyx microsecond timestamps preserve adverse event ordering inside one millisecond", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_microsecond_ordering",
    phoneNumber: "+12065550224",
    campaignId: "campaign_microsecond_ordering",
    assignmentCampaignId: "campaign_microsecond_ordering",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);

  await webhooks.processTenDlcEvent("event_microsecond_verified_older", "10dlc.campaign.update", "2026-07-10T19:41:00.000100+00:00", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED"
  });
  await webhooks.processTenDlcEvent("event_microsecond_rejected_newer", "10dlc.campaign.update", "2026-07-10T19:41:00.000900+00:00", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "MNO_CAMPAIGN_OPERATION_REJECTED"
  });

  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_rejected");
  assert.equal(saved.status, "provider_update_pending");
});

test("an adverse event wins an exact occurred_at tie with VERIFIED", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_equal_clock",
    phoneNumber: "+12065550226",
    campaignId: "campaign_equal_clock",
    assignmentCampaignId: "campaign_equal_clock",
    assignmentStatus: "assigned",
    campaignStatus: "submitted",
    status: "provider_update_pending"
  });
  assert.equal((await claim(profile, "active")).claimed, true);
  const occurredAt = "2026-07-10T19:41:30.123456Z";

  await webhooks.processTenDlcEvent("event_equal_clock_verified", "10dlc.campaign.update", occurredAt, {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED"
  });
  assert.equal((await latest(profile)).status, "active");
  await webhooks.processTenDlcEvent("event_equal_clock_rejected", "10dlc.campaign.update", occurredAt, {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "MNO_CAMPAIGN_OPERATION_REJECTED"
  });

  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_rejected");
  assert.equal(saved.status, "provider_update_pending");
});

test("an explicit non-ready brand identity wins an exact occurred_at tie", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_brand_equal_clock",
    phoneNumber: "+12065550229",
    campaignId: "campaign_brand_equal_clock",
    assignmentCampaignId: "campaign_brand_equal_clock",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);
  const occurredAt = "2026-07-10T19:41:35.123456Z";
  await webhooks.processTenDlcEvent("event_brand_equal_verified", "10dlc.brand.update", occurredAt, {
    brandId: profile.provider_refs.telnyx_brand_id,
    identityStatus: "VERIFIED",
    status: "OK"
  });
  await webhooks.processTenDlcEvent("event_brand_equal_unverified", "10dlc.brand.update", occurredAt, {
    brandId: profile.provider_refs.telnyx_brand_id,
    identityStatus: "UNVERIFIED",
    status: "OK"
  });
  const saved = await latest(profile);
  assert.equal(saved.brand_status, "unverified");
  assert.equal(saved.status, "provider_update_pending");
});

test("unknown event types cannot claim MNO_PROVISIONED without VERIFIED", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_unverified_provisioned",
    phoneNumber: "+12065550227",
    campaignId: "campaign_unverified_provisioned",
    assignmentCampaignId: "campaign_unverified_provisioned",
    assignmentStatus: "assigned",
    campaignStatus: "submitted",
    status: "provider_update_pending"
  });
  assert.equal((await claim(profile, "active")).claimed, true);

  await webhooks.processTenDlcEvent("event_unverified_provisioned", "10dlc.campaign.update", "2026-07-10T19:41:40.000000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TELNYX_EVENT",
    eventType: "UNRECOGNIZED_INFORMATIONAL_EVENT",
    campaignStatus: "MNO_PROVISIONED"
  });
  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_pending");
  assert.equal(saved.status, "provider_update_pending");
});

test("10DLC state events without a valid occurred_at are quarantined instead of applied", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_invalid_clock",
    phoneNumber: "+12065550228",
    campaignId: "campaign_invalid_clock",
    assignmentCampaignId: "campaign_invalid_clock",
    assignmentStatus: "assigned",
    campaignStatus: "mno_rejected",
    status: "provider_update_pending"
  });
  assert.equal((await claim(profile, "active")).claimed, true);
  const before = await latest(profile);

  for (const [index, occurredAt] of ["", "not-a-timestamp", "2026-07-10"].entries()) {
    await assert.rejects(
      () => webhooks.processTenDlcEvent(`event_invalid_clock_${index}`, "10dlc.campaign.update", occurredAt, {
        campaignId: profile.provider_refs.telnyx_campaign_id,
        type: "VERIFIED"
      }),
      /valid RFC 3339 occurred_at/
    );
  }
  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_rejected");
  assert.equal(saved.status, "provider_update_pending");
  assert.equal(saved.events.length, before.events.length);
});

test("an expired campaign cannot be reactivated by a later VERIFIED event", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_expired_terminal",
    phoneNumber: "+12065550225",
    campaignId: "campaign_expired_terminal",
    assignmentCampaignId: "campaign_expired_terminal",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);

  await webhooks.processTenDlcEvent("event_campaign_terminal_expired", "10dlc.campaign.update", "2026-07-10T19:42:00.000000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "CAMPAIGN_EXPIRED"
  });
  await webhooks.processTenDlcEvent("event_campaign_verified_after_expiry", "10dlc.campaign.update", "2026-07-10T19:43:00.000000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED"
  });

  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "tcr_expired");
  assert.equal(saved.status, "provider_update_pending");
});

test("provider events cannot reactivate an administratively deactivating profile", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_deactivation_pending_event",
    phoneNumber: "+12065550230",
    campaignId: "campaign_deactivation_pending_event",
    assignmentCampaignId: "campaign_deactivation_pending_event",
    assignmentStatus: "assigned",
    campaignStatus: "submitted",
    status: "deactivation_pending"
  });
  assert.equal((await claim(profile, "active")).claimed, true);
  await webhooks.processTenDlcEvent("event_verified_during_deactivation", "10dlc.campaign.update", "2026-07-10T19:44:00.000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED"
  });
  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_provisioned");
  assert.equal(saved.status, "deactivation_pending");
});

test("replacement campaigns cannot inherit or receive an old campaign's number assignment", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_replacement",
    phoneNumber: "+12065550103",
    campaignId: "campaign_replacement_new",
    assignmentCampaignId: "campaign_replacement_old",
    assignmentStatus: "assigned",
    status: "provider_update_pending"
  });
  assert.equal((await claim(profile)).claimed, true);

  await webhooks.processTenDlcEvent("event_replacement_verified", "10dlc.campaign.update", "2026-07-10T20:00:00.000Z", {
    brandId: profile.provider_refs.telnyx_brand_id,
    campaignId: "campaign_replacement_new",
    type: "VERIFIED",
    campaignStatus: "accepted"
  });
  assert.equal((await latest(profile)).status, "provider_update_pending");

  await assert.rejects(
    () => webhooks.processTenDlcEvent("event_old_assignment", "10dlc.phone_number.update", "2026-07-10T20:00:01.000Z", {
      phoneNumber: profile.campaign.selectedNumber,
      telnyxCampaignId: "campaign_replacement_old",
      type: "assignment",
      assignmentStatus: "success"
    }),
    /does not match current campaign/
  );
  assert.equal((await latest(profile)).phone_number_campaign_id, "campaign_replacement_old");

  await webhooks.processTenDlcEvent("event_new_assignment", "10dlc.phone_number.update", "2026-07-10T20:00:02.000Z", {
    phoneNumber: profile.campaign.selectedNumber,
    telnyxCampaignId: "campaign_replacement_new",
    type: "assignment",
    assignmentStatus: "success"
  });
  const saved = await latest(profile);
  assert.equal(saved.phone_number_campaign_id, "campaign_replacement_new");
  assert.equal(saved.status, "active");
});

test("a provisioned status event cannot activate a profile that no longer owns its selected number", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_lost_number_owner",
    phoneNumber: "+12065550106",
    campaignId: "campaign_lost_number_owner",
    assignmentCampaignId: "campaign_lost_number_owner",
    assignmentStatus: "assigned",
    campaignStatus: "submitted",
    status: "provider_update_pending"
  });
  const conflictingOwner = (await communications.claimPhoneNumberOwnership({
    phone_number: profile.campaign.selectedNumber,
    organization_id: "org_different_current_owner",
    compliance_profile_id: "profile_different_current_owner",
    messaging_profile_id: "messaging_different_current_owner",
    status: "active"
  }));
  assert.equal(conflictingOwner.claimed, true);

  await webhooks.processTenDlcEvent("event_no_longer_owned_verified", "10dlc.campaign.update", "2026-07-10T20:30:00.000Z", {
    brandId: profile.provider_refs.telnyx_brand_id,
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED",
    campaignStatus: "accepted"
  });

  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_provisioned");
  assert.equal(saved.status, "provider_update_pending");
  assert.equal((await communications.findPhoneNumberOwner(String(profile.campaign.selectedNumber)))?.organization_id, "org_different_current_owner");
});

test("phone-number webhooks follow current ownership after a released number is reacquired", async () => {
  const phoneNumber = "+12065550104";
  const historical = await provisionedProfile({
    organizationId: "org_released_number_old",
    phoneNumber,
    campaignId: "campaign_released_number_old",
    assignmentCampaignId: "campaign_released_number_old",
    assignmentStatus: "unassigned",
    status: "deactivated"
  });
  const current = await provisionedProfile({
    organizationId: "org_released_number_new",
    phoneNumber,
    campaignId: "campaign_released_number_new",
    assignmentStatus: "unassigned"
  });
  assert.equal((await claim(current)).claimed, true);

  await webhooks.processTenDlcEvent("event_reacquired_assignment", "10dlc.phone_number.update", "2026-07-10T21:00:00.000Z", {
    phoneNumber,
    telnyxCampaignId: "campaign_released_number_new",
    type: "assignment",
    assignmentStatus: "success"
  });

  const oldSaved = await latest(historical);
  const newSaved = await latest(current);
  assert.equal(oldSaved.phone_number_campaign_status, "unassigned");
  assert.equal(oldSaved.events.some((event) => event.provider_event_id === "event_reacquired_assignment"), false);
  assert.equal(newSaved.phone_number_campaign_status, "assigned");
  assert.equal(newSaved.phone_number_campaign_id, "campaign_released_number_new");
  assert.equal(newSaved.status, "active");
});

test("late CAMPAIGN_BILLED events retain tenant identity but remain unpriced pending reconciliation", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_late_campaign_bill",
    phoneNumber: "+12065550105",
    campaignId: "campaign_current_after_supersession",
    campaignStatus: "submitted",
    status: "deactivated"
  });
  (await communications.upsertBillingCommitment({
    organization_id: profile.external_organization_id,
    provider: "telnyx",
    resource_type: "campaign",
    resource_id: "campaign_superseded_but_billed",
    amount: "10.00",
    currency: "USD",
    billing_interval: "month",
    status: "active",
    metadata: { compliance_profile_id: profile.id }
  }));
  (await communications.endBillingCommitment("telnyx", "campaign", "campaign_superseded_but_billed", "2026-07-01T00:00:00.000Z"));
  const before = await latest(profile);

  await webhooks.processTenDlcEvent("event_late_campaign_bill", "10dlc.campaign.update", "2026-07-10T22:00:00.000Z", {
    campaignId: "campaign_superseded_but_billed",
    type: "TCR_EVENT",
    eventType: "CAMPAIGN_BILLED"
  });

  const usage = (await communications.listUsageEvents(profile.external_organization_id, { direction: "campaign_billing_notice" }));
  assert.equal(usage.length, 1);
  const charge = usage[0]!;
  assert.equal(charge.provider_message_id, "campaign_superseded_but_billed");
  assert.equal(charge.amount, "0");
  assert.equal((charge.metadata as Record<string, unknown>).commitment_status, "ended");
  assert.equal((charge.metadata as Record<string, unknown>).unpriced, true);
  assert.equal((charge.metadata as Record<string, unknown>).reconciliation_required, true);
  assert.equal((charge.metadata as Record<string, unknown>).monetary_usage_recorded, false);
  const afterProfile = await latest(profile);
  assert.equal(afterProfile.status, before.status);
  assert.equal(afterProfile.events.length, before.events.length);
});

test("actual campaign resubmission events meter one idempotent carrier review fee", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_campaign_resubmission_review",
    phoneNumber: "+12065550107",
    campaignId: "campaign_resubmission_review",
    assignmentCampaignId: "campaign_resubmission_review",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile)).claimed, true);
  const payload = {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "CAMPAIGN_RESUBMISSION"
  };

  await webhooks.processTenDlcEvent("event_campaign_resubmission_review", "10dlc.campaign.update", "2026-07-10T23:00:00.000Z", payload);
  await webhooks.processTenDlcEvent("event_campaign_resubmission_review", "10dlc.campaign.update", "2026-07-10T23:00:00.000Z", payload);

  const usage = (await communications.listUsageEvents(profile.external_organization_id, { direction: "campaign_review" }));
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.provider_message_id, profile.provider_refs.telnyx_campaign_id);
  assert.equal(usage[0]?.amount, "15.00");
  assert.equal((usage[0]?.metadata as Record<string, unknown>)?.review_kind, "resubmission");
  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "tcr_pending");
  assert.equal(saved.status, "provider_update_pending");
});

test("an out-of-order campaign resubmission still meters its idempotent review fee", async () => {
  const profile = await provisionedProfile({
    organizationId: "org_stale_campaign_resubmission_review",
    phoneNumber: "+12065550108",
    campaignId: "campaign_stale_resubmission_review",
    assignmentCampaignId: "campaign_stale_resubmission_review",
    assignmentStatus: "assigned",
    status: "active"
  });
  assert.equal((await claim(profile, "active")).claimed, true);
  await webhooks.processTenDlcEvent("event_state_after_resubmission", "10dlc.campaign.update", "2026-07-10T23:10:00.000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "VERIFIED"
  });
  await webhooks.processTenDlcEvent("event_stale_campaign_resubmission_review", "10dlc.campaign.update", "2026-07-10T23:00:00.000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "CAMPAIGN_RESUBMISSION"
  });
  await webhooks.processTenDlcEvent("event_stale_campaign_resubmission_review", "10dlc.campaign.update", "2026-07-10T23:00:00.000Z", {
    campaignId: profile.provider_refs.telnyx_campaign_id,
    type: "TCR_EVENT",
    eventType: "CAMPAIGN_RESUBMISSION"
  });

  const usage = (await communications.listUsageEvents(profile.external_organization_id, { direction: "campaign_review" }));
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.amount, "15.00");
  const saved = await latest(profile);
  assert.equal(saved.campaign_status, "mno_provisioned");
  assert.equal(saved.status, "active");
  assert.equal(saved.events.find((event) => event.provider_event_id === "event_stale_campaign_resubmission_review")?.stale, true);
});
