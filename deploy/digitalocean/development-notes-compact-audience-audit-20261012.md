# Compact Notes and Crew audience audit — October 12, 2026

Feature commit `53b470c98b25f142dd58c1988b5f1307777de249`.

Reply on a note with zero active replies opens the composer directly, including
when the thread contains only archived replies. Threads with active replies keep
the existing Add Reply flow. A repeated Reply click in an open empty thread
focuses the composer. The main note composer removes its Add Note heading and
places visibility inside the box at its upper right beside the formatting bar.
The placeholder is Add an internal note. Photo and author-name hover/focus share
the organization-scoped summary.user target on both notes and replies.

The visibility menu begins with Just Everybody, followed by the department
heading and department choices. The department heading uses the catalog's
configured plural. The field-user choice and footer use workforce.worker_plural;
the explanatory app name uses workforce.field_application. They update through
the existing fm:terminology:updated event. IDs and membership never depend on
those display labels.

## Crew audit and correction

The earlier note_audience_crew flag used Channels' legacy viewerAudienceGroups
resolver. That resolver matches role tokens such as crew, installer, production
and repair, or enabled field-app access; owners/admins receive all legacy audience
groups. It does not look up a workforce resource group's members, a project's
assigned crews or scope/work-plan assignments. Calling it field users was
therefore imprecise, and renaming terms or creating arbitrary role IDs cannot
make that heuristic a reliable group-membership model.

For the typed Notes crew flag, the field-user branch now checks actual
ctx.applicationAccess.field.enabled. Role-name matches alone cannot satisfy it.
Existing organization/project/channel authorization, administrative department
access and active department membership still apply. Department selections and
field-app membership remain a union. Older audience arrays keep their historical
role semantics; this change does not rewrite stored notes or broaden grants.

The built-in option now means field-app users who already have access to the
project. It is not a reference to a particular assigned resource group. A fully
general audience model should use stable typed references to departments,
resource groups, application-user audiences and explicit project/scope assignment
contexts, resolved centrally and reused for history, threads, archives, realtime
and notification delivery. Workforce organization-structure already resolves
active resource-group membership and department associations by IDs. Scope sets
are workflow definitions/context, not implicit membership grants. Terminology
customizes presentation. None should turn a renamed label into authorization.
The legacy boolean remains a compatible built-in audience, not a substitute for
that future shared model.

## Checks and rollout

The browser regression passes compact composer placement and placeholder,
empty-thread direct compose, nonempty Add Reply behavior, real shared summary
rendering on both names and photos, menu sections, terminology overrides/live
updates and previous composer/archive/count workflows at narrow widths.
Seven isolated API tests pass, including a management-only production_manager
role rejected from the typed field-user audience. TypeScript checks pass.
Fixture APIs do not post customer notes.

The rollout owns the Notes library and its bundle version, Channels API/service
sources and their two compiled modules. The bundle version is
20261012-notes-compact-hover-v5. Audited Feed moderation changes and per-role
application manifest differences are preserved. Immutable stages verify source
hashes, compile TypeScript and run the isolated seven-test suite. Activation
guards current paths/runtime, switches releases atomically, restarts only the
development web/legacy service and reloads PHP-FPM. Development isolation remains
mandatory. There is no migration or worker change; production is outside scope.

Payloads, audited baselines, hashes, scripts and receipts are retained under
ignored output/notes-compact-deploy/ and in the immutable releases. Rollback
must preserve subsequent changes and reverse only this owned patch.

## Verified result

All three roles activated successfully and passed final source/compiled hashes,
exact runtime identity, readiness and enforced development isolation. The public
Notes and manifest hashes matched reviewed payloads after the rolling restarts.
The browser regression passed again with dev-hosted libraries after all roles
were active. A transient public asset 503 during the pool restart cleared before
final verification.

| Role | Current release | Previous release |
| --- | --- | --- |
| Web | `/opt/firstmeasure/releases-phone-second-pass/53b470c98b25f142dd58c1988b5f1307777de249-notes-compact` | `/opt/firstmeasure/releases-phone-second-pass/6cd8f83dbf3865fe82e4ed1f49786846a9291e17-notes-counts` |
| Pool | `/opt/firstmeasure/releases-phone-second-pass/53b470c98b25f142dd58c1988b5f1307777de249-notes-compact` | `/opt/firstmeasure/releases-phone-second-pass/6cd8f83dbf3865fe82e4ed1f49786846a9291e17-notes-counts` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/53b470c98b25f142dd58c1988b5f1307777de249-notes-compact` | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/6cd8f83dbf3865fe82e4ed1f49786846a9291e17-notes-counts` |

Runtime identity is `53b470c98b25f142dd58c1988b5f1307777de249` on every role.
The Notes normalized SHA-256 is
`1accf09b39d8345eced15429d0faea959cf36ad6fe3817d29dcddf391e3bcbb3`.
