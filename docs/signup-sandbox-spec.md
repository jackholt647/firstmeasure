# Signup Workflow Sandbox — Spec

Development-only tool for aggressively A/B-testing signup/setup workflows:
different entry points, different page sequences, different app subsets, all the
way down to "this whole product is just one app" flows. It lets you compose
workflows out of a shared page library, launch fresh pre-authenticated test
orgs to walk them, and export/import everything as portable JSON bundles.

**This must never run in production.** The API mints logged-in orgs with the
fixed password `test1234`; the whole module answers 404 when `env.isProduction`.

## Locations

| Piece | Path |
|---|---|
| Backend module | `public/v1/signup-sandbox/{api,service,storage}.ts`, mounted at `/v1/signup-sandbox` in `public/v1/src/app.ts` |
| Builder UI | `public/portal/signup-sandbox/index.php` (+ `sandbox.js`, `sandbox.css`) |
| Injected dev bar | `public/portal/signup-sandbox/devbar.js`, included by `public/portal/index.php`; renders only when the session org is a sandbox test org |
| Stage overlay (placeholder-page host) | Rendered by `devbar.js` inside the real portal at `/portal/?sbx_stage=<index>` — there is no separate runner page. |
| Agent-built pages | `public/portal/signup-sandbox/pages/<page_id>/page.js` (contract in `pages/README.md`) |
| Sandbox data | `./storage/signup-sandbox/{workflows,pages,test_orgs}/<id>.json` (relative to `public/v1`) |

## Concepts

- **Page** — one screen a signing-up company can encounter. Lives in a global
  library; workflows reference pages by id, so a page can appear in many
  workflows. Pages are created as **placeholders** (id + title + agent brief)
  and implemented later, agentically.
- **Workflow** — an ordered list of stages (tiles), each pointing at a page.
  End-to-end: an optional marketing **landing** front step, the **signup**
  step, then the **setup** steps. A workflow id is the unit you attach to
  marketing entry points (put it in the URL/query params of a landing page).
- **Variant** — a page or workflow cloned with `variant_of` pointing at its
  source. Today variants are routed manually; automated split-testing routes
  onto these same documents later.
- **Test instance / test org** — a throwaway real org created by the sandbox.
  Creation skips the login/company-info step entirely: the server creates the
  org + identity + owner user, logs your browser in (real platform session
  cookies), records it in the test-org registry, and lands you **directly on
  the real surface of the first actionable stage** — the actual portal
  onboarding wizard (`/portal/?onboarding=1`) when that stage is a builtin
  wizard step, or the dev-bar stage overlay (`?sbx_stage=<n>`) when the page has no real surface yet.
  Password is always `test1234`.
- **Dev bar** — `devbar.js` is included on every signup surface (portal
  `index.php`, `login.php`, the landing router) and asks `GET
  /current-instance` whether the logged-in org is a sandbox test org. If so it
  injects a thin light-themed bar along the bottom of the screen (the wizard
  overlay is raised to sit above it) with one pill per stage. Placeholder and
  bundle pages render as a full-screen stage overlay inside the portal
  (`?sbx_stage=<index>`, wizard hidden while it's up; Continue records
  `complete-stage` and advances). Every other pill goes to the stage's REAL
  surface: wizard steps call the wizard's own `goToPage` in place (slide
  animation, no reload — `wizard.js` exposes `goToPage`/`currentPage`/
  `pageIndexForName` on `Portal.modules.onboarding_wizard`); from another
  surface the target is `/portal/?onboarding=1&sbx_step=<name>` and the bar
  jumps the wizard after boot. Landing stages open
  `/portal/landing/?variant=<builtin_ref>` (real landing page), signup stages
  open `/portal/login.php`. The current surface's pill is highlighted (700ms
  poll of wizard state); completed stages are checked (`onboarding_completed`
  for wizard steps, `complete-stage` records for overlay stages); entry stages
  are italic (already satisfied, still viewable). × hides it for the tab
  session. For non-test orgs — and in production, where the API is dead — it
  renders nothing.

## Data model (schema_version 1)

All ids are globally unique and machine-generated (`swf_`, `spg_`, `stg_`,
`sbi_` prefixes + 16 hex chars). Seeded template docs use stable readable ids
so two machines seed identical documents.

### Workflow (`kind: "signup_workflow"`)

```json
{
  "schema_version": 1,
  "kind": "signup_workflow",
  "id": "swf_firstmate_default",
  "title": "FirstMate default signup",
  "description": "…",
  "entry_mode": "landing_first",        // or "signup_first"
  "defaults": {                          // org state at instance creation, on top of platform defaults
    "app_flags": { "apps.equipment": false },
    "settings": { "branding.colors.primary": "#0b5cad" }
  },
  "stages": [
    { "id": "stg_fm_landing", "page_id": "spg_firstmate_landing", "notes": "…" }
  ],
  "variant_of": null,                    // workflow id this was duplicated from
  "tags": ["template", "firstmate"],
  "created_at": "…", "updated_at": "…"
}
```

