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
        platform: { lead_import: true, website_embed_import: true, scheduling: true, documents: true },
        email: { inbound_lead_import: true },
        lead_forms: { contact_form: true, appointment_form: true, instant_estimate: true }
      }
    }
  }));
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-forms-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.EMAIL_LEAD_AI_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.FORMS_RATE_LIMIT_DISABLED = "1";
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
    company: "Forms Test Org",
    organization_id: `org_forms_${suffix}`,
    global: {
      app_flags: {
        platform: { lead_import: true, website_embed_import: true, scheduling: true, documents: true },
        email: { inbound_lead_import: true },
        lead_forms: { contact_form: true, appointment_form: true, instant_estimate: true }
      }
    }
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}
const publicCall = async (method: string, url: string, payload?: unknown) => {
  const response = await (app.inject as any)({ method, url, payload });
  return { status: response.statusCode as number, body: response.body ? JSON.parse(response.body) : null };
};

async function createPublished(client: ReturnType<typeof createSessionClient>, orgId: string, template: string, edit?: (definition: any) => void) {
  const created = await client.request("POST", `/v1/forms/organizations/${orgId}/forms`, { template });
  let form = created.form;
  if (edit) {
    edit(form.definition);
    form = (await client.request("PATCH", `/v1/forms/organizations/${orgId}/forms/${form.id}`, { definition: form.definition, expected_revision: form.revision })).form;
  }
  const published = await client.request("POST", `/v1/forms/organizations/${orgId}/forms/${form.id}/publish`, { expected_revision: form.revision });
  return published.form;
}

test("Forms context lists templates, blocks and appointment types gated by capability", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const context = await client.request("GET", `/v1/forms/organizations/${orgId}/context`);
  assert.deepEqual(context.templates.map((template: any) => template.id), ["blank", "contact", "service_request", "appointment", "estimate", "roofing_instant_estimate"]);
  assert.ok(context.templates.every((template: any) => template.available));
  assert.ok(context.blocks.some((block: any) => block.kind === "appointment" && block.available));
  assert.ok(context.appointment_types.some((type: any) => type.id === "sales" && type.bookable_online));
  assert.equal(context.measurement_sources[0].id, "solar_roof");
});

