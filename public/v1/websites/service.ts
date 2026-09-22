import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import {
  listDocuments,
  listOrganizations,
  readDocument,
  readGlobal,
  readMediaFile,
  readMediaMetadata,
  readOrganization,
  type JsonObject
} from "../platform/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { projectAudienceFacts, type ProjectAudienceFacts } from "../platform/portal_audience.js";
import { normalizePortalSettings } from "../platform/portal_settings.js";
import { definitionChecksum } from "../documents/storage.js";
import { organizationBranding, organizationLogoUrl } from "../documents/service.js";
import { documentCapabilityState, filterDocumentDefinitionByCapabilities } from "../documents/capability_policy.js";
import {
  registerDocumentWidgetResolver,
  resolveDocumentWidgetData,
  type DocumentWidgetServices,
  type WidgetResolveContext
} from "../documents/widgets/registry.js";
import { ensureLeadIntakeSettings } from "../lead-intake/api.js";
import { FMDocModel } from "./schemas.js";
import { WEBSITE_SCHEMA_VERSION } from "./schemas.js";
import {
  createPageVersion,
  deletePageRecord,
  deletePageVersions,
  generatePageId,
  generateSiteId,
  listPageVersions,
  listSitePages,
  listSites,
  mintSiteKey,
  readPage,
  readPageVersion,
  readSite,
  recordWebsiteEvent,
  registerSiteKey,
  resolveDomainHost,
  saveSite,
  savePage,
  syncSiteDomainHosts,
  normalizeWebsiteHostname,
  unregisterSiteKey,
  WEBSITE_PAGE_COLLECTION
} from "./storage.js";
import {
  blankPageDefinition,
  footerSeedDefinition,
  headerSeedDefinition,
  homeSeedDefinition,
  portalSummaryExtensionSeedDefinition,
  WEBSITE_DESIGN_WIDTH_PT
} from "./seeds.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Slugs that collide with routing or role addressing. */
export const RESERVED_SLUGS = ["header", "footer", "~home", "~header", "~footer", "sites", "api"];

/**
 * Built-in customer portal tabs, surfaced by GET sites/:siteId as read-only
 * descriptors. Deliberately data-driven so they can graduate to configurable
 * records later without API shape changes.
 */
export const PORTAL_SYSTEM_PAGES = [
  { id: "summary", title: "Summary", description: "Project overview, status, and shared updates.", icon: "fa-house" },
  { id: "schedule", title: "Schedule", description: "Upcoming visits and project milestones.", icon: "fa-calendar-days" },
  { id: "photos", title: "Photos", description: "Shared project photos and progress galleries.", icon: "fa-images" },
  { id: "checklists", title: "Checklists", description: "Customer-facing checklists and sign-offs.", icon: "fa-list-check" },
  { id: "proposals", title: "Proposals", description: "Proposals shared for review and signature.", icon: "fa-file-signature" },
  { id: "documents", title: "Documents", description: "Documents delivered through the portal.", icon: "fa-file-lines" },
  { id: "payments", title: "Payments", description: "Invoices, payment schedule, and payment history.", icon: "fa-credit-card" }
];

/** Curated documents widgets that make sense on marketing pages. */
export const WEBSITE_DOC_WIDGET_IDS = ["doc.photo", "doc.photo_grid", "doc.video", "doc.qr", "doc.media_popup"];

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

export function slugifyTitle(value: string) {
  return cleanText(value)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function assertValidSlug(slug: string) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw badRequest("invalid_page_slug", "Page slugs must be kebab-case (letters, numbers, dashes).");
  }
  if (RESERVED_SLUGS.includes(slug)) {
    throw badRequest("reserved_page_slug", `"${slug}" is a reserved slug and cannot be used for a page.`);
  }
}

