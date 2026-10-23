# FirstMeasure working instructions

> **Directory move pending (September 23):** The physical canonical checkout is
> still `C:/Users/jackh/Code/2026/FirstMeasure`. Windows blocked the move because
> multiple Codex helpers hold this directory open. `FirstMate Platform` paths
> below describe the intended destination; it does not exist yet. No alias or
> duplicate was created. See [rename status and completion](docs/canonical-rename-status.md).


On a fresh clone or another computer, read [NEW_COMPUTER.md](NEW_COMPUTER.md)
first for the handoff branch, prerequisites, SSH setup, and Git workflow. Read
the linked release and incident records before proposing a production release.
Git push authorization does not itself authorize production activation.

For deployment, production troubleshooting, infrastructure changes, or planning a release, read [DEPLOYMENT.md](DEPLOYMENT.md) first. It records the completed migration, current architecture, deployment workflow, required production fixes, and remaining release-baseline work. Verify current state; historical IPs and release IDs may change.

Preserve unrelated changes in the existing workspace. A fresh worktree may lack uncommitted code already deployed to production. Do not bulk deploy, reset, clean, or replace the workspace without reviewing the actual source baseline.

Production deployment requires user authorization; honor authorization already given in the current conversation without requesting it again. Preparing documentation or a release does not itself authorize activation.

## Named infrastructure

- `dev sync droplet` means the dedicated development host at SSH alias `dev-sync-droplet`.
- Its normal account is `dev`; its default project directory is `/home/dev/code`.
- Connect through the existing SSH configuration. Never expose, print, copy, or transmit a private SSH key.
- Infer sync paths/direction only from adequate context. Do not infer deletion, mirroring, or overwrite semantics from a generic sync request.

## Performance work deferred on purpose

[docs/optimization-backlog.md](docs/optimization-backlog.md) is the one list of
known performance shortcuts (full scans, repeated work, things that will not
scale). Add an entry when you knowingly ship one, link it from the relevant
architecture doc, and remove it when it is done. An optimization must return
exactly the same results.

## Canonical source

The active combined platform checkout is `C:/Users/jackh/Code/2026/FirstMate Platform`
on `codex/consolidated-firstmeasure-20260923`. Read
[docs/canonical-checkout.md](docs/canonical-checkout.md) before source reconciliation
or handoff. Older worktrees preserve recovery history; do not silently switch
to them or reimport their files. Deploy immutable verified commits from the
canonical branch using the existing deployment workflow. Development deployment
authorization does not authorize production deployment or topology changes.

## Core mobile app

The sole Android/iOS app is the global FirstMate platform host at
[`native/firstmate`](native/firstmate/README.md). Measurements is one module.
Do not restore retired customer or management prototypes or infer app ownership
from legacy package identifiers.

## Architecture continuity

The sole core Android/iOS app is the global **FirstMate** platform host at
[`native/firstmate`](native/firstmate/README.md). FirstMeasure/Measurements is a
module within it. Do not recreate the removed customer or management prototypes
or infer app ownership from the checkout name or legacy package identifiers.

Before editing the global assistant, its instructions, memories or tools, read
[global assistant architecture](docs/architecture/global-assistant.md).

Before data/action publication or document/scope architecture work, read
[the agreed design and pending audit](docs/architecture/data-actions-continuity.md).
It links the full-conversation continuation. Audit the canonical integrated
source before treating earlier checkout findings as current facts.

## Forms

Read [forms](docs/architecture/forms.md) before changing website forms, their
public runtime, pricing or booking. A form is steps of blocks published as a
workflow document module; there are no form types. Add capability as a block
kind or a template, never as a mode. There is no forms agent: the shared
assistant edits forms with its `forms_*` tools and the editor's AI tab is that
assistant in a `form:<id>` conversation. Form calculations run evaluate-only in the
module sandbox with no data or action bindings; do not widen that for anonymous
requests without a publication-layer design. Appointment blocks book through the
appointments domain writer using an appointment type; do not compute slots or
write events in `public/v1/forms`. Run `npm run test:forms` and
`npm run test:forms:browser` in `public/v1` for changes to these contracts.

## Editing documents as sent

