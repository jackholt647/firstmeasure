import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Customer portal v2 — docs/customer-portal-v2-spec.md
 *
 * Covers the four foundations: portal settings resolution (§5), audience
 * targeting (§3) including the direct page-fetch re-check (§3.3), and
 * server-driven tab descriptors (§2) with their mandatory legacy-parity
 * guarantee.
 */

let app: any = null;
let storageRoot = "";

type Json = Record<string, any>;

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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-portal-v2-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  if (!appSource.includes("registerWebsitesApi")) {
    const { registerWebsitesApi } = await import("../websites/api.js");
    await app.register(registerWebsitesApi, { prefix: "/v1/websites" });
  }
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

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Portal V2 Test Org",
    organization_id: `org_portal_v2_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

async function seedProject(orgId: string, id: string, data: Json = {}) {
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id,
    data: { branch_id: "default", title: `${id} Project`, address: `${id} Address`, ...data },
    metadata: { kind: "project" }
  }, { replace: true });
}

async function portalFor(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  const result = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`);
  return result.portal as Json;
}

// ---------------------------------------------------------------------------
// §5 — Portal settings resolution (pure unit; no app boot needed)
// ---------------------------------------------------------------------------

test("portal settings default-deny every customer-write surface", async () => {
  const { normalizePortalSettings, portalHasCustomerWrites } = await import("../platform/portal_settings.js");
  const settings = normalizePortalSettings(undefined, undefined);

  assert.equal(settings.uploads.photos, false);
  assert.equal(settings.uploads.documents, false);
  assert.equal(settings.comments.photos, false);
  assert.equal(settings.punch_list.enabled, false);
  assert.equal(settings.upsells.enabled, false);
  assert.equal(settings.messaging.enabled, false);
  assert.equal(settings.sharing.enabled, false);
  assert.equal(portalHasCustomerWrites(settings), false);
  // Completion signature is the one default-ON flag: it tightens rather than
  // loosens, so it cannot open a surface that was previously closed.
  assert.equal(settings.completion.signature_required, true);
});

test("project settings override org defaults, including turning a flag back off", async () => {
  const { normalizePortalSettings } = await import("../platform/portal_settings.js");

  const orgOn = normalizePortalSettings({ uploads: { photos: true } }, undefined);
  assert.equal(orgOn.uploads.photos, true, "org default should enable uploads");

  // The tri-state read is what makes this work: an explicit `false` on the
  // project must beat an org default of `true`.
  const projectOff = normalizePortalSettings({ uploads: { photos: true } }, { uploads: { photos: false } });
  assert.equal(projectOff.uploads.photos, false, "explicit project false must win over org true");

  const projectOn = normalizePortalSettings({ uploads: { photos: false } }, { uploads: { photos: true } });
  assert.equal(projectOn.uploads.photos, true);
});

test("portal settings clamp numeric limits to their hard ceilings", async () => {
  const {
    normalizePortalSettings,
    PORTAL_MAX_UPLOAD_BYTES,
    PORTAL_MAX_UPLOADS_PER_DAY,
    PORTAL_MAX_PUNCH_ITEMS,
    PORTAL_MAX_GUEST_LINKS
  } = await import("../platform/portal_settings.js");

  const greedy = normalizePortalSettings(undefined, {
    uploads: { photos: true, max_bytes: 5_000_000_000, max_files: 100_000 },
    punch_list: { enabled: true, max_items: 9999 },
    sharing: { enabled: true, max_guests: 500 }
  });

  assert.equal(greedy.uploads.max_bytes, PORTAL_MAX_UPLOAD_BYTES, "upload size must clamp to the ceiling");
  assert.equal(greedy.uploads.max_files, PORTAL_MAX_UPLOADS_PER_DAY);
  assert.equal(greedy.punch_list.max_items, PORTAL_MAX_PUNCH_ITEMS);
  assert.equal(greedy.sharing.max_guests, PORTAL_MAX_GUEST_LINKS);

  // Lowering below the ceiling is always allowed.
  const modest = normalizePortalSettings(undefined, { uploads: { photos: true, max_bytes: 1024 * 1024 } });
  assert.equal(modest.uploads.max_bytes, 1024 * 1024);
});

