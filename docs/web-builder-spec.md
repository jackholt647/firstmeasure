# Web Builder — Architecture & Implementation Contracts

The website builder ("Web Editor") lets an organization build and host websites —
their public marketing site(s) and custom pages for the customer portal — using
the SAME document-engine libraries (`FMDocModel` / `FMDocRenderer` /
`FMDocWidgets` / `FMDocEditor`) that power documents. No forks: website pages are
`kind: "view"` DocModels, edited with a new `website` editor profile, rendered by
the one shared renderer.

Companions: `docs/document-engine-spec.md`, `docs/document-engine-contracts.md`
(binding for the shared libraries — additive changes here must be reflected
there).

## 0. Vocabulary + top-level decisions

- **Site** — an org-owned website. Two kinds: `public` (marketing site; an org
  may have several) and `customer_portal` (exactly one, blessed, auto-created;
  its pages inject into the customer portal as extra tabs).
- **Page** — a named, slugged `kind:"view"` DocModel belonging to a site.
  Roles: `page` (regular), `header`, `footer` (blessed chrome pages on public
  sites; auto-created, not deletable, excluded from menus, they *render* the
  menus).
- **Draft vs live** — every page has exactly one mutable **draft** definition
  and a pointer to one immutable **published version**. Editing always writes
  the draft; publishing freezes the draft as version N+1 and moves the live
  pointer. Full version history is kept; any old version can be restored INTO
  the draft (never directly to live). New pages start as draft-only
  (`published_version: 0`) and cannot appear on the live site until first
  published.
- **Enabled** — separate from publishing: a published page can be toggled
  on/off on the live site. Draft-only pages are never live regardless.
- **Hosting (v1)** — sites are served from a subdirectory of the existing app:
  `/sites/<site_key>/[<page-slug>]`, where `site_key` is a compact unique key
  (`s` + 10 hex). All intra-site links are built from a runtime `basePath`, so
  the same published site works unchanged when custom domains / platform
  subdomains are attached later (basePath becomes `/`). The **host registry**
  (§4) is the future domain-attachment seam.
- **Rendering (v1)** — client-side: a PHP shell + `firstmate-site-runtime.js`
  fetch the published payload and render with `FMDocRenderer` (interactive
  mode, so widgets like lead forms work). Mobile = proportional scaling of the
  design width (Canva-site behavior), via `handle.setScale`. SSR/static
  publish and true responsive reflow are future work — the payload shape
  (resolved definition + widget data) is already what an SSR pass would
  consume, so nothing here boxes that in.

## 1. Data model (backend `public/v1/websites/`, mounted at `/v1/websites`)

Collections (add to `PlatformCollection` + `COLLECTIONS` in
`public/v1/platform/storage.ts`): `websites`, `website_pages`,
`website_page_versions`, `website_events`.

### Site record (`websites` collection), `data`:

```jsonc
{
  "schema_version": 1,
  "id": "site_<20 hex>",
  "kind": "website",
  "site_kind": "public" | "customer_portal",
  "name": "Main Website",
  "status": "active" | "archived",          // customer_portal site can never archive
  "site_key": "s0123456789",                 // public URL key, unique platform-wide (host registry)
  "home_page_id": "page_...",                // must be a role:"page" page
  "header_page_id": "page_..." | null,       // public sites only
  "footer_page_id": "page_..." | null,
  "domains": [],                             // future: [{ host, kind: "custom"|"platform_subdomain", status }]
  "settings": {
    "design_width_pt": 720,                  // 960px default design width for new pages
    "theme_vars": {},                        // CSS var overrides layered over org branding
    "chat": { "enabled": false, "widget_key": "" },   // site-global chat embed
    "seo": { "title": "", "description": "" }
  },
  "created_by_user_id": "...", "updated_by_user_id": "...",
  "created_at": "...", "updated_at": "..."
}
```

### Page record (`website_pages`), `data`:

