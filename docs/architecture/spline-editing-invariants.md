# Analytic spline editing invariants

September 23, 2026.

Spline definitions and their original controls are authoritative. Sampled polygon boundaries are evaluation data for face filling, intersection, rendering and extrusion, not newly authored points or straight edges. Deliberately added points and real junctions remain editable.

## Shared protection

`exterior_geometry.js` owns `curveEdgeRange` and `annotateCurveGraph`. Recognition uses absolute geometry contact tolerance, including endpoints rounded to the polygon grid; a fixed parameter tolerance is not valid for short sample segments. Recognition also verifies the intervening curve samples, so an endpoint chord is not mistaken for an arc. Graph incidence distinguishes samples from controls, authored points and junctions.

Sketch creation and reload restore analytic ownership from retained face definitions. Rebind uses the same classifier and compacts sample fragments into analytic intervals while preserving fixed/editable ownership. Analytic edges whose definitions are missing raise an error rather than silently becoming straight edges. Repeated reads do not reimport stale face definitions over intentional edits.

Draft imports carry curve definitions, compact evaluated samples, avoid rematerializing sample vertices and exclude analytic intervals from straight-edge subdivision. Paste, contained-face merges, divided-sticker imports and contained draft merges preserve mapped analytic definitions and interval edges.

## Audit coverage

All editor `curveSamples` consumers were reviewed in exterior geometry, base sketch geometry/editor, wall solid geometry and wall face drafting. Preview sampling is temporary; arch creation persists the analytic definition. Copy/flip/resize transform definitions. Extrusion retains curved-surface metadata. The top-down roof interaction graph is separate and does not use this spline representation.

Regression coverage includes the reported sticker-chord deletion, rounded face boundaries, creation/reload, import, metadata loss rejection, three coordinate scales, original controls, explicit authored points and real branch junctions. All 467 focused sketch/drafting/solid/invariant tests pass. The separate curved-surface suite has 13 passing tests and two previously documented eave-extrusion failures (finite-eave fillet curtains and saved outward-extrusion curtains).

This protects the audited conversion boundaries and supplies regression invariants for future changes. It cannot recover the original spline from old data that has already lost its analytic definition and contains only untagged polylines. Face tessellation remains necessary; its vertices must never become editable controls merely because a face is rebuilt.
