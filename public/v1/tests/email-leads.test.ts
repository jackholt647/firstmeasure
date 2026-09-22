import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";
let originalFetch: typeof globalThis.fetch;

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
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
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

async function seedAppFlagDefaults(platformRoot: string) {
  const configDir = path.join(platformRoot, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "app_flag_defaults.json"), JSON.stringify({
    data: {
      app_flags: {
        platform: { lead_import: true, website_embed_import: true, scheduling: true },
        email: { inbound_lead_import: true },
        lead_forms: { appointment_form: true, instant_estimate: true }
      }
    }
  }));
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-email-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.EMAIL_LEAD_AI_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  await seedAppFlagDefaults(process.env.PLATFORM_STORAGE_ROOT);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://maps.googleapis.com/") || url.startsWith("https://solar.googleapis.com/")) {
      throw new TypeError("fetch failed");
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Email Lead Test Org",
    organization_id: `org_email_${suffix}`,
    global: {
      app_flags: {
        platform: { lead_import: true, website_embed_import: true, scheduling: true },
        email: { inbound_lead_import: true },
        lead_forms: { appointment_form: true, instant_estimate: true }
      }
    }
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

test("FirstMate Mail inbound lead email creates project contacts and notification", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const { saveBranchModule } = await import("../platform/storage.js");
  const legacyInboundEmail = "leads-default-legacy@1m8.ai";
  await saveBranchModule(orgId, "default", "lead_import", {
    data: { enabled: true, inbound_email: legacyInboundEmail }
  }, { replace: true });
  const settings = await client.request("GET", `/v1/email/organizations/${orgId}/branch/default/lead-import`);
  const inboundEmail = settings.settings.inbound_email;
  assert.match(inboundEmail, /@firstmatemail\.com$/);
  assert.deepEqual(settings.settings.legacy_inbound_emails, [legacyInboundEmail]);

  const inbound = await client.request("POST", "/v1/email/inbound/events", {
    provider: "ses",
    provider_event_id: "ses-lead-test-message-1",
    from: { address: "leads@example-provider.test", name: "Example Provider" },
    to: [{ address: inboundEmail, name: "Inbound Leads" }],
    subject: "New roofing lead - Jane Homeowner",
    text: [
      "Name: Jane Homeowner",
      "Phone: (555) 222-3333",
      "Email: jane@example.test",
      "Address: 123 Cedar Street, Boise, ID 83702"
    ].join("\n"),
    headers: { message_id: "ses-lead-test-message-1" }
  });

  assert.equal(inbound.accepted, true);
  assert.equal(inbound.project.data.work_projection.active_instances[0].template_id, "sales_pipeline");
  assert.equal(inbound.project.data.work_projection.active_instances[0].stage_id, "new_lead_stage");
  assert.equal(inbound.project.data.address, "123 Cedar Street, Boise, ID 83702");
  assert.equal(inbound.project.data.contacts[0].email, "jane@example.test");
  assert.equal(inbound.contacts[0].email, "jane@example.test");

  const projects = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  assert.equal(projects.documents.length, 1);
  assert.equal(projects.documents[0].data.source, "email_lead");

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(notifications.notifications.length, 1);
  assert.equal(notifications.notifications[0].context.project_id, inbound.project.id);
});

