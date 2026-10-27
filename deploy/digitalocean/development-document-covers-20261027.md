> Superseded by the [permanent visual recovery rollout](development-visual-recovery-20261027.md): release `c9d694e1` is activated on development legacy and web, including subsequent mobile, icon and pill changes. The live-only state below is historical.

# Document covers — October 27, 2026

Latest committed source: `00a237f4`. Verified served through the development live layer for `libraries/apps/docs/project.js` and `libraries/apps/materials/project.js`. All task deltas are pushed and reconciled into canonical without replacing unrelated edits.

Tiles have first-page previews fitted to width, a fixed 54px footer, single-line ellipsized titles, vertically centered type icons and standardized subtitles. Measurement values and document-specific details are pills. The type pill is solid organization-primary with white text; secondary pills are solid gray with white text. User/code badges sit in the ruler's upper-right space. Page-less modules retain a large fallback icon as well as the small title icon.

Verification: actual PDF page-one rendering, module first-page selection, page-less fallback, measurement pills, primary/gray colors, desktop/phone footer geometry and width-fit covers pass. Both report-source tests and all 24 Operations tests also passed.

During rapid user iteration, only intermediate `d57e9a75` was activated on legacy. Web remains `82fa4dc6`. Staged `8433910a` and `aa62dce8` are superseded; do not activate them. The current live overlays contain later requested pill styling. Finish the immutable rollout from `00a237f4` or a successor after the design settles, preserving those overlays. Do not clear them before release reconciliation. Production and worker were untouched.