test("A contact form is a draft until published, then captures a lead and its submission", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const draft = (await client.request("POST", `/v1/forms/organizations/${orgId}/forms`, { template: "contact", name: "Homepage contact" })).form;
  assert.equal(draft.status, "draft");
  assert.equal(draft.public_key, "", "unpublished forms expose no embed key");

  const published = (await client.request("POST", `/v1/forms/organizations/${orgId}/forms/${draft.id}/publish`, { expected_revision: draft.revision })).form;
  assert.equal(published.status, "live");
  assert.ok(published.published.version);
  assert.equal(published.has_unpublished_changes, false);
  const key = published.public_key;

  const config = await publicCall("GET", `/v1/forms/public/${key}`);
  assert.equal(config.status, 200, JSON.stringify(config.body));
  assert.equal(config.body.form.name, "Homepage contact");
  assert.equal(config.body.form.steps[0].items[0].kind, "contact");
  assert.equal(JSON.stringify(config.body).includes("notify_role_ids"), false, "settings stay server-side");

  const invalid = await publicCall("POST", `/v1/forms/public/${key}/submit`, { answers: { contact: { name: "No Email" } } });
  assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
  assert.equal(invalid.body.details.issues[0].param, "contact");

  const payload = {
    submission_id: "client-1",
    page_url: "https://example.test/contact",
    answers: { contact: { name: "Website Visitor", email: "Visitor@Example.test", phone: "(555) 444-5555" }, address: "441 Pine Avenue, Tacoma, WA 98402", message: "Need help with a fence.", unknown_field: "dropped" }
  };
  const submit = await publicCall("POST", `/v1/forms/public/${key}/submit`, payload);
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  assert.equal(submit.body.accepted, true);
  assert.equal(submit.body.project, undefined, "anonymous responses never include the project record");
  assert.equal(submit.body.success.title, "Request received");

  const replay = await publicCall("POST", `/v1/forms/public/${key}/submit`, payload);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.submission_id, submit.body.submission_id);

  const bot = await publicCall("POST", `/v1/forms/public/${key}/submit`, { website_url: "http://spam.test", answers: payload.answers });
  assert.equal(bot.status, 201);

  const projects = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  assert.equal(projects.documents.length, 1, "replays and bots create no extra leads");
  const project = projects.documents[0].data;
  assert.equal(project.source, "web_form");
  assert.equal(project.contacts[0].email, "visitor@example.test");
  assert.equal(project.summary, "Need help with a fence.");
  assert.equal(project.form_submission.form_name, "Homepage contact");
  assert.equal(project.form_submission.answers.unknown_field, undefined);
  assert.equal(project.lead_source.page_url, "https://example.test/contact");

  const submissions = await client.request("GET", `/v1/forms/organizations/${orgId}/forms/${draft.id}/submissions`);
  assert.equal(submissions.submissions.length, 1);
  assert.equal(submissions.submissions[0].contact.name, "Website Visitor");
  assert.equal(submissions.submissions[0].project_id, projects.documents[0].id);

  const listed = await client.request("GET", `/v1/forms/organizations/${orgId}/forms`);
  assert.equal(listed.forms[0].submissions.count, 1);

  // Pausing stops intake without losing the embed key; rotating the key revokes old embeds.
  const paused = (await client.request("PATCH", `/v1/forms/organizations/${orgId}/forms/${draft.id}`, { enabled: false })).form;
  assert.equal(paused.status, "paused");
  assert.equal((await publicCall("GET", `/v1/forms/public/${key}`)).status, 403);
  await client.request("PATCH", `/v1/forms/organizations/${orgId}/forms/${draft.id}`, { enabled: true });
  const rotated = (await client.request("POST", `/v1/forms/organizations/${orgId}/forms/${draft.id}/rotate-key`, {})).form;
  assert.notEqual(rotated.public_key, key);
  assert.equal((await publicCall("GET", `/v1/forms/public/${key}`)).status, 404);
  assert.equal((await publicCall("GET", `/v1/forms/public/${rotated.public_key}`)).status, 200);
});

test("Draft edits stay private until republished, and incomplete forms cannot publish", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const form = await createPublished(client, orgId, "contact");
  const definition = form.definition;
  definition.presentation.headline = "Edited headline";
  definition.steps[0].items.push({ id: "service", kind: "select", param: "service", label: "Service", options: [] });
  const saved = (await client.request("PATCH", `/v1/forms/organizations/${orgId}/forms/${form.id}`, { definition, expected_revision: form.revision })).form;
  assert.equal(saved.has_unpublished_changes, true);
  assert.notEqual((await publicCall("GET", `/v1/forms/public/${form.public_key}`)).body.form.presentation.headline, "Edited headline");

  const stale = await client.raw("PATCH", `/v1/forms/organizations/${orgId}/forms/${form.id}`, { name: "Stale", expected_revision: form.revision });
  assert.equal(stale.statusCode, 409, stale.body);

  const blocked = await client.raw("POST", `/v1/forms/organizations/${orgId}/forms/${form.id}/publish`, {});
  assert.equal(blocked.statusCode, 400, blocked.body);
  assert.match(blocked.body, /form_incomplete/);
  assert.match(blocked.body, /Add at least one choice/);

  saved.definition.steps[0].items.at(-1).options = [{ value: "repair", label: "Repair" }];
  const fixed = (await client.request("PATCH", `/v1/forms/organizations/${orgId}/forms/${form.id}`, { definition: saved.definition })).form;
  const republished = (await client.request("POST", `/v1/forms/organizations/${orgId}/forms/${form.id}/publish`, { expected_revision: fixed.revision })).form;
  assert.notEqual(republished.published.version, form.published.version, "a new content-addressed module version");
  assert.equal((await publicCall("GET", `/v1/forms/public/${form.public_key}`)).body.form.presentation.headline, "Edited headline");

  const copy = (await client.request("POST", `/v1/forms/organizations/${orgId}/forms/${form.id}/duplicate`, {})).form;
  assert.equal(copy.status, "draft");
  assert.equal(copy.name, "Contact form copy");
  await client.request("DELETE", `/v1/forms/organizations/${orgId}/forms/${copy.id}`);
  assert.equal((await client.request("GET", `/v1/forms/organizations/${orgId}/forms`)).forms.length, 1);
});

