import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type TestClient = ReturnType<typeof createSessionClient>;

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
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
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
    let data: any = null;
    try {
      data = response.body ? JSON.parse(response.body) : null;
    } catch {
      data = null;
    }
    return { statusCode: response.statusCode, body: response.body, data };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-feedback-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkDatabase } = await import("../work/storage.js");
  (await closeWorkDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `feedback-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Feedback Test Owner",
    company: "Feedback API Test Org",
    organization_id: `org_feedback_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return { orgId: String(registered.organization.id), suffix };
}

async function createProject(orgId: string, projectId: string, name: string) {
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: {
      id: projectId,
      title: `${name} Roof Replacement`,
      branch_id: "default",
      status: "open",
      customer_name: name,
      customer_phone: "+12065551234",
      customer_email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`
    }
  });
}

test("feedback system: settings, request send, public rating, review routing", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const settingsUrl = `/v1/feedback/organizations/${orgId}/branches/default/settings`;

  // Defaults come back normalized before anything is saved.
  const initial = await owner.request("GET", settingsUrl);
  assert.equal(initial.settings.survey.scale, 5);
  assert.equal(initial.settings.review.mode, "threshold");
  assert.equal(initial.settings.delivery.trigger, "workflow");
  assert.equal(initial.settings.messages.portal_title, "How did we do?");

  // Save settings: 4-star threshold with a Google destination.
  const saved = await owner.request("PUT", settingsUrl, {
    ...initial.settings,
    review: {
      ...initial.settings.review,
      threshold: 4,
      destinations: [
        { id: "google", label: "Google", url: "https://search.google.com/local/writereview?placeid=test", icon: "fab fa-google", enabled: true },
        { id: "unlinked", label: "No URL yet", url: "", icon: "fas fa-star", enabled: true }
      ]
    }
  });
  assert.equal(saved.settings.review.threshold, 4);
  assert.equal(saved.settings.review.destinations.length, 2);

  // Send a request for a project (SMS captures, email is disabled in tests).
  await createProject(orgId, "proj_feedback_happy", "Sarah Mitchell");
  const sent = await owner.request("POST", `/v1/feedback/organizations/${orgId}/requests`, {
    project_id: "proj_feedback_happy"
  });
  assert.equal(sent.ok, true);
  assert.ok(sent.link.startsWith("http://127.0.0.1:8011/l/pl1."), `unexpected public link: ${sent.link}`);
  assert.ok(sent.sends.some((send: any) => send.channel === "sms"));

  // Re-sending without resend:true is a no-op.
  const repeat = await owner.request("POST", `/v1/feedback/organizations/${orgId}/requests`, {
    project_id: "proj_feedback_happy"
  });
  assert.equal(repeat.skipped, true);
  assert.equal(repeat.reason, "already_sent");

  const token = String(sent.link).split("/l/")[1]!;

  // The stable public-link route resolves without a platform session and
  // redirects into the feedback experience for this exact resource.
  const opened = await (app.inject as any)({ method: "GET", url: `/l/${token}` });
  assert.equal(opened.statusCode, 302);
  assert.equal(opened.headers.location, `/v1/feedback/public/${encodeURIComponent(token)}/app`);

  // Public page + view + state.
  const html = await (app.inject as any)({ method: "GET", url: `/v1/feedback/public/${token}/app` });
  assert.equal(html.statusCode, 200);
  assert.ok(String(html.body).includes(token));

  const anonymous = createSessionClient();
  const view = await anonymous.request("GET", `/v1/feedback/public/${token}`);
  assert.equal(view.state.rated, false);
  assert.equal(view.branding.company_name, "Feedback API Test Org");
  await anonymous.request("POST", `/v1/feedback/public/${token}/view`, {});

  // A 5-star rating meets the threshold: review destinations are offered,
  // but only destinations with a URL.
  const rated = await anonymous.request("POST", `/v1/feedback/public/${token}/rating`, {
    rating: 5,
    comment: "Crew was fantastic."
  });
  assert.equal(rated.review.show_review, true);
  assert.equal(rated.review.destinations.length, 1);
  assert.equal(rated.review.destinations[0].id, "google");
  // Exactly one closing message: the invitation prompt when the review ask is shown.
  assert.equal(rated.message, saved.settings.review.prompt);

  const clicked = await anonymous.request("POST", `/v1/feedback/public/${token}/click`, { destination_id: "google" });
  assert.ok(String(clicked.url).startsWith("https://search.google.com/"));

  // The rating landed on the project as a first-class variable.
  const { readDocument } = await import("../platform/storage.js");
  const project = await readDocument(orgId, "projects", "proj_feedback_happy");
  assert.equal((project.data as any).custom_fields.feedback_rating, 5);
  assert.equal((project.data as any).feedback.rating, 5);
  assert.equal((project.data as any).feedback.met_review_threshold, true);

  // Feedback events flowed through the work event bus.
  const { listEventRecords } = await import("../work/storage.js");
  const events = (await listEventRecords(orgId, {})).map((event: any) => event.type);
  for (const expected of ["feedback.request.sent", "feedback.request.opened", "feedback.rating.recorded", "feedback.review.link_clicked"]) {
    assert.ok(events.includes(expected), `missing event ${expected} in ${events.join(", ")}`);
  }

  // A below-threshold rating keeps the review invitation private.
  await createProject(orgId, "proj_feedback_low", "Tom Harris");
  const lowSent = await owner.request("POST", `/v1/feedback/organizations/${orgId}/requests`, {
    project_id: "proj_feedback_low"
  });
  const lowToken = String(lowSent.link).split("/l/")[1]!;
  const lowRated = await anonymous.request("POST", `/v1/feedback/public/${lowToken}/rating`, { rating: 2 });
  assert.equal(lowRated.review.show_review, false);
  assert.equal(lowRated.review.destinations.length, 0);
  // Below threshold → the private low-rating note is the one message shown.
  assert.equal(lowRated.message, saved.settings.review.low_note);

  // Summary rolls both up.
  const summary = await owner.request("GET", `/v1/feedback/organizations/${orgId}/requests`);
  assert.equal(summary.totals.sent, 2);
  assert.equal(summary.totals.rated, 2);
  assert.equal(summary.totals.average_rating, 3.5);
  assert.equal(summary.totals.review_clicks, 1);
});

test("feedback system: 'always' mode invites every rating, 'never' invites none", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const settingsUrl = `/v1/feedback/organizations/${orgId}/branches/default/settings`;
  const initial = await owner.request("GET", settingsUrl);
  await owner.request("PUT", settingsUrl, {
    ...initial.settings,
    review: {
      ...initial.settings.review,
      mode: "always",
      destinations: [{ id: "google", label: "Google", url: "https://g.page/r/test/review", icon: "fab fa-google", enabled: true }]
    }
  });

  await createProject(orgId, "proj_feedback_always", "Ana Lopez");
  const sent = await owner.request("POST", `/v1/feedback/organizations/${orgId}/requests`, { project_id: "proj_feedback_always" });
  const token = String(sent.link).split("/l/")[1]!;
  const anonymous = createSessionClient();
  const rated = await anonymous.request("POST", `/v1/feedback/public/${token}/rating`, { rating: 1 });
  assert.equal(rated.review.show_review, true);

  const updated = await owner.request("GET", settingsUrl);
  await owner.request("PUT", settingsUrl, {
    ...updated.settings,
    review: { ...updated.settings.review, mode: "never" }
  });
  await createProject(orgId, "proj_feedback_never", "Raj Patel");
  const neverSent = await owner.request("POST", `/v1/feedback/organizations/${orgId}/requests`, { project_id: "proj_feedback_never" });
  const neverToken = String(neverSent.link).split("/l/")[1]!;
  const neverRated = await anonymous.request("POST", `/v1/feedback/public/${neverToken}/rating`, { rating: 5 });
  assert.equal(neverRated.review.show_review, false);
  // Good rating with reviews off → the default thank-you is the one message.
  assert.equal(neverRated.message, updated.settings.survey.thank_you);
});

test("public links: org-scoped credentials can be listed, resolved, and revoked", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "apps.feedback": true, "feedback.review_requests": true });
  const created = await owner.request("POST", `/v1/public-links/organizations/${orgId}/links`, {
    kind: "example",
    resource_type: "example_record",
    resource_id: "record_123",
    destination_path: "/example/public/{token}",
    allowed_actions: ["view"]
  });
  assert.equal(created.ok, true);
  assert.ok(String(created.token).startsWith("pl1."));
  assert.equal(created.url, `http://127.0.0.1:8011/l/${created.token}`);
  assert.equal(Object.hasOwn(created.link, "token_hash"), false);

  const listed = await owner.request("GET", `/v1/public-links/organizations/${orgId}/links`);
  assert.equal(listed.links.length, 1);
  assert.equal(listed.links[0].resource_id, "record_123");
  assert.equal(Object.hasOwn(listed.links[0], "token_hash"), false);

  const opened = await owner.raw("GET", `/l/${created.token}`);
  assert.equal(opened.statusCode, 302);
  assert.equal(opened.body, "");

  await owner.request("POST", `/v1/public-links/organizations/${orgId}/links/${created.link.id}/revoke`, {});
  const revoked = await owner.raw("GET", `/l/${created.token}`);
  assert.equal(revoked.statusCode, 403);
  assert.equal(revoked.data.error, "public_link_revoked");
});

