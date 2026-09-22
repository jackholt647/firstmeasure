# Equipment & Fleet Management — System Spec

Status: **draft / not built**. This spec designs a data-driven equipment system that scales
from "this truck is on this job" (sole proprietor) to full fleet management (heavy civil:
serialized units, meters, maintenance programs, operator certifications, utilization costing).
Nothing here is implemented yet; the "Current state" section is an audit of what exists today.

---

## 1. Current state (audited 2026-07-25)

### What exists

- **Scope resource lists** support `resource_type: "equipment"` end-to-end
  (`public/v1/scopes/schemas.ts:71`, duplicated at `public/v1/materials/schemas.ts:9`).
  Equipment lists are stored in the `material_lists` collection alongside material/labor lists.
- **One seed**: the roofing preset ships a `roofing_equipment` list with three items
  (disposal trailer, portable toilet, truck) at `public/v1/scopes/presets/index.ts:869-881` —
  no prices, `controls: { scheduling: false }`, `schedule: { enabled: false }`.
- **Schedule plumbing is pre-wired but disabled**: generated events carry
  `equipment_list_id`, `schedule_item_kind: "equipment"`, `resource_type: "equipment"`
  (`public/v1/materials/storage.ts:831`); `eventKind()` resolves `'equipment'`
  (`platform-scheduling.js:961`); the Gantt has equipment styling
  (`platform-schedule-view.js:4501,4509`). But the project schedule panel filters equipment
  out in three places (`apps/project-schedule/panel.js:456,711,2218`) and
  `materials/storage.ts:1635` actively cancels stale equipment events.
- **Expense projection**: each equipment list is an expense target with a `by_resource.equipment`
  rollup — but `public/v1/payments/storage.ts:1189` hardcodes `paid_cents: 0`; equipment can
  never accrue actual cost today.
- **Terminology** per-org relabeling works for the equipment resource type (tested: "Vehicles").

### What does NOT exist

- **No equipment registry** of any kind — no catalog, no unit records, no inventory,
  no org settings. Greps for `fleet`, `equipment_id`, `equipment_item`, `asset_registry`
  return zero hits.
- **No crew↔equipment relation.** Zero references — not even a TODO. The
  `capabilities: ["items","scheduling_optional"]` descriptor on the preset resource type
  (`presets/index.ts:814`) is static metadata nothing reads.
- **Equipment cannot be assigned to events.** `work_resource_ref.kind` is limited to
  `organization_user | resource_group | organization_connection`
  (`public/v1/workforce/assignability.ts:3-7`), and it is single-valued — an event cannot
  carry a crew *and* equipment.
- **No cross-project availability/conflict model for anything but individual users**
  (`platform-scheduling.js:1051 availabilityForRole`). The Gantt surfaces no conflicts.
- **Gantt rows are work items, not resources** — `renderGanttScheduler`
  (`platform-schedule-view.js:4517`) has no `resources` option; only the routing schedulers do.

### Known inconsistencies to fix in passing

- Icon mismatch: backend default `fa-truck-pickup` (`materials/storage.ts:673`) vs frontend
  `fa-trailer` (`platform-schedule-view.js:4509`).
- `eventCategory()` maps equipment to `'other'` (`platform-scheduling.js:972`) while
  `isProductionEvent()` treats it as production (`apps/scheduling/app.js:658`) — the
  view-filter toggles will disagree once equipment events flow.
- `tests/materials-api.test.ts:660-673` asserts equipment scheduling stays disabled —
  must be updated when the capability flips it on.

---

## 2. Design principles

1. **One system, dialed by capabilities.** There is a single equipment model; org-level
   capability flags (§8) hide whole layers (maintenance, meters, operators, costing). A
   two-truck contractor and a heavy-civil GC run the same code with different flags.
2. **Equipment is a first-class assignable resource, not a project sub-object.** No
   project-modal equipment tab. Equipment appears where work appears: the global Equipment
   app, the scheduling surfaces, and scope-generated requirements.
