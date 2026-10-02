# Roof key, Scope width and measurement precision — October 2, 2026

Development source release: `1078ee5aad5a815a2fdd13955555fe4a52a8b06f`.

The Key dropdown opens below the icon toolbar and lists its entries vertically down the left. Scope overrides the shared project layout's `flex:0 0 30%!important` sidebar rule with its own more-specific 50% rule. Border-box sizing keeps the actual outer width at half the tab, with inherited width constraints removed. Other app rails are unchanged.

Both Scope and the shared measurement widget display numeric values to one decimal place, including numeric strings. For example, `212.01027519664146 lf` displays as `212.0 lf`. Formatting does not alter source values or calculation precision. Non-numeric values remain readable. Shared and lazy-loaded cache versions were advanced.

The previous Scope fixture lacked the shared layout stylesheet and therefore missed the 30% override. It now loads the real project-layout CSS and uses the actual tab-content/sidebar classes, asserting a 650px Scope rail in a 1300px tab. Browser tests also check the long-decimal example in both render paths. Twelve focused roof, widget and Scope checks passed; the vertical key was visually inspected.

## Rollback baselines

- web: `d74705e12169c186d733bab5e1528becb14b3a21`
- legacy: `03dd687d1658f73444f59568709b844c5125e7a0`
- pool: `03dd687d1658f73444f59568709b844c5125e7a0`

Deployment uses a reviewed four-file overlay over each inspected live baseline. Rollback restores that role's previous symlink, restarts its development service and reloads PHP, then checks readiness and development isolation. No backend/worker or production changes.

All three roles activated successfully. Public readiness confirmed the release with development isolation enforced, and all four changed public assets matched staged role hashes.