test("punch-list and upsell sub-flags collapse when the parent is off", async () => {
  const { normalizePortalSettings } = await import("../platform/portal_settings.js");
  const settings = normalizePortalSettings(undefined, {
    punch_list: { enabled: false, customer_can_add: true, require_signoff: true },
    upsells: { enabled: false, require_signature: true, auto_accept_under_cents: 50_000 }
  });

  // Callers read one field instead of remembering to && the parent every time.
  assert.equal(settings.punch_list.customer_can_add, false);
  assert.equal(settings.punch_list.require_signoff, false);
  assert.equal(settings.upsells.require_signature, false);
  assert.equal(settings.upsells.auto_accept_under_cents, 0);
});

test("public settings projection carries no internal-only fields", async () => {
  const { normalizePortalSettings, publicPortalSettings } = await import("../platform/portal_settings.js");
  const projection = publicPortalSettings(normalizePortalSettings(undefined, { upsells: { enabled: true, auto_accept_under_cents: 5000 } }));

  // auto_accept_under_cents is a server-side pricing decision; exposing it would
  // tell a customer exactly what threshold to stay under.
  assert.equal((projection.upsells as Json).auto_accept_under_cents, undefined);
  assert.equal((projection.upsells as Json).enabled, true);
});

// ---------------------------------------------------------------------------
// §3 — Audience facts
// ---------------------------------------------------------------------------

test("project audience facts lowercase tags and survive a missing work database", async () => {
  const { projectAudienceFacts } = await import("../platform/portal_audience.js");
  const facts = (await projectAudienceFacts("org_missing", {
    id: "project_missing",
    tags: ["Commercial", "ROOFING", "commercial"],
    status: "Active",
    custom_fields: { roof_type: "Shingle" }
  }));

  assert.deepEqual(facts.tag_ids, ["commercial", "roofing"], "tags lowercase + dedupe");
  assert.equal(facts.status, "active");
  assert.equal(facts.custom_fields.roof_type, "Shingle");
  assert.ok(Array.isArray(facts.scope_template_ids));
});

// ---------------------------------------------------------------------------
// §2 — Server-driven tab descriptors
// ---------------------------------------------------------------------------

test("portal payload serves tab descriptors matching the legacy order", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await seedProject(orgId, "proj_tabs_basic");
  const portal = await portalFor(client, orgId, "proj_tabs_basic");

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.ok(Array.isArray(payload.tabs), "payload must carry tab descriptors");

  const ids = payload.tabs.map((tab: Json) => tab.id);
  // Legacy-proposal retirement: the Proposals tab is now conditional on actual
  // legacy proposals (or a scope that will produce them). A bare project shows
  // only the portal spine.
  assert.deepEqual(ids, ["summary", "schedule", "photos", "payments"]);

  for (const tab of payload.tabs) {
    assert.equal(tab.kind, "system");
    assert.ok(tab.label, "every tab needs a label");
    assert.ok(Number.isFinite(tab.order), "every tab needs a sortable order");
  }
});

test("portal payload carries a client-safe settings projection", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await seedProject(orgId, "proj_tabs_settings");
  const portal = await portalFor(client, orgId, "proj_tabs_settings");

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.ok(payload.settings, "payload must carry resolved settings");
  assert.equal(payload.settings.uploads.photos, false, "writes stay off until an org opts in");
  assert.equal(payload.settings.sharing.enabled, false);
});

