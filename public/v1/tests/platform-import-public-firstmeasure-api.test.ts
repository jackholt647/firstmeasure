import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";
let apiKey = "";
let otherApiKey = "";
let autoTopupKey = "";
let lowCreditKey = "";
let expiredApiKey = "";
let emailFlagApiKey = "";
let campaignApiKey = "";
let testModeApiKey = "";
let originalFetch: typeof globalThis.fetch;
const sentPostmarkPayloads: any[] = [];
const rejectedPostmarkRecipients = new Set<string>();

async function request(method: string, url: string, payload?: unknown, key = apiKey) {
  const response = await (app.inject as any)({
    method,
    url,
    payload,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(payload ? { "content-type": "application/json" } : {})
    }
  });
  let json: any = null;
  try {
    json = response.body ? JSON.parse(response.body) : null;
  } catch {
    json = null;
  }
  return { response, json };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-public-firstmeasure-test-"));
  process.env.NODE_ENV = "test";
  process.env.FIRSTMEASURE_INTERNAL_API_SECRET = "isolated-public-import-secret";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  process.env.PUBLIC_FIRSTMEASURE_API_KEY_SECRET = "public-firstmeasure-test-secret";
  process.env.GOOGLE_MAPS_API_KEY = "gmaps_public_firstmeasure_test";
  process.env.STRIPE_TEST_MODE = "1";
  process.env.STRIPE_TEST_SECRET_KEY = "sk_test_public_firstmeasure";
  process.env.FIRSTMEASURE_POSTMARK_TOKEN = "pm_test_public_firstmeasure";

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.postmarkapp.com/email" && String(init?.method || "").toUpperCase() === "POST") {
      const payload = JSON.parse(String(init?.body ?? "{}"));
      sentPostmarkPayloads.push(payload);
      const to = String(payload.To ?? "").toLowerCase();
      if ([...rejectedPostmarkRecipients].some((email) => to.includes(email))) {
        return new Response(JSON.stringify({
          ErrorCode: 300,
          Message: "Invalid recipient"
        }), { status: 422, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        To: "recipient@example.test",
        SubmittedAt: new Date().toISOString(),
        MessageID: `pm-test-${sentPostmarkPayloads.length}`,
        ErrorCode: 0,
        Message: "OK"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://api.stripe.com/v1/payment_intents" && String(init?.method || "").toUpperCase() === "POST") {
      return new Response(JSON.stringify({
        id: "pi_public_firstmeasure_autotopup",
        status: "succeeded",
        amount: 10000,
        currency: "usd"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://maps.googleapis.com/maps/api/geocode/json")) {
      return new Response(JSON.stringify({
        status: "OK",
        results: [{
          formatted_address: "123 Public API Way, Seattle, WA 98101, USA",
          geometry: { location: { lat: 47.61, lng: -122.33 } }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected external request in isolated test: ${new URL(url).origin}`);
  }) as typeof globalThis.fetch;

  const { createOrganization, saveGlobal } = await import("../platform/storage.js");
  await createOrganization({
    id: "org_public_api",
    name: "Public API Roofing",
    global: {
      credits_balance: 500,
      credits_ledger: [],
      billing: {
        stripe: { has_payment_method: true, payment_method_id: "pm_public_test", customer_id: "cus_public_test", last4: "4242" },
        auto_topup: { enabled: false, status: "idle" }
      }
    }
  });
  await createOrganization({
    id: "org_public_other",
    name: "Other Public API Roofing",
    global: {
      credits_balance: 500,
      credits_ledger: [],
      billing: {
        stripe: { has_payment_method: true, payment_method_id: "pm_public_other", customer_id: "cus_public_other", last4: "5555" },
        auto_topup: { enabled: false, status: "idle" }
      }
    }
  });
  await createOrganization({
    id: "org_public_autotopup",
    name: "Public API Auto Topup Roofing",
    global: {
      credits_balance: 45,
      credits_ledger: [],
      billing: {
        stripe: { has_payment_method: true, payment_method_id: "pm_public_auto", customer_id: "cus_public_auto", last4: "1111" },
        auto_topup: { enabled: true, threshold_dollars: 50, topup_dollars: 100, cooldown_minutes: 0, status: "idle" }
      }
    }
  });
  await createOrganization({
    id: "org_public_low_credit",
    name: "Public API Low Credit Roofing",
    global: {
      credits_balance: 20,
      credits_ledger: [],
      billing: {
        stripe: { has_payment_method: false },
        auto_topup: { enabled: false, status: "idle" }
      }
    }
  });
  await createOrganization({
    id: "org_public_email_flag",
    name: "Public API Email Flag Roofing",
    global: {
      credits_balance: 500,
      credits_ledger: [],
      app_flags: {
        firstmeasure: {
          report_expedite_options: false,
          bonus_upfront_match: false
        }
      },
      billing: {
        stripe: { has_payment_method: true, payment_method_id: "pm_public_email_flag", customer_id: "cus_public_email_flag", last4: "2222" },
        auto_topup: { enabled: false, status: "idle" }
      }
    }
  });
  await createOrganization({
    id: "org_public_bonus_campaign",
    name: "Public API Bonus Campaign Roofing",
    global: {
      credits_balance: 500,
      credits_ledger: [],
      app_flags: {
        firstmeasure: {
          report_expedite_options: false,
          bonus_upfront_match: true
        }
      },
      billing: {
        stripe: { has_payment_method: true, payment_method_id: "pm_public_campaign", customer_id: "cus_public_campaign", last4: "3333" },
        auto_topup: { enabled: false, status: "idle" }
      }
    }
  });
  await createOrganization({
    id: "org_public_test_mode",
    name: "Public API Test Mode Roofing",
    global: {
      app_flags: { firstmeasure: { gutter_reports: false, weather_reports: false, report_expedite_options: false } },
      credits_balance: 0,
      credits_ledger: [],
      billing: {
        stripe: { has_payment_method: false },
        auto_topup: { enabled: false, status: "idle" }
      }
    }
  });
  await saveGlobal("org_public_api", {
    data: {
      credits_balance: 500,
      app_flags: {
        firstmeasure: {
          gutter_reports: true,
          weather_reports: true,
          report_expedite_options: true
        }
      },
      branding: {
        logo: "https://cdn.example.test/platform-roofing.png",
        colors: {
          primary: "#456789",
          secondary: "#fedcba"
        }
      },
      report_settings: {
        page_summary: true
      }
    }
  });

  const { createPublicFirstMeasureApiKey } = await import("../public-firstmeasure/keys.js");
  apiKey = (await createPublicFirstMeasureApiKey({
    orgId: "org_public_api",
    name: "Live-mode test key",
    mode: "live",
    createdBy: "test"
  })).key;
  otherApiKey = (await createPublicFirstMeasureApiKey({
    orgId: "org_public_other",
    name: "Other live-mode test key",
    mode: "live",
    createdBy: "test"
  })).key;
  autoTopupKey = (await createPublicFirstMeasureApiKey({
    orgId: "org_public_autotopup",
    name: "Auto topup test key",
    mode: "live",
    createdBy: "test"
  })).key;
  lowCreditKey = (await createPublicFirstMeasureApiKey({
    orgId: "org_public_low_credit",
    name: "Low credit test key",
    mode: "live",
    createdBy: "test"
  })).key;
  expiredApiKey = (await createPublicFirstMeasureApiKey({
    orgId: "org_public_api",
    name: "Expired test key",
    mode: "test",
    createdBy: "test",
    expiresAt: "2020-01-01T00:00:00.000Z"
  })).key;
  emailFlagApiKey = (await createPublicFirstMeasureApiKey({
    orgId: "org_public_email_flag",
    name: "Email flag test key",
    mode: "live",
    createdBy: "test"
  })).key;
  campaignApiKey = (await createPublicFirstMeasureApiKey({
    orgId: "org_public_bonus_campaign",
    name: "Bonus campaign email test key",
    mode: "live",
    createdBy: "test"
  })).key;
  testModeApiKey = (await createPublicFirstMeasureApiKey({
    orgId: "org_public_test_mode",
    name: "Sandbox test mode key",
    mode: "test",
    createdBy: "test",
    requireBilling: false
  })).key;

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (app) await app.close();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
});

test("public FirstMeasure API rejects expired API keys", async () => {
  const { response, json } = await request("GET", "/v1/public/firstmeasure/balance", undefined, expiredApiKey);
  assert.equal(response.statusCode, 403);
  assert.equal(json.ok, false);
  assert.equal(json.error, "api_key_expired");
});

test("standard expedite due window end follows the estimated wait", async () => {
  const { buildReportExpediteOptions } = await import("../firstmeasure/expedite.js");
  const quote = buildReportExpediteOptions({
    projectType: "residential",
    structureCount: 1,
    now: new Date("2026-06-16T19:00:00.000Z")
  });
  const standard = quote.options.find((option) => option.key === "standard_3_6");
  assert.ok(standard);
  assert.equal(standard.end_minutes, standard.estimated_wait_minutes);
  assert.equal(
    Date.parse(String(standard.due_window_end)),
    Date.parse(quote.generated_at) + Number(standard.estimated_wait_minutes) * 60_000
  );
});

test("new expedite options expose production deadlines before customer promise times", async () => {
  const { buildReportExpediteOptions } = await import("../firstmeasure/expedite.js");
  const quote = buildReportExpediteOptions({
    projectType: "residential",
    structureCount: 1,
    now: new Date("2026-06-16T19:00:00.000Z")
  });
  const underOne = quote.options.find((option) => option.key === "rush_under_1");
  const oneToThree = quote.options.find((option) => option.key === "rush_1_3");
  assert.ok(underOne);
  assert.ok(oneToThree);
  assert.equal(underOne.label, "Less than 1 hr rush");
  assert.equal(underOne.start_minutes, 50);
  assert.equal(underOne.end_minutes, 60);
  assert.equal(oneToThree.label, "1-3 hr rush");
  assert.equal(oneToThree.start_minutes, 60);
  assert.equal(oneToThree.end_minutes, 180);
  assert.equal(oneToThree.production_deadline_minutes, 120);
  assert.equal(Date.parse(String(underOne.due_window_start)), Date.parse(quote.generated_at) + 50 * 60_000);
  assert.equal(Date.parse(String(oneToThree.due_window_start)), Date.parse(quote.generated_at) + 60 * 60_000);
  assert.equal(Date.parse(String(oneToThree.production_deadline_at)), Date.parse(quote.generated_at) + 120 * 60_000);
});

test("commercial expedite options add half an hour per additional structure", async () => {
  const { buildReportExpediteOptions } = await import("../firstmeasure/expedite.js");
  const quote = buildReportExpediteOptions({
    projectType: "commercial",
    structureCount: 3,
    now: new Date("2026-06-16T19:00:00.000Z")
  });
  const underOne = quote.options.find((option) => option.key === "rush_under_1");
  const oneToThree = quote.options.find((option) => option.key === "rush_1_3");
  const standard = quote.options.find((option) => option.key === "standard_3_6");
  assert.ok(underOne);
  assert.ok(oneToThree);
  assert.ok(standard);
  assert.equal(underOne.start_minutes, 110);
  assert.equal(underOne.end_minutes, 120);
  assert.equal(underOne.production_deadline_minutes, 110);
  assert.equal(oneToThree.start_minutes, 120);
  assert.equal(oneToThree.end_minutes, 240);
  assert.equal(oneToThree.production_deadline_minutes, 180);
  assert.equal(standard.start_minutes, 300);
  assert.equal(standard.additional_structure_minutes, 60);
});

test("direct FirstMeasure coverage rejection refunds charged credits once", async () => {
  const { createOrganization, readGlobal } = await import("../platform/storage.js");
  const suffix = Date.now();
  const orgId = `org_rejection_refund_${suffix}`;
  const projectId = `rejection-refund-${suffix}`;
  await createOrganization({
    id: orgId,
    name: "Rejection Refund Roofing",
    global: {
      credits_balance: 100,
      credits_ledger: [],
      billing: {
        stripe: { has_payment_method: false },
        auto_topup: { enabled: false, status: "idle" }
      }
    }
  });

  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id: projectId,
      address: "123 Refund Rejection Way, Seattle, WA",
      status: "queued",
      project_type: "residential",
      amount_charged: 7,
      organization_ref: { id: orgId, name: "Rejection Refund Roofing" },
      owner_ref: { email: "refund-rejection@example.test", name: "Refund Rejection" },
      team_ref: { id: "default" }
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(created.statusCode, 201, created.body);

  const rejectPayload = {
    rejection_reason: "invalid_pin_placement",
    note: "Pin is not on the target structure",
    actor: { email: "qa-refunds@example.test", name: "QA Refunds" }
  };
  const rejected = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}/coverage/reject`,
    payload: rejectPayload,
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  const rejectedJson = JSON.parse(rejected.body);
  assert.equal(rejectedJson.manifest.status, "rejected");
  assert.equal(rejectedJson.manifest.refund_issued, true);
  assert.equal(rejectedJson.manifest.refund_amount, 7);
  assert.equal(rejectedJson.manifest.refund_reason, "rejection_refund");
  assert.equal(rejectedJson.manifest.customer_rejection_title, "Project rejected");
  assert.match(
    rejectedJson.manifest.customer_rejection_message,
    /selected pin does not appear to be placed on a structure/
  );

  const rejectedCardBucket = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/queue/bucket",
    payload: { group: "rejected", view: "card", limit: 10, include_all: true },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(rejectedCardBucket.statusCode, 200, rejectedCardBucket.body);
  const rejectedCardJson = JSON.parse(rejectedCardBucket.body);
  const rejectedCard = rejectedCardJson.projects.find((project: any) => project.id === projectId);
  assert.ok(rejectedCard, rejectedCardBucket.body);
  assert.equal(rejectedCard.rejection_reason, "invalid_pin_placement");
  assert.equal(rejectedCard.refund_issued, true);
  assert.equal(rejectedCard.refund_amount, 7);
  assert.match(
    rejectedCard.customer_rejection_message,
    /selected pin does not appear to be placed on a structure/
  );

  const rejectedFullBucket = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/queue/bucket",
    payload: { group: "rejected", view: "full", limit: 10, include_all: true },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(rejectedFullBucket.statusCode, 200, rejectedFullBucket.body);
  const rejectedFullJson = JSON.parse(rejectedFullBucket.body);
  const rejectedFull = rejectedFullJson.projects.find((project: any) => project.id === projectId);
  assert.ok(rejectedFull, rejectedFullBucket.body);
  assert.equal(rejectedFull.rejection_reason, "invalid_pin_placement");
  assert.equal(rejectedFull.refund_issued, true);
  assert.equal(rejectedFull.refund_amount, 7);
  assert.match(
    rejectedFull.customer_rejection_message,
    /selected pin does not appear to be placed on a structure/
  );

  const refundedGlobal = await readGlobal(orgId);
  assert.equal(refundedGlobal.data.credits_balance, 107);
  const ledger = refundedGlobal.data.credits_ledger as any[];
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].delta, 7);
  assert.equal(ledger[0].reason, "rejection_refund");
  assert.equal(ledger[0].meta.project_id, projectId);

  const rejectedAgain = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}/coverage/reject`,
    payload: rejectPayload,
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(rejectedAgain.statusCode, 200, rejectedAgain.body);
  const afterRetryGlobal = await readGlobal(orgId);
  assert.equal(afterRetryGlobal.data.credits_balance, 107);
  assert.equal((afterRetryGlobal.data.credits_ledger as any[]).length, 1);
});

test("FirstMeasure organization context refreshes stale cached branding defaults from branch style", async () => {
  const { createOrganization, saveBranchModule, upsertDocument } = await import("../platform/storage.js");
  const suffix = Date.now();
  const orgId = `org_branch_branding_${suffix}`;
  const projectId = `branch-branding-${suffix}`;
  await createOrganization({
    id: orgId,
    name: "Original Red Roofing",
    global: {
      branding: {
        logo: "https://cdn.example.test/red-logo.png",
        colors: {
          primary: "#d93025",
          secondary: "#111111"
        }
      },
      report_settings: {
        page_summary: false
      }
    }
  });
  await upsertDocument(orgId, "branch", {
    id: "default",
    data: {
      name: "Branch Style Roofing",
      branding: {
        logo: "https://cdn.example.test/branch-logo.png",
        colors: {
          primary: "#287848",
          secondary: "#182230",
          accent: "#287848"
        }
      },
      report_settings: {
        cover_show_customer: false
      }
    }
  }, { replace: true });
  await saveBranchModule(orgId, "default", "presentation_style", {
    data: {
      companyName: "Presentation Style Roofing",
      branding: {
        logo: "https://cdn.example.test/style-logo.png",
        colors: {
          primary: "#2468ac",
          secondary: "#13579b",
          accent: "#2468ac"
        }
      },
      report_settings: {
        page_summary: true
      }
    }
  }, { replace: true });

  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id: projectId,
      address: "123 Branch Branding Way, Seattle, WA",
      status: "queued",
      project_type: "residential",
      organization_ref: { id: orgId, name: "Original Red Roofing" },
      owner_ref: { email: "branch-branding@example.test", name: "Branch Branding" },
      team_ref: { id: "default" },
      branding_defaults: {
        id: orgId,
        name: "Original Red Roofing",
        logo_url: "https://cdn.example.test/red-logo.png",
        primary_color: "#d93025",
        secondary_color: "#111111",
        branding: {
          logo: "https://cdn.example.test/red-logo.png",
          colors: {
            primary: "#d93025",
            secondary: "#111111",
            accent: "#d93025"
          }
        },
        report_settings: {
          page_summary: false
        }
      }
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(created.statusCode, 201, created.body);

  const editor = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}/editor`
  });
  assert.equal(editor.statusCode, 200, editor.body);
  const editorJson = JSON.parse(editor.body);
  assert.equal(editorJson.organization.source, "portal_organization_context");
  assert.equal(editorJson.organization.name, "Branch Style Roofing");
  assert.equal(editorJson.organization.branding.logo, "https://cdn.example.test/style-logo.png");
  assert.equal(editorJson.organization.branding.colors.primary, "#2468ac");
  assert.equal(editorJson.organization.branding.colors.secondary, "#13579b");
  assert.equal(editorJson.organization.report_settings.cover_show_customer, false);
  assert.equal(editorJson.organization.report_settings.page_summary, true);

  const refreshed = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}`
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const refreshedJson = JSON.parse(refreshed.body);
  assert.equal(refreshedJson.project.branding_defaults.source, "portal_organization_context");
  assert.equal(refreshedJson.project.branding_defaults.branch_id, "default");
  assert.equal(refreshedJson.project.branding_defaults.branding.logo, "https://cdn.example.test/style-logo.png");
  assert.equal(refreshedJson.project.branding_defaults.branding.colors.primary, "#2468ac");
});

test("priority one completed projects are not bucketed as holding for release", async () => {
  const suffix = Date.now();
  const scheduledReleaseAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const createHeldProject = async (id: string, patch: Record<string, unknown>) => {
    const created = await (app.inject as any)({
      method: "POST",
      url: "/v1/firstmeasure/projects",
      payload: {
        id,
        address: `${id} Queue Test Way, Seattle, WA`,
        status: "queued",
        project_type: "residential",
        team_ref: { id: "default" },
        owner_ref: { email: `${id}@example.test`, name: id },
        ...patch
      },
      headers: { "content-type": "application/json" }
    });
    assert.equal(created.statusCode, 201, created.body);

    const updated = await (app.inject as any)({
      method: "PATCH",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}`,
      payload: {
        status: "completed",
        completed_at: new Date().toISOString(),
        delivery_hold_status: "holding",
        delivery_hold_scheduled_release_at: scheduledReleaseAt,
        delivery: {
          release_hold: {
            status: "holding",
            scheduled_release_at: scheduledReleaseAt,
            reason: "test_hold"
          }
        },
        ...patch
      },
      headers: { "content-type": "application/json" }
    });
    assert.equal(updated.statusCode, 200, updated.body);
  };

  const standardId = `release_hold_standard_${suffix}`;
  const priorityId = `release_hold_priority_${suffix}`;
  await createHeldProject(standardId, { report_expedite_option: "standard_3_6" });
  await createHeldProject(priorityId, { qa_priority: true, report_expedite_option: "standard_3_6" });

  const releaseHolding = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/queue/bucket",
    payload: { group: "release_holding", view: "card", limit: 50, include_all: true },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(releaseHolding.statusCode, 200, releaseHolding.body);
  const releaseHoldingJson = JSON.parse(releaseHolding.body);
  assert.ok(releaseHoldingJson.projects.some((project: any) => project.id === standardId), releaseHolding.body);
  assert.equal(releaseHoldingJson.projects.some((project: any) => project.id === priorityId), false, releaseHolding.body);

  const completed = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/queue/bucket",
    payload: { group: "completed", view: "card", limit: 50, include_all: true },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(completed.statusCode, 200, completed.body);
  const completedJson = JSON.parse(completed.body);
  assert.ok(completedJson.projects.some((project: any) => project.id === priorityId), completed.body);
});

