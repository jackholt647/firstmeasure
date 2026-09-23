# Development: multi-point nudging and Q ownership

Code release: `f0ec2e4ede04eb195c18c379d91ffde9a58a83b9`.
Baseline: `f9cc71f335a41cf9bbe4422009fe63e03f27578d`.

Two runtime files change: `wall_face_draft.js` and `wall_solid_geometry.js`.
The existing eight-view AI camera runtime and all other baseline files are preserved.
Production is unchanged.

## Behavior

Partial point selections follow each selected point's connected line in the
arrow's screen direction. Destinations are calculated before geometry changes,
then shared straight boundaries update together in one transaction and undo
record. Selection survives repeated nudges across draft owners. Curved controls
retain analytic curves. Complete faces/windows retain their existing translation.

Q resolves draft-local node IDs using the explicit draft selection rather than
the potentially different active wall. The resolved draft stays pinned throughout
the quadrilateral gesture. World-point collection follows the same ownership.

## Validation

The expanded editor/geometry suite ran 1,092 tests: 1,090 passed, with only the two
previously documented curved-eave failures from the arch release remaining:

- `real house fillet crosses its finite eave without upright curtains or restored height`
- `saved failing outward extrusion removes all three eave curtains`

New regressions cover a local point-ID collision between separate wall drafts,
Q placement on the correct owner, repeated multi-point nudges on a shared edge,
differently sloped faces, separate construction drafts, curve controls, and
single-operation undo snapshots. Existing complete-window movement tests pass.
Evidence: `output/selection-nudge-full-tests.log` and
`output/selection-nudge-20260923/`.

## Deployment

All three development roles activated with matching release IDs, readiness and
outbound isolation. Staging checked 24,499 unchanged public files on web and
compatibility and 24,513 on worker. Worker activation required no running jobs;
both PHP-serving roles refreshed PHP-FPM. Public asset checksums match both
committed scripts, and public readiness reports the exact release and isolated
development environment. The temporary load-balancer 503 during restart cleared
without configuration changes.

An authenticated separate browser tab loaded the full house after deployment.
The automation could not change the layer selector, so the live Q gesture was
not completed; Q and nudge behavior were verified by handler tests. The temporary
tab was closed without committing geometry, and the user's editor tab was untouched.

## Recovery

Use the existing guarded development rollback procedure to the complete baseline
above, with worker idle checks, readiness, outbound isolation and PHP-FPM refresh
on both PHP-serving roles. No persisted schema change is introduced.
