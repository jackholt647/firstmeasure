import { nextTestPhone, closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { runLegacyCrmMigration } from "../internal/crm/migration.js";
import { ensureLeadDatabase, withLeadDb } from "../internal/crm/leads.js";

let app: any = null;
let storageRoot = "";

async function inject(method: string, url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload });
  const json = response.body ? JSON.parse(response.body) : null;
  assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
  return json;
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-crm-api-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, 'messaging');
  process.env.CUSTOMER_CALL_WORKER_DISABLED = '1';
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, "channels");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { env } = await import("../src/config/env.js");
  const mutableEnv = env as unknown as {
    platformStorageRoot: string;
    messagingStorageRoot: string;
    internalStorageRoot: string;
    crmStorageRoot: string;
    channelsStorageRoot: string;
    firstmeasureStorageRoot: string;
    firstmeasureIndexDbPath: string;
  };
  mutableEnv.platformStorageRoot = process.env.PLATFORM_STORAGE_ROOT ?? "";
  mutableEnv.messagingStorageRoot = process.env.MESSAGING_STORAGE_ROOT ?? '';
  mutableEnv.internalStorageRoot = process.env.INTERNAL_STORAGE_ROOT ?? "";
  mutableEnv.crmStorageRoot = process.env.CRM_STORAGE_ROOT ?? "";
  mutableEnv.channelsStorageRoot = process.env.CHANNELS_STORAGE_ROOT ?? "";
  mutableEnv.firstmeasureStorageRoot = process.env.FIRSTMEASURE_STORAGE_ROOT ?? "";
  mutableEnv.firstmeasureIndexDbPath = process.env.FIRSTMEASURE_INDEX_DB_PATH ?? "";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
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

test("CRM API stores organization-scoped CRM collections with pagination and search", async () => {
  const created = await inject("POST", "/v1/internal/crm/organizations/org_1/leads", {
    id: "lead_1",
    data: {
      name: "Acme Roof",
      status: "new",
      address: "1 Main"
    }
  });
  assert.equal(created.document.id, "lead_1");
  assert.equal(created.document.organization_id, "org_1");

  await inject("POST", "/v1/internal/crm/organizations/org_1/leads", {
    id: "lead_2",
    data: { name: "Beta Roof", status: "won" }
  });

  const searched = await inject("GET", "/v1/internal/crm/organizations/org_1/leads/search?q=acme&limit=10");
  assert.equal(searched.count, 1);
  assert.equal(searched.documents[0].id, "lead_1");

  const dashboard = await inject("GET", "/v1/internal/crm/organizations/org_1/dashboard");
  assert.equal(dashboard.totals.leads, 2);
  assert.equal(dashboard.lead_status_counts.new, 1);
  assert.equal(dashboard.lead_status_counts.won, 1);
});

