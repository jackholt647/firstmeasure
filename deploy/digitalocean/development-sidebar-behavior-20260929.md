# Personal sidebar behavior â€” development, September 29, 2026

Source feature commit: `8f54fe98a3c4d2b588fc5a9789fd41d8d853159a`. User-authorized target: `https://dev.1m8.ai`.

My Settings â†’ Left column offers Adaptive, Locked, Forced shrunk and Forced expanded. Adaptive keeps the existing per-tab collapse choices and hover resize/overlap preference. Clicking to collapse overrides the current hover until pointer re-entry. Locked ignores hover, remembers its open/closed position in personal identity preferences and toggles on click. Entering Locked retains the visible position. Forced modes hide the resize edge and toggle and reject module expansion requests. Advanced app menu styling cannot expand a manually closed sidebar.

The six-file runtime overlays contain portal PHP/CSS, core JavaScript, personal settings, its bundle token, platform API source and its matching compiled output. Each overlay is based on the audited active release for that role. Only six new preference declarations/read/write lines differ in compiled API output. Existing role-specific API, core, Brand Kit and Contacts behavior is preserved. No dependencies, schema migrations, runtime configuration, worker, topology or production changes.

Validation: three clean TypeScript builds; web and compatibility preference persistence, mode validation and independent-account defaults; rendered Chromium checks for collapse while hovered, renewed hover expansion, locked open/closed toggles, persisted click states and forced-mode width/control enforcement. The older full sidebar contract suite has an unrelated pre-existing Doc Studio release assertion failure; targeted sidebar checks pass.

Predecessors:
- web: `0d3f064715641f07131a4492336e6006712b6799`
- pool: `0d3f064715641f07131a4492336e6006712b6799`
- legacy: `0d3f064715641f07131a4492336e6006712b6799`

Rollback restores the relevant predecessor current pointer and restarts its development service plus PHP-FPM, then verifies release identity, readiness, development environment and outbound isolation. Check for intervening deployments first. Preference fields are additive and remain safe after code rollback. The existing development autoscale image limitation remains; no image/template provisioning is included.

Preparation, payload hashes, role variants and verification evidence: ignored `output/sidebar-behavior-dev-20260929/`.

Staging initially stopped before activation because the concurrent Contacts search rollout changed a predecessor. All three roles subsequently completed that rollout on `0d3f064`; their source/runtime baselines were re-audited and the task overlays rebuilt without changing their validated API output. Activation and public verification pending.
