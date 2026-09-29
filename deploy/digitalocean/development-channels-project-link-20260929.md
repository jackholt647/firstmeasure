# Open projects from Channels — development, September 29, 2026

Source/runtime release: `499a0ce1903f41cc1e32925b28406b91902abbb4`.

Project channel titles open their associated project through the existing
portal navigation. This applies to the full Channels view and the conversation
window. The title is a keyboard-accessible button with an Open project tooltip;
ordinary channel and DM titles remain plain text. Navigation clears the
conversation overlay and stale project subview parameters so the project is
visible through the normal project window flow.

Open project is also available in the sidebar channel More menu, the desktop
conversation More menu, and mobile conversation actions. Only channels with
type `project` and an associated project ID expose it. Existing project access
checks remain owned by the project app.

The three frontend files are the shared Channels UI, Channels app shell and
bundle manifest. Only task-owned changes were committed; concurrent project
notes/content rendering work in the shared files remains separate. The
immutable per-role overlay preserves existing live files and manifest settings.
There are no backend, schema, dependency, configuration or topology changes.
Worker and production are unchanged.

JavaScript syntax checks and Chromium smoke checks passed against both the
working UI and exact release payload. Coverage includes full-view title click,
header and sidebar menus, overlay title click, keyboard activation and resetting
to a non-project channel. Isolated channel/API fixtures exercise the actual UI
with navigation captured rather than modifying customer projects.

Evidence and per-role manifests are in ignored
`output/channels-project-link-20260929/`. Rollback predecessors are
`068eafd9f4055a4acb9f04d8c95d88e94e5aa769` for web/pool and
`4733be6b2b99fc7ae303b96bc72b6210c7910375` for compatibility. Check for intervening
releases before atomic symlink/service rollback, one role at a time, followed
by readiness, development isolation and public asset verification. The existing
autoscale replacement image limitation remains.

Final verification: web, pool and compatibility passed deployed asset hashes,
readiness and development isolation on `499a0ce`. All three public JavaScript
assets matched the release payload and returned the correct MIME type. Six
public readiness responses passed. The Chromium interaction checks also passed
using the scripts served by dev.1m8.ai.