test("feedback delivery timing: final-payment mode sends once on the matching event", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "apps.feedback": true, "feedback.review_requests": true });
  const settingsUrl = `/v1/feedback/organizations/${orgId}/branches/default/settings`;
  const initial = await owner.request("GET", settingsUrl);
  const saved = await owner.request("PUT", settingsUrl, {
    ...initial.settings,
    delivery: { trigger: "final_payment" },
    channels: { sms: true, email: false, portal: true },
    messages: {
      ...initial.settings.messages,
      portal_title: "How was your project?",
      portal_body: "Your feedback helps our crew improve.",
      portal_cta: "Rate your experience"
    }
  });
  assert.equal(saved.settings.delivery.trigger, "final_payment");
  assert.equal(saved.settings.messages.portal_cta, "Rate your experience");

  await createProject(orgId, "proj_feedback_timing", "Jamie Rivera");
  const { handleFeedbackDeliveryEvent } = await import("../feedback/service.js");
  const progress = await handleFeedbackDeliveryEvent({
    id: "evt_progress",
    organization_id: orgId,
    branch_id: "default",
    project_id: "proj_feedback_timing",
    type: "payment.received",
    payload: { payment_kind: "progress" }
  });
  assert.equal(progress.reason, "delivery_trigger_not_matched");

  const finalPayment: any = await handleFeedbackDeliveryEvent({
    id: "evt_final",
    organization_id: orgId,
    branch_id: "default",
    project_id: "proj_feedback_timing",
    type: "payment.received",
    payload: { payment_kind: "final" }
  });
  assert.equal(finalPayment.ok, true);
  assert.equal(finalPayment.sends.length, 2);
  assert.equal(finalPayment.sends[0].channel, "sms");
  assert.equal(finalPayment.sends[1].channel, "portal");
});
