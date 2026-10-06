# Automation authoring contract

Scopes are versioned templates that instantiate Work plans; the Work engine runs
their automations. This guide covers the layer between the two: the contracts an
editor or an agent builds automations against. It does not change how events are
stored, leased or executed. Read [the Work API](../../public/v1/work/README.md) and
[scope templates](../../public/v1/scopes/README.md) for the runtime itself.

Everything here is served by one read:
`GET /v1/scopes/organizations/:orgId/automation-catalog` (`manage_company_settings`),
built by `work/catalog.ts`. The Automations Agent reads the same catalog through
its `get_automation_catalog` tool.

## Actions have typed inputs

`work/automations/catalog.ts` gives every registered automation a title, a
category and a JSON Schema for its binding `input`. `x-control` on a property
names the editor widget (`template_text`, `role_ids`, `scope_template`, `code`,
…) and is ignored at run time. Text inputs accept `{{template}}` interpolation,
so numeric inputs are typed `["number","string"]`. `internal: true` marks setup
actions that run from defaults and are not offered in a picker. Templates walk
lists by position, so `{{project.contacts.0.phone}}` is the first contact's phone.

Adding an automation means registering the handler and adding its catalog entry.
`tests/automation-contracts.test.ts` fails when a registered action has no entry,
when an entry is not registered, or when an input the handler documents is not a
typed property. Runtime validation of published actions stays in
`platform/publication/work-actions.ts`.

## One condition contract

`work/conditions.ts` evaluates conditions for scope bindings, external triggers,
sequence steps, organization rules and intake routing. Two spellings, freely
nested:

```json
{ "payload.payment_kind": "deposit", "project.claims.welcome_call": "" }
```

Every entry must match; a list means any of; `""` means missing or empty.

```json
{ "match": "all", "rules": [
  { "field": "project.total_cents", "operator": "greater_than", "value": 1000000 },
  { "field": "payload.received_at", "operator": "after", "value": "now-3d" },
  { "match": "any", "rules": [ { "field": "project.tags", "operator": "contains", "value": "insurance" } ] }
] }
```

Operators: `equals`, `not_equals`, `in`, `not_in`, `contains`, `not_contains`,
`starts_with`, `ends_with`, `is_present`, `is_missing`, `greater_than`,
`greater_or_equal`, `less_than`, `less_or_equal`, `before`, `after`. `before` and
`after` take an ISO date, `now`, or a relative time (`now-3d`, `now+2h`; units
`m`, `h`, `d`, `w`). Fields are dot paths over `event`, `payload`, `context`,
`project`, `plan` and `node`; a path that does not resolve is retried under
`payload.`.

Intake routing keeps its stored shape (`{match, conditions: [{field, operator,
value}]}`) and its matching style: case-insensitive, with a comma-separated value
read as a list. Malformed conditions are rejected when a scope template or the
organization rules are saved.

## Binding keys mean one event

`automation_bindings` are keyed by a lifecycle hook or a full event name
(`work/bindings.ts`):

- `onReady`, `onStarted`, `onCompleted`, `onSkipped`, `onCanceled`, `onBlocked`,
  `onDue`, `onTimer` on a work item mean that item's own `work.node.*` event; on a
  scope, `onCreated`, `onStarted`, `onCompleted` mean its `work.plan.*` event.
- A full event name (`payment.received`) matches that event when it explicitly
  targets the work item or scope.

A hook does not answer another domain's event that shares its suffix, and
neither spelling hides the other: both lists run, hook entries first, deduplicated
by binding id. Saving a template rewrites `work.node.completed`-style keys to the
hook, so stored definitions have one spelling per event.

A saved `proposal.signed` subscription matches a signed proposal from either
path: the retired proposal link, or a proposal signed through Documents
(`document.signed` with `document_type: "proposal"` or a `proposal` tag). That is
what moves the sales pipeline's signature step.

## Sequences

A work item may declare `sequence` for "do this, wait, then do that":

```json
{ "start": "ready", "steps": [
  { "id": "text_now", "actions": [ { "automation": "communications.sendSms.v1", "input": { "text": "Thanks for reaching out!" } } ] },
  { "id": "email_later", "wait": { "days": 2 }, "conditions": { "project.replied": "" },
    "actions": [ { "automation": "communications.sendEmail.v1", "input": { "subject": "Still interested?", "text": "…" } } ] }
] }
```

