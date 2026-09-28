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

Completed rollout: `60a8d3eddd0cfe0e7cbc44310e8138d96dad00a7` is active on
both development web nodes (`do-598520065`, `do-603124965`). Local readiness,
development isolation and asset hashes passed on both. Public health/hash checks
and the existing browser flow against the served script passed with synthetic
API fixtures. Both previous releases were
`09ccc4c33fedf8cf18842c1add405e96b6152f3b`. Production is unchanged.
