# Line double-click point placement — September 24, 2026

Release `4d9aa8674197b36be18b4b186c3861d38199506b` lets a double-click
place a point on a visible line without requiring a face hit. The same line
picker and occlusion rules used for selection identify the target. Projected
segment solving handles perspective depth, while endpoints and enabled line
centers remain snapping targets. Draft-owned lines use their original sketch;
standalone and surface-edge points use the existing loose-point representation.
Existing face placement retains its inference and analytic curve behavior.
The editor wrapper no longer substitutes an old selected wall for a missed
face hit. Placement is undoable and repeated clicks deduplicate points.

Five regressions cover standalone line selection followed by double-click,
perspective projection, hidden lines, clicks just outside a surface edge, and
line-center toggling. The combined draft/mode/editor run passed 493 of 494
checks. The remaining generated chimney-support face-selection failure also
fails with the unchanged HEAD versions of both edited editor scripts, verified
through a read-only test loader. It is recorded as an existing failure, not a
passing check or a fix in this release.

The two-script development delta preserves the per-role runtime baselines:
web nodes `4c42747e06326d54d9d80c95c19be15b72cd0cc2`; worker and
compatibility `9098b7dbfcdf1d599c98e44ee8042c5dd85ce6d8`. Unrelated
mobile fixes and node configuration remain intact. Production is unchanged.

All four roles activated and passed local exact-release readiness with
development data and enforced outbound isolation. Staging verified 24,509
unchanged public files per web/compatibility node and 24,523 on the worker.
Both public script checksums match the commit. All 24 public readiness samples
reached `do-598520065` at this release; the second web node is locally verified
but not covered by these public samples. The public editor required login, so
verification of placement behavior used the automated editor fixtures.