3. **Reuse the assignment-policy seam.** The workforce assignability engine (subject types,
   rules, tags, capability scopes) is the extension point the codebase was built around.
   Equipment becomes a new subject type; "which crews can use which equipment" becomes
   assignment rules + operator requirements, not a bespoke tag system.
4. **Requirements vs. units.** Scopes declare equipment *requirements* by type
   ("1 disposal trailer"). Scheduling fulfills requirements with concrete *units*
   ("Trailer #2"). Small orgs can skip the distinction (auto-fulfill when a type has one unit).
5. **Data-driven everything**: categories, attributes, statuses, maintenance programs, and
   terminology are org-configurable data, mirroring `resource_group_kinds` /
   `assignment_tags` in workforce.
6. **UI preservation**: new surfaces follow existing patterns (portal tab app, settings tab,
   FontAwesome, `--primary` tokens); existing scheduling surfaces gain equipment lanes/filters
   without reformatting.

---

## 3. Domain model

New backend module `public/v1/equipment/` (api/schemas/service/storage per the `training`
pattern), sqlite store `equipment.sqlite` (node:sqlite, WAL, same conventions:
`id TEXT PK`, `organization_id`, `*_json`, `revision`, ISO timestamps).

### 3.1 `equipment_types` — the catalog (what kinds of equipment exist)

```
id, organization_id, name, category_id, description,
icon, color,
tracking            'unit' | 'quantity'        -- serialized units vs bulk pool
mobility            'mobile' | 'fixed' | 'portable'
default_meter_kind  'none' | 'hours' | 'miles' | 'both'
operator_requirements_json   -- [{ tag_id, label }] e.g. CDL-A, certified operator
attributes_schema_json       -- org-defined custom fields for units of this type
default_rates_json           -- { hourly_cents, daily_cents, weekly_cents }
scope_item_keys_json         -- aliases matching scope-template item ids/names (§6)
status, sort_order, revision, created_at, updated_at, archived_at
```

- `tracking: 'quantity'` covers bulk gear (ladders, cones, pumps): the type carries a pool
  `quantity`; availability = pool minus concurrently booked. `'unit'` types have serialized
  `equipment_units` rows.
- `mobility: 'fixed'` covers brick-and-mortar assets (spray booth, saw line, yard crane):
  scheduling books *capacity at a location* rather than dispatching to a site; travel/routing
  never applies; the unit's `location` is permanent.
- Categories (`equipment_categories`: id, name, icon, sort) are org data with shipped seeds
  (Vehicles, Trailers, Heavy Equipment, Attachments, Tools, Site Services, Facilities).

### 3.2 `equipment_units` — the fleet (what you actually own)

```
id, organization_id, type_id, branch_id,
name ("Trailer #2"), identifier (asset #), serial_number, license_plate,
year, make, model, vin,
ownership           'owned' | 'leased' | 'rented' | 'customer'
acquisition_json    -- { date, cost_cents, vendor, lease/rental terms, disposal }
status              'available' | 'in_use' (derived) | 'down' | 'reserved' | 'retired'
condition_status_id -- org-configurable status list (like pipeline stages)
location_json       -- { kind: 'yard'|'site'|'address'|'facility', label, address, project_id? }
home_location_json  -- default yard/facility
current_meter_json  -- { hours, miles, as_of }
rates_json          -- overrides type default_rates
attributes_json     -- values for the type's attributes_schema
operator_tag_overrides_json,
photos_json, documents_json (registration, insurance, manuals — platform docs refs),
tags_json (platform-tags), notes,
revision, created_at, updated_at, archived_at
```

`status` splits **administrative state** (down / retired / reserved — user-set or
maintenance-driven) from **derived state** (`in_use` computed from live bookings; never stored).

### 3.3 Meters & usage — `equipment_meter_entries`

```
id, organization_id, unit_id, kind ('hours'|'miles'), value, recorded_at,
source ('manual'|'assignment'|'maintenance'), event_id?, user_id
```

Simple orgs never see meters (capability-gated). Advanced orgs log readings from the field
(crew app check-in/out on an assigned event) and maintenance intervals key off them.

### 3.4 Maintenance — programs, work orders, downtime

