# CRM

The CRM is a way of looking at and working records that already exist. It adds no
lead record. The records are a **contact** ([contacts](contacts.md)), a **project**
with its **opportunities** ([opportunities](opportunities.md)), **schedule events**
([schedule events](schedule-events.md)) and **to-dos** (follow-ups). The CRM adds
four things on top of them:

1. **Views**: saved filters over a collection of those records, shown as a list, a
   board or an agenda, shared or personal, pinned as a person's daily lists.
2. **Worklists**: working a view one record at a time (call, text, record what
   happened, schedule the next touch, next).
3. **Sources and the funnel**: where each lead came from, what it cost, and how far
   it got, read from history.
4. **Building blocks for industries**: appointment setting on the scheduling system,
   agreements signed before a sale, structured records such as an insurance claim,
   cancellation windows and reviews, all configured by scopes and presets.

Everything a business might do differently is data: scopes, presets, settings and
organization rules. Every word the CRM shows comes from terminology. Features a small
company does not need stay off behind capabilities, and the setup turns on what fits
the company's industry and size.

## Words

Every label below is a terminology key in the `crm` section of
`platform-terminology.js` (and the generated contract), so an organization renames
it once and every screen follows. Funnel step names and source names are the
organization's own data, like stage titles, and are not terminology keys.

| Key | Default | Meaning |
|---|---|---|
| `crm.portal_tab` | CRM | The app |
| `crm.lead` / `crm.leads` | Lead / Leads | A contact with an open opportunity |
| `crm.new_lead` / `crm.new_leads` | New lead / New leads | A lead with no scope yet |
| `crm.customer` | Customer | A contact with a won opportunity |
| `crm.opportunity` / `crm.opportunities` | Opportunity / Opportunities | An open sales question on a project |
| `crm.lead_state` / `crm.relationship` | Lead state / Relationship | The state fields of the two collections |
| `crm.source` / `crm.sources` / `crm.source_type` | Source / Sources / Source type | Where a lead came from |
| `crm.disposition` | Result | What happened on a touch |
| `crm.follow_ups` | Follow-ups | The follow-ups collection |
| `crm.appointment` / `crm.appointments` / `crm.next_appointment` | Appointment / Appointments / Next appointment | Booked meetings |
| `crm.call_list` / `crm.worklist` | Call list / Worklist | Lists worked by phone |
| `crm.funnel` | Funnel | Steps from lead to net sale |
| `crm.rescission` / `crm.rescission_until` | Cancellation window / Can cancel until | The time a customer may cancel |

## Views

A **view** is `{collection, filter, sort, group_by, layout, columns}` plus who sees it.

**Collections** (`crm/records.ts`). Each is a list of flat rows built from the
records, with a field catalog the browser shows as filters, columns and groups:

- `opportunities`: one row per project that arrived as a lead or has a sales scope:
  the project, its primary contact, lead source (catalog source with its path,
  channel and provider), the active plan and stage, state (`new_lead`, `open`, `won`,
  `lost`, `closed`), value, next appointment, next follow-up, last touch, age, won
  and lost dates and reason, the cancellation window (`rescission_until`), rating,
  funnel milestones reached (`milestone.<id>`, with dates), branch, tags and custom
  fields (`cf.<path>`). Custom fields come from the scope templates as well as the
  projects, so a view can filter on a field before any project has it.
- `contacts`: one row per contact: name, kind, phone, email, tags, and what their
  projects say: relationship, lead, new lead, customer, open opportunities, last
  activity, leads referred and value won.
- `follow_ups`: one row per open follow-up to-do or call-list entry: due, overdue,
  list, attempts, channel, the project and contact.
- `appointments`: one row per project event of an appointment type or preset: start,
  type, who it is with, confirmation, status, upcoming, the project and contact.

Rows are built server-side from the stores (contacts, projects, work plans and nodes,
work events, results), filtered by the caller's branch scope and department access,
and never written to. Building them reads every record of the collection; that is in
the [optimization backlog](../optimization-backlog.md).

