import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await app.inject({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-messaging-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.TELNYX_API_KEY = "";
  process.env.TELNYX_BASE_URL = "https://api.telnyx.com/v2";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  if (app) await app.close();
  await closePlatformFixtureStores();
  await closeSqlStoresForTests();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>, smsSettings = true) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(), 
    email: `sms-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "SMS Owner",
    company: "SMS Test Org",
    organization_id: `org_sms_${suffix}`,
    global: {
      app_flags: {
        platform: { sms_settings: smsSettings }
      }
    }
  });
  await enableExpandedPlatformFixture(String(data.organization.id));
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(data.organization.id, {
    data: {
      app_flags: {
        platform: { expanded_access: true, sms_settings: smsSettings }
      }
    }
  });
  return { orgId: data.organization.id as string };
}

async function createAutoresponseProfile(externalOrganizationId: string, suffix: string) {
  const { createSmsComplianceProfile, ensureMessagingOrganization, updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const organization = await ensureMessagingOrganization(externalOrganizationId);
  const created = await createSmsComplianceProfile(organization);
  return await updateSmsComplianceProfile(created, {
    brand: { displayName: "Acme Roofing" },
    campaign: {
      optinKeywords: "START, JOIN",
      optinMessage: "Acme Roofing: You are subscribed. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
      optoutKeywords: "STOP",
      optoutMessage: "Acme Roofing: You are unsubscribed. Reply START to resubscribe.",
      helpKeywords: "HELP",
      helpMessage: "Acme Roofing: Help at 206-555-0100. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out."
    },
    provider_refs: { telnyx_messaging_profile_id: `messaging-${suffix}` }
  });
}

test("Messaging API reports Telnyx config without exposing secrets", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/v1/messaging/telnyx/config" });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const client = createSessionClient();
  await register(client);
  const body = await client.request("GET", "/v1/messaging/telnyx/config");
  assert.equal(body.ok, true);
  assert.equal(body.provider, "telnyx");
  assert.equal(body.configured, false);
  assert.equal(Object.hasOwn(body, "api_key"), false);
  assert.equal(Object.hasOwn(body, "base_url"), false);
});

test("live messaging startup fails closed when consent enforcement is disabled", async () => {
  const { env } = await import("../src/config/env.js");
  const { buildApp } = await import("../src/app.js");
  const previous = {
    mode: env.communicationsDeliveryMode,
    key: env.telnyxApiKey,
    publicKey: env.telnyxWebhookPublicKey,
    webhookUrl: env.telnyxWebhookUrl,
    encryptionKey: env.messagingEncryptionKey,
    requireConsent: env.smsRequireConsent
  };
  let unsafeApp: any = null;
  try {
    (env as any).communicationsDeliveryMode = "live";
    (env as any).telnyxApiKey = "KEY_TEST";
    (env as any).telnyxWebhookPublicKey = "test-public-key";
    (env as any).telnyxWebhookUrl = "https://app.1m8.ai/v1/messaging/webhooks/telnyx";
    (env as any).messagingEncryptionKey = "test-encryption-key";
    (env as any).smsRequireConsent = false;
    unsafeApp = await buildApp();
    await assert.rejects(() => unsafeApp.ready(), /SMS_REQUIRE_CONSENT=true/);
  } finally {
    if (unsafeApp) await unsafeApp.close().catch(() => undefined);
    (env as any).communicationsDeliveryMode = previous.mode;
    (env as any).telnyxApiKey = previous.key;
    (env as any).telnyxWebhookPublicKey = previous.publicKey;
    (env as any).telnyxWebhookUrl = previous.webhookUrl;
    (env as any).messagingEncryptionKey = previous.encryptionKey;
    (env as any).smsRequireConsent = previous.requireConsent;
  }
});

test("Telnyx client sends bearer auth and lists messaging profiles", async () => {
  const { createTelnyxClient } = await import("../messaging/telnyx.js");
  const requests: { url: string; authorization: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      authorization: headers.get("authorization") ?? ""
    });
    return new Response(JSON.stringify({
      data: [{
        id: "40000000-0000-0000-0000-000000000001",
        name: "FirstMate Test Profile",
        enabled: true,
        webhook_url: "https://example.test/webhooks/telnyx/messaging"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const client = createTelnyxClient({
    apiKey: "KEY_TEST",
    baseUrl: "https://api.telnyx.com/v2/",
    fetchImpl
  });

  const profiles = await client.listMessagingProfiles();
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, "https://api.telnyx.com/v2/messaging_profiles?page[size]=10");
  assert.equal(request.authorization, "Bearer KEY_TEST");
  assert.deepEqual(profiles, [{
    id: "40000000-0000-0000-0000-000000000001",
    name: "FirstMate Test Profile",
    enabled: true,
    webhook_url: "https://example.test/webhooks/telnyx/messaging"
  }]);
});

test("Telnyx client uses the documented auto-response list, create, update, and delete contracts", async () => {
  const { createTelnyxClient } = await import("../messaging/telnyx.js");
  const requests: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url: String(input), body });
    if (method === "GET") {
      return new Response(JSON.stringify({
        data: [{ id: "autoresp-start", op: "start", keywords: ["START", "UNSTOP"], country_code: "US", resp_text: "You are subscribed to updates." }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "DELETE") return new Response(JSON.stringify("OK"), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ data: { id: "autoresp-write", ...body } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = createTelnyxClient({ apiKey: "KEY_TEST", baseUrl: "https://api.telnyx.com/v2", fetchImpl });
  const desired = { op: "info", keywords: ["HELP", "INFO"], country_code: "US", resp_text: "Contact Acme support for assistance." };

  const listed = await client.listMessagingProfileAutorespConfigs("profile-1", "US");
  await client.createMessagingProfileAutorespConfig("profile-1", desired);
  await client.updateMessagingProfileAutorespConfig("profile-1", "autoresp-info", desired);
  await client.deleteMessagingProfileAutorespConfig("profile-1", "autoresp-info");

  assert.equal(listed[0]?.op, "start");
  assert.deepEqual(requests, [
    { method: "GET", url: "https://api.telnyx.com/v2/messaging_profiles/profile-1/autoresp_configs?country_code=US", body: null },
    { method: "POST", url: "https://api.telnyx.com/v2/messaging_profiles/profile-1/autoresp_configs", body: desired },
    { method: "PUT", url: "https://api.telnyx.com/v2/messaging_profiles/profile-1/autoresp_configs/autoresp-info", body: desired },
    { method: "DELETE", url: "https://api.telnyx.com/v2/messaging_profiles/profile-1/autoresp_configs/autoresp-info", body: null }
  ]);
});

test("Telnyx client keeps v2 base path for 10DLC requests", async () => {
  const { createTelnyxClient } = await import("../messaging/telnyx.js");
  const requests: { url: string; authorization: string; body: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      authorization: headers.get("authorization") ?? "",
      body: String(init?.body ?? "")
    });
    return new Response(JSON.stringify({
      brandId: "BMOCK123",
      mock: true
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const client = createTelnyxClient({
    apiKey: "KEY_TEST",
    baseUrl: "https://api.telnyx.com/v2/",
    fetchImpl
  });

  const response = await client.create10DlcBrand({ displayName: "Mock Brand", mock: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.telnyx.com/v2/10dlc/brand");
  assert.equal(requests[0]?.authorization, "Bearer KEY_TEST");
  assert.deepEqual(response, { brandId: "BMOCK123", mock: true });
});

test("Telnyx client exposes every exact deterministic Messaging Profile match and treats POST 5xx as ambiguous", async () => {
  const { createTelnyxClient, TelnyxError } = await import("../messaging/telnyx.js");
  const requestedUrls: string[] = [];
  const name = "FirstMate org_profile deterministic";
  const listClient = createTelnyxClient({
    apiKey: "KEY_TEST",
    baseUrl: "https://api.telnyx.com/v2/",
    fetchImpl: (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({
        data: [
          { id: "profile-match-a", name, enabled: true, webhook_url: "https://example.test/webhook" },
          { id: "profile-match-b", name, enabled: true, webhook_url: "https://example.test/webhook" },
          { id: "profile-near-match", name: `${name} extra`, enabled: true, webhook_url: "https://example.test/webhook" }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });
  const matches = await listClient.listMessagingProfilesByName(name, 100);
  assert.deepEqual(matches.map((entry) => entry.id), ["profile-match-a", "profile-match-b"]);
  assert.equal(requestedUrls[0], `https://api.telnyx.com/v2/messaging_profiles?filter[name][eq]=${encodeURIComponent(name)}&page[size]=100`);

  const ambiguousPostClient = createTelnyxClient({
    apiKey: "KEY_TEST",
    fetchImpl: (async () => new Response(JSON.stringify({ errors: [{ code: "temporary" }] }), {
      status: 503,
      headers: { "content-type": "application/json" }
    })) as typeof fetch
  });
  await assert.rejects(
    () => ambiguousPostClient.createMessagingProfile({ name }),
    (error: unknown) => {
      assert.ok(error instanceof TelnyxError);
      assert.equal((error.details as Record<string, unknown>).submission_unknown, true);
      return true;
    }
  );
});

test("registered 10DLC use cases default-deny every mismatched SMS purpose", async () => {
  const { outboundSmsComplianceIssue, smsConsentPurposesAllow } = await import("../messaging/compliance_rules.js");
  const generalPurposes = ["customer_care", "transactional", "appointment", "project_update", "billing", "marketing"];
  const specialized = new Map<string, string>([
    ["ACCOUNT_NOTIFICATION", "account_notification"],
    ["CUSTOMER_CARE", "customer_care"],
    ["DELIVERY_NOTIFICATION", "delivery_notification"],
    ["FRAUD_ALERT", "fraud_alert"],
    ["HIGHER_EDUCATION", "higher_education"],
    ["MARKETING", "marketing"],
    ["POLLING_VOTING", "polling_voting"],
    ["PUBLIC_SERVICE_ANNOUNCEMENT", "public_service_announcement"],
    ["SECURITY_ALERT", "security_alert"],
    ["2FA", "two_factor_auth"]
  ]);
  const everyPurpose = [...generalPurposes, ...new Set(specialized.values())];
  const text = "Acme update. Reply STOP to opt out.";

  for (const [usecase, registeredPurpose] of specialized) {
    const profile = { brand: { displayName: "Acme" }, campaign: { usecase, enabledFeatures: [] } };
    for (const purpose of everyPurpose) {
      const issue = outboundSmsComplianceIssue(profile, purpose, text);
      assert.equal(issue === null, purpose === registeredPurpose, `${usecase} unexpectedly ${issue ? "blocked" : "allowed"} ${purpose}`);
    }
  }

  for (const usecase of ["AGENTS_FRANCHISES", "MIXED", "SOLE_PROPRIETOR"]) {
    const profile = { brand: { displayName: "Acme" }, campaign: { usecase, enabledFeatures: ["crm_conversations", "operations", "customer_growth"] } };
    for (const purpose of everyPurpose) {
      const issue = outboundSmsComplianceIssue(profile, purpose, text);
      assert.equal(issue === null, generalPurposes.includes(purpose), `${usecase} unexpectedly ${issue ? "blocked" : "allowed"} ${purpose}`);
    }
  }

  assert.equal(outboundSmsComplianceIssue({ brand: {}, campaign: { usecase: "UNMAPPED" } }, "transactional", text)?.code, "sms_purpose_not_registered");
  assert.equal(outboundSmsComplianceIssue({ brand: {}, campaign: { usecase: "AGENTS_FRANCHISES", enabledFeatures: [] } }, "customer_care", text)?.code, "sms_purpose_not_registered");
  assert.equal(smsConsentPurposesAllow(["customer_care"], "appointment"), false);
  assert.equal(smsConsentPurposesAllow(["appointment"], "appointment"), true);
  assert.equal(smsConsentPurposesAllow(["transactional"], "two_factor_auth"), false);
  assert.equal(smsConsentPurposesAllow(["two_factor_auth"], "two_factor_auth"), true);
});