test("legacy P2 expedited projects hold release even without explicit hold flag", async () => {
  const id = `legacy_p2_hold_${Date.now()}`;
  const createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const queuedAt = createdAt.replace("T", " ").slice(0, 19);
  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id,
      address: `${id} Release Hold Way, Seattle, WA`,
      status: "completed",
      project_type: "residential",
      is_expedited: true,
      report_expedite_option: "rush_1_3",
      report_expedite_label: "1-3 hr rush",
      report_due_window_start: new Date(Date.parse(createdAt) + 120 * 60_000).toISOString(),
      report_due_window_end: new Date(Date.parse(createdAt) + 180 * 60_000).toISOString(),
      report_due_window_label: "legacy 2-3 hr label",
      report_release_hold_enabled: null,
      timestamps: {
        created_at: queuedAt,
        queued_at: queuedAt,
        completed_at: new Date().toISOString()
      },
      team_ref: { id: "default" },
      issuer: { name: "Hold Tester", email: "hold-tester@example.test" },
      owner_ref: { name: "Hold Tester", email: "hold-tester@example.test" }
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(created.statusCode, 201, created.body);

  const sent = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}/email/send-report`,
    payload: {},
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const sentJson = JSON.parse(sent.body);
  assert.equal(sentJson.result.held, true, sent.body);
  assert.equal(sentJson.result.reason, "rush_1_3_release_window");

  const held = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}`
  });
  assert.equal(held.statusCode, 200, held.body);
  const heldJson = JSON.parse(held.body);
  assert.equal(heldJson.project.manifest.delivery_hold_status, "holding");
});

