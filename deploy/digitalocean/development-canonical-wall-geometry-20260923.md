# Canonical wall geometry — September 23, 2026

Development runtime: `974f20e6639bbe4a4a1011bd69d67cd20edf0ef6`.
Previous runtime: `ccc45af009b25a99af8ce46315f624dc42442c1b`.

The previous straight-boundary cleanup retained ragged source triangles. Generated
coordinates, planar union, filled triangulation and editable boundary now agree.
Overlapping strips are unioned instead of counted as shared edges. Holes and
disconnected regions retain valid loops, and unused source stations are removed
from derived geometry. Generated extrusion cutters respect the canonical contact;
horizontal divider movement follows roof and floor profiles across corners.

See [the geometry audit](../../docs/editor-planar-editing-audit-20260923.md) for
scope, measurement tolerance, ownership and legacy-edit limitations.

## Verification

- 1,038 distinct wall/roof/base/exterior checks passed: 1,037 in the full run plus
  the additional overlap/hole regression in the 28-test wall geometry run.
- Captured 18- and 24-inch front wall outward extrusions tested at three depths;
  exact authored nonuniform extrusion and movement across a roof peak/sloping
  floor are covered. Source canonicalization is idempotent in both captured cases.
- Five runtime files only: `wall_geometry.js`, `wall_mode.js`,
  `wall_face_draft.js`, `wall_solid_geometry.js`, and `exterior_model.js`.
  Architecture `4a3c46c` and concurrent document/platform work remain undeployed.
- Web, worker and compatibility roles staged, activated and verified successfully.
  Staging checked 23,475 unchanged public files on web/compatibility and 23,486 on
  worker against the previous runtime.
- A separate authenticated editor tab loaded and rendered the saved house with
  95 sources, 57 valid face regions and three chimneys. No rebuild or save was
  performed; the original user tab remained untouched.
- Public readiness reports the exact release and development environment with
  outbound isolation enforced. All five served JavaScript checksums match the
  immutable source commit. The unauthenticated editor route returns its login page.

Evidence: `output/canonical-wall-geometry-20260923/`.
Test logs: `output/canonical-full3.log`, `output/canonical-geometry-final.log`.

Production, runtime configuration and saved project geometry were not changed.
Previously committed malformed custom extrusions remain saved edits; retest from
pre-edit geometry or fresh From Roof output after reloading the editor.

Rollback: activate previous runtime `ccc45af009b25a99af8ce46315f624dc42442c1b`
on the three development roles, using existing role-specific activation/readiness
checks and refreshing PHP-FPM on web and compatibility. No database migration.