test("10DLC provider fees separate brand, prepaid subscription, and campaign review costs", async () => {
  const { env } = await import("../src/config/env.js");
  const { recordBrandRegistrationFee, recordCampaignRegistrationFee } = await import("../messaging/api.js");
  const { findBillingCommitment, listUsageEvents } = await import("../messaging/communications_storage.js");
  const previous = {
    mode: env.communicationsDeliveryMode,
    standardBrand: env.telnyxStandardBrandRegistrationFeeUsd,
    soleBrand: env.telnyxSoleProprietorBrandRegistrationFeeUsd,
    campaignReview: env.telnyxCampaignReviewFeeUsd
  };
  const suffix = `${Date.now()}_${Math.random()}`;
  const organizationId = `org_cost_${suffix}`;
  const standardBrandId = `brand_standard_${suffix}`;
  const soleBrandId = `brand_sole_${suffix}`;
  const campaignId = `campaign_${suffix}`;
  try {
    (env as any).communicationsDeliveryMode = "live";
    (env as any).telnyxStandardBrandRegistrationFeeUsd = "4.50";
    (env as any).telnyxSoleProprietorBrandRegistrationFeeUsd = "4.00";
    (env as any).telnyxCampaignReviewFeeUsd = "15.00";

    (await recordBrandRegistrationFee(organizationId, standardBrandId, "profile-cost", "PRIVATE_PROFIT"));
    (await recordBrandRegistrationFee(organizationId, soleBrandId, "profile-cost", "SOLE_PROPRIETOR", false));
    (await recordBrandRegistrationFee(organizationId, soleBrandId, "profile-cost", "SOLE_PROPRIETOR", true));
    (await recordCampaignRegistrationFee(organizationId, campaignId, "profile-cost", {
      quarterlyFee: 90,
      monthlyFee: 30,
      annualFee: 360
    }, null));

    const events = (await listUsageEvents(organizationId, { limit: 20 }));
    const standardBrand = events.find((entry) => entry.provider_message_id === standardBrandId);
    const soleBrand = events.find((entry) => entry.provider_message_id === soleBrandId);
    const initialSubscription = events.find((entry) => entry.direction === "campaign_subscription_initial");
    const initialReview = events.find((entry) => entry.direction === "campaign_review");
    assert.equal(standardBrand?.amount, "4.50");
    assert.equal(soleBrand?.amount, "4.00");
    assert.equal(initialSubscription?.amount, "90");
    assert.equal(initialReview?.amount, "15.00");
    assert.equal(events.filter((entry) => entry.provider_message_id === soleBrandId).length, 1);

    const commitment = (await findBillingCommitment("telnyx", "campaign", campaignId)) as Record<string, any> | null;
    assert.equal(commitment?.amount, "30");
    assert.equal(commitment?.billing_interval, "month");
    assert.ok(Date.parse(String(commitment?.starts_at)) > Date.now() + 75 * 24 * 60 * 60_000);
    assert.equal((commitment?.metadata as Record<string, unknown>)?.initial_quarter_prepaid, true);
  } finally {
    (env as any).communicationsDeliveryMode = previous.mode;
    (env as any).telnyxStandardBrandRegistrationFeeUsd = previous.standardBrand;
    (env as any).telnyxSoleProprietorBrandRegistrationFeeUsd = previous.soleBrand;
    (env as any).telnyxCampaignReviewFeeUsd = previous.campaignReview;
  }
});

test("phone number ownership cannot be reassigned across organizations", async () => {
  const { claimPhoneNumberOwnership } = await import("../messaging/communications_storage.js");
  const phoneNumber = "+12065550009";
  const first = (await claimPhoneNumberOwnership({
    phone_number: phoneNumber,
    organization_id: "org_number_owner_a",
    compliance_profile_id: "profile_a",
    messaging_profile_id: "messaging_profile_a",
    provider_phone_number_id: "provider_phone_a",
    status: "active"
  }));
  assert.equal(first.claimed, true);

  const second = (await claimPhoneNumberOwnership({
    phone_number: phoneNumber,
    organization_id: "org_number_owner_b",
    compliance_profile_id: "profile_b",
    messaging_profile_id: "messaging_profile_b",
    status: "pending"
  }));
  assert.equal(second.claimed, false);
  assert.equal(second.owner.organization_id, "org_number_owner_a");
  assert.equal(second.owner.compliance_profile_id, "profile_a");
  assert.equal(second.owner.provider_phone_number_id, "provider_phone_a");
});

test("provider operations serialize active work and recover stale pending work as outcome unknown", async () => {
  const { beginProviderOperation, finishProviderOperation, getCommunicationsDatabase } = await import("../messaging/communications_storage.js");
  const suffix = `${Date.now()}_${Math.random()}`;
  const input = {
    organization_id: `org_provider_operation_${suffix}`,
    compliance_profile_id: `profile_provider_operation_${suffix}`,
    operation_type: "campaign_submission",
    request_hash: "request-a"
  };
  const created = (await beginProviderOperation(input));
  assert.equal(created.state, "created");
  assert.equal((await beginProviderOperation(input)).state, "pending");

  (await getCommunicationsDatabase().prepare("UPDATE messaging_provider_operations SET updated_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", String(created.operation.id)));
  const recovered = (await beginProviderOperation(input));
  assert.equal(recovered.state, "outcome_unknown");
  assert.equal("recovered_stale" in recovered && recovered.recovered_stale, true);
  assert.equal((await beginProviderOperation(input)).state, "outcome_unknown");
  assert.equal((await beginProviderOperation({ ...input, request_hash: "request-b" })).state, "conflict");

  const changedInput = { ...input, compliance_profile_id: `${input.compliance_profile_id}_changed`, request_hash: "request-original" };
  const changedCreated = (await beginProviderOperation(changedInput));
  (await getCommunicationsDatabase().prepare("UPDATE messaging_provider_operations SET updated_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", String(changedCreated.operation.id)));
  const staleConflict = (await beginProviderOperation({ ...changedInput, request_hash: "request-new" }));
  assert.equal(staleConflict.state, "conflict");
  const persisted = (await getCommunicationsDatabase().prepare("SELECT status FROM messaging_provider_operations WHERE id = ?")
    .get(String(changedCreated.operation.id))) as { status: string };
  assert.equal(persisted.status, "outcome_unknown");

  const laneBase = {
    organization_id: `org_provider_lane_${suffix}`,
    compliance_profile_id: `profile_provider_lane_${suffix}`,
    exclusive_operation_prefixes: ["campaign_submission", "campaign_replacement", "campaign_appeal"]
  };
  const appeal = (await beginProviderOperation({
    ...laneBase,
    operation_type: "campaign_appeal_generation_reason",
    request_hash: "appeal-request"
  }));
  assert.equal(appeal.state, "created");
  const replacementBlocked = (await beginProviderOperation({
    ...laneBase,
    operation_type: "campaign_replacement_revision",
    request_hash: "replacement-request"
  }));
  assert.equal(replacementBlocked.state, "conflict", "appeal and paid replacement operations must share one atomic campaign mutation lane");
  (await finishProviderOperation(String(appeal.operation.id), { status: "failed", error: { code: "test_complete" } }));
  assert.equal((await beginProviderOperation({
    ...laneBase,
    operation_type: "campaign_replacement_revision",
    request_hash: "replacement-request"
  })).state, "created");
});

