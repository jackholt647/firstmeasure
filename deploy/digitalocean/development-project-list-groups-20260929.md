# My Projects List grouping — development, September 29, 2026

Release `4733be6b2b99fc7ae303b96bc72b6210c7910375` is pushed and active on both development web nodes and compatibility. It tightens the My Projects controls, orders the views Stages/List/Tiles, and removes Drafts and Refresh. The existing minute poll now refreshes board configuration as well as projects.

List uses the Stages board picker. Its All boards option groups projects under collapsible colored board headers, including an Unassigned group. A selected board can be grouped by stage or board using the dropdown before All Statuses. Stage groups accept drag movement through the existing permission-checked manual-stage API. Sorting remains within each group.

Only `public/libraries/apps/projects/viewer.js` and the Projects bundle entry in `public/libraries/apps/firstmate-apps-manifest.js` change. Each role inherits its verified predecessor's other files and manifest entries. The predecessor for all three roles at activation was `e515f117a35fe9f6201f0df60f0db419c0638d4a`. A parallel development rollout changed live predecessors during the first staging and activation attempt; the guarded workflow stopped before modifying the affected roles. They were re-inventoried, restaged, and verified. Worker and production are unchanged.

JavaScript syntax and diff checks passed. A real-browser fixture exercised control order, board and stage grouping, All and Unassigned, collapse, sorting, stage drag, and a 390 px layout using both local and hosted viewer scripts. All three roles passed hashes, readiness, and development-isolation checks. Two public assets and six public readiness responses matched. Evidence is in ignored `output/project-list-groups-20260929/`.

Rollback: check for intervening releases, then restore `e515f117a35fe9f6201f0df60f0db419c0638d4a` on the three updated roles through the existing atomic symlink and service workflow. Verify public readiness as each web node returns. No database or configuration change was made. The existing development autoscale replacement-image limitation remains.
