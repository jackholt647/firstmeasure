import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Money onboarding slice: the env-derived default merchant provider and the
 * money_onboarding attention source (all five states) computed from
 * capabilities + merchant config + boarding application state.
 */

let app: any = null;
let storageRoot = "";

const US_PLAN_ID = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}),
        ...extraHeaders
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await raw(method, url, payload, extraHeaders);
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payments-onboarding-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.V1_LOG_LEVEL = "error";
  // No Forward credentials: the environment default must resolve to mock.
  process.env.FORWARD_WEBHOOK_SECRET = "";
  process.env.FORWARD_PRIVATE_KEY = "";
  process.env.FORWARD_PUBLIC_KEY = "";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  (await closeWorkforceDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>, options: { moneyFlags?: boolean } = {}) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `onboarding-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Onboarding Owner",
    company: "Onboarding Test Org",
    organization_id: `org_onb_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  if (options.moneyFlags !== false) {
    const { saveGlobal } = await import("../platform/storage.js");
    await saveGlobal(orgId, {
      data: {
        app_flags: {
          platform: { expanded_access: true, money: true },
          money: { merchant_processing: true }
        }
      }
    }, { replace: false });
  }
  return { orgId };
}

function moneyEntry(feed: any) {
  return (feed.entries as any[]).find((entry) => entry.id === "attention_money_onboarding") || null;
}

