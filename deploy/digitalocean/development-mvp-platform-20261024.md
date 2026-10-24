# Development rollout: MVP platform signup configuration and the My Projects map (2026-10-24)

Three releases on the development worker, legacy (compatibility) and web roles. The pool node is unreachable
(down since 2026-10-22) and was not part of these rollouts. Tooling: `output/mvp-platform-20261024/`
(`candidate.py`, `candidate2.py`, `candidate3.py`, `ship.sh`, `replay.py`).

| Release | What |
| --- | --- |
| `cc9144c3` | Signup sandbox `swf_mvp_platform`: FirstMeasure default stages plus expanded access with an explicit app list (`MVP_PLATFORM_ENABLED` in `signup-sandbox/service.ts`). Seeded once; edit the saved workflow to change it. |
| `6e50be65` | My Projects Map view (`projects/map-view.js`, gated on `apps.project_map`); MVP test orgs can take sample data. |
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

## Known issues found (not from these releases)

- The project **Notes** tray shows "Cannot access 'filterMenu' before initialization": in canonical
  `project-notes/project-notes.js` (from `18d7c000`/`31d47774`), `render()` calls `syncAuthorFilters()` before
  `filterMenu` is declared. Another session has an uncommitted rewrite of that file in the shared checkout; left to it.
- A **Messages** tray shows beside Notes because both are gated on `channels.project_notes`.
- Sample projects have no board, so the map shows them as "No board" (grey); stage colours show with real boards.
