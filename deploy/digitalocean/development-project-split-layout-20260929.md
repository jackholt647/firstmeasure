# Project split-content prototype — development, September 29, 2026

Final development web release: `0fd9508eaafddc0b228abc3802d962234d08b5d8`.
Layout source: `a232984d02e35eaac8d582ca763eb3df9ea66dba`.
Predecessor before this work: `9cfc7fc78d0c55bd83d6a4b0e70c9ed554d88906`.

Project windows now show the project title above the tabs, with all window
controls in one row at the top right. The shared project sidebar is off.
Development-only rollback switches are the `config` object in
`public/libraries/window-manager/project-layout.js`: `enabled`,
`showProjectSidebar`, and `splitTabs`. There is no settings menu or saved user
preference. Creation workflows retain their required form inside the content.

Right-click a tab to dock it left or right. Open tabs have an outline star;
clicking an already docked tab focuses its existing pane. Docking the current
tab keeps it open when another tab is selected. Multiple panes are supported,
with horizontal scrolling when minimum pane widths exceed the window width.
Drag a divider to resize adjacent panes; double-click to swap them. Dividers
also support arrow-key resizing and Enter to swap. A docked tab's context menu
can close its pane.

Each docked app retains an independent same-origin document and local content
rail. Legacy app DOM IDs, state, and left-root contracts remain isolated; the
app-specific left/right sections are inside each pane's content container.
Reordering changes flex order without reparenting or reloading live iframes.
Window minimization keeps pane documents and their viewport state mounted.

The follow-up core/viewer change validates frame ownership with the parent
registry, then skips unrelated portal tab activation in owned project documents.
Hidden Projects-list fetches, refresh bursts and board loading are suppressed
there. The main portal retains its normal initialization and services.

Delivery used two guarded frontend overlays on both development web nodes:
the project app and new layout helper, followed by portal core and the Projects
viewer. Each node inherited its verified current release and was activated
sequentially. Concurrent Notes, Feedback, navigation/setup and documentation
edits were excluded. Production, other development roles, configuration and
schemas were unchanged; no autoscale image was created.

Validation includes JavaScript syntax and diff checks, the split-pane browser
suite (local and hosted helper), eight retained-project window contexts, all
15 shared restore interactions, and 12 focused capability/mobile draft tests.
The split suite covers local rails, open stars, docking, three panes, resizing,
swap without losing drafts, closing panes and primary-tab retention.
Authenticated verification against the unmodified deployed portal passed with
Photos and Scope, checking app-local controls, swap, minimize/restore, closing,
and absence of the hidden Projects list. No page errors occurred. The disposable
organization, identity and session were removed. Both web nodes verified healthy
on the final release. All four public asset hashes and six public readiness
checks passed. Evidence and guarded deployment scripts are in ignored
`output/project-split-layout-20260929/`.

Rollback must first account for any newer deployment, then restore the
predecessor above via the atomic current symlink and restart the development
web service and PHP FPM one web node at a time, checking readiness after each.
The intermediate `a232984` release contains the layout without focused boot;
prefer rolling back to the pre-task release when reverting this prototype.

Follow-up: [Split-pane behavior, compact tabs and shared realtime fixes](development-project-split-fixes-20260929.md).
