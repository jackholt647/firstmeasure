# Equipment icon grid spacing — September 28, 2026

The equipment type icon picker uses the full available section width with no
inset padding, gray panel background or panel rounding. Icons sit directly on
the white form surface. Icon hit areas, selection indication, keyboard focus and
hover feedback are retained.

JavaScript syntax and the three existing Equipment browser/contract checks pass.
Deploy the single Equipment frontend asset over verified live development web
baselines. Verify per-node readiness, development isolation, asset hashes and
public health/hash, plus the existing served-script browser flow.
Evidence: output/equipment-icon-grid-20260928/ (ignored). No backend, database,
topology or production changes. Roll back using the receipt's prior releases
through the existing symlink/service workflow after checking for intervening
work, then reverify readiness/isolation.
