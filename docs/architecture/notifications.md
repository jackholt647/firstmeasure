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
The UI renders this catalog with Apps and Workflows & scopes views, cross-view
search, collapsible groups, 1–3 responsive columns, tooltips and accessible switches.
Saves are serialized; failures retain pending changes and expose a Retry control.

Messaging has a separate settings section. In-app delivery offers Off, Silent and
Alerting while push remains independent. The existing `in_app` boolean remains
compatible with producers and assistant tools; `in_app_sound` distinguishes Silent
from Alerting. Optional `in_app_bell` and `in_app_badge` booleans control placement
and unread counts through each row's initially collapsed Advanced tray. All maps
use the same catalog keys and validated partial-update behavior. Existing enabled
preferences allow sound unless explicitly disabled. Direct Messages default to
the messaging inbox; users can additionally enable notification-bell placement.

The list API returns recipient-specific `presentation` metadata. Deliveries outside
the bell use `in_app_alerts`, allowing an alert without adding a bell entry. Both
lists share recipient, branch, expiry and in-app preference filtering. Off does not
remove the underlying conversations or disable push. Silent celebrations remain
ordinary entries without playing their animation or sound. The bell badge counts
unread entries whose badge preference is enabled; total entries remain in its menu.


Native OS channels remain the existing broad categories. The larger catalog lives
inside FirstMate; push still requires a configured provider and device permission.

## Verification

Focused tests cover event subscription without scopes, duplicate event replay,
unknown keys, scope declarations, undeclared custom-code notifications, empty scope
categories, branch isolation and preservation through renaming. Browser checks cover
1/2/3 columns, search across views, collapse, keyboard operation, rapid toggle saves
and retry. Run `npm run check`, `npm run test:publication`, and the notification,
automation-engine and scope-artifact tests after changing these contracts.

## Programmable delivery (September 29, 2026)

The implementation lives in `public/v1/platform/notifications`. A durable occurrence
captures the parent notification, safe event envelope and resolved user audience
before creating recipient children. Explicit user/role targets or `broadcast: true`
are required for new producers. The existing `notification.create.v1` adapter keeps
its historical empty-audience broadcast behavior for compatibility. Recipient and
method identities are stable across replay. A worker recovers partially materialized
occurrences without expanding their saved audience.

Each recipient has independent `in_app`, `push`, `email`, `sms`, `celebration`,
`toast`, `audio` and `customer_portal` delivery records. Email/SMS use the existing
communications service (including sender configuration, consent and idempotency).
Push uses the existing FCM/APNs configuration. Provider acceptance is not proof of
receipt. Interrupted external sends become `uncertain`, rather than being blindly
repeated. Missing devices/providers are `unavailable`; failures are recorded.
Client audio/toast/celebration claims are atomic across tabs. The ordinary bell entry
is not completed merely because an animation played.

Customer delivery requires explicit `target_portal_ids` plus separate
`customer_copy: {title, body}`. The owner portal receives this copy only; internal
text and event data are not projected, and guest/preview portals receive no inbox.
Personal employee rules cannot target customer recipients.

### Event selection and document labels

`document.signed` is the canonical completed-signature event. Legacy incoming
`proposal.signed` events normalize to it, and retained old subscriptions match only
the legacy proposal source. The retired proposal signing entry point remains
blocked; consolidation does not restore it. Event copy/schema is catalogued once.

Document instances copy normalized, multiple template tags on creation, retaining
their own labels when a template changes later. Tags are included in new accepted
signing content and emitted signature metadata. Existing signed hashes are not
recomputed to add tags. Old untagged instances are not automatically classified.

A rule selects one base event with bounded structured filters (`eq`, `in`,
`contains`, numeric comparisons); all filters must pass. A proposal selector uses
`payload.document_tags contains proposal`. Free regex is not needed for exact tags.
Optional `scope_template_id` and `notification_key` narrow the rule. `subscribe`
creates a personal notification; otherwise the rule treats matching existing
notifications. A failed selector does not invoke an agent. Future templates inherit
behavior by carrying the selected tags. Tag quality/registration guidance is a
separate product layer.