test("VIP P2 expedited projects keep P2 release hold behavior", async () => {
  const id = `vip_p2_hold_${Date.now()}`;
  const queuedMs = Date.now() - 20 * 60_000;
  const queuedAt = new Date(queuedMs).toISOString().replace("T", " ").slice(0, 19);
  const productionDeadlineAt = new Date(queuedMs + 120 * 60_000).toISOString();
  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id,
      address: `${id} VIP P2 Hold Way, Seattle, WA`,
      status: "completed",
      project_type: "residential",
      is_vip: true,
      is_expedited: true,
      report_expedite_option: "rush_1_3",
      report_expedite_label: "1-3 hr rush",
      report_due_window_start: new Date(queuedMs + 60 * 60_000).toISOString(),
      report_due_window_end: new Date(queuedMs + 180 * 60_000).toISOString(),
      report_production_deadline_at: productionDeadlineAt,
      report_due_window_label: "vip p2 release window",
      report_release_hold_enabled: null,
      timestamps: {
        created_at: queuedAt,
        queued_at: queuedAt,
        completed_at: new Date().toISOString().replace("T", " ").slice(0, 19)
      },
      team_ref: { id: "default" },
      issuer: { name: "VIP Hold Tester", email: "vip-hold-tester@example.test" },
      owner_ref: { name: "VIP Hold Tester", email: "vip-hold-tester@example.test" }
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(created.statusCode, 201, created.body);

  const listed = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects/list",
    payload: { statuses: ["completed"], include_all: true, limit: 50 },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(listed.statusCode, 200, listed.body);
  const listedJson = JSON.parse(listed.body);
  const listedProject = listedJson.projects.find((project: any) => project.id === id);
  assert.ok(listedProject, listed.body);
  assert.equal(listedProject.is_vip, true);
  assert.equal(listedProject.is_expedited, true);
  assert.equal(listedProject.deadline_at, productionDeadlineAt);

  const sent = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}/email/send-report`,
    payload: {},
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const sentJson = JSON.parse(sent.body);
  assert.equal(sentJson.result.held, true, sent.body);
  assert.equal(sentJson.result.reason, "rush_1_3_release_window");
});

test("VIP standard projects use P2 release hold behavior", async () => {
  const id = `vip_standard_p2_hold_${Date.now()}`;
  const queuedMs = Math.floor((Date.now() - 20 * 60_000) / 1000) * 1000;
  const standardDueStartMs = queuedMs + 180 * 60_000;
  const standardDueEndMs = queuedMs + 360 * 60_000;
  const queuedAt = new Date(queuedMs).toISOString().replace("T", " ").slice(0, 19);
  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id,
      address: `${id} VIP Standard Hold Way, Seattle, WA`,
      status: "completed",
      project_type: "residential",
      is_vip: true,
      is_expedited: false,
      report_expedite_option: "standard_3_6",
      report_expedite_label: "3-6 hrs",
      report_due_window_start: new Date(standardDueStartMs).toISOString(),
      report_due_window_end: new Date(standardDueEndMs).toISOString(),
      report_release_hold_enabled: true,
      timestamps: {
        created_at: queuedAt,
        queued_at: queuedAt,
        completed_at: new Date().toISOString().replace("T", " ").slice(0, 19)
      },
      team_ref: { id: "default" },
      issuer: { name: "VIP Standard Tester", email: "vip-standard-tester@example.test" },
      owner_ref: { name: "VIP Standard Tester", email: "vip-standard-tester@example.test" }
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(created.statusCode, 201, created.body);

  const sent = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}/email/send-report`,
    payload: {},
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const sentJson = JSON.parse(sent.body);
  assert.equal(sentJson.result.held, true, sent.body);
  assert.equal(sentJson.result.reason, "vip_p2_release_window");

  const held = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}`
  });
  assert.equal(held.statusCode, 200, held.body);
  const heldJson = JSON.parse(held.body);
  const heldManifest = heldJson.project.manifest;
  const scheduledMs = Date.parse(heldManifest.delivery_hold_scheduled_release_at);
  const storedQueuedMs = Date.parse(`${String(heldManifest.timestamps.queued_at).replace(" ", "T")}Z`);
  assert.ok(scheduledMs >= storedQueuedMs + 60 * 60_000, held.body);
  assert.ok(scheduledMs <= storedQueuedMs + 120 * 60_000, held.body);
  assert.ok(scheduledMs < Date.parse(heldManifest.report_due_window_start), held.body);
  assert.equal(heldManifest.delivery_hold_promised_delivery_at, new Date(storedQueuedMs + 180 * 60_000).toISOString());
});

test("P2 release hold uses SQL timestamps as UTC and releases between one and two hours", async () => {
  const id = `p2_prod_deadline_hold_${Date.now()}`;
  const queuedMs = Date.now() - 10 * 60_000;
  const dueStartMs = queuedMs + 60 * 60_000;
  const dueEndMs = queuedMs + 180 * 60_000;
  const queuedAt = new Date(queuedMs).toISOString().replace("T", " ").slice(0, 19);
  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id,
      address: `${id} Production Deadline Way, Seattle, WA`,
      status: "completed",
      project_type: "residential",
      is_expedited: true,
      report_expedite_option: "rush_1_3",
      report_expedite_label: "1-3 hr rush",
      report_due_window_start: new Date(dueStartMs).toISOString(),
      report_due_window_end: new Date(dueEndMs).toISOString(),
      report_production_deadline_at: new Date(queuedMs + 120 * 60_000).toISOString(),
      report_due_window_label: "test p2 production deadline",
      report_release_hold_enabled: null,
      team_ref: { id: "default" },
      issuer: { name: "Hold Tester", email: "hold-prod@example.test" },
      owner_ref: { name: "Hold Tester", email: "hold-prod@example.test" },
      timestamps: {
        created_at: queuedAt,
        queued_at: queuedAt,
        updated_at: new Date().toISOString().replace("T", " ").slice(0, 19),
        completed_at: new Date().toISOString().replace("T", " ").slice(0, 19)
      }
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(created.statusCode, 201, created.body);

  const sent = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}/email/send-report`,
    payload: {},
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const sentJson = JSON.parse(sent.body);
  assert.equal(sentJson.result.held, true, sent.body);
  assert.equal(sentJson.result.reason, "rush_1_3_release_window");
  const held = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}`
  });
  assert.equal(held.statusCode, 200, held.body);
  const heldJson = JSON.parse(held.body);
  const releaseHold = heldJson.project.manifest.delivery.release_hold;
  const scheduledMs = Date.parse(releaseHold.scheduled_release_at);
  assert.ok(scheduledMs >= dueStartMs, held.body);
  assert.ok(scheduledMs <= dueStartMs + 60 * 60_000, held.body);
  assert.equal(releaseHold.promised_delivery_at, new Date(dueEndMs).toISOString());
  assert.ok(releaseHold.random_offset_minutes >= 0, held.body);
  assert.ok(releaseHold.random_offset_minutes <= 60, held.body);
});

test("force release clears held project even when report email is rejected", async () => {
  sentPostmarkPayloads.length = 0;
  const rejectedEmail = `release-reject-${Date.now()}@example.test`;
  rejectedPostmarkRecipients.add(rejectedEmail);
  const id = `force_release_email_failure_${Date.now()}`;
  const scheduledReleaseAt = new Date(Date.now() - 30 * 60_000).toISOString();
  const completedAt = new Date(Date.now() - 60 * 60_000).toISOString();

  try {
    const created = await (app.inject as any)({
      method: "POST",
      url: "/v1/firstmeasure/projects",
      payload: {
        id,
        address: `${id} Release Failure Way, Seattle, WA`,
        status: "completed",
        project_type: "residential",
        completed_at: completedAt,
        team_ref: { id: "default" },
        issuer: { name: "Rejected Recipient", email: rejectedEmail },
        owner_ref: { name: "Rejected Recipient", email: rejectedEmail },
        delivery_hold_status: "holding",
        delivery_hold_reason: "standard_release_window",
        delivery_hold_scheduled_release_at: scheduledReleaseAt,
        delivery: {
          release_hold: {
            status: "holding",
            reason: "standard_release_window",
            scheduled_release_at: scheduledReleaseAt,
            completed_at: completedAt
          }
        }
      },
      headers: { "content-type": "application/json" }
    });
    assert.equal(created.statusCode, 201, created.body);

    const fakePdf = Buffer.from("%PDF-1.4\n% Release failure test PDF\n%%EOF\n").toString("base64");
    const uploadedPdf = await (app.inject as any)({
      method: "POST",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}/artifacts`,
      payload: { file_name: "Report.pdf", content_base64: fakePdf },
      headers: { "content-type": "application/json" }
    });
    assert.equal(uploadedPdf.statusCode, 200, uploadedPdf.body);

    const released = await (app.inject as any)({
      method: "POST",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}/release/force`,
      payload: {},
      headers: { "content-type": "application/json" }
    });
    assert.equal(released.statusCode, 200, released.body);
    const releasedJson = JSON.parse(released.body);
    assert.equal(releasedJson.success, true, released.body);
    assert.equal(releasedJson.result.released, true, released.body);
    assert.equal(releasedJson.result.email_sent, false, released.body);
    assert.equal(releasedJson.result.warning, "report_email_failed", released.body);
    assert.equal(releasedJson.result.email.ok, false, released.body);
    assert.equal(releasedJson.result.email.http, 422, released.body);
    assert.equal(sentPostmarkPayloads.length, 1);

    const status = await (app.inject as any)({
      method: "GET",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}/email/status`
    });
    assert.equal(status.statusCode, 200, status.body);
    const statusJson = JSON.parse(status.body);
    assert.equal(statusJson.email_summary.report_email.sent_ok, false, status.body);
    assert.equal(statusJson.email_summary.report_email.attempts, 1, status.body);
    assert.equal(statusJson.email_summary.report_email.last_http, 422, status.body);

    const detail = await (app.inject as any)({
      method: "GET",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(id)}`
    });
    assert.equal(detail.statusCode, 200, detail.body);
    const detailJson = JSON.parse(detail.body);
    assert.equal(detailJson.project.manifest.delivery_hold_status, "force_released", detail.body);
    assert.equal(detailJson.project.manifest.delivery.release_hold.status, "force_released", detail.body);
    assert.equal(detailJson.project.manifest.delivery_release_email_status, "failed", detail.body);

    const bucket = await (app.inject as any)({
      method: "POST",
      url: "/v1/firstmeasure/queue/bucket",
      payload: { group: "release_holding", view: "card", limit: 50, include_all: true },
      headers: { "content-type": "application/json" }
    });
    assert.equal(bucket.statusCode, 200, bucket.body);
    const bucketJson = JSON.parse(bucket.body);
    assert.equal(bucketJson.projects.some((project: any) => project.id === id), false, bucket.body);
  } finally {
    rejectedPostmarkRecipients.delete(rejectedEmail);
  }
});

test("public FirstMeasure test mode is sandboxed and does not charge or create live reports", async () => {
  const { readGlobal } = await import("../platform/storage.js");
  const before = await readGlobal("org_public_test_mode");
  assert.equal(before.data.credits_balance, 0);
  assert.deepEqual(before.data.credits_ledger, []);

  const balance = await request("GET", "/v1/public/firstmeasure/balance", undefined, testModeApiKey);
  assert.equal(balance.response.statusCode, 200, balance.response.body);
  assert.equal(balance.json.mode, "test");
  assert.equal(balance.json.test_mode, true);
  assert.equal(balance.json.balance, 0);
  assert.equal(balance.json.feature_flags, undefined);

  const gatedGutters = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: "sandbox_gutter_disabled",
    address: "1 Sandbox Way, Test City, TS 00000",
    project_type: "residential",
    include_gutter_measurements: true
  }, testModeApiKey);
  assert.equal(gatedGutters.response.statusCode, 403, gatedGutters.response.body);
  assert.equal(gatedGutters.json.error, "feature_not_enabled");
  assert.equal(gatedGutters.json.details.feature, "firstmeasure.gutter_reports");

  const gatedWeather = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: "sandbox_weather_disabled",
    address: "1 Sandbox Way, Test City, TS 00000",
    project_type: "residential",
    include_weather_report: true
  }, testModeApiKey);
  assert.equal(gatedWeather.response.statusCode, 403, gatedWeather.response.body);
  assert.equal(gatedWeather.json.error, "feature_not_enabled");
  assert.equal(gatedWeather.json.details.feature, "firstmeasure.weather_reports");

  const gatedRush = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: "sandbox_rush_disabled",
    address: "1 Sandbox Way, Test City, TS 00000",
    project_type: "residential",
    report_expedite_option: "rush_1_2"
  }, testModeApiKey);
  assert.equal(gatedRush.response.statusCode, 403, gatedRush.response.body);
  assert.equal(gatedRush.json.error, "feature_not_enabled");
  assert.equal(gatedRush.json.details.feature, "firstmeasure.report_expedite_options");

  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/public/firstmeasure/reports",
    payload: {
      external_id: "sandbox_job_001",
      address: "1 Sandbox Way, Test City, TS 00000",
      project_type: "commercial",
      report_mode: "full",
      pins: [{ lat: 37.422, lng: -122.084 }],
      metadata: { source: "sandbox_test" }
    },
    headers: {
      authorization: `Bearer ${testModeApiKey}`,
      "content-type": "application/json",
      "idempotency-key": "sandbox-same-order"
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const createdJson = JSON.parse(created.body);
  assert.equal(createdJson.mode, "test");
  assert.equal(createdJson.test_mode, true);
  assert.equal(createdJson.billing.amount_charged, 0);
  assert.equal(createdJson.billing.quoted_amount, 12);
  assert.equal(createdJson.billing.balance, 0);
  assert.equal(createdJson.billing.ledger_count, 0);
  assert.equal(createdJson.report.mode, "test");
  assert.equal(createdJson.report.test_mode, true);
  assert.equal(createdJson.report.status, "completed");
  assert.equal(createdJson.report.amount_charged, 0);
  assert.equal(createdJson.report.quoted_amount, 12);

  const after = await readGlobal("org_public_test_mode");
  assert.equal(after.data.credits_balance, 0);
  assert.deepEqual(after.data.credits_ledger, []);

  const { listPublicFirstMeasureReports } = await import("../public-firstmeasure/reports.js");
  const records = await listPublicFirstMeasureReports({ orgId: "org_public_test_mode", mode: "test", externalId: "sandbox_job_001", limit: 1 });
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record);
  assert.equal(record.amount_charged, 0);
  assert.equal(record.mode, "test");
  assert.match(record.firstmeasure_project_id, /^test_fmr_/);

  const liveProject = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}`
  });
  assert.equal(liveProject.statusCode, 404);

  const replay = await (app.inject as any)({
    method: "POST",
    url: "/v1/public/firstmeasure/reports",
    payload: {
      external_id: "sandbox_job_changed",
      address: "2 Sandbox Way, Test City, TS 00000",
      project_type: "commercial",
      pins: [{ lat: 37.422, lng: -122.084 }]
    },
    headers: {
      authorization: `Bearer ${testModeApiKey}`,
      "content-type": "application/json",
      "idempotency-key": "sandbox-same-order"
    }
  });
  const replayJson = JSON.parse(replay.body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replayJson.idempotent_replay, true);
  assert.equal(replayJson.report.id, createdJson.report.id);

  const listed = await request("GET", "/v1/public/firstmeasure/reports?external_id=sandbox_job_001", undefined, testModeApiKey);
  assert.equal(listed.response.statusCode, 200, listed.response.body);
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.reports[0].test_mode, true);

  const report = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(createdJson.report.id)}`, undefined, testModeApiKey);
  assert.equal(report.response.statusCode, 200, report.response.body);
  assert.equal(report.json.project.test_mode, true);
  assert.equal(report.json.project.status, "completed");

  const files = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(createdJson.report.id)}/files`, undefined, testModeApiKey);
  assert.equal(files.response.statusCode, 200, files.response.body);
  assert.ok(files.json.files.some((file: any) => file.name === "Report.pdf"));
  assert.ok(files.json.files.some((file: any) => file.name === "model_data.xml"));

  const pdf = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(createdJson.report.id)}/pdf`, undefined, testModeApiKey);
  assert.equal(pdf.response.statusCode, 200, pdf.response.body);
  assert.equal(String(pdf.response.headers["content-type"]).includes("application/pdf"), true);

  const fileDownload = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(createdJson.report.id)}/files/${encodeURIComponent("model_data.xml")}`, undefined, testModeApiKey);
  assert.equal(fileDownload.response.statusCode, 200, fileDownload.response.body);
  assert.equal(String(fileDownload.response.headers["content-type"]).includes("application/xml"), true);

  const measurements = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(createdJson.report.id)}/measurements`, undefined, testModeApiKey);
  assert.equal(measurements.response.statusCode, 200, measurements.response.body);
  assert.equal(measurements.json.test_mode, true);
  assert.equal(measurements.json.measurements.source_format, "roofplan");
  assert.ok(measurements.json.measurements.summary.face_count > 0);
});

test("first report delivery email omits bonus offer when app flag is off", async () => {
  sentPostmarkPayloads.length = 0;

  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal("org_public_email_flag", {
    data: {
      app_flags: {
        firstmeasure: {
          report_expedite_options: false,
          bonus_upfront_match: false
        }
      }
    }
  });

  const externalId = `email_flag_off_${Date.now()}`;
  const created = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: externalId,
    address: "789 Flag Off Lane, Seattle, WA",
    project_type: "residential",
    report_mode: "full",
    pins: [{ lat: 47.61, lng: -122.33 }],
    issuer: { name: "Flag Tester", email: "flag-off@example.test" },
    customer: { name: "Bonus Hidden", email: "hidden@example.test" }
  }, emailFlagApiKey);
  assert.equal(created.response.statusCode, 201, created.response.body);

  const { listPublicFirstMeasureReports } = await import("../public-firstmeasure/reports.js");
  const records = await listPublicFirstMeasureReports({ orgId: "org_public_email_flag", externalId, limit: 1 });
  const record = records[0];
  assert.ok(record);

  const stagedProject = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}`
  });
  assert.equal(stagedProject.statusCode, 200, stagedProject.body);
  const stagedProjectJson = JSON.parse(stagedProject.body);
  assert.equal(stagedProjectJson.project.manifest.report_release_hold_enabled, false);

  const fakePdf = Buffer.from("%PDF-1.4\n% Flag-off report email test PDF\n%%EOF\n").toString("base64");
  const uploadedPdf = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/artifacts`,
    payload: { file_name: "Report.pdf", content_base64: fakePdf },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(uploadedPdf.statusCode, 200, uploadedPdf.body);

  const completed = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/status`,
    payload: { status: "completed" },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(completed.statusCode, 200, completed.body);

  const sent = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/email/send-report`,
    payload: {},
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const sentJson = JSON.parse(sent.body);
  assert.equal(sentJson.success, true, sent.body);
  assert.equal(sentPostmarkPayloads.length, 1);

  const payload = sentPostmarkPayloads[0];
  assert.match(String(payload.TextBody), /Your roof report is ready!/);
  assert.doesNotMatch(String(payload.TextBody), /Limited time offer/);
  assert.doesNotMatch(String(payload.HtmlBody), /Limited Time Offer/);
  assert.doesNotMatch(String(payload.HtmlBody), /Claim offer/);
});

test("bonus campaign teaser is sent with the next report email once", async () => {
  sentPostmarkPayloads.length = 0;
  const { readGlobal, saveGlobal } = await import("../platform/storage.js");
  const campaignStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await saveGlobal("org_public_bonus_campaign", {
    data: {
      bonus_offer_instances: {
        campaign_email_instance: {
          id: "campaign_email_instance",
          offer_id: "bonus_upfront_match_v1",
          rollout_id: "rollout_email_test",
          label: "Limited time test campaign",
          status: "available",
          starts_at: campaignStartedAt,
          created_at: campaignStartedAt,
          window_hours: 24,
          viewed: false,
          claimed: false,
          tiers: [
            { id: "tier_1", label: "Option 1", customer_pays: 1000, bonus_dollars: 250, total_account_value: 1250, match_percent: 25 },
            { id: "tier_2", label: "Option 2", customer_pays: 2000, bonus_dollars: 1000, total_account_value: 3000, match_percent: 50 },
            { id: "tier_3", label: "Option 3", customer_pays: 6000, bonus_dollars: 3000, total_account_value: 9000, match_percent: 50 }
          ]
        }
      }
    }
  });

  async function createCompleteAndEmail(externalId: string, email: string) {
    const created = await request("POST", "/v1/public/firstmeasure/reports", {
      external_id: externalId,
      address: "812 Campaign Lane, Seattle, WA",
      project_type: "residential",
      report_mode: "full",
      pins: [{ lat: 47.61, lng: -122.33 }],
      issuer: { name: "Campaign Tester", email },
      customer: { name: "Campaign Customer", email: `customer-${externalId}@example.test` }
    }, campaignApiKey);
    assert.equal(created.response.statusCode, 201, created.response.body);

    const { listPublicFirstMeasureReports } = await import("../public-firstmeasure/reports.js");
    const records = await listPublicFirstMeasureReports({ orgId: "org_public_bonus_campaign", externalId, limit: 1 });
    const record = records[0];
    assert.ok(record);

    const fakePdf = Buffer.from(`%PDF-1.4\n% Campaign report email test PDF ${externalId}\n%%EOF\n`).toString("base64");
    const uploadedPdf = await (app.inject as any)({
      method: "POST",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/artifacts`,
      payload: { file_name: "Report.pdf", content_base64: fakePdf },
      headers: { "content-type": "application/json" }
    });
    assert.equal(uploadedPdf.statusCode, 200, uploadedPdf.body);

    const completed = await (app.inject as any)({
      method: "POST",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/status`,
      payload: { status: "completed" },
      headers: { "content-type": "application/json" }
    });
    assert.equal(completed.statusCode, 200, completed.body);

    const sent = await (app.inject as any)({
      method: "POST",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/email/send-report`,
      payload: {},
      headers: { "content-type": "application/json" }
    });
    assert.equal(sent.statusCode, 200, sent.body);
    const sentJson = JSON.parse(sent.body);
    assert.equal(sentJson.success, true, sent.body);
    return record;
  }

  const firstRecord = await createCompleteAndEmail(`campaign_email_1_${Date.now()}`, "campaign-email-1@example.test");
  assert.equal(sentPostmarkPayloads.length, 1);
  const firstPayload = sentPostmarkPayloads[0];
  assert.match(String(firstPayload.TextBody), /Limited time offer: get up to \$3,000 in free credits/);
  assert.match(String(firstPayload.TextBody), /Claim your offer:/);
  assert.match(String(firstPayload.HtmlBody), /Limited Time Offer/);
  assert.match(String(firstPayload.HtmlBody), /Get up to \$3,000 in free credits/);
  assert.doesNotMatch(String(firstPayload.TextBody), /one-time|new account/i);
  assert.doesNotMatch(String(firstPayload.HtmlBody), /one-time|New Account/i);

  const afterFirst = await readGlobal("org_public_bonus_campaign");
  const instanceAfterFirst = (afterFirst.data as any).bonus_offer_instances.campaign_email_instance;
  assert.ok(instanceAfterFirst.report_email_teaser_sent_at);
  assert.equal(instanceAfterFirst.report_email_teaser_project_id, firstRecord.firstmeasure_project_id);

  await createCompleteAndEmail(`campaign_email_2_${Date.now()}`, "campaign-email-2@example.test");
  assert.equal(sentPostmarkPayloads.length, 2);
  const secondPayload = sentPostmarkPayloads[1];
  assert.doesNotMatch(String(secondPayload.TextBody), /Limited time offer/);
  assert.doesNotMatch(String(secondPayload.HtmlBody), /Limited Time Offer/);
  assert.doesNotMatch(String(secondPayload.HtmlBody), /Claim offer/);
});