test("An estimate form prices answers through its published module and conditional questions", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const form = await createPublished(client, orgId, "estimate", (definition) => {
    definition.steps[0].items.push({ id: "gate", kind: "boolean", param: "gated", label: "Is there a locked gate?" });
    definition.steps[0].items.push({ id: "gate_code", kind: "text", param: "gate_code", label: "Gate code", required: true, visible_when: [{ param: "gated", op: "answered" }] });
    definition.calculation.pricing.adjustments = [{ id: "rush", label: "Rush scheduling", percent: 10, when: [{ param: "timing", op: "eq", value: "asap" }] }];
  });
  const module = await client.request("GET", `/v1/document-modules/organizations/${orgId}/modules/${form.published.module_id}`);
  assert.equal(module.module.definition.kind, "workflow");
  assert.equal(module.module.version, form.published.version);
  assert.equal(module.module.definition.workflow.steps[0].items[0].writes, "params.size");

  const contact = { name: "Estimate Visitor", email: "estimate@example.test" };
  const missing = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers: { size: 1000, gated: true, contact, consent: true } });
  assert.equal(missing.status, 422, JSON.stringify(missing.body));
  assert.equal(missing.body.details.issues[0].param, "gate_code");

  const submit = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers: { size: 1000, timing: "asap", gate_code: "hidden answers are dropped", contact, consent: true } });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  const estimate = submit.body.estimate;
  assert.equal(estimate.currency, "USD");
  assert.equal(estimate.low, 4400);
  assert.equal(estimate.high, 9900);
  assert.deepEqual(estimate.options.map((option: any) => [option.id, option.low, option.high]), [["standard", 4400, 6600], ["premium", 6600, 9900]]);
  assert.deepEqual(estimate.adjustments, [{ label: "Rush scheduling", percent: 10 }]);
  assert.equal(estimate.quantity.value, 1000);

  const projects = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  const project = projects.documents[0];
  assert.equal(project.data.form_submission.estimate.high, 9900);
  assert.equal(project.data.form_submission.answers.gate_code, undefined);

  const noConsent = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers: { size: 500, contact } });
  assert.equal(noConsent.status, 422);

  const preview = await client.request("POST", `/v1/forms/organizations/${orgId}/preview/submit`, { definition: form.definition, answers: { size: 2000, contact, consent: true } });
  assert.equal(preview.preview, true);
  assert.equal(preview.estimate.low, 8000);
  assert.equal((await client.request("GET", `/v1/platform/organizations/${orgId}/projects`)).documents.length, 1, "previewing creates nothing");
});

test("A submitted estimate is recorded on the project as a frozen instance of the form's module", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const form = await createPublished(client, orgId, "estimate");
  const { submitPublicForm } = await import("../forms/service.js");
  const { response, background } = await submitPublicForm(form.public_key, { answers: { size: 800, contact: { name: "Module Visitor", email: "module@example.test" }, consent: true } });
  await background;
  const projectId = (await client.request("GET", `/v1/platform/organizations/${orgId}/projects`)).documents[0].id;
  const instances = await client.request("GET", `/v1/document-modules/organizations/${orgId}/instances?projectId=${projectId}`);
  assert.equal(instances.instances.length, 1, JSON.stringify(instances));
  assert.equal(instances.instances[0].moduleId, form.published.module_id);
  assert.equal(instances.instances[0].frozen, true);
  const instance = (await client.request("GET", `/v1/document-modules/organizations/${orgId}/instances/${instances.instances[0].id}`)).instance;
  assert.equal(instance.exports.estimate.low, (response as any).estimate.low);
  assert.equal(instance.exports.answers.size, 800);
});