Read [editing a document as sent](docs/architecture/document-as-sent-editing.md)
before changing "Edit manually", binding resolution (`resolveBindings` trace),
document input rules or `/documents/:id/inputs`. The editor shows the same
render the PDF is made from. A value from the document's data is an input:
typing writes the data through `writeDocumentInputs` (which saves with
`patchDocumentInstance`) and everything derived recomputes; totals and other
calculated values are never typed. Other text is a `props.blocks` override
whose bindings stay live, with `base` set so a later template change is
flagged, not lost. Add behavior for a kind of data as an input rule in
`documents/inputs.ts`, never per template. Run
`tests/document-as-sent-editing.test.ts` and
`tests/doc-sent-editor-browser.test.mjs` for changes here.

## App experience

Read [app experience](docs/architecture/app-experience.md) before changing which
apps anyone sees, on which device, an app's options, or a route's app gate.
There is no management or field application and no office/field distinction:
a role gives different apps in different places. Every app a person opens (a
portal tab, a project view, a contact view) is declared once in
`platform/app-experience/registry.ts` with the device types it exists on
(`platform/app-experience/devices.ts`, data), its organization switches and its
options. Visibility is set per device by roles, groups, departments and the
person, in People › App experience; an app the organization has off is not
offered. Whether someone has an app is not a permission: never hide an app
because of a permission, and never declare visibility in a manifest entry or
app bundle. A setting that is not about what someone may do (Today's time
clock) is an app option. A route that belongs to an app names it with
`requirePlatformAuth({ app })`. Run `tests/app-experience.test.ts`,
`tests/app-experience-registry.test.ts` and `tests/access-gates.test.ts` for
changes here.

## Payments

Read [payments](docs/architecture/payments.md) before changing how customers
pay, refunds, autopay, payment forms or the merchant account. Every charge,
saved card, autopay enrollment and online payment request checks
`requirePaymentsReady` on the server; nothing is ever recorded as paid without
a processor charge (cash and check are recorded as such). Card and bank details
are typed only into Forward's element; a browser payment pays a prepared
checkout (`prepareCheckout`), and every Forward write carries an idempotency
key a retry reuses. The simulator never runs on production data. Run
`npm run test:payments` for changes here.

## Contacts, leads and opportunities

Read [contacts](docs/architecture/contacts.md) and
[opportunities](docs/architecture/opportunities.md) before changing contacts,
lead intake, matching, merging or sales scopes. A contact is its own record in
the `contacts` store; a project names contacts by link and `project.contacts`
is a read-only projection. There is no lead record or lead status. Every
project runs scopes; a lead that has none yet is a **new lead**. An opportunity
is a new lead or a work plan whose scope template has the built-in `sales`
category, and a lead is a contact with an open one. A project starts only
through `receiveLead` (every intake source) or `createProject`
(`projects/create.ts`, which always starts a scope); intake routing runs once,
at arrival, and nothing else routes a project. Other project writes pass
`mustExist` or an `expected_revision`. What happens to a new lead (who is
told, the first call) is organization rules on `lead.received`. Never
hard-code a business decision (when a sale is won, how many sales plans run):
bind an action in the scope or add a setting with a default. Every store that
keeps contact or project ids registers a reference adapter so merges reach
it. Run `tests/contacts-store.test.ts`, `tests/contact-merge.test.ts`,
`tests/lead-receive.test.ts`, `tests/new-leads.test.ts` and
`tests/project-entry.test.ts` for changes here.

## Platform publications and programmable modules

Read [publication architecture](docs/architecture/publication-architecture.md)
before adding cross-app data access, business operations or programmable logic.
Read [permissions and agents](docs/architecture/permissions-and-agents.md)
before changing role grants, permission checks, published operation access, or
agent tools. Preserve FirstMeasure's seven production permission flags.
Publish typed data through `platform/publication/providers.ts` and business
actions through `platform/publication/actions.ts`; register adapters during
shared bootstrap. Reuse domain services and their resource authorization.
Do not expose raw collections, credentials, arbitrary HTTP proxies or privileged
work contexts to module code. Reads must not create or mutate domain records.

Update the application ownership inventory in `publication/coverage.ts` for
new apps, and add behavior tests for authorization, schemas and effects.
Run `npm run test:publication` and `npm run check` in `public/v1` for changes to
these contracts. Custom code uses the bounded document-module sandbox;
freezing belongs to consumer bindings, with immutable provenance and fresh
authorization on replay. Never substitute a new action implementation for a
pinned unavailable version. The architecture guide records migration limits;
registration coverage alone does not prove every legacy endpoint is migrated.

