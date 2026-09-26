# Notification declarations and subscriptions

Notification delivery is shared by platform apps, Work events, and scope automation.
The catalog in `public/v1/platform/notification_catalog.ts` is the settings contract.

## Built-in events

Register events through the existing `work/events.ts` catalog and emit them through
`emitWorkEvent`. Each registered event has an `event.<event-name>` preference for
in-app and push delivery. No scope or organization automation rule is needed.
Add new domain ownership to `eventGroups` with its real app flag and permission.
New event subscriptions are off by default; existing direct-app and Measurements
preferences retain their prior defaults. Subscribe explicitly in Notifications.

The Work worker checks active membership, branch, app enablement and the domain's
permission before selecting subscribers. Event notifications contain catalog copy
and a project link; raw event payloads (which may contain private data) are never
copied into notifications. The event ID is the deduplication identity.
This subscribes to eligible events in the branch, not only events assigned to the
subscriber. Explicit workflow recipients continue to be controlled by the workflow.

## Scope declarations

Existing `notification.create.v1` bindings are automatically inventoried. Their
preference identity uses branch, scope template ID, node, hook and binding ID.
Keep binding IDs stable. Legacy bindings lacking an ID use their index; authors
should give those bindings explicit IDs before reordering them.

For custom code, declare notifications at the scope definition's top level:

```json
{
  "notifications": [
    {
      "id": "shingles_done",
      "label": "Shingles completed",
      "description": "The crew has finished installing shingles.",
      "defaults": { "in_app": true, "push": false }
    }
  ]
}
```

Call the existing published `notification.create.v1` action in command mode with
`notification_id: "shingles_done"`, a title/body, and explicit recipients as usual.
The trusted Work host validates that ID against the executing scope's pinned
version and supplies the preference key and defaults. The notification action may
also use `notification_id` to share an explicitly declared notification type.
Unknown declarations fail; code is never scanned or executed to discover alerts.

Renaming a scope, changing message text, or publishing a new version keeps explicit
notification preferences. Current templates plus declarations from active pinned
versions are shown. Archived and empty installed scopes remain visible. Organization
notification rules appear under Company automations for administrators.

Preferences are per organization member, with branch-scoped workflow keys. Partial
updates preserve other keys, including temporarily hidden or retired definitions.
Legacy category opt-outs are inherited until a workflow-specific choice is made.
Turning off a notification never disables the underlying workflow or its effects.

## Settings and mobile

The preferences GET endpoint returns `catalog` and effective `preferences`; it is
read-only and does not install scope templates. Both GET/PATCH accept `branch_id`.
The UI renders the authorized catalog with General and Workflows & scopes views,
cross-view search, collapsible groups, tooltips and accessible switches. Presentation
grouping is independent of app ownership: related events share activity categories,
while broad direct-app controls appear under Miscellaneous. Cron and mock-payment
events are omitted from the end-user settings, without changing automation events.
Workflow categories and preference keys are preserved. All categories use the same
responsive column count (three at 840px, two at 560px, otherwise one), with vertical
dividers and balanced rows. Widths refer to the settings content area.
Saves are serialized; failures retain pending changes and expose a Retry control.

Native OS channels remain the existing broad categories. The larger catalog lives
inside FirstMate; push still requires a configured provider and device permission.

## Verification

Focused tests cover event subscription without scopes, duplicate event replay,
unknown keys, scope declarations, undeclared custom-code notifications, empty scope
categories, branch isolation and preservation through renaming. Browser checks cover
1/2/3 columns, search across views, collapse, keyboard operation, rapid toggle saves
and retry. Run `npm run check`, `npm run test:publication`, and the notification,
automation-engine and scope-artifact tests after changing these contracts.