test("guest links are hashed, scoped, read-only, revocable, and never expose owner or payment credentials", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await seedProject(orgId, "proj_guest_secure", {
    contact_id: "contact_guest_secure",
    contacts: [{ id:"contact_guest_secure", primary:true, name:"Taylor Customer", email:"taylor@example.test", phone:"5551234567" }],
    proposals: [{ id:"proposal_secret", title:"Private proposal", status:"sent", public_token:"proposal-payment-secret" }]
  });
  const portal = await portalFor(client, orgId, "proj_guest_secure");
  await seedProject(orgId, "proj_guest_sibling", {
    contact_id: "contact_guest_secure",
    contacts: [{ id:"contact_guest_secure", primary:true, name:"Taylor Customer", email:"taylor@example.test" }]
  });
  await portalFor(client, orgId, "proj_guest_sibling");

  const disabled = await client.raw("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, {
    label:"Spouse", preset:"full_view", expires_days:30
  });
  assert.equal(disabled.statusCode, 403, "customer sharing stays default-deny until staff enables it");

  await client.request("PATCH", `/v1/platform/organizations/${orgId}/projects/proj_guest_secure/customer-portal`, {
    settings: { ...(portal.settings || {}), sharing:{ enabled:true, max_guests:5, default_expires_days:30 } }
  });
  const created = await client.request("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, {
    label:"Alex — spouse", preset:"full_view", expires_days:0
  });
  assert.equal(created.share.expires_at, "", "a shared link may explicitly never expire");
  assert.deepEqual(created.share.project_ids, ["proj_guest_secure"], "omitting project scope defaults to only the current project");
  assert.match(created.url, /customer_portal\/\?id=psg_/, "recipient receives a distinct bearer link");
  const guestToken = new URL(created.url).searchParams.get("id") || "";
  assert.match(guestToken, /^psg_[A-Za-z0-9_-]{40,}$/);

  const { readDocument, upsertDocument } = await import("../platform/storage.js");
  const stored = await readDocument(orgId, "customer_portals", "customer_portal_proj_guest_secure");
  const storedText = JSON.stringify(stored);
  assert.equal(storedText.includes(guestToken), false, "the usable guest token must never be stored");
  assert.match(storedText, /"token_hash":"[a-f0-9]{64}"/, "guest lookup retains a one-way token hash");
  assert.match(storedText, /"token_ciphertext":"enc:v1:/, "the reusable link secret is authenticated-encrypted at rest");

  const guest = await client.request("GET", `/v1/platform/customer-portals/${guestToken}`);
  const guestText = JSON.stringify(guest);
  assert.equal(guest.access.mode, "guest");
  assert.equal(guest.access.read_only, true);
  assert.equal(guest.access.can_pay, false);
  assert.equal(guest.access.can_sign, false);
  assert.equal(guest.access.can_share, false);
  assert.deepEqual(guest.tabs.map((tab:Json) => tab.id), ["summary", "schedule", "photos"], "only safe relevant tabs survive the preset intersection");
  assert.equal(guestText.includes("proposal-payment-secret"), false, "proposal/payment bearer tokens must be absent");
  assert.equal(guestText.includes(portal.public_uuid), false, "the owner portal credential must not leak to a guest");
  assert.equal(guestText.includes(portal.preview_uuid), false, "the staff preview credential must not leak to a guest");
  assert.equal(guestText.includes("taylor@example.test"), false, "guest projections minimize customer contact data");
  assert.equal(guest.settings.uploads.photos, false);
  assert.equal(guest.settings.comments.photos, false);
  assert.equal(guest.chat, null);
  assert.equal(guest.feedback, null);

  const guestCreate = await client.raw("POST", `/v1/platform/customer-portals/${guestToken}/shares`, { label:"Backdoor" });
  assert.equal(guestCreate.statusCode, 403, "guest links cannot create more links");

  const ownerListing = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}/shares`);
  assert.equal(ownerListing.shares.length, 1);
  assert.equal(JSON.stringify(ownerListing).includes("token_hash"), false, "share management responses never expose stored hashes");
  assert.equal(JSON.stringify(ownerListing).includes("token_ciphertext"), false, "share management responses never expose encrypted storage fields");
  assert.equal(ownerListing.shares[0].url, created.url, "owners can copy an existing shared link again");

  const legacy = await client.request("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, {
    label:"Legacy recipient", preset:"photos_only", expires_days:0
  });
  const legacyToken = new URL(legacy.url).searchParams.get("id") || "";
  const beforeMigration = await readDocument(orgId, "customer_portals", "customer_portal_proj_guest_secure");
  const beforeMigrationData = { ...(beforeMigration.data as Json) };
  beforeMigrationData.guest_links = (beforeMigrationData.guest_links as Json[]).map((link) =>
    link.id === legacy.share.id ? { ...link, token_ciphertext:"" } : link
  );
  await upsertDocument(orgId, "customer_portals", {
    id: beforeMigration.id,
    data: beforeMigrationData,
    metadata: beforeMigration.metadata
  }, { replace:true });
  const migratedListing = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}/shares`);
  const migratedLegacy = migratedListing.shares.find((share:Json) => share.id === legacy.share.id);
  assert.match(migratedLegacy.url, /customer_portal\/\?id=psg_/, "legacy links transparently gain a copyable management URL");
  assert.notEqual(migratedLegacy.url, legacy.url, "legacy migration mints a recoverable alias instead of pretending to know the old secret");
  await client.request("GET", `/v1/platform/customer-portals/${legacyToken}`);
  await client.request("GET", `/v1/platform/customer-portals/${new URL(migratedLegacy.url).searchParams.get("id")}`);

  for (let index = 0; index < 5; index += 1) {
    await client.request("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, {
      label:`Additional recipient ${index + 1}`, preset:"photos_only", expires_days:0
    });
  }
  const unlimitedListing = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}/shares`);
  assert.equal(unlimitedListing.shares.filter((share:Json) => share.status === "active").length, 7, "shared links have no arbitrary active-link cap");

  await client.request("DELETE", `/v1/platform/customer-portals/${portal.public_uuid}/shares/${created.share.id}`);
  const revoked = await client.raw("GET", `/v1/platform/customer-portals/${guestToken}`);
  assert.equal(revoked.statusCode, 403, "revocation is enforced on the next request");
  assert.match(revoked.body, /expired or been revoked/i);

  const updates = await client.request("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, {
    label:"Project updates", preset:"project_updates", expires_days:7
  });
  const updatesToken = new URL(updates.url).searchParams.get("id") || "";
  const updatesGuest = await client.request("GET", `/v1/platform/customer-portals/${updatesToken}`);
  assert.deepEqual(updatesGuest.tabs.map((tab:Json) => tab.id), ["schedule", "photos"], "project updates excludes the full overview and checklists");
  await client.request("DELETE", `/v1/platform/customer-portals/${portal.public_uuid}/shares/${updates.share.id}`);
});

test("org tab config renames, reorders, and hides blessed tabs", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.web_editor": true }
  });
  await seedProject(orgId, "proj_tab_config");
  const portal = await portalFor(client, orgId, "proj_tab_config");

  const listing = await client.request("GET", `/v1/websites/organizations/${orgId}/sites`);
  const portalSite = listing.sites.find((site: Json) => site.site_kind === "customer_portal");
  assert.ok(portalSite, "org should have a seeded customer_portal site");

  await client.request("PATCH", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}`, {
    settings: {
      ...(portalSite.settings || {}),
      portal_tabs: {
        photos: { label: "Job Photos", order: 5 },
        proposals: { enabled: false }
      }
    }
  });

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  const ids = payload.tabs.map((tab: Json) => tab.id);
  const photos = payload.tabs.find((tab: Json) => tab.id === "photos");

  assert.equal(photos.label, "Job Photos", "label override should apply");
  assert.equal(ids.includes("proposals"), false, "enabled:false should drop the tab");
  assert.equal(ids[0], "photos", "order override should re-sort the list");
});