/** Unique per site; collisions get -2, -3... suffixes. */
async function uniquePageSlug(orgId: string, siteId: string, desired: string, excludePageId = "") {
  const base = slugifyTitle(desired) || "page";
  const candidateBase = RESERVED_SLUGS.includes(base) ? `${base}-page` : base;
  const pages = await listSitePages(orgId, siteId);
  const taken = new Set(
    pages
      .filter((page) => cleanText(page.id) !== excludePageId)
      .map((page) => cleanText(page.slug))
      .filter(Boolean)
  );
  if (!taken.has(candidateBase)) return candidateBase;
  let suffix = 2;
  while (taken.has(`${candidateBase}-${suffix}`)) suffix += 1;
  return `${candidateBase}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Record factories
// ---------------------------------------------------------------------------

function defaultSiteSettings() {
  return {
    design_width_pt: WEBSITE_DESIGN_WIDTH_PT,
    theme_vars: {},
    chat: { enabled: false, widget_key: "" },
    seo: { title: "", description: "" }
  };
}

function newSiteData(input: { id: string; siteKind: string; name: string; siteKey: string }, ctx: PlatformAuthContext | null): JsonObject {
  const now = nowIso();
  return {
    schema_version: WEBSITE_SCHEMA_VERSION,
    id: input.id,
    kind: "website",
    site_kind: input.siteKind,
    name: input.name,
    status: "active",
    site_key: input.siteKey,
    home_page_id: "",
    header_page_id: null,
    footer_page_id: null,
    domains: [],
    settings: defaultSiteSettings(),
    created_by_user_id: ctx?.userId || "",
    updated_by_user_id: ctx?.userId || "",
    created_at: now,
    updated_at: now
  };
}

function newPageData(
  input: { id: string; websiteId: string; title: string; slug: string | null; role: string; definition: JsonObject; nav?: JsonObject; enabled?: boolean },
  ctx: PlatformAuthContext | null
): JsonObject {
  const now = nowIso();
  return {
    schema_version: WEBSITE_SCHEMA_VERSION,
    id: input.id,
    website_id: input.websiteId,
    title: input.title,
    slug: input.slug,
    role: input.role,
    enabled: input.enabled === true,
    nav: { header: false, footer: false, order: 0, ...asObject(input.nav) },
    draft: {
      definition: input.definition,
      checksum: definitionChecksum(input.definition),
      based_on_version: 0,
      updated_at: now,
      updated_by_user_id: ctx?.userId || ""
    },
    published_version: 0,
    published_checksum: "",
    seo: { title: "", description: "" },
    created_at: now,
    updated_at: now
  };
}

// ---------------------------------------------------------------------------
// Unpublished-changes indicator
// ---------------------------------------------------------------------------

export async function pageHasUnpublishedChanges(orgId: string, page: JsonObject) {
  const publishedVersion = Number(page.published_version || 0);
  if (!publishedVersion) return true;
  const draftChecksum = cleanText(asObject(page.draft).checksum);
  let publishedChecksum = cleanText(page.published_checksum);
  if (!publishedChecksum) {
    const version = await readPageVersion(orgId, cleanText(page.id), publishedVersion);
    publishedChecksum = cleanText(asObject(version).checksum);
  }
  return draftChecksum !== publishedChecksum;
}

async function pageListView(orgId: string, page: JsonObject) {
  const { draft, ...rest } = page;
  return {
    ...rest,
    draft: { ...asObject(draft), definition: undefined },
    has_unpublished_changes: await pageHasUnpublishedChanges(orgId, page)
  };
}

// ---------------------------------------------------------------------------
// Seeding — lazy, TTL-guarded (mirrors documents ensureDefaultDocumentAssets)
// ---------------------------------------------------------------------------

const ensuring = new Set<string>();
const ensured = new Map<string, number>();
const ENSURE_TTL_MS = 60_000;

async function organizationName(orgId: string) {
  const org = await readOrganization(orgId).catch(() => ({} as JsonObject));
  const globalDoc = await readGlobal(orgId).catch(() => ({} as JsonObject));
  return cleanText(asObject(org).name || asObject(asObject(globalDoc).data).company_name) || "Our Company";
}

async function publishStarterPage(orgId: string, siteId: string, page: JsonObject, ctx: PlatformAuthContext | null) {
  const definition = asObject(asObject(page.draft).definition);
  const checksum = cleanText(asObject(page.draft).checksum) || definitionChecksum(definition);
  await createPageVersion(orgId, { websiteId: siteId, pageId: cleanText(page.id), version: 1, definition, checksum }, ctx);
  return {
    ...page,
    published_version: 1,
    published_checksum: checksum,
    draft: { ...asObject(page.draft), based_on_version: 1 },
    updated_at: nowIso()
  };
}

/** Creates a public site with starter Home (published + enabled + home), Header and Footer pages. */
export async function createPublicSite(orgId: string, name: string, ctx: PlatformAuthContext | null) {
  const orgName = await organizationName(orgId);
  const siteId = generateSiteId();
  const siteKey = await mintSiteKey();
  const site = newSiteData({ id: siteId, siteKind: "public", name: cleanText(name) || "Main Website", siteKey }, ctx);

  let home = newPageData({
    id: generatePageId(),
    websiteId: siteId,
    title: "Home",
    slug: "home",
    role: "page",
    definition: homeSeedDefinition(orgName),
    nav: { header: true, footer: true, order: 0 },
    enabled: true
  }, ctx);
  home = await publishStarterPage(orgId, siteId, home, ctx);

  let header = newPageData({
    id: generatePageId(),
    websiteId: siteId,
    title: "Header",
    slug: null,
    role: "header",
    definition: headerSeedDefinition(orgName)
  }, ctx);
  header = await publishStarterPage(orgId, siteId, header, ctx);

  let footer = newPageData({
    id: generatePageId(),
    websiteId: siteId,
    title: "Footer",
    slug: null,
    role: "footer",
    definition: footerSeedDefinition(orgName)
  }, ctx);
  footer = await publishStarterPage(orgId, siteId, footer, ctx);

  site.home_page_id = cleanText(home.id);
  site.header_page_id = cleanText(header.id);
  site.footer_page_id = cleanText(footer.id);

  await savePage(orgId, cleanText(home.id), home);
  await savePage(orgId, cleanText(header.id), header);
  await savePage(orgId, cleanText(footer.id), footer);
  const saved = await saveSite(orgId, siteId, site);
  await registerSiteKey(siteKey, orgId, siteId);
  await recordWebsiteEvent(orgId, saved, null, "website.site.created", { site_kind: "public" }, ctx);
  return saved;
}

async function createPortalSummaryPage(orgId: string, site: JsonObject, ctx: PlatformAuthContext | null) {
  let summary = newPageData({
    id: generatePageId(),
    websiteId: cleanText(site.id),
    title: "Summary",
    slug: "summary",
    role: "page",
    definition: portalSummaryExtensionSeedDefinition(),
    nav: { header: false, footer: false, order: 0 },
    enabled: true
  }, ctx);
  summary.system_key = "summary";
  summary = await publishStarterPage(orgId, cleanText(site.id), summary, ctx);
  await savePage(orgId, cleanText(summary.id), summary);
  return summary;
}

/** The blessed customer-portal site: exactly one, with one required Summary editor page. */
async function createCustomerPortalSite(orgId: string, ctx: PlatformAuthContext | null) {
  const siteId = generateSiteId();
  const siteKey = await mintSiteKey();
  const site = newSiteData({ id: siteId, siteKind: "customer_portal", name: "Customer Portal", siteKey }, ctx);
  const summary = await createPortalSummaryPage(orgId, site, ctx);
  site.home_page_id = cleanText(summary.id);
  const saved = await saveSite(orgId, siteId, site);
  await registerSiteKey(siteKey, orgId, siteId);
  await recordWebsiteEvent(orgId, saved, null, "website.site.created", { site_kind: "customer_portal" }, ctx);
  return saved;
}

/**
 * Lazy blessed content: ensures the org has its customer_portal site and one
 * public starter site. Called from site list/read routes; TTL-guarded.
 */
export async function ensureDefaultWebsites(orgId: string, ctx: PlatformAuthContext | null = null) {
  const key = cleanText(orgId);
  if (!key || ensuring.has(key)) return;
  const last = ensured.get(key) || 0;
  if (Date.now() - last < ENSURE_TTL_MS) return;
  ensuring.add(key);
  try {
    const sites = await listSites(orgId);
    const existingPortal = sites.find((site) => cleanText(site.site_kind) === "customer_portal");
    if (!existingPortal) {
      await createCustomerPortalSite(orgId, ctx);
    } else if (!cleanText(existingPortal.home_page_id)) {
      // Migrate older portal sites lazily. Summary is a required surface, so
      // every org receives its editable "additional content" page.
      const summary = await createPortalSummaryPage(orgId, existingPortal, ctx);
      await saveSite(orgId, cleanText(existingPortal.id), {
        ...existingPortal,
        home_page_id: cleanText(summary.id),
        updated_at: nowIso()
      });
    }
    if (!sites.some((site) => cleanText(site.site_kind) === "public")) {
      await createPublicSite(orgId, "Main Website", ctx);
    }
    ensured.set(key, Date.now());
  } finally {
    ensuring.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Site operations
// ---------------------------------------------------------------------------

export async function siteListing(orgId: string) {
  const sites = await listSites(orgId);
  const out: JsonObject[] = [];
  for (const site of sites) {
    const pages = await listSitePages(orgId, cleanText(site.id));
    out.push({ ...site, page_count: pages.length });
  }
  return out;
}

export async function siteDetail(orgId: string, siteId: string) {
  const site = await readSite(orgId, siteId);
  const pages = await listSitePages(orgId, siteId);
  const views: JsonObject[] = [];
  for (const page of pages) views.push(await pageListView(orgId, page));
  return {
    site,
    pages: views,
    system_pages: cleanText(site.site_kind) === "customer_portal" ? PORTAL_SYSTEM_PAGES : []
  };
}

export async function patchSite(orgId: string, siteId: string, patch: JsonObject, ctx: PlatformAuthContext | null) {
  const current = await readSite(orgId, siteId);
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(current.revision || 0)) {
    throw conflict("website_revision_conflict", "The website revision does not match.");
  }
  const next: JsonObject = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    next.name = cleanText(patch.name) || cleanText(current.name);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "home_page_id")) {
    const pageId = cleanText(patch.home_page_id);
    if (cleanText(current.site_kind) === "customer_portal" && pageId !== cleanText(current.home_page_id)) {
      throw forbidden("website_summary_change_forbidden", "The customer portal Summary is required and cannot be replaced.");
    }
    const page = await readPage(orgId, pageId).catch(() => null);
    if (!page || cleanText(page.website_id) !== siteId) {
      throw badRequest("invalid_home_page", "home_page_id must reference a page of this site.");
    }
    if (cleanText(page.role) !== "page") {
      throw badRequest("invalid_home_page", "The home page must be a regular page (not header/footer).");
    }
    next.home_page_id = pageId;
  }
  for (const [field, role, label] of [
    ["header_page_id", "header", "header"],
    ["footer_page_id", "footer", "footer"]
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const pageId = cleanText(patch[field]);
    if (!pageId) {
      next[field] = null;
      continue;
    }
    const page = await readPage(orgId, pageId).catch(() => null);
    if (!page || cleanText(page.website_id) !== siteId || cleanText(page.role) !== role) {
      throw badRequest(`invalid_${role}_page`, `${field} must reference a ${label} page of this site.`);
    }
    next[field] = pageId;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "settings")) {
    const settings = asObject(patch.settings);
    const currentSettings = asObject(current.settings);
    let domains = asArray(currentSettings.domains).map(normalizeWebsiteHostname).filter(Boolean);
    if (Object.prototype.hasOwnProperty.call(settings, "domains")) {
      if (cleanText(current.site_kind) !== "public") {
        throw badRequest("website_domains_not_supported", "Custom domains can only be connected to public websites.");
      }
      const requested = asArray(settings.domains);
      domains = [...new Set(requested.map(normalizeWebsiteHostname).filter(Boolean))];
      if (domains.length !== requested.length) {
        throw badRequest("invalid_website_domain", "Every custom domain must be a valid hostname and may only appear once.");
      }
    }
    next.settings = {
      ...currentSettings,
      ...settings,
      domains,
      theme_vars: Object.prototype.hasOwnProperty.call(settings, "theme_vars") ? asObject(settings.theme_vars) : asObject(currentSettings.theme_vars),
      chat: { ...asObject(currentSettings.chat), ...asObject(settings.chat) },
      seo: { ...asObject(currentSettings.seo), ...asObject(settings.seo) }
    };
    next.domains = domains;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    const status = cleanText(patch.status);
    if (status === "archived" && cleanText(current.site_kind) === "customer_portal") {
      throw forbidden("website_archive_forbidden", "The customer portal site cannot be archived.");
    }
    next.status = status || cleanText(current.status);
  }
  next.updated_by_user_id = ctx?.userId || cleanText(current.updated_by_user_id);
  next.updated_at = nowIso();
  const currentDomains = [...new Set(asArray(asObject(current.settings).domains).map(normalizeWebsiteHostname).filter(Boolean))];
  const nextDomains = [...new Set(asArray(asObject(next.settings).domains).map(normalizeWebsiteHostname).filter(Boolean))];
  const currentRegisteredDomains = cleanText(current.status) === "active" ? currentDomains : [];
  const nextRegisteredDomains = cleanText(next.status) === "active" ? nextDomains : [];
  const domainRegistryChanged = JSON.stringify(currentRegisteredDomains) !== JSON.stringify(nextRegisteredDomains);
  if (domainRegistryChanged) await syncSiteDomainHosts(nextRegisteredDomains, orgId, siteId);
  let saved: JsonObject;
  try {
    saved = await saveSite(orgId, siteId, next, { expectedRevision: expectedRevision || undefined });
  } catch (error) {
    if (domainRegistryChanged) await syncSiteDomainHosts(currentRegisteredDomains, orgId, siteId).catch(() => undefined);
    throw error;
  }
  const statusChanged = cleanText(saved.status) !== cleanText(current.status);
  if (statusChanged && cleanText(saved.status) === "archived") await unregisterSiteKey(cleanText(saved.site_key));
  if (statusChanged && cleanText(saved.status) === "active") await registerSiteKey(cleanText(saved.site_key), orgId, siteId);
  return saved;
}

export async function archiveSite(orgId: string, siteId: string, ctx: PlatformAuthContext | null) {
  const current = await readSite(orgId, siteId);
  if (cleanText(current.site_kind) === "customer_portal") {
    throw forbidden("website_archive_forbidden", "The customer portal site cannot be archived.");
  }
  return await patchSite(orgId, siteId, { status: "archived" }, ctx);
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------

export async function createSitePage(orgId: string, siteId: string, input: JsonObject, ctx: PlatformAuthContext | null) {
  const site = await readSite(orgId, siteId);
  const title = cleanText(input.title) || "New page";
  const desired = cleanText(input.slug) || title;
  if (cleanText(input.slug)) assertValidSlug(slugifyTitle(cleanText(input.slug)));
  const slug = await uniquePageSlug(orgId, siteId, desired);
  const page = newPageData({
    id: generatePageId(),
    websiteId: siteId,
    title,
    slug,
    role: "page",
    definition: blankPageDefinition(title)
  }, ctx);
  await savePage(orgId, cleanText(page.id), page);
  return await readPage(orgId, cleanText(page.id));
}

function requireSitePage(site: JsonObject, page: JsonObject) {
  if (cleanText(page.website_id) !== cleanText(site.id)) {
    throw notFound("website_page_not_found", "The requested website page was not found.");
  }
}

function guardExpectedRevision(page: JsonObject, expectedRevision: number) {
  if (expectedRevision && expectedRevision !== Number(page.revision || 0)) {
    throw conflict("website_revision_conflict", "The website page revision does not match.");
  }
}

/**
 * Normalize a page `audience` block to the canonical stored shape.
 *
 * Tag values are lowercased at write time so matching never has to guess about
 * case, and an all-empty block collapses to `{}` — the wildcard — so a page can
 * be un-targeted by clearing its dimensions.
 */
function normalizePageAudience(value: unknown): JsonObject {
  const input = asObject(value);
  const scopeTemplateIds = [...new Set(asArray(input.scope_template_ids).map(cleanText).filter(Boolean))];
  const tagIds = [...new Set(asArray(input.tag_ids ?? input.tags).map((tag) => cleanText(tag).toLowerCase()).filter(Boolean))];
  const projectStatus = [...new Set(asArray(input.project_status).map((status) => cleanText(status).toLowerCase()).filter(Boolean))];
  const customFieldInput = asObject(input.custom_field);
  const customKey = cleanText(customFieldInput.key);
  const customValues = [...new Set(asArray(customFieldInput.in).map((entry) => cleanText(entry).toLowerCase()).filter(Boolean))];
  const hasCustomField = Boolean(customKey && customValues.length);

  if (!scopeTemplateIds.length && !tagIds.length && !projectStatus.length && !hasCustomField) return {};
  return {
    match: cleanText(input.match).toLowerCase() === "all" ? "all" : "any",
    ...(scopeTemplateIds.length ? { scope_template_ids: scopeTemplateIds } : {}),
    ...(tagIds.length ? { tag_ids: tagIds } : {}),
    ...(projectStatus.length ? { project_status: projectStatus } : {}),
    ...(hasCustomField ? { custom_field: { key: customKey, in: customValues } } : {})
  };
}

export async function patchSitePage(orgId: string, siteId: string, pageId: string, patch: JsonObject, ctx: PlatformAuthContext | null) {
  const site = await readSite(orgId, siteId);
  const current = await readPage(orgId, pageId);
  requireSitePage(site, current);
  const expectedRevision = Number(patch.expected_revision || 0);
  guardExpectedRevision(current, expectedRevision);
  const role = cleanText(current.role) || "page";
  const requiredSummary = cleanText(site.site_kind) === "customer_portal" && cleanText(site.home_page_id) === pageId;
  const next: JsonObject = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    next.title = requiredSummary ? "Summary" : (cleanText(patch.title) || cleanText(current.title));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "slug")) {
    if (role !== "page") throw badRequest("invalid_page_slug", "Header and footer pages do not have slugs.");
    const desired = slugifyTitle(cleanText(patch.slug));
    assertValidSlug(desired);
    next.slug = await uniquePageSlug(orgId, siteId, desired, pageId);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "nav")) {
    next.nav = requiredSummary
      ? { ...asObject(current.nav), header: false, footer: false, order: 0 }
      : { ...asObject(current.nav), ...asObject(patch.nav) };
  }
  if (Object.prototype.hasOwnProperty.call(patch, "seo")) {
    next.seo = { ...asObject(current.seo), ...asObject(patch.seo) };
  }
  if (Object.prototype.hasOwnProperty.call(patch, "notes")) {
    // Editor-side working notes (bottom bar Notes drawer) — never rendered on
    // the live site.
    next.notes = String(patch.notes ?? "");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "audience")) {
    // Audience REPLACES rather than merges: array dimensions merged field-by-field
    // would make "remove this tag" impossible to express, and a half-applied
    // targeting rule is exactly the failure that shows a page to the wrong
    // customer. Passing null/{} clears targeting.
    next.audience = normalizePageAudience(patch.audience);
  }
  let enabledChanged = false;
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    const enabled = requiredSummary ? true : patch.enabled === true;
    enabledChanged = enabled !== (current.enabled === true);
    next.enabled = enabled;
  }
  next.updated_at = nowIso();
  const saved = await savePage(orgId, pageId, next, { expectedRevision: expectedRevision || undefined });
  if (enabledChanged) {
    await recordWebsiteEvent(orgId, site, saved, saved.enabled === true ? "website.page.enabled" : "website.page.disabled", {}, ctx);
  }
  return saved;
}

export async function saveSitePageDraft(orgId: string, siteId: string, pageId: string, definition: JsonObject, expectedRevision: number, ctx: PlatformAuthContext | null) {
  const site = await readSite(orgId, siteId);
  const current = await readPage(orgId, pageId);
  requireSitePage(site, current);
  guardExpectedRevision(current, expectedRevision);
  // Validate authored values before canonicalization so an explicitly invalid
  // unit/anchor is rejected rather than silently interpreted as a default.
  // Missing placement is valid and receives the canonical default below.
  const authoredValidation = FMDocModel.validateDocument(definition);
  if (definition.kind !== "view" || !authoredValidation.ok) {
    throw badRequest("invalid_page_definition", "Website page definitions must be valid view DocModels.", { errors: authoredValidation.errors.slice(0, 10) });
  }
  const normalizedDefinition = FMDocModel.normalizeViewHorizontalPositions(FMDocModel.deepClone(definition)) as JsonObject;
  const normalizedValidation = FMDocModel.validateDocument(normalizedDefinition);
  if (!normalizedValidation.ok) throw badRequest("invalid_page_definition", "Website page placement could not be normalized.", { errors: normalizedValidation.errors.slice(0, 10) });
  const next: JsonObject = {
    ...current,
    draft: {
      ...asObject(current.draft),
      definition: normalizedDefinition,
      checksum: definitionChecksum(normalizedDefinition),
      updated_at: nowIso(),
      updated_by_user_id: ctx?.userId || ""
    },
    updated_at: nowIso()
  };
  return await savePage(orgId, pageId, next, { expectedRevision: expectedRevision || undefined });
}

export async function publishSitePage(orgId: string, siteId: string, pageId: string, expectedRevision: number, ctx: PlatformAuthContext | null) {
  const site = await readSite(orgId, siteId);
  const current = await readPage(orgId, pageId);
  requireSitePage(site, current);
  guardExpectedRevision(current, expectedRevision);
  const draft = asObject(current.draft);
  const definition = asObject(draft.definition);
  const checksum = cleanText(draft.checksum) || definitionChecksum(definition);
  const nextVersion = Number(current.published_version || 0) + 1;
  await createPageVersion(orgId, { websiteId: siteId, pageId, version: nextVersion, definition, checksum }, ctx);
  const next: JsonObject = {
    ...current,
    published_version: nextVersion,
    published_checksum: checksum,
    draft: { ...draft, based_on_version: nextVersion },
    updated_at: nowIso()
  };
  // First publish means "make it live": the page goes visible immediately —
  // and on the customer-portal site that IS the portal tab, so the two are one
  // switch. Later publishes respect a manual hide.
  if (nextVersion === 1 && cleanText(current.role) === "page") {
    next.enabled = true;
    if (cleanText(asObject(site).site_kind) === "customer_portal") {
      next.nav = { ...asObject(current.nav), header: true };
    }
  }
  const saved = await savePage(orgId, pageId, next, { expectedRevision: expectedRevision || undefined });
  await recordWebsiteEvent(orgId, site, saved, "website.page.published", { version: nextVersion }, ctx);
  return saved;
}

export async function discardSitePageDraft(orgId: string, siteId: string, pageId: string, expectedRevision: number, ctx: PlatformAuthContext | null) {
  const site = await readSite(orgId, siteId);
  const current = await readPage(orgId, pageId);
  requireSitePage(site, current);
  guardExpectedRevision(current, expectedRevision);
  const publishedVersion = Number(current.published_version || 0);
  if (!publishedVersion) {
    throw notFound("website_page_not_published", "This page has never been published; there is nothing to discard to.");
  }
  const version = await readPageVersion(orgId, pageId, publishedVersion);
  if (!version) throw notFound("website_page_version_not_found", "The published version row is missing.");
  const definition = asObject(version.definition);
  const next: JsonObject = {
    ...current,
    draft: {
      ...asObject(current.draft),
      definition,
      checksum: cleanText(version.checksum) || definitionChecksum(definition),
      based_on_version: publishedVersion,
      updated_at: nowIso(),
      updated_by_user_id: ctx?.userId || ""
    },
    updated_at: nowIso()
  };
  return await savePage(orgId, pageId, next, { expectedRevision: expectedRevision || undefined });
}

export async function restoreSitePageVersion(orgId: string, siteId: string, pageId: string, versionNumber: number, expectedRevision: number, ctx: PlatformAuthContext | null) {
  const site = await readSite(orgId, siteId);
  const current = await readPage(orgId, pageId);
  requireSitePage(site, current);
  guardExpectedRevision(current, expectedRevision);
  const version = await readPageVersion(orgId, pageId, versionNumber);
  if (!version) throw notFound("website_page_version_not_found", "That page version was not found.");
  const definition = asObject(version.definition);
  const next: JsonObject = {
    ...current,
    draft: {
      ...asObject(current.draft),
      definition,
      checksum: cleanText(version.checksum) || definitionChecksum(definition),
      based_on_version: versionNumber,
      updated_at: nowIso(),
      updated_by_user_id: ctx?.userId || ""
    },
    updated_at: nowIso()
  };
  const saved = await savePage(orgId, pageId, next, { expectedRevision: expectedRevision || undefined });
  await recordWebsiteEvent(orgId, site, saved, "website.page.restored", { version: versionNumber }, ctx);
  return saved;
}

export async function deleteSitePage(orgId: string, siteId: string, pageId: string, ctx: PlatformAuthContext | null) {
  const site = await readSite(orgId, siteId);
  const current = await readPage(orgId, pageId);
  requireSitePage(site, current);
  const role = cleanText(current.role) || "page";
  if (role === "header" || role === "footer") {
    throw forbidden("website_page_delete_forbidden", "Header and footer pages cannot be deleted.");
  }
  if (cleanText(site.home_page_id) === pageId) {
    throw forbidden("website_page_delete_forbidden", cleanText(site.site_kind) === "customer_portal"
      ? "The customer portal Summary cannot be deleted."
      : "The home page cannot be deleted. Pick a different home page first.");
  }
  await deletePageVersions(orgId, pageId);
  await deletePageRecord(orgId, pageId);
  await recordWebsiteEvent(orgId, site, current, "website.page.deleted", {}, ctx);
  return current;
}

// ---------------------------------------------------------------------------
// Theme vars — org branding base layered with site settings.theme_vars
// ---------------------------------------------------------------------------

function hexToRgbTriplet(value: string): string {
  const hex = cleanText(value).replace(/^#/, "");
  const expanded = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return "";
  const num = parseInt(expanded, 16);
  return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

export function websiteThemeVars(branding: JsonObject, siteSettings: JsonObject): Record<string, string> {
  const colors = asObject(branding.colors);
  const primary = cleanText(colors.primary || branding.primary_color || branding.primaryColor) || "#2563eb";
  const secondary = cleanText(colors.secondary || branding.secondary_color || branding.secondaryColor) || "#111827";
  const accent = cleanText(colors.accent || branding.accent_color || branding.accentColor) || primary;
  const vars: Record<string, string> = {
    "--fm-primary": primary,
    "--fm-secondary": secondary,
    "--fm-accent": accent
  };
  for (const [name, base] of [["--fm-primary-rgb", primary], ["--fm-secondary-rgb", secondary], ["--fm-accent-rgb", accent]] as Array<[string, string]>) {
    const triplet = hexToRgbTriplet(base);
    if (triplet) vars[name] = triplet;
  }
  for (const [rawName, rawValue] of Object.entries(asObject(asObject(siteSettings).theme_vars))) {
    const name = cleanText(rawName);
    const value = cleanText(rawValue);
    if (!name || !value) continue;
    vars[name.startsWith("--") ? name : `--${name}`] = value;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

type NavLink = { slug: string; title: string; href: string; order: number };

/** Published + enabled regular pages placed in the requested menu, ordered. */
export function siteNavLinks(pages: JsonObject[], source: "header" | "footer"): NavLink[] {
  return pages
    .filter((page) => cleanText(page.role || "page") === "page")
    .filter((page) => Number(page.published_version || 0) > 0 && page.enabled === true)
    .filter((page) => asObject(page.nav)[source] === true)
    .map((page) => ({
      slug: cleanText(page.slug),
      title: cleanText(page.title),
      href: `./${cleanText(page.slug)}`,
      order: Number(asObject(page.nav).order || 0)
    }))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Server widget resolvers (registered into the SHARED documents registry)
// ---------------------------------------------------------------------------

function widgetServices(): DocumentWidgetServices {
  return {
    pricebook: {},
    payments: {
      listProjectObligations: async () => [],
      listProjectPayments: async () => []
    },
    media: {
      readMediaMetadata: async (orgId, mediaId) => await readMediaMetadata(orgId, mediaId),
      fileUrl: (orgId, mediaId, variant = "original") => (
        `/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(mediaId)}/file?variant=${encodeURIComponent(variant)}`
      ),
      readMediaFile: async (orgId, mediaId, variant = "original") => {
        const file = await readMediaFile(orgId, mediaId, variant);
        return { contentType: cleanText(file.contentType), bytes: file.bytes };
      }
    },
    platform: {
      readDocument: async (orgId, collection, documentId) => await readDocument(orgId, collection, documentId),
      listDocuments: async (orgId, collection) => await listDocuments(orgId, collection)
    }
  };
}

export async function leadFormsForOrg(orgId: string) {
  const { data } = await ensureLeadIntakeSettings(orgId).catch(() => ({ data: {} as JsonObject }));
  return asArray(asObject(data).forms).map(asObject).map((form) => ({
    id: cleanText(form.id),
    name: cleanText(form.name),
    mode: cleanText(form.mode),
    enabled: form.enabled !== false
  })).filter((form) => form.id);
}

let resolversRegistered = false;

export function registerWebsiteWidgetResolvers() {
  if (resolversRegistered) return;
  resolversRegistered = true;

  registerDocumentWidgetResolver("web.nav_menu", async (ctx: WidgetResolveContext, config: JsonObject) => {
    const websiteId = cleanText(asObject(ctx.document).website_id);
    if (!websiteId) return { links: [], source: cleanText(config.source) || "header" };
    const pages = await listSitePages(ctx.organizationId, websiteId);
    const source = cleanText(config.source) === "footer" ? "footer" : "header";
    return { links: siteNavLinks(pages, source), source };
  }, { title: "Navigation menu", category: "layout" });

  registerDocumentWidgetResolver("web.lead_form", async (ctx: WidgetResolveContext, config: JsonObject) => {
    const formId = cleanText(config.form_id);
    const forms = await leadFormsForOrg(ctx.organizationId);
    const form = forms.find((entry) => entry.id === formId && entry.enabled);
    return { form_id: formId, form_title: cleanText(form?.name), available: Boolean(form) };
  }, { title: "Lead form", category: "input" });

  registerDocumentWidgetResolver("web.page_embed", async (ctx: WidgetResolveContext, config: JsonObject) => {
    const pageId = cleanText(config.page_id);
    const sourcePageId = cleanText(asObject(ctx.document).id);
    const websiteId = cleanText(asObject(ctx.document).website_id);
    if (!pageId || pageId === sourcePageId || !websiteId) return { page_id: pageId, available: false };
    const page = await readPage(ctx.organizationId, pageId).catch(() => null);
    if (!page || cleanText(page.website_id) !== websiteId || cleanText(page.role || "page") !== "page") {
      return { page_id: pageId, available: false };
    }
    const versionNumber = Number(page.published_version || 0);
    const version = versionNumber ? await readPageVersion(ctx.organizationId, pageId, versionNumber).catch(() => null) : null;
    const definition = FMDocModel.deepClone(asObject(asObject(version).definition));
    if (Object.keys(definition).length) attachImageMediaUrls(ctx.organizationId, definition, null);
    return {
      page_id: pageId,
      page_title: cleanText(page.title),
      available: Object.keys(definition).length > 0,
      definition,
      widget_data: {}
    };
  }, { title: "Embedded page section", category: "layout" });
}

registerWebsiteWidgetResolvers();

// ---------------------------------------------------------------------------
// Resolution pipeline
// ---------------------------------------------------------------------------

function attachImageMediaUrls(orgId: string, definition: JsonObject, portal?: SitePagePortalContext | null) {
  const mediaUrlFor = (media: JsonObject) => {
    const mediaId = cleanText(media.media_id || media.mediaId);
    if (!mediaId || cleanText(media.url)) return "";
    if (portal) {
      const prefix = portal.preview ? "customer-portals/preview" : "customer-portals";
      return `/v1/platform/${prefix}/${encodeURIComponent(portal.portal_uuid)}/media/${encodeURIComponent(mediaId)}/file?variant=${encodeURIComponent(cleanText(media.variant) || "original")}`;
    }
    return `/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(mediaId)}/file?variant=${encodeURIComponent(cleanText(media.variant) || "original")}`;
  };
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const item = node as JsonObject;
    if (cleanText(item.type) === "image") {
      const props = asObject(item.props);
      const media = asObject(props.media);
      const url = mediaUrlFor(media);
      if (url) {
        media.url = url;
        props.media = media;
        item.props = props;
      }
    }
    // Image fills (contracts §10): every node's style.fill may reference media
    // by id — attach a loadable url the same way image nodes get theirs.
    const style = item.style;
    if (style && typeof style === "object" && !Array.isArray(style)) {
      const fill = (style as JsonObject).fill;
      if (fill && typeof fill === "object" && !Array.isArray(fill) && cleanText((fill as JsonObject).type) === "image") {
        const fillMedia = asObject((fill as JsonObject).media);
        const url = mediaUrlFor(fillMedia);
        if (url) {
          fillMedia.url = url;
          (fill as JsonObject).media = fillMedia;
        }
      }
    }
    if (Array.isArray(item.children)) item.children.forEach(visit);
  };
  if (definition.kind === "view") visit(definition.root);
}

async function siteScopeEntities(orgId: string, site: JsonObject, pages: JsonObject[]) {
  const branding = await organizationBranding(orgId);
  const org = await readOrganization(orgId).catch(() => ({} as JsonObject));
  const logoUrl = await organizationLogoUrl(orgId, branding, asObject(org), false).catch(() => "");
  const name = await organizationName(orgId);
  return {
    branding,
    org: { id: orgId, name, branding, logo_url: logoUrl },
    site: {
      id: cleanText(site.id),
      name: cleanText(site.name),
      site_key: cleanText(site.site_key),
      base_path: `/sites/${cleanText(site.site_key)}/`,
      nav: {
        header: siteNavLinks(pages, "header"),
        footer: siteNavLinks(pages, "footer")
      }
    }
  };
}

/**
 * Customer-portal render context. Passing this is what turns a page render from
 * "anonymous marketing page" into "this customer's page": bindings like
 * {{project.address}} resolve, and `portal.*` widget resolvers receive the
 * project they need.
 *
 * Public-site resolution passes nothing and is byte-for-byte unchanged.
 * Contract: docs/customer-portal-v2-spec.md §4.
 */
export type SitePagePortalContext = {
  project: JsonObject;
  customer: JsonObject;
  portal_uuid: string;
  contact_id: string;
  preview: boolean;
  /** Resolved PortalSettings from platform/portal_settings.ts. */
  settings: JsonObject;
};

/**
 * Resolve a page definition (draft or published) into the render payload:
 * bindings against { params, org, site } (plus { project, customer } under a
 * portal context), shared server widget resolution, media URLs and layered
 * theme vars.
 */
export async function resolveSitePage(
  orgId: string,
  site: JsonObject,
  page: JsonObject,
  source: "draft" | "published",
  portalContext?: SitePagePortalContext | null
) {
  let definition: JsonObject;
  if (source === "published") {
    const publishedVersion = Number(page.published_version || 0);
    if (!publishedVersion) throw notFound("website_page_not_published", "This page has never been published.");
    const version = await readPageVersion(orgId, cleanText(page.id), publishedVersion);
    if (!version) throw notFound("website_page_version_not_found", "The published version row is missing.");
    definition = asObject(version.definition);
  } else {
    definition = asObject(asObject(page.draft).definition);
  }
  const pages = await listSitePages(orgId, cleanText(site.id));
  const entities = await siteScopeEntities(orgId, site, pages);
  const portal = portalContext || null;
  const scope: JsonObject = {
    params: {},
    org: entities.org,
    site: entities.site,
    project: portal ? portal.project : null,
    customer: portal ? portal.customer : null
  };
  const normalizedDefinition = FMDocModel.normalizeViewHorizontalPositions(FMDocModel.deepClone(definition));
  const resolvedDefinition = FMDocModel.resolveBindings(normalizedDefinition, scope);
  // Bindings/components/repeaters may synthesize nodes that were not present
  // in the authored tree. Reassert placement after resolution as well so
  // workflow/agent-generated absolute items obey the same runtime contract.
  FMDocModel.normalizeViewHorizontalPositions(resolvedDefinition);
  attachImageMediaUrls(orgId, resolvedDefinition, portal);
  const effectiveDefinition = filterDocumentDefinitionByCapabilities(resolvedDefinition, await documentCapabilityState(orgId));
  const widgetCtx: WidgetResolveContext = {
    organizationId: orgId,
    document: { ...page, website_id: cleanText(site.id) },
    params: {},
    project: portal ? portal.project : null,
    snapshot: null,
    target: "interactive",
    portal: portal
      ? {
        portal_uuid: cleanText(portal.portal_uuid),
        project_id: cleanText(asObject(portal.project).id),
        contact_id: cleanText(portal.contact_id),
        preview: portal.preview === true,
        settings: asObject(portal.settings)
      }
      : null,
    services: widgetServices()
  };
  const widgetData = await resolveDocumentWidgetData(effectiveDefinition, widgetCtx);
  const themeVars = websiteThemeVars(entities.branding, asObject(site.settings));
  return {
    definition: effectiveDefinition,
    widget_data: widgetData,
    theme_vars: themeVars,
    site_context: entities.site
  };
}

function publicPagePayload(page: JsonObject, resolved: { definition: JsonObject; widget_data: Record<string, unknown>; theme_vars: Record<string, string> }) {
  return {
    page: {
      slug: cleanText(page.slug) || null,
      title: cleanText(page.title),
      seo: asObject(page.seo)
    },
    definition: resolved.definition,
    widget_data: resolved.widget_data,
    theme_vars: resolved.theme_vars
  };
}

export async function listSitePageVersions(orgId: string, siteId: string, pageId: string) {
  const site = await readSite(orgId, siteId);
  const page = await readPage(orgId, pageId);
  requireSitePage(site, page);
  return (await listPageVersions(orgId, pageId)).map((version) => ({ ...version, definition: undefined }));
}

export async function readSitePageVersion(orgId: string, siteId: string, pageId: string, versionNumber: number) {
  const site = await readSite(orgId, siteId);
  const page = await readPage(orgId, pageId);
  requireSitePage(site, page);
  const version = await readPageVersion(orgId, pageId, versionNumber);
  if (!version) throw notFound("website_page_version_not_found", "That page version was not found.");
  return version;
}

// ---------------------------------------------------------------------------
// Public serving (site_key routes)
// ---------------------------------------------------------------------------

async function resolvePublicSite(siteKey: string) {
  const { resolveSiteKey } = await import("./storage.js");
  const entry = await resolveSiteKey(siteKey);
  return await resolvePublicSiteEntry(entry);
}

async function resolvePublicSiteEntry(entry: { org_id: string; site_id: string } | null) {
  if (!entry) throw notFound("website_not_found", "No website is registered under that key.");
  const site = await readSite(entry.org_id, entry.site_id).catch(() => null);
  if (!site || cleanText(site.status) !== "active") {
    throw notFound("website_not_found", "No website is registered under that key.");
  }
  if (cleanText(site.site_kind) !== "public") {
    throw notFound("website_not_found", "No website is registered under that key.");
  }
  if (!(await isCapabilityEnabled(entry.org_id, "web_editor.public_sites"))) {
    throw notFound("website_not_found", "No website is registered under that key.");
  }
  return { orgId: entry.org_id, site };
}

export async function publicHostResolution(hostname: string) {
  const normalized = normalizeWebsiteHostname(hostname);
  if (!normalized) throw notFound("website_not_found", "No website is registered under that hostname.");
  const { site } = await resolvePublicSiteEntry(await resolveDomainHost(normalized));
  const settings = asObject(site.settings);
  return {
    hostname: normalized,
    site_key: cleanText(site.site_key),
    primary_domain: normalizeWebsiteHostname(settings.primary_domain) || normalized
  };
}

export async function publicSiteManifest(siteKey: string) {
  const { orgId, site } = await resolvePublicSite(siteKey);
  const pages = await listSitePages(orgId, cleanText(site.id));
  const branding = await organizationBranding(orgId);
  const org = await readOrganization(orgId).catch(() => ({} as JsonObject));
  const logoUrl = await organizationLogoUrl(orgId, branding, asObject(org), false).catch(() => "");
  const settings = asObject(site.settings);
  const chat = asObject(settings.chat);
  const homePage = pages.find((page) => cleanText(page.id) === cleanText(site.home_page_id)) || null;
  const headerPage = pages.find((page) => cleanText(page.id) === cleanText(site.header_page_id)) || null;
  const footerPage = pages.find((page) => cleanText(page.id) === cleanText(site.footer_page_id)) || null;
  const livePages = pages
    .filter((page) => cleanText(page.role || "page") === "page")
    .filter((page) => Number(page.published_version || 0) > 0 && page.enabled === true)
    .map((page) => ({
      slug: cleanText(page.slug),
      title: cleanText(page.title),
      in_header: asObject(page.nav).header === true,
      in_footer: asObject(page.nav).footer === true,
      order: Number(asObject(page.nav).order || 0)
    }))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return {
    name: cleanText(site.name),
    home_slug: cleanText(asObject(homePage).slug),
    base_path: `/sites/${cleanText(site.site_key)}/`,
    pages: livePages,
    header_published: Number(asObject(headerPage).published_version || 0) > 0,
    footer_published: Number(asObject(footerPage).published_version || 0) > 0,
    branding: { colors: asObject(branding.colors), logo_url: logoUrl },
    theme_vars: websiteThemeVars(branding, settings),
    chat: { widget_key: chat.enabled === true && cleanText(chat.widget_key) ? cleanText(chat.widget_key) : null },
    seo: asObject(settings.seo)
  };
}

export async function publicSitePagePayload(siteKey: string, slugOrRole: string) {
  const { orgId, site } = await resolvePublicSite(siteKey);
  const pages = await listSitePages(orgId, cleanText(site.id));
  const target = cleanText(slugOrRole);
  let page: JsonObject | null = null;
  if (target === "~home") {
    page = pages.find((entry) => cleanText(entry.id) === cleanText(site.home_page_id)) || null;
  } else if (target === "~header") {
    page = pages.find((entry) => cleanText(entry.id) === cleanText(site.header_page_id)) || null;
  } else if (target === "~footer") {
    page = pages.find((entry) => cleanText(entry.id) === cleanText(site.footer_page_id)) || null;
  } else {
    page = pages.find((entry) => cleanText(entry.role || "page") === "page" && cleanText(entry.slug) === target) || null;
  }
  if (!page) throw notFound("website_page_not_found", "The requested page was not found.");
  const role = cleanText(page.role || "page");
  if (Number(page.published_version || 0) <= 0) {
    throw notFound("website_page_not_found", "The requested page was not found.");
  }
  if (role === "page" && page.enabled !== true) {
    throw notFound("website_page_not_found", "The requested page was not found.");
  }
  const resolved = await resolveSitePage(orgId, site, page, "published");
  return publicPagePayload(page, resolved);
}

// ---------------------------------------------------------------------------
// Customer portal injection (contract consumed by platform/api.ts via
// dynamic import — keep listPortalPages / resolvePublishedPagePayload stable)
// ---------------------------------------------------------------------------

async function customerPortalSite(orgId: string) {
  const sites = await listSites(orgId);
  return sites.find((site) => cleanText(site.site_kind) === "customer_portal" && cleanText(site.status) === "active") || null;
}

function definitionReferencesMedia(value: unknown, mediaId: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => definitionReferencesMedia(item, mediaId));
  const item = value as JsonObject;
  if (cleanText(item.media_id || item.mediaId) === mediaId) return true;
  return Object.values(item).some((child) => definitionReferencesMedia(child, mediaId));
}

/**
 * Authorize a live portal asset that is embedded in a published page visible
 * to this portal's project. Project photos still use shared_items; this path is
 * for editor-owned assets such as welcome videos and manually uploaded team
 * portraits.
 */
export async function portalPublishedPageReferencesMedia(orgId: string, portal: JsonObject, mediaIdValue: string) {
  const mediaId = cleanText(mediaIdValue);
  const site = await customerPortalSite(orgId);
  if (!site || !mediaId) return false;
  const projectId = cleanText(portal.project_id);
  const projectDoc = projectId ? await readDocument(orgId, "projects", projectId).catch(() => null) : null;
  const project = projectDoc ? { id: projectDoc.id, ...asObject(projectDoc.data) } : null;
  const facts = project ? (await projectAudienceFacts(orgId, project)) : null;
  const pages = await listSitePages(orgId, cleanText(site.id));
  for (const page of pages) {
    const versionNumber = Number(page.published_version || 0);
    if (!versionNumber || page.enabled !== true || !pageAudienceMatches(page, facts)) continue;
    const version = await readPageVersion(orgId, cleanText(page.id), versionNumber).catch(() => null);
    if (version && definitionReferencesMedia(asObject(version.definition), mediaId)) return true;
  }
  return false;
}

/**
 * Does this page's audience block admit this project?
 *
 * An absent or fully-empty `audience` block is a wildcard — that is today's
 * behavior and every existing page keeps it. A populated dimension must match;
 * `match: "all"` requires every populated dimension, `"any"` (default) requires
 * at least one.
 *
 * FAIL CLOSED: a page with a populated audience block is hidden when no facts
 * are supplied. A caller that cannot say who is looking does not get to see
 * targeted pages. (The spec's §3.2 note that omitting facts disables filtering
 * applies only to pages with no audience block.)
 */
function pageAudienceMatches(page: JsonObject, facts?: ProjectAudienceFacts | null) {
  const audience = asObject(page.audience);
  const scopeIds = asArray(audience.scope_template_ids).map(cleanText).filter(Boolean);
  // Projects store tags as free-text labels, so tag matching is case-insensitive
  // on both sides (facts arrive lowercased from projectAudienceFacts).
  const tagIds = asArray(audience.tag_ids ?? audience.tags)
    .map((value) => cleanText(value).toLowerCase())
    .filter(Boolean);
  const statuses = asArray(audience.project_status).map((value) => cleanText(value).toLowerCase()).filter(Boolean);
  const customField = asObject(audience.custom_field);
  const customKey = cleanText(customField.key);
  const customValues = asArray(customField.in).map((value) => cleanText(value).toLowerCase()).filter(Boolean);

  const populated = Boolean(scopeIds.length || tagIds.length || statuses.length || (customKey && customValues.length));
  if (!populated) return true;
  if (!facts) return false;

  const dimensions: boolean[] = [];
  if (scopeIds.length) dimensions.push(scopeIds.some((id) => facts.scope_template_ids.includes(id)));
  if (tagIds.length) dimensions.push(tagIds.some((id) => facts.tag_ids.includes(id)));
  if (statuses.length) dimensions.push(statuses.includes(cleanText(facts.status).toLowerCase()));
  if (customKey && customValues.length) {
    const actual = cleanText(asObject(facts.custom_fields)[customKey]).toLowerCase();
    dimensions.push(Boolean(actual) && customValues.includes(actual));
  }
  return cleanText(audience.match).toLowerCase() === "all"
    ? dimensions.every(Boolean)
    : dimensions.some(Boolean);
}

/**
 * Published + enabled pages of the org's customer_portal site that are marked
 * as portal tabs (nav.header === true), sorted by nav.order. Returns null when
 * the capability is off, the site does not exist, or there are no live pages.
 *
 * `facts` narrows the list to pages whose audience admits this project. The
 * parameter is optional so the pre-audience call signature stays valid.
 */
export async function listPortalPages(
  orgId: string,
  facts?: ProjectAudienceFacts | null
): Promise<{ site_key: string; pages: Array<{ id: string; slug: string; title: string; order: number }> } | null> {
  if (!(await isCapabilityEnabled(orgId, "web_editor.portal_pages"))) return null;
  const site = await customerPortalSite(orgId);
  if (!site) return null;
  const pages = await listSitePages(orgId, cleanText(site.id));
  const live = pages
    .filter((page) => cleanText(page.role || "page") === "page")
    .filter((page) => Number(page.published_version || 0) > 0 && page.enabled === true)
    .filter((page) => asObject(page.nav).header === true)
    .filter((page) => pageAudienceMatches(page, facts))
    .map((page) => ({
      id: cleanText(page.id),
      slug: cleanText(page.slug),
      title: cleanText(page.title),
      order: Number(asObject(page.nav).order || 0)
    }))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  if (!live.length) return null;
  return { site_key: cleanText(site.site_key), pages: live };
}

/**
 * Portal-level configuration carried on the customer_portal site record:
 * customer-write defaults, blessed-tab overrides, and the optional Home page.
 * Returns null when the capability is off or the site does not exist.
 */
export async function portalSiteConfig(orgId: string): Promise<{
  site_key: string;
  portal_defaults: JsonObject;
  portal_tabs: JsonObject;
  home_page_id: string;
} | null> {
  if (!(await isCapabilityEnabled(orgId, "web_editor.portal_pages"))) return null;
  const site = await customerPortalSite(orgId);
  if (!site) return null;
  const settings = asObject(site.settings);
  const homePageId = cleanText(site.home_page_id);
  // Only surface a Home page that is actually live — an unpublished or disabled
  // page must not blank out the built-in summary tab.
  let liveHomePageId = "";
  if (homePageId) {
    const page = await readPage(orgId, homePageId).catch(() => null);
    if (page && Number(page.published_version || 0) > 0 && page.enabled === true) liveHomePageId = homePageId;
  }
  return {
    site_key: cleanText(site.site_key),
    portal_defaults: asObject(settings.portal_defaults),
    portal_tabs: asObject(settings.portal_tabs),
    home_page_id: liveHomePageId
  };
}

/**
 * Build the render + targeting context for a portal page request from a
 * resolved portal access record. One call so the two public portal routes
 * cannot drift apart on what a page is allowed to see.
 *
 * Returns nulls when the portal points at a project that no longer exists —
 * callers then render without project scope rather than failing the request.
 */
export async function portalRenderContext(access: { orgId: string; preview: boolean; portal: JsonObject }): Promise<{
  portalContext: SitePagePortalContext | null;
  facts: ProjectAudienceFacts | null;
}> {
  const portalData = asObject(access.portal);
  const projectId = cleanText(portalData.project_id);
  if (!projectId) return { portalContext: null, facts: null };
  const projectDoc = await readDocument(access.orgId, "projects", projectId).catch(() => null);
  if (!projectDoc) return { portalContext: null, facts: null };
  const project: JsonObject = { id: projectDoc.id, ...asObject(projectDoc.data) };
  const config = await portalSiteConfig(access.orgId);
  const settings = normalizePortalSettings(config?.portal_defaults, portalData.settings);
  return {
    portalContext: {
      project,
      customer: asObject(portalData.customer),
      portal_uuid: cleanText(access.preview ? portalData.preview_uuid : portalData.public_uuid),
      contact_id: cleanText(portalData.contact_id),
      preview: access.preview === true,
      settings: settings as unknown as JsonObject
    },
    facts: (await projectAudienceFacts(access.orgId, project))
  };
}

/**
 * Public page payload (spec §2 shape) for one published portal page.
 *
 * `facts` re-checks audience. This route is directly addressable, so filtering
 * the tab list is NOT sufficient — a targeted page must 404 for a project it
 * was not meant for. (docs/customer-portal-v2-spec.md §3.3)
 */
export async function resolvePublishedPagePayload(
  orgId: string,
  pageId: string,
  portalContext?: SitePagePortalContext | null,
  facts?: ProjectAudienceFacts | null
) {
  const page = await readPage(orgId, pageId);
  const site = await readSite(orgId, cleanText(page.website_id));
  if (Number(page.published_version || 0) <= 0 || page.enabled !== true) {
    throw notFound("website_page_not_found", "The requested page was not found.");
  }
  if (!pageAudienceMatches(page, facts)) {
    throw notFound("website_page_not_found", "The requested page was not found.");
  }
  const resolved = await resolveSitePage(orgId, site, page, "published", portalContext);
  return publicPagePayload(page, resolved);
}

/** Draft-source payload for the Web Editor's portal preview (preview uuid only). */
export async function resolveDraftPagePayload(orgId: string, pageId: string, portalContext?: SitePagePortalContext | null) {
  const page = await readPage(orgId, pageId);
  const site = await readSite(orgId, cleanText(page.website_id));
  const resolved = await resolveSitePage(orgId, site, page, "draft", portalContext);
  return publicPagePayload(page, resolved);
}

/**
 * Portal-uuid resolution for the /public/portal/* routes. Accepts both the
 * live public_uuid and the staff preview_uuid (mirrors platform/api.ts
 * findCustomerPortalByUuid without editing that file).
 */
export async function findPortalAccessByUuid(uuid: string): Promise<{ orgId: string; preview: boolean; portal: JsonObject } | null> {
  const target = cleanText(uuid);
  if (!target) return null;
  const orgs = await listOrganizations();
  for (const org of orgs) {
    const orgId = cleanText(asObject(org).id);
    if (!orgId) continue;
    const portals = await listDocuments(orgId, "customer_portals").catch(() => []);
    for (const doc of portals) {
      const data = asObject(doc.data);
      if (cleanText(data.status || "active") !== "active") continue;
      if (cleanText(data.public_uuid) === target) return { orgId, preview: false, portal: data };
      if (cleanText(data.preview_uuid) === target) return { orgId, preview: true, portal: data };
    }
  }
  return null;
}

/** Org-level gate used by the /public/portal routes. */
export async function portalPagesEnabled(orgId: string) {
  return await isCapabilityEnabled(orgId, "web_editor.portal_pages");
}

export { WEBSITE_PAGE_COLLECTION };