test("call lists are organization objects with assignments, idempotent entries, and dispositions", async () => {
  let cookie='',csrf='';
  const inject=async(method:string,url:string,payload?:unknown)=>{
    const response=await app.inject({method,url,payload,headers:{cookie,...(method!=='GET'&&csrf?{'x-platform-csrf':csrf}:{})}});
    for(const value of [response.headers['set-cookie']||[]].flat()){
      const pair=String(value).split(';')[0]!,name=pair.split('=')[0];cookie=[...cookie.split('; ').filter(p=>p&&!p.startsWith(`${name}=`)),pair].join('; ');
      if(name==='fm_platform_session_csrf')csrf=decodeURIComponent(pair.slice(pair.indexOf('=')+1));
    }
    assert.ok(response.statusCode<400,`${method} ${url}: ${response.statusCode} ${response.body}`);return response.json();
  };
  const platformStorage = await import("../platform/storage.js");
  const suffix = Math.random().toString(36).slice(2, 10);
  const orgId = `org_calls_${suffix}`;
  const projectId = `project_calls_${suffix}`;
  await inject('POST','/v1/platform/auth/register',{
    phone: nextTestPhone(),organization_id:orgId,email:`calls-${suffix}@example.test`,password:'correct horse battery staple',name:'Casey Caller',company:'Call List Test'});
  await enableExpandedPlatformFixture(orgId);
  await platformStorage.upsertDocument(orgId, "projects", {
    id: projectId,
    data: {
      title: "Smith Roof",
      address: "12 Cedar Way",
      contacts: [{ name: "Alex Smith", phone: "+12065550102" }]
    },
    metadata: { kind: "platform_project" }
  });

  // No blessed lists: a fresh org has zero call lists until an automation,
  // the follow-up projection, or explicit configuration creates one.
  const defaults = await inject("GET", `/v1/internal/crm/organizations/${orgId}/call-lists`);
  assert.equal(defaults.call_lists.length, 0);

  // A new lead arriving (project.created) queues the first call through the
  // default organization automation rule, creating New Leads on demand with a
  // project-keyed entry.
  const { emitWorkEvent } = await import("../work/engine.js");
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: "default",
    project_id: projectId,
    type: "project.created",
    idempotency_key: `project.created:${projectId}`,
    payload: { project_id: projectId }
  });
  const seeded = await inject("GET", `/v1/internal/crm/organizations/${orgId}/call-lists`);
  const newLeads = seeded.call_lists.find((list: any) => list.key === "new_leads");
  assert.ok(newLeads, "the intake rule created the New Leads list");
  assert.equal(newLeads.pending_count, 1);

  const created = await inject("POST", `/v1/internal/crm/organizations/${orgId}/call-lists`, {
    key: "mid_project_checkin",
    title: "Mid-project Check-ins",
    kind: "production",
    assigned_role_ids: ["production"],
    metadata: { cadence: "halfway" }
  });
  assert.equal(created.call_list.key, "mid_project_checkin");
  assert.deepEqual(created.call_list.assigned_role_ids, ["production"]);

  const first = await inject("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/mid_project_checkin/entries`, {
    source_key: "work_node_1",
    project_id: projectId,
    work_plan_id: "work_plan_1",
    title: "Halfway check-in"
  });
  const duplicate = await inject("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/mid_project_checkin/entries`, {
    source_key: "work_node_1",
    project_id: projectId,
    title: "Updated halfway check-in"
  });
  assert.equal(duplicate.entry.id, first.entry.id);

  const hidden = await inject("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { role_ids: ["office"] });
  assert.ok(hidden.columns.some((column: any) => column.key === "mid_project_checkin"), 'server uses the authenticated owner permissions, not client-supplied roles');
  const queue = await inject("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { role_ids: ["production"] });
  const productionList = queue.columns.find((column: any) => column.key === "mid_project_checkin");
  assert.equal(productionList.tasks.length, 1);
  assert.equal(productionList.tasks[0].name, "Alex Smith");
  assert.equal(productionList.tasks[0].title, "Updated halfway check-in");

  const disposition = await inject("POST", `/v1/internal/crm/organizations/${orgId}/call-list-entries/${first.entry.id}/disposition`, {
    actor_email: "caller@example.test",
    actor_name: "Casey Caller",
    disposition: "answered",
    outcome: "check_in_complete",
    note_text: "Everything is on track."
  });
  const after = await inject("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { role_ids: ["production"] });
  assert.equal(after.columns.find((column: any) => column.key === "mid_project_checkin").tasks.length, 0);
  // Call notes now live in the channels backend as messages in the project's
  // channel (tagged call_note), not as project-document JSON.
  const { findChannelByProject, listMessageRecords } = await import("../channels/storage.js");
  const projectChannel = (await findChannelByProject(orgId, projectId));
  assert.ok(projectChannel, "disposition creates the project channel");
  const messages = (await listMessageRecords(orgId, projectChannel!.id, {}));
  const callMessage = messages.find((message) => message.tags.includes("call_note"));
  assert.ok(callMessage, "call note message exists in the project channel");
  assert.equal(callMessage!.text, "Everything is on track.");
  assert.deepEqual(callMessage!.tags, ["call_note"]);
  assert.equal((callMessage!.metadata.call as any).call_list_key, "mid_project_checkin");
  assert.equal(callMessage!.client_msg_id, `call_disposition:${disposition.entry.result.note_id}`);
  assert.equal(Object.hasOwn(disposition.entry.result, "note_text"), false);
  const { listEventRecords } = await import("../work/storage.js");
  const callEvent = (await listEventRecords(orgId, { project_id:projectId, type:"call.completed", visibility:"activity" }))[0] as any;
  assert.ok(callEvent, "completed calls are published to the activity feed");
  assert.equal(callEvent.payload.disposition, "answered");
  assert.equal(callEvent.context.actor_name, "Casey Caller");
  const project = await platformStorage.readDocument(orgId, "projects", projectId);
  assert.equal(Object.hasOwn(project.data, "call_notes"), false);
  assert.ok(!(project.data.project_note_items as any[])?.length, "legacy note JSON is not written anymore");
});

test("CRM migration dry-run is read-only and fresh rebuild validates cloned records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmate-crm-migration-"));
  try {
    const source = path.join(root, "legacy-crm");
    const target = path.join(root, "crm");
    await writeJson(path.join(source, "organizations", "org_legacy", "leads", "legacy_lead.json"), {
      id: "legacy_lead",
      data: { name: "Legacy Lead", status: "contacting" }
    });
    await writeJson(path.join(source, "global", "call_scripts", "default.json"), {
      id: "default",
      data: { title: "Default Script", body: "Hello" }
    });
    const before = await readFile(path.join(source, "organizations", "org_legacy", "leads", "legacy_lead.json"), "utf8");

    const dryRun = await runLegacyCrmMigration({ sourceRoot: source, targetRoot: target, mode: "dry-run" });
    assert.equal(dryRun.counts.legacy_records_read, 2);
    assert.equal(dryRun.counts.crm_records_written, 0);
    assert.equal(await readFile(path.join(source, "organizations", "org_legacy", "leads", "legacy_lead.json"), "utf8"), before);

    const fresh = await runLegacyCrmMigration({ sourceRoot: source, targetRoot: target, mode: "fresh", confirmFresh: true });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.validation?.failed, 0);
    const saved = JSON.parse(await readFile(path.join(target, "organizations", "org_legacy", "leads", "legacy_lead.json"), "utf8"));
    assert.equal(saved.data.name, "Legacy Lead");

    const validate = await runLegacyCrmMigration({ sourceRoot: source, targetRoot: target, mode: "validate" });
    assert.equal(validate.ok, true);
    assert.equal(validate.validation?.failed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Internal CRM referral endpoints save partners and pair organizations", async () => {
  const platformStorage = await import("../platform/storage.js");
  const suffix = Math.random().toString(36).slice(2, 10);
  const orgId = `org_referral_${suffix}`;
  await platformStorage.createOrganization({
    id: orgId,
    name: "Referral Test Customer",
    status: "active",
    owner_email: "owner@example.test",
    metadata: { phone: "555-0100" }
  });
  await platformStorage.patchOrganization(orgId, {
    owner_email: "owner@example.test",
    billing_email: "billing@example.test"
  });

  const saved = await inject("POST", "/v1/internal/crm/referrals/partners", {
    display_name: "Test Referral Partner",
    company_name: "Partner Co",
    type: "manufacturer_rep",
    status: "active",
    contact_email: "partner@example.test",
    new_org_offer_id: "referral_week_discount_v1"
  });
  assert.equal(saved.success, true);
  assert.ok(saved.partner.id);
  assert.equal(saved.primary_code.new_org_offer_id, "referral_week_discount_v1");

  const listed = await inject("GET", "/v1/internal/crm/referrals/partners");
  assert.ok(listed.partners.some((partner: any) => partner.id === saved.partner.id));

  const searched = await inject("GET", "/v1/internal/crm/referrals/organizations/search?q=Referral%20Test&limit=10");
  assert.ok(searched.organizations.some((organization: any) => organization.id === orgId));

  const attached = await inject("POST", `/v1/internal/crm/referrals/partners/${saved.partner.id}/attach-organization`, {
    org_id: orgId,
    note: "test attach"
  });
  assert.equal(attached.attached, true);

  const rewards = await inject("GET", "/v1/internal/crm/referrals/rewards");
  assert.ok(rewards.rows.some((row: any) => row.referred_org_id === orgId));

  const oldPath = await app.inject({ method: "GET", url: "/v1/crm/referrals/partners" });
  assert.equal(oldPath.statusCode, 404);
});