test("Public website form creates a Platform lead through generic intake", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PATCH", `/v1/lead-intake/organizations/${orgId}/branch/default/settings`, {
    forms: [{
      id: "form_public_test",
      enabled: true,
      name: "Homepage Booking",
      tracking_key: "homepage",
      mode: "appointment",
      copy: { headline: "Book now", submit_label: "Request Appointment" },
      style: { primary_color: "#d93025", text_color: "#111827", font_family: "Montserrat" },
      scheduling: {
        event_type_default_id: "sales_appointment",
        duration_minutes: 60,
        slot_minutes: 30,
        allowed_role_ids: ["sales_appointments"]
      }
    }]
  });

  const config = await (app.inject as any)({ method: "GET", url: "/v1/lead-intake/public/forms/form_public_test" });
  assert.equal(config.statusCode, 200, config.body);
  const parsedConfig = JSON.parse(config.body);
  assert.equal(parsedConfig.form.tracking_key, "homepage");

  const legacyConfig = await (app.inject as any)({ method: "GET", url: "/v1/email/public/forms/form_public_test" });
  assert.equal(legacyConfig.statusCode, 200, legacyConfig.body);

  const availability = await (app.inject as any)({ method: "GET", url: "/v1/lead-intake/public/forms/form_public_test/availability?date=2027-01-08" });
  assert.equal(availability.statusCode, 200, availability.body);
  const parsedAvailability = JSON.parse(availability.body);
  assert.equal(parsedAvailability.event_type_id, "sales_appointment");
  const openSlot = parsedAvailability.slots.find((slot: any) => slot.available === true);
  assert.ok(openSlot);

  const submit = await (app.inject as any)({
    method: "POST",
    url: "/v1/lead-intake/public/forms/form_public_test/submit",
    payload: {
      name: "Website Visitor",
      phone: "(555) 444-5555",
      email: "visitor@example.test",
      address: "441 Pine Avenue, Tacoma, WA 98402",
      message: "Need a roof estimate.",
      preferred_start_at: openSlot.start_at,
      page_url: "https://example.test/roofing"
    }
  });
  assert.equal(submit.statusCode, 201, submit.body);
  const created = JSON.parse(submit.body);
  assert.equal(created.accepted, true);
  assert.equal(created.project.data.source, "website_embed");
  assert.equal(created.project.data.embeddable_form.tracking_key, "homepage");
  assert.equal(created.project.data.website_form.tracking_key, "homepage");
  assert.equal(created.project.data.events[0].event_type_default_id, "sales_appointment");
  assert.equal(created.project.data.contacts[0].email, "visitor@example.test");
  assert.equal(created.contacts[0].email, "visitor@example.test");

  const duplicate = await (app.inject as any)({
    method: "POST",
    url: "/v1/lead-intake/public/forms/form_public_test/submit",
    payload: {
      name: "Second Visitor",
      phone: "(555) 444-6666",
      address: "442 Pine Avenue, Tacoma, WA 98402",
      preferred_start_at: openSlot.start_at
    }
  });
  assert.equal(duplicate.statusCode, 409, "public submission revalidates routed capacity instead of trusting a stale rendered slot");
});