**Filters** use the one condition contract (`work/conditions.ts`): chips that become
`all`/`any` groups, the shared operators, relative times (`now-7d`). Views add three
relative values resolved per viewer before evaluation: `$me` (the viewer's user id),
`$my_branches` and `$my_departments`. One shared "My leads" view works for every rep.

**Display** is separate from the filter: layout (`list` or `board`; `calendar`, an
agenda, for appointments), group-by with counts and value, sort, visible columns. The
first column can carry a second line (the address under a contact's name).

**Who sees a view.** `private` (the owner), `roles` (named roles), `everyone`. A view
can be pinned by default for roles; `*` pins it for everyone. Sharing a view or
making it a role's default needs `manage_company_settings`. Changing a view in the
browser is unsaved until the person picks **Save for everyone**, **Save as new view**
or **Discard**. Pins are per person; a person can hide a shared view without deleting
it. The view and panel are in the URL (`crmView`, `crmPanel`).

Saved views live in the `crm` SQL store (`crm/views.ts`, `crm.sqlite`), with
preferences, source spend and results. Every organization gets the base views
(`crm/presets.ts`, `BASE_VIEWS`) on first load; presets install views by a stable
`preset_key`, never overwrite one, and a preset view someone deleted stays deleted.

**Bulk actions** on selected rows run in the browser through the existing writers,
four at a time, reporting what failed: work these, assign a person field, start a
scope, schedule a follow-up, mark lost with a reason, tag, and merge two contacts or
two projects.

## Worklists

Any view can be worked ("Worklist"). It steps through the view's rows (up to 1,000)
or a selection: the person, their phones and email, the opportunity and its stage,
and the history. Call and text go through comms (`Portal.Communications.open` and the
project's comms tab). The person records a **result**: what happened (talked, left
voicemail, no answer, texted, met), an outcome from the work configuration's
follow-up outcomes, a note and when to try again, then **Save and next**. Skip (`S`)
and Back move without recording.

- A result is `POST /v1/crm/organizations/:orgId/results` (`crm/results.ts`). On a
  call-list entry the call-list disposition path runs; on a follow-up to-do the
  follow-up outcome path runs (retry ladder, successor follow-up). On any other row a
  follow-up outcome creates a follow-up (on the date given, or by the follow-up
  schedule), and a lost outcome marks the opportunity lost. A note becomes a
  `call_note` message on the project channel. Every result is kept (`crm_results`)
  and emits `crm.disposition.recorded`, so organization rules decide what follows.
- Rows already worked or skipped in the session are not shown again.
- Call lists stay: automations add entries (`crm.callLists.add.v1`), and a call list
  is worked like any view of follow-ups.

## The record

Selecting a row opens the **lead drawer** beside the list: contact header with
state, actions (call, text, email, set appointment, result, open project, more:
start a scope, mark lost), the cancellation window with **Customer cancelled** while
it is open, each opportunity with its scope and stage, source, value, next
appointment and follow-up, the rating, the fields a scope shows in its overview, the
contact's phones, emails and tags, and the history (arrival, results, appointments,
won and lost). Calls, texts and email are in the project's comms tab, one click away.

## Sources and attribution

The **source catalog** (`crm/sources.ts`, branch module `crm_sources`, default
branch) is a tree: source, sub-source, campaign or event. Each has a channel (web,
phone, referral, canvass, event, aggregator, paid, email, walk in, other), match
rules in the condition contract over the arriving project (`lead_source.kind`,
`provider`, `utm_source`, `utm_medium`, `utm_campaign`, `gclid`, `fbclid`,
`page_url`, `form_id`, tracking number, connection), and an active flag.

`receiveLead` calls `stampLeadSource`: it copies the ad tracking tags of the page a
lead came from onto `lead_source` (UTM tags and click ids, for any the intake did not
record), then stores the most specific matching source (`source_id`, `source_path`,
`source_channel`): Website › Google Ads before Website. A person may correct it on
the project; a source a person set is never replaced.

**Spend** is entered per source and period (`crm_source_spend`) and prorated by the
days a report's period overlaps it. A funnel row carries the spend entered on its
own source; a source that was paid for and brought no leads still shows. Spend and
cost are shown only with `crm.source_spend` and `manage_company_settings`.

A **referral partner** is a contact whose leads name them
(`lead_source.referrer_contact_id`); the contact row counts the leads they sent and
the value won. Setters and reps are credited by the funnel; who is paid for a role
stays an assignee field on the project ([pay rules](pay-rules.md)).

## The funnel

The **funnel** (`crm/funnel.ts`, branch module `crm_funnel`) is an ordered list of
steps, each reached when the first matching work event happens on a project:

```ts
{ id, label, when: [{ event: "project.event_scheduled", conditions }], unless: ["cancelled"], credit: "actor" | "assignee" | "", color }
```

`node.template_node_id` is available to conditions, so a step can be a scope step
(Contingency signed is `work.node.completed` of `sign_contingency`). `unless` drops a
step a project also reached another step for. `credit` names who gets the step in
reports: the event's actor (the setter who booked) or the appointment's assignee (the
rep). The default funnel is Lead, Appointment set, Appointment held, Won; presets
replace it (below).

Steps are computed per project from the work event log and are fields on the
`opportunities` collection. **Reports** (`GET .../funnel/report?from&to&group`) take
the leads that arrived in the period and count how far each got, grouped by source,
source type, scope, setter, rep, branch, month or not at all, with step-to-step
rates, spend and cost per step. Each cell names its projects, and the app opens them
as a view.

## Appointment setting

Appointments are booked with the scheduling system, the same as production work:
the booking dialog (`FirstMateBooking.open`) with appointment presets
(`scheduling.appointment_catalog`), availability, travel time and the planned
booking writer. The CRM opens it from the drawer and the worklist with the project
locked; nothing in the CRM computes slots or writes events.

- A preset names the event type its bookings carry (`event_type_id`, default
  `appointment`; "Counts as" in the preset settings). The sales preset names
  `sales_appointment`, so a booking from the CRM or a website form advances the sales
  scope and counts as Appointment set.
- The `appointments` collection gives the confirmation list (Unconfirmed in the next 2
  days) and a rep's day (a view filtered on With is `$me`).
- Territories, timeslot grids per market and a forward look at unfilled slots are
  designed, not built: they belong to the scheduling system, for every kind of
  appointment.

## Building blocks for industries

**Agreements before a sale.** A scope stage completes when a document is signed. The
insurance roof sale scope's Claim stage has *Get the contingency agreement signed*,
completed by `document.signed` with `contingency` in its `document_tags`. A
consultation waiver or a membership agreement is a document template plus a stage;
signing one mints no receivables unless its type says so.

**Structured records on a project.** A scope contributes a custom field group, shown
on the project and in the lead drawer and filterable in views. The insurance roof sale
scope adds Insurance claim: status, carrier, claim number, date of loss, cause,
adjuster and their phone and email, adjuster meeting, deductible, replacement cost,
actual cash value and mortgage company. No claim record type is built into the
platform.

**Cancellation windows (rescission).** The `crm_rescission` module (`crm/rescission.ts`)
holds rules: days, how days are counted (`calendar`; `business`, Monday to Saturday;
`weekdays`), federal holidays skipped or not, and conditions in the condition contract
over the project, its primary contact (with `contact.age` from a birthday) and its
lead source. The first matching rule applies; with none, or with rescission off, the
sale has no window. The window is a scope step (`rescissionStage` in
`scopes/presets/industry.ts`):

- `onReady`: `sales.startRescission.v1` sets the step's due date to the end of the
  last day the customer may cancel, in the organization's time zone, and records the
  signed proposal; with no rule it skips the step.
- A timer on the due date runs `work.finishItem.v1`, completing the step.
- `onCompleted` and `onSkipped`: `scopes.activateFromProposal.v1` with the recorded
  proposal starts production. The closing stage of these scopes marks the sale won at
  signing but does not start production.
- **Customer cancelled** (`POST .../projects/:projectId/cancel-sale`, needs
  `manage_projects` and `crm.rescission`) makes the won sale whose window is open
  lost, which cancels its open work, so production never starts.

The deadline is mirrored on the plan (`metadata.rescission.deadline`) for the
`rescission_until` field. A Net sale or Sale stands funnel step is the window step
completing or being skipped. Same-day presets have no cancellation step.

**Reviews.** The feedback system asks for a rating when a scope binds
`feedback.requestReview.v1`. The rating is a field on leads and shows in the drawer.

**Financing.** Not built; it waits for the financing partner. Applications will be a
provider integration writing events (`financing.applied`, `financing.approved`,
`financing.declined`) that funnel steps and scope stages use, the same way payments
do. Nothing in the CRM needs to change for it.

## Presets and size

`crm/presets.ts`. The CRM settings panel's **Set up for your business** (and
`POST .../presets/apply`, needs `manage_company_settings`) applies an industry pack
and, when asked, the features for the team size. Applying only adds: views a company
lacks, a source catalog when it has none, a funnel and cancellation rules when it has
never saved them, and the pack's scopes when they are not installed. Applying a
second pack adds its scopes and views only.