test("The roofing template falls back when imagery is unavailable and rejects forged measurements", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const form = await createPublished(client, orgId, "roofing_instant_estimate");
  const measured = await publicCall("POST", `/v1/forms/public/${form.public_key}/measurement`, { item_id: "measurement", address: "500 Roof Lane, Tacoma, WA" });
  assert.equal(measured.status, 200, JSON.stringify(measured.body));
  assert.equal(measured.body.measured, false);
  assert.ok(measured.body.token);

  const answers = { address: "500 Roof Lane, Tacoma, WA", roof_age: "20+", damage: "none", timeline: "asap", contact: { name: "Roof Visitor", email: "roof@example.test" }, consent: true, measurement: { roof_area_sqft: 1 } };
  const submit = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers, measurements: { measurement: "forged.token" } });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  assert.equal(submit.body.estimate.quantity.source, "fallback");
  assert.equal(submit.body.estimate.quantity.value, 2200);
  assert.deepEqual(submit.body.estimate.options.map((option: any) => option.id), ["asphalt", "metal", "tile"]);
  assert.equal(submit.body.estimate.low, 14850);

  const { signMeasurement } = await import("../forms/sources.js");
  const token = signMeasurement(form.id, "measurement", answers.address, { status: "measured", roof_area_sqft: 3000, pitch_category: "Steep" });
  const steep = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers, measurements: { measurement: token } });
  assert.equal(steep.body.estimate.quantity.source, "answer");
  assert.equal(steep.body.estimate.options[0].low, 26350, "3000 sq ft x 6.75 with the steep-pitch adjustment");
  assert.deepEqual(steep.body.estimate.adjustments, [{ label: "Steep roof pitch", percent: 30 }]);
});

test("An appointment form books a real appointment from the selected appointment type", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const unconfigured = await client.raw("POST", `/v1/forms/organizations/${orgId}/forms`, { template: "appointment" });
  const draft = JSON.parse(unconfigured.body).form;
  const blocked = await client.raw("POST", `/v1/forms/organizations/${orgId}/forms/${draft.id}/publish`, {});
  assert.equal(blocked.statusCode, 400, blocked.body);
  assert.match(blocked.body, /form_appointment_type_missing/);

  const form = await createPublished(client, orgId, "appointment", (definition) => {
    const picker = definition.steps[1].items[0];
    picker.preset_id = "sales";
    picker.horizon_days = 365;
  });
  const config = await publicCall("GET", `/v1/forms/public/${form.public_key}`);
  assert.equal(config.body.form.steps[1].items[0].preset_id, undefined, "scheduling configuration stays server-side");

  const date = new Date(Date.now() + 10 * 86_400_000);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  const day = date.toISOString().slice(0, 10);
  const availability = await publicCall("GET", `/v1/forms/public/${form.public_key}/availability?item_id=appointment&date=${day}&address=${encodeURIComponent("441 Pine Avenue, Tacoma, WA 98402")}`);
  assert.equal(availability.status, 200, JSON.stringify(availability.body));
  const slot = availability.body.slots[0];
  assert.ok(slot, "the sales appointment type has open times");
  assert.equal(slot.plan, undefined, "staff assignments are never sent to the visitor");

  const answers = { contact: { name: "Booking Visitor", phone: "(555) 444-5555" }, address: "441 Pine Avenue, Tacoma, WA 98402", appointment: { start_at: slot.start_at } };
  const submit = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  assert.equal(submit.body.appointment.status, "booked");
  assert.equal(submit.body.appointment.start_at, slot.start_at);

  const project = (await client.request("GET", `/v1/platform/organizations/${orgId}/projects`)).documents[0].data;
  assert.equal(project.events.length, 1);
  assert.equal(project.events[0].status, "scheduled");
  assert.equal(project.events[0].appointment_configuration.preset_id, "sales");
  assert.equal(project.events[0].customer_visible, true);
  assert.ok(project.events[0].assigned_user_ids.length, "the booking is assigned like a staff booking");

  const taken = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers: { ...answers, contact: { name: "Second Visitor", phone: "(555) 444-6666" } } });
  assert.equal(taken.status, 409, JSON.stringify(taken.body));
  assert.equal(taken.body.error, "form_slot_unavailable");
  assert.equal((await client.request("GET", `/v1/platform/organizations/${orgId}/projects`)).documents.length, 1, "a lost slot creates no lead");
});

