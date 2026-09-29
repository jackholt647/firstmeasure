# My Projects view controls — development, September 29, 2026

Source and development release: `45cad4faddf640bdbd00b3e7021852345ba0e35d`.
Previous releases: `147e3158f5b0ee4ede478499f21ffe0ed732258c` on both web nodes,
`499a0ce1903f41cc1e32925b28406b91902abbb4` on compatibility.

The My Projects subtitle and column-sort tip are removed. The Stages, List,
Tiles and Manage view controls align to the right of the title. The board picker
remains below for Stages and List. List now uses Manage view to choose visible
columns; column headers still sort. The selected board groups List by stage,
while All groups by board. Stages uses Manage view for order field and direction.
Tiles uses it for stage filtering, order field and direction. The group headings
in List have stronger typography and color. The old status filter, grouping
selector and combined sort menu are removed.

Only the Projects viewer and its bundle token were overlaid onto each role's
current release. Live viewer hashes matched the parent source commit. The
manifest token was replaced in each role's live file, preserving other release
entries and unrelated in-progress local edits. All three roles passed guarded
staging, activation, development-isolation, readiness and file-hash checks.
Two public asset hashes and six public readiness responses matched. The browser
fixture passed locally and with the script served by dev.1m8.ai, covering
right-aligned controls, List column choices and sorting, Stages ordering, Tiles
stage filtering, All board grouping, and the narrow layout. Evidence and
rollout scripts are in ignored `output/project-view-controls-20260929/`.

For rollback, first check for newer releases, then restore each role's previous
release through the atomic current symlink and restart its web or compatibility
service and PHP FPM, one role at a time. Production and worker are unchanged.
