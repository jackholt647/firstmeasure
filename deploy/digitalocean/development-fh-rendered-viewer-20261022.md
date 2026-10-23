# Report model as the editor's Textured view, hover previews, report tabs follow the choice — development, October 22, 2026

Releases `cb0f8ddc` (viewer, all four roles) and `8181a0f8` (report tabs, legacy/web/pool). Both verified.

**Rendered model (`cb0f8ddc`)**
- The viewer also loads `exterior_rendered.js` and builds the editor's photographic presentation from its own meshes:
  material packs, HDR daylight and shadows. Lines, labels, measurements and selection washes are drawn over it.
- The editor's finish defaults reach `ExteriorFinishes`/`ExteriorRendered` through `WallMode.finishDefaults`, as in the
  editor.
- `exterior-model` now:
  - drops baked colors equal to the default they resolved from, so uncolored brick uses its photo color;
  - carries the full finish defaults (roof covering, trim and sticker colors).
- Hover previews what a click would select, fainter:
  - a face wash;
  - a hidden line drawn with its length;
  - roof pitch and area, or an opening's size.

**Report tabs (`8181a0f8`)**
- Every host call into the measurements module re-runs `mount()`, which copied the route's `reportView` into the active
  tab each time. A stale route overrode the chosen tab, and the host's strip refresh marked it: first Standard while
  Model showed, then Model on every tab.
- The routed view now applies only when the route value changes. After a chosen tab is pushed, the route value that
  reads back is recorded.
- The host's strip refresh redraws the panel if the active tab and the visible pane differ.
- The compact report header includes the Model tab.
- Dev runs another session's report-tab hotfix (`d12a4c71`, branch `claude/report-tabs-hotfix-20261022`, 1M8-205/232:
  `userMeasurementTab`, `selectInitialMeasurementTab`). These edits were replayed onto that live file without removing
  any of it.

**Test project data**
- The internal draft `fullhouse_ce52…` (saved 21:58 UTC) was opened read-only in the real editor (all writes blocked).
  Its exterior state went into the sample `exteriors_057d…` and the instant copy `exteriors_e76fff4b…`:
  `exteriorsWalls`, `exteriorsRoofTrim`, `exteriorsHeightMask`, `exteriorsView`, and the editor's
  `WallMode.reportSnapshot()` as `pdf_state.exteriorReport`.
- Backups were kept as `dev-backup-app_metadata-20261022.json` and `dev-backup-pdf_state-20261022.json`.
- The roof and 2D geometry were unchanged, so `model_data.xml` stands. Report.pdf and Summary.pdf were not regenerated.

Tests: `measurements-full-house-viewer-browser` and `measurements-roof-viewer-browser` 4/4.
Scripts: `output/fh-rendered-viewer-20261022/`, `output/fh-tab-route-20261022/`, `output/fh-model-viewer-20261022/`.

**Follow-up `21cc3bc1` (legacy/web/pool, verified)**
- Openings are built 3 cm proud of their wall on its outside, and the camera near plane is 1. This stops sticker
  z-fighting, including doors whose material `ExteriorRendered` replaces without a depth offset.
- Chimney walls and caps get rebuilt chimney ids: each cap is a chimney, and a chimney wall joins the cap above it. The
  rendered caps then take their chimney's average side color, as in the editor.

**Follow-up `88476a5f` (all four roles, verified)**
- Door and window casing: `exterior-model` now carries each opening's sticker trim faces (`trimFaces`, with sticker type
  and only a trim colour chosen for that sticker). The viewer builds them as opening trim with `prepare`/`apply`, so the
  rendered scene draws the painted casing in the sticker trim colour. The Mercer Way front door's 32 casing faces now
  show.