test("billable provider operations acquire against one immutable profile revision", async () => {
  const { beginProviderOperation, findProviderOperation } = await import("../messaging/communications_storage.js");
  const { createSmsComplianceProfile, ensureMessagingOrganization, updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const suffix = `${Date.now()}_${Math.random()}`;
  const organizationId = `org_revision_lock_${suffix}`;
  const organization = await ensureMessagingOrganization(organizationId);
  const profile = await createSmsComplianceProfile(organization, { brand: { displayName: "Before" } });
  const oldRevision = profile.updated_at;
  await updateSmsComplianceProfile(profile, { brand: { displayName: "After" } });

  const operation = (await beginProviderOperation({
    organization_id: organizationId,
    compliance_profile_id: profile.id,
    operation_type: "brand_submission",
    request_hash: "stale-brand-payload",
    profile_updated_at: oldRevision
  }));
  assert.equal(operation.state, "profile_changed");
  assert.equal((await findProviderOperation(organizationId, profile.id, "brand_submission")), null);
});

test("organization Messaging Profile creation is serialized and ambiguous POSTs reconcile by deterministic name", async () => {
  const { ensureOrganizationTelnyxProfile } = await import("../messaging/api.js");
  const { createSmsComplianceProfile, ensureMessagingOrganization } = await import("../messaging/storage.js");
  const { TelnyxError } = await import("../messaging/telnyx.js");
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const organization = await ensureMessagingOrganization(`org_profile_serial_${suffix}`);
  const profile = await createSmsComplianceProfile(organization);
  let releaseList!: () => void;
  let reportListStarted!: () => void;
  const listStarted = new Promise<void>((resolve) => { reportListStarted = resolve; });
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  let listCalls = 0;
  let createCalls = 0;
  let updateCalls = 0;
  const serializedClient = {
    async listMessagingProfilesByName() {
      listCalls += 1;
      reportListStarted();
      await listGate;
      return [];
    },
    async createMessagingProfile() {
      createCalls += 1;
      return { data: { id: `telnyx-profile-${suffix}` } };
    },
    async updateMessagingProfile() {
      updateCalls += 1;
      return { data: { id: `telnyx-profile-${suffix}` } };
    }
  } as any;

  const first = ensureOrganizationTelnyxProfile(profile, serializedClient);
  await listStarted;
  const concurrent = ensureOrganizationTelnyxProfile(profile, serializedClient);
  await assert.rejects(concurrent, (error: any) => {
    assert.equal(error.code, "provider_operation_in_progress");
    return true;
  });
  releaseList();
  const provisioned = await first;
  assert.equal(listCalls, 1);
  assert.equal(createCalls, 1);
  assert.equal(provisioned.messagingProfileId, `telnyx-profile-${suffix}`);
  assert.equal((provisioned.profile.provider_refs as Record<string, unknown>).telnyx_messaging_profile_id, `telnyx-profile-${suffix}`);
  await ensureOrganizationTelnyxProfile(provisioned.profile, serializedClient);
  assert.equal(updateCalls, 1);

  const ambiguousOrganization = await ensureMessagingOrganization(`org_profile_ambiguous_${suffix}`);
  const ambiguousProfile = await createSmsComplianceProfile(ambiguousOrganization);
  let deterministicName = "";
  let ambiguousCreateCalls = 0;
  const timeoutClient = {
    async listMessagingProfilesByName(name: string) {
      deterministicName = name;
      return [];
    },
    async createMessagingProfile() {
      ambiguousCreateCalls += 1;
      throw new TelnyxError("Timed out after provider submission.", 502, { submission_unknown: true });
    },
    async updateMessagingProfile() {
      throw new Error("update should not run before reconciliation");
    }
  } as any;
  await assert.rejects(() => ensureOrganizationTelnyxProfile(ambiguousProfile, timeoutClient), TelnyxError);

  let reconcileUpdateCalls = 0;
  const reconcileClient = {
    async listMessagingProfilesByName(name: string) {
      assert.equal(name, deterministicName);
      return [{ id: `telnyx-profile-reconciled-${suffix}`, name, enabled: true, webhook_url: "" }];
    },
    async createMessagingProfile() {
      throw new Error("ambiguous reconciliation must not issue another POST");
    },
    async updateMessagingProfile() {
      reconcileUpdateCalls += 1;
      return { data: { id: `telnyx-profile-reconciled-${suffix}` } };
    }
  } as any;
  const reconciled = await ensureOrganizationTelnyxProfile(ambiguousProfile, reconcileClient);
  assert.equal(ambiguousCreateCalls, 1);
  assert.equal(reconcileUpdateCalls, 1);
  assert.equal(reconciled.messagingProfileId, `telnyx-profile-reconciled-${suffix}`);
});

test("organization keyword responses create once, verify by read-back, and update in place", async () => {
  const { ensureOrganizationTelnyxAutoresponses } = await import("../messaging/api.js");
  const { smsAutoresponsesReady } = await import("../messaging/autoresponses.js");
  const { updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let profile = await createAutoresponseProfile(`org_autoresp_${suffix}`, suffix);
  const configs: Record<string, any>[] = [];
  let creates = 0;
  let updates = 0;
  const client = {
    async listMessagingProfileAutorespConfigs() {
      return configs.map((config) => ({ ...config, keywords: [...config.keywords] }));
    },
    async createMessagingProfileAutorespConfig(_profileId: string, desired: Record<string, any>) {
      creates += 1;
      const config = { id: `autoresp-${desired.op}-${suffix}`, ...desired };
      configs.push(config);
      return { data: config };
    },
    async updateMessagingProfileAutorespConfig(_profileId: string, configId: string, desired: Record<string, any>) {
      updates += 1;
      const index = configs.findIndex((config) => config.id === configId);
      assert.notEqual(index, -1);
      configs[index] = { id: configId, ...desired };
      return { data: configs[index] };
    }
  } as any;

  profile = await ensureOrganizationTelnyxAutoresponses(profile, `messaging-${suffix}`, client);
  assert.equal(creates, 3);
  assert.equal(updates, 0);
  assert.equal(smsAutoresponsesReady(profile), true);
  assert.deepEqual(configs.map((config) => config.op).sort(), ["info", "start", "stop"]);
  assert.ok(configs.find((config) => config.op === "stop")?.keywords.includes("STOP ALL"));

  profile = await ensureOrganizationTelnyxAutoresponses(profile, `messaging-${suffix}`, client);
  assert.equal(creates, 3, "an exact read-back must not POST duplicates");
  assert.equal(updates, 0);

  profile = await updateSmsComplianceProfile(profile, {
    campaign: { ...profile.campaign, optinMessage: "Acme Roofing: Subscription confirmed. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out." }
  });
  profile = await ensureOrganizationTelnyxAutoresponses(profile, `messaging-${suffix}`, client);
  assert.equal(creates, 3);
  assert.equal(updates, 1, "changed registered copy must update the existing config by ID");
  assert.equal(smsAutoresponsesReady(profile), true);
});

test("keyword-response reconciliation cannot certify a concurrently changed campaign draft", async () => {
  const { ensureOrganizationTelnyxAutoresponses } = await import("../messaging/api.js");
  const { smsAutoresponsePlan, smsAutoresponsesReady } = await import("../messaging/autoresponses.js");
  const { readSmsComplianceProfile, updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const profile = await createAutoresponseProfile(`org_autoresp_revision_${suffix}`, suffix);
  const originalPlan = smsAutoresponsePlan(profile);
  let reportListStarted!: () => void;
  let releaseList!: () => void;
  const listStarted = new Promise<void>((resolve) => { reportListStarted = resolve; });
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  let firstList = true;
  const client = {
    async listMessagingProfileAutorespConfigs() {
      if (firstList) {
        firstList = false;
        reportListStarted();
        await listGate;
      }
      return originalPlan.configs.map((config) => ({ id: `revision-${config.op}`, ...config }));
    },
    async createMessagingProfileAutorespConfig() {
      throw new Error("all original configs already exist");
    },
    async updateMessagingProfileAutorespConfig() {
      throw new Error("all original configs already match");
    }
  } as any;

  const reconciliation = ensureOrganizationTelnyxAutoresponses(profile, `messaging-${suffix}`, client);
  await listStarted;
  await updateSmsComplianceProfile(profile, {
    campaign: {
      ...profile.campaign,
      helpMessage: "Acme Roofing: Help at 206-555-0199. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out."
    }
  });
  releaseList();
  await assert.rejects(reconciliation, (error: any) => error?.code === "autoresponse_configuration_changed");
  const saved = await readSmsComplianceProfile(profile.messaging_organization_id, profile.id);
  assert.equal((saved.autoresponse_state as Record<string, unknown>).status, "pending");
  assert.equal(smsAutoresponsesReady(saved), false);
});

test("ambiguous auto-response POSTs reconcile without a second create", async () => {
  const { ensureOrganizationTelnyxAutoresponses } = await import("../messaging/api.js");
  const { smsAutoresponsesReady } = await import("../messaging/autoresponses.js");
  const { TelnyxError } = await import("../messaging/telnyx.js");
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let profile = await createAutoresponseProfile(`org_autoresp_ambiguous_${suffix}`, suffix);
  const configs: Record<string, any>[] = [];
  let creates = 0;
  let first = true;
  const client = {
    async listMessagingProfileAutorespConfigs() {
      return configs.map((config) => ({ ...config, keywords: [...config.keywords] }));
    },
    async createMessagingProfileAutorespConfig(_profileId: string, desired: Record<string, any>) {
      creates += 1;
      const config = { id: `autoresp-${desired.op}-${suffix}`, ...desired };
      configs.push(config);
      if (first) {
        first = false;
        throw new TelnyxError("Timed out after provider submission.", 502, { submission_unknown: true });
      }
      return { data: config };
    },
    async updateMessagingProfileAutorespConfig() {
      throw new Error("an exact reconciled config must not be updated");
    }
  } as any;

  profile = await ensureOrganizationTelnyxAutoresponses(profile, `messaging-${suffix}`, client);
  assert.equal(creates, 3);
  assert.equal(smsAutoresponsesReady(profile), true);
  await ensureOrganizationTelnyxAutoresponses(profile, `messaging-${suffix}`, client);
  assert.equal(creates, 3, "replay must only read and verify the three existing configs");
});

test("an unresolved auto-response POST is outcome-unknown and never blindly retried", async () => {
  const { ensureOrganizationTelnyxAutoresponses } = await import("../messaging/api.js");
  const { findProviderOperation } = await import("../messaging/communications_storage.js");
  const { readSmsComplianceProfile } = await import("../messaging/storage.js");
  const { TelnyxError } = await import("../messaging/telnyx.js");
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const profile = await createAutoresponseProfile(`org_autoresp_unknown_${suffix}`, suffix);
  let creates = 0;
  const client = {
    async listMessagingProfileAutorespConfigs() {
      return [];
    },
    async createMessagingProfileAutorespConfig() {
      creates += 1;
      throw new TelnyxError("Timed out after provider submission.", 502, { submission_unknown: true });
    },
    async updateMessagingProfileAutorespConfig() {
      throw new Error("update should not run");
    }
  } as any;

  await assert.rejects(
    () => ensureOrganizationTelnyxAutoresponses(profile, `messaging-${suffix}`, client),
    (error: any) => error?.code === "provider_operation_outcome_unknown"
  );
  const afterFirst = await readSmsComplianceProfile(profile.messaging_organization_id, profile.id);
  assert.equal((afterFirst.autoresponse_state as Record<string, unknown>).status, "outcome_unknown");
  assert.equal(afterFirst.campaign_status, "draft");
  assert.equal((await findProviderOperation(profile.external_organization_id, profile.id, "campaign_submission")), null,
    "auto-response preflight must not acquire a campaign lease or make a first campaign request ambiguous");
  await assert.rejects(
    () => ensureOrganizationTelnyxAutoresponses(afterFirst, `messaging-${suffix}`, client),
    (error: any) => error?.code === "provider_operation_outcome_unknown"
  );
  assert.equal(creates, 1);
});

test("duplicate US auto-response operations fail closed", async () => {
  const { ensureOrganizationTelnyxAutoresponses } = await import("../messaging/api.js");
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const profile = await createAutoresponseProfile(`org_autoresp_duplicate_${suffix}`, suffix);
  const client = {
    async listMessagingProfileAutorespConfigs() {
      return [
        { id: "start-a", op: "start", keywords: ["START"], country_code: "US", resp_text: "Old response copy for this profile." },
        { id: "start-b", op: "start", keywords: ["START"], country_code: "US", resp_text: "Other old response for this profile." }
      ];
    }
  } as any;
  await assert.rejects(
    () => ensureOrganizationTelnyxAutoresponses(profile, `messaging-${suffix}`, client),
    (error: any) => error?.code === "duplicate_autoresponse_configs"
  );
});

test("consent events are monotonic and STOP wins an out-of-order START", async () => {
  const { listSmsConsentEvents, readSmsConsent, upsertSmsConsent } = await import("../messaging/communications_storage.js");
  const organizationId = "org_consent_ordering";
  const phoneNumber = "+12065550010";
  (await upsertSmsConsent({
    organization_id: organizationId, phone_number: phoneNumber, status: "opted_out", source: "inbound_stop",
    occurred_at: "2026-07-10T12:00:10.000Z", event_key: "stop-newer", evidence: { provider_event_id: "stop-newer" }
  }));
  (await upsertSmsConsent({
    organization_id: organizationId, phone_number: phoneNumber, status: "opted_in", source: "inbound_start",
    consent_id: "start-older", occurred_at: "2026-07-10T12:00:00.000Z", event_key: "start-older", evidence: { provider_event_id: "start-older" }
  }));
  assert.equal((await readSmsConsent(organizationId, phoneNumber))?.status, "opted_out");
  assert.equal((await listSmsConsentEvents(organizationId, phoneNumber)).length, 2);
});

test("delivery aggregation covers mixed terminal states and near-term schedules wait internally", async () => {
  const { deliveryAggregateStatus, scheduleForProvider } = await import("../messaging/delivery_worker.js");
  assert.equal(deliveryAggregateStatus([{ status: "failed" }, { status: "delivery_unconfirmed" }]), "delivery_unconfirmed");
  assert.equal(deliveryAggregateStatus([{ status: "delivered" }, { status: "cancel_failed" }]), "partially_delivered");
  assert.equal(deliveryAggregateStatus([{ status: "cancel_failed" }]), "failed");
  assert.equal(scheduleForProvider(new Date(Date.now() + 60_000).toISOString()), "wait");
});

test("SMS setup routes are gated behind the Platform SMS settings flag", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, false);
  const response = await client.raw("GET", `/v1/messaging/organizations/${orgId}/sms/setup`);
  assert.equal(response.statusCode, 403, response.body);
  assert.match(response.body, /app_flag_disabled/);
});

test("masked EIN values from public profiles cannot overwrite stored legal data during autosave", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);
  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: { displayName: "Acme Legal", companyName: "Acme Legal LLC", ein: "12-3456789" },
    campaign: {}
  });
  assert.equal(created.profile.brand.ein, "***6789");

  await client.request("PATCH", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}`, {
    brand: created.profile.brand,
    campaign: created.profile.campaign
  });
  const { ensureMessagingOrganization, readSmsComplianceProfile } = await import("../messaging/storage.js");
  const organization = await ensureMessagingOrganization(orgId);
  const stored = await readSmsComplianceProfile(organization.id, created.profile.id);
  assert.equal(stored.brand.ein, "12-3456789");
});

test("10DLC compliance profile workflow saves drafts and builds dry-run provider payloads", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);

  const emptySetup = await client.request("GET", `/v1/messaging/organizations/${orgId}/sms/setup`);
  assert.equal(emptySetup.ok, true);
  assert.equal(emptySetup.organization.external_organization_id, orgId);
  assert.deepEqual(emptySetup.profiles, []);

  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: {
      country: "US",
      displayName: "FirstMate Test",
      companyName: "FirstMate Test LLC",
      entityType: "PRIVATE_PROFIT",
      vertical: "CONSTRUCTION",
      email: "support@example.test",
      ein: "123456789",
      phone: "(206) 555-0100",
      street: "100 Main Street",
      city: "Boise",
      state: "ID",
      postalCode: "83702",
      website: "example.test",
      firstName: "Test",
      lastName: "Owner",
      mock: true
    },
    campaign: {
      brandId: "BTEST123",
      usecase: "CUSTOMER_CARE",
      description: "Customer care messages for project updates and appointment coordination.",
      messageFlow: "Customers opt in by submitting a website form or asking for project updates from staff.",
      sample1: "Hi Jane, this is FirstMate with an update on your roof appointment. Reply STOP to opt out.",
      sample2: "Your appointment is confirmed for Tuesday at 10:00 AM. Reply HELP for help or STOP to opt out.",
      subscriberOptin: true,
      subscriberOptout: true,
      subscriberHelp: true,
      featuresConfirmed: true,
      enabledFeatures: ["crm_conversations"],
      optoutKeywords: "STOP",
      helpKeywords: "HELP",
      optinMessage: "FirstMate: You are opted in. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
      optoutMessage: "FirstMate: You are unsubscribed and will receive no more messages. Reply START to resubscribe.",
      helpMessage: "FirstMate: Help at support@example.test. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.",
      termsAndConditions: true,
      privacyPolicyLink: "https://example.test/privacy",
      termsAndConditionsLink: "https://example.test/terms"
    }
  });
  assert.equal(created.profile.status, "draft");
  assert.equal(created.profile.validation.ready_for_brand_submission, true);
  assert.equal(created.profile.validation.ready_for_campaign_submission, false);

  const profileId = created.profile.id;
  const brandDryRun = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${profileId}/submit-brand`, {
    dry_run: true
  });
  assert.equal(brandDryRun.dry_run, true);
  assert.equal(brandDryRun.payload.displayName, "FirstMate Test");
  assert.equal(brandDryRun.payload.mock, true);
  assert.equal(brandDryRun.payload.entityType, "PRIVATE_PROFIT");
  assert.equal(brandDryRun.payload.phone, "+12065550100");
  assert.equal(brandDryRun.payload.website, "https://example.test");

  const campaignDryRun = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${profileId}/submit-campaign`, {
    dry_run: true
  });
  assert.equal(campaignDryRun.dry_run, true);
  assert.equal(campaignDryRun.payload.brandId, "BTEST123");
  assert.equal(campaignDryRun.payload.usecase, "CUSTOMER_CARE");
  assert.equal(campaignDryRun.payload.subscriberOptout, true);

  const status = await client.request("GET", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${profileId}/status`);
  assert.equal(status.status, "draft");
  assert.equal(status.validation.ready_for_brand_submission, true);
});