```
equipment_service_programs:
  id, organization_id, type_id | unit_id, name,
  trigger_json  -- { every: {days | meter_hours | meter_miles}, or fixed dates }
  checklist_json (or checklist template ref — reuse apps.checklists templates),
  lead_time_days, estimated_downtime_hours, estimated_cost_cents

equipment_work_orders:
  id, organization_id, unit_id, program_id?, title, kind ('scheduled'|'repair'|'inspection'),
  status ('open'|'scheduled'|'in_progress'|'completed'|'canceled'),
  due_at | due_meter_json, scheduled_start/end, completed_at,
  assigned_to_json (user | vendor/organization_connection),
  cost_json ({ parts_cents, labor_cents, vendor_cents, invoice_ref }),
  meter_at_service_json, notes, checklist_state_json,
  downtime_event_id   -- link to the blocking calendar event (§5.4)
```

A scheduled work order generates a **downtime block**: a floating `calendar_events` document
with `resource_refs: [{kind:'equipment_unit', id}]` and `kind:'equipment_downtime'`. Downtime
blocks participate in conflict detection exactly like project bookings — no special casing.

Due-soon computation is a service function (`upcomingService(orgId)`) comparing programs
against elapsed days and latest meter entries; surfaced in the app dashboard and (optionally)
the platform action-items feed.

### 3.5 Assignments (bookings)

**No new booking table.** A booking *is* a schedule event referencing the unit. The event
model gains a plural `resource_refs: [{ kind, id, name, role? }]` (§5.1); equipment refs use
`kind: 'equipment_unit'` (or `kind: 'equipment_type'` + `quantity` for bulk). The equipment
module reads bookings by querying events — same source of truth as every schedule surface,
so there is nothing to keep in sync.

---

## 4. API surface — `/v1/equipment`

Registered in `public/v1/src/app.ts` (prefix `/v1/equipment`), routes gated with
`requirePlatformAuth(request, { orgId, capability: "apps.equipment", permission })`.

```
GET/POST/PATCH/DELETE /organizations/:orgId/types[/:typeId]
GET/POST/PATCH/DELETE /organizations/:orgId/categories[/:id]
GET/POST/PATCH/DELETE /organizations/:orgId/units[/:unitId]
POST   /organizations/:orgId/units/:unitId/meter-entries
GET    /organizations/:orgId/units/:unitId/history        -- bookings + service + meters
GET    /organizations/:orgId/availability?start&end&type_id&unit_ids
       -- per unit: bookings, downtime, free windows; per quantity-type: pool utilization
GET/POST/PATCH /organizations/:orgId/service-programs[/:id]
GET/POST/PATCH /organizations/:orgId/work-orders[/:id]
GET    /organizations/:orgId/dashboard                    -- counts, due service, conflicts
GET/PUT /organizations/:orgId/settings                    -- equipment module settings (§8)
```

Frontend client: `public/libraries/equipment-api/equipment-api.js` following `training-api`.

---

## 5. Scheduling integration

This is Path A from the audit — the assignable-subject seam — plus a Gantt resource-lane mode.

### 5.1 Events: plural `resource_refs`

`work_resource_ref` stays for compat, but `normalizeProjectEvent` (`platform/api.ts:3817`)
gains `resource_refs: [{ kind, id, name, role, quantity? }]`:

- `role: 'crew' | 'equipment' | 'operator'` distinguishes refs so an event carries a crew
  AND its equipment.
- Mirror rules: if `resource_refs` absent, derive from `work_resource_ref`; the first
  crew-role ref back-fills the singular mirrors (`assigned_crew_id` etc.) so every legacy
  reader keeps working. Update `eventAssignmentKeys` (`platform/api.ts:3756`) so policy
  enforcement covers equipment refs, and `sanitizedWorkAssignment` (`:3843`) +
  `workResourcePayload()` (`apps/scheduling/app.js`) to round-trip the new field.

### 5.2 Assignability: new subject type `equipment_unit`

- `ASSIGNABLE_SUBJECT_TYPES` (`workforce/assignability.ts:3`) gains `"equipment_unit"`
  (mirror in `platform-scheduling.js:147`).