| Pack | Adds |
|---|---|
| Roofing and exteriors | Insurance roof sale scope; canvassing, storm, lead vendors, yard signs, insurance agent sources; Lead, Inspection set, Inspected, Contingency signed, Won, Sale stands; federal cooling-off rule; Open claims view |
| In-home sales | In-home sale scope (production after the window); events, canvassing, lead vendors, direct mail, TV and radio; Lead, Appointment set, Sat, Sold, Net sale; federal cooling-off rule; In the cancellation window view |
| Home services and repair | Lead vendor, local services and yard sign sources; the default funnel |
| Appointment businesses | Walk-in, online booking, social sources; New client, Booked, Visited; Due to rebook view |
| Something else | The base views and sources |

Every pack also adds the common sources (Website with Google Ads and Facebook and
Instagram under it, Phone call, Referral, Repeat customer). The industry scopes live
in `scopes/presets/industry.ts` and are not installed in every organization.

| People | CRM features on |
|---|---|
| 1–2 | Views, sources (plus appointments and follow-ups, which every size has) |
| 3–10 | Worklists, call lists, the funnel |
| 11 or more | Spend and cost per lead |

Capabilities (`apps.crm` children): `crm.views`, `crm.worklists`, `crm.sources`,
`crm.source_spend`, `crm.funnel`, `crm.rescission`, `crm.call_lists`; appointment
setting uses `scheduling.appointment_slots`. A pack with cancellation rules turns on
`crm.rescission`. A feature that is off renders nothing: no menu, panel or setting.

