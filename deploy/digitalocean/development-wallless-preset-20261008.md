# Development: Wallless resoffit preset — October 8, 2026

Source/runtime release: `553d46a915e9b5e18273a0d1bd31c164db7af41e`.

Wallless is a preset alongside 0, ½ ft, 1 ft, 1½ ft and 2 ft in Resoffit. Removed the checkbox. Preset selection is exclusive and highlighted; Wallless disables numeric depth, and selecting a depth restores it. Custom numeric input clears unmatched preset selection. Geometry behavior is unchanged.

Validation: JavaScript syntax and diff checks passed. The focused wall-mode UI regression passed, covering default selection, Wallless Apply, switching back to zero/half-foot depths, custom depth and invalid input.

Deployed only `public/measure/internal/editor_scripts/wall_mode.js` using fresh per-role baseline audits and immutable releases. Compatibility, web, pool and worker all report the release above, matching asset hashes, readiness and development isolation. Public editor asset was SHA-256 verified with its content-hash cache key; public readiness passed. Production was not changed. Evidence is under `output/wallless-preset-20261008/`. No live project geometry was edited for verification.