- `listAssignableResources()` (`workforce/service.ts`) merges the equipment catalog into
  `subjects` with the standard projection: `{ subject_type:'equipment_unit', id, name,
  status, branch_id, kind_ids:[type_id, category_id], assignment_tag_ids,
  capability_scope_ids }`. The existing `assignable-resources` endpoint and policy resolver
  then work unchanged.
- **Crew↔equipment eligibility** (the thing that never got built) falls out of the existing
  rule engine: an `AssignmentRule` already supports `kind_ids`, `assignment_tag_ids`,
  `tag_match`, `capability_scope_ids`. Operator requirements are checked at assignment time:
  the type's `operator_requirements_json` tags must be present on at least one assigned
  user/crew member's profile tags (workforce user profile attributes). Advisory warning by
  default; hard block when `equipment.operators.enforce` is on.

### 5.3 Requirements → fulfillment (scopes drive scheduling)

- Scope equipment list items gain an optional `equipment_type_id` (matched via the type's
  `scope_item_keys_json` aliases, so existing presets like `disposal_trailer` bind without
  editing templates).
- `initialize-from-scope` (with `equipment.scheduling` on) generates the equipment schedule
  event as it already knows how to (`materials/storage.ts:807-831`) — now enabled — carrying
  `resource_requirements: [{ equipment_type_id, quantity }]`.
- The scheduler shows unfulfilled requirements as a badge on the event; picking a unit writes
  the `resource_refs` entry. **Simple-mode auto-fulfill**: when a required type has exactly
  one active unit, assign it automatically.

### 5.4 Availability & conflicts (the actual fleet-management win)

New shared logic, `availabilityForEquipment(unitIds, start, end, {excludeEventId})`,
server-side in `equipment/service.ts` with a frontend twin in `platform-scheduling.js`
(next to `availabilityForRole` at `:1051`):

- **Unit-tracked**: a unit is conflicted when any other event (project or downtime block)
  with a `resource_refs` entry for it overlaps the window. Optional per-type
  `allow_double_booking` (a truck can serve two nearby jobs in one day; an excavator cannot).
- **Quantity-tracked**: conflict when concurrent booked quantity exceeds pool quantity.
- **Down/retired** units are unavailable regardless of bookings.
- Server-side enforcement on `POST /events`: reject (409 `equipment_conflict`) when
  `equipment.conflicts.enforce` is on; otherwise return warnings the UI renders (same
  pattern as the crew conflict triangle at `apps/scheduling/app.js:2554`).

### 5.5 Gantt: resource lanes

`renderGanttScheduler` gains an opt-in `groupBy: 'resource'` row-builder branch
(`platform-schedule-view.js:4538-4570`): section rows per resource (crew or equipment unit),
child rows are that resource's events, an **Unassigned** section at the bottom, and a
red overlap highlight when two bars on one lane intersect. Downtime blocks render as
hatched bars. The org-wide scheduling app gets a "Group by: Project | Resource" toggle;
equipment joins the existing sales/production/material view filters (fixing the
`eventCategory` inconsistency so equipment is consistently `production`).

The three routing schedulers need almost nothing: they already accept
`resources`/`resourceIdForItem`/`canPlaceItemInResource` — supply equipment units as
resources (the `__materials__` pseudo-resource at `apps/scheduling/app.js:4077` is precedent).

### 5.6 Un-suppressing equipment events

- Flip the roofing preset to `controls.scheduling: true`, `schedule.enabled: true`
  **conditionally** — the generator consults the org's `equipment.scheduling` capability, so
  orgs with equipment off keep today's behavior byte-for-byte.
- Remove/gate the three `productionResourceType(e) !== 'equipment'` filters in
  `apps/project-schedule/panel.js` behind the same capability.
- Update `tests/materials-api.test.ts:660-673` to assert both modes.
- Unify the icon (`fa-truck-pickup` everywhere).

---

## 6. The global Equipment app