test("Acquisition campaigns balance bonus offer assignments and carry them to signup", async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const campaignCode = `BONUS-SPLIT-${suffix}`.toUpperCase();
  const saved = await inject("POST", "/v1/internal/crm/referrals/acquisition/campaigns", {
    display_name: `Bonus Split ${suffix}`,
    code: campaignCode,
    campaign_type: "facebook",
    landing_page: "/portal/landing/variants/measurements/",
    bonus_offer_sets: [
      {
        label: "Small control",
        tiers: [
          { customer_pays: 50, match_percent: 0 },
          { customer_pays: 100, match_percent: 25 }
        ]
      },
      {
        label: "Aggressive match",
        tiers: [
          { customer_pays: 50, match_percent: 25 },
          { customer_pays: 100, match_percent: 50 }
        ]
      }
    ]
  });
  assert.equal(saved.success, true);

  const firstView = await inject("POST", "/v1/platform/acquisition/public/track", {
    cid: campaignCode,
    landing_page: "/portal/landing/variants/measurements/",
    page_url: `https://app.1m8.ai/portal/landing/variants/measurements/?cid=${campaignCode}`,
    client_ip: "203.0.113.10",
    browser_user_agent: "node-test"
  });
  const secondView = await inject("POST", "/v1/platform/acquisition/public/track", {
    cid: campaignCode,
    landing_page: "/portal/landing/variants/measurements/",
    page_url: `https://app.1m8.ai/portal/landing/variants/measurements/?cid=${campaignCode}`,
    client_ip: "203.0.113.11",
    browser_user_agent: "node-test"
  });
  assert.ok(firstView.bonus_offer?.token);
  assert.ok(secondView.bonus_offer?.token);
  assert.equal(firstView.bonus_offer.tiers.length, 3);
  assert.equal(secondView.bonus_offer.tiers.length, 3);
  const repeatFirstView = await inject("POST", "/v1/platform/acquisition/public/track", {
    cid: campaignCode,
    landing_page: "/portal/landing/variants/measurements/",
    page_url: `https://app.1m8.ai/portal/landing/variants/measurements/?cid=${campaignCode}`,
    client_ip: "203.0.113.10",
    browser_user_agent: "node-test"
  });
  assert.equal(repeatFirstView.bonus_offer?.token, firstView.bonus_offer.token);

  const email = `bonus-${suffix}@example.test`;
  const registered = await inject("POST", "/v1/platform/auth/legacy-action", {
    action: "register",
    name: "Bonus Split Owner",
    company: `Bonus Split Co ${suffix}`,
    phone: nextTestPhone(),
    email,
    password: "secret123",
    acquisition_code: campaignCode,
    acquisition_attribution_id: firstView.acquisition_attribution_id,
    acquisition_bonus_token: firstView.bonus_offer.token,
    xid: firstView.bonus_offer.token,
    landing_variant: "measurements",
    campaign_type: "facebook"
  });
  const orgId = registered.organization?.id || registered.membership?.organization_id;
  assert.ok(orgId);

  const referrals = await import("../internal/crm/referrals.js");
  const offer = await referrals.acquisitionBonusOfferForOrganization(orgId);
  assert.equal(offer.offer_enabled, true);
  assert.ok(offer.offer);
  assert.equal(offer.offer.token, firstView.bonus_offer.token);

  const quote = await referrals.acquisitionBonusQuoteForOrganization(orgId, 120, firstView.bonus_offer.token);
  assert.equal(quote.valid, true);
  assert.equal(quote.threshold, 100);
  assert.equal(quote.total_account_value, 120 + quote.bonus_dollars);

  const report = await inject("GET", `/v1/internal/crm/referrals/acquisition/report?campaign_id=${encodeURIComponent(saved.campaign.id)}&start_date=2020-01-01&end_date=2099-12-31`);
  assert.ok(report.bonus_offers.length >= 1);
  assert.ok(report.bonus_offers.some((row: any) => row.token === firstView.bonus_offer.token && row.signups === 1));
});