```jsonc
{
  "schema_version": 1,
  "id": "page_<20 hex>",
  "website_id": "site_...",
  "title": "About Us",
  "slug": "about",                 // unique per site, kebab-case; null for header/footer roles
  "role": "page" | "header" | "footer",
  "enabled": false,                // live-site visibility (only meaningful when published_version > 0)
  "nav": { "header": true, "footer": false, "order": 2 },  // menu placement; for the
                                   // customer_portal site, nav.header === "show as portal tab"
  "draft": {
    "definition": { /* DocModel, kind: "view" */ },
    "checksum": "<sha256>",        // FMDocModel definition checksum (same fn as documents)
    "based_on_version": 0,         // version the draft was last synced from (0 = new page)
    "updated_at": "...", "updated_by_user_id": "..."
  },
  "published_version": 0,          // 0 = never published (page is draft-only)
  "seo": { "title": "", "description": "" },
  "created_at": "...", "updated_at": "..."
}
```

### Version record (`website_page_versions`), `data` — immutable:

```jsonc
{ "schema_version": 1, "id": "<deterministic: page_version_<sha256(orgId:page:version).slice(0,20)>>",
  "website_id": "...", "page_id": "...", "version": 3,
  "definition": { }, "checksum": "...",
  "published_at": "...", "published_by_user_id": "...", "locked": true }
```

Mirror the documents versioned-asset engine (`public/v1/documents/storage.ts:83-288`)
— copy the pattern, do not import module-privates. Deterministic version ids
allow O(1) reads without directory scans. `expected_revision` guards on every
page write (envelope `revision`), returning `conflict("website_revision_conflict")`.

### Lifecycle rules

- **Save draft** (`PUT .../draft`): validates `kind === "view"` via
  `FMDocModel.validateDocument`, recomputes checksum, bumps envelope revision.
  Never touches live.
- **Publish** (`POST .../publish`): draft → new immutable version row,
  `published_version = N+1`, `draft.based_on_version = N+1`. Emits
  `website.page.published`.
- **Discard draft** (`POST .../discard-draft`): copies the published version's
  definition back into the draft (404-equivalent error if never published).
- **Restore** (`POST .../restore { version }`): copies that version's
  definition into the DRAFT (draft.based_on_version = that version). Live is
  untouched until the user publishes.
- **Unpublished changes indicator**: `draft.checksum !== <published version
  checksum>` or `published_version === 0`. API list responses include a
  computed `has_unpublished_changes` boolean per page.
- **Delete page** (`DELETE`): hard-deletes page + versions; forbidden for
  roles `header`/`footer`, for the home page, and for customer_portal system
  behavior. Emits `website.page.deleted`.
- **Home page**: `PATCH site { home_page_id }`; must reference an existing
  role:"page" page of that site. The live site serves home at the bare site
  URL; the home page's own slug also works.

### Blessed content

- `ensureDefaultWebsites(orgId)` — lazy, called from site list/read routes
  (mirror `ensureDefaultDocumentAssets` seeding pattern incl. in-process TTL
  cache): creates (a) the `customer_portal` site (name "Customer Portal") and
  (b) one `public` site (name "Main Website") with starter Home (published +
  enabled + set as home), Header, Footer pages. Starter definitions live in
  `seeds.ts` — simple, branded, org-name-aware (hero section, nav menu widget
  in header, footer text). The customer_portal site gets NO header/footer
  pages (the portal has its own chrome) and its starter state has no pages.
- **System pages** (customer_portal site only): the built-in portal tabs
  (Summary, Schedule, Photos, Checklists, Proposals, Documents, Payments) are
  NOT page records. `GET sites/:siteId` returns them as a `system_pages: [{
  id, title, description, icon }]` array from a constant in the websites
  module, so the Web Editor can show them as read-only tiles. This is
  deliberately data-driven so later they can graduate to configurable records
  without API shape changes.

## 2. Backend routes (`registerWebsitesApi`, prefix `/v1/websites`)

Follow `documents/api.ts` conventions exactly: per-plugin `setErrorHandler`
(ZodError→400, PlatformError→status), zod body schemas in `schemas.ts`,
`requirePlatformAuth`. Reads: `{ orgId, permission: "view_projects|manage_company_settings",
capability: "apps.web_editor" }`. Writes: `{ orgId, csrf: true, permission:
"manage_company_settings", capability: "apps.web_editor" }`. Public routes: no auth.

