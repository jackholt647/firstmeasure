# Development: saved wall-contact repair — October 9, 2026

Source/runtime release: `80e8a9771c7c8bf59c36d3e86f7ad7d3ef568c35`.

The prior generation correction did not update persisted editable drafts, which masked the generator output. Project restore now repairs qualifying generated upper-contact planes in both existing wall caches and their draft coordinate systems. The repair uses source/roof ancestry and a maximum 10 mm correction to the measured back edge. It does not rebuild walls or alter the foundation. Moved drafts, nonfixed sketches, deleted faces, replacement surfaces, holes, and curved geometry are excluded. Subsequent refreshes are idempotent; repaired data is persisted to the local project backup and available to normal project Save.

Captured saved geometry from the affected project verifies that visible draft faces move to the measured contact line, preserve face IDs and unrelated geometry, and survive serialization. Five repair regressions pass; base/generation/repair suites total 26 passes; the full wall-mode suite has 77 passes, including the restore integration test (103 total). Syntax and scoped diff checks pass. This migration corrects the proven narrow seam; it does not collapse every larger generated footprint return.

Only base_geometry.js and wall_mode.js were deployed from the commit above with fresh baseline audits. All four development roles report matching hashes, readiness, release identity and isolation. Public assets and readiness were verified. No direct metadata write or production change was performed. Evidence: `output/stored-wall-contact-20261009/`.