test("Acquisition lookup resolves cloned landing pages when template campaign data is stale", async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const campaignCode = `META619A-${suffix}`.toUpperCase();
  const landingPage = "/portal/landing/variants/meta-619a/";
  const saved = await inject("POST", "/v1/internal/crm/referrals/acquisition/campaigns", {
    display_name: `Meta 619A ${suffix}`,
    code: campaignCode,
    campaign_type: "facebook",
    landing_page: landingPage,
    landing_variant: "meta-619a",
    bonus_offer_sets: [
      {
        label: "Meta bonus",
        tiers: [
          { customer_pays: 50, match_percent: 20 },
          { customer_pays: 100, match_percent: 50 }
        ]
      }
    ]
  });
  assert.equal(saved.success, true);

  const tracked = await inject("POST", "/v1/platform/acquisition/public/track", {
    campaign: "landing_template",
    landing_variant: "landing_template",
    landing_page: landingPage,
    page_url: `https://app.1m8.ai${landingPage}`,
    client_ip: "203.0.113.61",
    browser_user_agent: "node-test"
  });
  assert.equal(tracked.success, true);
  assert.equal(tracked.link.code, campaignCode);
  assert.equal(tracked.acquisition_campaign.id, saved.campaign.id);
  assert.ok(tracked.bonus_offer?.token);

  const email = `meta-619a-${suffix}@example.test`;
  const registered = await inject("POST", "/v1/platform/auth/legacy-action", {
    action: "register",
    name: "Meta Campaign Owner",
    company: `Meta Campaign Co ${suffix}`,
    phone: nextTestPhone(),
    email,
    password: "secret123",
    acquisition_attribution_id: tracked.acquisition_attribution_id,
    campaign: "landing_template",
    landing_variant: "meta-619a",
    landing_page: landingPage,
    campaign_type: "facebook"
  });
  const orgId = registered.organization?.id || registered.membership?.organization_id;
  assert.ok(orgId);

  const referrals = await import("../internal/crm/referrals.js");
  const offer = await referrals.acquisitionBonusOfferForOrganization(orgId);
  assert.equal(offer.offer_enabled, true);
  assert.ok(offer.offer);
  assert.equal(offer.offer.token, tracked.bonus_offer.token);
});