```
GET    /                                                       health/info
GET    /organizations/:orgId/sites                             (lazy-seeds; returns sites + per-site page counts)
POST   /organizations/:orgId/sites                             { name } → creates public site + starter pages
GET    /organizations/:orgId/sites/:siteId                     site + pages[] (with has_unpublished_changes) + system_pages
PATCH  /organizations/:orgId/sites/:siteId                     { name?, home_page_id?, settings?, status?, expected_revision }
DELETE /organizations/:orgId/sites/:siteId                     archive (forbidden for customer_portal kind)
GET    /organizations/:orgId/sites/:siteId/catalog             { widgets, fonts, lead_forms } — editor palette; web.* widget
                                                               defs get per-org configPanel options baked in (e.g. lead form select)
POST   /organizations/:orgId/sites/:siteId/pages               { title, slug? } → new draft page (auto-slug from title)
GET    /organizations/:orgId/sites/:siteId/pages/:pageId       full page record
PATCH  /organizations/:orgId/sites/:siteId/pages/:pageId       { title?, slug?, enabled?, nav?, seo?, expected_revision }
DELETE /organizations/:orgId/sites/:siteId/pages/:pageId
PUT    /organizations/:orgId/sites/:siteId/pages/:pageId/draft { definition, expected_revision }
POST   /organizations/:orgId/sites/:siteId/pages/:pageId/publish        { expected_revision }
POST   /organizations/:orgId/sites/:siteId/pages/:pageId/discard-draft  { expected_revision }
POST   /organizations/:orgId/sites/:siteId/pages/:pageId/restore        { version, expected_revision }
GET    /organizations/:orgId/sites/:siteId/pages/:pageId/versions
GET    /organizations/:orgId/sites/:siteId/pages/:pageId/versions/:version
POST   /organizations/:orgId/sites/:siteId/pages/:pageId/resolve        { source: "draft"|"published" }
       → { definition (resolved), widget_data, theme_vars, site_context }   (editor/preview live resolution)

Public (no auth, CORS-friendly like /v1/chat/public):
GET    /public/site/:siteKey/manifest
       → { name, home_slug, base_path, pages: [{ slug, title, in_header, in_footer, order }],
           header_published: bool, footer_published: bool,
           branding: { colors, logo_url }, theme_vars, chat: { widget_key|null }, seo }
GET    /public/site/:siteKey/page/:slugOrRole
       :slugOrRole = page slug | "~home" | "~header" | "~footer"
       → { page: { slug, title, seo }, definition (resolved), widget_data, theme_vars }
       404 for unpublished/disabled pages. Serves the PUBLISHED version only.
GET    /public/portal/:portalUuid/pages          (customer-portal injection; §6)
GET    /public/portal/:portalUuid/pages/:pageId  → same shape as public page payload
```

### Resolution pipeline (`service.ts`)

Reuse the documents approach (`resolveDocumentInstance`, `documents/service.ts:1101`)
in miniature: load definition (draft or version) → `FMDocModel.resolveBindings`
with scope `{ params, org, site }` → resolve `web.*` widget data via the shared
server widget-resolver registry (`registerDocumentWidgetResolver` — reuse the
SAME registry from `documents/widgets/registry.ts`; register `web.*` resolvers
from the websites module at import time) → attach media URLs → theme vars.

**Theme var layering** (matches the documents branding gotcha): base =
`readGlobal(orgId).data.branding` colors → site `settings.theme_vars`
overrides. Emit as `theme_vars` (CSS custom property map: `--fm-primary`,
`--fm-secondary`, `--fm-accent` + rgb variants) in every resolve/public
payload; clients pass it as `themeContext.overrides`.

### Server widget resolvers (registered by websites module)

- `web.nav_menu` → `{ links: [{ slug, title, href }], source }` built from the
  site's published+enabled nav pages. `href` is basePath-relative (`./` +
  slug); the runtime finalizes with its basePath.
- `web.lead_form` → `{ form_id, form_title, available: bool }` (validates the
  form exists via lead-intake storage; render is client-side).

### Events

Register in `public/v1/work/events.ts`: `website.site.created`,
`website.page.published`, `website.page.restored`, `website.page.deleted`,
`website.page.enabled`, `website.page.disabled` (visibility `system`).
Local audit rows in `website_events` via a `recordWebsiteEvent` mirroring
`recordDocumentEvent` (`documents/storage.ts:518`).

### Capabilities (`public/v1/platform/capability_defs.ts`)

