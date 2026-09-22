import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { PlatformError, badRequest, notFound } from "../platform/errors.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { listDocuments, type JsonObject } from "../platform/storage.js";
import { DOCUMENT_FONTS, DOCUMENT_WIDGET_CATALOG } from "../documents/api.js";
import { capabilityDisabledPatch, documentCapabilityEnabled, documentCapabilityState, widgetCapability } from "../documents/capability_policy.js";
import {
  createPageSchema,
  createSiteSchema,
  discardDraftSchema,
  patchPageSchema,
  patchSiteSchema,
  publishPageSchema,
  resolvePageSchema,
  restorePageSchema,
  saveDraftSchema
} from "./schemas.js";
import {
  archiveSite,
  createPublicSite,
  createSitePage,
  deleteSitePage,
  discardSitePageDraft,
  ensureDefaultWebsites,
  findPortalAccessByUuid,
  leadFormsForOrg,
  listPortalPages,
  listSitePageVersions,
  pageHasUnpublishedChanges,
  patchSite,
  patchSitePage,
  portalPagesEnabled,
  portalRenderContext,
  publicSiteManifest,
  publicSitePagePayload,
  publicHostResolution,
  publishSitePage,
  readSitePageVersion,
  registerWebsiteWidgetResolvers,
  resolveDraftPagePayload,
  resolvePublishedPagePayload,
  resolveSitePage,
  restoreSitePageVersion,
  saveSitePageDraft,
  siteDetail,
  siteListing,
  WEBSITE_DOC_WIDGET_IDS
} from "./service.js";
import { listSitePages, readPage, readSite } from "./storage.js";

registerWebsiteWidgetResolvers();

const READ_AUTH = { permission: "view_projects|manage_company_settings", capability: "apps.web_editor" } as const;
const WRITE_AUTH = { csrf: true, permission: "manage_company_settings", capability: "apps.web_editor" } as const;

/**
 * Editor-palette metadata for the web.* widgets. configPanel follows the
 * shared field DSL (document-engine contracts §4); the lead-form select gets
 * per-org options baked in by the catalog route.
 */
function webWidgetCatalog(
  leadForms: Array<{ id: string; name: string; mode: string; enabled: boolean }>,
  pageOptions: Array<[string, string]> = []
) {
  const formOptions = leadForms.filter((form) => form.enabled).map((form) => [form.id, form.name || form.id]);
  return [
    {
      id: "web.nav_menu",
      version: 1,
      title: "Navigation menu",
      category: "layout",
      icon: "fa-bars",
      defaults: { config: { source: "header", layout: "horizontal", align: "center", gap_pt: 18, link_style: "plain" }, frame: { w: 400, h: 32 } },
      configPanel: [
        { key: "source", label: "Menu", kind: "select", options: [["header", "Header menu"], ["footer", "Footer menu"]] },
        { key: "layout", label: "Layout", kind: "select", options: [["horizontal", "Horizontal"], ["vertical", "Vertical"]] },
        { key: "align", label: "Align", kind: "select", options: [["start", "Start"], ["center", "Center"], ["end", "End"]] },
        { key: "gap_pt", label: "Gap (pt)", kind: "number", min: 0, max: 96 },
        { key: "link_style", label: "Link style", kind: "select", options: [["plain", "Plain"], ["underline", "Underline"], ["pill", "Pill"]] }
      ],
      has_server_resolver: true
    },
    {
      id: "web.lead_form",
      version: 1,
      title: "Lead form",
      category: "input",
      icon: "fa-envelope-open-text",
      defaults: { config: { form_id: formOptions.length ? formOptions[0]![0] : "" }, frame: { w: 420, h: 320 } },
      configPanel: [
        { key: "form_id", label: "Form", kind: "select", options: formOptions }
      ],
      has_server_resolver: true
    },
    {
      id: "web.page_embed",
      version: 1,
      title: "Embedded page section",
      category: "layout",
      icon: "fa-window-restore",
      defaults: { config: { page_id: pageOptions.length ? pageOptions[0]![0] : "" }, frame: { w: 720, h: 360 } },
      configPanel: [
        { key: "page_id", label: "Page", kind: "select", options: pageOptions }
      ],
      has_server_resolver: true
    }
  ];
}