## Published data

The CRM collections are published as the `crm` provider (`crm/publication.ts`), with the
exports `opportunities`, `contacts`, `follow_ups` and `appointments`: the rows the CRM tab
shows, nested by their dotted keys (`cf.crm.owner` is the path `cf` › `crm` › `owner`),
limited by the caller's branch scope and department access. An export reads its collection
once per execution, so a program's selections share one build. Reads never write.

`crm.leads.update` (organization scope, `manage_projects`, idempotent) writes declared
custom fields on one lead's project, `{ project_id, values }`, through
`custom-fields.project.write` with the caller's own access. It is how a program that works
across many leads (routing, a reassignment sweep, a score) changes one of them.

## Lead routing and scoring

Routing and scoring are programs, not features. CRM settings › Lead routing saves the
`crm_routing` branch module (`crm/routing.ts`) and turns it into organization rules, every
one with an id starting `crm_routing_`, whose action is `scope.code.run.v1`: a sandbox
program with the settings as its inputs. Saving replaces only those rules; a company's own
rules are left alone.

| Rule | Trigger | Program |
| --- | --- | --- |
| `crm_routing_assign` | `lead.received` | routing, mode `assign` |
| `crm_routing_reassign` | every five minutes, when *Pass on if untouched* is set | routing, mode `reassign` |
| `crm_routing_score_<event>` | lead received, result recorded, appointment booked or held, won, lost | scoring |

The settings:

- **Method**: take turns (whoever has waited longest for a lead), by share (each person's
  share of leads routed in the last 30 days, from their weight), fewest open leads, or by
  rules (the first rule whose conditions the lead matches picks the people, who take turns;
  no match falls through to the people list).
- **Most open leads per person** skips anyone at the limit; **When nobody can take it**
  names the fallback people.
- **Pass on if untouched after** moves a lead whose owner has not touched it since it was
  routed, to the next person (never back to the same one), up to **Times a lead may be
  passed on**. A touch is the lead's `last_touch_at`.
- **Lead scoring**: rules of conditions and points; the score is the sum of the points of
  the rules the lead matches, and is written only when it changes.
- Conditions are the one condition contract over the lead's row (any opportunities field:
  source, scope, stage, value, custom fields, funnel milestones), edited with the same
  filter editor as views.

The programs write four declared project fields, added to every branch when routing or
scoring is turned on: `crm.owner` (Lead owner, a person), `crm.score` (Lead score),
`crm.routed_at` and `crm.route_count` (background). Because they are ordinary fields,
views filter and group on them, worklists and the board use them, and pay rules can read
the owner.

