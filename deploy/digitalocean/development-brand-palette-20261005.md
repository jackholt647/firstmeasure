# Brand Kit regeneration and color dragging — October 5, 2026

Source: `6f179e94405dadc4bd351adb60b3919733ded225`, pushed on
`codex/consolidated-firstmeasure-20260923`. Development activation is authorized
in the originating chat.

Both simple and advanced Brand Kits expose Regenerate palette from logo. It
updates the visible Primary and Secondary colors and the available supporting
colors. Company Settings refreshes the theme and autosaves the generated palette.

The shared picker dismisses on an outside pointer press rather than a retargeted
click at the end of a drag. Focusing the color plane avoids scrolling. Backing
controls are rebound after both input and change handlers, preserving continuous
updates when Company Settings replaces its palette controls. Done and Escape
retain their existing behavior.

Validation: 13 focused browser and CSRF tests pass, including both Brand Kit
layouts, continuous pointer movement, rerendered backing fields, Done and outside
presses. `npm run check` passes. The original immediate dismissal was reproduced
in the hosted Company Settings UI; its original test-company primary color was
restored after the check.

Deployment overlays only five frontend assets on audited live baselines on the
two development web nodes and compatibility. Existing source, runtime settings,
worker and production remain unchanged. The baseline was
`27926ec287e1331e6cfa981766ae3ec6a4e9a5ba`; an intervening rollout advanced it to
`57b7a4aa0919622907f2dea2ed0d3d498997b901`. Baseline and process guards stopped
activation during that rollout; fresh snapshots preserved its changes. Per-role manifests, source hashes,
previous paths and staging receipts are in ignored `output/brand-palette-20261005`.
Space-saving hardlink staging detaches all changed files and release metadata;
no previous release is deleted. The existing development autoscale-image
limitation remains.

Rollback: first inspect intervening releases. Restore each role's `previous_path`
from the deployment manifest, restart its development service and reload PHP-FPM.
Verify readiness, development isolation, outbound safety and return to public
traffic. No migration or data rollback is required.


## Activation verified

All three serving roles run `6f179e94405dadc4bd351adb60b3919733ded225` and passed
source-hash, release identity, readiness, development isolation and enforced
outbound-safety checks. Both web nodes returned to public traffic. All five
public asset hashes match the staged payloads.

Live Company Settings verification confirmed that selecting a point and dragging
across the color plane keep the picker open and update the color. Done and an
outside press close it. Reset restored the original test-company primary color,
and autosave reported success. Screenshot evidence is
`output/brand-palette-20261005/hosted-picker-proof.png`.