The concurrently maintained FirstMeasure editor under `public/measure/internal`
is outside this architecture change. Preserve its work and stage only the files
owned by the current task when preparing commits or release artifacts.

## Measurements

Read [measurement dictionary and schemas](docs/architecture/measurement-schemas.md)
before adding a measurement, a producer of measurements, or anything that binds
to one. A measurement has one shared definition in
`platform/publication/measurement-schemas.ts`; a kind of work selects from the
dictionary with a schema, and scope templates name their schemas. The dictionary
only grows: never change a definition's meaning, unit or key, and when unsure
whether two trades mean the same thing, define two. Producers such as FirstMeasure
fill dictionary keys and do not invent names. Run
`tests/publication-measurement-schemas.test.ts` for changes here.

## CRM

Read [CRM](docs/architecture/crm.md) before changing CRM views, worklists, results,
sources and spend, the funnel, cancellation windows, the CRM presets or the CRM app.
The CRM adds no lead record: collections are read-only rows built from contacts,
projects, plans, events and to-dos, filtered by branch and department access, and
filters are the one condition contract. Results, bulk actions and cancellations
reuse the existing writers. Funnel steps are read from work events and never
stored. A cancellation window is a scope step; production starts when it ends.
Presets only add what an organization lacks. Run `tests/crm-views.test.ts`,
`tests/crm-rescission.test.ts` and `tests/crm-app-browser.test.mjs` for changes
here.

## Completion and closeout

Read [closeout](docs/architecture/closeout.md) before changing how a labor list
is finished, paid out or locked, the completion widgets, or project closeout.
Finished work is **finalized** (`labor/completion.ts`), never released; a
released commitment was taken back. A finalized list is locked: every writer
that can change a labor list's lines calls `assertLaborListOpen`. Piece-rate pay
is earned on `finalized_at`. Only `reopen_finalized_work` reopens finalized work
or a closeout, always with a reason. Closeout checks read other apps through the
published data layer, warn and never block; the only thing that stops a close
is an unfinalized work order. Confirmation is the `work.completion` widget with
one `method` parameter; do not add another confirmation control. Run
`tests/labor-completion.test.ts` and `tests/closeout-completion-browser.test.mjs`
for changes here.

## Labor pay

Read [pay sheets](docs/architecture/pay-sheets.md) before changing how assignees
are paid, or how labor lists are priced. There is no
shared catalogue of priced labor tasks: each party has a pay sheet that declares
its inputs and is evaluated against a job. A sheet that reads a measurement
names a measurement schema. Evaluation is deterministic and leaves a line
unresolved rather than pricing it at zero; an agent may author a sheet but never
computes pay. Run `tests/labor-pay-sheets.test.ts` and `tests/pay-sheets-editor-browser.test.mjs` for changes here.

Read [pay rules](docs/architecture/pay-rules.md) before changing how anyone is
paid, payroll earnings, pay runs or time clock pay. Earnings are derived: a pay
rule declares its inputs as selections over published data, runs in the sandbox
and returns what was earned; a refresh posts only the difference to the ledger
and never edits a posted entry. Rules are grouped into pay plans and assigned,
added, removed or overridden per payee, all effective-dated. Any assignee can be
a payee. Who is paid for a role on a project is an assignee custom field on the
project; do not add payee lists, commission settings on scope templates, or
code that posts pay directly from an event. A formula that cannot be evaluated
leaves the earning unresolved, never zero. Run `tests/pay-rules.test.ts` and
`tests/pay-sources.test.ts` for changes here.

Read [assignees](docs/architecture/assignees.md) before changing who work is
assigned or committed to, units, commitments, delivery or availability. Say
**assignee** for a person, group of users or outside company that work can be
assigned to; `work_resource_ref`, "assignable subject" and "subject" are older
names for the same thing and stay only where they are stored. "Crew" is not a
platform word: what a group or unit is called comes from the terminology system,
so do not write it into contracts, field names or fixed copy. A commitment is a
frozen copy and is never edited. Delivery code runs in the sandbox and only
returns steps. A commitment says nothing about when anyone is free. Run
`tests/labor-commitments.test.ts` for changes here.

## Assignee base and roster

