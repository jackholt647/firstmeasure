# Sales Role & Data-Driven Persona Templates — System Spec

Status: **in progress** — Phase 1 (§3 persona templates + crew re-seed parity;
`public/v1/workforce/persona_templates.ts`, `/access/templates` routes,
`tests/persona-templates.test.ts`) built 2026-07-30; admin UI for templates lands
with Phase 2. Everything else not built. This spec designs (a) the salesperson phone experience
(commission earnings, today's sales appointments, per-rep stats, self-managed follow-ups,
proposal status visibility) and (b) the generalization that makes it possible: **persona
templates** — data-driven bundles of apps, params, and permissions applied to user types.
Crew, salesperson, delivery driver, inspector, technician-who-sells, and sole-prop are all
instances of the same template mechanism, not separate code paths. The "Current state"
section is an audit of what exists today (2026-07-30).

---

## 1. Current state (audited 2026-07-30)

### Already data-driven (keep, build on)

- **Access roles are DB rows, not code.** `workforce_access_roles`
  (`public/v1/workforce/access.ts:1106`) with full CRUD (`createAccessRole` :1267,
  `patchAccessRole` :1311 with optimistic concurrency, `archiveAccessRole`). A role =
  `{ application_ids[], permissions, app_defaults, level, metadata }`. Roles can span
  applications (`application_ids` is an array).
- **Per-app params are the parameterization seam.** `app_defaults[appId] =
  { enabled, params, layout }` — this is how supervisor gets `variant: 'supervisor'` on
  the overview, foreman gets `mode: 'manage'` on checklists. Entitlement layering
  (`effectiveEntitlements`, access.ts:1570) resolves catalog default → role defaults →
  per-user `app_overrides` (`show`/`hide`/`inherit`), with `parameter_permissions` and
  device filters. Any role enabling an app wins.
- **Capability presets are stored JSON** with CRUD
  (`public/v1/platform/capabilities.ts:507-643`, custom presets at
  `{platformStorageRoot}/config/capability_presets.json`). Note `applyCapabilityPreset()`
  (:764) is destructive/complete — unlisted booleans turn off.
- **Compensation-driven visibility** already exists (`hasHourlyCompensation`,
  access.ts:1551 → forces `time_clock_enabled` off for non-hourly). Pure-commission reps
  never see the clock with zero new code.
- **Commissions are first-class payroll**: `payroll.commissions` capability
  (`capability_defs.ts:663`), rules engine (`public/v1/payroll/commission_rules.ts`),
  automations `payroll.commission.rule.v1` / `payroll.commission.post.v1`, clawbacks with
  `clawback_cap_percent`, scope-template commission editor
  (`apps/settings/company.js:7960-8160`), payee roles `estimator` + `inside_salesperson`
  auto-populated from the sales appointment (`scopes/presets/index.ts:898-932`).
- **Self-service earnings route is role-agnostic by design.**
  `GET /v1/payroll/organizations/:orgId/earnings/me` (`payroll/api.ts:142`) gates on
  capability `payroll.self_service_earnings` only — no application requirement, payee
  forced to session user. Payroll README: same report shape "so Crew, sales, and future
  role-specific apps can render the data differently."
- **Sales scheduling primitives ship today**: `sales_appointments` / `inside_sales`
  standard roles, `sales_appointment` event type (60 min, availability windows,
  appointment slots, confirmations), events carry `assigned_user_ids`.
- **Internal signing route exists and is the same function as the portal's.**
  `POST .../documents/:documentId/outputs/:key` (`documents/api.ts:571`) →
  `recordDocumentOutput` (`documents/service.ts:1692`) — identical normalization,
  evidence freeze, status recompute, `document.signed` emission, `on_signed` →
  receivables (`documents/receivables.ts:111`). Client method already exists:
  `DocumentsAPI.documents.recordOutput` (`documents-api.js:146`).
