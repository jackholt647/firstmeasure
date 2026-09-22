# CRM Call Lists API

Call lists are durable, organization-scoped CRM objects. A list owns presentation and assignment attributes; entries point at callable subjects such as projects and may also point at the work node that created them. The implementation is idempotent at two levels:

- list keys are unique within an organization and create the list on first use;
- entry `source_key` values are unique within a list (scope automations use the work-node id).

## List shape

```json
{
  "key": "new_customers",
  "title": "New Customers",
  "description": "Signed customers whose welcome call is ready.",
  "kind": "signature",
  "icon": "fa-handshake",
  "tone": "customer",
  "sort_order": 30,
  "status": "active",
  "assigned_user_ids": [],
  "assigned_role_ids": ["office"],
  "metadata": { "purpose": "welcome_call" }
}
```

An empty assignment means organization-wide visibility. If users or roles are present, the queue endpoint returns the list only to matching callers. Managers and administrative tools can pass `include_all: true` when an unfiltered view is authorized by the caller.

For backward compatibility, the queue read ensures the `new_leads`, `follow_ups`, and `new_customers` list objects exist. `new_leads` is synchronized from current project stage, while `new_customers` is populated by scope automation rather than stage inference. The `follow_ups` list is a read projection of open, due Work nodes tagged `follow_up`; it does not own separate follow-up state. Legacy project follow-up date fields are migrated into tagged Work nodes and cleared when the queue synchronizes.

## Follow-ups

A follow-up is a normal dated Work to-do with `metadata.kind: "follow_up"` and `metadata.type_tags` containing `follow_up`. It is checked off through the configured follow-up outcome API rather than through an independent Calls-only record. Rescheduling completes the current node and creates an assigned successor node, booking a sales appointment completes it through the project event trigger, and the lost outcome updates the project stage before completion.

Company Settings stores the shared label, default title/time, quick reschedule intervals, automatic retry cadence, outcome terminology, and scheduled/lost stage mappings in the Work configuration. The retry cadence is an ordered set of waits used after voicemail, no-answer, and optionally a manual follow-up outcome. Calls and the Today to-do list consume the same configuration and the same node state.

## Company settings

Managers can see and edit these objects in **Company Settings → CRM → Call workflows**. That workspace shows pending counts, active status, presentation, display order, and caller routing by access role or individual user. List keys become read-only after creation because scopes and automations use them as stable references. Deactivating a list keeps its definition and entries but removes it from the Calls tab until it is reactivated.

When designing a scope, reuse the key shown in Company Settings or provide the complete `list` definition to `crm.callLists.add.v1`. The automation creates a missing list automatically, so project-specific call types such as a mid-project production check-in do not require a separate setup step.

## Endpoints

All routes are under `/v1/internal/crm`.

- `GET /organizations/:orgId/call-lists` lists definitions and pending counts.
- `POST /organizations/:orgId/call-lists` creates or updates a list by `key`.
- `POST /organizations/:orgId/call-lists/queue` returns visible lists and their pending, project-enriched tasks. Body fields are `user_id`, `role_ids`, and optionally `include_all`.
- `POST /organizations/:orgId/call-lists/:listKey/entries` ensures the list and upserts an entry. Use a stable `source_key`; accepted associations include `project_id`, `work_plan_id`, and `work_node_id`.
- `DELETE /organizations/:orgId/call-lists/:listKey/entries/:entryId` removes a pending entry.
- `POST /organizations/:orgId/call-list-entries/:entryId/disposition` records `answered`, `voicemail`, `no_answer`, or `skipped`, plus optional `outcome`, `note_text`, and `followup.due_at`. A non-empty `note_text` becomes one message in the project's channel (the internal messaging backend at `/v1/channels`) tagged `call_note` with structured call metadata, idempotent via `client_msg_id = call_disposition:<note_id>`. The disposition result stores only the resulting `note_id`, so note text has a single source of truth. For a tagged follow-up entry, the configured outcome resolver completes or replaces the associated Work node.

Message classifications use the shared `tags` string array on channel messages. These tags are separate from `mention_users`, which controls person mentions. The channels UI library (`window.FirstMateChannels`) renders known tags such as `call_note` while safely rendering unknown future tag keys.

Server-side scope code should use the registered `crm.callLists.add.v1` and `crm.callLists.remove.v1` automations documented in [`../../scopes/README.md`](../../scopes/README.md), rather than calling HTTP endpoints from the work engine.
