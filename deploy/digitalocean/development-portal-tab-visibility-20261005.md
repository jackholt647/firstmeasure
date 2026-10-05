# Portal tab visibility — October 5, 2026

Selecting Invoices or Financials after opening standalone Channels left the
Channels workspace visible. Its inline `display:flex` overrode the portal's
ordinary `.fm-tabpanel { display:none }` rule. Channels continued occupying a
full panel height, pushing apps later in document order below the viewport.

Commit `8967d9848d199160a847e13af2538b84d07dd152` makes the shell's inactive
panel selector authoritative with `display:none!important`. Active apps retain
their own layout. This also hides inactive apps whose asynchronous mount finishes
after navigation and reapplies inline display styles. The integrated Channels
conversation window has a separate root and is unaffected by this panel rule.

The browser regression runs the actual portal activation function and standalone
Channels mount. It failed against the preceding CSS at Channels → Invoices and
passes with the fix for Invoices, Financials, and Projects at 1280 and 600 pixels,
including pointer hit testing and a delayed inline layout write. The broader
Channels source-contract suite has six unrelated assertion failures in its
existing localization, huddle, attention, DM, realtime, and project-note checks;
those implementations were not changed in this release.

## Development rollout

Only `public/portal/scripts/core.js` is overlaid onto the audited live baselines
for both serving web nodes and compatibility. Their baseline was
`15dc6d879aa839703658fcaf8acf30e7355a23a2`; the older compatibility source was
merged to retain its existing differences. Worker has no changed runtime files
and is excluded from activation. Unrelated working-tree changes are excluded
from the scoped commit. Staged source hashes and JavaScript syntax checks pass.

Evidence and prior release paths are in `output/portal-tab-visibility-20261005/`.
Rollback uses those retained paths with sequential development activation and
readiness verification. No production activation is part of this rollout.

Both serving nodes and compatibility activated and verified release
`8967d9848d199160a847e13af2538b84d07dd152`. Public readiness and the public
core script hash match the staged release, with development outbound isolation
enforced. A fresh hosted sandbox passed eight navigation sequences at 1440 and
600 pixels: Channels → Invoices, Financials, My Projects, and Invoices again.
Every destination received pointer input and all inactive panels stayed hidden;
there were no browser page errors. The Financials screenshot was inspected and
the temporary sandbox organization and identity were removed.
