# Development rollout: MVP platform signup configuration and the My Projects map (2026-10-24)

Three releases on the development worker, legacy (compatibility) and web roles. The pool node is unreachable
(down since 2026-10-22) and was not part of these rollouts. Tooling: `output/mvp-platform-20261024/`
(`candidate.py`, `candidate2.py`, `candidate3.py`, `ship.sh`, `replay.py`).

| Release | What |
| --- | --- |
| `cc9144c3` | Signup sandbox `swf_mvp_platform`: FirstMeasure default stages plus expanded access with an explicit app list (`MVP_PLATFORM_ENABLED` in `signup-sandbox/service.ts`). Seeded once; edit the saved workflow to change it. |
| `6e50be65` | My Projects Map view (`projects/map-view.js`, gated on `apps.project_map`); MVP test orgs can take sample data. |
| `4123e67a` | Notes render after the author filter menu exists (fixes "Cannot access 'filterMenu' before initialization" on a new project); My Projects remembers only boards someone picks (storage key v2), so the default is the board with the most projects; `channels.project_messages_tray` gates the Messages tray, off in the MVP platform (the saved workflow gains it via the seed). |
| `2e9c8da3` | `projectView=map` allowed in the manifest's route schema (a map link fell back to Stages); sample projects carry lat/lng around Denver because their synthetic addresses do not geocode. |

## Host merges

- `firstmate-apps-manifest.js`: hosts carry a newer viewer bundle version than canonical, so the map bundle and the
  route value were replayed onto each host's live file (`replay.manifest`).
- `portal/index.php`: only the `map-view.js` script tag (another session has an unrelated uncommitted edit there).
- Legacy runs an older signup sandbox UI (`sandbox.js?v=2`, no sample-data button); its two sandbox files were kept.

## Verified on dev.1m8.ai

- The sandbox lists **MVP platform**. A new instance shows only My Projects, My Contacts and Feed in the left column;
  the Apps / To Do / Channels / AI left-column modes are not visible.
- Project window tabs: Overview, Photos, Docs, Customer Portal, Project, Reports. Trays: Notes, To Do, Messages,
  Activity, Agent. The Project tab's rail has Measurements, Documents and Photos and no Schedule.
- Map: `?projectView=map` opens the map; with sample data all four projects are placed; clicking a row selects it
  and opens the preview card; **Open project** opens the project window.

After `4123e67a`, a new MVP instance's trays are Notes, To Do, Activity and Agent, and a new unsaved project's Notes
tray shows "No notes yet" with no error. The shared checkout's working copy of `project-notes.js` holds an unrelated,
uncommitted older variant (last touched 2026-10-16); the fix was replayed onto the committed file.

## Known issues

- Sample projects have no board, so the map shows them as "No board" (grey); stage colours show with real boards.

## Later releases (same day)

| Release | What |
| --- | --- |
| `c0f34bdc` | Cover photo only in the full Overview (no longer floating over the expanded map); default satellite cover uses the thumbnail endpoint with fallbacks (it pointed at a google.png artifact that often did not exist); set and see the cover from Photos; the Overview map fills its card. Web needed a second activation (runtime release check raced the restart). |
| `36d6858c` + `8374f90d` | MVP platform moved into `signup-sandbox/configurations/mvp-platform.ts` with a setup script (Generic Roofing scope, intake routing to it, other preset scopes off); workflow data `sample_data`, `setup_scripts`, `dev_bar`, `configuration_revision`; top bar with search and notifications; no test-run bar for MVP or Instant full org. 36d6858c failed the host TypeScript check and never activated; it shipped with 8374f90d (base c0f34bdc), which also carried another session's `3c1df2d4` (session replay). |
| `a823eb07` | Manual measurement entry when there is no report (manual dataset, `measurements.manual.save`, project history); empty-organization board tie goes to a real board. |
| `11e969cc` | To Do, Activity and Agent trays on a new, unsaved project; assistant no longer stuck on Loading with no conversation. Legacy keeps its older `project-trays.js`. |
| `04a3829c` + `ccad1ebd` | Map camera: one eased centre-and-zoom tween from the click; full-house exteriors on in the MVP platform (revision 3). |
| `ea21b143` | Roof-only 3D roofs use the exteriors editor's dense shingle covering; MVP platform turns on `firstmeasure.roof_model_viewer` (revision 4). Dev runs that gate from the release-branch hold `067deb12`, which canonical lacks. |

Verified on dev: a new MVP org has one Roofing board (New, Inspection, Estimate, Sold, In production, Complete), no test-run bar, the top bar with search and notifications, and Full House Reports on. The map camera and the roof viewer were verified in local harnesses only: the browser pane was hidden (no animation frames), so in-pane checks of animated views stall at "Loading".

| Release | What |
| --- | --- |
| `cd228a8d` + `501cfd60` | Left-column pins: apps declare pinnable subviews (My Projects: Stages, List, Tiles, Map); personal `left_column_pins` preference; hover/focus roll-out in the apps overlay; drag-to-pin onto the left column; collapsed column widens to 78 px while the overlay is open; all behind `platform.advanced_app_menu`, which the MVP platform turns on (revision 5). cd228a8d's core.js had misplaced zero-context hunks (a syntax error); 501cfd60 fixed it before anything shipped. Checked after activation: the served core.js parses and the new library is served. |