test("10DLC brand submit rejects invalid NANP phone numbers before Telnyx", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);

  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: {
      country: "US",
      displayName: "Bad Phone Test",
      companyName: "Bad Phone Test LLC",
      entityType: "PRIVATE_PROFIT",
      vertical: "CONSTRUCTION",
      email: "support@example.test",
      ein: "123456789",
      phone: "1234567890",
      street: "100 Main Street",
      city: "Boise",
      state: "ID",
      postalCode: "83702",
      website: "example.test",
      mock: true
    },
    campaign: {}
  });

  const response = await client.raw("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-brand`, {
    dry_run: true
  });
  assert.equal(response.statusCode, 400, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.error, "brand_profile_incomplete");
  assert.deepEqual(body.details.missing, ["phone"]);
});

test("10DLC brand submit accepts ten digit NANP numbers with valid area codes", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);

  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: {
      country: "US",
      displayName: "Phone Format Test",
      companyName: "Phone Format Test LLC",
      entityType: "PRIVATE_PROFIT",
      vertical: "CONSTRUCTION",
      email: "support@example.test",
      ein: "123456789",
      phone: "2061234567",
      street: "100 Main Street",
      city: "Boise",
      state: "ID",
      postalCode: "83702",
      website: "example.test",
      mock: true
    },
    campaign: {}
  });

  const dryRun = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-brand`, {
    dry_run: true
  });
  assert.equal(dryRun.payload.phone, "+12061234567");
});

test("a rejected 10DLC brand is corrected with idempotent PUT and no duplicate registration fee", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);
  const brandId = `B_CORRECTION_${Date.now()}`;
  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: {
      country: "US",
      displayName: "Brand Correction Test",
      companyName: "Brand Correction Test LLC",
      entityType: "PRIVATE_PROFIT",
      vertical: "CONSTRUCTION",
      email: "support@example.test",
      ein: "123456789",
      phone: "2061234567",
      street: "100 Main Street",
      city: "Boise",
      state: "ID",
      postalCode: "83702",
      website: "example.test"
    },
    campaign: { consentAcknowledged: true, standardizationVersion: "firstmate-crm-10dlc-v2" }
  });
  const { ensureMessagingOrganization, readSmsComplianceProfile, updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const messagingOrganization = await ensureMessagingOrganization(orgId);
  const stored = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
  await updateSmsComplianceProfile(stored, {
    status: "provider_update_pending",
    brand_status: "unverified",
    provider_refs: { telnyx_brand_id: brandId }
  });

  const requests: { method: string; url: string; body: string }[] = [];
  let server: Server | null = null;
  const serverUrl = await new Promise<string>((resolve) => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ method: request.method || "", url: request.url || "", body: Buffer.concat(chunks).toString("utf8") });
      response.setHeader("content-type", "application/json");
      if (request.method === "PUT" && request.url === `/10dlc/brand/${brandId}`) {
        response.end(JSON.stringify({ brandId, identityStatus: "PENDING", status: "PENDING" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found", method: request.method, url: request.url }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const { env } = await import("../src/config/env.js");
  const { recordBrandRegistrationFee } = await import("../messaging/api.js");
  const { listUsageEvents } = await import("../messaging/communications_storage.js");
  const previous = {
    mode: env.communicationsDeliveryMode,
    key: env.telnyxApiKey,
    baseUrl: env.telnyxBaseUrl,
    publicKey: env.telnyxWebhookPublicKey,
    webhookUrl: env.telnyxWebhookUrl,
    encryptionKey: env.messagingEncryptionKey
  };
  try {
    (env as any).communicationsDeliveryMode = "live";
    (env as any).telnyxApiKey = "KEY_TEST";
    (env as any).telnyxBaseUrl = serverUrl;
    (env as any).telnyxWebhookPublicKey = "test-public-key";
    (env as any).telnyxWebhookUrl = "https://app.1m8.ai/v1/messaging/webhooks/telnyx";
    (env as any).messagingEncryptionKey = "test-encryption-key";
    (await recordBrandRegistrationFee(orgId, brandId, created.profile.id, "PRIVATE_PROFIT"));

    const corrected = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-brand`, { submit: true });
    assert.equal(corrected.profile.provider_refs.telnyx_brand_id, brandId);
    assert.equal(corrected.profile.brand_status, "pending");
    assert.match(corrected.profile.provider_refs.telnyx_brand_submission_operation_type, /^brand_update_[a-f0-9]{12}$/);

    const replay = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-brand`, { submit: true });
    assert.equal(replay.idempotent_replay, true);
    assert.deepEqual(requests.map((entry) => `${entry.method} ${entry.url}`), [`PUT /10dlc/brand/${brandId}`]);
    assert.equal((await listUsageEvents(orgId, { direction: "brand_registration" })).filter((entry) => entry.provider_message_id === brandId).length, 1);
  } finally {
    (env as any).communicationsDeliveryMode = previous.mode;
    (env as any).telnyxApiKey = previous.key;
    (env as any).telnyxBaseUrl = previous.baseUrl;
    (env as any).telnyxWebhookPublicKey = previous.publicKey;
    (env as any).telnyxWebhookUrl = previous.webhookUrl;
    (env as any).messagingEncryptionKey = previous.encryptionKey;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

test("10DLC mock number search and selection saves selected sending number", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);

  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: {
      country: "US",
      displayName: "Number Selection Test",
      companyName: "Number Selection Test LLC",
      entityType: "PRIVATE_PROFIT",
      vertical: "CONSTRUCTION",
      email: "support@example.test",
      ein: "123456789",
      phone: "2061234567",
      street: "100 Main Street",
      city: "Boise",
      state: "ID",
      postalCode: "83702",
      website: "example.test",
      mock: true
    },
    campaign: {}
  });

  const found = await client.request("GET", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/available-numbers?area_code=206`);
  assert.equal(found.ok, true);
  assert.equal(found.mock, true);
  assert.equal(found.area_code, "206");
  assert.equal(found.numbers.length, 6);
  assert.match(found.numbers[0].phone_number, /^\+1206/);

  const selected = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/select-number`, {
    phone_number: found.numbers[0].phone_number,
    display_number: found.numbers[0].display_number,
    area_code: "206",
    locality: found.numbers[0].locality,
    region: found.numbers[0].region,
    features: found.numbers[0].features
  });

  assert.equal(selected.ok, true);
  assert.equal(selected.profile.campaign.selectedNumber, found.numbers[0].phone_number);
  assert.equal(selected.profile.campaign.selectedNumberAreaCode, "206");
  assert.equal(selected.profile.provider_refs.mock_phone_number, found.numbers[0].phone_number);
  assert.equal(selected.profile.validation.number.ok, true);
});

test("10DLC mock number search rejects invalid area code", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);

  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: { mock: true },
    campaign: {}
  });

  const response = await client.raw("GET", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/available-numbers?area_code=111`);
  assert.equal(response.statusCode, 400, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.error, "invalid_area_code");
});