/** Portal-only widgets. Kept out of public-site catalogs so project-aware
 * surfaces cannot be accidentally offered on an anonymous marketing page. */
function portalWidgetCatalog(userOptions: Array<[string, string]> = [], projectOptions: Array<[string, string]> = []) {
  const titleFields: JsonObject[] = [
    { key: "title", label: "Title", kind: "text" },
    { key: "subtitle", label: "Subtitle", kind: "text" }
  ];
  const widget = (id: string, title: string, icon: string, category: string, defaults: JsonObject, configPanel: JsonObject[]) => ({
    id, version: 1, title, icon, category, defaults, configPanel, has_server_resolver: !["portal.project_header", "portal.next_steps", "portal.next_appointment", "portal.photo_strip"].includes(id)
  });
  return [
    widget("portal.project_header", "Project header", "fa-house-chimney", "portal", { config: { show_contact: true }, frame: { w: 560, h: 120 } }, [
      { key: "show_contact", label: "Show contact details", kind: "toggle" }
    ]),
    widget("portal.next_steps", "Next steps", "fa-list-check", "portal", { config: { title: "Next steps" }, frame: { w: 360, h: 260 } }, titleFields),
    widget("portal.next_appointment", "Next visit", "fa-calendar-day", "portal", { config: { title: "Your next visit" }, frame: { w: 360, h: 220 } }, titleFields),
    widget("portal.photo_strip", "Recent photos", "fa-images", "portal", { config: { title: "Recent photos" }, frame: { w: 560, h: 180 } }, titleFields),
    widget("portal.activity_feed", "Project updates", "fa-timeline", "portal", { config: { title: "Project updates", source_mode: "automatic", layout: "timeline", limit: 10, days_back: 0, show_dates: true, show_details: true, newest_first: true, event_types: [], manual_entries: [] }, frame: { w: 520, h: 360 } }, titleFields.concat([
      { key: "source_mode", label: "Updates", kind: "select", options: [["automatic", "Project activity"], ["manual", "Manual updates"], ["hybrid", "Project + manual"]] },
      { key: "layout", label: "Layout", kind: "select", options: [["timeline", "Timeline"], ["cards", "Cards"], ["compact", "Compact"]] },
      { key: "limit", label: "Entries", kind: "number", min: 1, max: 50 }, { key: "days_back", label: "Only the last (days)", kind: "number", min: 0, max: 3650 },
      { key: "show_dates", label: "Show dates", kind: "toggle" }, { key: "show_details", label: "Show details", kind: "toggle" }, { key: "newest_first", label: "Newest first", kind: "toggle" },
      { key: "event_types", label: "Event types (blank = all)", kind: "list" },
      { key: "manual_entries", label: "Manual updates", kind: "list", itemLabel: "Update", itemFields: [{ key: "label", label: "Headline", kind: "text" }, { key: "detail", label: "Details", kind: "text" }, { key: "date", label: "Date", kind: "text" }, { key: "icon", label: "Icon class", kind: "text" }] }
    ])),
    widget("portal.team", "Meet the team", "fa-people-group", "portal", { config: { title: "Meet your team", source_mode: "automatic", layout: "cards", columns: 3, photo_shape: "round", show_role: true, show_bio: false, limit: 12, selected_user_ids: [], manual_members: [] }, frame: { w: 560, h: 320 } }, titleFields.concat([
      { key: "source_mode", label: "People", kind: "select", options: [["automatic", "Assigned team"], ["manual", "Manual people"], ["hybrid", "Assigned + manual"]] }, { key: "selected_user_ids", label: "Selected users", kind: "list", itemLabel: "User", itemFields: [{ key: "user_id", label: "User", kind: "select", options: userOptions }] },
      { key: "layout", label: "Layout", kind: "select", options: [["cards", "Cards"], ["list", "Compact list"]] }, { key: "columns", label: "Columns", kind: "number", min: 1, max: 4 }, { key: "photo_shape", label: "Photo shape", kind: "select", options: [["round", "Round"], ["square", "Rounded square"]] },
      { key: "show_role", label: "Show roles", kind: "toggle" }, { key: "show_bio", label: "Show bios", kind: "toggle" }, { key: "limit", label: "Maximum people", kind: "number", min: 1, max: 24 },
      { key: "manual_members", label: "Manual people", kind: "list", itemLabel: "Person", itemFields: [{ key: "name", label: "Name", kind: "text" }, { key: "role", label: "Role", kind: "text" }, { key: "bio", label: "Bio", kind: "text" }, { key: "photo", label: "Photo", kind: "media", accept: "image/*" }] }
    ])),
    widget("portal.portfolio", "Before & after", "fa-images", "portal", { config: { title: "Before & after", source_mode: "automatic", layout: "slider", columns: 2, limit: 4, before_tag: "before", after_tag: "after", show_labels: true, show_captions: true, manual_pairs: [] }, frame: { w: 560, h: 380 } }, titleFields.concat([
      { key: "source_mode", label: "Photos", kind: "select", options: [["automatic", "Tagged project photos"], ["manual", "Manual pairs"], ["hybrid", "Manual + tagged"]] }, { key: "layout", label: "Layout", kind: "select", options: [["slider", "Comparison slider"], ["grid", "Side-by-side grid"], ["stack", "Full-width stack"]] },
      { key: "columns", label: "Grid columns", kind: "number", min: 1, max: 4 }, { key: "limit", label: "Pairs shown", kind: "number", min: 1, max: 24 }, { key: "before_tag", label: "Before tag", kind: "text" }, { key: "after_tag", label: "After tag", kind: "text" }, { key: "show_labels", label: "Show Before / After labels", kind: "toggle" }, { key: "show_captions", label: "Show captions", kind: "toggle" },
      { key: "manual_pairs", label: "Manual pairs", kind: "list", itemLabel: "Pair", itemFields: [{ key: "label", label: "Title", kind: "text" }, { key: "caption", label: "Caption", kind: "text" }, { key: "before", label: "Before image", kind: "media", accept: "image/*" }, { key: "after", label: "After image", kind: "media", accept: "image/*" }] }
    ])),
    widget("portal.welcome_video", "Welcome video", "fa-circle-play", "portal", { config: { media: null, autoplay: false }, frame: { w: 560, h: 340 } }, titleFields.concat([{ key: "media", label: "Video", kind: "media", accept: "video/*" }, { key: "caption", label: "Caption", kind: "text" }, { key: "autoplay", label: "Autoplay (muted)", kind: "toggle" }])),
    widget("portal.nearby_jobs", "Nearby projects", "fa-map-location-dot", "portal", { config: { title: "Work near you", radius_miles: 10, limit: 8, selection_mode: "automatic", selected_project_ids: [], project_types: [], statuses: ["active", "completed"], layout: "map_list", show_thumbnails: true }, frame: { w: 560, h: 440 } }, titleFields.concat([{ key: "selection_mode", label: "Projects", kind: "select", options: [["automatic", "Showcase-enabled projects"], ["selected", "Selected projects"], ["hybrid", "Showcase-enabled + selected"]] }, { key: "selected_project_ids", label: "Selected projects", kind: "list", itemLabel: "Project", itemFields: [{ key: "project_id", label: "Project", kind: "select", options: projectOptions }] }, { key: "radius_miles", label: "Radius (miles)", kind: "number", min: .5, max: 100, step: .5 }, { key: "limit", label: "Projects shown", kind: "number", min: 1, max: 30 }, { key: "project_types", label: "Project types (blank = all)", kind: "list" }, { key: "statuses", label: "Project statuses", kind: "list" }, { key: "layout", label: "Layout", kind: "select", options: [["map_list", "Map + project cards"], ["map", "Map"], ["list", "Project cards"]] }, { key: "show_thumbnails", label: "Show project photos", kind: "toggle" }]))
  ];
}