test("Capability flags gate forms and the blocks that need them", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const form = await createPublished(client, orgId, "estimate");
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, { data: { app_flags: { platform: { expanded_access: true, lead_import: true, website_embed_import: true }, lead_forms: { contact_form: true, appointment_form: true, instant_estimate: false } } } }, { replace: false });
  assert.equal((await publicCall("GET", `/v1/forms/public/${form.public_key}`)).status, 403);
  const create = await client.raw("POST", `/v1/forms/organizations/${orgId}/forms`, { template: "estimate" });
  assert.equal(create.statusCode, 403, create.body);
  const contactCreate = await client.raw("POST", `/v1/forms/organizations/${orgId}/forms`, { template: "contact" });
  assert.equal(contactCreate.statusCode, 201, contactCreate.body);

  await saveGlobal(orgId, { data: { app_flags: { platform: { expanded_access: true, lead_import: true, website_embed_import: false } } } }, { replace: false });
  const listed = await client.raw("GET", `/v1/forms/organizations/${orgId}/forms`);
  assert.equal(listed.statusCode, 403, listed.body);
  assert.match(listed.body, /app_flag_disabled/);
});

test("Public submissions are rate limited per visitor", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const form = await createPublished(client, orgId, "contact");
  process.env.FORMS_RATE_LIMIT_DISABLED = "0";
  try {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      statuses.push((await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers: {} })).status);
    }
    assert.deepEqual(statuses.slice(0, 6), [422, 422, 422, 422, 422, 422]);
    assert.deepEqual(statuses.slice(6), [429, 429]);
  } finally {
    process.env.FORMS_RATE_LIMIT_DISABLED = "1";
  }
});

test("The form builder agent stages validated drafts and checks its own pricing", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const catalog = await client.request("GET", `/v1/agents/organizations/${orgId}/agents`);
  assert.ok(catalog.agents.some((agent: any) => agent.id === "forms"), "the agent is registered with the shared runtime");

  const { agentDefinition } = await import("../agents/registry.js");
  const { buildTemplateDefinition } = await import("../forms/templates.js");
  const tools = agentDefinition("forms")!.tools as any[];
  const tool = (name: string) => tools.find((entry) => entry.name === name);
  const definition = buildTemplateDefinition("estimate") as any;
  const run: any = { input: { subject: { name: "Fence estimate" }, definition }, scratch: {}, actions: [], changeLog: [], ctx: null };

  assert.equal((await tool("get_current_form").execute(run, {})).name, "Fence estimate");

  const broken = structuredClone(definition);
  broken.steps[0].items.push({ id: "material", kind: "select", param: "material", label: "Material", options: [] });
  const rejected = await tool("update_form").execute(run, { definition: JSON.stringify(broken) });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(" "), /Add at least one choice/);
  assert.equal(run.actions.length, 0, "an invalid draft never reaches the editor");

  const edited = structuredClone(definition);
  edited.steps[0].items.push({ id: "material", kind: "select", param: "material", label: "Material", options: [{ value: "wood", label: "Wood" }, { value: "vinyl", label: "Vinyl" }] });
  edited.calculation.pricing.adjustments = [{ id: "vinyl", label: "Vinyl upgrade", percent: 25, when: [{ param: "material", op: "eq", value: "vinyl" }] }];
  const staged = await tool("update_form").execute(run, { definition: JSON.stringify(edited), change_note: "Added a material question with a vinyl upgrade." });
  assert.equal(staged.ok, true);
  assert.equal(run.actions[0].type, "form.set_definition");
  assert.equal(run.actions[0].definition.steps[0].items.at(-1).style, "cards", "the staged draft is the normalized definition");
  assert.deepEqual(run.changeLog, ["Added a material question with a vinyl upgrade."]);

  const priced = await tool("test_estimate").execute(run, { answers: JSON.stringify({ size: 1000, material: "vinyl" }) });
  assert.equal(priced.ok, true);
  assert.equal(priced.estimate.low, 5000, "prices the draft staged this turn, not the stale editor copy");
  assert.deepEqual(priced.estimate.adjustments, [{ label: "Vinyl upgrade", percent: 25 }]);
});

