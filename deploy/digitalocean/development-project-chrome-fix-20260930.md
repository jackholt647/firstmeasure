# Project tray mounting and chrome fixes — development

Source release: `4f146f203360f038ab27eecfd5430ff764c5abaa`.
Target: `https://dev.1m8.ai`; development roles only.

## Fixes

The portal statically loads project apps and did not include the tray library. The tray mount also searched for the header within the content rail, but the real split layout moves the header to the window shell. The static loader now includes the library before the project app, and mounting resolves the retained shell header. Icon tabs occupy the header's second row at the right, below window controls; app actions keep their own grid column. Content-only docked app panes do not create another set of project trays.

The shared window placement picker shows six SVG icons (left/right and four corners), with a thin separator between halves and corners. Both docking-button and header menus use the picker. Header context menus use cursor coordinates in the menu document, including parent/child iframe offsets, and clamp to the viewport. Menu hints and accessible names retain readable placement labels.

Project iframe identity uses `aria-label`, preventing the tooltip library from adopting its title as a hover target spanning the entire modal. The Notes tray and Overview composer display a literal `+ Note`. The Overview send/pin controls are one joined group, with a white internal divider, square inner edges, matching color and no gap; edit mode shows a single Save control.

## Validation

Six browser tests passed from isolated source: real project split-layout tray mounting and tray workflows; header/docking SVG menus and cursor placement in same/cross-document cases; iframe tooltip behavior; joined note/pin geometry; existing docking, previews, swaps and float detachment. Animation geometry checks wait for completed animations instead of fixed delays. Four checks also passed using actual JavaScript fetched from development: real split-layout tray mounting/workflows, menu icons and cross-document cursor placement, iframe tooltip suppression, and joined Overview send/pin controls. These browser fixtures use existing components with mocked application APIs. JavaScript syntax and portal PHP lint passed during staging.

## Deployment safeguards

Immutable source commit; role-specific existing code preserved. The compatibility host's old window-manager library lacked the placement APIs required by the new menu, so that owned shared library uses the verified canonical implementation. No backend contracts, database migration, capability defaults, production environment or topology change is included.

Concurrent rollouts triggered baseline guards before staging/activation. A compatibility staging attempt targeted the former root-disk path and failed to copy. Only this task's inactive partial artifact was removed, restoring approximately 14.9 GiB root headroom; prior releases were retained. Staging now uses the compatibility host's existing `/mnt/firstmeasure_dev_releases/releases` path. Its immutable clone retains unchanged files by hardlink, atomically replacing every overlaid file, release environment and receipt. A second baseline-hash check proves the live source remains unchanged.

Per-role previous release, file hashes and staging/activation receipts are retained in ignored `output/project-chrome-fix/` and the deployed `channels-release.json`. Rollback restores the recorded prior symlink and restarts only that development role after checking current state. No application data is changed by this frontend rollout.

All four development roles activated and independently verified at `4f146f203360f038ab27eecfd5430ff764c5abaa`. Public readiness passed with development outbound-safety enforcement. Reload the portal to load the corrected static script list and recreate retained project iframes.
