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
