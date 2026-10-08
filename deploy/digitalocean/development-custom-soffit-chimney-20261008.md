# Custom soffits and multi-level chimneys — development, October 8, 2026

From Roof retains Auto and No soffit, replaces 0.2 ft with 0.5 ft, and adds
Custom (ft) with Go and Enter. Blank, negative and nonfinite lengths do not
regenerate the building. Custom lengths use the same generation defaults,
including the flat-roof, skylight and parapet zero-soffit exceptions.

Chimney detection splits overlapping projected contacts before deduplication,
retains all original connection identities, and completes a rectangular corner
when portions of all four sides have been measured. True branches and ambiguous
outlines are still rejected. Duplicate roof contacts can span several chimney
segments; uncovered portions retain their soffits and different elevations
remain independent.

The captured regression contains overlapping chimney contacts on separate roof
levels and an unfinished fourth side. Generation now recognizes both chimneys,
creates the missing shaft and cap, and preserves the source roof.

Validation and role-specific immutable delta manifests are retained in
`output/custom-soffit-20261008/`. Deployment changes only three editor scripts.
Rollback baseline: `5dc08befcab29d6ceec95078589d9f62a60c4d04` on all four roles.
Production, project records, runtime configuration and topology are unchanged.

Validation: all 178 focused tests passed, including the captured outline,
ambiguous-branch rejection, split-contact setbacks, multi-level geometry,
chimney heights, cleanup and the custom-foot input. A headless Chrome check
confirmed the updated presets and custom input fit within the menu.

Verified application release: `b89f6d445d348e8a0ca6b3d68e134dd4e60bc9b1`.
All four development roles passed file hashes, runtime identity, readiness and
development isolation checks. Public HTTPS matched all three script hashes
and the expected release ID. Rollback uses each manifest role's previous_path.
