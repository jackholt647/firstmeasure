# Project Activity and reusable tray widgets — October 3, 2026

Source release: `f4102a7a867947b6b3d9b28f8f0cec0f9e4e702f`.
Target: `https://dev.1m8.ai`, development web, pool and compatibility roles.

## Changes

Notes, To Do, Activity and Agent are versioned `FirstMateWidgets` definitions;
the optional Messages tray uses the same contract. They support project and
dashboard hosts and fill the supplied height, with scrolling inside the content.
Existing domain controllers retain API authorization, notes/task behavior,
drafts, Agent pinning and voice-session transfer. These interactive client
widgets are not added to the assistant tool catalog or document registry.

Activity uses the To Do typography scale (11px), sticky date groups, event icons,
actor/type/time metadata, search and category filtering. Refresh retains loaded
pages and scroll position; errors are shown once with a retry action. Polling
pauses while hidden and is disposed with the instance. Work/audit event IDs are
namespaced to avoid dropping distinct events with matching IDs.

## Verification

- TypeScript check passed.
- Seven focused browser tests passed: shared widget lifecycle, late responses,
  Scope integration, independent Activity hosts, filtering/pagination/retry,
  real To Do behavior, Notes drafts, and Agent pin/voice/minimize/transfer.
- Inspected the Activity screenshot at tray and independent dashboard heights.
- Browser fixtures now use an HTTP origin, allowing the shared assistant's
  lazy booking URL to initialize. The real tray and voice tests load the widget
  runtime to cover the new nesting and Agent movement behavior.
- Both web and compatibility assembled packages passed the Activity browser test.

## Rollout

The first staging attempt stopped before mutation because another development
release changed the active baseline. Inventory was repeated after that release
completed. Prior release on all changed roles: `96267164e4b7479808082365fdc5f2b420109562`.

Only project-trays.js, platform-widgets/runtime.js and the app manifest are
included in each role's immutable overlay. Compatibility retains its older
Agent shell and widget presentation behavior; the shared widget adapter and
Activity are applied without bringing in unrelated Agent changes. Backend,
worker, configuration, database and production are unchanged.

Evidence, inventory, merged overlays, hashes and deployment scripts are under
ignored `output/activity-widgets-20261003/`. Each release carries its previous
path and file hashes in `channels-release.json`. Roll back by restoring that
role's recorded prior symlink, restarting its development service and reloading
PHP, then verifying readiness, release identity and outbound isolation. A code
rollback does not undo user edits.

All three development frontend roles activated successfully. Per-role release
identity, source hashes, readiness and enforced outbound isolation passed.
Public readiness reports the source release above, and all three public asset
hashes match their inspected packages. The Activity browser test also passed
using JavaScript fetched from development with mocked domain APIs.