test("CRM lead API queries paginated SQLite leads with derived activity fields", async () => {
  await ensureLeadDatabase();
  withLeadDb((db) => {
    db.exec("DELETE FROM lead_custom_values; DELETE FROM lead_custom_fields; DELETE FROM lead_exports; DELETE FROM lead_dial_events; DELETE FROM lead_notes; DELETE FROM lead_contacts; DELETE FROM lead_followups; DELETE FROM lead_memberships; DELETE FROM lead_lists; DELETE FROM lead_entities;");
    db.prepare(`
      INSERT INTO lead_lists (id, name, assigned_to_email, exported_at, created_at, updated_at)
      VALUES ('list_1', 'Northwest', 'rep@example.test', 1770000100, 1770000000, 1770000000)
    `).run();
    db.prepare(`
      INSERT INTO lead_memberships (id, list_id, status, company, email, phone, region, region_code, assigned_to_email, created_at, updated_at, external_key, website)
      VALUES
      ('lead_1', 'list_1', 'new', 'Acme Roofing', 'acme@example.test', '555-1111', 'Washington', 'WA', 'rep@example.test', 1770000001, 1770000300, 'ext_1', 'https://acme.test'),
      ('lead_2', 'list_1', 'called', 'Beta Roofing', '', '555-2222', 'Washington', 'WA', 'other@example.test', 1770000002, 1770000200, 'ext_2', ''),
      ('lead_3', 'list_1', '', 'Gamma Roofing', '', '', '', '', 'other@example.test', 1770000003, 1770000100, 'ext_3', '')
    `).run();
    db.prepare("INSERT INTO lead_dial_events (id, lead_id, owner_email, context_json, dialed_at, created_at) VALUES ('dial_1', 'lead_1', 'rep@example.test', '{\"disposition\":\"Interested\"}', 1770000400, 1770000400)").run();
    db.prepare("INSERT INTO lead_notes (id, lead_id, owner_email, note_text, created_at, updated_at) VALUES ('note_1', 'lead_1', 'rep@example.test', 'Useful note', 1770000500, 1770000500)").run();
    db.prepare("INSERT INTO lead_contacts (id, lead_id, full_name, email, phone, created_at, updated_at) VALUES ('contact_1', 'lead_1', 'Pat Owner', 'pat@example.test', '555-4444', 1770000500, 1770000500)").run();
    db.prepare("INSERT INTO lead_exports (id, list_id, exported_by_email, exported_at, row_count) VALUES ('export_1', 'list_1', 'rep@example.test', 1770000600, 3)").run();
  });

  const fields = await inject("GET", "/v1/internal/crm/leads/fields");
  assert.ok(fields.fields.some((field: any) => field.key === "latest_call_at"));
  assert.equal(fields.fields.some((field: any) => field.key === "list_name"), false);
  assert.equal(fields.fields.some((field: any) => field.key === "contact_count"), false);

  const customField = await inject("POST", "/v1/internal/crm/leads/custom-fields", {
    label: "Priority Band",
    data_type: "select",
    topbar_filter: true,
    options: ["High", "Low"],
    actor_email: "manager@example.test"
  });
  assert.equal(customField.field.key, "custom_priority_band");
  assert.equal(customField.field.topbarFilter, true);
  withLeadDb((db) => {
    db.prepare(`
      INSERT INTO lead_custom_values (lead_id, field_key, value_text, updated_at, updated_by_email)
      VALUES ('lead_1', 'priority_band', 'High', 1770000700, 'manager@example.test')
    `).run();
  });

  const fieldsWithCustom = await inject("GET", "/v1/internal/crm/leads/fields");
  assert.ok(fieldsWithCustom.fields.some((field: any) => field.key === "custom_priority_band"));

  const options = await inject("POST", "/v1/internal/crm/leads/filter-options", {
    manager: true
  });
  assert.ok(options.options.status.some((option: any) => option.value === "new"));
  assert.ok(options.options.status.some((option: any) => option.value === "__none__"));
  assert.ok(options.options.assigned_to_email.some((option: any) => option.value === "rep@example.test"));
  assert.ok(options.options.region.some((option: any) => option.value === "Washington"));
  assert.ok(options.options.region.some((option: any) => option.value === "__none__"));
  assert.ok(options.options.disposition.some((option: any) => option.value === "Interested"));
  assert.ok(options.options.disposition.some((option: any) => option.value === "__none__"));
  assert.ok(options.options.custom.custom_priority_band.some((option: any) => option.value === "High"));

  const page = await inject("POST", "/v1/internal/crm/leads/query", {
    page: 1,
    per_page: 10,
    q: "acme",
    manager: true,
    sort: "latest_call_at",
    dir: "desc",
    filters: { has_email: true }
  });
  assert.equal(page.total, 1);
  assert.equal(page.leads[0].id, "lead_1");
  assert.equal(page.leads[0].latest_call_at, 1770000400);
  assert.equal(page.leads[0].latest_export_at, 1770000600);
  assert.equal(page.leads[0].notes_count, 1);
  assert.equal(page.leads[0].custom_priority_band, "High");

  const customFiltered = await inject("POST", "/v1/internal/crm/leads/query", {
    page: 1,
    per_page: 10,
    manager: true,
    filters: { custom_priority_band: "High" }
  });
  assert.equal(customFiltered.total, 1);
  assert.equal(customFiltered.leads[0].id, "lead_1");

  const repScoped = await inject("POST", "/v1/internal/crm/leads/query", {
    actor_email: "rep@example.test",
    manager: false,
    per_page: 10
  });
  assert.equal(repScoped.total, 1);
  assert.equal(repScoped.leads[0].id, "lead_1");

  const blankScoped = await inject("POST", "/v1/internal/crm/leads/query", {
    manager: true,
    per_page: 10,
    filters: { status: "__none__", region: "__none__", disposition: "__none__", no_contact_data: true }
  });
  assert.equal(blankScoped.total, 1);
  assert.equal(blankScoped.leads[0].id, "lead_3");

  const detail = await inject("GET", "/v1/internal/crm/leads/lead_1/detail");
  assert.equal(detail.notes[0].note_text, "Useful note");

  const viewer = await inject("GET", "/v1/internal/crm/leads/lead_1/viewer");
  assert.equal(viewer.lead.company, "Acme Roofing");
  assert.equal(viewer.notes[0].note_text, "Useful note");

  const edited = await inject("PATCH", "/v1/internal/crm/leads/lead_1", {
    actor_email: "rep@example.test",
    lead: { phone: "555-9999" },
    custom_values: { priority_band: "Low" }
  });
  assert.equal(edited.lead.phone, "555-9999");
  assert.equal(edited.lead.custom_priority_band, "Low");

  const editedContact = await inject("PATCH", "/v1/internal/crm/leads/lead_1/contacts/contact_1", {
    actor_email: "rep@example.test",
    contact: { phone: "555-1010" }
  });
  assert.equal(editedContact.contacts[0].phone, "555-1010");

  const addedNote = await inject("POST", "/v1/internal/crm/leads/lead_1/notes", {
    actor_email: "rep@example.test",
    note_text: "Fresh note"
  });
  assert.ok(addedNote.notes.some((note: any) => note.note_text === "Fresh note"));

  const addedFollowup = await inject("POST", "/v1/internal/crm/leads/lead_1/followups", {
    actor_email: "rep@example.test",
    title: "Call back",
    due_at: "2026-06-03"
  });
  assert.ok(addedFollowup.followups.some((followup: any) => followup.title === "Call back"));

  const addedContactNote = await inject("POST", "/v1/internal/crm/leads/lead_1/contacts/contact_1/notes", {
    actor_email: "rep@example.test",
    note_text: "Contact-specific note"
  });
  assert.ok(addedContactNote.contact_notes.some((note: any) => note.note_text === "Contact-specific note"));

  const explicitExport = await inject("POST", "/v1/internal/crm/leads/export", {
    selection: { mode: "explicit", ids: ["lead_1"] },
    fields: ["company", "email", "latest_call_at"]
  });
  assert.equal(explicitExport.count, 1);
  assert.match(explicitExport.csv, /Acme Roofing/);

  const customExport = await inject("POST", "/v1/internal/crm/leads/export", {
    selection: { mode: "explicit", ids: ["lead_1"] },
    fields: ["company", "custom_priority_band"]
  });
  assert.match(customExport.csv, /Priority Band/);
  assert.match(customExport.csv, /Low/);

  const filteredExport = await inject("POST", "/v1/internal/crm/leads/export", {
    selection: {
      mode: "filtered",
      excluded_ids: ["lead_2"],
      query: { manager: true, filters: { region: "Washington" } }
    },
    fields: ["company"]
  });
  assert.equal(filteredExport.count, 1);
  assert.match(filteredExport.csv, /Acme Roofing/);
  assert.doesNotMatch(filteredExport.csv, /Beta Roofing/);

  const selectedSummary = await inject("POST", "/v1/internal/crm/leads/query", {
    manager: true,
    q: "acme",
    selection: { mode: "explicit", ids: ["lead_1", "lead_2"] }
  });
  assert.equal(selectedSummary.selection_summary.total, 2);
  assert.equal(selectedSummary.selection_summary.matching_current_filter, 1);
  assert.equal(selectedSummary.selection_summary.outside_current_filter, 1);

  const selectedView = await inject("POST", "/v1/internal/crm/leads/query", {
    manager: true,
    selection_view: true,
    selection: { mode: "explicit", ids: ["lead_1", "lead_2"] },
    selection_summary_query: { manager: true, q: "acme" },
    page: 1,
    per_page: 1
  });
  assert.equal(selectedView.total, 2);
  assert.equal(selectedView.leads.length, 1);
  assert.equal(selectedView.leads[0].id, "lead_1");
  assert.equal(selectedView.selection_summary.outside_current_filter, 1);

  const previewReassign = await inject("POST", "/v1/internal/crm/leads/reassign", {
    manager: true,
    actor_email: "manager@example.test",
    dry_run: true,
    assignees: ["one@example.test", "two@example.test"],
    selection: {
      mode: "filtered",
      excluded_ids: ["lead_2"],
      query: { manager: true, filters: { region: "Washington" } }
    }
  });
  assert.equal(previewReassign.total, 1);
  assert.equal(previewReassign.assignees[0].count, 1);

  const reassigned = await inject("POST", "/v1/internal/crm/leads/reassign", {
    manager: true,
    actor_email: "manager@example.test",
    dry_run: false,
    assignees: ["one@example.test"],
    selection: { mode: "explicit", ids: ["lead_1"] }
  });
  assert.equal(reassigned.total, 1);
  const afterReassign = await inject("POST", "/v1/internal/crm/leads/query", {
    manager: true,
    filters: { assigned_to_email: "one@example.test" }
  });
  assert.equal(afterReassign.total, 1);
});