test("Public instant estimate form measures or falls back, creates a lead, and triggers customer email", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PATCH", `/v1/lead-intake/organizations/${orgId}/branch/default/settings`, {
    forms: [{
      id: "form_estimate_test",
      enabled: true,
      name: "Instant Estimate",
      tracking_key: "instant-estimate",
      mode: "instant_estimate",
      copy: {
        headline: "Get a free instant estimate",
        submit_label: "Get my estimate"
      },
      style: { primary_color: "#d93025", text_color: "#111827", font_family: "Montserrat" },
      estimate: {
        low_price_sqft: 5,
        high_price_sqft: 10,
        default_sqft: 1000,
        send_customer_email: true,
        pricing_matrix: [
          { roof_type: "Asphalt", pitch: "Moderate", low_price_sqft: 6, high_price_sqft: 8 },
          { roof_type: "Metal", pitch: "Moderate", low_price_sqft: 10, high_price_sqft: 14 },
          { roof_type: "Flat", pitch: "Low", low_price_sqft: 9, high_price_sqft: 12 }
        ],
        pages: [{
          key: "roof_age",
          title: "How old is your roof?",
          type: "choice",
          options: [{ value: "10+", label: "10+ years" }]
        }]
      }
    }]
  });

  const preview = await client.request("POST", `/v1/lead-intake/organizations/${orgId}/branch/default/forms/form_estimate_test/instant-estimate-preview`, {
    address: "100 Solar Way, Phoenix, AZ 85001"
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.estimate.low, 6000);
  assert.equal(preview.estimate.high, 14000);
  assert.equal(preview.estimate.pricing_options.length, 2);
  assert.equal(preview.estimate.pricing_options[0].roof_type, "Asphalt");
  assert.ok(["missing_google_solar_api_key", "fetch failed", "geocode_failed"].includes(preview.measurement.error || preview.measurement.status));
  assert.ok(["missing_google_solar_api_key", "fetch failed", "geocode_failed"].includes(preview.preview.error || preview.preview.status));

  const flatPreview = await client.request("POST", `/v1/lead-intake/organizations/${orgId}/branch/default/forms/form_estimate_test/instant-estimate-preview`, {
    address: "100 Solar Way, Phoenix, AZ 85001",
    answers: { slope: "flat" }
  });
  assert.equal(flatPreview.estimate.pitch_category, "Flat");
  assert.equal(flatPreview.estimate.pricing_options.length, 1);
  assert.equal(flatPreview.estimate.pricing_options[0].roof_type, "Flat");
  assert.equal(flatPreview.estimate.low, 9000);
  assert.equal(flatPreview.estimate.high, 12000);

  const missingConsent = await (app.inject as any)({
    method: "POST",
    url: "/v1/lead-intake/public/forms/form_estimate_test/submit",
    payload: {
      name: "Estimate Visitor",
      email: "estimate@example.test",
      address: "100 Solar Way, Phoenix, AZ 85001"
    }
  });
  assert.equal(missingConsent.statusCode, 400, missingConsent.body);
  assert.match(missingConsent.body, /estimate_contact_consent_required/);

  const submit = await (app.inject as any)({
    method: "POST",
    url: "/v1/lead-intake/public/forms/form_estimate_test/submit",
    payload: {
      name: "Estimate Visitor",
      email: "estimate@example.test",
      phone: "(555) 555-1212",
      address: "100 Solar Way, Phoenix, AZ 85001",
      message: "I want a roof replacement.",
      contact_consent: "true",
      answers: { roof_age: "10+", slope: "moderate" },
      page_url: "https://example.test/estimate"
    }
  });
  assert.equal(submit.statusCode, 201, submit.body);
  const created = JSON.parse(submit.body);
  assert.equal(created.accepted, true);
  assert.equal(created.project.data.source, "instant_estimate");
  assert.equal(created.instant_estimate.estimate.low, 6000);
  assert.equal(created.instant_estimate.estimate.high, 14000);
  assert.equal(created.instant_estimate.estimate.pricing_options.length, 2);
  assert.equal(created.instant_estimate.estimate.source, "fallback");
  assert.ok(["missing_google_solar_api_key", "fetch failed", "geocode_failed"].includes(created.instant_estimate.measurement.error || created.instant_estimate.measurement.status));
  assert.equal(created.instant_estimate.email.success, true);
  assert.equal(created.instant_estimate.email.message.status, "sent");
  assert.equal(created.instant_estimate.email.message.deliveries[0].status, "sent");
  assert.equal(created.project.data.instant_estimate.estimate.low, 6000);
  assert.equal(created.project.data.instant_estimate.answers.roof_age, "10+");
  assert.equal(created.project.data.contacts[0].email, "estimate@example.test");
  assert.equal(created.contacts[0].email, "estimate@example.test");
});

test("App flags gate email inbox and website embed lead intake", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        email: { inbound_lead_import: false },
        platform: { expanded_access: true, lead_import: false, website_embed_import: false }
      }
    }
  }, { replace: false });

  const flags = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(flags.enabled.email.includes("inbound_lead_import"), false);
  assert.equal(flags.enabled.platform.includes("website_embed_import"), false);

  const settings = await client.raw("GET", `/v1/email/organizations/${orgId}/branch/default/lead-import`);
  assert.equal(settings.statusCode, 403, settings.body);
  assert.match(settings.body, /app_flag_disabled/);

  const patch = await client.raw("PATCH", `/v1/email/organizations/${orgId}/branch/default/lead-import`, {
    website_forms: [{ id: "form_disabled_test", name: "Disabled" }]
  });
  assert.equal(patch.statusCode, 403, patch.body);
  assert.match(patch.body, /app_flag_disabled/);

  const intakePatch = await client.raw("PATCH", `/v1/lead-intake/organizations/${orgId}/branch/default/settings`, {
    forms: [{ id: "form_disabled_test", name: "Disabled" }]
  });
  assert.equal(intakePatch.statusCode, 403, intakePatch.body);
  assert.match(intakePatch.body, /app_flag_disabled/);
});