Read [the assignee base and the roster](docs/architecture/assignee-base.md)
before changing what every assignee has, the assignee directory, who is on a
piece of work, time off or staffing requirements. The three kinds (user, group
of users, outside company) keep their own stores and share one contract in
`public/v1/assignees/`, filled by one adapter per kind; ask a **trait**
(`has_members`, `has_login`, `external_link`, `splits_pay`), never the kind.
"Capability" is not a word for these: it means what kinds of work an assignee
can do (`labor/capabilities.ts`). A shared field is read from the home it
already had; do not copy it into the base record. **Kind** is which of the
three. **Types** are always `type_ids`, a list: a user's types are their access
roles (there is no user type and no user type list), a group has exactly one
type (its `kind_id`), and an outside company has zero or more company types.
Ask `assigneeTypeIds`. Permission defaults belong to the group type: its
`member_role_ids` are added to a user when they join a group of that type, on
every path that adds a member, and nothing is removed when they leave; setting
them needs `manage_company_user_permissions`. Pay attaches to types, never to
tags. An assignment is a list of entries that
add or remove an assignee, each optionally for part of the work; who is on the
work is the roster resolved from it, with time compared as exact intervals and
a person in two groups counted once. What is true of a person is an ordinary
user field and rolls up to groups in the data layer; do not bless a field.
Every assignee has `branch_ids` ([branches](docs/architecture/branches.md)). A
**staffing requirement** is a count and a condition in the one condition
contract; "requirements" alone means what a job needs done. Unmet staffing
requirements and conflicts warn; a save is refused only when an
organization or assignee sets double-booking to block. Run `tests/assignee-base.test.ts`,
`tests/assignee-roster.test.ts` and `tests/assignee-base-store.test.ts` for
changes here.

## Branches and regions

Read [branches](docs/architecture/branches.md) before changing branches,
regions, where departments live, who belongs to which branch or what anyone
may see of other branches. The hierarchy is organization -> optional flat
regions -> branches -> departments. Say **branch** and **region** in code; the
UI words come from the terminology system. A department belongs to one branch;
there are no department categories and no organizational units (divisions). A
user, group or outside company belongs to one or more branches in the home it
already had (`branch_id` plus `branch_ids`; a company with none works in every
branch). Multiple branches is the `platform.multiple_branches` feature; with it
off, or with one branch, the default branch is implicit, needs no name and
nothing about branches shows. **Branch scope:** with more than one branch,
People data and its writes are limited on the server to the caller's own
branches unless they have `view_region_branches`/`manage_region_branches` or
`view_all_branches`/`manage_all_branches`; scope only removes, it never grants.
`organization-structure.ts` stays the one structure resolver. Run
`tests/branches.test.ts` and `tests/organization-structure.test.ts` for
changes here.

## Requirements and coverage

Read [requirements](docs/architecture/requirements.md) before changing what a
job requires, how a line accounts for it, capabilities, or the Requirements
tray. A project has two lists that carry money (materials and the work order)
and requirements, which carry none. What a project requires is the sum of its
scope artifacts (ledger sets published by an accepted document, added by hand
or built by an agent) and never comes from the scope set, which only says what
a kind of work could include and how it is sized. A work item or function has one shared
definition in `platform/publication/work-items.ts`, sized from measurements and
never priced; the dictionary only grows. Coverage is read from the lists as
they stand: a generated line carries what it pays for, and a pay sheet maps pay
to work with `covers`, `work` and `provides`. Work is counted once: use the
measurement partitions to tell a line that pays from one that adjusts, and do
not add parts of different partitions together. A warning never blocks. Run
`tests/work-requirements.test.ts` for changes here.

## Project change history

Read [project change history](docs/architecture/project-history.md) before
adding a writer that changes a project's lists, scope or schedule, or a
generator that writes them. Every change to a project's real work is recorded
append-only by the domain writer, on the server, with its source (person,
agent, automation, module, generator or system); `history/source.ts` carries
the source, so nothing passes it by hand. A generator records its run with
`recordGeneration`, writes inside `withChangeSource({ kind: "generator" })` and
stamps `generation_id` on its lines, so what people do to generated work is
told apart from it. Read history through the `project-history` provider, never
the tables. Run `tests/project-history.test.ts` for changes here.

## Schedule events