- **Payment intake UI runs in the company app** (`payment-intake.js`; mounted at
  `portal/index.php:2137` and `apps/money/project.js:2016`) writing real allocated
  payments via `PaymentsAPI.payments.create`. Processor is mock (see §8).

### Hardcoded today (the overhaul targets)

- **Role definitions are code seeds**: `defaultRoleSeeds()` (access.ts:976-1101) with
  upgrade keyed on `metadata.preset_revision`. `crewAppDefaults(variant)` types variant
  as a closed union `"member" | "foreman" | "supervisor" | "solo"` (:931).
- **The app catalog is two hardcoded arrays**: `MANAGEMENT_APP_CATALOG_SOURCE`
  (access.ts:174) and `CREW_APP_CATALOG_SOURCE` (:527). Catalog entries stay code (apps
  ARE code), but there is no "sales" section and crew entries default off with role
  seeds as the only enabler.
- **Application ids are a closed two-value union**: `management` / `field`
  (access.ts:12-13), alias tables at `canonicalApplicationId()` (access.ts:760,
  auth.ts:605, core.js:1883). `CapabilityAudience` union (`capabilities.ts:37`) is
  informational only.
- **No salesperson access role, no sales apps, no sales permission nodes** anywhere in
  the tenant platform. (The FirstMeasure internal console's salesperson/commission
  system is a separate operator-only system.)

### Known gaps this spec depends on (fix in scope)

- **Stats `primary_user_id` is never populated.** `stats/sync.ts:310-313` reads
  `data.assigned_user_id || salesperson_id || sales_rep_id || owner_user_id` — nothing
  writes any of these. The canonical rep is the custom field `assignments.estimator`
  (`project.custom_field_values.assignments.estimator.subject_id`), which sync never
  reads; `projectAttrs()` (:241) reads the legacy `custom_fields` key and flattens only
  top-level scalars. The metric DSL itself needs **no changes** — grouped/filtered
  close rate works once the column is populated (`metrics.ts:479` combines formula
  inputs per group+bucket).
- **Follow-up per-user filtering exists server-side but every surface opts out.**
  `GET /v1/work/.../todos` defaults to `user_id: ctx.userId` (`work/api.ts:186`), but
  the sidebar (`core.js:2350`) and contact modal (`contacts/modal.js:524`) send
  `includeAll: true`. No `kind`/`type_tags` filter param exists (follow-up detection is
  client-only, `isFollowUpItem`). Pipeline follow-ups are role-assigned
  (`assigned_role_ids: ["sales_appointments"]`, `scopes/presets/index.ts:154`); only
  the call-disposition path assigns a concrete user (`crm/call_lists.ts:494`). The
  `"office"/"management"` role token injected at `work/api.ts:184` makes every
  management user match every role-assigned node.
- **Internal document surfaces are deliberately inert.** `apps/documents/project.js`
  renders `mode: 'static'` (:2604, :3320); `doc-workflow` hard-codes
  `ctx.audience !== 'customer'` → dead "customer signs from their portal" card for
  `signature`/`payment` kinds (:1546, :1587). Evidence capture
  (`signatureEvidencePayload`) lives only in `customer_portal.js:2264`. The internal
  outputs route is gated on `view_projects` (a read permission). `doc-editor` has an
  unwired `fill` profile ("hand the document back") with pointer pass-through
  (`firstmate-doc-editor.js:1676`).
- **`document.payment.received` has no consumer** — a document "payment" output marks
  status but creates no payment record and allocates nothing (contrast legacy
  `proposals/storage.ts:2060` which calls `createPayment`).
- Renderer bug: `doc-renderer:2574` never forwards `widgetContext.publicToken` /
  `portalUrl` into `ctx.api` (being fixed separately).

---

## 2. Design principles

1. **Personas are data; apps are code.** A persona template is a stored JSON bundle —
   apps + params + permissions + application access + capability requirements. The app
   *implementations* (catalog entries, mount functions) remain code, but must be
   parameterized enough that every persona difference is expressible as data. No more
   `variant` closed unions in TypeScript.
