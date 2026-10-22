# Full-house report model in the 3D viewer — development, October 22, 2026

Release `066c69533b27615ad8d6f93406dcbf56b27a1733` (parent `df0ad5b5`).

**What changed**
- `GET /v1/firstmeasure/projects/:id/exterior-model` (`firstmeasure/exterior_model.ts`) returns a slim projection of a
  completed customer full house:
  - the published exterior report (walls with material keys, openings, wall edges, base, roof faces, fascia, caps);
  - the editor's source roof graph and finish defaults.

  It runs the same organization check as `exterior-measurements`. No editor state, QA data or images leave the server.
- The `reports.roof` widget data carries `exteriorUrl` for full-house reports, and the Reports tab passes it too.
- `roof-viewer.js` loads the editor's own kernel and finishes from `measure/internal/editor_scripts`: Clipper, earcut,
  `exterior_geometry`, `wall_solid_geometry`, `wall_features`, `roof_trim` and `exterior_finishes`. It renders exactly
  as the editor's Textured view:
  - unlit materials with `ExteriorFinishes.prepare`/`apply`;
  - `roofMeshes` with soffit undersides, plus ridge and hip caps and skylights;
  - fascia from the report or `RoofTrim.panels`;
  - the `exteriorSurfaceDisplay` depth offsets.
- New viewer controls:
  - Roof/Walls/Base layers;
  - categories for roof lines, wall surfaces by material, wall edges and openings;
  - click to inspect a face or line;
  - decluttered line-length labels;
  - a two-point measure tool that snaps to model corners.
- Layout: a standalone viewer at least 900 px wide puts its measurements in a left column. Narrower panes (the Projects
  tab rail, phones) keep the tabbed tray under the model.
- Reports tab:
  - the model tab is "Model", mounted directly with no media selector column;
  - the floating Support button is hidden on the Model tab.

**Rollout**
- All four roles were overlaid with the eight files.
- On legacy, web and pool, `measurements/project.js` keeps the release candidate's live `reportModelViewerEnabled()`
  gate, with this release's five edits replayed onto it. The manifest swaps only the roof-viewer and project cache keys.
- The first attempt stopped while staging pool because another session activated `1767838f`. It was rebuilt onto
  that release and activated worker, legacy, web, pool. Verify passed.
- On dev web, the newest instant dev copy of 4725 W Mercer Way (`exteriors_e76fff4b…`) projects to 66 walls,
  299 wall edges, 40 roof faces and the 107-point source roof.

**Tests**
- `measurements-full-house-viewer-browser` 2/2, `measurements-roof-viewer-browser` 2/2, `project-scope-work-browser`
  23/23, `publication-widgets` pass.
- `platform-widgets-browser` has two failures ("late reads…", "Scope uses shared widgets…"). Both fail identically on the
  parent commit.

Scripts: `output/fh-model-viewer-20261022/`.
