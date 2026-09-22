# Chimney selection and sequential extrusion fixes — September 22, 2026

Development runtime: `0a8957121da0933d2e98f552c67c62ac834763b2`.
Previous runtime: `a13f0d95c67f602682420bec95ba3fc38f530c2b`.
Branch: `codex/dev-chimney-edit-20260922`.

## Changes

- Keep roof-plane chimney exposure classification active when selection creates wall drafts and when editing materializes those drafts as surfaces. Selection previously switched to footprint-only clipping and removed 5.22 m² of exposed chimney sides in the captured house.
- Continue a measured roof plane over a contacting wall edge carried beyond its footprint by a prior side extrusion. The extension is limited to the connected overhanging interval, respects roof holes, and distinguishes lower caps from overlapping upper roofs.
- Allow the boolean seam tolerance at neighboring wall boundaries and suppress vertical return panels along internal boundaries between a roof and its continuation. Shared points, the moving cap, and adjacent returns remain roof-bounded.

## Verification

- 852 Node editor/geometry tests passed, including 13 new regressions for click-created drafts, selection/materialization/reload, rotated sequential sweeps, and all four lower caps on both chimneys.
- Fresh development project state: all eight lower support wall selections leave chimney panels unchanged. Side-then-front extrusion at all four caps stays within 0.000001 m of the lower roof plane, including shared anchors and returns.
- Runtime delta contains only `wall_chimneys.js` and `wall_solid_geometry.js`. Existing files were verified against the previous development release before activation: 24,129 web files, 24,143 worker files, and 24,129 compatibility files.
- Web, worker, and compatibility roles activated successfully. Both JavaScript HTTP checksums match the release; readiness reports the expected release, development data environment, and enforced outbound isolation.
- Live development UI: selecting the adjacent lower support face retained the continuous chimney side, and a typed half-foot extrusion was accepted. The full sequential extrusion was verified numerically against saved geometry; intermittent browser capture timeouts prevented a final visual confirmation of that sequence. The verification tab was closed without saving. Fresh metadata comparisons were identical.
- Local workspace received only the two engine changes and their regression tests after baseline comparison; unrelated local changes were preserved.

No production activation is included. No project save is required for the engine fixes.

## Rollback

Use the standard development activation workflow to restore the prior runtime on all three development roles. Refresh PHP-FPM on both PHP-serving hosts and verify readiness/asset checksums. Do not replace project metadata during rollback.