Manifest entry (`firstmate-apps-manifest.js`): `id:'portal.equipment'`, `package:'equipment'`,
`kind:'portal_tab'`, `terminologyKey:'equipment.portal_tab'`, icon `fa-truck-pickup`,
`access: managementAccess`, plus `appCapabilities['portal.equipment'] = 'apps.equipment'`
and `nestedRouteParams.equipment`. Bundle `public/libraries/apps/equipment/app.js`
(crew-style access-object registration, `mount` returning `{destroy}`), script tag in
`public/portal/index.php`.

Views (progressively revealed by capability tier — §8):

1. **Fleet** (always): card/table of units — photo, name, type, status chip, current
   assignment ("On: Smith Re-roof · Crew A"), location, next service due. Filters by
   category/type/status/branch. Unit drawer: details, photos/docs, meter log, booking
   history, service history, rates.
2. **Timeline** (with `equipment.scheduling`): the equipment-lane Gantt (§5.5) scoped to
   equipment resources — "when is everything in use." Same renderer, read/write.
3. **Maintenance** (with `equipment.maintenance`): due-soon board, work-order list/detail,
   service programs editor.
4. **Utilization** (with `equipment.costing`): booked-hours vs available, cost per unit,
   rental-vs-own comparisons — facts fed into the stats warehouse (stats.sqlite metric DSL)
   rather than computed ad hoc.
5. **Settings** (in-app): the same settings surface as the company-settings tab (§8),
   rendered by a shared module so there is exactly one implementation.

Field surface: crew app (workforce crew_api) gets a lightweight "my equipment today" list on
the dashboard plus meter-reading / damage-report entry — capability-gated, later phase.

Terminology: new `section('equipment', ...)` in `platform-terminology.js` CATALOG
(`portal_tab`, `settings_tab`, `equipment_unit`, `equipment_type`, `work_order`, ...) so
orgs can call it "Vehicles", "Assets", "Fleet".

---

## 7. Costing

- Unit/type rates (hourly/daily/weekly) × booked duration → **projected** equipment cost on
  the project's `scope_resource_list:<id>` expense target, replacing today's priceless items.
- Work-order costs post as supplemental expenses with the existing `equipment` category
  (`payments/schemas.ts:138`) — allocated to the org (overhead) or optionally to the project
  the unit was on.
- Remove the `paid_cents: 0` hardcode (`payments/storage.ts:1189`) so equipment can carry
  actuals (rental invoices, fuel, service).
- All capability-gated under `equipment.costing`; orgs without it see no money anywhere in
  the equipment UI.

---

## 8. Settings & the complexity dial

### Capability nodes (`public/v1/platform/capability_defs.ts`, Field & Workforce category)

```
apps.equipment                kind:app      default:false  runtime_app_id:'equipment'
equipment.scheduling          kind:feature  parent:apps.equipment  default:true
equipment.requirements        kind:feature  parent:apps.equipment  default:false  -- scope-driven req/fulfillment
equipment.maintenance         kind:feature  parent:apps.equipment  default:false
equipment.meters              kind:feature  parent:equipment.maintenance default:false
equipment.operators           kind:feature  parent:apps.equipment  default:false  -- certifications/CDL checks
equipment.costing             kind:feature  parent:apps.equipment  default:false
permission.equipment_view     kind:permission  access:read   permission_key:equipment.view
permission.equipment_manage   kind:permission  access:write  permission_key:equipment.manage
permission.equipment_service  kind:permission  access:write  permission_key:equipment.service
```

`apps.equipment` defaults **off** — exactly the "feature flag until they turn it on" case.
Orgs whose scope sets include no equipment never see any of it. Add to
`capability_presets.json` / `builtinCapabilityPresets()`: on in `field_operations` and
`full_platform` (scheduling only), off elsewhere.

### Module settings (equipment.sqlite `settings`, one row per org)

Behavioral knobs that aren't on/off gates: conflict mode (`warn` | `block` | `off`),
auto-fulfill single-unit types, default meter units, downtime auto-blocking, operator
enforcement (`warn` | `block`), field meter entry on/off.

### The tier presets (what the user actually touches)

The settings UI leads with a one-question dial that writes the flags above:

