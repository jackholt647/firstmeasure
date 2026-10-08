# Automatic parapets and soffit defaults — development, October 8, 2026

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
`output/parapet-walls-20261008/`. Activation and hosted verification are pending.
