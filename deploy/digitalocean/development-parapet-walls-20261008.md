# Automatic parapets and soffit defaults — development, October 8, 2026

Verified application release: `32468b06758541ffce9b39f3f31133b75ea26b55`.

From Roof generates zero-soffit perimeter walls for parapet edges, roof planes
below 1/12 pitch, and exposed skylight edges. Inset skylights and shared skylight
seams do not create exterior walls. Other edges retain the selected soffit.
Foundation fallback honors these offsets and manual Resoffit remains available.

Automatic parapet inside walls defaults on in Advanced settings. On the next
From Roof rebuild it creates ordinary editable cap and inside-wall surfaces:
6 inches inward and 2 feet down from the measured parapet top. Adjoining caps
and inner walls share mitered corners. The setting is saved per project and
does not discard edited faces when toggled. Existing line tools can change
the inside height; Resoffit preserves the cap width. Rebuild replaces generated
geometry through the existing undoable From Roof workflow.

Final focused validation: 122 tests pass, covering generation, corners, reversed
connections, concave footprints, surviving wall intervals, editable inside
heights, serialization, setting persistence, rebuilds, Resoffit, foundations,
and reports. Earlier broad wall/base verification found a chimney draft-selection
failure that also reproduces with the unchanged engine.

The user authorized deployment to dev.1m8.ai only. The six-file release preserves
the active runtime and all unrelated files on each of the four development roles.
Evidence, manifests, test output and rollback baselines are retained under
`output/parapet-walls-20261008/`. All four roles activated successfully; all six
files match their role manifests, and readiness, runtime identity, development
data isolation and outbound restrictions passed on each role. Public HTTPS
verification matched all five JavaScript asset checksums and the release ID.
PHP syntax checks passed during staging. The worker's older unrelated editor
markup was preserved through a reviewed three-way merge.

Rollback baseline for every role is `09bcf8335108ed8baa9ab62b85ba23cdbdc227fc`.
Use the manifest's `previous_path` on the applicable host, atomically restore
`/opt/firstmeasure/current`, restart that development service, reload PHP-FPM on
web/compatibility roles, and verify release identity and readiness. No database,
configuration, production, or topology changes were part of this rollout.
