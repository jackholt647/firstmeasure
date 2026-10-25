# Development: My Projects can open on the map (2026-10-24)

Release to dev.1m8.ai (worker, legacy, web, pool). Production untouched.

## What changed

- **Map first, as an app option.** My Projects (`portal.viewer`) has the app
  option Open on the map (`map_first`, default off, set in People › App
  experience or on a role's `app_defaults`). With it on and the Project Map
  feature (`apps.project_map`) on, My Projects opens on the map and the view
  switcher reads Map, Stages, Tiles, List; with it off nothing changes (Stages
  or Tiles first, map last). A view chosen by the route or the person stays;
  until then the view follows the default as the session and features load.
  No configuration id is read: the MVP platform setup turns the option on for
  its roles (owned by the MVP configuration session).
- **Empty map.** The tray says No projects yet with a New project button right
  under it, opening the normal new-project window. Filters that leave nothing
  do not offer it.
- **Search with no match.** "Create a new project for <typed text>" appears
  under My Projects' own search box (organizations without expanded access)
  and at the top of the top-bar search results (expanded-access organizations,
  including the MVP platform, whose My Projects has no search box of its own),
  whenever no project matches. Both appear only for people who can use the New
  button (`order_reports`, not assigned-only).
- **Typed address lookup.** The new-project window takes `address`; project-map
  (`lookupTypedAddress`) fills the address box and geocodes it with Google at
  once. A full (not partial) match is loaded as if picked from the suggestions;
  otherwise the text stays typed and Google's suggestions are opened under it.

New language keys (English fallbacks show until the catalogs are rebuilt):
`projects.projects_map_empty_new_project`, `projects.projects_search_create_for`,
`platform.search_create_project_for`.

## Files

`public/libraries/apps/projects/viewer.js`, `projects/map-view.js`,
`project-map/app.js`, `project-request/app.js` (open option only),
`public/v1/platform/app-experience/registry.ts` (the option; worker too),
`public/portal/scripts/topbar.js`, `firstmate-apps-manifest.js` (bundle
versions only). Tests: `projects-map-view`, `projects-map-empty-browser`,
`project-feature-gates`, `project-map-typed-address`.

Tooling: `output/projects-map-first-20261024/`.