2. **No third application id.** `management`/`field` stay. Salesperson is a
   field-application persona (phone-first); hybrid personas (technician-who-sells,
   sole-prop) compose crew + sales + management apps via `application_ids` arrays and
   app defaults — composition already works (any role enabling an app wins).
3. **Sales apps are parameterized building blocks, not a monolith.** Each new app
   declares its params in the catalog so templates can dial it (e.g. money visibility
   level, whether follow-ups show, whether payments can be taken).
4. **Signatures and payments are project-modal tabs, audience-neutral.** They are not
   sales-only: a supervisor collecting a final sign-off uses the same tab. Gated by
   permissions, included in personas as data.
5. **Reuse the report shapes.** Earnings, todos, events, document statuses all have
   role-agnostic APIs already; sales surfaces re-render, they do not re-compute.
6. **UI preservation**: new surfaces follow the crew app's phone patterns
   (`icon_tabs`, `mobile_fullscreen`, FontAwesome, `--primary` tokens); existing
   surfaces are not reformatted.
7. **Visibility-first money gating.** Financial *reading* becomes permissioned, not
   just financial actions — a company dials each persona from "status chips only" to
   "full amounts + take payment".

---

## 3. Persona templates (the data-driven role system)

### 3.1 Model

New per-org collection `persona_templates` — stored alongside the org's access roles
(workforce storage), NOT global platform config. Built-in templates ship as factory
definitions that are copied into each org on seed and are then fully org-editable;
`revision` upgrades apply only to org copies whose content still matches the shipped
prior revision (org-modified templates are never overwritten):

```jsonc
{
  "id": "salesperson",
  "name": "Salesperson",
  "description": "Phone-first sales: appointments, follow-ups, commissions, proposals.",
  "builtin": true,                    // factory-shipped; org copy stays editable
  "revision": 1,                      // upgrade applies only if org copy is unmodified
  "application_ids": ["field"],
  "level": 20,
  "metadata": { "persona": "sales" },
  "permissions": {                    // permission map, same shape roles use today
    "sales.dashboard.view": true,
    "sales.schedule.view": true,
    "sales.followups.manage": true,
    "sales.earnings.view": true,
    "sales.stats.view_own": true,
    "sales.documents.view_status": true,
    "sales.money.view_status": true,
    "project.signatures.present": false,
    "project.payments.take": false
  },
  "app_defaults": {                   // exact shape access roles use today
    "portal.sales_overview": { "enabled": true, "params": { "show_pipeline_pulse": true } },
    "portal.sales_schedule": { "enabled": true },
    "portal.sales_earnings": { "enabled": true },
    "project.sales_overview": { "enabled": true, "params": { "money_visibility": "status" } },
    "project.signatures":    { "enabled": false },
    "project.payments":      { "enabled": false }
  },
  "capability_requirements": ["apps.sales", "platform.scheduling", "platform.proposals"]
}
```

- **Applying a template creates/updates an access role** (`workforce_access_roles`) via
  the existing CRUD — the runtime resolution path (`resolveAccessProfile`,
  `effectiveEntitlements`) is untouched. Templates are authoring-time data; roles remain
  the runtime object.
- `capability_requirements` is advisory: applying a template reports (does not force)
  org capabilities that are off, mirroring the registry's `dependency_unsatisfied`
  reporting.
- CRUD + apply endpoints under `/v1/workforce/organizations/:orgId/access/templates`,
  admin UI inside the existing permission-sets settings surface
  (`apps/settings/company.js` capabilityUi region).

### 3.2 Crew overhaul (migration, deliberately small)

- Re-express the four existing seeds (`crew_member`, `repairman`, `crew_foreman`,
  `supervisor`) as built-in persona templates in the same JSON format.
  `defaultRoleSeeds()` becomes "apply built-in templates on seed", keeping the
  `INSERT OR IGNORE` + `preset_revision` upgrade mechanism (bump
  `ACCESS_ROLE_PRESET_REVISION`).
