# Scheduling release polish — development, September 29, 2026

Release `856b5729cd55c3a0de7e7bc8ca29a80c1b782492` is pushed and active on both
development web nodes and compatibility. Worker and production were not changed.

The UX pass is listed item by item in
[docs/scheduling-polish-20260929.md](../../docs/scheduling-polish-20260929.md).
In short, the global Scheduling header shows the Sales/Production/Other filters
as check chips in every view, including Timeline. Views are grouped in
segmented controls, and the header arrows and Today button drive the Timeline.
The Timeline now:

- follows the header filters
- opens near today or on the nearest scheduled work
- keeps its viewport across saves
- adds Fit zoom and lanes for each assigned person
- correctly shades weekends, snaps to local days and handles daylight-saving
  changes

The project Schedule tab uses the same Timeline naming, navigation, lock and
equipment rules. Fixes include:

- phone view and month menus that ignored taps
- schedule groups queued as waiting work
- older timed events shown as all-day
- raw assignee ids on project tiles
- the crowded production tile

Only four frontend files are replaced: the scheduling app, the project
schedule panel, the shared schedule view and the apps manifest. The manifest
changes only the project-schedule bundle version. Each role inherits its
verified live predecessor, `f85233b8f4194edd94510d63988a5f6f095686dc`, with a
guarded four-file overlay. There are no backend, database, worker or topology
changes.

Validation:

- JavaScript syntax checks passed.
- The scheduling contract suite matches its pre-change baseline. Its 33 older
  failures are unchanged, and two assertions were updated for the intended
  source changes.
- The equipment picker and equipment browser tests passed.
- A browser fixture seeded with projects, crews, dependencies, deliveries and
  locked items passed at 1440 px, 1100 px and 390 px. It covered header
  paging, Today, drag-to-reschedule with local-midnight snapping, scroll
  retention after save, the production filter, header filtering of the
  Timeline, continuous zoom-slider drag, resource lanes, project paging and
  single Today, and phone view switching. Screenshots were reviewed.
- The fixture passed again using the scripts served by dev.1m8.ai.

The localization catalog check already fails at HEAD (a stale equipment
catalog). The new strings fall back to US English until the next catalog
migration.

All three roles passed staging hashes, syntax checks, readiness and
development-isolation checks. Each web node returned to public traffic before
the next one was activated. Four public asset hashes and six public readiness
responses matched. Evidence is in ignored `output/scheduling-polish-20260929/`.

Rollback: check for intervening releases, then restore the
`f85233b8f4194edd94510d63988a5f6f095686dc` symlink on each role with the
existing atomic symlink/service workflow. Verify public return one web node at a
time. There are no migrations to reverse. The existing autoscale
replacement-image limitation remains.