| Tier | What it turns on | Who it's for |
|---|---|---|
| **Off** | nothing (`apps.equipment` false) | scope sets have no equipment |
| **Simple** | app + scheduling; conflict=warn; auto-fulfill on | "the truck is on the job" |
| **Standard** | + requirements, maintenance, costing; conflict=block | typical contractor |
| **Advanced** | + meters, operators, enforcement | heavy equipment / enterprise |

Individual flags remain adjustable after picking a tier (the tier is a preset, not a mode).

### Surfaces

One shared settings renderer used in two places: (a) the Equipment app's Settings view,
(b) a company-settings **Equipment** tab in `company.js` — remembering all seven parallel
edit sites, the single-line `tabAllowed` chain at `company.js:1957`, and the duplicate
`can*` block at `:14213`.

---

## 9. Build phases

1. **Registry + app shell.** `/v1/equipment` module (types, categories, units, settings),
   capability nodes, manifest/app registration, Fleet view, terminology section, settings
   tab. Ships value alone: a place to see your stuff.
2. **Scheduling.** `resource_refs` on events, `equipment_unit` subject type, availability +
   conflict service, un-suppress scope equipment events, assignment UI in the schedulers,
   equipment filters. Simple tier is fully served after this phase.
3. **Gantt resource lanes + Timeline view.** `groupBy:'resource'`, overlap highlighting,
   downtime rendering, "Group by" toggle in the scheduling app.
4. **Maintenance.** Programs, work orders, downtime blocks, due-soon dashboard,
   action-items integration.
5. **Requirements, operators, costing, utilization.** Scope `equipment_type_id` binding,
   operator certification checks, rates → expenses, meters, stats warehouse facts, crew-app
   field surface.

Each phase is independently shippable and independently gateable.

---

## 10. Competitive landscape (researched 2026-07-25) — gaps and decisions

Surveyed: ServiceTitan (Fleet Pro / installed equipment / inventory), Buildertrend, Procore
(Equipment + Resource Management), and dedicated fleet platforms (Fleetio, Tenna, HCSS
Equipment360/FuelerPlus, B2W Maintain, EquipmentShare T3, Samsara).

Context: **Buildertrend has no equipment module at all** (a known product gap), and Procore's
is a registry + job-costing layer with no maintenance. The table-stakes set across dedicated
platforms is: GPS/telematics with geofence alerts, meter-based preventive maintenance, work
orders, digital inspections, utilization reporting, and a mobile field surface. This spec
already covers everything in that list except telematics and daily inspections.

### Adopted into this spec (cheap, high-value)