Read [schedule events](docs/architecture/schedule-events.md) before changing
what a schedule event stores, who or what it is assigned to, how events relate
to each other, or how double-booking is checked. An event is one time range plus
the resources it uses for that whole range, in `resource_refs` and nowhere else;
anything that needs a different range is a child event (`parent_event_id` plus a
`placement`), and the parent drives it. Do not add a second field that names an
event's assignee or list, dates on a resource, or a range derived from children.
Whether an assignee is free comes from events through `assessAssigneeOverlap`,
with capacity from the assignee's units; what an overlap does (`warn`, `block`,
`allow`) is a setting of the organization and of the assignee. Run
`tests/schedule-events.test.ts` and `tests/scheduling-event-writes.test.ts` for
changes here.

## Automations

Read [automation authoring](docs/architecture/automation-authoring.md) before
changing scope automations, organization rules, conditions or the Automations
Agent's tools. Conditions have one contract in `work/conditions.ts`; do not add
a second matcher. A registered automation needs a typed entry in
`work/automations/catalog.ts`. Express waits as a node `sequence`, which
compiles to timers and bindings; do not add sequencing to the engine. A template
save affects new instances only; reaching running ones is the explicit push in
`scopes/instances.ts`. Dry run is for agents and tests and is not a product UI
feature. Run `tests/automation-contracts.test.ts` for changes to these contracts.

## Agent how-to index

Read [agent how-to index](docs/architecture/agent-how-to-index.md) before
adding or changing a recipe that tells agents how to combine capabilities into
a business task. Entries are source data in `public/v1/agents/how-tos/entries`,
one file each, listed in `how-tos/index.ts`. Agents fetch a body with
`platform_how_to_search` and `platform_how_to_read`; only ids and titles go in
the shared prompt, never an entry body. Every id a step names must be
registered. Mark a step `planned` when what it needs is not built, and verify a
recipe against the code before writing it as fact. Run
`tests/agent-how-to-index.test.ts` for changes here.

## Realtime: one stream per page

Read [realtime](docs/architecture/realtime.md) before adding anything that
pushes from the server to a page. A page holds one long-lived connection, the
platform event stream. Publish facts with `publishRealtimeEvent`; carry live
per-page state (presence, collaboration) as a channel registered with
`registerRealtimeChannelKind` and watched with `PlatformRealtime.watchChannel`.
Never create an `EventSource`, `WebSocket` or streaming `fetch` in browser
code, and never add another `text/event-stream` endpoint: browsers allow six
connections per site across all tabs, and each extra stream silently starves
ordinary requests. Run `tests/realtime-single-stream.test.ts` and
`tests/view-presence-client.test.mjs` for changes here.

## Session replay

Read [session replay](docs/architecture/session-replay.md) before changing what
pages record, the replay viewer, or anything `platform-api.js` loads on every
page. Recording is the organization feature `platform.session_replay`, off by
default and never part of a preset; only platform administrators switch it on
or read replays. Apps never mark elements for tracking: add `data-fmr-mask` to
a field that must not be recorded and `data-fmr-ignore` to UI that must not
appear in replays. The recorder posts chunks; it never opens a stream. Bump the
`?v=` values when a library file changes. Archives are lossless and pinned to
their vocabulary versions: never change how a stored archive decodes (a new
writer gets a new `ARCHIVE_FORMAT`), and keep customer text out of the platform
vocabulary. Run `tests/session-replay-browser.test.mjs`,
`tests/session-replay.test.ts` and `tests/session-replay-archive.test.ts` for
changes here.

## Session replay search

Read [session replay search](docs/architecture/session-replay-search.md) before
changing how recordings are indexed or the tools a language model uses to
question them. The index is derived from recordings alone and can always be
rebuilt (bump `INDEX_VERSION`); recordings stay exact and are only opened to
drill into a moment. Element and screen ids must stay stable across sessions
and organizations. Field values never enter the index. Tools are for platform
administrators, or a coding agent holding an access key one of them created
(MCP at `/v1/platform/session-replay/mcp`); a key opens the search tools and
nothing else. Run `tests/session-replay-insights-browser.test.mjs` and
`tests/session-replay-agent-access.test.ts` for changes here.

## Project window content ownership

Read [project content layout](docs/architecture/project-content-layout.md) before changing project modal tabs or sidebars. Overview owns the project-details column inside its tab content. Other apps own their own content rails. There is no configurable shared modal left region or left-column override API; do not recreate one.
