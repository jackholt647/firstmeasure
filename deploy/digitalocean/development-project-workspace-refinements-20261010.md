# Project workspace refinements — October 10, 2026

Development-only follow-up to the [Project workspace release](development-project-scope-work-20261010.md).

Measurements now render all published values in a two-column editable grid, with
no producer-specific title, hover tooltip or extra navigation. Edits use existing
project-local overrides; they do not change upstream publications. The right
workspace has 10px edge padding and a compact New scope list / Generate lists
automatically header. Individual lists retain their domain controls, add rows,
animate closed into header pills, and can be archived through the existing writer.
Accepted document material sets retain provenance and can be minimized; the
domain forbids deleting them.

The rail keeps both report widgets mounted while views switch. Company primary
color supplies the bottom tabs. A reusable image viewer adds scroll zoom,
pointer panning, keyboard controls and Fit to report images while preserving
view state. The roof key has all 15 editor categories, merges step flashing into
sidewall flashing, uses 5/4 columns (fewer for very narrow panes), and occupies
reserved bottom space with its own collapse arrow. The top controls are Texture,
Colored lines and Reset view. Roof camera sizing uses the remaining canvas.

The report publication gains optional bounded `edgeTypes`, preserving its
existing authorization and completed-report gate. These classifications come
from the saved report/geometry and retain XML point deduplication, recovering
chimney/transition classifications lost in the XML export. Missing source
endpoints are skipped. Editor code, reports, permissions and production remain
unchanged.

Validation and activation details are retained in
`output/project-workspace-refinements-20261010`. Role payloads overlay only owned
files on freshly audited development baselines. Runtime safety, release identity,
file hashes and readiness are checked before and after activation. Each role's
previous immutable path in `manifest.json` is its rollback target.

## Verified source and checks

Feature commit: `1d109809d4c4e39851ee1c355d89d31c719c9aa0`. A follow-up
keeps the camera finite when the eagerly mounted roof viewer starts hidden.
The isolated source passed `npm run check` and `npm run test:publication`
(69 passed, one PostgreSQL-only skip). Eleven focused interaction/classification
checks passed, including actual WebGL openings, responsive legend layout,
image zoom/pan, retained viewers, list archive failure/project-switch guards,
and editable measurements. The roof suite additionally checks hidden eager
initialization. Desktop/mobile browser checks use the development session and
read-only client fixtures for accepted document rendering and 18 measurements.

The initial four-role rollout rebased after concurrent releases changed the
worker and frontend baselines. The final frontend camera overlay retains each
role baseline and the feature backend; the worker retains the feature release.
