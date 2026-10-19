# Project Photos and measurement presentation — October 10, 2026

Project Photos replaces Aerial View. The authorized completed-report aerial is selected by default, followed by report reference and project Media images. The full-height image viewer centers the largest contained image. A draggable and keyboard-accessible divider expands the horizontal thumbnail row into a grid. Zoom and selection survive local tab switches; source reads never import or mutate media.

Measurements use value-sized decimal inputs and place oversized labels in full-width rows at the end of otherwise adaptive sections. Pitch is a Pitch/Squares table with calculation tooltips. Zero and unavailable fields are hidden by default with a heading toggle. Decimal input validation rejects exponent text, including e-3.

The 3D roof tray has Line types, Pitches and Summary tabs with animated collapse. Summary includes predominant pitch, squares, penetration counts and grouped horizontal opening footprint dimensions. Pitch and Area face labels can be shown independently. The 3D roof has a Pitch labels toggle, with anchors chosen in the largest clear interior region of each face, excluding holes. The key uses compact names with full-name tooltips, rounded editable linear feet, and selectable line types that highlight all matching edges. Editing either view uses the same project-local override path. Published source values remain intact.

Validation: Focused browser/contract tests cover actual image/runtime sizing, cached aspect definitions, photo selection and zoom retention, drag-to-grid, narrow measurement columns and full-width outliers, decimal validation and zero toggle, pitch table markup, WebGL highlight behavior, and label anchors outside saved penetration holes. Development activation only, using immutable owned-file overlays over current audited web, pool, legacy and worker baselines.

Resource columns read an organization resource-type catalog, with roofing defaults supplied without mutating reads. New categories and lists use inline empty Untitled placeholders; category icon and color are edited together through the shared icon picker. Lists inherit category appearance. Catalog writes enforce organization membership, project management permission, registration and revision conflicts. Typed publication adapters delegate to the domain writer.

Columns retain equal relative widths regardless of item content. Compact item cards replace wide table layouts, redundant section headers and the separate labor estimate panel. Each column has a compact total footer; labor totals retain the existing expense projection.

## Completed development rollout

Main source: `121e046e6bf8c4de5d0d3a5bbe1a786726bf54a8` (feature commit `5c49e988b33dfaac35ce16a2b038af55b44d8612` plus imported-row total fallback). Shared picker follow-up: `08027737edaeed696a79b714911fb6580bc5dd2b`. The web, pool and legacy development services activated verified picker overlays containing the main changes. Worker catalog alignment activated `d9c782333468487fb60b363e25ceff41cbcf0773`. Source was pushed through merge `8567108e87bf094210f25e0943d2dc3414954c65`, preserving concurrent development work.

The shared icon picker lazily loads its color control when requested inside an app iframe. Imported rows without an explicit projected total use quantity times unit price; explicit totals remain authoritative.

Validation completed: 19 focused browser tests, six materials backend tests, the isolated lazy-color-picker test, imported-total fallback checks and TypeScript checking passed. Hosted desktop and mobile checks reported no page errors. Hosted inline creation verified empty name placeholders, category icon and color, list and item persistence after reload, a $150 footer for two $75 items, and removal of the test list. Accepted-document preview and dense measurement rendering were also exercised in the hosted app. The broader publication suite had 85 passing tests, one skipped test and two existing fixture failures: duplicate `org_custom_fields_test` and `platform_phone_not_issued`; both reproduce in isolation.

Owned-file manifests and exact prior release paths for rollback are recorded under `output/project-measurement-fit-20261010`, `output/project-resource-picker-20261010` and `output/project-resource-worker-catalog-20261010`. Each activation checked service health, release identity, owned source hashes and development isolation. Concurrent release changes were re-audited before staging; stale-baseline guards prevented replacement of newer work.