export const registerWebsitesApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
    }
    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      reply.code(Number((error as { statusCode: number }).statusCode));
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "websites",
    message: "websites API is mounted",
    endpoints: {
      sites: "/organizations/:orgId/sites",
      site: "/organizations/:orgId/sites/:siteId",
      catalog: "/organizations/:orgId/sites/:siteId/catalog",
      pages: "/organizations/:orgId/sites/:siteId/pages",
      publicManifest: "/public/site/:siteKey/manifest",
      publicPage: "/public/site/:siteKey/page/:slugOrRole",
      publicHost: "/public/host/:hostname/resolve",
      portalPages: "/public/portal/:portalUuid/pages"
    }
  }));

  // -------------------------------------------------------------------------
  // Sites
  // -------------------------------------------------------------------------

  app.get("/organizations/:orgId/sites", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...READ_AUTH });
    await ensureDefaultWebsites(orgId, ctx);
    const sites = await siteListing(orgId);
    return { ok: true, sites, count: sites.length };
  });

  app.post("/organizations/:orgId/sites", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = createSiteSchema.parse(request.body ?? {});
    const site = await createPublicSite(orgId, body.name, ctx);
    reply.code(201);
    return { ok: true, site };
  });

  app.get("/organizations/:orgId/sites/:siteId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...READ_AUTH });
    await ensureDefaultWebsites(orgId, ctx);
    const detail = await siteDetail(orgId, getParam(request.params, "siteId"));
    return { ok: true, site: detail.site, pages: detail.pages, system_pages: detail.system_pages };
  });

  app.patch("/organizations/:orgId/sites/:siteId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = patchSiteSchema.parse(request.body ?? {});
    const site = await patchSite(orgId, getParam(request.params, "siteId"), body, ctx);
    return { ok: true, site };
  });

  app.delete("/organizations/:orgId/sites/:siteId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const site = await archiveSite(orgId, getParam(request.params, "siteId"), ctx);
    return { ok: true, site };
  });

  /** Editor palette: web widgets (per-org options baked in) + curated doc widgets + fonts + lead forms. */
  app.get("/organizations/:orgId/sites/:siteId/catalog", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, ...READ_AUTH });
    const site = await readSite(orgId, getParam(request.params, "siteId"));
    const capabilityState = await documentCapabilityState(orgId);
    const leadForms = await leadFormsForOrg(orgId);
    const pageOptions = (await listSitePages(orgId, cleanText(site.id)))
      .filter((page) => cleanText(page.role || "page") === "page")
      .map((page) => [cleanText(page.id), cleanText(page.title) || "Untitled page"] as [string, string]);
    const userOptions: Array<[string, string]> = String(site.site_kind) === "customer_portal"
      ? (await listDocuments(orgId, "users").catch(() => [])).map((record) => {
          const data = asObject(record.data);
          const profile = asObject(data.profile);
          return [cleanText(record.id), cleanText(data.name || data.full_name || profile.name || data.email || record.id)] as [string, string];
        }).filter(([id]) => Boolean(id))
      : [];
    const projectOptions: Array<[string, string]> = String(site.site_kind) === "customer_portal"
      ? (await listDocuments(orgId, "projects").catch(() => [])).map((record) => {
          const data = asObject(record.data);
          return [cleanText(record.id), cleanText(data.project_title || data.title || data.address || record.id)] as [string, string];
        }).filter(([id]) => Boolean(id))
      : [];
    const curated = DOCUMENT_WIDGET_CATALOG.filter((descriptor) => WEBSITE_DOC_WIDGET_IDS.includes(String(descriptor.id))).map((descriptor) => {
      const capability = widgetCapability(descriptor.id);
      return capability && !documentCapabilityEnabled(capabilityState, capability)
        ? { ...descriptor, ...capabilityDisabledPatch(capability) }
        : descriptor;
    });
    return {
      ok: true,
      capabilities: capabilityState.effectiveByKey,
      widgets: [...webWidgetCatalog(leadForms, pageOptions), ...curated, ...(String(site.site_kind) === "customer_portal" ? portalWidgetCatalog(userOptions, projectOptions) : [])],
      fonts: DOCUMENT_FONTS,
      lead_forms: leadForms
    };
  });

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  app.post("/organizations/:orgId/sites/:siteId/pages", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = createPageSchema.parse(request.body ?? {});
    const page = await createSitePage(orgId, getParam(request.params, "siteId"), body, ctx);
    reply.code(201);
    return { ok: true, page };
  });

  app.get("/organizations/:orgId/sites/:siteId/pages/:pageId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, ...READ_AUTH });
    const site = await readSite(orgId, getParam(request.params, "siteId"));
    const page = await readPage(orgId, getParam(request.params, "pageId"));
    if (String(page.website_id || "") !== String(site.id || "")) {
      throw notFound("website_page_not_found", "The requested website page was not found.");
    }
    return { ok: true, page: { ...page, has_unpublished_changes: await pageHasUnpublishedChanges(orgId, page) } };
  });

  app.patch("/organizations/:orgId/sites/:siteId/pages/:pageId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = patchPageSchema.parse(request.body ?? {});
    const page = await patchSitePage(orgId, getParam(request.params, "siteId"), getParam(request.params, "pageId"), body, ctx);
    return { ok: true, page };
  });

  app.delete("/organizations/:orgId/sites/:siteId/pages/:pageId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const page = await deleteSitePage(orgId, getParam(request.params, "siteId"), getParam(request.params, "pageId"), ctx);
    return { ok: true, page };
  });

  app.put("/organizations/:orgId/sites/:siteId/pages/:pageId/draft", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = saveDraftSchema.parse(request.body ?? {});
    const page = await saveSitePageDraft(
      orgId,
      getParam(request.params, "siteId"),
      getParam(request.params, "pageId"),
      body.definition as Record<string, unknown>,
      Number(body.expected_revision || 0),
      ctx
    );
    return { ok: true, page };
  });

  app.post("/organizations/:orgId/sites/:siteId/pages/:pageId/publish", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = publishPageSchema.parse(request.body ?? {});
    const page = await publishSitePage(orgId, getParam(request.params, "siteId"), getParam(request.params, "pageId"), Number(body.expected_revision || 0), ctx);
    reply.code(201);
    return { ok: true, page };
  });

  app.post("/organizations/:orgId/sites/:siteId/pages/:pageId/discard-draft", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = discardDraftSchema.parse(request.body ?? {});
    const page = await discardSitePageDraft(orgId, getParam(request.params, "siteId"), getParam(request.params, "pageId"), Number(body.expected_revision || 0), ctx);
    return { ok: true, page };
  });

  app.post("/organizations/:orgId/sites/:siteId/pages/:pageId/restore", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = restorePageSchema.parse(request.body ?? {});
    const page = await restoreSitePageVersion(
      orgId,
      getParam(request.params, "siteId"),
      getParam(request.params, "pageId"),
      Number(body.version),
      Number(body.expected_revision || 0),
      ctx
    );
    return { ok: true, page };
  });

  app.get("/organizations/:orgId/sites/:siteId/pages/:pageId/versions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, ...READ_AUTH });
    const versions = await listSitePageVersions(orgId, getParam(request.params, "siteId"), getParam(request.params, "pageId"));
    return { ok: true, versions, count: versions.length };
  });

  app.get("/organizations/:orgId/sites/:siteId/pages/:pageId/versions/:version", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, ...READ_AUTH });
    const versionNumber = Number(getParam(request.params, "version"));
    if (!Number.isFinite(versionNumber) || versionNumber <= 0) {
      throw badRequest("invalid_version", "Version must be a positive integer.");
    }
    const version = await readSitePageVersion(orgId, getParam(request.params, "siteId"), getParam(request.params, "pageId"), versionNumber);
    return { ok: true, version };
  });

  /** Live resolution for the editor/preview. */
  app.post("/organizations/:orgId/sites/:siteId/pages/:pageId/resolve", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, ...WRITE_AUTH });
    const body = resolvePageSchema.parse(request.body ?? {});
    const site = await readSite(orgId, getParam(request.params, "siteId"));
    const page = await readPage(orgId, getParam(request.params, "pageId"));
    if (String(page.website_id || "") !== String(site.id || "")) {
      throw notFound("website_page_not_found", "The requested website page was not found.");
    }
    const resolved = await resolveSitePage(orgId, site, page, body.source === "published" ? "published" : "draft");
    return {
      ok: true,
      definition: resolved.definition,
      widget_data: resolved.widget_data,
      theme_vars: resolved.theme_vars,
      site_context: resolved.site_context
    };
  });

  // -------------------------------------------------------------------------
  // Public (no auth) — site_key routes
  // -------------------------------------------------------------------------

  app.get("/public/host/:hostname/resolve", async (request) => {
    return { ok: true, ...(await publicHostResolution(getParam(request.params, "hostname"))) };
  });

  app.get("/public/site/:siteKey/manifest", async (request) => {
    const manifest = await publicSiteManifest(getParam(request.params, "siteKey"));
    return { ok: true, ...manifest };
  });

  app.get("/public/site/:siteKey/page/:slugOrRole", async (request) => {
    const payload = await publicSitePagePayload(getParam(request.params, "siteKey"), getParam(request.params, "slugOrRole"));
    return { ok: true, ...payload };
  });

  // -------------------------------------------------------------------------
  // Public (no auth) — customer-portal injection. Accepts both live
  // public_uuid and staff preview_uuid; gated on web_editor.portal_pages.
  // -------------------------------------------------------------------------

  app.get("/public/portal/:portalUuid/pages", async (request) => {
    const access = await findPortalAccessByUuid(getParam(request.params, "portalUuid"));
    if (!access) throw notFound("portal_not_found", "The requested customer portal could not be found.");
    if (!(await portalPagesEnabled(access.orgId))) {
      throw notFound("portal_pages_disabled", "Portal pages are not enabled for this organization.");
    }
    const { facts } = await portalRenderContext(access);
    const listing = await listPortalPages(access.orgId, facts);
    return { ok: true, site_key: listing?.site_key || null, pages: listing?.pages || [] };
  });

  app.get("/public/portal/:portalUuid/pages/:pageId", async (request) => {
    const access = await findPortalAccessByUuid(getParam(request.params, "portalUuid"));
    if (!access) throw notFound("portal_not_found", "The requested customer portal could not be found.");
    if (!(await portalPagesEnabled(access.orgId))) {
      throw notFound("portal_pages_disabled", "Portal pages are not enabled for this organization.");
    }
    const pageId = getParam(request.params, "pageId");
    const query = asObject(request.query);
    const { portalContext, facts } = await portalRenderContext(access);
    // Draft source is a staff preview affordance: only reachable through the
    // unguessable preview_uuid, never the live public_uuid. Audience is NOT
    // re-checked here — staff previewing their own targeted page must see it.
    if (access.preview && String(query.source || "") === "draft") {
      const payload = await resolveDraftPagePayload(access.orgId, pageId, portalContext);
      return { ok: true, source: "draft", ...payload };
    }
    const payload = await resolvePublishedPagePayload(access.orgId, pageId, portalContext, facts);
    return { ok: true, source: "published", ...payload };
  });
};

// ---------------------------------------------------------------------------
// Helpers (documents/api.ts conventions)
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}
