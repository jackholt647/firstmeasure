# Websites module (`/v1/websites`)

Backend for the Web Editor (website builder): org-owned **sites** whose
**pages** are `kind: "view"` DocModels rendered by the shared document-engine
libraries. Binding spec: `docs/web-builder-spec.md` (§§0–3, 6).

## Files

- `api.ts` — `registerWebsitesApi` Fastify plugin (mounted at `/v1/websites`
  in `src/app.ts`). Per-plugin error handler (ZodError→400, PlatformError→
  status), zod schemas from `schemas.ts`.
- `service.ts` — site/page operations, lazy seeding, slug rules, resolution
  pipeline, theme vars, `web.*` widget resolvers, portal contract.
- `storage.ts` — JSON-document CRUD over the platform collections
  (`websites`, `website_pages`, `website_page_versions`, `website_events`),
  deterministic version rows, the host registry, `recordWebsiteEvent`.
- `schemas.ts` — zod bodies + shared `FMDocModel` handle (view-only
  definition validation).
- `seeds.ts` — starter Home / Header / Footer / blank-page DocModel builders
  (org-name aware, colors reference `--fm-primary` theme vars).

## Model

- **Site** (`site_<20hex>`): `site_kind: "public" | "customer_portal"`,
  platform-unique `site_key` (`s`+10 hex), `home/header/footer_page_id`,
  `settings` (design width, theme_vars, chat, seo). The customer_portal site
  is blessed: auto-created, never archived, no chrome pages.
- **Page** (`page_<20hex>`): role `page | header | footer`, kebab-case slug
  unique per site (reserved: header, footer, ~home, ~header, ~footer, sites,
  api; collisions suffix `-2`, `-3`...), mutable `draft`
  (definition/checksum/based_on_version) + immutable published versions.
  `published_version: 0` = draft-only, never live. `enabled` gates live
  visibility separately from publishing. Every write guards
  `expected_revision` → 409 `website_revision_conflict`.
- **Versions**: deterministic ids
  `page_version_<sha256(orgId:website_page:pageId:version).slice(0,20)>` for
  O(1) reads. Publish freezes the draft as N+1; restore/discard copy INTO the
  draft only.
- **Host registry** (`{platformStorageRoot}/config/website_hosts.json`):
  cross-org `site_key → { org_id, site_id }` index (atomic writes, mtime
  cache). Entries added on create, removed on archive. Future domain seam.

## Routes

Org routes under `/organizations/:orgId/sites[...]` (reads:
`view_projects|manage_company_settings` + capability `apps.web_editor`;
writes: CSRF + `manage_company_settings`): site list/create/detail/patch/
archive, per-site `catalog` ({ widgets, fonts, lead_forms } — web widget
configPanels get per-org lead-form options baked in), page CRUD, `draft`,
`publish`, `discard-draft`, `restore`, `versions[/:version]`, `resolve`.

Public (no auth): `GET /public/site/:siteKey/manifest`,
`GET /public/site/:siteKey/page/:slugOrRole` (`~home|~header|~footer` or a
slug; published-only, 404 for disabled), and the portal injection routes
`GET /public/portal/:portalUuid/pages[/:pageId]` (accepts public_uuid AND
preview_uuid; `?source=draft` works only via preview_uuid; gated on the org
capability `web_editor.portal_pages`).

## Contracts consumed elsewhere

- `listPortalPages(orgId)` → `{ site_key, pages: [{ id, slug, title, order }] } | null`
  (published+enabled `nav.header:true` portal-site pages sorted by nav.order;
  null when capability off / no site / no pages). Used by the customer portal
  payload builder via dynamic import.
- `resolvePublishedPagePayload(orgId, pageId)` →
  `{ page: { slug, title, seo }, definition, widget_data, theme_vars }`.
- Server widget resolvers registered into the SHARED documents registry:
  `web.nav_menu` → `{ links: [{ slug, title, href, order }], source }`,
  `web.lead_form` → `{ form_id, form_title, available }`.

Events (`work/events.ts` + `website_events` rows): `website.site.created`,
`website.page.published|restored|deleted|enabled|disabled`.

Tests: `npm run test:websites` (`tests/websites-api.test.ts`).
