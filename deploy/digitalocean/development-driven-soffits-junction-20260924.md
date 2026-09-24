# Driven soffit junction correction — September 24, 2026

Release `9098b7dbfcdf1d599c98e44ee8042c5dd85ce6d8` corrects the first
implementation's classification of finite junction limits as measured anchors.
Those limits stopped the actual measured depth from propagating through the
tower sides. Roof-support clipping then produced sloping side fragments even
though the front was flat.

Finite junctions now participate in driven-depth selection, with their maximum
depth retained as a clamp. Actual measured contacts remain anchors. In the
captured house fixture the entire tower run is level within 0.1 mm, each side
is one source segment, and the foundation has no open junctions. The regression
checks both sides, measured contacts and final wall tops, replacing the earlier
incorrect expectation that the junction-limited side depths should stay fixed.

All 233 focused geometry and wall-mode tests pass. The advanced setting remains
default-on and applies on the next From Roof rebuild. Disabled-mode tests still
verify the previous behavior.

The development delta contains only `wall_geometry.js`, staged against exact
baseline `2acb42780eee33487a08fc1a7e2b17553beeb7b2`. Existing runtime files,
node-specific feature settings and the mobile-download repair are preserved.
Production and autoscale provisioning are outside this change.

All four roles activated and passed local exact-release readiness with
protected development data/outbound isolation. Staging verified 24,510
unchanged public files per web/compatibility node and 24,524 on the worker.
The public geometry script matches the committed checksum. All 24 public
readiness samples returned the new release from `do-598520065`; the second
web node passed local checks but was not covered by these public samples.
The public editor required login; the captured-fixture tests provide geometry
validation rather than an interactive test of the user's current project.