```ts
{ key: "apps.web_editor", kind: "app", category: "Platform & Appearance",
  label: "Web Editor", description: "Visual website builder: host public websites and design custom customer-portal pages.",
  default: false, runtime_app_id: "web-editor" },
{ key: "web_editor.public_sites", kind: "feature", parent: "apps.web_editor",
  label: "Public websites", default: true, description: "Build and host public marketing websites." },
{ key: "web_editor.portal_pages", kind: "feature", parent: "apps.web_editor",
  label: "Customer portal pages", default: true, description: "Inject custom published pages into the customer portal as tabs." },
{ key: "web_editor.custom_domains", kind: "feature", parent: "apps.web_editor",
  label: "Custom domains", default: false, description: "Attach custom domains or platform subdomains to hosted sites." }
```

`web_editor.portal_pages` is checked server-side (org capability value, not a
request ctx) inside the portal payload builder and the `/public/portal/*`
routes.

## 3. Host registry (`{platformStorageRoot}/config/website_hosts.json`)

The cross-org lookup index for public serving — and the future domain seam.

```jsonc
{ "schema_version": 1,
  "site_keys": { "<site_key>": { "org_id": "...", "site_id": "..." } },
  "domains":   { "<host>":     { "org_id": "...", "site_id": "..." } } }   // future
```

Module-owned helper in `websites/storage.ts`: atomic read/modify/write (same
atomic-write pattern as platform storage), in-process cache with mtime check.
Entries written on site creation, removed on archive. Public resolution:
site_key → entry → `readDocument(org, "websites", site_id)` — O(1), no
platform-wide scan (deliberately unlike `findPublicDocumentSnapshot`).

## 4. Public hosting shell

- **`public/sites/index.php`** — front controller (pattern:
  `customer_portal/index.php`). Parses `REQUEST_URI` after `/sites/` into
  `<siteKey>[/<pageSlug>]` (sanitize `[^a-zA-Z0-9_-]`), computes
  `$assetVer` from mtimes, emits the shell: viewport meta,
  `window.__FM_SITE = { siteKey, pageSlug, basePath: "/sites/<siteKey>/", apiBase }`,
  loads `../fonts.css`, doc-model, doc-widgets, doc-renderer, web-widgets,
  site-runtime (root-relative `../libraries/...` paths). No auth. apiBase uses
  the same localhost `:3101` switch as `customer_portal/index.php:19-25`.
- **`nginx/nginx.conf.template`** — add above `location /`:
  `location ^~ /sites/ { try_files $uri $uri/ /sites/index.php?$query_string; }`
- **`router.php`** (PHP built-in server fallback) — route any `/sites/...`
  path without a real file to `public/sites/index.php`.
- **`public/libraries/site-runtime/firstmate-site-runtime.js`** (global
  `FirstMateSiteRuntime`) — `boot(config)` reads `window.__FM_SITE`:
  1. Fetch manifest + page payload (parallel; `credentials: 'omit'`).
  2. Render header (if published) + page + footer stacked via
     `FMDocRenderer.render(..., { mode: "interactive", themeContext: { overrides: theme_vars } })`.
  3. Responsive: observe container width; `handle.setScale(min(1, containerWidth / designWidthPx))`
     per section (ResizeObserver).
  4. Link handling: intercept `[data-fm-link-page]` / relative page links →
     `basePath + slug` navigation (full page loads; no SPA router in v1).
  5. Document title + meta description from page seo (fallback site seo).
  6. Chat: if `manifest.chat.widget_key`, inject
     `libraries/chat-embed/firstmate-chat-embed.js` with that key.
  7. 404 page: friendly built-in "Page not found" panel.

## 5. Shared library changes (ADDITIVE — update `docs/document-engine-contracts.md`)

### doc-editor (`firstmate-doc-editor.js`)

1. **`FMDocEditor.registerProfile(name, flags, { rank })`** — public API to add
   profiles without editing the library; validates flag keys against
   `FEATURE_KEYS`.
2. **Built-in `website` profile** (registered in-library):
   `{ free_transform:true, rotate:true, resize:true, shapes:true, images:true,
   filters:true, text_style:true, widget_insert:true, page_manage:false,
   group:true, z_order:true, theme_edit:false, bind_edit:false, unlock:false }`,
   rank between `document` and `designer`. `insertTabAvailable()` becomes
   flag-driven (`can("widget_insert") || can("shapes") || can("images")`)
   instead of profile-name-driven.
3. **View-doc fixes**: double-click-to-insert works when `currentPageId` is
   null (view docs); `zoom("fit-width")` measures the view root correctly.
4. **`viewportWidth` option + `editor.setViewportWidth(px|null)`** — view docs
   only: constrains the stage to a pixel width and rescales (mobile preview).
   Emits `viewport` event.