test("unknown keys in tab config cannot inject tabs", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.web_editor": true }
  });
  await seedProject(orgId, "proj_tab_inject");
  const portal = await portalFor(client, orgId, "proj_tab_inject");

  const listing = await client.request("GET", `/v1/websites/organizations/${orgId}/sites`);
  const portalSite = listing.sites.find((site: Json) => site.site_kind === "customer_portal");
  await client.request("PATCH", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}`, {
    settings: {
      ...(portalSite.settings || {}),
      portal_tabs: { admin_backdoor: { label: "Admin", order: 1, enabled: true } }
    }
  });

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  const ids = payload.tabs.map((tab: Json) => tab.id);
  assert.equal(ids.includes("admin_backdoor"), false, "config may only adjust known tabs, never add one");
});

// ---------------------------------------------------------------------------
// §3.3 — Audience enforcement, including the directly-addressable page route
// ---------------------------------------------------------------------------

test("targeted portal pages are filtered by project audience on both routes", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.web_editor": true }
  });

  await seedProject(orgId, "proj_roofing", { tags: ["Roofing"] });
  await seedProject(orgId, "proj_siding", { tags: ["Siding"] });
  const roofingPortal = await portalFor(client, orgId, "proj_roofing");
  const sidingPortal = await portalFor(client, orgId, "proj_siding");

  const listing = await client.request("GET", `/v1/websites/organizations/${orgId}/sites`);
  const portalSite = listing.sites.find((site: Json) => site.site_kind === "customer_portal");

  const created = await client.request("POST", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages`, {
    title: "Roof Care"
  });
  const pageId = created.page.id as string;

  // A newly created page already carries a valid starter view draft; publish it
  // as-is rather than hand-rolling a definition the validator would reject.
  await client.request("POST", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages/${pageId}/publish`, {});
  await client.request("PATCH", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages/${pageId}`, {
    enabled: true,
    nav: { header: true, order: 1 },
    audience: { match: "any", tag_ids: ["roofing"] }
  });

  // Tab list: present for the roofing project, absent for siding.
  const roofingPayload = await client.request("GET", `/v1/platform/customer-portals/${roofingPortal.public_uuid}`);
  const sidingPayload = await client.request("GET", `/v1/platform/customer-portals/${sidingPortal.public_uuid}`);
  const roofingIds = roofingPayload.tabs.map((tab: Json) => tab.id);
  const sidingIds = sidingPayload.tabs.map((tab: Json) => tab.id);

  assert.ok(roofingIds.some((id: string) => id.startsWith("page:")), "roofing project should see the targeted page");
  assert.equal(sidingIds.some((id: string) => id.startsWith("page:")), false, "siding project must not see it");

  // Audience rules themselves must never reach the client.
  assert.equal(JSON.stringify(roofingPayload.portal_pages).includes("audience"), false);

  // The page-fetch route is separately addressable: filtering the tab list is
  // NOT sufficient. Guessing the page id must still 404 for the wrong project.
  const allowed = await client.raw("GET", `/v1/websites/public/portal/${roofingPortal.public_uuid}/pages/${pageId}`);
  assert.equal(allowed.statusCode, 200, "targeted project can fetch the page directly");

  const denied = await client.raw("GET", `/v1/websites/public/portal/${sidingPortal.public_uuid}/pages/${pageId}`);
  assert.equal(denied.statusCode, 404, "non-targeted project must 404 on the direct page route");
});

