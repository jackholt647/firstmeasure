# Dragging docked windows and usable floats — development, September 29, 2026

Development web release: `56c9f869e31ac7bd551a06e0b952d264a3b01c99`.
Implementation: `63c342ff6a4d02a81fa0334875fb9f4bf1c9f710`.
Previous release on both nodes: `8c95b6583074ab4a4c6052a1bfdaea8fc3c927ac`.

A docked header now detaches on pointer movement and continues the same floating
drag, preserving the grab position. Header clicks without movement remain docked;
dividers continue to resize. Edge previews and release-to-dock remain available.
The implementation handles side, corner, top and bottom docks, including project
headers in retained iframes without replacing their documents or state.

Initial floats are bounded to 72% of host width and 60% of usable height,
subject to minimum dimensions and available space. Returning from workspace or
entire-screen presentation preserves smaller user sizing; near-workspace-sized
saved floats are reduced so the header can be moved. The initial position leaves
room beside the window. Pointer movement remains immediate; button placements
retain the existing CSS transitions.

A concurrent Channels rollout changed the active baseline during preparation.
The owned-asset guard stopped this rollout before activation. Both nodes were
re-inventoried after that rollout completed, and its Channels cache version was
preserved in the final source commit. Only the shared window manager and its
manifest cache version were overlaid onto the verified live releases. Concurrent
Notes, Feedback, scheduling, Channels source and other unpublished work were
excluded. Both development web nodes, `do-598520065` and `do-603124965`, were
activated sequentially; environment safety, release identity, readiness and owned
asset hashes passed on each node. Public asset hashes and six public readiness
checks also passed.

Local Chrome checks cover drag detach from six dock placements, click versus drag,
continued pointer movement, floating dimensions after full/fullscreen, existing
docking/swaps/previews, and assistant docking. Retained-project iframe checks
verify real pointer dragging, saved draft and document identity, floating bounds,
and redocking. Both shared-window tests and the retained-project fixture passed
again using scripts served by dev.1m8.ai. These fixtures do not use an authenticated
customer session. Evidence is in ignored `output/window-detach-20260929/`.

No database, dependency, configuration, topology or production changes. Worker
and compatibility roles were not activated. The previously recorded development
autoscale replacement-image limitation remains; no image was created.

Rollback: verify no newer deployment has occurred, then atomically restore the
previous release above and restart the development web service and PHP FPM,
one node at a time, verifying readiness and preserved unrelated source.
