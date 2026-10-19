# Perpendicular directional extrusion caps — October 12, 2026

Source `60ab248273c012aebd6add39ef7389bd76ffe8f2`, integrated through `2b19d662`.

Planar faces extruded along an alternate direction now end on a plane perpendicular
to that direction. World Z gives a level cap above sloped ground. Distance is
measured beyond the source extreme in the signed direction, avoiding caps that
cross the original face at short distances. Zero offset keeps the source unchanged.
Face-normal extrusion is unchanged. This does not flatten intrinsically curved
logical surfaces.

Outer boundaries, holes and retained anchors share the projection. Analytic curved
boundaries use ruled returns between their original and projected curves. Directional
snapping uses the projected reference plane and refreshes candidates when direction
sign changes. M movement is unchanged.

Validation: 672 geometry/editor tests passed, plus an additional analytic curved
boundary regression. Tests cover positive/negative offsets, vertical/horizontal/
oblique axes, short distances, holes, unchanged sources, E cycling, cancel and
exact placement. Browser replay placed a one-foot vertical extrusion above sloped
ground with four side walls and zero height spread across the cap.

## Verified development deployment

Only wall_solid_geometry.js and wall_face_draft.js were overlaid from the immutable
commit onto audited development baselines. Concurrent uncommitted plane-stepping
work was excluded from the source commit and deployment. Baseline, runtime path,
PID, isolation and file-hash guards passed. PHP was reloaded; backends were retained.
All three serving nodes passed source hashes, readiness and enforced outbound
safety. Both public HTTPS assets at dev.1m8.ai matched the reviewed source hashes.
Worker and production were unchanged; no customer geometry was edited to verify it.

Retained backend runtime: `b178dae7c2e35fda5e3c5942828df0eff680fbfe`.

| Role | New frontend | Previous frontend |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/60ab248273c012aebd6add39ef7389bd76ffe8f2` | `/opt/firstmeasure/releases/96eea8f00c6fc528b97286a54d7f9fc5409e42cb-notes-reply-labels-r2` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/60ab248273c012aebd6add39ef7389bd76ffe8f2` | `/mnt/firstmeasure_dev_releases/releases/96eea8f00c6fc528b97286a54d7f9fc5409e42cb-notes-reply-labels` |
| pool | `/opt/firstmeasure/releases/60ab248273c012aebd6add39ef7389bd76ffe8f2` | `/opt/firstmeasure/releases/b178dae7c2e35fda5e3c5942828df0eff680fbfe` |

Evidence and manifests are retained in `output/flat-extrusion-20261012`. Rollback must preserve subsequent work and reverse only these owned patches; if no later frontend changes exist, restore the recorded previous symlink and reload PHP while retaining the backend.