test("defaultMerchantProvider resolves mock without Forward keys and getMerchantConfig persists it on first read", async () => {
  const { defaultMerchantProvider } = await import("../payments/merchant_config.js");
  assert.equal(defaultMerchantProvider(), "mock");

  const client = createSessionClient();
  const { orgId } = await register(client);
  const first = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(first.merchant_config.provider, "mock", "fresh org gets the env default");

  // Persisted: the ops read (which never defaults) now sees the stored value.
  const { getMerchantConfigForOps } = await import("../payments/merchant_config.js");
  const stored = await getMerchantConfigForOps(orgId);
  assert.equal(stored?.provider, "mock");

  // Boarding is therefore available on a fresh org with zero setup calls.
  const plans = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-boarding/processing-plans`);
  assert.ok(plans.processing_plans.length >= 2);
});

test("an explicitly stored provider is never overwritten by the default", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "forward" });
  const read = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(read.merchant_config.provider, "forward");
});

test("bank_account rides the boarding application payload into the mock application raw", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const created = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications`, {
    business: { name: "Bank Slot Test Co" },
    company: { legal_name: "Bank Slot Test Co", ein: "12-3456789" },
    address: { address1: "1 Test Way", city: "Austin" },
    bank_account: { routing_number: "021000021", account_number: "000123456789", account_type: "checking", holder_name: "Bank Slot Test Co" }
  });
  const applicationId = created.application.id as string;
  assert.deepEqual(created.application.raw.bank_account, {
    routing_number: "021000021",
    account_number: "000123456789",
    account_type: "checking",
    holder_name: "Bank Slot Test Co"
  });

  const patched = await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${applicationId}`, {
    bank_account: { account_type: "savings" }
  });
  assert.equal(patched.application.raw.bank_account.account_type, "savings");
  assert.equal(patched.application.raw.bank_account.routing_number, "021000021", "partial patch merges, does not replace");
});

test("money_onboarding attention source walks all five states", async (t) => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const attentionUrl = `/v1/platform/organizations/${orgId}/attention`;
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;

  await t.test("gated off when the money capabilities are off", async () => {
    const gatedClient = createSessionClient();
    const { orgId: gatedOrg } = await register(gatedClient, { moneyFlags: false });
    const feed = await gatedClient.request("GET", `/v1/platform/organizations/${gatedOrg}/attention`);
    assert.equal(moneyEntry(feed), null);
  });

  await t.test("state 1: no application -> active on all three surfaces, non-dismissible, resumes at business", async () => {
    const feed = await client.request("GET", attentionUrl);
    const entry = moneyEntry(feed);
    assert.ok(entry, "entry present when both money capabilities are on");
    assert.equal(entry.state, "active");
    assert.equal(entry.priority, 100);
    assert.equal(entry.tone, "orange");
    assert.deepEqual(entry.surfaces, ["topbar", "sidebar", "notification"]);
    assert.deepEqual(entry.dismissible, { topbar: false, sidebar: false, notification: false });
    assert.match(entry.title, /Finish setting up payments/);
    assert.match(entry.body, /Complete your onboarding to start taking payments/);
    assert.deepEqual(entry.frontend_action.route, {
      tab: "company_settings", sub: "money", settingsView: "payments", workflow: "money_onboarding", workflow_step: "business"
    });
  });

  let applicationId = "";
  await t.test("state 1 (DRAFT): resume step advances as the draft fills in", async () => {
    const created = await client.request("POST", `${boardingBase}/applications`, {
      business: { name: "Attention Walk Co" },
      company: { legal_name: "Attention Walk Co", ein: "12-3456789" },
      address: { address1: "9 Ridge Road", city: "Austin" }
    });
    applicationId = created.application.id as string;
    const afterBusiness = moneyEntry(await client.request("GET", attentionUrl));
    assert.equal(afterBusiness.frontend_action.route.workflow_step, "owners", "business complete -> resume at owners");

    await client.request("PATCH", `${boardingBase}/applications/${applicationId}`, {
      owners: [{ name: "Rita Ridge", ownership_percent: 100, signer: true }],
      volumes: { annual_volume: 250000, avg_ticket: 8000 }
    });
    const afterVolumes = moneyEntry(await client.request("GET", attentionUrl));
    assert.equal(afterVolumes.frontend_action.route.workflow_step, "bank", "owners+volumes complete -> resume at bank");

    // Bank complete WITHOUT a plan: still a wizard resume, at review.
    await client.request("PATCH", `${boardingBase}/applications/${applicationId}`, {
      bank_account: { routing_number: "021000021", account_number: "000123456789", account_type: "checking", holder_name: "Attention Walk Co" }
    });
    const afterBank = moneyEntry(await client.request("GET", attentionUrl));
    assert.equal(afterBank.frontend_action.route.workflow_step, "review", "bank complete -> resume at review");
    assert.equal(afterBank.state, "active");

    // Plan chosen -> every wizard step is complete; what remains (signatures,
    // verification, submission) happens on Forward's HOSTED application, so
    // the entry flips to the hosted-handoff copy and lands on the Payments
    // pane (which offers the link) instead of the wizard.
    await client.request("PATCH", `${boardingBase}/applications/${applicationId}`, { processing_plan_id: US_PLAN_ID });
    const complete = moneyEntry(await client.request("GET", attentionUrl));
    assert.equal(complete.state, "active");
    assert.match(complete.title, /Finish your application on Forward's secure page/);
    assert.deepEqual(complete.frontend_action.route, { tab: "company_settings", sub: "money", settingsView: "payments" });
  });

  await t.test("state 3: submitted / UNDER_REVIEW -> waiting, notification surface only, no workflow keys", async () => {
    await client.request("POST", `${boardingBase}/applications/${applicationId}/submit`, {});
    const entry = moneyEntry(await client.request("GET", attentionUrl));
    assert.ok(entry);
    assert.equal(entry.state, "waiting");
    assert.deepEqual(entry.surfaces, ["notification"]);
    assert.match(entry.title, /under review/i);
    assert.deepEqual(entry.frontend_action.route, { tab: "company_settings", sub: "money", settingsView: "payments" });
  });

  await t.test("state 2: NEED_INFORMATION -> active on all three surfaces, CTA lands on the Payments pane (docs upload on Forward's hosted form)", async () => {
    await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
      op: "underwriting", to: "NEED_INFORMATION",
      documents_requested: [{ type: "bank_statement", description: "3 months of statements" }]
    });
    const entry = moneyEntry(await client.request("GET", attentionUrl));
    assert.ok(entry);
    assert.equal(entry.state, "active");
    assert.equal(entry.priority, 100);
    assert.deepEqual(entry.surfaces, ["topbar", "sidebar", "notification"]);
    assert.deepEqual(entry.dismissible, { topbar: false, sidebar: false, notification: false });
    assert.match(entry.title, /Action needed on your payments application/);
    assert.match(entry.body, /Forward's secure application page/);
    assert.deepEqual(entry.frontend_action.route, { tab: "company_settings", sub: "money", settingsView: "payments" });
  });

  await t.test("state 4: approved with payouts pending -> waiting, notification only", async () => {
    await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "underwriting", to: "APPROVED" });
    // Mock approval enables payouts; simulate the enablement gap explicitly.
    await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { forward: { payouts_enabled: false } });
    const entry = moneyEntry(await client.request("GET", attentionUrl));
    assert.ok(entry);
    assert.equal(entry.state, "waiting");
    assert.deepEqual(entry.surfaces, ["notification"]);
    assert.match(entry.title, /Almost there/);
    assert.deepEqual(entry.frontend_action.route, { tab: "company_settings", sub: "money", settingsView: "payments" });
  });

  await t.test("state 5: approved with payouts enabled -> no entries", async () => {
    await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { forward: { payouts_enabled: true } });
    const feed = await client.request("GET", attentionUrl);
    assert.equal(moneyEntry(feed), null);
  });
});

test("hosted application link: generated, persisted, reused until expiry, regenerated after", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;
  const created = await client.request("POST", `${boardingBase}/applications`, {
    business: { name: "Hosted Link Co" },
    company: { legal_name: "Hosted Link Co", ein: "12-3456789" },
    address: { address1: "1 Link Lane", city: "Austin" }
  });
  const applicationId = created.application.id as string;

  const first = await client.request("POST", `${boardingBase}/applications/${applicationId}/link`, {});
  assert.match(first.link.url, /^https:\/\/application\.mock\.local\/aapplink_mock_/, "mock link mirrors Forward's aapplink URL shape");
  assert.ok(Date.parse(first.link.expires_at) > Date.now(), "link carries a future expiry");
  assert.equal(first.link.reused, false);
  assert.equal(first.merchant_config.forward.application_link_url, first.link.url, "link persisted on merchant config");
  assert.equal(first.merchant_config.forward.application_link_expires_at, first.link.expires_at);

  // Second call within the expiry window reuses the stored link (no churn).
  const second = await client.request("POST", `${boardingBase}/applications/${applicationId}/link`, {});
  assert.equal(second.link.reused, true);
  assert.equal(second.link.url, first.link.url);

  // force skips reuse even inside the expiry window — surfaces that render
  // the link mint fresh because Forward can invalidate stored links early.
  const forced = await client.request("POST", `${boardingBase}/applications/${applicationId}/link`, { force: true });
  assert.equal(forced.link.reused, false);
  assert.notEqual(forced.link.url, first.link.url, "force mints a fresh URL");
  assert.equal(forced.merchant_config.forward.application_link_url, forced.link.url, "forced link persisted");

  // Force expiry -> the route regenerates and persists a fresh link.
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    forward: { application_link_expires_at: new Date(Date.now() - 60_000).toISOString() }
  });
  const third = await client.request("POST", `${boardingBase}/applications/${applicationId}/link`, {});
  assert.equal(third.link.reused, false);
  assert.notEqual(third.link.url, first.link.url, "expired link regenerates a fresh URL");
  assert.equal(third.merchant_config.forward.application_link_url, third.link.url);
});

test("hosted_submit advance op: merchant completing Forward's hosted workflow moves DRAFT -> UNDER_REVIEW through the shared event path", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;
  const created = await client.request("POST", `${boardingBase}/applications`, {
    business: { name: "Hosted Submit Co" },
    company: { legal_name: "Hosted Submit Co", ein: "12-3456789" },
    address: { address1: "2 Submit Street", city: "Austin" },
    processing_plan_id: US_PLAN_ID
  });
  const applicationId = created.application.id as string;

  const advanced = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "hosted_submit" });
  assert.equal(advanced.application.id, applicationId);
  assert.equal(advanced.application.status, "UNDER_REVIEW");
  assert.equal(advanced.application.raw.submitted_via, "hosted_application");
  // The synthesized v2.application.submitted event flowed through the shared
  // ingestion path and projected onto the merchant config.
  assert.equal(advanced.merchant_config.forward.boarding_status, "UNDER_REVIEW");

  // Only DRAFT / NEED_INFORMATION applications can be hosted-submitted.
  const repeat = await client.raw("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "hosted_submit" });
  assert.equal(repeat.statusCode, 400);
  assert.equal(JSON.parse(repeat.body).error, "mock_application_not_submittable");
});

test("merchant portal login-url: ensures the signer's portal user and mints a single-use magic link", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;
  await client.request("POST", `${boardingBase}/applications`, {
    business: { name: "Portal SSO Co" },
    company: { legal_name: "Portal SSO Co", ein: "12-3456789" },
    address: { address1: "3 Portal Place", city: "Austin" },
    owners: [{ name: "Sig Signer", email: "sig-signer@example.test", ownership_percent: 100, signer: true }]
  });

  const first = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-portal/login-url`, {});
  assert.match(first.login_url, /^https:\/\/portal\.mock\.local\/auth\/magic-link\?code=/);
  assert.match(first.user_id, /^user_mock_/);

  // Second mint reuses the same portal user (ensure semantics) with a fresh
  // single-use URL.
  const second = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-portal/login-url`, {});
  assert.equal(second.user_id, first.user_id);
  assert.notEqual(second.login_url, first.login_url);
});

test("hosted-first signup harness: one call creates a minimal draft + hosted link, reruns reuse the application", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;

  // No Forward keys in this suite -> environment is "" and the provider is
  // mock, which the harness explicitly allows.
  const configBefore = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(configBefore.forward_environment, "");
  assert.equal(configBefore.merchant_config.provider, "mock");

  const first = await client.request("POST", `${boardingBase}/hosted-signup`, { business_name: "Hosted First Co" });
  const applicationId = first.application.id as string;
  assert.ok(applicationId, "draft application created");
  assert.equal(first.application.status, "DRAFT");
  assert.match(first.link.url, /^https:\/\/application\.mock\.local\/aapplink_mock_/, "hosted link mirrors Forward's aapplink URL shape");
  assert.ok(Date.parse(first.link.expires_at) > Date.now(), "link carries a future expiry");
  assert.equal(first.merchant_config.forward.application_id, applicationId, "application persisted on merchant config");
  assert.equal(first.merchant_config.forward.application_link_url, first.link.url, "link persisted on merchant config");
  assert.ok(first.merchant_config.forward.business_id, "business persisted on merchant config");
  assert.ok(first.merchant_config.forward.processing_plan_id, "a processing plan was auto-assigned to the draft");

  // Rerun: same application, fresh-or-reused link, nothing duplicated.
  const second = await client.request("POST", `${boardingBase}/hosted-signup`, {});
  assert.equal(second.application.id, applicationId, "existing application is reused");
  assert.ok(second.link.url, "link still offered on rerun");

  // The Payments pane's tracked state matches what the harness stored.
  const configAfter = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(configAfter.merchant_config.forward.application_id, applicationId);
  assert.equal(configAfter.merchant_config.forward.boarding_status, "DRAFT");

  // The harness composes with the rest of the mock lifecycle: hosted submit
  // then approval work against the harness-created draft.
  const advanced = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "hosted_submit" });
  assert.equal(advanced.merchant_config.forward.boarding_status, "UNDER_REVIEW");
});

test("a submitted hosted application cannot be offered as a draft again", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;
  const created = await client.request("POST", `${boardingBase}/hosted-signup`, { business_name: "Submitted Link Co" });
  const applicationId = created.application.id as string;
  await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "hosted_submit" });
  // Simulate a hosted submission whose webhook has not updated our tracked state.
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    forward: { boarding_status: "DRAFT" }
  });

  const attention = moneyEntry(await client.request("GET", `/v1/platform/organizations/${orgId}/attention`));
  assert.equal(attention.state, "waiting");
  assert.deepEqual(attention.surfaces, ["notification"]);
  assert.match(attention.title, /under review/i);

  const resumed = await client.request("POST", `${boardingBase}/hosted-signup`, {});
  assert.equal(resumed.already_submitted, true);
  assert.equal(resumed.link, null);
  assert.equal(resumed.application.status, "UNDER_REVIEW");
  assert.equal(resumed.merchant_config.forward.boarding_status, "UNDER_REVIEW");
  assert.equal(resumed.merchant_config.forward.application_link_url, "");

  const directLink = await client.raw("POST", `${boardingBase}/applications/${applicationId}/link`, { force: true });
  assert.equal(directLink.statusCode, 400);
  assert.equal(JSON.parse(directLink.body).error, "merchant_boarding_application_not_draft");
});

test("application GET shim syncs boarding_status from the provider (hosted submissions surface without webhooks)", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;
  const created = await client.request("POST", `${boardingBase}/hosted-signup`, { business_name: "Status Sync Co" });
  const applicationId = created.application.id as string;

  // Simulate our tracked status drifting from the provider's truth (webhooks
  // may not reach a local stack after an off-site hosted submission).
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    forward: { boarding_status: "UNDER_REVIEW" }
  });

  const synced = await client.request("GET", `${boardingBase}/applications/${applicationId}`);
  assert.equal(synced.application.status, "DRAFT", "provider truth: still a draft");
  assert.equal(synced.merchant_config?.forward?.boarding_status, "DRAFT", "GET shim resynced the tracked status to the provider's");

  const after = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(after.merchant_config.forward.boarding_status, "DRAFT");
});

test("application GET shim backfills the merchant account on approval (webhookless account discovery)", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;
  const created = await client.request("POST", `${boardingBase}/hosted-signup`, { business_name: "Account Backfill Co" });
  const applicationId = created.application.id as string;
  await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "hosted_submit" });
  await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "underwriting", to: "APPROVED" });

  // Simulate the webhookless case: approval happened provider-side but the
  // account id never reached our config.
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    forward: { account_id: "" }
  });

  const synced = await client.request("GET", `${boardingBase}/applications/${applicationId}`);
  assert.ok(synced.merchant_config, "sync patch returned the updated config");
  assert.match(synced.merchant_config.forward.account_id, /^acct_mock_/, "account id rediscovered from the provider's account list");
});

test("approval fires the one-time merchant-approved notification with the portal action", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;
  await client.request("POST", `${boardingBase}/hosted-signup`, { business_name: "Notify Co" });
  await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "hosted_submit" });
  await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "underwriting", to: "APPROVED" });

  const list = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const approved = (list.notifications as any[]).filter((n) => n.id === "merchant_processing_approved");
  assert.equal(approved.length, 1, "exactly one approval notification");
  assert.equal(approved[0].frontend_action?.kind, "open_merchant_portal");
  assert.match(approved[0].body, /bank account/i);

  // Re-syncing an already-approved org must not duplicate it.
  const config = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  await client.request("GET", `${boardingBase}/applications/${config.merchant_config.forward.application_id}`);
  const again = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal((again.notifications as any[]).filter((n) => n.id === "merchant_processing_approved").length, 1);
});

test("hosted-first signup harness: concurrent calls share ONE link generation (Forward keeps one active link per application)", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardingBase = `/v1/payments/organizations/${orgId}/merchant-boarding`;
  await client.request("POST", `${boardingBase}/hosted-signup`, { business_name: "Single Flight Co" });

  // The route deep link and pane init can both request signup within
  // milliseconds; if each minted its own link the first one would be
  // invalidated before it rendered.
  const [a, b] = await Promise.all([
    client.request("POST", `${boardingBase}/hosted-signup`, {}),
    client.request("POST", `${boardingBase}/hosted-signup`, {})
  ]);
  assert.equal(a.application.id, b.application.id);
  assert.equal(a.link.url, b.link.url, "concurrent calls receive the SAME link");
  assert.ok(a.shared_in_flight === true || b.shared_in_flight === true, "one of the two calls was deduped onto the other's in-flight work");
});
