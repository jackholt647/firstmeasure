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

## Labor pay

Read [pay sheets](docs/architecture/pay-sheets.md) before changing how assignees
are paid, or how labor lists are priced. There is no
shared catalogue of priced labor tasks: each party has a pay sheet that declares
its inputs and is evaluated against a job. A sheet that reads a measurement
names a measurement schema. Evaluation is deterministic and leaves a line
unresolved rather than pricing it at zero; an agent may author a sheet but never
computes pay. Run `tests/labor-pay-sheets.test.ts` for changes here.

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
returns steps. Availability comes from commitments alone. Run
`tests/labor-commitments.test.ts` for changes here.

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

## Project window content ownership

Read [project content layout](docs/architecture/project-content-layout.md) before changing project modal tabs or sidebars. Overview owns the project-details column inside its tab content. Other apps own their own content rails. There is no configurable shared modal left region or left-column override API; do not recreate one.
