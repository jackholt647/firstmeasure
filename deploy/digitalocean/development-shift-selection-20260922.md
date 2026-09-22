# Additive line selection misses — September 22, 2026

Development runtime: `6e0163edef2db805c2d618dc2312cec870df03b7`.
Previous runtime: `da6f7094b847ad14f1ed69969d3bbb46b40be627`.
Branch: `codex/dev-chimney-edit-20260922`.

## Correction

A Shift-click that missed a line could select the face or point behind it, clearing the selected lines. The earlier empty-background fix did not cover these hits. Pointer movement of four pixels also turned a click into a point marquee that discarded line selections.

When adding to selected lines, the main input dispatcher and draft picker stay in line picking. A miss no longer falls through to face, point, trim, ground or layer selection. Additive line marquees retain prior lines and add fully contained visible edges; an empty marquee changes no selection. Normal unmodified selection and active tool placement remain available.

## Validation

862 editor and geometry tests pass, including six new regressions for draft and materialized face misses, point/background misses, repeated additive picks, rectangle jitter, additive rectangles, and the main input dispatcher. The initial four regressions failed before the fix.

Only `wall_face_draft.js` and `wall_mode.js` are deployed. Local files and tests were synced after baseline comparison, preserving unrelated workspace changes. No project metadata, database, configuration, or production changes are included.

All three development roles activated successfully. Readiness and both served JavaScript checksums match the release; outbound isolation remains enforced. Staging verified 24,129 unchanged web files, 24,143 worker files, and 24,129 compatibility files. Brief HTTP 503 responses during activation cleared; final verification passed.

Live authenticated editor verification after reload: selected a wall edge, then repeatedly Shift-clicked off that line over the model. The selection readout retained one line and zero faces. The verification tab was closed without saving.

## Rollback

Restore the previous runtime on all three development roles with the standard activation workflow. Refresh PHP-FPM on web and compatibility hosts, and verify readiness and asset checksums. Do not replace project metadata.