- Delete `crewAppDefaults(variant)` / `hiddenCrewAppDefaults()` closed unions; their
  content moves into the template JSON. `field_mode` metadata is preserved as
  `metadata` passthrough.
- Management roles (`viewer`…`super_admin`) become templates too, for uniformity.
- **No behavior change intended** for existing orgs: seeded role ids, permissions, and
  app defaults stay byte-identical; tests that assert exact entitlement shapes
  (`tests/crew-api.test.ts:445,479`) should pass unmodified. New assertion: template →
  seed parity.
- Future personas the user anticipates (delivery driver, inspector) become new template
  JSON, zero code.

### 3.3 New built-in templates shipped with this feature

- `salesperson` (above), `sales_manager`, and a `technician_seller` example composing
  crew_member + salesperson app defaults (documents both the mechanism and the hybrid
  story).
- `sales_manager` team visibility is **parameterized per-org**, not fixed: template
  params such as `team_visibility: "none" | "leaderboard" | "boards"` (whether the
  manager sees teammates' Today boards), `sales.stats.view_team`, and follow-up
  reassignment rights are all dials in the org's copy of the template — the shipped
  default is leaderboard-only.

---

## 4. Capability & permission additions

Registry (`capability_defs.ts`):

- App node `apps.sales` — "Sales workspace" (audience `field`, informational).
- Permission nodes under it (all `audience: ["field"]`, mirroring `crew.*`):
  `sales.dashboard.view`, `sales.schedule.view`, `sales.followups.manage`,
  `sales.earnings.view` (requires `apps.payroll`), `sales.stats.view_own` (requires
  `apps.stats`), `sales.stats.view_team`, `sales.documents.view_status` (requires
  `platform.proposals`), `sales.money.view_status`, `sales.money.view_amounts`
  (requires `platform.money`).
- Audience-neutral project-tab permissions: `project.signatures.present` (new node
  under `platform.proposals` — see §6.4 for why signing needs more than
  `view_projects`), `project.payments.take` (alias/requires the existing
  `crew.payments.take` semantics; see §7).
- Update/extend the `sales_crm` capability preset (or add `sales_team`) to include
  `apps.sales`, `apps.payroll`, `payroll.commissions`, `payroll.self_service_earnings`
  — today `sales_crm` enables none of the payroll layer.

Manifest (`firstmate-apps-manifest.js`): new entries with
`access: { applicationsAny: ['field'], devices: ['mobile','desktop'], requireEntitlement: true }`
(same shape as `crewAccess`), `appCapabilities` mappings, `nestedRouteParams.sales`,
and a `salesBundles` list (payroll-api, payments-api, documents-api, platform-api,
sales/app.js). Catalog entries appended as `SALES_APP_CATALOG_SOURCE` in access.ts
(default off, template-enabled — same policy as crew).

---

## 5. The sales app package (`public/libraries/apps/sales/app.js`)

Follows the crew package pattern exactly: single file, inline CSS, crew-style
presentation constants (`desktopLeft:'none'`, `mobileTabs:'icons'`,
`mobile_fullscreen`), server facade + thin client.

### 5.1 Portal tabs

| App id | Tab | Content |
|---|---|---|
| `portal.sales_overview` | **Today** (`defaultHome`) | Today's `sales_appointment` events (time, customer, address, status chip incl. confirmation state); follow-up queue split **Mine / Unclaimed (my role)**; pipeline pulse strip (params-gated): close rate, appointments this week, revenue sold this month |
| `portal.sales_schedule` | **Schedule** | Shared `PlatformScheduleView.renderProjectRangeScheduler` read-only (crew pattern, `crew/app.js:563`), event source = my sales appointments, past + future; list/day/4day/week/month |
| `portal.sales_earnings` | **Earnings** | `PayrollAPI.earnings.me` re-rendered commission-first: per-deal commission cards, pending vs. paid, installment status (deposit-received / production-complete splits), clawbacks called out. Summary grid stays Owed / Paid / Projected for consistency |
| `portal.sales_stats` | **Stats** | A **parameterized instance of the existing stats app** (`apps/stats/app.js`), not a fork — mounted with params restricting which views appear and forcing per-user data scope (§9). The Today tab's pulse strip covers the glance case; this tab is the deep dive: full configurable widgets plus a past-jobs list (closed / lost / open per project) |

### 5.2 Project-modal tabs

| App id | Content |
|---|---|
| `project.sales_overview` (`defaultHome`) | Customer + one-tap contact actions; appointment history on this project; document status chips (`draft/sent/viewed/signed/paid` — presentation of existing statuses); this project's follow-ups (create → self-assigned); money summary rendered per `money_visibility` param: `none` \| `status` (chips only) \| `amounts` (contract/collected/outstanding) |
| `project.signatures` | §6 — audience-neutral, shared with crew personas |
| `project.payments` | §7 — audience-neutral, shared with supervisor persona |

### 5.3 Server facade (`public/v1/workforce/sales_api.ts` or `public/v1/sales/`)

Mirror of `crew_api.ts`:

- `GET .../sales/me/dashboard` — requires `sales.dashboard.view`; today's assigned
  `sales_appointment` events + follow-up buckets + pulse metrics.
- `GET .../sales/me/appointments?from&to` — requires `sales.schedule.view`.
- Assignment scoping: new helper alongside `assignment_scope.ts` matching events where
  `event_type_default_id`/kind is a sales appointment AND (`assigned_user_ids` contains
  the user OR the user holds an assigned scheduling role, claimable). The existing
  `isProjectWorkEvent` scoping is production-specific and is not reused.
- Project access rule: a salesperson can open projects where they are the
  `assignments.estimator` / `assignments.inside_salesperson`, or have an assigned
  sales appointment — the sales analogue of `assignedProject()`. `sales_manager` gets
  the view-all analogue.

---

## 6. Signatures project tab (`project.signatures`)

The chosen shape (per product direction): a project-modal tab, visible on mobile, that
lists what needs signing on this project and **injects the interactive signature
surface inline**. The injection is built as a reusable component so it can mount
elsewhere later (kiosk mode, appointment detail, portal preview).

### 6.1 New shared library: `public/libraries/doc-sign/`

`FMDocSign.mount(container, { orgId, documentId, outputKey?, mode, onSigned })`:

- Wraps `FMDocRenderer.render` in `mode: 'interactive'` with a real
  `widgetContext.submitOutput` → `DocumentsAPI.documents.recordOutput(orgId, docId,
  key, { value, evidence })` (the authenticated route — everything downstream,
  including `document.signed` → receivables, already fires).
- Extracts `openSignatureModal` from the doc-widgets IIFE
  (`firstmate-doc-widgets.js:1465`) into a shared export so the modal is usable
  without a full document render (needed for §6.5 and future standalone sign-offs).
- Extracts `signatureEvidencePayload()` from `customer_portal.js:2264` into a shared
  helper (`doc-sign` or `platform-api`) so in-app signatures carry identical
  browser/geo evidence — auditable parity with portal signatures.

### 6.2 Evidence provenance (server, small but substantive)

`recordDocumentOutput` evidence gains `capture_mode: "remote" | "in_person"` and
`witnessed_by_user_id` (from `ctx` on the internal path; the public path stays
`remote`). `portalSignatureEvidenceFrom` parameterizes its hardcoded
`source: "customer_portal"`. This is the legally meaningful delta between "customer
signed alone in the portal" and "customer signed on the rep's device".

### 6.3 Tab behavior

- Lists the project's documents having signature-typed `output_defs`, grouped: **Needs
  signature** (required outputs unsatisfied) / **Signed** (with signer, timestamp,
  capture mode). Data: existing documents list + `requiredOutputsSatisfied`.
- Tapping a pending item enters **present mode**: fullscreen interactive render
  (snapshot minted via the existing no-email `POST .../snapshots` if none current),
  chrome suppressed, a "Done — return to <rep name>" bar, and on return a brief
  witnessed-by confirmation. The doc-editor `fill` profile's pointer pass-through is
  prior art; the tab uses the renderer directly (no editor dependency).
- Workflow documents: mount `FMDocWorkflow` with a new `presenting: true` state that
  un-gates the `signature`/`payment` item kinds' customer renderers for internal
  hosts (`doc-workflow:1546,1587`) — this is the "impersonation view" the tiers spec
  left open, resolved as: yes, behind `project.signatures.present`.
- Payment-typed outputs shown in present mode render a "collect on the Payments tab"
  handoff until §8 wiring lands.

### 6.4 Permission

Recording outputs internally today requires only `view_projects`. The route adds:
signature-typed outputs require `project.signatures.present` when called with an
authenticated ctx. (Public-token path unchanged.)

### 6.5 Document-less sign-off (phase-later, but shaped now)

customer-portal-v2-spec §8.2b (`completion.request.v1`, `mode: document | signature`)
remains the plan of record for sign-offs without a document; `portal_signatures.ts`,
`project.completion.signed`, and the recognition consumer already exist. The §6.1
modal extraction is the shared prerequisite. When built, standalone sign-offs appear
in this same tab as a third row type. Out of scope for the first sales release.

---

## 7. Payments project tab (`project.payments`)

- Extract the supervisor crew-payments tab (`crew/app.js:943 mountProjectPayments`)
  into a shared package (`public/libraries/apps/field-payments/`) registered as
  `project.payments`; `project.crew_payments` becomes an alias (via `APP_ID_ALIASES`,
  access.ts:701) so existing supervisor entitlements keep working.
- Mounts `FirstMatePaymentIntake` (already mobile-responsive) →
  `PaymentsAPI.payments.create` with `kind:'customer_payment'`, `allocate: true` —
  the exact live path the Money tab uses (`money/project.js:2016`). Obligation list
  (deposit due on signature, etc.) shown from `listProjectObligations`, tapping one
  pre-fills `amountCents` — the signature → deposit → collect handoff.
- **Processor**: per product direction, build against `PaymentsAPI` as-is (mock
  settlement). Real gateway + card-present hardware is a later, separate effort; the
  `document.payment.received` → `createPayment` bridge also lands with that effort.
- Permission: `project.payments.take` (crew personas keep `crew.payments.take`; the
  shared tab accepts either — one permission node `requires` the other).

---

## 8. Payments backend expectations (deferred wiring, recorded here)

When the processor lands: tokenized capture replaces raw-PAN intake
(`payment-intake.js:249` takes PAN/CVC into JS today — must move to processor
iframe/SDK); an automation consumes `document.payment.received` and calls
`createPayment` + allocation (mirroring `proposals/storage.ts:2060`); saved methods
replace `fakeSavedMethods()`. Nothing in this spec blocks on it.

---

## 9. Stats: per-rep metrics

1. **Sync fix** (`stats/sync.ts`): populate `primary_user_id` from
   `custom_field_values` → `assignments.estimator.subject_id` (subject_type
   `organization_user`), with existing flat-key reads kept as fallback. Fix
   `projectAttrs()` to read `custom_field_values` (keep legacy `custom_fields`
   fallback) — nested objects skipped, not stringified to `"[object Object]"`.
   Bump the sync/cache version key; backfill runs via the normal full resync.
2. **Per-user views via the existing view ("set") mechanism.** Stats views gain two
   config fields: `audience` (which personas see the view — e.g. this one appears in
   the salesperson stats tab) and `per_user: true` (the view is grouped/filtered by
   `primary_user_id`). Ship a built-in **"Stats by salesperson"** view: close rate
   (the org-wide formula at `presets.ts:49` with `group_by: primary_user_id`),
   appointments run, revenue sold, average ticket, plus a past-jobs widget (projects
   listed with sold/lost/open status). One view, two renderings:
   - **Admin on desktop**: sees "Stats by salesperson" as another view pill in
     `portal.stats`, grouped across all reps.
   - **Salesperson on mobile**: sees the same view in `portal.sales_stats` with the
     server forcing `{"field":"primary_user_id","op":"eq","value":ctx.userId}` onto
     every spec input for users holding only `sales.stats.view_own`. Salespeople
     never receive the unscoped warehouse; existing management gates unchanged.
3. **The sales stats tab is the stats app, parameterized.** `portal.sales_stats`
   mounts `apps/stats/app.js` with entitlement params (e.g.
   `{ audience: 'sales', scope: 'self' }`) selecting which views render and the data
   scope. View configurability (which widgets, which metrics) is thereby inherited —
   orgs customize the salesperson stats page the same way they customize any view.
4. **Mobile optimization of the stats app is in scope** and benefits the global
   `portal.stats` too — the app is being made responsive once, for both surfaces.
   The UI already resolves user labels (`stats/app.js:262`).

---

## 10. Follow-ups: "mine" as a first-class view

1. **Server**: add `kinds`/`type_tags` filter to `listWorkTodos` + the todos route so
   follow-ups are queryable server-side. Add an explicit `assigned_to=me` mode that
   matches **only** `assigned_user_ids` (bypassing the injected `office`/`management`
   role token at `work/api.ts:184`, which otherwise matches every management user to
   every role-assigned node).
2. **Claiming**: role-assigned follow-ups (the pipeline default) appear under
   "Unclaimed (my role)"; claiming stamps `assigned_user_ids: [me]` (reschedule
   chains then propagate the user — existing behavior, `followups.ts:192`).
3. **Sales surfaces default to self-assignment** on create (`assigned_user_ids: [me]`)
   — the composer default already exists (`platform-action-items.js:560`); the sales
   app just doesn't send `includeAll: true`.
4. Existing org-wide surfaces (sidebar, contact modal) are untouched.

---

## 11. Phasing

1. **Persona templates + crew re-seed parity** (§3) — the foundation; no visible change.
2. **Sales package scaffold**: catalog + manifest + capability nodes + templates +
   `sales_api` dashboard/schedule + Today & Schedule tabs (§4, §5).
3. **Stats sync fix + per-rep stats tab** (§9) — sync fix ships early; it's a
   correctness fix independent of sales.
4. **Follow-ups server filters + Today integration** (§10).
5. **Earnings tab** (§5.1) — pure re-render of the existing report.
6. **Signatures tab + doc-sign library + evidence provenance** (§6).
7. **Payments tab extraction** (§7).
8. Later, separate: document-less sign-off (§6.5), processor + payment bridges (§8).

## 12. Tests & contracts to update

- `tests/crew-api.test.ts` (:445, :479 assert exact `allowed_app_ids`) — must pass
  unchanged after §3.2; extend with template-parity + sales-catalog assertions.
- `tests/capabilities.test.ts`, `tests/navigation-contract.test.mjs` — new nodes/apps.
- `tests/follow-up-ui-contract.test.mjs` — new filter params.
- `tests/stats-api.test.ts` — `primary_user_id` from `assignments.estimator` fixture.
- `docs/document-engine-contracts.md` — amend §2/§8: internal interactive submission
  (`presenting` state), evidence `capture_mode`/`witnessed_by_user_id`, doc-sign
  library, modal export. Tiers-spec open decision #3 resolved (yes, permissioned).

## 13. Resolved decisions (2026-07-30)

1. **Persona templates are stored per-org** (§3.1) — built-ins are factory defaults
   copied into each org, then org-editable; revision upgrades never overwrite
   modified copies.
2. **Sales stats is its own tab and is a parameterized instance of the existing
   stats app** (§9) — pulse strip on Today for the glance, full configurable stats
   tab for the deep dive, "Stats by salesperson" as a shared view the admin also
   sees on desktop. The stats app gets mobile-optimized once, for both surfaces.
   Tab naming stays "Stats" for now.
3. **Sales-manager team visibility is a per-org template parameter** (§3.3), shipped
   default leaderboard-only.