test("public FirstMeasure API supports key auth, billing, report resources, and org scoping", async () => {
  const { response, json } = await request("GET", "/v1/public/firstmeasure/balance", undefined, "");
  assert.equal(response.statusCode, 401);
  assert.equal(json.ok, false);
  assert.equal(json.error, "missing_api_key");

  const root = await request("GET", "/v1/public/firstmeasure");
  assert.equal(root.response.statusCode, 200, root.response.body);
  assert.equal(root.json.api, "public_firstmeasure");
  assert.equal(root.json.endpoints.reports, "/reports");

  const pricing = await request("GET", "/v1/public/firstmeasure/pricing?project_type=residential&structure_count=2");
  assert.equal(pricing.response.statusCode, 200, pricing.response.body);
  assert.equal(pricing.json.project_type, "residential");
  assert.equal(pricing.json.structure_count, 2);
  assert.ok(Array.isArray(pricing.json.options));
  assert.equal(pricing.json.feature_flags.gutter_reports, true);
  assert.equal(pricing.json.feature_flags.weather_reports, true);
  assert.equal(pricing.json.feature_flags.report_expedite_options, true);
  assert.equal(typeof pricing.json.current_wait.estimated_wait_minutes, "number");
  assert.ok(pricing.json.options.some((option: any) => option.key === "rush_under_1" && option.expedited === true && option.start_minutes === 50 && option.unit_price > 7));
  assert.ok(pricing.json.options.some((option: any) => option.key === "rush_1_3" && option.expedited === true && option.start_minutes === 60 && option.end_minutes === 180 && option.production_deadline_minutes === 120));
  assert.equal(pricing.json.add_ons.gutters.enabled, true);
  assert.equal(pricing.json.add_ons.gutters.unit_price, 2);
  assert.equal(pricing.json.add_ons.weather_report.enabled, true);
  assert.equal(pricing.json.add_ons.weather_report.unit_price, 5);
  assert.equal(pricing.json.add_ons.weather_report.unit, "per_structure");

  const beforeBalance = await request("GET", "/v1/public/firstmeasure/balance");
  assert.equal(beforeBalance.response.statusCode, 200, beforeBalance.response.body);
  assert.equal(beforeBalance.json.balance, 500);
  const { listPublicFirstMeasureReports } = await import("../public-firstmeasure/reports.js");

  const geocodedOrder = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: "job_geocoded_coordinates",
    address: "123 Public API Way, Seattle, WA",
    project_type: "residential",
    report_mode: "full"
  });
  assert.equal(geocodedOrder.response.statusCode, 201, geocodedOrder.response.body);
  assert.equal(geocodedOrder.json.report.status, "needs_structure_pins");
  assert.equal(geocodedOrder.json.billing.amount_charged, 7);

  const geocodedRecords = await listPublicFirstMeasureReports({ orgId: "org_public_api", externalId: "job_geocoded_coordinates", limit: 1 });
  const geocodedRecord = geocodedRecords[0];
  assert.ok(geocodedRecord);
  assert.equal(geocodedRecord.request.lat, 47.61);
  assert.equal(geocodedRecord.request.lng, -122.33);
  assert.equal((geocodedRecord.metadata as any).geocoding.provider, "google_maps");
  const firstOrgProject = await request("GET", `/v1/firstmeasure/projects/${encodeURIComponent(geocodedRecord.firstmeasure_project_id)}`);
  assert.equal(firstOrgProject.response.statusCode, 200, firstOrgProject.response.body);
  assert.equal(firstOrgProject.json.project.manifest.is_vip, true);
  assert.equal(firstOrgProject.json.project.manifest.is_expedited, false);

  const created = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: "job_123",
    address: "123 Public API Way, Seattle, WA",
    project_type: "residential",
    report_mode: "full",
    include_gutter_measurements: true,
    include_weather_report: true,
    weather_report_tier: "history",
    report_expedite_option: "rush_1_3",
    lat: 47.61,
    lng: -122.33,
    customer: { name: "Pat Homeowner", email: "pat@example.test" },
    branding_defaults: {
      branding: {
        logo: "https://cdn.example.test/pat-roofing.png",
        colors: {
          primary: "#123456",
          secondary: "#abcdef"
        }
      },
      report_settings: {
        cover_show_customer: false
      }
    },
    metadata: { source: "node_test" }
  });
  assert.equal(created.response.statusCode, 201, created.response.body);
  assert.equal(created.json.ok, true);
  assert.match(created.json.report.id, /^fmr_/);
  assert.equal(created.json.report.external_id, "job_123");
  assert.ok(created.json.billing.amount_charged > 14);
  assert.equal(created.json.billing.balance, 500 - geocodedOrder.json.billing.amount_charged - created.json.billing.amount_charged);

  const commercialNoPins = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: "job_commercial_pin_timing",
    address: "456 Commercial Way, Seattle, WA",
    project_type: "commercial",
    report_mode: "full",
    report_expedite_option: "rush_1_3",
    lat: 47.62,
    lng: -122.34
  });
  assert.equal(commercialNoPins.response.statusCode, 201, commercialNoPins.response.body);
  const commercialRecords = await listPublicFirstMeasureReports({ orgId: "org_public_api", externalId: "job_commercial_pin_timing", limit: 1 });
  const commercialRecord = commercialRecords[0];
  assert.ok(commercialRecord);
  const placedCommercialPins = await (app.inject as any)({
    method: "PATCH",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(commercialRecord.firstmeasure_project_id)}`,
    payload: {
      pins: [
        { lat: 47.6201, lng: -122.3401 },
        { lat: 47.6202, lng: -122.3402 },
        { lat: 47.6203, lng: -122.3403 }
      ],
      is_custom_pin: true,
      status: "processing",
      structure_pin_mode: "employee_supplied",
      structure_pin_status: "processing"
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(placedCommercialPins.statusCode, 200, placedCommercialPins.body);
  const placedCommercialPinsJson = JSON.parse(placedCommercialPins.body);
  const commercialManifest = placedCommercialPinsJson.project.manifest;
  const commercialSubmittedMs = Date.parse(`${String(commercialManifest.timestamps.created_at).replace(" ", "T")}Z`);
  assert.equal(Date.parse(commercialManifest.report_due_window_start) - commercialSubmittedMs, 120 * 60_000);
  assert.equal(Date.parse(commercialManifest.report_production_deadline_at) - commercialSubmittedMs, 180 * 60_000);
  assert.equal(Date.parse(commercialManifest.report_due_window_end) - commercialSubmittedMs, 240 * 60_000);

  const listed = await request("GET", "/v1/public/firstmeasure/reports?external_id=job_123&limit=10");
  assert.equal(listed.response.statusCode, 200, listed.response.body);
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.reports[0].external_id, "job_123");

  const replay = await (app.inject as any)({
    method: "POST",
    url: "/v1/public/firstmeasure/reports",
    payload: {
      external_id: "job_123_replay",
      address: "123 Public API Way, Seattle, WA",
      project_type: "residential",
      lat: 47.61,
      lng: -122.33
    },
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": "same-order"
    }
  });
  assert.equal(replay.statusCode, 201);

  const replayAgain = await (app.inject as any)({
    method: "POST",
    url: "/v1/public/firstmeasure/reports",
    payload: {
      external_id: "job_123_replay_changed",
      address: "Different Address",
      project_type: "residential",
      lat: 47.61,
      lng: -122.33
    },
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": "same-order"
    }
  });
  const replayAgainJson = JSON.parse(replayAgain.body);
  assert.equal(replayAgain.statusCode, 200);
  assert.equal(replayAgainJson.idempotent_replay, true);

  const fallbackRecords = await listPublicFirstMeasureReports({ orgId: "org_public_api", externalId: "job_123_replay", limit: 1 });
  const fallbackRecord = fallbackRecords[0];
  assert.ok(fallbackRecord);
  const fallbackEditor = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(fallbackRecord.firstmeasure_project_id)}/editor`
  });
  assert.equal(fallbackEditor.statusCode, 200, fallbackEditor.body);
  const fallbackEditorJson = JSON.parse(fallbackEditor.body);
  assert.equal(fallbackEditorJson.organization.branding.logo, "https://cdn.example.test/platform-roofing.png");
  assert.equal(fallbackEditorJson.organization.branding.colors.primary, "#456789");
  assert.equal(fallbackEditorJson.organization.branding.colors.secondary, "#fedcba");

  const records = await listPublicFirstMeasureReports({ orgId: "org_public_api", externalId: "job_123", limit: 1 });
  const record = records[0];
  assert.ok(record);

  const stagedProject = await (app.inject as any)({
    method: "GET",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}`
  });
  assert.equal(stagedProject.statusCode, 200, stagedProject.body);
  const stagedProjectJson = JSON.parse(stagedProject.body);
  assert.equal(stagedProjectJson.project.manifest.status, "needs_structure_pins");
  assert.equal(stagedProjectJson.project.manifest.is_vip, false);
  assert.equal(stagedProjectJson.project.manifest.structure_pin_mode, "all_structures_on_parcel");
  assert.equal(stagedProjectJson.project.manifest.structure_pin_status, "needs_structure_pins");
  assert.equal(stagedProjectJson.project.manifest.include_gutter_measurements, true);
  assert.equal(stagedProjectJson.project.manifest.include_weather_report, true);
  assert.equal(stagedProjectJson.project.manifest.weather_report_tier, "history");
  assert.equal(stagedProjectJson.project.manifest.report_expedite_option, "rush_1_3");
  assert.equal(stagedProjectJson.project.manifest.report_expedite_label, "1-3 hr rush");
  assert.equal(
    Date.parse(stagedProjectJson.project.manifest.report_due_window_end) - Date.parse(stagedProjectJson.project.manifest.report_due_window_start),
    120 * 60_000
  );
  assert.equal(
    Date.parse(stagedProjectJson.project.manifest.report_production_deadline_at) - Date.parse(stagedProjectJson.project.manifest.report_due_window_start),
    60 * 60_000
  );
  assert.equal(stagedProjectJson.project.branding_defaults.branding.logo, "https://cdn.example.test/pat-roofing.png");
  assert.equal(stagedProjectJson.project.branding_defaults.branding.colors.primary, "#123456");
  assert.equal(stagedProjectJson.project.branding_defaults.branding.colors.secondary, "#abcdef");
  assert.equal(stagedProjectJson.project.branding_defaults.report_settings.cover_show_customer, false);

  const needsPinsBucket = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/queue/bucket",
    payload: { group: "needs_structure_pins", view: "card", limit: 10, include_all: true },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(needsPinsBucket.statusCode, 200, needsPinsBucket.body);
  const needsPinsJson = JSON.parse(needsPinsBucket.body);
  const queuedCard = needsPinsJson.projects.find((project: any) => project.id === record.firstmeasure_project_id);
  assert.ok(queuedCard, needsPinsBucket.body);
  assert.equal(queuedCard.report_expedite_option, "rush_1_3");
  assert.equal(queuedCard.is_expedited, true);
  assert.equal(queuedCard.deadline_at, stagedProjectJson.project.manifest.report_production_deadline_at);

  const sampleXmlPath = path.join(process.cwd(), "storage", "firstmeasure", "projects");
  const sampleXml = await findSampleModelXml(sampleXmlPath);
  assert.ok(sampleXml.includes("<DATA_EXPORT"));

  const fakePdf = Buffer.from("%PDF-1.4\n% Public FirstMeasure test PDF\n%%EOF\n").toString("base64");
  const uploadedXml = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/artifacts`,
    payload: { file_name: "model_data.xml", content_text: sampleXml },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(uploadedXml.statusCode, 200, uploadedXml.body);

  const uploadedPdf = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/artifacts`,
    payload: { file_name: "Report.pdf", content_base64: fakePdf },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(uploadedPdf.statusCode, 200, uploadedPdf.body);

  const report = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}`);
  assert.equal(report.response.statusCode, 200, report.response.body);
  assert.equal(report.json.report.id, record.report_id);
  assert.equal(report.json.project.artifacts.has_report_pdf, true);
  assert.equal(report.json.project.artifacts.has_model_data, true);

  const files = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/files`);
  assert.equal(files.response.statusCode, 200);
  assert.ok(files.json.files.some((file: any) => file.name === "Report.pdf"));

  const fileDownload = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/files/${encodeURIComponent("Report.pdf")}`);
  assert.equal(fileDownload.response.statusCode, 200, fileDownload.response.body);
  assert.equal(String(fileDownload.response.headers["content-type"]).includes("application/pdf"), true);

  const pdf = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/pdf`);
  assert.equal(pdf.response.statusCode, 200, pdf.response.body);
  assert.equal(String(pdf.response.headers["content-type"]).includes("application/pdf"), true);

  const measurements = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/measurements`);
  assert.equal(measurements.response.statusCode, 200, measurements.response.body);
  assert.equal(measurements.json.measurements.source_format, "roofplan");
  assert.ok(measurements.json.measurements.summary.face_count > 0);

  const forbidden = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}`, undefined, otherApiKey);
  assert.equal(forbidden.response.statusCode, 404);

  const webhook = await request("POST", "/v1/public/firstmeasure/webhooks/test", { ping: "pong" });
  assert.equal(webhook.response.statusCode, 200, webhook.response.body);
  assert.equal(webhook.json.ok, true);
  assert.equal(webhook.json.org_id, "org_public_api");
  assert.deepEqual(webhook.json.body, { ping: "pong" });

  const cancelledProjectId = `cancelled_activity_${Date.now()}`;
  const cancelledCreated = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id: cancelledProjectId,
      address: "999 Cancelled Queue Lane, Seattle, WA",
      status: "queued",
      project_type: "residential",
      team_ref: { id: "default" },
      owner_ref: { email: "cancelled@example.test", name: "Cancelled Test" }
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(cancelledCreated.statusCode, 201, cancelledCreated.body);
  const cancelledAt = new Date().toISOString();
  const cancelledPatch = await (app.inject as any)({
    method: "PATCH",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(cancelledProjectId)}`,
    payload: {
      status: "cancelled",
      timestamps: { cancelled_at: cancelledAt }
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(cancelledPatch.statusCode, 200, cancelledPatch.body);
  const cancelledBucket = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/queue/bucket",
    payload: {
      group: "cancelled",
      view: "card",
      limit: 50,
      activity_start: new Date(Date.now() - 60_000).toISOString(),
      activity_end: new Date(Date.now() + 60_000).toISOString()
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(cancelledBucket.statusCode, 200, cancelledBucket.body);
  const cancelledBucketJson = JSON.parse(cancelledBucket.body);
  assert.ok(
    cancelledBucketJson.projects.some((project: any) => project.id === cancelledProjectId),
    cancelledBucket.body
  );

  const autoTopupOrder = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: "job_auto_topup",
    address: "456 Auto Topup Ave, Seattle, WA",
    project_type: "residential",
    report_mode: "full",
    lat: 47.62,
    lng: -122.31
  }, autoTopupKey);
  assert.equal(autoTopupOrder.response.statusCode, 201, autoTopupOrder.response.body);
  assert.equal(autoTopupOrder.json.billing.amount_charged, 7);
  assert.equal(autoTopupOrder.json.billing.auto_topup.success, true);
  assert.equal(autoTopupOrder.json.billing.auto_topup.balance, 138);

  const autoTopupBalance = await request("GET", "/v1/public/firstmeasure/balance", undefined, autoTopupKey);
  assert.equal(autoTopupBalance.response.statusCode, 200, autoTopupBalance.response.body);
  assert.equal(autoTopupBalance.json.balance, 138);
  assert.equal(autoTopupBalance.json.billing.auto_topup.status, "ok");

  const lowCreditReport = await request("POST", "/v1/public/firstmeasure/reports", {
    external_id: "job_needs_pins_low_credit",
    address: "1600 Amphitheatre Parkway, Mountain View, CA 94043",
    project_type: "commercial",
    report_mode: "full",
    lat: 37.422,
    lng: -122.0841,
    customer: { name: "Low Credit Test", email: "low-credit@example.test" }
  }, lowCreditKey);
  assert.equal(lowCreditReport.response.statusCode, 201, lowCreditReport.response.body);
  assert.equal(lowCreditReport.json.billing.amount_charged, 12);
  assert.equal(lowCreditReport.json.billing.balance, 8);

  const lowCreditRecords = await listPublicFirstMeasureReports({ orgId: "org_public_low_credit", externalId: "job_needs_pins_low_credit", limit: 1 });
  const lowCreditRecord = lowCreditRecords[0];
  assert.ok(lowCreditRecord);

  const suppliedPins = [
    { lat: 37.422480886384356, lng: -122.08466602281236 },
    { lat: 37.42158834960335, lng: -122.08458555654191 },
    { lat: 37.42254692090254, lng: -122.08558870271348 },
    { lat: 37.42167355643795, lng: -122.0856101603856 }
  ];
  const patchedPins = await (app.inject as any)({
    method: "PATCH",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(lowCreditRecord.firstmeasure_project_id)}`,
    payload: {
      pins: suppliedPins,
      is_custom_pin: true,
      status: "processing",
      structure_pin_mode: "employee_supplied",
      structure_pin_status: "processing"
    },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(patchedPins.statusCode, 200, patchedPins.body);

  const acceptedProcess = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(lowCreditRecord.firstmeasure_project_id)}/process/imagery`,
    payload: { process_async: true, actor: { email: "pins@example.test", name: "Pin Tester" } },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(acceptedProcess.statusCode, 202, acceptedProcess.body);
  const acceptedProcessJson = JSON.parse(acceptedProcess.body);
  assert.equal(acceptedProcessJson.project.manifest.structure_pin_status, "generating");

  let rejectedProcessJson: any = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const checkRejected = await (app.inject as any)({
      method: "GET",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(lowCreditRecord.firstmeasure_project_id)}`
    });
    rejectedProcessJson = JSON.parse(checkRejected.body);
    if (rejectedProcessJson.project.manifest.status === "rejected") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(rejectedProcessJson.project.manifest.status, "rejected");
  assert.equal(rejectedProcessJson.project.manifest.public_api.structure_pin_billing.delta_required, 36);

  const rejectedProcess = await (app.inject as any)({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(lowCreditRecord.firstmeasure_project_id)}/process/imagery`,
    payload: { actor: { email: "pins@example.test", name: "Pin Tester" } },
    headers: { "content-type": "application/json", "x-firstmeasure-internal": process.env.FIRSTMEASURE_INTERNAL_API_SECRET }
  });
  assert.equal(rejectedProcess.statusCode, 402, rejectedProcess.body);
  const rejectedSyncJson = JSON.parse(rejectedProcess.body);
  assert.equal(rejectedSyncJson.ok, false);
  assert.equal(rejectedSyncJson.billing.delta_required, 36);
  assert.equal(rejectedSyncJson.project.manifest.status, "rejected");
  assert.equal(rejectedSyncJson.project.manifest.amount_charged, 12);

  const rejectedReport = await request("GET", `/v1/public/firstmeasure/reports/${encodeURIComponent(lowCreditRecord.report_id)}`, undefined, lowCreditKey);
  assert.equal(rejectedReport.response.statusCode, 200, rejectedReport.response.body);
  assert.equal(rejectedReport.json.report.status, "rejected");
  assert.equal(rejectedReport.json.report.amount_charged, 12);
  assert.equal(rejectedReport.json.report.rejection.reason, "api_insufficient_credits");
});

async function findSampleModelXml(root: string) {
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(root, { withFileTypes: true }).catch(() => []));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, "model_data.xml");
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // Try the next fixture.
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?><DATA_EXPORT><LOCATION address="Fixture"/><STRUCTURES><ROOF id="ROOF1"><FACES><FACE id="F1" type="ROOF"><POLYGON id="P1" path="L1,L2" pitch="6" size="100"/></FACE></FACES><LINES><LINE id="L1" path="C1,C2" type="EAVE" width="6" height="12"/></LINES><POINTS><POINT id="C1" data="0,0,0"/><POINT id="C2" data="1,1,1"/></POINTS></ROOF></STRUCTURES></DATA_EXPORT>`;
}
