# Agent chat panels — October 5, 2026

The user authorized the terminology change and deployment to `dev.1m8.ai`.
Chat presentation containers are panels; widgets are their UI children and
published artifacts remain domain objects. Production activation is outside scope.

Source commits: `08c6dfc8f7787a94545b28ae4dbbd99a8aa58bc7` and
`d5990751e31cf70eddb0c387c5e82692fc222b64`.

## Behavior

- `present_panel` replaces `create_artifact`. A panel has a title, identity,
  optional stable replacement key and one to six visualization or registered
  platform widgets. A turn can present at most four panels.
- `platform_show_widget` creates a one-widget panel. Registered children retain
  current user, tenant, project, app and agent restriction checks. A denied child
  does not publish a partial panel. Display does not mutate business records.
- Dashboard responses use `panel`; scheduled agents pin and replace panels.
  Saved `artifact` and `platform_widget` presentations remain readable. The
  historical `artifact_json` storage column remains without a database rewrite.
- The assistant renders grouped panels beside chat or inline. Chart resizing
  preserves mounted widgets. Shared app chat presentation and Stats recognize
  registered-widget panels. Artifact names for documents, datasets, files and
  executable versions are preserved.

## Verification

Local TypeScript checking passed. Publication suite: 50 passed, one optional
PostgreSQL test skipped. Seven focused panel/API/agent tests passed; 97 frontend
client checks passed. Grouped panels passed desktop/mobile switching, natural
height, expansion, overflow and disposal checks. The shared widget browser check
passed panel rendering and escaped titles alongside existing isolation checks.

The broader assistant run also exposed two notification expectations outside
this change. Existing project/voice browser fixtures fail at initialization on
`about:blank` because the assistant's existing booking asset URL needs an HTTP
origin. Those fixtures do not establish voice regression coverage for this release.

## Delivery

Role-specific immutable overlays preserve each verified development baseline.
Baseline guards stopped staging when concurrent releases moved. Linux checks
include the renamed test imports because the deployment TypeScript configuration
also checks tests. Staging uses immutable hardlink clones with detached writes
and a storage reserve; no release history is deleted. Compatibility widget
presentation retains its earlier layout while adding panel-container support.

Web, worker, compatibility and pool roles activated
`d5990751e31cf70eddb0c387c5e82692fc222b64`. Their deployed tools expose
`present_panel`, omit `create_artifact` and produce the verified two-widget
panel contract. Public readiness returned this release with development data
isolation and enforced outbound safety. Public assistant/widget asset hashes
matched the payload manifests. The grouped-panel desktop/mobile browser check
also passed using the actual deployed assets.

The ignored
`output/chat-panels-20261005/manifest.json` records source hashes, previous paths,
payload checksums and rollback targets.

## Rollback

Restore each role's manifest `previous_path`, restart its development service,
reload PHP-FPM on serving roles and verify readiness and enforced outbound safety.
Do not replace a later release without reviewing its intervening changes.
