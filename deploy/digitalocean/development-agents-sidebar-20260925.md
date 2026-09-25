# Agents left-column layout — development, September 25, 2026

Source commit `fc4e1632f613df5ec80359206db3746a8e6c4c21` is pushed to
`codex/consolidated-firstmeasure-20260923`. Both development web nodes
(`do-598520065`, `do-603124965`) run release
`692caff88c3d7785c6909d1bf0da8c9feacc2b8c`. Production is unchanged.

The default-off `assistant.sidebar_tab` capability adds an Agents mode to the
portal's left column. When enabled, the existing conversation list moves into
that column; selecting a conversation opens the full assistant on the right.
The assistant continues to use its existing docked and mobile layout. In both
full-screen modes, Dock, Float, and Minimize float in the upper right without a
full-width assistant header. The flag appears in assistant Capabilities and in
company settings. App rollout authorization is still required to save it.

The release was overlaid on the verified live development baseline
`21fe1b937eaab6aba91eec3108dd8673f5ebb29d`. Eight changed browser and
capability files were staged with SHA-256 verification on both nodes. The live
company settings Brand Kit edits and its portal script include were preserved
by a clean three-way merge against the source parent. No unrelated source or
service role was replaced. Each web node was activated separately, with an
automatic rollback path and local readiness checks.

Local TypeScript check, build, capability tests (12/12), assistant frontend
tests, JavaScript syntax checks, PHP lint, and deployment checksums passed.
Public readiness reported the new release, development data, and enforced
outbound safety. Public assistant, portal, and company-settings assets match the
staged hashes. Live Chrome inspection confirmed the default-off full-screen
layout and floating controls. The current test account could see the new layout
switch but could not save it: the server returned “Only an authorized operator
can change app rollout flags.” The switch was returned to off. The enabled
layout is covered by source and capability tests, but was not visually verified
under an authorized operator account in this rollout.

The development autoscale image remains historical. Rollback on each web node:
restore `/opt/firstmeasure/current` to
`21fe1b937eaab6aba91eec3108dd8673f5ebb29d`, restart
`firstmeasure-development-web.service` and `php8.3-fpm.service`, then verify
local readiness. Reconcile any later concurrent release before rollback.