test("untargeted pages stay visible to every project", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.web_editor": true }
  });
  await seedProject(orgId, "proj_any", { tags: ["Whatever"] });
  const portal = await portalFor(client, orgId, "proj_any");

  const listing = await client.request("GET", `/v1/websites/organizations/${orgId}/sites`);
  const portalSite = listing.sites.find((site: Json) => site.site_kind === "customer_portal");
  const created = await client.request("POST", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages`, {
    title: "Welcome"
  });
  const pageId = created.page.id as string;
  // A newly created page already carries a valid starter view draft; publish it
  // as-is rather than hand-rolling a definition the validator would reject.
  await client.request("POST", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages/${pageId}/publish`, {});
  await client.request("PATCH", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages/${pageId}`, {
    enabled: true,
    nav: { header: true, order: 1 }
  });

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  const ids = payload.tabs.map((tab: Json) => tab.id);
  assert.ok(ids.includes("page:welcome"), `expected page:welcome in ${JSON.stringify(ids)}`);
  // Custom pages sort after the blessed band by default.
  assert.equal(ids[ids.length - 1], "page:welcome");
});

// ---------------------------------------------------------------------------
// §7 — Customer-visible activity events (default-deny)
// ---------------------------------------------------------------------------

test("only events with an explicit customer descriptor are customer-visible", async () => {
  const { workEventCustomerDescriptor } = await import("../work/events.js");

  // Registered + explicitly customer-facing.
  assert.ok(workEventCustomerDescriptor("payment.received"), "payment.received should be customer-visible");

  // Registered, human-relevant internally, but NOT customer-facing. This is the
  // distinction the `customer` block exists to make: "activity" visibility is
  // about the internal timeline, not the portal.
  assert.equal(workEventCustomerDescriptor("payroll.batch.paid"), null);
  assert.equal(workEventCustomerDescriptor("expense.recorded"), null);

  // Unregistered events can never be customer-visible, however they are named.
  assert.equal(workEventCustomerDescriptor("payment.received.internal_margin"), null);
  assert.equal(workEventCustomerDescriptor("totally.made.up"), null);
});

test("customer event labels interpolate only allowlisted payload keys", async () => {
  const { registerWorkEvents, renderCustomerEventLabel } = await import("../work/events.js");

  registerWorkEvents([{
    name: "test.portal.label_guard",
    description: "Fixture for label interpolation.",
    visibility: "activity",
    customer: { label: "Delivered {item} on {when} {secret}", fields: ["item"] }
  }]);

  const rendered = renderCustomerEventLabel("test.portal.label_guard", {
    item: "shingles",
    when: "2026-07-01",
    secret: "margin=42%"
  });

  assert.ok(rendered.includes("shingles"), "allowlisted key should interpolate");
  assert.equal(rendered.includes("2026-07-01"), false, "non-allowlisted key must not render");
  assert.equal(rendered.includes("margin"), false, "non-allowlisted key must not leak");
});

test("a malformed customer block does not make an event customer-visible", async () => {
  const { registerWorkEvents, workEventCustomerDescriptor } = await import("../work/events.js");
  registerWorkEvents([
    { name: "test.portal.empty_label", description: "", visibility: "activity", customer: { label: "   " } },
    { name: "test.portal.truthy_junk", description: "", visibility: "activity", customer: true as any }
  ]);

  assert.equal(workEventCustomerDescriptor("test.portal.empty_label"), null);
  assert.equal(workEventCustomerDescriptor("test.portal.truthy_junk"), null);
});

// ---------------------------------------------------------------------------
// §6 — portal.* widget resolvers
// ---------------------------------------------------------------------------

test("portal.* resolvers return null without portal context", async () => {
  await import("../platform/portal_widgets.js");
  const { documentWidgetResolver } = await import("../documents/widgets/registry.js");

  const services = {
    pricebook: {},
    payments: { listProjectObligations: async () => [], listProjectPayments: async () => [] },
    media: {
      readMediaMetadata: async () => ({}),
      fileUrl: () => "",
      readMediaFile: async () => ({ contentType: "", bytes: Buffer.alloc(0) })
    },
    platform: { readDocument: async () => ({}), listDocuments: async () => [] }
  } as any;

  // This is the guard that keeps project data off public marketing pages: the
  // websites resolver path passes portal: null for any non-portal render.
  const publicSiteCtx = {
    organizationId: "org_x",
    document: {},
    params: {},
    project: null,
    portal: null,
    services
  } as any;

  for (const id of ["portal.activity_feed", "portal.reviews", "portal.team", "portal.portfolio", "portal.nearby_jobs", "portal.recurring"]) {
    const resolver = documentWidgetResolver(id);
    assert.ok(resolver, `${id} should be registered`);
    assert.equal(await resolver!(publicSiteCtx, {}), null, `${id} must return null without portal context`);
  }
});

test("portal.welcome_video resolves from config alone and needs no project", async () => {
  await import("../platform/portal_widgets.js");
  const { documentWidgetResolver } = await import("../documents/widgets/registry.js");
  const resolver = documentWidgetResolver("portal.welcome_video");
  assert.ok(resolver);

  const services = {
    pricebook: {},
    payments: { listProjectObligations: async () => [], listProjectPayments: async () => [] },
    media: {
      readMediaMetadata: async () => ({ content_type: "video/mp4" }),
      fileUrl: (orgId: string, mediaId: string) => `/media/${orgId}/${mediaId}`,
      readMediaFile: async () => ({ contentType: "video/mp4", bytes: Buffer.alloc(0) })
    },
    platform: { readDocument: async () => ({}), listDocuments: async () => [] }
  } as any;
  const ctx = { organizationId: "org_x", document: {}, params: {}, project: null, portal: null, services } as any;

  assert.equal(await resolver!(ctx, {}), null, "no media id configured means nothing to show");
  const resolved: any = await resolver!(ctx, { media_id: "media_1" });
  assert.equal(resolved.url, "/media/org_x/media_1");
  const selected: any = await resolver!(ctx, { media: { media_id: "media_2", variant: "original" } });
  assert.equal(selected.media_id, "media_2", "the editor's structured media picker contract is supported");
});

test("portal widgets honor manual configuration and use portal-safe media URLs", async () => {
  await import("../platform/portal_widgets.js");
  const { documentWidgetResolver } = await import("../documents/widgets/registry.js");
  const services = {
    pricebook: {},
    payments: { listProjectObligations: async () => [], listProjectPayments: async () => [] },
    media: {
      readMediaMetadata: async () => ({ content_type: "image/jpeg" }),
      fileUrl: () => "/private-media-url",
      readMediaFile: async () => ({ contentType: "image/jpeg", bytes: Buffer.from("thumbnail") })
    },
    platform: { readDocument: async () => ({}), listDocuments: async () => [] }
  } as any;
  const ctx = {
    organizationId: "org_x",
    document: {},
    params: {},
    project: { id: "project_current" },
    portal: { portal_uuid: "portal_public", project_id: "project_current", preview: false },
    services
  } as any;

  const activity: any = await documentWidgetResolver("portal.activity_feed")!(ctx, {
    source_mode: "manual",
    manual_entries: [{ title: "Roof complete", detail: "Final cleanup is next.", occurred_at: "2026-07-20" }]
  });
  assert.equal(activity.entries[0].label, "Roof complete");
  assert.equal(activity.entries[0].detail, "Final cleanup is next.");

  const team: any = await documentWidgetResolver("portal.team")!(ctx, {
    source_mode: "manual",
    manual_members: [{ name: "Alex", role: "Project manager", bio: "Your day-to-day contact.", photo: { media_id: "portrait_1" } }]
  });
  assert.equal(team.members[0].name, "Alex");
  assert.match(team.members[0].avatar_url, /customer-portals\/portal_public\/media\/portrait_1\/file/);

  const portfolio: any = await documentWidgetResolver("portal.portfolio")!(ctx, {
    source_mode: "manual",
    manual_pairs: [{ label: "Front elevation", before: { media_id: "before_1" }, after: { media_id: "after_1" } }]
  });
  assert.equal(portfolio.pairs[0].label, "Front elevation");
  assert.match(portfolio.pairs[0].before_url, /before_1/);
  assert.match(portfolio.pairs[0].after_url, /after_1/);
});

test("nearby jobs fail closed and expose only opted-in, coarse project locations", async () => {
  await import("../platform/portal_widgets.js");
  const { documentWidgetResolver } = await import("../documents/widgets/registry.js");
  const services = {
    pricebook: {},
    payments: { listProjectObligations: async () => [], listProjectPayments: async () => [] },
    media: {
      readMediaMetadata: async () => ({}),
      fileUrl: () => "/private-media-url",
      readMediaFile: async () => ({ contentType: "image/jpeg", bytes: Buffer.from("thumbnail") })
    },
    platform: {
      readDocument: async () => ({}),
      listDocuments: async (_orgId: string, collection: string) => collection === "customer_portals"
        ? [{ data: { project_id: "near_1", shared_items: [{ type: "media", item_id: "photo_1" }] } }]
        : [
            { id: "near_1", data: { showcase_opt_in: true, showcase_title: "Kitchen remodel", project_type: "remodel", status: "complete", latitude: 34.05789, longitude: -118.24789, address: "123 Private St, Los Angeles, CA" } },
            { id: "private_1", data: { showcase_opt_in: false, latitude: 34.06, longitude: -118.25 } }
          ]
    }
  } as any;
  const ctx = {
    organizationId: "org_x",
    document: {},
    params: {},
    project: { id: "current", latitude: 34.05, longitude: -118.25 },
    portal: { portal_uuid: "portal_public", project_id: "current", preview: false },
    services
  } as any;
  const resolved: any = await documentWidgetResolver("portal.nearby_jobs")!(ctx, { radius_miles: 10 });
  assert.equal(resolved.jobs.length, 1);
  assert.equal(resolved.jobs[0].lat, 34.06);
  assert.equal(resolved.jobs[0].lng, -118.25);
  assert.equal(JSON.stringify(resolved).includes("123 Private St"), false, "street addresses must never leave the resolver");
  assert.match(resolved.jobs[0].thumbnail_url, /^data:image\/jpeg;base64,/);
  assert.equal(JSON.stringify(resolved).includes("portal_public"), false, "nearby cards must not reveal a different portal route or identifier");
});

// ---------------------------------------------------------------------------
// §8.7 — Live chat handoff
// ---------------------------------------------------------------------------

test("portal chat handoff is absent until live chat is enabled", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await seedProject(orgId, "proj_chat_off");
  const portal = await portalFor(client, orgId, "proj_chat_off");

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.equal(payload.chat, null, "no chat block without the capability");
});

test("portal chat handoff mints a verifiable grant and never appears in preview", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.live_chat": true }
  });
  await seedProject(orgId, "proj_chat_on");
  const portal = await portalFor(client, orgId, "proj_chat_on");

  const settingsUrl = `/v1/chat/organizations/${orgId}/branch/default/chat/settings`;
  const initial = await client.request("GET", settingsUrl);
  await client.request("PUT", settingsUrl, {
    data: { ...initial.settings, enabled: true, portal: { enabled: true } }
  });

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.ok(payload.chat, "live portal should carry a chat handoff");
  assert.ok(payload.chat.widget_key, "handoff needs a widget key");
  assert.match(payload.chat.portal_grant, /^pg\./, "grant uses the pg. envelope the chat service verifies");

  // The grant must actually validate against the chat service — a malformed
  // mint would fail open as an anonymous visitor rather than loudly.
  const session = await client.request("POST", `/v1/chat/public/widgets/${payload.chat.widget_key}/sessions`, {
    page_url: "https://example.test/portal",
    portal_grant: payload.chat.portal_grant
  });
  assert.ok(session.visitor_token, "grant should establish a visitor session");

  // Preview is a staff affordance: starting a real customer conversation from it
  // would drop a staff member into the customer's thread.
  const previewPayload = await client.request("GET", `/v1/platform/customer-portals/preview/${portal.preview_uuid}`);
  assert.equal(previewPayload.chat, null, "preview portals must not mint grants");
});

test("portal.team never shows a permission slug as a job title", async () => {
  await import("../platform/portal_widgets.js");
  const { documentWidgetResolver } = await import("../documents/widgets/registry.js");
  const resolver = documentWidgetResolver("portal.team");
  assert.ok(resolver);

  const users: Record<string, Json> = {
    u_admin: { name: "Jordan Vance", role: "super_admin" },
    u_viewer: { name: "Riley Cho", role: "viewer" },
    u_titled: { name: "Sam Ortiz", title: "Lead Estimator", role: "custom" }
  };
  const services = {
    pricebook: {},
    payments: { listProjectObligations: async () => [], listProjectPayments: async () => [] },
    media: { readMediaMetadata: async () => ({}), fileUrl: () => "", readMediaFile: async () => ({ contentType: "", bytes: Buffer.alloc(0) }) },
    platform: {
      readDocument: async (_org: string, _collection: string, id: string) => ({ id, data: users[id] || {} }),
      listDocuments: async () => []
    }
  } as any;

  const ctx = {
    organizationId: "org_x",
    document: {},
    params: {},
    project: { id: "p1", events: [{ assigned_user_ids: ["u_admin", "u_viewer", "u_titled"] }] },
    portal: { portal_uuid: "u", project_id: "p1", contact_id: "c", preview: false, settings: {} },
    services
  } as any;

  const resolved: any = await resolver!(ctx, {});
  const byName = Object.fromEntries(resolved.members.map((m: Json) => [m.name, m.role]));

  // Access levels are internal structure and mean nothing to a customer.
  assert.equal(byName["Jordan Vance"], "", "super_admin must not surface as a title");
  assert.equal(byName["Riley Cho"], "", "viewer must not surface as a title");
  // A real job title is exactly what this widget is for.
  assert.equal(byName["Sam Ortiz"], "Lead Estimator");
});
