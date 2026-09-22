# Scope Templates API

Scope templates are versioned workflow definitions. There are two kinds:

- `kind: "production"` — proposal project pieces such as Roof Replacement, Repairs, Gutters, Siding, and Maintenance.
- `kind: "pipeline"` — entry workflows such as the default `sales_pipeline`. The sales board derives from this template exactly like production boards derive from theirs; there is no separate CRM stage system.

A template carries its display metadata, proposal fields, and the complete work-plan definition that should be instantiated when the scope starts. A project can hold multiple scope instances (work plans) at once; per-instance stages and project-level lifecycle facts (`lifecycle.status` open/completed/canceled/lost, `sold_at`, `completed_at`) are denormalized onto the project document as `work_projection` — there is no `project.stage`.

The scope library is a canonical catalog separate from installed scope instances. A catalog template remains selectable after installation; selecting it creates a new scope with copied board behavior, automations, fields, resources, checklists, and commissions. Copies record `library_template_id` / `based_on_preset` provenance without modifying the source template.

## The automation engine around scopes

- **Event catalog**: every platform event is registered in `public/v1/work/events.ts` with a description and a visibility (`activity` = human-relevant, shown in the activity feeds at `/v1/work/organizations/:orgId/activity` and `.../projects/:projectId/activity`; `system` = machinery, stored and automatable but hidden from feeds). All events persist in the work event store with actor attribution.
- **Organization automation rules** (`public/v1/work/rules.ts`, branch module `automation_rules`, API `.../branches/:branchId/automation-rules`): the always-on layer above scope sets, evaluated on every event before any scope binding. Rules are `{event | schedule: {cron}, conditions, automation, input}`. Ships nearly empty — the only default creates payment receivables on `proposal.signed`.
- **Conditions everywhere**: external triggers AND automation bindings accept `conditions` — dot-path equality over `event/payload/context/project/plan/node`, so automations can gate on live project state (e.g. `{"project.claims.welcome_call": ""}`).
- **Claims** (`project.claim.v1`): atomic test-and-set on `project.claims[key]` so parallel scope instances coordinate (one welcome call across roof + gutter scopes).
- **Time triggers**: nodes declare `timers: [{id, anchor: created|ready|started|due, offset_minutes}]` and react in `onTimer` bindings (`work.node.timer` events, one-shot); org rules with `schedule.cron` fire `time.cron` on a 5-field cron (minute resolution).
- **Data context providers** (`public/v1/work/context.ts`): automation inputs interpolate any registered namespace — `{{organization.name}}`, `{{users.by_role.sales_appointments.0.email}}`, `{{pricebook.default.catalog...}}`, `{{branch.<moduleId>...}}`, `{{scopes.list...}}`, `{{money.obligations...}}`, `{{work.active_instances...}}`, or project media such as `{{media.by_tag.before_photos.0.media_id}}` — lazily loaded and cached per event. New subsystems register a provider to become scriptable.
- **No blessed subsystems**: custom-field schema contribution, materials, checklists, and commission setup run as default `onStarted` bindings (`customFields.initializeFromScope.v1`, `materials.initializeFromScope.v1`, `checklists.initializeFromScope.v1`, `payroll.reconcileScopeCommissions.v1`) injected from template content; deposit-time reconciliation is a preset binding (`scopes.reconcileProjectResources.v1`); receivables are a default org rule. Templates override any default by declaring a binding with the same id.

## Intake routing and transitions

