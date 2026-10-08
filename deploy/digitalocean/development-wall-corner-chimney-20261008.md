# Wall corner and exposed chimney sides - development, October 8, 2026

Lower-roof contact adjustments now translate a whole wall plane and rejoin
connected returns at their intersection. Previously, independently classifying
endpoints at a lower-roof boundary could bevel an otherwise square corner.

Generated chimney exposure uses the house footprint to reject exterior points
before ray classification. Chimney cleanup removes covered siding before this
query; the resulting open seam previously hid two exposed lower chimney faces.
Edited wall/base geometry retains the existing visibility classification.

Validation: 259 focused geometry tests passed, including regressions against the
captured three-layer roof for the square corner, its connected return, all three
exposed lower chimney sides and the hidden rear face. Coverage also includes
layered roofs, chimney heights and cleanup, foundations, Resoffit, zero soffits
and parapets. Two rendered views confirm the corner and exposed chimney shaft.
Evidence: `output/wall-corner-chimney-20261008/`.

Deployment is a two-script immutable delta from each verified development role.
The audited baseline on all four roles is
`313db654c7ab8f246826cc5a67701514e3fc0749`; rollback uses each manifest role's
previous_path. No project data, production, configuration or topology changes.

Activation and verification receipt pending.
