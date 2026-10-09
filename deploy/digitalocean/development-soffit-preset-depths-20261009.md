# Development explicit soffit depths — October 9, 2026

Source: `abe9017333edf16c216a1f0a226bb2beb5ececc4`.

Numeric soffit presets and custom lengths were being overwritten by automatic driven-soffit propagation. In the captured Lake Washington Boulevard project, a 16.7-inch measured roof contact spread around most main-roof eaves even when 2, 3 or 4 feet was selected. Another group inherited an 11-inch contact.

Driven-soffit propagation now runs only in Auto. Numeric choices retain their requested depth on ordinary eaves; measured roof contacts and overlap-clearance constraints stay local. Advanced-setting help describes this distinction.

## Verification

- Replayed the actual preset and custom-length handlers against the captured project at 2, 3 and 4 feet. Verified ordinary source depths, generated wall positions, and save/reload preservation.
- 301 distinct relevant tests passed: 295 in the initial full suite, then four new depth/UI regressions and two additional overlap-depth cases alongside their existing suites. No runtime code changed between those runs.
- The three new numeric-depth regressions fail with the previously deployed geometry module.
- Existing Auto driven-soffit behavior remains covered. Roof-overlap non-penetration checks pass at 24, 36 and 48 inches.
- Inspected matching top-down renders of old 4-foot generation and corrected 2-, 3- and 4-foot generation.
- Downloaded and SHA-256 verified both editor JavaScript files served by dev.1m8.ai. Replayed the actual custom-length handler with the downloaded geometry module at 4 feet: 62 sources, 52 rendered faces, zero open perimeter edges. Inspected the resulting render again.

Evidence is in the ignored `output/soffit-preset-depths-20261009/` directory, including test logs, source snapshots, generated topology, and before/after screenshots. The preview renders actual generated topology in an isolated harness; it does not overwrite the user's saved project.

## Rollout

Only `wall_geometry.js` and the advanced-setting explanatory text in `wall_mode.js` are included in the development overlay. No database, configuration, backend or production changes. Existing saved walls require refresh followed by an explicit From Roof generation to apply the correction. Per-role rollback paths are retained in the deployment manifest.

All four development roles verified on the source release above. Per-host file hashes, runtime identities, readiness and isolation passed. Public readiness and served asset hashes also passed.