- **Custody / check-out (tool-crib) tracking** (Tenna's differentiator). Add
  `custody_json: { user_id|crew_id, checked_out_at, expected_return_at }` to
  `equipment_units`, check-out/check-in actions in the app and crew app, and printable
  QR labels per unit that deep-link to the unit page (`?equipmentItem=<id>` route). Answers
  "who has the ladder" without GPS hardware. Phase 5, gated by a new
  `equipment.custody` feature flag (Simple tier can enable just this + scheduling).
- **Pre-use inspections (DVIR-style)**. Table-stakes in every fleet platform. Extend
  service programs with `kind: 'inspection'` + `trigger: per_assignment | daily`, reusing
  checklist templates; a failed item can auto-open a repair work order and optionally set
  the unit `down`. Phase 4.
- **Fuel & consumables entries**. Add `kind: 'fuel'` to meter entries
  (`{ gallons, cost_cents, odometer }`) posting to the equipment expense category. No fuel-card
  import initially. Phase 5, under `equipment.costing`.
- **Telematics adapter seam (integration, not hardware).** Every dedicated platform leads
  with GPS; we should not build hardware, but the model must not preclude a feed. Add
  `location_source: 'manual' | 'assignment' | 'telematics'` to units (assignment-derived:
  unit location follows its active booking's project address — free win), and design the
  ingest as an adapter accepting the **AEMP/ISO 15143-3** standard feed (what B2W/HCSS
  consume) writing `location_json` + meter entries. Adapter itself is post-v1.
- **Utilization/TCO depth** (Fleetio's differentiator). The §6 Utilization view's stats
  facts should include: booked vs. idle days, cost-per-hour (service + fuel + rental),
  and lifetime cost vs. acquisition — enough for repair-vs-replace and rent-vs-own calls.
  No depreciation schedules (that's accounting software).
- **Procore-style project cost actuals.** Booked-hours × rate is projection; actual usage
  hours captured from field meter/time entries flow to the project's equipment expense
  target as actuals. Already implied by §7; made explicit.

### Noted as a separate future module (not this system)

- **Customer-owned installed equipment** (ServiceTitan's core "equipment" concept):
  equipment records on customer service locations, per-unit service history, warranty
  tracking, membership/recurring-service agreements driving repeat revenue. This is a
  *service CRM* feature, not fleet management — different lifecycle, different owner. The
  `ownership: 'customer'` value in §3.2 is only for customer gear temporarily in our
  custody. If FirstMate targets service/replacement trades (HVAC, plumbing), spec this
  separately as e.g. `docs/installed-equipment-spec.md`; recurring service events would
  ride the existing recurrence-series machinery.

  Direction decided 2026-07-25: the workflow layer (recurring visits, checklists, comms,
  billing) is a **well-written scope set on a long-lived "maintenance" project per contact**
  — existing machinery, no new app. What scope sets + custom fields cannot provide is unit
  *identity*: custom fields are project-scoped scalars (docs/custom-fields-v3.md), not
  repeating collections, so a customer with three HVAC units gets no per-unit service
  history, no cross-customer unit reporting ("all Carrier units >10 yrs" for replacement
  campaigns), and no warranty automations. The fix is thin: reuse this module's
  `equipment_units` table with `ownership:'customer'` + a `contact_id`/service-location
  ref, let events/work-orders reference unit ids for history, and let the maintenance
  scope set read/write those units. One units table, two ownership worlds.

### Integration backlog (non-MVP, requires external hardware/APIs)

- Telematics ingest adapter (AEMP/ISO 15143-3; vendor APIs: Samsara, Azuga, GPS Insight)
  → live map, geofence/after-hours/theft alerts, auto meter readings
- Engine fault-code (OBD-II/J1939) driven maintenance alerts
- Dashcams / AI safety cameras (hardware programs like Azuga SmartView)
- Driver scorecards (speeding/braking/idle — needs telematics accelerometer data)
- GPS-verified timesheets / payroll reconciliation
- Fuel-card transaction import (WEX/Fleetcor) with misuse detection
- IFTA/DOT/ELD/HOS compliance reporting
- Live-GPS nearest-resource dispatch & route optimization
- BLE/RFID tag hardware for bulk tool tracking (printable QR labels need no hardware and
  are already in scope)

### Deliberately out of scope

- Hardware telematics, dashcams, driver scorecards, theft recovery (ServiceTitan Fleet
  Pro/Samsara/Tenna sell hardware; we integrate via the adapter seam instead).
- DOT/IFTA/HOS/ELD compliance (Samsara/Fleetio territory; trucking-regulatory, not ours).
- Parts inventory & shop management (Fleetio/HCSS/B2W CMMS tier) — work orders carry costs
  and free-text parts; stocked-parts inventory would belong to the pricebook/materials
  domain if ever needed.
- Truck-as-warehouse material inventory & replenishment (ServiceTitan Inventory) — a
  materials-domain feature, not equipment.
- GPS-based timesheet reconciliation and route optimization.

## 11. Open questions

- **Bulk pools per branch?** Quantity-tracked types probably need per-branch pool quantities
  for multi-branch orgs; deferred until a real need.
- **Rentals as first-class?** `ownership:'rented'` with acquisition terms covers tracking;
  a rental-return reminder could ride the work-order system. Deferred.
- **Operators as a scheduling constraint vs. a check.** Spec says advisory-then-enforced
  check at assignment time; full "auto-pick a qualified operator" solving is out of scope.
- **`resource_refs` merge semantics.** Event writes merge field-wise last-writer-wins
  (`mergeProjectEmbeddedEvents`, `platform/api.ts:3690`); concurrent equipment assignment
  from two surfaces can clobber a ref list. Acceptable initially (same exposure as
  `assigned_user_ids` today); revisit if it bites.