**What a program can read.** A program declares bindings; each binding names a published
source (`provider`/`export` and a target). It may read a binding whole with
`api.data.read(name)` or query it with `api.data.select(name, selection)`: the shared
selection (`where` in the condition contract, `orderBy`, `period`, `limit` up to 5,000)
plus `fields`, a list of dotted paths returned as flat keys. Any published provider can be
a binding, so a program may draw on the whole data layer; nothing is hidden from
automation beyond what its author may see. The standard routing program selects open
leads and leads routed in the last 30 days to count each person's load, and selects a
single lead with a rule's conditions to test whether it matches. The trigger is
`state.trigger` (`type`, `project_id`, `payload`, `at`).

**Custom code.** CRM settings › Custom code shows both programs. Editing one stores it in
`custom.routing_source` or `custom.scoring_source`, and the rules run it instead of the
standard program, with the same inputs, bindings and outputs; *Use the standard program*
clears it. A program in an organization rule must be the one saved in the rules (its hash
is checked) and runs with the access of whoever last saved the rules.

## The CRM app

`portal.crm` (`public/libraries/apps/crm/app.js`, `crm.css`), the CRM tab. It is declared
in the app registry (`platform/app-experience/registry.ts`) with the organization switch
`apps.crm`, and its manifest entry and bundle name `apps.crm` too, so More apps can open
and pin it. Who sees it, on which device, is App experience
([app experience](app-experience.md)); `crm.views` off shows that views are off.

**Every CRM route names the app** (`requirePlatformAuth({ app: ["portal.crm"] })` in
`crm/api.ts`), including the reads of sources, the funnel and cancellation rules: only the
CRM tab calls them. Lead intake (`stampLeadSource` in `receiveLead`) and the cancellation
step (`sales.startRescission.v1`) read those settings in-process from `crm/sources.ts` and
`crm/rescission.ts`, never through the routes, so the app gate does not reach them. A new
consumer outside the CRM tab reads the module or a published provider, not these routes.

The tab:

- **Rail**: pinned views with live counts, more views, New view, then Funnel,
  Duplicates, Sources and CRM settings. At phone width it slides over the page.
- **View header**: name and count, layout switch, filter chips and Add filter,
  Display (group, sort, columns), search, Worklist, the view menu (pin, rename,
  duplicate, share, hide, delete), and the save bar when changed.
- **List**: selectable rows, groups with counts and value, the bulk bar on selection,
  load more. At phone width rows are cards.
- **Board**: columns by the group-by field; stage columns are the stages of the
  scopes present plus New leads. Dragging to a stage starts or moves the scope;
  dragging to a person sets that field.
- **Agenda** for appointments, by day.
- **Lead drawer** on row select; the **worklist** as a focused full panel.
- **Funnel**: period and grouping, bars and the table, each cell a link to its leads.
- **Duplicates**: suggested contacts and projects side by side; keep one or dismiss.
- **Sources**: the tree with rules, and spend.
- **CRM settings**: setup, lead routing and scoring with their custom code, the funnel
  steps, cancellation rules.
- Keyboard while the CRM is on screen: `/` search, `f` filter, `j`/`k` next and
  previous row, `Esc` close, `Ctrl+K` command menu, `S` skip in a worklist.

## Not built

Timeslot grids, financing, triggers keyed on a contact, and a funnel step editor for
conditions (steps with conditions are
kept and shown, and are edited through the API or presets).

- **No place record** (decided 2026-10-19): an address lives on the contact and on the
  project; nothing waits on a shared property or site.
- **Triggers keyed on a contact** (decided to build): contact writers emit contact events
  (created, updated with the changed fields, tagged, merged); a date on a contact can fire a
  rule; rule conditions read the contact; actions text or email the contact, create a to-do,
  or start a lead through `receiveLead`.
- **Territories** are routing rules: a rule whose conditions name ZIP codes, a state or a
  branch, with the people who cover it. A map editor is not built.

Validation: `tests/crm-views.test.ts` (collections, views, results, sources, spend,
the funnel, presets, tracking tags and the cancellation window),
`tests/crm-rescission.test.ts` (deadlines and rules), `tests/crm-routing.test.ts` (routing
by turns, capacity, fallback and rules, scoring, passing on untouched leads) and
`tests/crm-app-browser.test.mjs` (the app in a browser against the server; set
`CRM_SCREENSHOTS` to keep a screenshot of each screen).
