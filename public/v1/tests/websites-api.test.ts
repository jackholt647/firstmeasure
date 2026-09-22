import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-websites-test-"));
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
    company: "Websites Test Org",
    organization_id: `org_websites_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

async function setCapabilities(client: ReturnType<typeof createSessionClient>, orgId: string, values: Record<string, unknown>) {
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values });
}

/** Registers an org with the web editor on and returns the two seeded sites. */
async function setupOrg(client: ReturnType<typeof createSessionClient>) {
  const { orgId } = await registerOrg(client);
  await setCapabilities(client, orgId, { "apps.web_editor": true });
  const listing = await client.request("GET", `/v1/websites/organizations/${orgId}/sites`);
  const publicSite = listing.sites.find((site: any) => site.site_kind === "public");
  const portalSite = listing.sites.find((site: any) => site.site_kind === "customer_portal");
  return { orgId, sites: listing.sites, publicSite, portalSite };
}

async function readHostRegistryFile() {
  const filePath = path.join(String(process.env.PLATFORM_STORAGE_ROOT), "config", "website_hosts.json");
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sitePages(detail: any) {
  return detail.pages as any[];
}

test("lazy seeding creates both sites, starter pages that validate, and host registry entries", async () => {
  const client = createSessionClient();
  const { orgId, sites, publicSite, portalSite } = await setupOrg(client);

  assert.equal(sites.length, 2, "seeding creates exactly two sites");
  assert.ok(publicSite, "a public site is seeded");
  assert.ok(portalSite, "the customer_portal site is seeded");
  assert.equal(publicSite.page_count, 3, "public site seeds home + header + footer");
  assert.equal(portalSite.page_count, 1, "portal site seeds its required Summary editor page");
  assert.match(publicSite.site_key, /^s[0-9a-f]{10}$/, "site keys are s + 10 hex");

  const detail = await client.request("GET", `/v1/websites/organizations/${orgId}/sites/${publicSite.id}`);
  const pages = sitePages(detail);
  const home = pages.find((page) => page.role === "page");
  const header = pages.find((page) => page.role === "header");
  const footer = pages.find((page) => page.role === "footer");
  assert.ok(home && header && footer, "home, header and footer pages exist");
  assert.equal(home.slug, "home");
  assert.equal(header.slug, null, "header pages carry no slug");
  assert.equal(detail.site.home_page_id, home.id);
  assert.equal(detail.site.header_page_id, header.id);
  assert.equal(detail.site.footer_page_id, footer.id);
  assert.equal(home.published_version, 1, "starter home is published");
  assert.equal(home.enabled, true, "starter home is enabled");
  assert.equal(home.has_unpublished_changes, false, "freshly seeded home has no unpublished changes");
  assert.equal(detail.system_pages.length, 0, "public sites have no system pages");

  const portalDetail = await client.request("GET", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}`);
  const summary = sitePages(portalDetail).find((page) => page.system_key === "summary");
  assert.ok(summary, "portal site has a protected Summary extension page");
  assert.equal(portalDetail.site.home_page_id, summary.id);
  assert.equal(summary.title, "Summary");
  assert.equal(summary.enabled, true);
  assert.equal(summary.nav.header, false, "Summary is not duplicated as a custom tab");
  assert.equal(summary.published_version, 1);
  const summaryPatch = await client.request("PATCH", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages/${summary.id}`, {
    title: "Home",
    enabled: false,
    nav: { header: true }
  });
  assert.equal(summaryPatch.page.title, "Summary", "Summary cannot be renamed to Home");
  assert.equal(summaryPatch.page.enabled, true, "Summary cannot be disabled");
  assert.equal(summaryPatch.page.nav.header, false, "Summary cannot become a duplicate custom tab");
  const deleteSummary = await client.raw("DELETE", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages/${summary.id}`);
  assert.equal(deleteSummary.statusCode, 403, "Summary cannot be deleted");
  const replaceSummary = await client.raw("PATCH", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}`, { home_page_id: "page_other" });
  assert.equal(replaceSummary.statusCode, 403, "Summary cannot be replaced");
  assert.equal(portalDetail.system_pages.length, 7, "portal site returns the built-in tab descriptors");
  assert.ok(portalDetail.system_pages.some((page: any) => page.id === "summary" && page.title && page.icon));

  const publicCatalog = await client.request("GET", `/v1/websites/organizations/${orgId}/sites/${publicSite.id}/catalog`);
  const portalCatalog = await client.request("GET", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/catalog`);
  const publicWidgetIds = new Set(publicCatalog.widgets.map((widget: any) => widget.id));
  const portalWidgetIds = new Set(portalCatalog.widgets.map((widget: any) => widget.id));
  assert.equal(publicWidgetIds.has("web.page_embed"), true, "public websites offer embedded-page sections");
  const pageEmbed = publicCatalog.widgets.find((widget: any) => widget.id === "web.page_embed");
  const pageField = pageEmbed?.configPanel?.find((field: any) => field.key === "page_id");
  assert.ok(Array.isArray(pageField?.options) && pageField.options.length > 0, "embedded-page widget includes site page choices");
  for (const widgetId of ["portal.project_header", "portal.activity_feed", "portal.team", "portal.portfolio", "portal.welcome_video", "portal.nearby_jobs"]) {
    assert.equal(publicWidgetIds.has(widgetId), false, `${widgetId} must stay out of public-site palettes`);
    assert.equal(portalWidgetIds.has(widgetId), true, `${widgetId} should be available in the portal editor`);
  }
  assert.equal(portalWidgetIds.has("portal.reviews"), false, "reviews remain intentionally deferred");

  // Every seeded definition is a valid kind:"view" DocModel.
  const { FMDocModel } = await import("../documents/schemas.js");
  for (const page of pages) {
    const record = await client.request("GET", `/v1/websites/organizations/${orgId}/sites/${publicSite.id}/pages/${page.id}`);
    const definition = record.page.draft.definition;
    assert.equal(definition.kind, "view", `${page.role} seed is a view document`);
    const result = FMDocModel.validateDocument(definition);
    assert.ok(result.ok, `${page.role} seed validates: ${JSON.stringify(result.errors.slice(0, 3))}`);
  }
  const summaryRecord = await client.request("GET", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}/pages/${summary.id}`);
  assert.ok(FMDocModel.validateDocument(summaryRecord.page.draft.definition).ok, "Summary extension seed validates");

  // Host registry entries for both sites.
  const registry = await readHostRegistryFile();
  for (const site of [publicSite, portalSite]) {
    assert.deepEqual(registry.site_keys[site.site_key], { org_id: orgId, site_id: site.id }, `host registry maps ${site.site_kind} site key`);
  }

  // Capability gate: an org without apps.web_editor cannot use the API.
  const otherClient = createSessionClient();
  const { orgId: otherOrgId } = await registerOrg(otherClient);
  const denied = await otherClient.raw("GET", `/v1/websites/organizations/${otherOrgId}/sites`);
  assert.equal(denied.statusCode, 403, "web editor routes are capability-gated");
});

test("site CRUD, settings, and archive guards", async () => {
  const client = createSessionClient();
  const { orgId, portalSite } = await setupOrg(client);

  const created = await client.request("POST", `/v1/websites/organizations/${orgId}/sites`, { name: "Landing Pages" });
  assert.equal(created.site.site_kind, "public");
  assert.equal(created.site.name, "Landing Pages");
  const detail = await client.request("GET", `/v1/websites/organizations/${orgId}/sites/${created.site.id}`);
  assert.equal(sitePages(detail).length, 3, "new public sites get starter pages");

  const patched = await client.request("PATCH", `/v1/websites/organizations/${orgId}/sites/${created.site.id}`, {
    name: "Landing",
    settings: {
      theme_vars: { "--fm-primary": "#ff0000" },
      seo: { title: "Landing" },
      domains: ["landing-host.example.com"]
    },
    expected_revision: detail.site.revision
  });
  assert.equal(patched.site.name, "Landing");
  assert.equal(patched.site.settings.theme_vars["--fm-primary"], "#ff0000");
  assert.equal(patched.site.settings.design_width_pt, 720, "untouched settings survive the patch");

  const staleConflict = await client.raw("PATCH", `/v1/websites/organizations/${orgId}/sites/${created.site.id}`, {
    name: "Stale",
    expected_revision: detail.site.revision
  });
  assert.equal(staleConflict.statusCode, 409, "stale site revision is rejected");

  // customer_portal site can never archive.
  const portalArchive = await client.raw("DELETE", `/v1/websites/organizations/${orgId}/sites/${portalSite.id}`);
  assert.equal(portalArchive.statusCode, 403, "portal site archive is forbidden");

  const archived = await client.request("DELETE", `/v1/websites/organizations/${orgId}/sites/${created.site.id}`);
  assert.equal(archived.site.status, "archived");
  const registry = await readHostRegistryFile();
  assert.equal(registry.site_keys[created.site.site_key], undefined, "archiving removes the host registry entry");
  assert.equal(registry.domains["landing-host.example.com"], undefined, "archiving removes the hostname registry entry");
  assert.equal(registry.domains["www.landing-host.example.com"], undefined, "archiving removes the www hostname alias");
  const gone = await client.raw("GET", `/v1/websites/public/site/${created.site.site_key}/manifest`);
  assert.equal(gone.statusCode, 404, "archived sites disappear from public serving");
});

test("page lifecycle: draft-only create, slugs, draft save conflicts, publish, versions, restore, discard", async () => {
  const client = createSessionClient();
  const { orgId, publicSite } = await setupOrg(client);
  const base = `/v1/websites/organizations/${orgId}/sites/${publicSite.id}`;

  // Create: auto-slug from title, draft-only.
  const created = await client.request("POST", `${base}/pages`, { title: "About Us" });
  const page = created.page;
  assert.equal(page.slug, "about-us");
  assert.equal(page.role, "page");
  assert.equal(page.published_version, 0, "new pages start draft-only");
  assert.equal(page.enabled, false);
  assert.ok(page.draft.definition, "new pages carry a starter draft definition");

  // Slug collision + reserved slug handling.
  const twin = await client.request("POST", `${base}/pages`, { title: "About Us" });
  assert.equal(twin.page.slug, "about-us-2", "slug collisions get numeric suffixes");
  const portfolio = await client.request("POST", `${base}/pages`, { title: "Portfolio", slug: "portfolio" });
  const portfolioTwin = await client.request("POST", `${base}/pages`, { title: "Portfolio", slug: "portfolio" });
  assert.equal(portfolioTwin.page.title, "Portfolio", "duplicate template titles remain available");
  assert.equal(portfolioTwin.page.slug, "portfolio-2", "duplicate template slugs get a numeric suffix");
  const reserved = await client.request("POST", `${base}/pages`, { title: "Header" });
  assert.equal(reserved.page.slug, "header-page", "reserved slugs are remapped");

  // Draft-only pages never reach the public manifest.
  const manifest0 = await client.request("GET", `/v1/websites/public/site/${publicSite.site_key}/manifest`);
  assert.ok(!manifest0.pages.some((entry: any) => entry.slug === "about-us"), "draft-only page is not live");
  const draft404 = await client.raw("GET", `/v1/websites/public/site/${publicSite.site_key}/page/about-us`);
  assert.equal(draft404.statusCode, 404, "draft-only page payload 404s");

  // Draft save honors expected_revision.
  const { FMDocModel } = await import("../documents/schemas.js");
  const definition = FMDocModel.deepClone(page.draft.definition);
  (definition as any).metadata = { ...(definition as any).metadata, edited: 1 };
  const conflictSave = await client.raw("PUT", `${base}/pages/${page.id}/draft`, {
    definition,
    expected_revision: page.revision + 5
  });
  assert.equal(conflictSave.statusCode, 409, "stale draft save is rejected");
  assert.equal(JSON.parse(conflictSave.body).error, "website_revision_conflict");
  const invalidSave = await client.raw("PUT", `${base}/pages/${page.id}/draft`, {
    definition: { kind: "document", pages: [] }
  });
  assert.equal(invalidSave.statusCode, 400, "non-view definitions are rejected");
  const findAbsoluteSectionItem = (input: any): any => {
    for (const section of input?.root?.children || []) {
      const stack = [...(section.children || [])];
      while (stack.length) {
        const node = stack.shift();
        if (node?.frame?.layout !== "flow" && node?.anchor !== "flow" && node?.anchor !== "inline") return node;
        stack.push(...(node?.children || []));
      }
    }
    return null;
  };
  const firstSection = (definition as any).root.children[0];
  firstSection.children = firstSection.children || [];
  firstSection.children.push(FMDocModel.createNode("image", {
    anchor: "page",
    frame: { x: 120, y: 40, w: 240, h: 140, layout: "absolute" },
    props: { media: null, fit: "cover", alt: "" }
  }));
  const invalidPlacement = FMDocModel.deepClone(definition) as any;
  const invalidItem = findAbsoluteSectionItem(invalidPlacement);
  assert.ok(invalidItem, "test website includes an absolute section item");
  invalidItem.frame.position = { x: { unit: "vw", anchor: "middle", value: "nope" } };
  const invalidPlacementSave = await client.raw("PUT", `${base}/pages/${page.id}/draft`, {
    definition: invalidPlacement,
    expected_revision: page.revision
  });
  assert.equal(invalidPlacementSave.statusCode, 400, "explicitly invalid responsive placement is rejected");
  const authoredItem = findAbsoluteSectionItem(definition as any);
  delete authoredItem.frame.position;
  const saved = await client.request("PUT", `${base}/pages/${page.id}/draft`, {
    definition,
    expected_revision: page.revision
  });
  assert.ok(saved.page.draft.checksum, "draft save recomputes the checksum");
  const normalizedItem = findAbsoluteSectionItem(saved.page.draft.definition);
  assert.deepEqual(normalizedItem.frame.position.x, { unit: "percent", anchor: "center", value: normalizedItem.frame.position.x.value });
  assert.equal(typeof normalizedItem.frame.position.x.value, "number", "missing placement is normalized before storage");

  // Publish v1: version row + published pointer + clean indicator.
  const published = await client.request("POST", `${base}/pages/${page.id}/publish`, {
    expected_revision: saved.page.revision
  });
  assert.equal(published.page.published_version, 1);
  assert.equal(published.page.draft.based_on_version, 1);
  const versions1 = await client.request("GET", `${base}/pages/${page.id}/versions`);
  assert.equal(versions1.count, 1);
  assert.ok(versions1.versions[0].checksum, "version rows carry checksums");
  assert.equal(versions1.versions[0].locked, true, "version rows are locked");
  let detail = await client.request("GET", base);
  let listed = sitePages(detail).find((entry) => entry.id === page.id);
  assert.equal(listed.has_unpublished_changes, false, "published page with untouched draft is clean");

  // Edit draft -> dirty indicator.
  (definition as any).metadata = { ...(definition as any).metadata, edited: 2 };
  const saved2 = await client.request("PUT", `${base}/pages/${page.id}/draft`, {
    definition,
    expected_revision: published.page.revision
  });
  detail = await client.request("GET", base);
  listed = sitePages(detail).find((entry) => entry.id === page.id);
  assert.equal(listed.has_unpublished_changes, true, "edited draft flips has_unpublished_changes");

  // Publish v2, then restore v1 INTO the draft (live untouched).
  const published2 = await client.request("POST", `${base}/pages/${page.id}/publish`, {
    expected_revision: saved2.page.revision
  });
  assert.equal(published2.page.published_version, 2);
  const versionRow = await client.request("GET", `${base}/pages/${page.id}/versions/1`);
  assert.equal(versionRow.version.version, 1);
  const restored = await client.request("POST", `${base}/pages/${page.id}/restore`, {
    version: 1,
    expected_revision: published2.page.revision
  });
  assert.equal(restored.page.published_version, 2, "restore never touches the live pointer");
  assert.equal(restored.page.draft.based_on_version, 1, "restore syncs the draft to the old version");
  assert.equal(restored.page.draft.definition.metadata.edited, 1, "restore copies the old definition into the draft");
  const missingRestore = await client.raw("POST", `${base}/pages/${page.id}/restore`, {
    version: 9,
    expected_revision: restored.page.revision
  });
  assert.equal(missingRestore.statusCode, 404, "restoring an unknown version 404s");

  // Discard draft -> back to the published (v2) definition.
  const discarded = await client.request("POST", `${base}/pages/${page.id}/discard-draft`, {
    expected_revision: restored.page.revision
  });
  assert.equal(discarded.page.draft.definition.metadata.edited, 2, "discard copies the live definition back");
  assert.equal(discarded.page.draft.based_on_version, 2);
  const neverPublished = await client.raw("POST", `${base}/pages/${twin.page.id}/discard-draft`, {});
  assert.equal(neverPublished.statusCode, 404, "discard on a never-published page fails");

  // Enabled + nav toggles reflect in the public manifest.
  const enabledPatch = await client.request("PATCH", `${base}/pages/${page.id}`, {
    enabled: true,
    nav: { header: true, footer: true, order: 5 }
  });
  assert.equal(enabledPatch.page.enabled, true);
  let manifest = await client.request("GET", `/v1/websites/public/site/${publicSite.site_key}/manifest`);
  const liveEntry = manifest.pages.find((entry: any) => entry.slug === "about-us");
  assert.ok(liveEntry, "published + enabled page appears in the manifest");
  assert.equal(liveEntry.in_header, true);
  assert.equal(liveEntry.order, 5);
  const payload = await client.request("GET", `/v1/websites/public/site/${publicSite.site_key}/page/about-us`);
  assert.equal(payload.page.title, "About Us");
  await client.request("PATCH", `${base}/pages/${page.id}`, { enabled: false });
  manifest = await client.request("GET", `/v1/websites/public/site/${publicSite.site_key}/manifest`);
  assert.ok(!manifest.pages.some((entry: any) => entry.slug === "about-us"), "disabled pages leave the manifest");
  const disabled404 = await client.raw("GET", `/v1/websites/public/site/${publicSite.site_key}/page/about-us`);
  assert.equal(disabled404.statusCode, 404, "disabled page payload 404s");

  // PATCH slug revalidates: reserved + collision handling.
  const reservedSlug = await client.raw("PATCH", `${base}/pages/${page.id}`, { slug: "header" });
  assert.equal(reservedSlug.statusCode, 400, "reserved slugs are rejected on PATCH");
  const renamed = await client.request("PATCH", `${base}/pages/${page.id}`, { slug: "about-us-2" });
  assert.equal(renamed.page.slug, "about-us-2-2", "PATCH slug collisions get suffixes");

  // Home-page guard: must reference a role:"page" page of this site.
  const headerPageId = detail.site.header_page_id;
  const badHome = await client.raw("PATCH", base, { home_page_id: headerPageId });
  assert.equal(badHome.statusCode, 400, "header pages cannot become the home page");
  const newHome = await client.request("PATCH", base, { home_page_id: page.id });
  assert.equal(newHome.site.home_page_id, page.id);
  const selectedHeader = await client.request("PATCH", base, { header_page_id: headerPageId });
  assert.equal(selectedHeader.site.header_page_id, headerPageId, "a site can select one of its header-role pages");
  const badHeader = await client.raw("PATCH", base, { header_page_id: page.id });
  assert.equal(badHeader.statusCode, 400, "regular pages cannot be selected as the site header");
  const badFooter = await client.raw("PATCH", base, { footer_page_id: headerPageId });
  assert.equal(badFooter.statusCode, 400, "header-role pages cannot be selected as the site footer");

  // Deletion guards: header/footer and the home page are protected.
  const headerDelete = await client.raw("DELETE", `${base}/pages/${headerPageId}`);
  assert.equal(headerDelete.statusCode, 403, "header pages cannot be deleted");
  const homeDelete = await client.raw("DELETE", `${base}/pages/${page.id}`);
  assert.equal(homeDelete.statusCode, 403, "the home page cannot be deleted");
  const deleted = await client.request("DELETE", `${base}/pages/${twin.page.id}`);
  assert.equal(deleted.page.id, twin.page.id);
  const gone = await client.raw("GET", `${base}/pages/${twin.page.id}`);
  assert.equal(gone.statusCode, 404, "deleted pages are gone");
});

test("public serving: manifest, ~role payloads, nav_menu resolution, and capability gates", async () => {
  const client = createSessionClient();
  const { orgId, publicSite } = await setupOrg(client);

  const customHostname = `published-${Date.now().toString(36)}.example.com`;
  await client.request("PATCH", `/v1/websites/organizations/${orgId}/sites/${publicSite.id}`, {
    settings: { ...publicSite.settings, primary_domain: customHostname, domains: [customHostname] }
  });
  const hostResolution = await client.request("GET", `/v1/websites/public/host/${customHostname}/resolve`);
  assert.equal(hostResolution.site_key, publicSite.site_key, "custom hostname resolves to the published website");
  assert.equal(hostResolution.primary_domain, customHostname);
  const wwwResolution = await client.request("GET", `/v1/websites/public/host/www.${customHostname}/resolve`);
  assert.equal(wwwResolution.site_key, publicSite.site_key, "apex connections automatically include their www alias");
  const unknownHost = await client.raw("GET", "/v1/websites/public/host/unattached.example.com/resolve");
  assert.equal(unknownHost.statusCode, 404, "unattached hostnames do not expose a website");

  const manifest = await client.request("GET", `/v1/websites/public/site/${publicSite.site_key}/manifest`);
  assert.equal(manifest.home_slug, "home");
  assert.equal(manifest.base_path, `/sites/${publicSite.site_key}/`);
  assert.equal(manifest.header_published, true);
  assert.equal(manifest.footer_published, true);
  assert.ok(manifest.pages.some((entry: any) => entry.slug === "home" && entry.in_header === true));
  assert.ok(manifest.theme_vars["--fm-primary"], "manifest carries layered theme vars");
  assert.equal(manifest.chat.widget_key, null, "chat is off by default");

  const unknown = await client.raw("GET", "/v1/websites/public/site/s0000000000/manifest");
  assert.equal(unknown.statusCode, 404, "unknown site keys 404");

  const home = await client.request("GET", `/v1/websites/public/site/${publicSite.site_key}/page/~home`);
  assert.equal(home.page.slug, "home");
  assert.equal(home.definition.kind, "view");
  assert.ok(home.theme_vars["--fm-primary"]);

  // The seeded header contains a web.nav_menu widget; its server-resolved
  // data must list the live header pages with basePath-relative hrefs.
  const header = await client.request("GET", `/v1/websites/public/site/${publicSite.site_key}/page/~header`);
  const navData = Object.values(header.widget_data as Record<string, any>).find((value) => value && Array.isArray(value.links));
  assert.ok(navData, "nav_menu widget data resolves server-side");
  assert.equal(navData.source, "header");
  const homeLink = navData.links.find((link: any) => link.slug === "home");
  assert.ok(homeLink, "home appears in the header menu");
  assert.equal(homeLink.href, "./home", "hrefs are basePath-relative");

  // Turning the app capability off hides the public site entirely.
  await setCapabilities(client, orgId, { "apps.web_editor": false });
  const hidden = await client.raw("GET", `/v1/websites/public/site/${publicSite.site_key}/manifest`);
  assert.equal(hidden.statusCode, 404, "public serving is gated on web_editor.public_sites");
  const hiddenHost = await client.raw("GET", `/v1/websites/public/host/${customHostname}/resolve`);
  assert.equal(hiddenHost.statusCode, 404, "hostname serving uses the same capability gate");
  await setCapabilities(client, orgId, { "apps.web_editor": true });
});

test("portal pages: listPortalPages contract, capability gate, and public portal routes", async () => {
  const client = createSessionClient();
  const { orgId, portalSite } = await setupOrg(client);
  const base = `/v1/websites/organizations/${orgId}/sites/${portalSite.id}`;
  const service = await import("../websites/service.js");

  // No pages yet -> null.
  assert.equal(await service.listPortalPages(orgId), null, "empty portal site lists as null");

  // Create + publish + enable a portal page marked as a tab.
  const created = await client.request("POST", `${base}/pages`, { title: "Warranty Info" });
  const pageId = created.page.id;
  await client.request("POST", `${base}/pages/${pageId}/publish`, { expected_revision: created.page.revision });
  await client.request("PATCH", `${base}/pages/${pageId}`, { enabled: true, nav: { header: true, order: 3 } });

  // A second page left OFF the tab bar (nav.header false) must not list.
  const hidden = await client.request("POST", `${base}/pages`, { title: "Internal Notes" });
  await client.request("POST", `${base}/pages/${hidden.page.id}/publish`, { expected_revision: hidden.page.revision });
  await client.request("PATCH", `${base}/pages/${hidden.page.id}`, { enabled: true, nav: { header: false } });

  const listing = await service.listPortalPages(orgId);
  assert.ok(listing, "portal listing resolves");
  assert.equal(listing!.site_key, portalSite.site_key, "listing carries the portal site key");
  assert.equal(listing!.pages.length, 1, "only nav.header pages appear as tabs");
  assert.deepEqual(listing!.pages[0], { id: pageId, slug: "warranty-info", title: "Warranty Info", order: 3 }, "listPortalPages contract shape");

  // resolvePublishedPagePayload contract shape.
  const payload = await service.resolvePublishedPagePayload(orgId, pageId);
  assert.equal(payload.page.slug, "warranty-info");
  assert.equal(payload.page.title, "Warranty Info");
  assert.ok(payload.definition && payload.definition.kind === "view");
  assert.ok(payload.widget_data !== undefined && payload.theme_vars["--fm-primary"], "payload carries widget data + theme vars");

  // Capability off -> null listing (feature flag, not the whole app).
  await setCapabilities(client, orgId, { "apps.web_editor": true, "web_editor.portal_pages": false });
  assert.equal(await service.listPortalPages(orgId), null, "portal listing is capability-gated");
  await setCapabilities(client, orgId, { "web_editor.portal_pages": true });

  // Public portal routes resolve by portal uuid (live + preview).
  const projectId = "project_websites_portal";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "1 Portal Way",
      title: "Portal Customer",
      project_type: "residential",
      contacts: [{ name: "Portal Customer", email: "portal@example.test", phone: "555-000-1111" }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
  const portalRecord = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`, {});
  const publicUuid = portalRecord.portal.public_uuid;
  const previewUuid = portalRecord.portal.preview_uuid;
  assert.ok(publicUuid && previewUuid, "portal record carries both uuids");

  // Editor-owned media embedded in a published portal page is readable via
  // the guarded portal media route even though it is not project shared media.
  const { storeMediaUpload } = await import("../platform/storage.js");
  const welcomeVideo = await storeMediaUpload(orgId, {
    ownerType: "website_page",
    ownerId: pageId,
    collection: "websites",
    fileName: "welcome.mp4",
    contentType: "video/mp4",
    bytes: Buffer.from("portal welcome video")
  });
  const pageRecord = await client.request("GET", `${base}/pages/${pageId}`);
  const { FMDocModel } = await import("../documents/schemas.js");
  const videoDefinition = FMDocModel.deepClone(pageRecord.page.draft.definition);
  videoDefinition.root.children.push(FMDocModel.createNode("widget", {
    name: "Welcome video",
    frame: { x: 48, y: 48, w: 560, h: 315, z: 1 },
    props: { widget: "doc.video@1", config: { media: { media_id: welcomeVideo.id, variant: "original" } } }
  }));
  const videoSaved = await client.request("PUT", `${base}/pages/${pageId}/draft`, {
    definition: videoDefinition,
    expected_revision: pageRecord.page.revision
  });
  await client.request("POST", `${base}/pages/${pageId}/publish`, { expected_revision: videoSaved.page.revision });
  const publicVideo = await (app.inject as any)({ method: "GET", url: `/v1/platform/customer-portals/${publicUuid}/media/${welcomeVideo.id}/file` });
  assert.equal(publicVideo.statusCode, 200, "published page video is publicly streamable through its portal");
  assert.equal(publicVideo.headers["accept-ranges"], "bytes", "portal video retains byte-range support for seeking");

  const listed = await client.request("GET", `/v1/websites/public/portal/${publicUuid}/pages`);
  assert.equal(listed.site_key, portalSite.site_key);
  assert.equal(listed.pages.length, 1);
  assert.equal(listed.pages[0].id, pageId);

  const publicPayload = await client.request("GET", `/v1/websites/public/portal/${publicUuid}/pages/${pageId}`);
  assert.equal(publicPayload.source, "published");
  assert.equal(publicPayload.page.title, "Warranty Info");

  // Draft source: allowed via preview uuid only; the public uuid always serves published.
  const previewDraft = await client.request("GET", `/v1/websites/public/portal/${previewUuid}/pages/${pageId}?source=draft`);
  assert.equal(previewDraft.source, "draft", "preview uuid may request the draft");
  const publicDraft = await client.request("GET", `/v1/websites/public/portal/${publicUuid}/pages/${pageId}?source=draft`);
  assert.equal(publicDraft.source, "published", "public uuid never serves drafts");

  const unknownPortal = await client.raw("GET", "/v1/websites/public/portal/not-a-portal/pages");
  assert.equal(unknownPortal.statusCode, 404, "unknown portal uuids 404");
  const notPublished = await client.raw("GET", `/v1/websites/public/portal/${publicUuid}/pages/${hidden.page.id}`);
  assert.equal(notPublished.statusCode, 200, "published+enabled pages resolve even when not tabs");

  // Disable the feature: the public portal routes go dark.
  await setCapabilities(client, orgId, { "web_editor.portal_pages": false });
  const dark = await client.raw("GET", `/v1/websites/public/portal/${publicUuid}/pages`);
  assert.equal(dark.statusCode, 404, "portal routes are gated on web_editor.portal_pages");
});