- New projects are routed into an entry scope by the intake router (`router.ts`), configured per branch in the `intake_routing` module. The module stores a guaranteed `default_template_id` fallback, optional ordered field formulas in `rules`, and the data-driven scope `buckets` used by Project Scopes settings. Formula conditions match dot-paths on the project document (for example `lead_source.kind`). Setting the fallback to a production template creates a production-only intake flow. The default buckets are Sales Scopes and Production Scopes, but organizations can rename, replace, and reassign them.
- Scope-to-scope transitions are automations, not engine code: `scopes.activateFromProposal.v1` (bound to the pipeline's signature node in the preset) instantiates one production plan per signed proposal piece, and `scopes.activateTemplate.v1` activates any fixed template (`input.template_id`) for arbitrary chaining.
- Proposal piece types map to templates through data: each template's `proposal.piece_types` claims its vocabulary, and a template with `proposal.fallback: true` (the Manual preset) catches the rest.

## Automations and artifact editors

Settings → Project Scopes → a scope → Automations uses the read-only
`GET /v1/scopes/organizations/:orgId/branches/:branchId/templates/:templateId/event-map`
endpoint (`manage_company_settings`). It combines the saved scope definition,
runtime setup defaults, compiled commission bindings, organization rules, and
registered event/action documentation. It includes hidden and unused entries,
conditions, inputs, timers, and transition destinations. Lifecycle aliases on
non-work events are shown with their explicit plan/node targeting requirement.
This is a configuration explorer, separate from the agent inventory and from
execution history; browsing it does not execute functions. The previous agent
automation interface remains in Assistant.

Artifact tabs project the same saved definition into To-dos, Checklists,
Documents, Materials, Events (calendar requirements), Notifications,
Communications, Labor & equipment, Project fields, Calls, Scope transitions,
Visit workflows, Customer Portal, Payments, and Other outputs. `artifacts.ts` describes creation
timing, conditions, original configuration, and links to automations and related
artifacts. It follows declared transitions into lifecycle hooks, preserves
explicit targeting requirements, and includes disabled outputs. It cannot infer
undeclared side effects inside arbitrary functions; these retain their function
documentation and source parameters in Other outputs.

`GET .../templates/:templateId/artifacts` returns the artifact catalog and resolves
only document templates explicitly referenced by this scope. Repeated uses of
one document are grouped while retaining each invocation's parameters and edit
target. Resource schedules describe relative timing and dependencies, not booked
project dates. `resources`, when present, takes precedence over legacy `materials`
just as it does at runtime.

`PATCH .../templates/:templateId/artifacts` accepts `expected_version`, an
`artifact_id`, optional `usage_id` for a document invocation, and `changes`.
Supported fields update the original definition path, then pass the complete
scope schema through the normal versioned save. There is no second artifact
store. Existing artifact edits, Details, and Commissions auto-save after a short
pause. Requests are serialized, use the latest confirmed version, and retain
invalid or failed edits with an explicit unsaved status. New artifacts use Add
once their configuration is ready. Creation accepts `type`, `changes`, and a lifecycle `trigger`; it adds an
executable binding (or a checklist preset). Existing scope instances retain
their installed definitions. Management permission and CSRF protection apply;
outdated versions return 409. Payments compiled from commission definitions are
inspected here and edited through Commissions.

## Stored Definition

Each branch template may define:

- name, plain-English description/details, icon, color, status, and sort order
- proposal-specific fields and metadata
- work-plan title and terminology overrides
- recursively nested work nodes, dependencies, assignments, due offsets, triggers, and automation bindings
- optional material-list definitions: stable id/title/color, price-book selectors, scheduling metadata, and allowed order sources
- optional project checklist definitions (`checklists`): stable id/title/icon, `kind` (`todo` or `quality`), `audience` (`crew` or `supervisor`), a `crew_editable` flag, global `assignment_policy`, and default items (`item_type` of `todo` or `rating`). `customer_access` is hidden by default and can independently enable portal visibility, customer completion, customer item editing, and voice mode (`off`, `complete`, or `edit`).
- optional `custom_fields` groups and typed fields. Dotted paths are durable,
  additive project schema contributions. Assignment reference types reuse the
  workforce `assignment_policy`; `default_from` can fill an empty field from
  the first qualifying event assignment. See
  [`../../../docs/custom-fields-v3.md`](../../../docs/custom-fields-v3.md).
- optional `communications.email_forwarding`, targeting a literal email,
  organization user, or assignment custom-field path

Material behavior belongs to the scope template rather than to an industry switch. A template with no `materials` definition creates no lists or delivery events. The Roof Replacement preset defines ordered Dry-In (`#dc2626`) and Shingle (`#f97316`) lists, manual ordering, and disabled/coming-soon SRS Distribution and Convoy Supply integrations. Selectors may match price-book item ids, item-type ids, categories, or tags; they are resolved against the organization catalog with the bundled catalog as a fallback.

`storage.ts` persists immutable versions and a current-version pointer. Saves use optimistic concurrency through `expected_version`, and seeded defaults upgrade safely without replacing branch edits. A signed proposal retains the exact template id and version it used.

## Runtime Flow

1. The proposal builder loads active templates from `/v1/scopes` and lets the user add one or more scope pieces.
2. Each selected piece keeps its own section name, structures, fields, and template version.
3. Proposal snapshots freeze each piece's selected `root_items` and project `measurements`; signing emits the canonical work event and instantiates one work plan per signed scope piece.
4. The work engine starts eligible nodes, exposes current to-dos and stages, and runs registered setup or node hooks.
5. A template material definition idempotently generates selected scope items into its lists and ensures any configured unscheduled delivery requirements; project work remains its own schedule item.
6. A template `checklists` definition idempotently instantiates project checklists (keyed by `scope:<template_id>:<checklist_id>`) through the workforce checklist store. Every preset ships a crew Safety checklist, a crew Work checklist, and a supervisor Completion quality review whose items are rated good/neutral/bad (bad requires a note). Projects without scope-defined checklists lazily receive the generic defaults on first read. Crew visibility, completion, and editing are governed by the field permissions `crew.checklists.view|complete|manage|supervise` plus each checklist's `audience` and `crew_editable` flag; the office manages everything from the project modal Checklists tab.

The API is mounted at `/v1/scopes`. It supports listing templates, reading current or historical versions, versioned saves, archive/delete, and resetting seeded defaults.

## Publishing scope work to Calls

Call lists are organization-wide CRM objects. A scope should publish a callable work node through lifecycle automation bindings instead of teaching the Calls UI how to infer a queue from project stages. The standard pattern is:

```json
{
  "id": "mid_project_call",
  "title": "Mid-project check-in",
  "actionable": true,
  "automation_bindings": {
    "onReady": [{
      "id": "queue_mid_project_call",
      "automation": "crm.callLists.add.v1",
      "input": {
        "list": {
          "key": "roof_mid_project",
          "title": "Roof Mid-project Calls",
          "kind": "production",
          "icon": "fa-helmet-safety",
          "tone": "production",
          "sort_order": 40,
          "assigned_role_ids": ["production"],
          "assigned_user_ids": [],
          "metadata": { "purpose": "mid_project_checkin" }
        }
      }
    }],
    "onCompleted": [{ "id": "dequeue_completed_call", "automation": "crm.callLists.remove.v1", "input": {} }],
    "onSkipped": [{ "id": "dequeue_skipped_call", "automation": "crm.callLists.remove.v1", "input": {} }],
    "onCanceled": [{ "id": "dequeue_canceled_call", "automation": "crm.callLists.remove.v1", "input": {} }]
  }
}
```

`onReady` means the call appears only when its work dependencies are satisfied. `crm.callLists.add.v1` ensures the list exists and then upserts one entry keyed by the work node, so event retries cannot duplicate it. A reopened node becomes ready again and reopens the same entry. Completing a call in the Calls dialer records the disposition on the project and completes the source work node; the terminal binding removes any still-pending entry.

List assignment is optional. With no `assigned_user_ids` or `assigned_role_ids`, every Calls user in the organization can see the list. When either is populated, a user sees the list when their user id or any role id matches. Assignment belongs to the list, not individual entries, so office and production call workflows remain separate.

The Roof Replacement and service presets use this contract for `welcome_call`. They publish to the `new_customers` list with `kind: "signature"`. See [`../internal/crm/CALL_LISTS.md`](../internal/crm/CALL_LISTS.md) for the direct CRM API.

The Customer Portal view combines customer checklist access, referenced documents,
appointment policies, visit handoffs, and inbound portal-page audience references.
Page targeting is read from customer portal sites and includes disabled and
unpublished matches. Shared pages without an explicit reference to this scope
are not included. Entries link to their canonical artifact, Customer Scheduling defaults,
or Web Editor page; they do not store separate portal configuration.

The scope editor keeps name, description, notes, color, and selectable icons in
Details. Customer Scheduling owns rescheduling defaults; Developer owns the raw
definition, stable IDs, custom calculations, metadata, and structural counts.
Boards previews the configured stage columns for the single board keyed by this
scope template, with links to work items and event-driven milestones inside each
stage. Project cards and
legacy columns from existing project instances belong to the live board.
Commissions presents configured rules first, named workflow-step selectors,
payout schedules, and collapsible optional settings and recipient assignments.
