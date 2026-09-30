# Event notification groups

Every `registerWorkEvents` declaration must include `notification: { group,
source, tab }`. TypeScript requires it and registration validates it at runtime.
The stable identifiers and display labels are declared in
`public/v1/work/events.ts` as `notificationEventGroups` and
`notificationEventSources`.

- `source` identifies the app or feature in the notification creation picker.
- `group` identifies the semantic section in Custom. For example, document
  signatures and project completion signatures share `signatures`; document,
  proposal and project payments share `payments`.
- `tab` places ordinary declared notifications under General, Messaging, Flows,
  Scopes or Documents. Custom rules remain in Custom, grouped by `group`.

These fields are presentation metadata. They do not authorize access, select
recipients, change event identity, or control delivery aggregation. Existing
app and resource authorization remains required. The delivery rule's grouping
key and alert behavior remain independent.

For a new event, choose an existing group or add a deliberate group and label
to the shared catalog. Use `miscellaneous` explicitly when no semantic group
fits. Unregistered events continue to flow through the work engine and receive
the miscellaneous presentation fallback from `workEventNotification`; their
existence does not make them customer-visible or register them in the picker.

The initial classification updates declarations only. It does not rewrite
organization records, existing rules or recipient preferences.

## Guided registrations

`GET /organizations/:orgId/notification-rules` returns authorized event choices,
their notification metadata, safe grouping paths, supported tag path, document
tag catalog and branch scope choices. `POST /notification-registrations` accepts
`event`, optional `title`, `tags`, `methods`, optional `group` and optional
`scope_template_id`. Selected tags require all matches. The guided path creates
a subscription with a no-op delivery program; advanced agent-authored code stays
available through the existing versioned rule API. An optional UUID `request_id`
makes identical creation retries idempotent; changed requests using that ID
return a conflict. Team channel and live-chat events retain membership-aware app
producers and cannot become broad personal event subscriptions.

Document events offer `document_workflow_id` instead of a scope selector. The
authorized `document_workflows` discovery list supplies choices; the resulting
filter compares the retained `payload.workflow_id`. This ID is also an available
delivery grouping field. A guided document registration rejects
`scope_template_id`, since document signing does not publish that relationship.
Scope selectors apply only to `work.*` events. The subscription host resolves the
event's plan ID within its organization and branch before publishing the actual
scope template and work-plan IDs into the safe envelope. Missing or mismatched
plans cannot satisfy a scope selector. Grouping choices are restricted to the
fields actually supported by the event family.

Personal rules may declare `quiet_exempt_methods`. These explicitly bypass quiet
hours for eligible methods, including methods enabled through preferences; hard
opt-outs still win. The runtime's separate `bypass_quiet` permission is unchanged.
Stored exemptions are checked again at delivery.

`DELETE /notification-rules/:id` requires the current `revision`. It retains
history and a tombstone, cancels available or pending deliveries, hides withdrawn
subscriptions, and prevents a concurrent repair from recreating the rule. Already
submitted provider effects cannot be recalled. The legacy
`POST /notification-registrations/remove` accepts a preference `key`; it removes
the personal custom marker and disables delivery. For an older custom automation
it removes only the caller's recipient assignment, retaining other recipients.