test("ambiguous live number orders reconcile before availability and never purchase twice", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);
  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: {}, campaign: {}
  });
  const selectedNumber = "+12065550199";
  const messagingProfileId = "40000000-0000-0000-0000-000000000199";
  const orderId = "number-order-reconciled-199";
  let inventoryCalls = 0;
  let numberOrderPosts = 0;
  let numberOrderLists = 0;
  let server: Server | null = null;
  const serverUrl = await new Promise<string>((resolve) => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.setHeader("content-type", "application/json");
      const url = request.url || "";
      if (request.method === "GET" && url.startsWith("/available_phone_numbers?")) {
        inventoryCalls += 1;
        response.end(JSON.stringify({
          data: inventoryCalls === 1 ? [{
            phone_number: selectedNumber,
            features: [{ name: "sms" }, { name: "mms" }],
            region_information: [{ region_type: "locality", region_name: "Seattle" }],
            cost_information: { monthly_cost: "1.00", upfront_cost: "0.50", currency: "USD" }
          }] : []
        }));
        return;
      }
      if (request.method === "GET" && url.startsWith("/messaging_profiles?")) {
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      if (request.method === "POST" && url === "/messaging_profiles") {
        response.end(JSON.stringify({ data: { id: messagingProfileId } }));
        return;
      }
      if (request.method === "PATCH" && url === `/messaging_profiles/${messagingProfileId}`) {
        response.end(JSON.stringify({ data: { id: messagingProfileId } }));
        return;
      }
      if (request.method === "POST" && url === "/number_orders") {
        numberOrderPosts += 1;
        response.statusCode = 503;
        response.end(JSON.stringify({ errors: [{ code: "temporary_provider_failure" }] }));
        return;
      }
      if (request.method === "GET" && url.startsWith("/number_orders?")) {
        numberOrderLists += 1;
        response.end(JSON.stringify({
          data: [{ id: orderId, status: "success", phone_numbers: [{ phone_number: selectedNumber }] }]
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found", method: request.method, url }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const { env } = await import("../src/config/env.js");
  const previous = {
    mode: env.communicationsDeliveryMode,
    key: env.telnyxApiKey,
    baseUrl: env.telnyxBaseUrl,
    publicKey: env.telnyxWebhookPublicKey,
    webhookUrl: env.telnyxWebhookUrl,
    encryptionKey: env.messagingEncryptionKey,
    requireConsent: env.smsRequireConsent
  };
  try {
    (env as any).communicationsDeliveryMode = "live";
    (env as any).telnyxApiKey = "KEY_TEST";
    (env as any).telnyxBaseUrl = serverUrl;
    (env as any).telnyxWebhookPublicKey = "test-public-key";
    (env as any).telnyxWebhookUrl = "https://app.1m8.ai/v1/messaging/webhooks/telnyx";
    (env as any).messagingEncryptionKey = "test-encryption-key";
    (env as any).smsRequireConsent = true;

    const first = await client.raw("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/select-number`, {
      phone_number: selectedNumber
    });
    assert.equal(first.statusCode, 503, first.body);
    const pending = await client.request("GET", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}`);
    assert.equal(pending.profile.campaign.selectedNumber, selectedNumber);
    assert.equal(pending.profile.campaign.selectedNumberMonthlyCost, "1.00");
    assert.equal(pending.profile.phone_number_status, "ordering");

    const reconciled = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/select-number`, {
      phone_number: selectedNumber
    });
    assert.equal(reconciled.profile.provider_refs.telnyx_number_order_id, orderId);
    assert.equal(reconciled.profile.campaign.selectedNumberMonthlyCost, "1.00");
    assert.equal(inventoryCalls, 1, "reconciliation must not query availability after the number was purchased");
    assert.equal(numberOrderPosts, 1, "reconciliation must not issue a second number-order POST");
    assert.equal(numberOrderLists, 1);
  } finally {
    (env as any).communicationsDeliveryMode = previous.mode;
    (env as any).telnyxApiKey = previous.key;
    (env as any).telnyxBaseUrl = previous.baseUrl;
    (env as any).telnyxWebhookPublicKey = previous.publicKey;
    (env as any).telnyxWebhookUrl = previous.webhookUrl;
    (env as any).messagingEncryptionKey = previous.encryptionKey;
    (env as any).smsRequireConsent = previous.requireConsent;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

test("manual provider refresh cannot overwrite a newer 10DLC webhook state", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);
  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, { brand: {}, campaign: {} });
  const selectedNumber = "+12065550198";
  const brandId = "brand-refresh-race";
  const campaignId = "campaign-refresh-race";
  const numberOrderId = "order-refresh-race";
  const messagingProfileId = "40000000-0000-0000-0000-000000000198";
  const { appendSmsComplianceEvent, ensureMessagingOrganization, readSmsComplianceProfile, updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const messagingOrganization = await ensureMessagingOrganization(orgId);
  let internal = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
  internal = await updateSmsComplianceProfile(internal, {
    status: "campaign_submitted",
    brand_status: "verified",
    campaign_status: "submitted",
    phone_number_status: "success",
    phone_number_campaign_status: "unassigned",
    campaign: {
      selectedNumber,
      selectedNumberMonthlyCost: "1.00",
      selectedNumberCurrency: "USD",
      optinKeywords: "START",
      optinMessage: "Refresh Test: You are subscribed. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
      optoutKeywords: "STOP",
      optoutMessage: "Refresh Test: You are unsubscribed. Reply START to resubscribe.",
      helpKeywords: "HELP",
      helpMessage: "Refresh Test: Help at 206-555-0100. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out."
    },
    provider_refs: {
      telnyx_brand_id: brandId,
      telnyx_campaign_id: campaignId,
      telnyx_number_order_id: numberOrderId,
      telnyx_messaging_profile_id: messagingProfileId
    }
  });
  const { smsAutoresponsePlan } = await import("../messaging/autoresponses.js");
  const autoresponsePlan = smsAutoresponsePlan(internal);
  assert.equal(autoresponsePlan.ok, true);
  internal = await updateSmsComplianceProfile(internal, {
    autoresponse_state: {
      status: "configured",
      messaging_profile_id: messagingProfileId,
      desired_hash: autoresponsePlan.hash,
      applied_hash: autoresponsePlan.hash,
      config_ids: { start: "refresh-start", stop: "refresh-stop", info: "refresh-info" }
    }
  });

  let releaseCampaign!: () => void;
  let reportCampaignStarted!: () => void;
  const campaignStarted = new Promise<void>((resolve) => { reportCampaignStarted = resolve; });
  const campaignGate = new Promise<void>((resolve) => { releaseCampaign = resolve; });
  let server: Server | null = null;
  const serverUrl = await new Promise<string>((resolve) => {
    server = createServer(async (request, response) => {
      const url = request.url || "";
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && url === `/10dlc/brand/${brandId}`) {
        response.end(JSON.stringify({ brandId, identityStatus: "VERIFIED", status: "OK" }));
        return;
      }
      if (request.method === "GET" && url === `/messaging_profiles/${messagingProfileId}/autoresp_configs?country_code=US`) {
        response.end(JSON.stringify({
          data: autoresponsePlan.configs.map((config) => ({ id: `refresh-${config.op}`, ...config }))
        }));
        return;
      }
      if (request.method === "GET" && url === `/10dlc/campaign/${campaignId}`) {
        reportCampaignStarted();
        await campaignGate;
        response.end(JSON.stringify({ campaignId, campaignStatus: "MNO_PROVISIONED" }));
        return;
      }
      if (request.method === "GET" && url === `/number_orders/${numberOrderId}`) {
        response.end(JSON.stringify({ data: { id: numberOrderId, status: "success" } }));
        return;
      }
      if (request.method === "GET" && url.startsWith("/phone_numbers?")) {
        response.end(JSON.stringify({ data: [{ id: "phone-refresh-race", phone_number: selectedNumber }] }));
        return;
      }
      if (request.method === "GET" && url.startsWith("/10dlc/phone_number_campaigns/")) {
        response.end(JSON.stringify({ campaignId, phoneNumber: selectedNumber, status: "success" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found", method: request.method, url }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const { env } = await import("../src/config/env.js");
  const previous = {
    mode: env.communicationsDeliveryMode,
    key: env.telnyxApiKey,
    baseUrl: env.telnyxBaseUrl,
    publicKey: env.telnyxWebhookPublicKey,
    webhookUrl: env.telnyxWebhookUrl,
    encryptionKey: env.messagingEncryptionKey,
    requireConsent: env.smsRequireConsent
  };
  try {
    (env as any).communicationsDeliveryMode = "live";
    (env as any).telnyxApiKey = "KEY_TEST";
    (env as any).telnyxBaseUrl = serverUrl;
    (env as any).telnyxWebhookPublicKey = "test-public-key";
    (env as any).telnyxWebhookUrl = "https://app.1m8.ai/v1/messaging/webhooks/telnyx";
    (env as any).messagingEncryptionKey = "test-encryption-key";
    (env as any).smsRequireConsent = true;

    const refresh = client.raw("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/refresh-status`, {});
    await campaignStarted;
    const current = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
    await appendSmsComplianceEvent(current, {
      type: "provider_webhook_received",
      provider_event_id: "newer-rejection-during-refresh",
      provider_event_type: "10dlc.campaign.update",
      occurred_at: new Date().toISOString()
    }, { campaign_status: "rejected", status: "provider_update_pending" });
    releaseCampaign();

    const response = await refresh;
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.body, /provider_state_changed/);
    const saved = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
    assert.equal(saved.campaign_status, "rejected");
    assert.equal(saved.status, "provider_update_pending");
  } finally {
    releaseCampaign?.();
    (env as any).communicationsDeliveryMode = previous.mode;
    (env as any).telnyxApiKey = previous.key;
    (env as any).telnyxBaseUrl = previous.baseUrl;
    (env as any).telnyxWebhookPublicKey = previous.publicKey;
    (env as any).telnyxWebhookUrl = previous.webhookUrl;
    (env as any).messagingEncryptionKey = previous.encryptionKey;
    (env as any).smsRequireConsent = previous.requireConsent;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

test("replacement refresh detaches the old campaign, assigns the new campaign, and retires the old campaign once", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);
  const selectedNumber = "+12065550197";
  const brandId = "brand-replacement-refresh";
  const oldCampaignId = "campaign-replacement-old";
  const campaignId = "campaign-replacement-new";
  const numberOrderId = "order-replacement-refresh";
  const messagingProfileId = "40000000-0000-0000-0000-000000000197";
  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, { brand: {}, campaign: {} });
  const { ensureMessagingOrganization, readSmsComplianceProfile, updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const messagingOrganization = await ensureMessagingOrganization(orgId);
  let internal = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
  internal = await updateSmsComplianceProfile(internal, {
    status: "campaign_submitted",
    brand_status: "verified",
    campaign_status: "submitted",
    phone_number_status: "success",
    phone_number_campaign_status: "replacement_pending",
    phone_number_campaign_id: oldCampaignId,
    brand: { displayName: "Replacement Test", mock: true },
    campaign: {
      selectedNumber,
      selectedNumberMonthlyCost: "1.00",
      selectedNumberCurrency: "USD",
      optinKeywords: "START",
      optinMessage: "Replacement Test: You are subscribed. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
      optoutKeywords: "STOP",
      optoutMessage: "Replacement Test: You are unsubscribed. Reply START to resubscribe.",
      helpKeywords: "HELP",
      helpMessage: "Replacement Test: Help at 206-555-0100. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out."
    },
    provider_refs: {
      telnyx_brand_id: brandId,
      telnyx_campaign_id: campaignId,
      previous_telnyx_campaign_ids: [oldCampaignId],
      telnyx_number_order_id: numberOrderId,
      telnyx_messaging_profile_id: messagingProfileId
    }
  });
  const { smsAutoresponsePlan } = await import("../messaging/autoresponses.js");
  const autoresponsePlan = smsAutoresponsePlan(internal);
  assert.equal(autoresponsePlan.ok, true);
  internal = await updateSmsComplianceProfile(internal, {
    autoresponse_state: {
      status: "configured",
      messaging_profile_id: messagingProfileId,
      desired_hash: autoresponsePlan.hash,
      applied_hash: autoresponsePlan.hash,
      config_ids: { start: "replace-start", stop: "replace-stop", info: "replace-info" }
    }
  });

  let assignedCampaignId = oldCampaignId;
  let detachCalls = 0;
  let attachCalls = 0;
  let deactivateCalls = 0;
  let server: Server | null = null;
  const serverUrl = await new Promise<string>((resolve) => {
    server = createServer(async (request, response) => {
      const url = request.url || "";
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && url === `/10dlc/brand/${brandId}`) {
        response.end(JSON.stringify({ brandId, identityStatus: "VERIFIED", status: "OK" }));
        return;
      }
      if (request.method === "GET" && url === `/10dlc/campaign/${campaignId}`) {
        response.end(JSON.stringify({ campaignId, campaignStatus: "MNO_PROVISIONED" }));
        return;
      }
      if (request.method === "GET" && url === `/number_orders/${numberOrderId}`) {
        response.end(JSON.stringify({ data: { id: numberOrderId, status: "success" } }));
        return;
      }
      if (request.method === "GET" && url.startsWith("/phone_numbers?")) {
        response.end(JSON.stringify({ data: [{ id: "phone-replacement-refresh", phone_number: selectedNumber }] }));
        return;
      }
      if (request.method === "GET" && url.startsWith("/10dlc/phone_number_campaigns/")) {
        if (!assignedCampaignId) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "not_found" }));
        } else {
          response.end(JSON.stringify({ phoneNumber: selectedNumber, campaignId: assignedCampaignId, status: "success" }));
        }
        return;
      }
      if (request.method === "DELETE" && url.startsWith("/10dlc/phone_number_campaigns/")) {
        detachCalls += 1;
        assignedCampaignId = "";
        response.end(JSON.stringify({ data: null }));
        return;
      }
      if (request.method === "POST" && url === "/10dlc/phone_number_campaigns") {
        attachCalls += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        assert.equal(body.phoneNumber, selectedNumber);
        assert.equal(body.campaignId, campaignId);
        assignedCampaignId = campaignId;
        response.end(JSON.stringify({ phoneNumber: selectedNumber, campaignId, status: "success" }));
        return;
      }
      if (request.method === "DELETE" && url === `/10dlc/campaign/${oldCampaignId}`) {
        deactivateCalls += 1;
        response.end(JSON.stringify({ campaignId: oldCampaignId, status: "DEACTIVATED" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found", method: request.method, url }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const { env } = await import("../src/config/env.js");
  const { findBillingCommitment, upsertBillingCommitment } = await import("../messaging/communications_storage.js");
  const previous = { key: env.telnyxApiKey, baseUrl: env.telnyxBaseUrl };
  try {
    (env as any).telnyxApiKey = "KEY_TEST";
    (env as any).telnyxBaseUrl = serverUrl;
    (await upsertBillingCommitment({
      organization_id: orgId,
      provider: "telnyx",
      resource_type: "campaign",
      resource_id: oldCampaignId,
      amount: "30",
      currency: "USD",
      billing_interval: "month",
      status: "active"
    }));

    const refreshed = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/refresh-status`, {});
    assert.equal(refreshed.profile.status, "active");
    assert.equal(refreshed.profile.phone_number_campaign_status, "assigned");
    assert.equal(refreshed.profile.phone_number_campaign_id, campaignId);
    assert.deepEqual(refreshed.profile.provider_refs.deactivated_telnyx_campaign_ids, [oldCampaignId]);
    assert.equal(detachCalls, 1);
    assert.equal(attachCalls, 1);
    assert.equal(deactivateCalls, 1);
    assert.equal(((await findBillingCommitment("telnyx", "campaign", oldCampaignId)) as Record<string, unknown>)?.status, "ended");

    const replay = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/refresh-status`, {});
    assert.equal(replay.profile.status, "active");
    assert.equal(detachCalls, 1, "a converged replacement must not detach again");
    assert.equal(attachCalls, 1, "a converged replacement must not attach again");
    assert.equal(deactivateCalls, 1, "a retired campaign must not be deactivated again");
  } finally {
    (env as any).telnyxApiKey = previous.key;
    (env as any).telnyxBaseUrl = previous.baseUrl;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

test("eligible native campaign appeals are idempotent and wait for webhook-priced review events", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);
  const campaignId = "campaign-native-appeal";
  const appealReason = "The public website now includes the required SMS privacy policy and terms links.";
  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, { brand: {}, campaign: {} });
  const { appendSmsComplianceEvent, ensureMessagingOrganization, readSmsComplianceProfile, updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const messagingOrganization = await ensureMessagingOrganization(orgId);
  const stored = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
  await updateSmsComplianceProfile(stored, {
    status: "provider_update_pending",
    brand_status: "verified",
    campaign_status: "telnyx_failed",
    provider_refs: { telnyx_campaign_id: campaignId }
  });

  let appealPosts = 0;
  let server: Server | null = null;
  const serverUrl = await new Promise<string>((resolve) => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === `/10dlc/campaign/${campaignId}/appeal`) {
        appealPosts += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        assert.equal(body.appeal_reason, appealReason);
        response.end(JSON.stringify({ appealed_at: "2026-07-10T12:00:00.000000+00:00" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found", method: request.method, url: request.url }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const { env } = await import("../src/config/env.js");
  const { listUsageEvents } = await import("../messaging/communications_storage.js");
  const previous = {
    mode: env.communicationsDeliveryMode,
    key: env.telnyxApiKey,
    baseUrl: env.telnyxBaseUrl,
    publicKey: env.telnyxWebhookPublicKey,
    webhookUrl: env.telnyxWebhookUrl,
    encryptionKey: env.messagingEncryptionKey
  };
  try {
    (env as any).communicationsDeliveryMode = "live";
    (env as any).telnyxApiKey = "KEY_TEST";
    (env as any).telnyxBaseUrl = serverUrl;
    (env as any).telnyxWebhookPublicKey = "test-public-key";
    (env as any).telnyxWebhookUrl = "https://app.1m8.ai/v1/messaging/webhooks/telnyx";
    (env as any).messagingEncryptionKey = "test-encryption-key";

    const appealed = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/appeal-campaign`, {
      appeal_reason: appealReason
    });
    assert.equal(appealed.appealed, true);
    assert.equal(appealed.profile.campaign_status, "tcr_accepted");
    assert.equal(appealed.profile.status, "provider_update_pending");

    const replay = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/appeal-campaign`, {
      appeal_reason: appealReason
    });
    assert.equal(replay.idempotent_replay, true);
    assert.equal(appealPosts, 1, "an accepted appeal must never be POSTed twice");
    assert.equal((await listUsageEvents(orgId, { direction: "campaign_review" })).length, 0, "appeal pricing is metered only from the actual resubmission webhook");

    const appealedProfile = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
    await appendSmsComplianceEvent(appealedProfile, {
      type: "provider_webhook_received",
      provider_event_type: "10dlc.campaign.update",
      provider_event_id: "campaign-rejected-again",
      occurred_at: "2026-07-11T12:00:00.000000+00:00"
    }, { status: "provider_update_pending", campaign_status: "mno_rejected" });
    const secondReview = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/appeal-campaign`, {
      appeal_reason: appealReason
    });
    assert.equal(secondReview.appealed, true);
    assert.equal(appealPosts, 2, "a later rejection event creates a new appeal generation even when the remediation text is unchanged");
  } finally {
    (env as any).communicationsDeliveryMode = previous.mode;
    (env as any).telnyxApiKey = previous.key;
    (env as any).telnyxBaseUrl = previous.baseUrl;
    (env as any).telnyxWebhookPublicKey = previous.publicKey;
    (env as any).telnyxWebhookUrl = previous.webhookUrl;
    (env as any).messagingEncryptionKey = previous.encryptionKey;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

test("10DLC campaign submit waits for brand readiness", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);

  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
    brand: {
      country: "US",
      displayName: "Pending Brand Test",
      companyName: "Pending Brand Test LLC",
      entityType: "PRIVATE_PROFIT",
      vertical: "CONSTRUCTION",
      email: "support@example.test",
      ein: "123456789",
      phone: "2061234567",
      street: "100 Main Street",
      city: "Boise",
      state: "ID",
      postalCode: "83702",
      website: "example.test",
      mock: false
    },
    campaign: {
      brandId: "B_PENDING",
      usecase: "CUSTOMER_CARE",
      description: "Customer care messages for project updates and appointment coordination.",
      messageFlow: "Customers opt in by submitting a website form or asking for project updates from staff.",
      sample1: "Hi Jane, this is FirstMate with an update on your roof appointment. Reply STOP to opt out.",
      sample2: "Your appointment is confirmed. Reply HELP for help or STOP to opt out.",
      subscriberOptin: true,
      subscriberOptout: true,
      subscriberHelp: true,
      featuresConfirmed: true,
      messageFlowConfirmed: true,
      enabledFeatures: ["crm_conversations"],
      optoutKeywords: "STOP",
      helpKeywords: "HELP",
      termsAndConditions: true,
      optinMessage: "FirstMate: You are opted in. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
      optoutMessage: "FirstMate: You are unsubscribed and will receive no more messages. Reply START to resubscribe.",
      helpMessage: "FirstMate: Help at support@example.test. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.",
      privacyPolicyLink: "https://example.test/privacy",
      termsAndConditionsLink: "https://example.test/terms",
      consentAcknowledged: true
    }
  });

  const { env } = await import("../src/config/env.js");
  const previousMode = env.communicationsDeliveryMode;
  (env as any).communicationsDeliveryMode = "live";
  const { ensureMessagingOrganization, readSmsComplianceProfile, updateSmsComplianceProfile } = await import("../messaging/storage.js");
  const messagingOrganization = await ensureMessagingOrganization(orgId);
  const storedProfile = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
  await updateSmsComplianceProfile(storedProfile, {
    brand_status: "registration_pending",
    provider_refs: { telnyx_brand_id: "B_PENDING" }
  });

  try {
    const response = await client.raw("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-campaign`, {
      submit: true
    });
    assert.equal(response.statusCode, 400, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.error, "brand_registration_pending");
  } finally {
    (env as any).communicationsDeliveryMode = previousMode;
  }
});

test("10DLC mock campaign submit records qualification failure and still calls Telnyx campaign creation", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, true);

  const requests: { method: string; url: string; body: string }[] = [];
  let server: Server | null = null;
  const serverUrl = await new Promise<string>((resolve) => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method || "", url: request.url || "", body });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/10dlc/campaignBuilder/brand/B_MOCK_PENDING/usecase/MIXED") {
        response.statusCode = 400;
        response.end(JSON.stringify({ errors: [{ detail: "Cannot qualify usecase: brand registration is still pending." }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/10dlc/campaignBuilder") {
        const submissionNumber = requests.filter((entry) => entry.method === "POST" && entry.url === "/10dlc/campaignBuilder").length;
        response.statusCode = 200;
        response.end(JSON.stringify({
          campaignId: submissionNumber === 1 ? "C_MOCK_123" : "C_MOCK_456",
          tcrCampaignId: submissionNumber === 1 ? "TCR_MOCK_123" : "TCR_MOCK_456",
          campaignStatus: "PENDING"
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const { env } = await import("../src/config/env.js");
  const previousKey = env.telnyxApiKey;
  const previousBaseUrl = env.telnyxBaseUrl;
  (env as any).telnyxApiKey = "KEY_TEST";
  (env as any).telnyxBaseUrl = serverUrl;

  try {
    const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles`, {
      brand: {
        country: "US",
        displayName: "Mock Pending Brand",
        companyName: "Mock Pending Brand LLC",
        entityType: "PRIVATE_PROFIT",
        vertical: "CONSTRUCTION",
        email: "support@example.test",
        ein: "123456789",
        phone: "2061234567",
        street: "100 Main Street",
        city: "Boise",
        state: "ID",
        postalCode: "83702",
        website: "example.test",
        mock: true
      },
      campaign: {
        brandId: "B_MOCK_PENDING",
        usecase: "MIXED",
        description: "Customer care messages for project updates and appointment coordination.",
        messageFlow: "Customers opt in by submitting a website form or asking for project updates from staff.",
        sample1: "Hi Jane, this is FirstMate with an update on your roof appointment. Reply STOP to opt out.",
        sample2: "Your appointment is confirmed. Reply HELP for help or STOP to opt out.",
        subscriberOptin: true,
        subscriberOptout: true,
        subscriberHelp: true,
        featuresConfirmed: true,
        enabledFeatures: ["crm_conversations", "operations"],
        optoutKeywords: "STOP",
        helpKeywords: "HELP",
        termsAndConditions: true,
        optinMessage: "FirstMate: You are opted in. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
        optoutMessage: "FirstMate: You are unsubscribed and will receive no more messages. Reply START to resubscribe.",
        helpMessage: "FirstMate: Help at support@example.test. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.",
        privacyPolicyLink: "https://example.test/privacy",
        termsAndConditionsLink: "https://example.test/terms"
      }
    });

    const { ensureMessagingOrganization, readSmsComplianceProfile, updateSmsComplianceProfile } = await import("../messaging/storage.js");
    const messagingOrganization = await ensureMessagingOrganization(orgId);
    const staleAssignment = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
    await updateSmsComplianceProfile(staleAssignment, {
      phone_number_campaign_status: "assigned",
      phone_number_campaign_id: "C_OLD_ASSIGNMENT"
    });

    const submitted = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-campaign`, {
      submit: true
    });

    assert.equal(submitted.ok, true);
    assert.equal(submitted.mock, true);
    assert.equal(submitted.qualification_error.statusCode, 400);
    assert.equal(submitted.profile.provider_refs.telnyx_campaign_id, "C_MOCK_123");
    assert.equal(submitted.profile.status, "campaign_submitted");
    assert.equal(submitted.profile.phone_number_campaign_status, "unassigned");
    assert.equal(submitted.profile.phone_number_campaign_id, "");
    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      "GET /10dlc/campaignBuilder/brand/B_MOCK_PENDING/usecase/MIXED",
      "POST /10dlc/campaignBuilder"
    ]);

    const firstSubmission = JSON.parse(requests.find((request) => request.method === "POST")?.body || "{}");
    const rejected = await readSmsComplianceProfile(messagingOrganization.id, created.profile.id);
    await updateSmsComplianceProfile(rejected, {
      status: "provider_update_pending",
      campaign_status: "mno_rejected",
      phone_number_campaign_status: "assigned",
      phone_number_campaign_id: "C_MOCK_123",
      campaign: {
        ...rejected.campaign,
        sample1: "Hi Jane, this is FirstMate with a corrected roof appointment update. Reply STOP to opt out."
      }
    });

    const replacement = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-campaign`, {
      submit: true,
      replace_rejected_campaign: true
    });
    const campaignPosts = requests.filter((request) => request.method === "POST" && request.url === "/10dlc/campaignBuilder");
    const secondSubmission = JSON.parse(campaignPosts[1]?.body || "{}");
    assert.equal(campaignPosts.length, 2, "a rejected campaign correction must create exactly one replacement campaign");
    assert.notEqual(secondSubmission.referenceId, firstSubmission.referenceId);
    assert.match(secondSubmission.referenceId, /^fm_[a-f0-9]{16}_[a-f0-9]{12}$/);
    assert.equal(replacement.profile.provider_refs.telnyx_campaign_id, "C_MOCK_456");
    assert.equal(replacement.profile.provider_refs.tcr_campaign_id, "TCR_MOCK_456");
    assert.deepEqual(replacement.profile.provider_refs.previous_telnyx_campaign_ids, ["C_MOCK_123"]);
    assert.deepEqual(replacement.profile.provider_refs.previous_tcr_campaign_ids, ["TCR_MOCK_123"]);
    assert.equal(replacement.profile.phone_number_campaign_status, "replacement_pending");
    assert.equal(replacement.profile.phone_number_campaign_id, "C_MOCK_123", "the old campaign binding stays authoritative until the replacement is assigned");

    const { findProviderOperation } = await import("../messaging/communications_storage.js");
    const replacementOperationType = replacement.profile.provider_refs.telnyx_campaign_submission_operation_type;
    const replacementOperation = (await findProviderOperation(orgId, created.profile.id, replacementOperationType)) as Record<string, unknown>;
    const replayDryRun = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-campaign`, {
      dry_run: true
    });
    assert.equal(
      replacementOperation.request_hash,
      createHash("sha256").update(JSON.stringify(replayDryRun.payload)).digest("hex"),
      "the accepted replacement operation must retain the exact replay payload"
    );

    const replay = await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/compliance-profiles/${created.profile.id}/submit-campaign`, {
      submit: true
    });
    assert.equal(replay.idempotent_replay, true);
    assert.equal(requests.filter((request) => request.method === "POST" && request.url === "/10dlc/campaignBuilder").length, 2, "replaying the accepted replacement must not issue another billable campaign POST");
    assert.equal(replay.profile.provider_refs.telnyx_campaign_id, "C_MOCK_456");
  } finally {
    (env as any).telnyxApiKey = previousKey;
    (env as any).telnyxBaseUrl = previousBaseUrl;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("organization communications capture SMS with production-shaped responses and idempotency", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  const capabilities = await client.request("GET", `/v1/messaging/organizations/${orgId}/capabilities`);
  assert.equal(capabilities.channels.sms.available, true);
  assert.equal(capabilities.channels.email.available, true);
  assert.equal(capabilities.channels.sms.senders[0].identity_id, "default_sms");

  const request = {
    channel: "sms",
    purpose: "appointment",
    recipients: [{ address: "(206) 555-0123", contact_id: "contact_communication_test" }],
    content: { text: "Your appointment is tomorrow at 10:00 AM." },
    context: { project_id: "project_communication_test", work_node_id: "work_node_reminder" },
    source: { type: "automation", automation_id: "appointment-reminder" },
    idempotency_key: "appointment-reminder:event-123"
  };
  const sent = await client.request("POST", `/v1/messaging/organizations/${orgId}/messages`, request);
  assert.equal(sent.created, true);
  assert.equal(sent.idempotent_replay, false);
  assert.equal(sent.message.channel, "sms");
  assert.equal(sent.message.status, "sent");
  assert.equal(sent.message.recipients[0].address, "+12065550123");
  assert.equal(sent.message.deliveries[0].status, "sent");
  assert.equal(Object.hasOwn(sent.message.deliveries[0], "provider"), false);
  assert.equal(Object.hasOwn(sent.message.deliveries[0], "transport_mode"), false);
  assert.equal(Object.hasOwn(sent.message.metadata, "transport_mode"), false);

  const replay = await client.request("POST", `/v1/messaging/organizations/${orgId}/messages`, request);
  assert.equal(replay.created, false);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.message.id, sent.message.id);

  const normalList = await client.request("GET", `/v1/messaging/organizations/${orgId}/messages?project_id=project_communication_test`);
  assert.equal(normalList.messages.length, 1);
  const developerList = await client.request("GET", `/v1/messaging/developer/organizations/${orgId}/messages`);
  assert.equal(developerList.messages.length, 1);
  assert.equal(developerList.messages[0].developer.captured, true);
  assert.equal(developerList.messages[0].developer.deliveries[0].provider, "telnyx");
  assert.equal(developerList.messages[0].developer.deliveries[0].transport_mode, "capture");
  assert.ok(developerList.messages[0].developer.events.some((event: any) => event.type === "provider.accepted"));

  const delivered = await client.request("POST", `/v1/messaging/developer/organizations/${orgId}/messages/${sent.message.id}/status`, {
    status: "delivered",
    reason: "Test delivery"
  });
  assert.equal(delivered.message.status, "delivered");
  const normalDetail = await client.request("GET", `/v1/messaging/organizations/${orgId}/messages/${sent.message.id}`);
  assert.equal(normalDetail.message.status, "delivered");
  assert.equal(normalDetail.message.deliveries[0].status, "delivered");
});

test("communications conversations support email history and simulated inbound messages", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  const created = await client.request("POST", `/v1/messaging/organizations/${orgId}/conversations`, {
    subject: "Roof project updates",
    channel_strategy: "omnichannel",
    participants: [{ address: "customer@example.test", contact_id: "contact_email_test" }],
    context: { project_id: "project_email_test", contact_id: "contact_email_test" }
  });
  assert.equal(created.conversation.status, "open");

  const outbound = await client.request("POST", `/v1/messaging/organizations/${orgId}/conversations/${created.conversation.id}/messages`, {
    channel: "email",
    purpose: "project_update",
    recipients: [{ address: "customer@example.test", contact_id: "contact_email_test" }],
    content: { subject: "Your roof project", text: "We have scheduled your material delivery." },
    context: { project_id: "project_email_test" },
    idempotency_key: "project-email-test-1"
  });
  assert.equal(outbound.message.channel, "email");
  assert.equal(outbound.message.sender.identity_id, "firstmate_mail");

  const inbound = await client.request("POST", `/v1/messaging/developer/organizations/${orgId}/inbound`, {
    channel: "email",
    conversation_id: created.conversation.id,
    from: { address: "customer@example.test", contact_id: "contact_email_test" },
    to: { address: "noreply@1m8.ai" },
    content: { subject: "Re: Your roof project", text: "Thank you. That date works for us." },
    context: { project_id: "project_email_test" }
  });
  assert.equal(inbound.message.direction, "inbound");
  assert.equal(inbound.message.status, "delivered");

  const detail = await client.request("GET", `/v1/messaging/organizations/${orgId}/conversations/${created.conversation.id}`);
  assert.equal(detail.conversation.messages.length, 2);
  assert.deepEqual(detail.conversation.messages.map((message: any) => message.direction), ["outbound", "inbound"]);

  const invalid = await client.raw("POST", `/v1/messaging/organizations/${orgId}/messages`, {
    channel: "email",
    recipients: [{ address: "not-an-email" }],
    content: { subject: "Invalid recipient", text: "This should be rejected." }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(invalid.body).error, "invalid_recipient");
});

test("communications developer log page is authenticated and organization scoped", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/v1/messaging/developer/test-messages" });
  assert.equal(anonymous.statusCode, 401);

  const client = createSessionClient();
  const { orgId } = await register(client);
  const page = await client.raw("GET", "/v1/messaging/developer/test-messages");
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.match(page.body, /Communications Test Log/);
  assert.match(page.body, new RegExp(orgId));
  assert.match(page.body, /\/organizations\//);
});

test("Work automations send through the same organization communications service", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_communication_automation";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Communications Automation", branch_id: "default", test_phone: "+12065550188", events: [] },
    metadata: { kind: "platform_project" }
  });
  const created = await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_communication_automation",
    title: "Communications Automation",
    source_key: "test:communications-automation",
    root_nodes: [{
      id: "send_reminder",
      title: "Send reminder",
      actionable: true,
      automation_bindings: {
        onCompleted: [{
          id: "send_sms",
          automation: "communications.sendSms.v1",
          input: {
            to: "{{project.test_phone}}",
            text: "The project reminder task was completed.",
            purpose: "project_update"
          }
        }]
      }
    }]
  });
  const task = created.tree.root_nodes[0];
  await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${task.id}/transition`, { status: "completed" });

  const messages = await client.request("GET", `/v1/messaging/developer/organizations/${orgId}/messages?project_id=${projectId}`);
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].channel, "sms");
  assert.equal(messages.messages[0].recipients[0].address, "+12065550188");
  assert.equal(messages.messages[0].source.type, "automation");
  assert.equal(messages.messages[0].source.automation_id, "communications.sendSms.v1");

  const executions = await client.request("GET", `/v1/work/organizations/${orgId}/executions`);
  assert.ok(executions.executions.some((execution: any) => execution.automation === "communications.sendSms.v1" && execution.status === "succeeded"));
});

test("live Telnyx transport requires consent and signed webhooks finalize delivery, meter cost, and enforce STOP", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const localNumber = "+12065550177";
  const recipientNumber = "+12065550178";
  const consentId = "consent_live_telnyx_1";
  const providerMessageId = "telnyx-message-live-1";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  const requests: { url: string; body: any }[] = [];
  let providerResponded = false;
  let server: Server | null = null;
  const serverUrl = await new Promise<string>((resolve) => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      requests.push({ url: request.url || "", body });
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/messages") {
        const earlyEnvelope = {
          data: {
            id: "telnyx-event-sent-before-response-1",
            event_type: "message.sent",
            occurred_at: new Date(Date.now() + 100).toISOString(),
            payload: {
              id: providerMessageId,
              direction: "outbound",
              type: "SMS",
              from: { phone_number: localNumber },
              to: [{ phone_number: recipientNumber, status: "queued" }]
            }
          }
        };
        const rawEarly = JSON.stringify(earlyEnvelope);
        const earlyTimestamp = String(Math.floor(Date.now() / 1000));
        const earlySignature = sign(null, Buffer.from(`${earlyTimestamp}|${rawEarly}`), privateKey).toString("base64");
        const earlyWebhook = await app.inject({
          method: "POST",
          url: `${new URL(body.webhook_url).pathname}${new URL(body.webhook_url).search}`,
          payload: rawEarly,
          headers: { "content-type": "application/json", "telnyx-timestamp": earlyTimestamp, "telnyx-signature-ed25519": earlySignature }
        });
        assert.equal(earlyWebhook.statusCode, 200, earlyWebhook.body);
        response.end(JSON.stringify({
          data: {
            id: providerMessageId,
            record_type: "message",
            direction: "outbound",
            type: "SMS",
            from: { phone_number: localNumber },
            to: [{ phone_number: recipientNumber, status: "queued" }],
            created_at: new Date().toISOString()
          }
        }));
        providerResponded = true;
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      assert.ok(address && typeof address === "object");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const { env } = await import("../src/config/env.js");
  const previous = {
    mode: env.communicationsDeliveryMode,
    key: env.telnyxApiKey,
    baseUrl: env.telnyxBaseUrl,
    publicKey: env.telnyxWebhookPublicKey,
    webhookUrl: env.telnyxWebhookUrl,
    encryptionKey: env.messagingEncryptionKey
  };
  try {
    const { createSmsComplianceProfile, ensureMessagingOrganization, updateSmsComplianceProfile } = await import("../messaging/storage.js");
    const messagingOrganization = await ensureMessagingOrganization(orgId);
    let profile = await createSmsComplianceProfile(messagingOrganization, {
      brand: { displayName: "SMS Test Org" },
      campaign: {
        selectedNumber: localNumber,
        consentAcknowledged: true,
        usecase: "AGENTS_FRANCHISES",
        enabledFeatures: ["operations"],
        optinKeywords: "START",
        optinMessage: "SMS Test Org: You are subscribed. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
        optoutKeywords: "STOP",
        optoutMessage: "SMS Test Org: You are unsubscribed. Reply START to resubscribe.",
        helpKeywords: "HELP",
        helpMessage: "SMS Test Org: Help at 206-555-0100. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out."
      },
      provider_refs: { telnyx_messaging_profile_id: "40000000-0000-0000-0000-000000000077", telnyx_campaign_id: "campaign-live-1" }
    });
    profile = await updateSmsComplianceProfile(profile, {
      status: "active",
      brand_status: "verified",
      campaign_status: "mno_provisioned",
      phone_number_status: "success",
      phone_number_campaign_status: "assigned",
      phone_number_campaign_id: "campaign-live-1"
    });
    const { smsAutoresponsePlan } = await import("../messaging/autoresponses.js");
    const autoresponsePlan = smsAutoresponsePlan(profile);
    assert.equal(autoresponsePlan.ok, true);
    profile = await updateSmsComplianceProfile(profile, {
      autoresponse_state: {
        status: "configured",
        messaging_profile_id: "40000000-0000-0000-0000-000000000077",
        desired_hash: autoresponsePlan.hash,
        applied_hash: autoresponsePlan.hash,
        config_ids: { start: "start-live", stop: "stop-live", info: "info-live" }
      }
    });
    const { claimPhoneNumberOwnership } = await import("../messaging/communications_storage.js");
    (await claimPhoneNumberOwnership({
      phone_number: localNumber,
      organization_id: orgId,
      compliance_profile_id: profile.id,
      messaging_profile_id: "40000000-0000-0000-0000-000000000077",
      status: "active"
    }));

    await client.request("POST", `/v1/messaging/organizations/${orgId}/sms/consents`, {
      phone_number: recipientNumber,
      status: "opted_in",
      consent_id: consentId,
      source: "web_form",
      disclosure_version: "sms-consent-v1",
      purposes: ["appointment"],
      evidence: { form_url: "https://example.test/contact", checkbox: true }
    });

    (env as any).communicationsDeliveryMode = "live";
    (env as any).telnyxApiKey = "KEY_TEST";
    (env as any).telnyxBaseUrl = serverUrl;
    (env as any).telnyxWebhookPublicKey = publicKeyPem;
    (env as any).telnyxWebhookUrl = "https://app.1m8.ai/v1/messaging/webhooks/telnyx";
    (env as any).messagingEncryptionKey = "test-messaging-encryption-key-with-sufficient-entropy";

    const sent = await client.request("POST", `/v1/messaging/organizations/${orgId}/messages`, {
      channel: "sms",
      purpose: "appointment",
      recipients: [{ address: recipientNumber, consent_id: consentId }],
      content: { text: "Your appointment is confirmed. Reply STOP to opt out." },
      idempotency_key: "live-telnyx-send-1"
    });
    assert.equal(sent.message.status, "queued");
    for (let attempt = 0; attempt < 100 && !providerResponded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(providerResponded, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.body.from, localNumber);
    assert.equal(requests[0]?.body.to, recipientNumber);
    const deliveryWebhookUrl = new URL(requests[0]?.body.webhook_url);
    assert.equal(`${deliveryWebhookUrl.origin}${deliveryWebhookUrl.pathname}`, "https://app.1m8.ai/v1/messaging/webhooks/telnyx");
    assert.equal(deliveryWebhookUrl.searchParams.get("delivery_id"), sent.message.deliveries[0].id);
    assert.ok(deliveryWebhookUrl.searchParams.get("delivery_token"));
    assert.equal(Object.hasOwn(requests[0]?.body, "client_state"), false);
    const accepted = await client.request("GET", `/v1/messaging/organizations/${orgId}/messages/${sent.message.id}`);
    assert.equal(accepted.message.status, "sent");

    const finalizedEnvelope = {
      data: {
        id: "telnyx-event-finalized-1",
        event_type: "message.finalized",
        occurred_at: new Date(Date.now() + 1000).toISOString(),
        payload: {
          id: providerMessageId,
          direction: "outbound",
          type: "SMS",
          from: { phone_number: localNumber },
          to: [{ phone_number: recipientNumber, status: "delivered" }],
          text: "Your appointment is confirmed. Reply STOP to opt out.",
          parts: 1,
          cost: { amount: "0.0075", currency: "USD" },
          completed_at: new Date(Date.now() + 1000).toISOString(),
          errors: []
        }
      }
    };
    const rawFinalized = JSON.stringify(finalizedEnvelope, null, 2);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${rawFinalized}`), privateKey).toString("base64");
    const finalized = await app.inject({
      method: "POST",
      url: "/v1/messaging/webhooks/telnyx",
      payload: rawFinalized,
      headers: { "content-type": "application/json", "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": signature }
    });
    assert.equal(finalized.statusCode, 200, finalized.body);

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/messaging/webhooks/telnyx",
      payload: rawFinalized,
      headers: { "content-type": "application/json", "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": signature }
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(JSON.parse(duplicate.body).duplicate, true);

    const delivered = await client.request("GET", `/v1/messaging/organizations/${orgId}/messages/${sent.message.id}`);
    assert.equal(delivered.message.status, "delivered");
    assert.equal(delivered.message.deliveries[0].status, "delivered");
    const usage = await client.request("GET", `/v1/messaging/organizations/${orgId}/sms/usage`);
    assert.equal(usage.summary.by_currency.USD.amount, "0.0075");
    assert.equal(usage.summary.by_currency.USD.segments, 1);
    assert.equal(usage.events.length, 1);

    const stopEnvelope = {
      data: {
        id: "telnyx-event-stop-1",
        event_type: "message.received",
        occurred_at: new Date(Date.now() + 2000).toISOString(),
        payload: {
          id: "telnyx-inbound-stop-1",
          direction: "inbound",
          type: "SMS",
          messaging_profile_id: "40000000-0000-0000-0000-000000000077",
          from: { phone_number: recipientNumber },
          to: [{ phone_number: localNumber }],
          text: "STOP",
          autoresponse_type: "STOP"
        }
      }
    };
    const rawStop = JSON.stringify(stopEnvelope);
    const stopTimestamp = String(Math.floor(Date.now() / 1000));
    const stopSignature = sign(null, Buffer.from(`${stopTimestamp}|${rawStop}`), privateKey).toString("base64");
    const stopped = await app.inject({
      method: "POST",
      url: "/v1/messaging/webhooks/telnyx",
      payload: rawStop,
      headers: { "content-type": "application/json", "telnyx-timestamp": stopTimestamp, "telnyx-signature-ed25519": stopSignature }
    });
    assert.equal(stopped.statusCode, 200, stopped.body);

    const infoEnvelope = {
      data: {
        id: "telnyx-event-info-1",
        event_type: "message.received",
        occurred_at: new Date(Date.now() + 3000).toISOString(),
        payload: {
          id: "telnyx-inbound-info-1",
          direction: "inbound",
          type: "SMS",
          messaging_profile_id: "40000000-0000-0000-0000-000000000077",
          from: { phone_number: recipientNumber },
          to: [{ phone_number: localNumber }],
          text: "SUPPORT",
          autoresponse_type: "INFO"
        }
      }
    };
    const rawInfo = JSON.stringify(infoEnvelope);
    const infoTimestamp = String(Math.floor(Date.now() / 1000));
    const infoSignature = sign(null, Buffer.from(`${infoTimestamp}|${rawInfo}`), privateKey).toString("base64");
    const info = await app.inject({
      method: "POST",
      url: "/v1/messaging/webhooks/telnyx",
      payload: rawInfo,
      headers: { "content-type": "application/json", "telnyx-timestamp": infoTimestamp, "telnyx-signature-ed25519": infoSignature }
    });
    assert.equal(info.statusCode, 200, info.body);
    assert.equal(requests.length, 1, "FirstMate must not send a duplicate local HELP response when Telnyx auto-responds");

    const managedResponseEnvelope = {
      data: {
        id: "telnyx-event-managed-response-1",
        event_type: "message.finalized",
        occurred_at: new Date(Date.now() + 4000).toISOString(),
        payload: {
          id: "telnyx-managed-response-1",
          direction: "outbound",
          type: "SMS",
          messaging_profile_id: "40000000-0000-0000-0000-000000000077",
          from: { phone_number: localNumber },
          to: [{ phone_number: recipientNumber, status: "delivered" }],
          parts: 1,
          cost: { amount: "0.002", currency: "USD" },
          completed_at: new Date(Date.now() + 4000).toISOString()
        }
      }
    };
    const rawManagedResponse = JSON.stringify(managedResponseEnvelope);
    const managedResponseTimestamp = String(Math.floor(Date.now() / 1000));
    const managedResponseSignature = sign(null, Buffer.from(`${managedResponseTimestamp}|${rawManagedResponse}`), privateKey).toString("base64");
    const managedResponse = await app.inject({
      method: "POST",
      url: "/v1/messaging/webhooks/telnyx",
      payload: rawManagedResponse,
      headers: { "content-type": "application/json", "telnyx-timestamp": managedResponseTimestamp, "telnyx-signature-ed25519": managedResponseSignature }
    });
    assert.equal(managedResponse.statusCode, 200, managedResponse.body);
    const usageAfterManagedResponse = await client.request("GET", `/v1/messaging/organizations/${orgId}/sms/usage`);
    assert.ok(usageAfterManagedResponse.events.some((event: any) => event.provider_message_id === "telnyx-managed-response-1"
      && event.metadata?.provider_managed === true));

    const blocked = await client.raw("POST", `/v1/messaging/organizations/${orgId}/messages`, {
      channel: "sms",
      purpose: "appointment",
      recipients: [{ address: recipientNumber, consent_id: consentId }],
      content: { text: "This must not be submitted after STOP." },
      idempotency_key: "live-telnyx-send-blocked"
    });
    assert.equal(blocked.statusCode, 400, blocked.body);
    assert.equal(JSON.parse(blocked.body).error, "sms_consent_required");
    assert.equal(requests.length, 1);

    const invalidSignature = await app.inject({
      method: "POST",
      url: "/v1/messaging/webhooks/telnyx",
      payload: rawStop,
      headers: { "content-type": "application/json", "telnyx-timestamp": stopTimestamp, "telnyx-signature-ed25519": Buffer.alloc(64).toString("base64") }
    });
    assert.equal(invalidSignature.statusCode, 401, invalidSignature.body);
  } finally {
    (env as any).communicationsDeliveryMode = previous.mode;
    (env as any).telnyxApiKey = previous.key;
    (env as any).telnyxBaseUrl = previous.baseUrl;
    (env as any).telnyxWebhookPublicKey = previous.publicKey;
    (env as any).telnyxWebhookUrl = previous.webhookUrl;
    (env as any).messagingEncryptionKey = previous.encryptionKey;
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  }
});