5. **Link editing**: inspector field (all profiles with `text_style` or
   website) writing `node.props.link` (see below).

### doc-model (`firstmate-doc-model.js`)

- `node.props.link = { href?, page?, target? }` — additive, allowed on any
  node type; validation accepts it. `page` is a site-page slug resolved by the
  host at render time.

### doc-renderer (`firstmate-doc-renderer.js`)

- Nodes with `props.link` render wrapped in `<a class="fmdoc-link">`
  (interactive AND static modes; documents/PDFs benefit too). `href`
  resolution: `props.link.href`, or `widgetContext.resolvePageHref(page)` when
  the host supplies it (site runtime + portal do; documents don't → plain
  href only).

### web-widgets (`public/libraries/web-widgets/firstmate-web-widgets.js`) — NEW

Registers into the SAME `FMDocWidgets` registry (loads after doc-widgets):

- `web.lead_form` — category `input`, config `{ form_id }`. Interactive:
  mounts `FirstMateLeadEmbed.render({ formId, target })` (lazy-loads
  `libraries/lead-embed/firstmate-lead-embed.js` if absent). Static/editor
  placeholder: labeled form card. configPanel `form_id` select — options baked
  by the server catalog per-org.
- `web.nav_menu` — category `layout`, config `{ source: "header"|"footer",
  layout: "horizontal"|"vertical", align, gap_pt, link_style }`. Renders from
  `ctx.data.links` (server-resolved); editor fallback renders from
  `ctx.scope.site?.nav` or a placeholder.

CSS embedded + self-injected (`<style id="fm-web-widgets-styles">`) per the
library CSS rule.

## 6. Customer portal injection

**Server** (`public/v1/platform/api.ts`, payload builder
`publicCustomerPortalPayload` ~line 5407): when org capability
`web_editor.portal_pages` is effectively on AND the org's customer_portal site
has published+enabled pages, add top-level:

```jsonc
"portal_pages": { "site_key": "s...", "pages": [{ "id", "slug", "title", "order" }] }
```

(pages sorted by `nav.order`; only `nav.header: true` pages appear as tabs —
that flag means "show as portal tab" on the portal site). Content is NOT
inlined — refs only, like `resources.documents`. Import the page-listing
helper from the websites module (`listPortalPages(orgId)`), not a
reimplementation.

**Client** (`public/customer_portal/customer_portal.js`):

- `tabs()` (~line 785): append `portal_pages.pages` as
  `{ id: "page:" + slug, label: title, kind: "custom", pageId }` — existing
  `.some(tab => tab.id === ...)` guards keep working.
- `activeTabHtml` chain: `id.startsWith("page:")` → `<div class="cp-custom-page"
  id="cpCustomPage" data-page-id="...">` stub.
- Post-render hydration: `mountCustomPage()` — fetch
  `GET /v1/websites/public/portal/:portalUuid/pages/:pageId` (cache per page
  id in state), render via `FMDocRenderer.render(..., mode: "interactive",
  themeContext: { overrides: theme_vars })`, responsive scale like the site
  runtime. Portal already loads doc-model/doc-widgets/doc-renderer; ALSO add
  web-widgets to the portal script list in both `index.php` and `preview.php`.
- Preview mode: works as-is (staff session); `track('tab_opened')` fires
  generically.
