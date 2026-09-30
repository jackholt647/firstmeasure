# Personal sidebar behavior — development, September 29, 2026

Source/runtime release: `5ad416c0685ec088fc5efc874eb2d574471d25b4`. User-authorized target: `https://dev.1m8.ai`.

My Settings → Left column offers Adaptive, Locked, Forced shrunk and Forced expanded. Adaptive retains the existing per-tab collapse choices and hover resize/overlap preference. Clicking to collapse overrides the current hover until pointer re-entry. Locked ignores hover, remembers its open/closed position in personal identity preferences and toggles on click. Entering Locked retains the visible position. Forced modes hide the resize edge and toggle and reject module expansion requests. Advanced app menu styling cannot expand a manually closed sidebar. The closed rail retains app icons without changing the selected tab. A late width-save response merges only the width and preserves newer sidebar choices, including keyboard collapse while a resize request is pending.

Six-file runtime overlays contain portal PHP/CSS, core JavaScript, personal settings, its bundle token, platform API source and matching compiled output. Each overlay is based on the audited active release for its role. Only six new preference declarations/read/write lines differ in compiled API output. Role-specific API/core behavior and the newer Contacts, Channels, Brand Kit and call-workspace releases are preserved. No dependencies, schema migrations, runtime configuration, worker, topology or production changes.

Validation: three clean TypeScript builds; web and compatibility preference persistence, mode validation and independent-account defaults; rendered Chromium checks for collapse while hovered, renewed hover expansion, locked open/closed toggles, persisted click states, late resize saves, compact navigation and forced-mode width/control enforcement. The earlier full sidebar contract suite has an unrelated pre-existing Doc Studio release assertion failure; targeted sidebar checks pass. Staging/activation guards stopped before changing current pointers when concurrent rollouts changed predecessors; final role baselines were refreshed and verified.

Activated successfully on web, pool and compatibility. All role payload hashes, runtime release identities, readiness, development environment and outbound isolation passed. Eight public readiness responses reached both serving web instances on the exact release. Three public frontend asset hashes matched their committed overlays. The sidebar browser fixture passed again using the JavaScript served by dev.1m8.ai and the source-verified portal CSS. API/browser fixtures used isolated test identities and synthetic responses; customer settings were not changed for verification.

Rollback predecessors:
- web: `225ed4f5f42bedec3ac21fdffd6d337af435c03a`
- pool: `225ed4f5f42bedec3ac21fdffd6d337af435c03a`
- legacy: `225ed4f5f42bedec3ac21fdffd6d337af435c03a`

Rollback restores the relevant predecessor current pointer and restarts its development service plus PHP-FPM, then verifies release identity, readiness, development environment and outbound isolation. Check for intervening deployments first. Preference fields are additive and remain safe after code rollback. Existing development autoscale image limitations remain; no image/template provisioning is included.

Preparation, payload hashes, role variants and verification evidence: ignored `output/sidebar-behavior-dev-20260929/`.