test("CRM lead imports preview duplicates and commit from stored import batch", async () => {
  await ensureLeadDatabase();
  const labelPreview = await inject("POST", "/v1/internal/crm/leads/imports/preview", {
    actor_email: "manager@example.test",
    rows: [
      {
        "Lead ID": "lead_1",
        Company: "Acme Roofing",
        Email: "acme@example.test",
        Phone: "555-9999",
        Status: "new",
        Region: "Washington",
        "Region Code": "WA",
        "Assigned To": "one@example.test",
        Website: "https://acme.test",
        "Priority Band": "Low",
        "Most Recent Call": "2026-02-02T08:06:40.000Z"
      }
    ]
  });
  assert.equal(labelPreview.summary.unchanged_count, 1);
  assert.equal(labelPreview.summary.duplicate_count, 0);

  const changedDuplicate = await inject("POST", "/v1/internal/crm/leads/imports/preview", {
    actor_email: "manager@example.test",
    rows: [
      {
        "Lead ID": "lead_2",
        Company: "Beta Roofing",
        Phone: "555-2222",
        Status: "called_again"
      }
    ]
  });
  assert.equal(changedDuplicate.summary.duplicate_count, 1);
  const changedCommitted = await inject("POST", `/v1/internal/crm/leads/imports/${changedDuplicate.import_id}/commit`, {
    actor_email: "manager@example.test",
    duplicate_action: "update"
  });
  assert.equal(changedCommitted.counts.updated, 1);
  const changedPage = await inject("POST", "/v1/internal/crm/leads/query", {
    manager: true,
    filters: { status: "called_again" }
  });
  assert.equal(changedPage.total, 1);
  assert.equal(changedPage.leads[0].id, "lead_2");

  const preview = await inject("POST", "/v1/internal/crm/leads/imports/preview", {
    actor_email: "manager@example.test",
    rows: [
      { company: "Acme Roofing", email: "acme@example.test", phone: "555-1111", external_key: "ext_1" },
      { company: "Charlie Roofing", email: "charlie@example.test", phone: "555-3333", region_code: "OR" }
    ]
  });
  assert.equal(preview.summary.duplicate_count, 1);
  assert.equal(preview.summary.new_count, 1);
  assert.ok(preview.import_id);

  const committed = await inject("POST", `/v1/internal/crm/leads/imports/${preview.import_id}/commit`, {
    actor_email: "manager@example.test",
    default_action: "skip"
  });
  assert.equal(committed.counts.created, 1);
  assert.equal(committed.counts.skipped, 1);

  const page = await inject("POST", "/v1/internal/crm/leads/query", {
    manager: true,
    q: "Charlie",
    per_page: 10
  });
  assert.equal(page.total, 1);
  assert.equal(page.leads[0].company, "Charlie Roofing");
});

test("global lead dialer does not accept anonymous caller-supplied staff identity", async () => {
  for (const url of ["/v1/internal/crm/calls/queue", "/v1/internal/crm/calls/fixture/disposition"]) {
    const response = await app.inject({ method: "POST", url, payload: { actor_email: "admin@example.test", disposition: "answered" } });
    assert.equal(response.statusCode, 401);
  }
  const { callQueue, recordLeadCall } = await import("../internal/crm/leads.js");
  const queue = await callQueue({ actor_email: "fixture@example.test" });
  assert.equal(queue.columns.length, 3);
  await assert.rejects(recordLeadCall("fixture", { disposition: "invalid" }), /valid call disposition/);
});
