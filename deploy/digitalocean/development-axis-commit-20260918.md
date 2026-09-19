# Development vertical cut commit repair — September 18, 2026

Runtime `565faf923e73c909e438a3e3b2348c646f91f228`; baseline `957a20c52f04bfdece4df9e3e770da223601dfc5`.

The browser error log confirmed an uncaught normalizeFace rejection during finishAxisCut. A minimized surface from the saved project reproduces it: the cut meets a window boundary and splits a bridged wall ring into two valid regions. Draft validation previously demanded one region. Non-feature draft regions now retain all normalized parts and their sketch-node IDs. Feature faces retain single-face validation.

Axis-cut previews validate before becoming placeable. Unexpected commit rejection restores the original edits, releases the tool and reports the reason rather than trapping all clicks in the failed preview.

876 regression tests pass. The saved geometry regression verifies both pieces, node ownership, click-to-commit, selectability, undo history and Escape after commit. A forced commit rejection verifies restored geometry and released controls. The fixture contains only the affected surface and starting point.

Root files were updated after verifying their baseline. The guarded two-file delta preserves other public runtime files and verifies release identity, readiness and development isolation on all three roles. Production is unchanged. Refresh and retry the cut.
