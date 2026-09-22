# Work API

The Work API is the canonical runtime for project phases, stages, to-dos, and sub-items. Those labels are presentation terminology over one recursively nested work-node model.

## Ownership

- `schemas.ts` defines plans, nodes, transitions, hooks, automation bindings, and branch terminology.
- `storage.ts` owns durable plans, nodes, events, automation executions, and idempotency records.
- `service.ts` creates plans, mutates nodes, returns to-do and board projections, and rolls status up the tree.
- `engine.ts` emits events, matches external triggers, runs hooks, unlocks dependencies, and deduplicates work.
- `registry.ts` is the only bridge from stored automation ids to trusted server TypeScript.
- `automations/builtins.ts` contains the built-in project, notification, and scheduling handlers.
- `scheduler.ts` emits due and scheduled-event lifecycle hooks.

## Model

A work plan contains one or more root nodes. Every node can contain child nodes, depend on sibling nodes, be actionable, appear in a user's to-do list, and bind automations to lifecycle hooks. The same tree can therefore render as boards, phases, stages, tasks, or nested sub-items without copying state between subsystems.

To-do assignment is additive: `assigned_user_ids` targets specific organization
users, `assigned_role_ids` targets workforce access roles, and
`assigned_resource_group_ids` targets typed resource groups dynamically. A
node may also store the shared workforce `assignment_policy`; when present,
creation and reassignment are validated against its allowed person roles,
group kinds, exact subjects, tags, and unassigned setting. A field user sees a
task when any concrete assignment matches. Project tasks additionally require
the user or their group to have access through a scheduled project-work event;
unassigned tasks remain management-only.

Node statuses are `pending`, `blocked`, `ready`, `active`, `completed`, `skipped`, and `canceled`. Parent status is derived from its configured completion mode and children. Completing a dependency unlocks eligible downstream nodes.

Branch configuration controls the displayed words for `phase`, `stage`, `task`, and `board`; those labels do not alter the stored shape.

## Follow-ups

Follow-ups are not a parallel task model. They are dated actionable Work nodes with `metadata.kind: "follow_up"` and the `follow_up` value in `metadata.type_tags`. Any feature can recognize the tag while completion, assignment, postponement, and list visibility continue to use the normal Work runtime.

The branch Work configuration defines follow-up terminology, default title/time, quick reschedule intervals, an ordered automatic contact cadence, and the `reschedule`, `scheduled`, and `lost` outcomes. The cadence can apply independently to voicemail, no-answer, and the manual follow-up outcome; its final interval can repeat or stop. Tagged nodes must be completed through an outcome. Rescheduling creates a successor tagged node that records its cadence step, a sales appointment event can complete the node automatically, and a lost outcome can move its project to the configured stage. The CRM Follow-up Calls list is a projection of due tagged nodes.

## Automations

Templates store automation ids and JSON input, never executable source. `registry.ts` resolves an id to a handler compiled into the server. Handlers receive a constrained context with the event, plan, node, project, scope, proposal, idempotency key, and service methods for project updates, scheduling, notifications, node transitions, and nested events.

Bindings may be attached to lifecycle hooks such as `onReady`, `onStarted`, `onCompleted`, `onDue`, and `onCanceled`. External event triggers can transition nodes when their conditions match. Event and execution keys make retries idempotent.

## HTTP Surface

The API is mounted at `/v1/work` and includes plan creation/read, node patch/transition, current to-do projection, tagged follow-up outcomes, project board/projection views, branch terminology, event emission, execution history, and the registered automation catalog.

The older `/v1/platform/organizations/:orgId/action-items` routes are compatibility adapters over work nodes. The generic `action_items` document collection is not a live write path.