`entry_mode` records whether the flow starts at a marketing landing page
(`landing_first`) or directly at signup (`signup_first`). Entry is *also*
represented as stages (role `landing` / `signup`) so the whole end-to-end path
lives in one ordered list.

### Page (`kind: "signup_page"`)

```json
{
  "schema_version": 1,
  "kind": "signup_page",
  "id": "spg_1a2b3c4d5e6f7a8b",
  "title": "Pick your apps",
  "role": "setup",                        // "landing" | "signup" | "setup"
  "status": "placeholder",                // "placeholder" | "implemented" | "builtin"
  "variant_of": null,                     // page id this variants from
  "implementation": {
    "type": "placeholder",                // "placeholder" | "bundle" | "builtin_wizard" | "landing_embed"
    "bundle": null,                       // for "bundle": "pages/<id>/page.js"
    "builtin_ref": null                   // for builtins: wizard page name / landing variant slug
  },
  "brief": "Agent instructions: what this page should do.",
  "effects": {
    "app_flags": { "apps.equipment": "$user" },
    "settings": { "branding.colors.primary": "$user" }
  },
  "tags": [],
  "created_at": "…", "updated_at": "…"
}
```

- `role: landing|signup` marks entry steps. **Test instances skip them**: the
  run starts at the first stage whose page role is `setup` (`start_stage` in
  the run-context response).
- `status: builtin` pages map onto existing FirstMate surfaces (the onboarding
  wizard pages `branding` / `users` / `account_load`, the register step, the
  landing system). Stage targets point at those real surfaces.
- `status: implemented` pages load `pages/<id>/page.js` per the contract in
  `public/portal/signup-sandbox/pages/README.md`.

### The settings model: defaults + effects

Every workflow defines the org state precisely, as three layers:

1. **Platform defaults** — `newOrganizationAppFlagDefaults()` + the standard
   register-time global doc (same as real signup).
2. **Workflow `defaults`** — overlaid at test-instance creation. `app_flags`
   uses legacy `"group.flag"` keys (the capability-registry-derived vocabulary,
   stored grouped in `global.data.app_flags`); `settings` uses dot-paths into
   the org global `data` (e.g. `"billing.auto_topup.enabled"`).
3. **Page `effects`** — what each stage changes, in stage order. A literal
   value means the page sets it outright; the string `"$user"` means the
   signing-up customer chooses it on that page (documented, never
   auto-applied).

`GET /workflows/:id/projection` computes the whole thing: baseline state,
per-stage effects + user choices + cumulative `state_after`, and `final_state`.
The builder's **Settings projection** modal renders this, so "what flags are on
after stage 3 of this workflow" is always answerable (and the projection JSON
is copyable).

During a run, advancing past a **placeholder** stage POSTs
`/test-orgs/:id/apply-stage/:stageId`, which applies that page's literal
effects to the test org's global doc (deep-merged; `"$user"` skipped). So a run
through unbuilt pages still leaves the org in the intended end state.
Implemented and builtin pages apply their own state through their real UIs.

### Test-org registry entry (`kind: "signup_sandbox_test_org"`)

```json
{
  "schema_version": 1,
  "kind": "signup_sandbox_test_org",
  "id": "sbi_…",
  "org_id": "org_…",
  "org_name": "Copper Falcon Test Co a1b2c3",
  "identity_id": "identity_…",
  "email": "sandbox-…@signup-sandbox.test",
  "password": "test1234",
  "workflow_id": "swf_…",
  "workflow_title": "…",
  "created_at": "…"
}
```

### Bundle (`kind: "signup_sandbox_bundle"`) — the copyable/syncable format

```json
{
  "schema_version": 1,
  "kind": "signup_sandbox_bundle",
  "exported_at": "…",
  "workflows": [ /* full workflow docs */ ],
  "pages": [ /* full page docs (a workflow export includes every referenced page) */ ]
}
```

This is what "Copy workflow JSON" / "Export library" put on the clipboard, what
Import accepts, and what you paste into a Claude session to ask questions about
a workflow. It is self-contained except for implemented pages' `page.js`
bundles, which are files — sync those by copying the
`pages/<page_id>/` folders alongside the bundle. Import skips existing ids
unless `overwrite: true`, so two people can merge libraries in either
direction; ids never collide because they are random.

## API (`/v1/signup-sandbox`, dev-only, no auth required)

