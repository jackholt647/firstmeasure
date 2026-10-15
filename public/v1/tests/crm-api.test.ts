import { nextTestPhone, closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";


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
  const { upsertProjectWithContacts } = await import("./helpers/project-contacts.js");
  await upsertProjectWithContacts(orgId, {
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
  const defaults = await inject("GET", `/v1/call-lists/organizations/${orgId}/call-lists`);
  assert.equal(defaults.call_lists.length, 0);

  // An opportunity opening (its sales plan starting) queues the first call through
  // the default organization automation rule, creating New Leads on demand with a
  // project-keyed entry.
  const { ensurePipelinePlanForProject } = await import("../scopes/router.js");
  await ensurePipelinePlanForProject(orgId, { id: projectId, ...(await platformStorage.readDocument(orgId, "projects", projectId)).data });
  await (await import("../work/engine.js")).drainWorkEvents();
  const seeded = await inject("GET", `/v1/call-lists/organizations/${orgId}/call-lists`);
  const newLeads = seeded.call_lists.find((list: any) => list.key === "new_leads");
  assert.ok(newLeads, "the intake rule created the New Leads list");
  assert.equal(newLeads.pending_count, 1);

  const created = await inject("POST", `/v1/call-lists/organizations/${orgId}/call-lists`, {
    key: "mid_project_checkin",
    title: "Mid-project Check-ins",
    kind: "production",
    assigned_role_ids: ["production"],
    metadata: { cadence: "halfway" }
  });
  assert.equal(created.call_list.key, "mid_project_checkin");
  assert.deepEqual(created.call_list.assigned_role_ids, ["production"]);

  const first = await inject("POST", `/v1/call-lists/organizations/${orgId}/call-lists/mid_project_checkin/entries`, {
    source_key: "work_node_1",
    project_id: projectId,
    work_plan_id: "work_plan_1",
    title: "Halfway check-in"
  });
  const duplicate = await inject("POST", `/v1/call-lists/organizations/${orgId}/call-lists/mid_project_checkin/entries`, {
    source_key: "work_node_1",
    project_id: projectId,
    title: "Updated halfway check-in"
  });
  assert.equal(duplicate.entry.id, first.entry.id);

  const hidden = await inject("POST", `/v1/call-lists/organizations/${orgId}/call-lists/queue`, { role_ids: ["office"] });
  assert.ok(hidden.columns.some((column: any) => column.key === "mid_project_checkin"), 'server uses the authenticated owner permissions, not client-supplied roles');
  const queue = await inject("POST", `/v1/call-lists/organizations/${orgId}/call-lists/queue`, { role_ids: ["production"] });
  const productionList = queue.columns.find((column: any) => column.key === "mid_project_checkin");
  assert.equal(productionList.tasks.length, 1);
  assert.equal(productionList.tasks[0].name, "Alex Smith");
  assert.equal(productionList.tasks[0].title, "Updated halfway check-in");

  const disposition = await inject("POST", `/v1/call-lists/organizations/${orgId}/call-list-entries/${first.entry.id}/disposition`, {
    actor_email: "caller@example.test",
    actor_name: "Casey Caller",
    disposition: "answered",
    outcome: "check_in_complete",
    note_text: "Everything is on track."
  });
  const after = await inject("POST", `/v1/call-lists/organizations/${orgId}/call-lists/queue`, { role_ids: ["production"] });
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