`wait` is the delay after the previous step, so times accumulate from the moment
the item becomes ready (`start: "started"` anchors on start instead). A step's
actions run in order; step and action conditions both apply. The sequence ends
when the item is completed, skipped or canceled, so an external trigger such as
`communication.received` stops a cadence when the customer replies.

`work/sequences.ts` compiles a sequence, when the plan is created, into what the
engine already runs: one-shot node timers (`sequence:<step>`) and bindings on
`onTimer` and the start hook, each marked `compiled_from: "sequence"`. The engine
has no sequence concept, and compilation is idempotent. Templates keep the
authored `sequence`; the event map and artifact views show its compiled timers
and actions as read-only entries.

`timers` (`{id, anchor: created|ready|started|due, offset_minutes}`) are now part
of the node schema rather than an unvalidated extra.

## Organization rules run several actions

A rule keeps one trigger (`event` or `schedule.cron`) and conditions, and may
list `actions`:

```json
{ "id": "deposit_thanks", "event": "payment.received", "conditions": { "payload.payment_kind": "deposit" },
  "actions": [
    { "id": "text", "automation": "communications.sendSms.v1", "input": { "text": "We received your deposit." } },
    { "id": "todo", "automation": "work.createTodo.v1", "input": { "title": "Order materials" }, "conditions": { "project.kind": "roof" } }
  ] }
```

Actions run in order as separate idempotent executions (`org_rule:<rule>:<action>`).
An action's conditions are checked in addition to the rule's, against project
state as left by earlier actions. A single `automation`/`input` on the rule itself
is still accepted and runs first under the rule's own id. Rule ids, and action
ids within a rule, must be unique.

## Dry run

`POST /v1/scopes/organizations/:orgId/branches/:branchId/automation-dry-run`
(`scopes/dry-run.ts`) replays steps against a definition and reports what would
happen. Nothing is executed or saved.

```json
{ "template_id": "sales_pipeline", "project_id": "…",
  "steps": [ { "advance": { "days": 2 } }, { "event": "communication.received", "payload": { "channel": "sms" } },
             { "transition": { "node_id": "send_proposal", "status": "completed" } } ] }
```

- Subject: `template_id` (a new instance of a saved template), `definition` (an
  unsaved draft), or `plan_id` (the current state of a running instance).
  `rules` tests draft organization rules; `include_organization_rules: false`
  leaves them out. `project_id` supplies real data; `project` layers sample fields.
- The reply lists, per step and event: organization-rule and binding actions with
  whether they would run, why not, the condition results, the interpolated input
  and any input problems against the action catalog; external-trigger
  transitions; then the final work-item statuses, pending timers and project
  changes. `issues` holds definition problems such as unknown actions.
- It mirrors the engine's order (organization rules, external triggers, then
  bindings), dependency unlocking and parent roll-up. Effects are not performed:
  only `project.patch.v1` and `project.claim.v1` alter the simulated project that
  later conditions read, and custom code is reported rather than run.

Dry run is exposed to agents (`dry_run_automations`) and over HTTP for tests and
tooling. It is intentionally not offered in the product UI.

## Pushing a template change to running instances

A plan runs the template version it was created from, so a saved edit affects
instances started afterwards. `scopes/instances.ts` moves running instances to
the current version when asked:

- `GET …/templates/:templateId/instances` previews, per open instance, the work
  items that would be updated, added or no longer exist.
- `POST …/templates/:templateId/instances/update` applies it. Body: optional
  `plan_ids`, `project_ids`, and `removed_work` (`keep` by default, or `skip`).
- `PUT …/templates/:templateId` accepts `apply_to_instances: "open"` to save and
  push in one request. Without it, a save never touches running instances.

An update replaces automations (bindings, triggers, timers), dependencies and
completion mode on existing work items and keeps their status, history,
assignments and notes. Title and description follow the template only where the
instance still shows the previous version's text. New work items are added as
pending and become ready through the normal rules, which runs their automations.
Removed work items are kept unless `removed_work` is `skip`, which skips open ones
and runs their skip automations. Finished and canceled instances are never
changed. Each update is recorded on the plan (`metadata.template_updates`).

How the product asks a customer whether an edit should reach existing leads is
an open design question for the automations editor; the backend supports both.

## Verification

Run `npm run check` and
`node --experimental-sqlite --import tsx --test --test-force-exit tests/automation-contracts.test.ts`
from `public/v1`, alongside `tests/automation-engine.test.ts`,
`tests/scope-event-map.test.ts`, `tests/scope-artifacts.test.ts` and
`tests/project-scopes-routing.test.ts`.