| Route | Purpose |
|---|---|
| `GET /state` | Everything (also seeds the FirstMate template on first call). |
| `POST /workflows`, `PATCH /workflows/:id`, `DELETE /workflows/:id` | Workflow CRUD. `PATCH {stages}` reorders/adds/removes tiles. |
| `POST /workflows/:id/duplicate` | Clone as a variant (`variant_of` set, fresh stage ids). |
| `GET /workflows/:id/export` | Bundle of the workflow + its pages. |
| `GET /workflows/:id/run-context` | `{workflow, stages(with resolved page), start_stage}`. |
| `GET /workflows/:id/projection` | Settings projection: baseline → per-stage `state_after` → `final_state`. |
| `POST /test-orgs/:id/apply-stage/:stageId` | Apply a stage's literal effects to the test org. |
| `POST /test-orgs/:id/complete-stage/:stageId` | Record a stage done on the instance (+ apply effects when the page is a placeholder); the dev-bar overlay calls this on Continue. |
| `GET /current-instance` | Resolve the session's org to a sandbox instance (test org + stages with jump `target`s + completion). Powers the dev bar; `instance: null` for non-test orgs. |
| `GET /test-orgs/:id/run-state` | Same payload for a specific instance. |
| `POST /pages`, `PATCH /pages/:id`, `DELETE /pages/:id[?force=true]` | Page CRUD. Delete 409s if a workflow references the page unless forced. |
| `POST /pages/:id/variant` | Clone a page as a placeholder variant. |
| `GET /export`, `POST /import {bundle, overwrite}` | Whole-library sync. |
| `POST /workflows/:id/instances` | Create a test org, set platform auth cookies on the response, return `{test_org, redirect, auth}`. |
| `GET /test-orgs`, `DELETE /test-orgs/:id` | Registry; delete removes the org dir, identity, email index, and its sessions. |

Test-instance creation mirrors the real register flow
(`public/v1/platform/api.ts` legacy-action `register`): same org global
defaults, same app-flag defaults, identity + owner user + membership, then
`loginPlatformIdentity` + `setPlatformAuthCookies` + `rememberPlatformAccount`
(so the account switcher can hop between your real account and test orgs). Orgs
are tagged `metadata.sandbox_test_org: true`.

## Seeded template

Three rebuildable templates ship as sandbox docs with stable ids.

The FirstMate production flow:

- Workflow `swf_firstmate_default`: `spg_firstmate_landing` (landing) →
  `spg_firstmate_signup` (signup) → `spg_firstmate_branding` →
  `spg_firstmate_users` → `spg_firstmate_account_load`.
- Duplicate it as the starting point for longer flows for more complex
  companies, or strip it down for single-app flows.

The Channels-only flow (`swf_channels_only`) treats FirstMate as a dedicated
collaboration product and never introduces the CRM or wider app suite:

- Standard account signup (skipped by test instances).
- The shared production branding experience: website discovery, logo
  preview/upload, image palette extraction, editable colors, and live branded
  previews. The Channels flow uses a Channels workspace sample (channel rail,
  conversation, messages, AI, and composer) while the standard signup keeps
  its report sample; both presentations share the same branding state and save
  pipeline.
- Teammate invitations with member/admin roles.
- Starter public/private channel structure.
- Collaboration defaults for notifications, send behavior, Channels AI,
  huddle recording, and external guests.
- A Channels-specific launch page.

Its workflow defaults turn off every unrelated app, the left-column Apps and
To Do modes, the New button, and global search. Channels, the AI Assistant,
Messages, Notifications, and Settings remain available. Custom page choices
are posted with stage completion and saved under the test org's global data;
only `$user` keys declared by that page are accepted.

The generic home improvement flow (`swf_home_improvement`) is the expandable
foundation for onboarding a full-service contractor:

- Standard account signup (skipped by test instances).
- The shared production branding experience with a lightweight generic
  workspace preview: branded left rail, neutral UI shapes, and a sample modal.
- A button-based multi-select for common services, plus a searchable expanded
  catalog of remodeling, trade, and exterior specialties.
- A button-based multi-select for full replacements, repairs, and ongoing
  maintenance. Any combination is allowed.

The two profile pages persist their choices under `home_improvement_setup` in
the organization global document. No selection page uses checkbox controls.

## Deliberately not built yet

- **Split-testing/routing**: variants exist as documents; automatic routing +
  stats come later.
- **Landing-page authoring**: landing pages are represented as pages with
  `role: landing`; real marketing landing pages still come from the existing
  `public/portal/landing` system (or future agent-built ones). The eventual
  end-to-end system should replace the old landing tracking, not extend it.
- **Sync transport**: bundles are copy/paste (or file copy) for now; a push/pull
  sync can be layered on the bundle format without schema changes.
