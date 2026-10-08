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

Verified application release: `72c0ee4e1bec4da865d6e306ee7111ea0d8b0700`.
All four roles passed runtime identity, content hashes, readiness and development
isolation checks. Public HTTPS returned the expected release and both script
checksums.

A concurrent deployment changed compatibility to
`0c01a90160780cdcef3131632d8be938245f2fe4` after staging. The baseline guard stopped
activation; its editor files still matched the audited source. Compatibility was
restaged from that newer release, preserving its unrelated changes. Its rollback
baseline is therefore `0c01a90160780cdcef3131632d8be938245f2fe4`; the other three
roles retain the baseline above. The manifest records those role-specific paths.
