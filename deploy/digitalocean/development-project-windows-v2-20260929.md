# Independent project windows — development, September 29, 2026

Source and development web release: `068eafd9f4055a4acb9f04d8c95d88e94e5aa769`.
Previous release on both web nodes: `72482beb4b9cfbc45c01771ba6be8adf1f8ed672`.

Project windows now have a thin control/drag bar joining the left pane, with
the existing taller application tabs below it on the right. The folder icon
precedes the left-column project title; there is no additional project tab.
Pin controls are removed from shared window chrome and menus. Modal, floating,
right docking, workspace fill, whole-screen fill, minimize and close remain.

Minimized windows use 224 × 32 pixel bars, arranged horizontally and wrapping
when needed. Contact chrome also fits the shorter shared minimized height.
Each project retains an independent same-origin portal document so existing
app-owned tabs, DOM IDs and module state remain isolated. Opening another
project does not replace a minimized project, and reopening the same project
restores its existing window. There is no imposed project-window count limit.
The parent owns placement and compact minimized controls. Minimization retains
the embedded document's viewport dimensions, preventing responsive rerenders
from clearing unsent notes. Placement never reparents the live iframe.

Five frontend assets were overlaid onto each verified predecessor release:
the shared manager, new project-windows helper, project app, app manifest and
Contact modal. Concurrent Notes and other workspace edits were excluded.
Both development web nodes were activated sequentially and verified healthy:
`do-598520065` and `do-603124965`. All five asset hashes matched on both nodes
and through the public development URL; six public readiness checks passed.

Validation passed:

- TypeScript check and JavaScript syntax checks.
- Eight retained project contexts, independent drafts and closing, same-project
  reuse, real iframe dragging, all five placements, exact workspace/fullscreen
  bounds, horizontal wrapping, title placement and absence of pin controls.
- All 15 shared-window restore interactions and Contact window regression checks.
- Twelve focused project capability and mobile order/draft tests.
- An authenticated browser check against the deployed portal using a disposable
  organization: two named projects minimized independently, an unsent note
  survived restore, and closing one left the other intact. No page errors.
  The disposable organization, identity and session were removed afterward.

Ignored evidence and guarded staging/activation scripts are under
`output/project-windows-v2-20260929/`. Production, development worker and
compatibility roles, configuration, and schemas were unchanged. The historical
autoscale image limitation remains; no new image was created for this rollout.

Rollback requires checking for a newer deployment, then restoring the previous
release above via the atomic current symlink and restarting the development web
service and PHP FPM, one web node at a time, with readiness checks after each.
