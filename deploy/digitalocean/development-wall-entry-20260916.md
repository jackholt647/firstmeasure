# Wall-mode entry and persistence repair — development only

Activated release `0ea9e7a9cd6d034120e53b8fbe8aaf7ead210031` follows development release
`24cdfbafda2e7b9f0433ed4964476d36625136ec`. The user reported a blank 3D view
when entering wall mode and loss of the selected mode after refreshing.

## Cause and repair

The live browser stack identified `ExteriorModel.collect(null)` from the draft
renderer's new opening index. A completed roof can be displayed in wall mode
before any wall model has been generated. Opening collection incorrectly assumed
that the wall model already existed. The exception could also escape
`WallMode.syncVisibility()` before `_animate3D()` scheduled its next frame,
permanently stopping rendering for that page.

- Opening collection treats absent wall state as an empty set of edits.
- The animation loop schedules its next frame before running the transition hook.
  Exceptions remain visible rather than being silently swallowed.
- The project mode is stored independently as `exteriorsView` in editor metadata
  and a project-specific local backup. Newer local/server view preferences win;
  older projects fall back to `exteriorsWalls.enabled`. Saving mode no longer
  requires generating wall geometry.

## Validation and package

All 779 local editor tests passed. On Linux, 300 focused geometry, renderer,
and mode tests plus three full-house PHP/access tests passed. Regressions cover
empty-state drawing followed by wall creation, animation recovery after a thrown
transition, project isolation, mode restore without geometry, and older metadata.

Four JavaScript runtime files changed. Node source and dependency manifests are
unchanged; the previously verified Linux build and dependencies were reused.
Build checkout: `/home/dev/code/internal-exteriors-build-0ea9e7a` on the dev worker.
Artifact: `/home/dev/exteriors-0ea9e7a.tar.gz`, with companion `.tar.json`.
Size: 249,915,483 bytes. SHA256:
`4e4f6d5d341afb4440a9817a2f490838a01a98281dca09794f0a85276ea944e6`.

The guarded helper is `/home/dev/deploy-wall-entry.py` on the worker and
`/tmp/deploy-wall-entry.py` on web/compatibility. Its expected previous release
is `24cdfba`; development environment, exact allowlist, outbound safety, quiet
worker, readiness, and automatic rollback checks are retained.

## Live verification

All three development roles staged and activated this exact release (worker,
web, then compatibility/PHP). Each stage matched 1,332 unchanged public source
files against its baseline. The worker had no running jobs at activation.
PHP FPM restarted with the compatibility role. Fresh checks confirmed all three
service release IDs, development isolation, enforced outbound safety, and health.
Public readiness recovered after the restart/reentry interval; all four changed
assets served through `dev.1m8.ai` matched Git after line-ending normalization.

In a separate signed-in tab, the user's saved development house rendered in wall
mode. Returning to roof mode, entering wall mode again, swapping 2D/3D both ways,
and refreshing all retained visible 3D geometry. Refresh restored wall mode, and
no `wallEdits`/exterior render exception recurred. Existing malformed keydown
events still appeared in browser diagnostics during automation; they are outside
this render/persistence repair and did not stop rendering. No geometry edits or
server saves were performed during the live browser check. The original user
tab was not reloaded, and the original pane arrangement was restored.

The enable flag and exact `jack@1m8.ai` allowlist remain unchanged. Production,
provider/signing configuration, and project geometry were not modified. The
previous development release remains installed for rollback using the guarded
procedure in `development-exterior-editor-20260916.md`, substituting `24cdfba`
as the rollback target. No production activation is authorized.
