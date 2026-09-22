# Development Resoffit tool — September 22, 2026

User-authorized local and development-only editor update. Production was not activated.

Runtime release: `a13f0d95c67f602682420bec95ba3fc38f530c2b` on development web, worker and compatibility roles. It preserves the earlier lower-layer-clearance baseline `453277465a814dd3bb1079fdd105ae4ca3cb4abb`.

## Change

Resoffit appears between From Roof and Merge faces. Select roof-contact lines, enter an absolute depth in feet (including 0.5 ft), and Apply. Shared corners intersect the moved wall planes with their fixed neighbors. Roof height, attached base, trim and connected fragments follow; lower-layer minimums remain enforced. Impossible collisions roll back atomically. Red-orange eligible edges remain visible at the roof contact, and the dropdown retains the edit result. Shift-empty clicks preserve wall selections.

See [engine and behavior notes](../../dev/RESOFFIT.md).

## Validation

- Final Node regression suite: 839 exterior, wall, base, roof-generation and editor tests passed, including the two new highlight/rendering regressions. An earlier broad run also passed three WebGL browser tests. The final release receives live browser verification below.
- Oblique/right-angle intersections, batch edits, repeated depths, source eligibility, lower-roof minimums, intermediate roof clipping, actual-house survey junctions, persistence, undo and atomic failure covered.
- The 53-edge half-foot sweep accepted 49 edits and safely rejected four lower-roof returns whose connected faces would reverse/collapse.
- Live UI verification is recorded in the task: tool placement, edge selection, half-foot application, highlighting, visible result and undo.
- All five changed JavaScript assets are checked byte-for-byte over development HTTPS; the PHP script loader is checked in each staged release. Normal authentication remains required.

## Rollout

Only the editor PHP loader and five JavaScript modules changed. Each immutable release was copied from the verified active development baseline. Between 24,125 and 24,139 unchanged public files per role were checksum-verified. Worker activation required zero running jobs; development readiness and outbound isolation were checked on every role. PHP-FPM was refreshed on both web and compatibility hosts. Saved project data was not overwritten during UI verification.

The primary local workspace received only these edits; its unrelated PHP differences were retained. The Git branch is `codex/dev-resoffit-20260922`.

Ignored deployment evidence: `output/resoffit-20260922` in the primary workspace. Engine test and house-sweep output: the corresponding worktree output directory.

Rollback: activate the preceding runtime release `e88eedeffeec6137e3233f21576657a4bac15c11` on all three development roles, restarting their services and both PHP-FPM services, then repeat readiness checks. To remove Resoffit entirely, the pre-tool release is `453277465a814dd3bb1079fdd105ae4ca3cb4abb`.