test("Mapped answers are written to the project's declared custom fields", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const { saveBranchModule } = await import("../platform/storage.js");
  await saveBranchModule(orgId, "default", "custom_fields", { data: { fields: [{ id: "gate_code", key: "gate_code", label: "Gate code", type: "text", entity: "project" }] } }, { replace: true });
  const form = await createPublished(client, orgId, "contact", (definition) => {
    definition.steps[0].items.push({ id: "gate", kind: "text", param: "gate", label: "Gate code", maps_to: "gate_code" });
  });
  const { submitPublicForm } = await import("../forms/service.js");
  const { background } = await submitPublicForm(form.public_key, { answers: { contact: { name: "Mapped Visitor", email: "mapped@example.test" }, gate: "4821" } });
  await background;
  const project = (await client.request("GET", `/v1/platform/organizations/${orgId}/projects`)).documents[0].data;
  assert.equal(project.form_submission.answers.gate, "4821");
  assert.equal((project.custom_field_values || project.custom_fields || {}).gate_code, "4821");
});

test("A lead is never lost to pricing, and a retried submission resolves to the same lead", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const form = await createPublished(client, orgId, "roofing_instant_estimate", (definition) => {
    definition.calculation.pricing.quantity.fallback = 0;
  });
  const answers = { address: "9 Unmeasurable Way, Tacoma, WA", roof_age: "20+", damage: "none", timeline: "asap", contact: { name: "http://spam.example/win", email: "retry@example.test" }, consent: true };
  const first = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers, submission_id: "retry-1" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.estimate, undefined);
  assert.equal(first.body.estimate_unavailable, true, "the visitor is told pricing will follow instead of seeing an error");

  // The response was lost in transit: the browser sends the same submission again.
  const again = await publicCall("POST", `/v1/forms/public/${form.public_key}/submit`, { answers, submission_id: "retry-1" });
  assert.equal(again.body.submission_id, first.body.submission_id);
  const projects = (await client.request("GET", `/v1/platform/organizations/${orgId}/projects`)).documents;
  assert.equal(projects.length, 1);
  assert.match(projects[0].data.form_submission.estimate_error, /quantity is required/);

  const { submitPublicForm } = await import("../forms/service.js");
  const { saveRecord } = await import("../forms/storage.js");
  // A request that died after creating the lead leaves its claim behind; once stale, the retry resumes onto the same lead.
  await saveRecord(orgId, "form_submissions", first.body.submission_id, { form_id: form.id, status: "processing", created_at: new Date(Date.now() - 10 * 60_000).toISOString() });
  await (await submitPublicForm(form.public_key, { answers, submission_id: "retry-1" })).background;
  assert.equal((await client.request("GET", `/v1/platform/organizations/${orgId}/projects`)).documents.length, 1);
});

test("Publishing rejects a show-when rule that depends on a later question", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const draft = (await client.request("POST", `/v1/forms/organizations/${orgId}/forms`, { template: "service_request" })).form;
  draft.definition.steps[0].items[0].visible_when = [{ param: "notes", op: "answered" }];
  await client.request("PATCH", `/v1/forms/organizations/${orgId}/forms/${draft.id}`, { definition: draft.definition });
  const blocked = await client.raw("POST", `/v1/forms/organizations/${orgId}/forms/${draft.id}/publish`, {});
  assert.equal(blocked.statusCode, 400, blocked.body);
  assert.match(blocked.body, /not asked earlier in the form/);
});

test("Rate limits follow the visitor's address behind the platform's proxies", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const form = await createPublished(client, orgId, "contact");
  process.env.FORMS_RATE_LIMIT_DISABLED = "0";
  try {
    const submit = async (forwarded: string) => (await (app.inject as any)({ method: "POST", url: `/v1/forms/public/${form.public_key}/submit`, payload: { answers: {} }, headers: { "x-forwarded-for": forwarded } })).statusCode;
    for (let attempt = 0; attempt < 6; attempt += 1) assert.equal(await submit("198.51.100.7, 10.0.0.4"), 422);
    assert.equal(await submit("198.51.100.7, 10.0.0.4"), 429);
    assert.equal(await submit("203.0.113.9, 198.51.100.7, 10.0.0.4"), 429, "a client-supplied prefix does not earn a fresh allowance");
    assert.equal(await submit("198.51.100.8, 10.0.0.4"), 422, "another visitor is unaffected");
  } finally {
    process.env.FORMS_RATE_LIMIT_DISABLED = "1";
  }
});