- The portal route accepts BOTH live `public_uuid` and `preview_uuid`
  (preview additionally allows draft source `?source=draft` for staff
  sessions — used by the Web Editor's "portal preview").

Keep the tab injection data-driven end-to-end: the client renders whatever
`portal_pages.pages` says; ordering/labels/gating all server-side. This is the
seam that later grows into full portal tab configuration (blessed tabs
becoming configurable), so do not hardcode anything about custom pages beyond
the `page:` id prefix.

## 7. Web Editor app (`public/libraries/apps/web-editor/`)

Files: `app.js` (IIFE, guard on `FirstMateApps` runtime), `web-editor.css`
(sibling, injected via `ensureStyles()` pattern), client
`public/libraries/websites-api/websites-api.js` (global `WebsitesAPI`, clone
of documents-api request core, baseUrl swap `/v1/platform` → `/v1/websites`,
public calls `credentials: 'omit'`).

Registration: manifest entry (`firstmate-apps-manifest.js`) `id:
"portal.web_editor"`, package `web-editor`, `kind: "portal_tab"`,
`portalTabId: "web_editor"`, title "Web Editor", `terminologyKey:
"web_editor.tab"`, icon `fa-globe`, `access: managementAccess`, `fullBleed`,
bundles: websites-api, doc-model, doc-widgets, doc-renderer, web-widgets,
doc-editor, `web-editor/app.js`. `appCapabilities["portal.web_editor"] =
"apps.web_editor"`. Route params under `nestedRouteParams["web-editor"]`:
`{ tab: { default: "web_editor", history: "push" }, site: { history: "push" },
page: { history: "push" }, view: { history: "replace" } }`. Bundle
self-registers via `runtime.registerApp({ ..., fullBleed: true, mount })`
(follow `documents/studio.js:1435`). Eager script tag in
`public/portal/index.php` near the other app bundles.

### Views (single `render()` + delegated events, studio.js conventions;
FirstMate design language: FontAwesome, `--primary` tokens, 800+ weights,
uppercase micro-labels, #e4e7ec borders)

1. **Site list** — cards for each site (name, kind badge — the customer
   portal site gets a distinct "Customer Portal" badge, page count, live URL
   with copy button, "Open site" external link). "+ New website" creates a
   public site.
2. **Site view** — page tiles grid (default; media-feed-like): each tile shows
   a mini page preview (static render of the published-or-draft definition,
   scaled), title, status chips (`Draft`, `Live`, `Live · edited`, `Off`),
   home star, header/footer badges. System pages (portal site) render as
   locked tiles. Toggle to a **list view**: table of pages with columns Name,
   Slug, Status, In header menu (toggle), In footer menu (toggle), Enabled
   (toggle), Home (radio), Updated. "+ New page" prompts for title. Site
   settings drawer: name, home page, chat widget (enabled + key from the org's
   live-chat settings), SEO, theme colors; live URL display. Blessed pages
   (Header/Footer) pinned in their own row on public sites.
3. **Page editor** — full-bleed. Top bar: back, page title (rename inline),
   **Draft/Live segmented toggle** (Live = read-only render of the published
   version; Draft = editable), device toggle (desktop/mobile via
   `setViewportWidth`), History button, Discard-draft, **Publish** button
   (disabled when no unpublished changes; confirm dialog states version
   number), page settings (slug, menus, enabled, SEO), for portal-site pages a
   **"Preview in portal"** toggle that wraps the canvas in the real portal
   chrome (loads `customer_portal.css`, reproduces `.cp-shell/.cp-header/
   .cp-tabs` markup from org branding + tab list so the customer view is
   faithful). Canvas: `FMDocEditor.mount(el, { document: draft, profile:
   "website", mode: "visual", catalog (from site catalog endpoint), media:
   PlatformAPI-backed pick/url bridge, resolveScope: site_context, onChange:
   debounced PUT draft with expected_revision })`. Autosave status chip
   (Saved / Saving… / Conflict → reload prompt).
4. **History panel** — right drawer listing versions (version #, published
   date, publisher), actions: Preview (static render in modal), **Restore to
   draft** (confirm). Wording is explicit that restore edits the draft only.

## 8. Verification

- `public/v1/tests/websites-api.test.ts` + `package.json` script
  `test:websites`: seeding, site CRUD, page create → draft-only invariants,
  draft save + revision conflicts, publish/version history/restore/discard,
  enabled + nav flags, home-page guards, header/footer protections, public
  manifest/page payloads by site_key (404 for unpublished/disabled), portal
  pages listing + capability gate, host registry entries.
- `node --check` all new/edited frontend libraries.
- Browser pass: create site → edit page → publish → visit `/sites/<key>/` →
  portal tab appears → mobile preview.

## 9. Explicit non-goals (v1) — recorded so the API doesn't box them out

- Custom domains / platform subdomains (seam: `site.domains[]` + host
  registry `domains` map + `web_editor.custom_domains` capability).
- SSR / static HTML publish (seam: public page payload is the SSR input).
- True responsive reflow (seam: frame constraints already in the model).
- Portal blessed-tab configuration + portal header/footer editing (seam:
  `system_pages` descriptors + server-driven `portal_pages` injection).
- Per-customer portal page overrides (seam: dormant `customer_portals`
  `settings{}` object).
- Additional data widgets (seam: `web.*` namespace in the shared registry).
