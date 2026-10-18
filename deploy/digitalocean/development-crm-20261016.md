# Development rollout: the CRM (2026-10-16)

Release `fa8725a3` from `claude/crm-20261016` (on `3d77acef`), development only. Design:
[CRM](../../docs/architecture/crm.md).

## What shipped

- **The CRM tab** (`portal.crm`, `public/libraries/apps/crm/`, capability `crm.views`): a rail of
  pinned views with live counts, list, board and agenda layouts, filter chips in the one
  condition contract, Display (group, sort, columns), saved, shared and pinned views with a
  save bar, bulk actions through the existing writers, the lead drawer, worklists, the funnel,
  duplicates, sources and CRM settings, keyboard shortcuts and a phone layout.
- **Collections and views** (`public/v1/crm/records.ts`, `views.ts`, `api.ts` at `/v1/crm`):
  read-only rows for leads, contacts, follow-ups and appointments, limited by branch and
  department access; the `crm` SQL store (views, preferences, spend, results); base views
  installed on first load.
- **Results** (`crm/results.ts`): a worklist or drawer result runs the call-list or follow-up
  path, or creates a follow-up or a lost outcome, posts the note to the project channel, is kept
  and emits `crm.disposition.recorded`.
- **Sources** (`crm/sources.ts`): the catalog tree with rules, the most specific match stamped by
  `receiveLead`, UTM tags and click ids copied from the lead's page, spend prorated by period.
- **Funnel** (`crm/funnel.ts`): steps read from work events, credited to the setter or the rep;
  reports by source, scope, setter, rep, branch and month with cost per step.
- **Cancellation windows** (`crm/rescission.ts`): rules by days, counting, holidays and
  conditions (state, customer age, how the lead arrived); `sales.startRescission.v1` sets the
  step's deadline and `work.finishItem.v1` (new) closes it on its timer; production starts
  when it ends; `POST .../cancel-sale` makes a won sale in its window lost.
- **Presets** (`crm/presets.ts`, `scopes/presets/industry.ts`): five industry packs and
  team-size features, applied from CRM settings; two industry scopes (insurance roof sale with
  the claim fields and contingency stage, in-home sale), installed only by the setup.
- **Scheduling**: an appointment preset names the event type its bookings carry ("Counts as");
  the sales preset carries `sales_appointment`.
- **Terminology**: the `crm` section's new keys and the regenerated contract.
- **System diagram** at `/dev-previews/system-diagram.html#crm`, with screenshots from the
  browser test.

## Checks

- `npm run check` clean.
- New: `tests/crm-views.test.ts` (2 tests: collections, views, results, sources, spend, the
  funnel; presets, tracking tags and the cancellation window sold through a real scope, cancelled
  in the window and closed by its timer), `tests/crm-rescission.test.ts` (6),
  `tests/crm-app-browser.test.mjs` (the app in Chrome against the in-process server, desktop and
  phone, with a screenshot of each screen).
- Updated and passing: `publication-actions` (30 legacy work actions with `work.finishItem.v1`),
  `publication-coverage` (the `crm` app's ownership entry), automation-contracts,
  appointment-booking, lead-receive, new-leads, project-entry, opportunity-outcome,
  scope-event-map, work-api, terminology agent and integration: 125 pass, 0 fail.
- Failing identically on the base `3d77acef` (not this release): 33 browser UI contract tests
  (navigation, settings layout, scheduling UI and others), the capability registry test
  (`platform.collaboration missing catalog_stub`), and the localization catalog build (an
  unknown pt-BR custom-fields key; `catalog-source.json` is stale across many namespaces, so it
  was not regenerated; the terminology contract was regenerated from the catalog alone).

## Rollout

- All four roles were on `7603342e` (the code of `3d77acef`); no host drift, so every file
  merged cleanly (`output/crm-20261016/replay.py` was not needed). The payload now copies
  imported JSON (the terminology contract) to `dist/`, and ships binary files byte for byte.
- The first staging stopped on legacy before any activation: `deploy.py` normalized line
  endings before hashing every file, so a PNG's hash could never match. Images are now hashed as
  bytes; the retry staged and activated worker, legacy, web and pool, and `verify` passed on all
  four at `fa8725a3`. `firstmeasure-development-platform-worker` restarted (it runs
  `sales.startRescission.v1` and `work.finishItem.v1`).
- Public checks (`output/crm-20261016/public-checks.sh`): `/v1/crm/` answers, organization routes
  need a session, `crm/app.js`, `crm.css`, the manifest's `portal.crm` and the terminology keys
  are served, and the diagram and all 12 screenshots are served byte for byte.
- Smoke on the web host (`output/crm-20261016/smoke-crm.mjs`, lead-verification organization):
  all four collections built (539 ms), the 11 base views installed and each queried, the funnel
  report ran, both industry scopes validate against the scope schema, and a July 2 sale's window
  ends `2026-07-09T03:59:59.999Z`.
- The diagram's CRM statuses were then set live and the page republished:
  [system diagram](https://dev.1m8.ai/dev-previews/system-diagram.html#crm).

The CRM tab appears for organizations with expanded platform access and `crm.views` (on by
default under `apps.crm`). A company sets it up for its industry under CRM > CRM settings > Set up for your business.

## Follow-ups (2026-10-16 to 2026-10-18)

- **`cfd28529` (hotfix on `7ef1084a`).** The CRM tab declared the feature `crm.views`, so More
  apps found no tab for the `apps.crm` app and offered neither Open nor Pin. The tab now declares
  `apps.crm`; `crm.views` off shows that views are off. Verified on all four roles.
- **`fe86a9ca` (canonical, App experience).** Canonical's App experience merge plus the CRM
  follow-up: the tab and registry name `apps.crm`, every CRM route needs the CRM app
  (`requirePlatformAuth({ app: ["portal.crm"] })`), bundle `20261016-crm-v3`. This rollout also
  brought App experience itself to dev. The hosts carried another session's channels-feed and
  phone-settings edits that canonical does not have; `output/crm-20261016/replay.py` keeps both
  sides (media app gate plus feed-attachment check, the union of permission bundles, live
  `workforce/access.ts`, manifest entries without their `access` lines), ships the release copy
  where live was an older commit, keeps live test files, the settings search index, and worker's
  and legacy's voice-less assistant API, and replaces the host-only crew-note check
  `ctx.applicationAccess.field` with `crew.projects.view` as App experience did elsewhere. The
  host-only `tests/project-note-departments.test.ts` (that removed rule) was removed from the
  staged clones. The first try stopped at legacy's TypeScript check before any activation; the
  retry staged, activated and verified all four. Platform worker restarted; public checks and
  the smoke passed.
- Whoever owns the channels-feed and phone-settings work should land it on canonical: those
  edits exist only on the dev hosts.
