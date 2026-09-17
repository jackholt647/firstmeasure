# Development sticker divisions

Status: activated and verified on all three development roles.

## Source and behavior

- Runtime: `c0faba77b5fec96a22760e069155ed914e814402`.
- Baseline: `770d80ca598917d152b06e8c023f9eec01e530a9`.
- Source branch: `codex/exterior-trim-controls`.
- Public delta: `wall_features.js`, `wall_face_draft.js`, `wall_editor.js`, `exterior_report_model.js`, and `exterior_pdf.js`.
- D divides a selected window, door or garage section. The selected section determines the initial direction; subsequent D presses toggle it. Every cut spans the whole coplanar sticker group.
- Numeric distances are feet from the top for horizontal cuts or left for vertical cuts. Both remaining dimensions are shown. Preview is non-mutating; click commits one undo item, Escape cancels.
- Child faces preserve appearance and feature type, with persisted group and section identities. Internal shared edges are dashed, independently selectable segments. Delete unions only the adjacent sections.
- Copying sections keeps their relationships; each paste remaps the group identity. Generic merge cleanup cannot erase intentional subdivisions.
- Reports union the sections into one opening, counting outer size, area and perimeter once; diagrams include dashed divisions. Division edges are indexed for rendering and textured-mode selection.
- D with no sticker selected still places a door; Ctrl+D retains the explicit door conversion shortcut.

## Validation

- Full local development suites passed before final refinements; focused controller/geometry/report checks passed again afterward (267 in the shared checkout, 265 in the isolated checkout before the final direction refinement).
- Browser check in an isolated local tab: selected an existing 5-by-4 window, toggled direction, typed a 2-foot distance and placed crossed cuts. Four sections rendered. Two Undo operations restored the original 4-foot height; the unsaved test tab was closed.
- Tests cover 7-foot/5-foot numeric division, crossed seams, four-to-three deletion, selected-section orientation, draft ownership, copy/paste identity, undo/cancel, serialization, report counts and dashed PDF output.
- The Linux host lacks Chromium. Seven existing browser tests passed locally but could not launch on Linux; the remaining 815 tests passed there. The final build passed all 815 checks.
- No compiled runtime, dependency, database, access configuration or production activation changes.

## Integration notes

The shared checkout has concurrent report layout, opening trim and point-occlusion changes. They were preserved locally and excluded from this release. The grouped-division report and render changes were applied to both the current shared renderer and the existing release renderer. Preserve these narrow changes when integrating that other work; do not replace the shared files wholesale.

## Deployment

- Artifact: `/home/dev/exteriors-c0faba7.tar.gz`, 249943560 bytes.
- SHA-256: `0e6050073789138822b1e0e731b3eaac439edf8297e53d04871b58247bcac17c`.
- All three roles staged and verified 1332 unchanged public source files.
- Worker, web and compatibility activation completed with development data, outbound isolation and the experimental allowlist preserved.
- Public readiness reports healthy development runtime `c0faba77b5fec96a22760e069155ed914e814402`; all five changed modules match the tested Git source byte-for-byte after newline normalization.
- An earlier candidate was staged on the worker but never activated. The final direction refinement is included in the active release.
- Production was not changed.