### Delivery programs and precedence

Rules retain natural-language `intent`, versioned source, typed publication
bindings, permitted methods, and explicit permission to bypass quiet hours. Run
rules by ascending priority then stable ID; later matching decisions replace the
same method. Producer-disabled methods and explicit user opt-outs cannot be enabled
by code. Quiet hours apply last unless the applicable method has an authorized
`bypass_quiet`; timezone-aware quiet hours are independent per method. Defaults on
failure mean ordinary preferences **including quiet hours**, not unconditional send.

Programs execute in the existing bounded QuickJS document-module runtime, with no
Node/network/action capabilities, 1.5 seconds and sixteen publication reads. They
receive `inputs.event`, `inputs.baseline`, `api.now`, and
`await data.require(bindingName)`. Bindings use authorized published source references;
`$organization`, `$project`, `$document`, `$snapshot` resolve from the event.
Missing, denied, wrong-type and missing nested fields fail the host evaluation even
if guest code catches the exception. Authors must not substitute zero or silent
false conditions for missing inputs. `documents.signed` reads explicitly published
parameters from the exact completed signing package, never current recalculated
pricing. Live operational conditions may use other authorized registry providers.

Code returns `{outputs:{push:{decision:'send',bypass_quiet:true}}}` (or `suppress`
or `defer` with a future `until`). Explicit typed `exports` allow
`outputs.variables`; other programs read these through `notification-rules.value`.
Outputs are owner scoped, recheck source permissions, reject dependency cycles,
and become unavailable when the declaration is revoked. Only a winning delivery
evaluation publishes outputs or successful regression samples.

### Bounded repair and default delivery

On execution failure, a recipient gets at most one backend repair attempt using
the shared notification assistant's model/settings/credentials. The agent receives
intent, code, failure and safe event context, with read-only publication tools. It
cannot ask a user, send a notification, broaden filters/audience/methods, or grant
itself a quiet-hours exception. It can propose source/binding changes or return
`use_default`. The host evaluates the candidate, replays up to twenty captured
successful samples, and accepts it using revision compare-and-swap. Revisions,
reasons, task IDs and recipient decisions are retained for inspection.

A repair task has a nine-second budget; a claimed recipient has a twelve-second
evaluation budget. Missing credentials, uncertainty, invalid repair, concurrency,
timeout or crash release normal delivery instead of leaving it waiting on an agent.
Equivalent repairs share a durable key (rule/revision/template/type/failure); failed
keys use defaults on later occurrences until the rule or failure context changes.
Successful repairs become the next rule revision. Late evaluation results cannot
replace an already planned default. See [background agents](background-agents.md).

### Grouping, settings and execution

A group uses owner, rule, a selected event resource ID and a bounded time window.
Rendering collapses matching bell records, with group actions applied to members.
Dispatch independently chooses `every`, `first` or `digest`; digest defers external
alerts until the window ends. Quiet hours can defer that further. Groups never cross
recipient boundaries.

The settings panel exposes quiet hours visually and custom intentions as text with
enable switches and change history. The existing notification assistant inspects
actual template tags/publications before `save_delivery_rule`. API endpoints are
`GET/PUT /v1/platform/organizations/:orgId/notification-rules`,
`PATCH .../notification-quiet-hours`, and `POST .../notification-deliveries/:id/ack`.
They use the existing member authentication, capability checks and CSRF handling.

The API and platform worker drain the durable lane every two seconds using claims;
`NOTIFICATION_LANE_DISABLED=1` disables the API timer for a dedicated worker setup.
No new provider credentials or separate AI service are introduced. SQLite is used
locally through SqlStore; PostgreSQL uses the existing shared store abstraction.
No production rollout was performed as part of this implementation.
