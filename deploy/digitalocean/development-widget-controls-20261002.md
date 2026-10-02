# Compact roof controls and Scope split — October 2, 2026

Development source release: `03dd687d1658f73444f59568709b844c5125e7a0`.

Roof texture, colored lines and reset use compact SVG icon buttons with accessible names and native tooltips. Key remains visible by default and its labeled dropdown toggles a wrapping legend row below the controls. Scope's desktop widget column changes from 44% to 50%; the existing small-screen stack is retained. Shared and lazy-loaded asset versions are refreshed.

Five focused browser tests passed, including dropdown placement, icon accessibility, the exact desktop 50% width, responsive widgets and roof geometry/holes. The shared roof widget was also visually inspected. Release overlays preserve unrelated live changes; no backend or worker update is required.

## Deployment and rollback

The first web node received the source release, then concurrent release `14954ceac292ba89e9d29189aa958841e6d92c0a` retained these changes. Its inspected assets contain the icons, 50% split and new lazy-loader version. Compatibility and pool were re-audited against that newer release, then received the four-file overlay under `03dd687d1658f73444f59568709b844c5125e7a0`. The superseded readiness poll was stopped; no concurrent code was reverted.

All four changed public assets matched an inspected or staged role hash. Compatibility and pool activation verified readiness and enforced development isolation. Their rollback baseline is `14954ceac292ba89e9d29189aa958841e6d92c0a`; use each role's recorded previous symlink, its development service restart and PHP reload, then verify readiness. Reverting the first web node requires a scoped code revert over its newer release rather than undoing unrelated work. Production was not changed.

The final pool activation was confirmed through public readiness after load-balancer reentry.
