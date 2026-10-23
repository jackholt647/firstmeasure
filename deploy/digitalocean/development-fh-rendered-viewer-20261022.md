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

**Follow-up `d35e275f` (all four roles, verified)**
- Openings stand out along the editor's saved outward wall normal, which `exterior-model` now carries. The house-centre
  guess pointed inward on a wing of the L-shaped plan (W23), which put both garage doors inside the brick.
- Rollout notes:
  - Legacy's TypeScript staging check was killed twice by the kernel for lack of memory (4 GB, no swap; the dmesg log
    shows node OOM kills while other sessions staged at the same time).
  - This release's own unactivated staging dirs were renamed to `*-failed-<time>` so it could restage.
  - It staged once about 3 GB was free.

**Follow-up `036660a7` (legacy/web/pool, verified)**
- Full-house roof faces show the matching `model_data.xml` face's pitch and area (the published report values), matched
  by face center. They measure the plane only when no report face matches. Mercer Way's main face now reads 12/12,
  775 sq ft, as the report does (previously 12.4/12).
- Legacy host: on Jack's go-ahead a 4 GB `/swapfile` was added (swapon, `/etc/fstab`). Previously it had none, and
  concurrent staging TypeScript checks were OOM-killed.

**Projected design `1cf37662` (all four roles, verified)**
- Viewer: an As built / Projected toggle and a Design panel, top right. The panel holds:
  - defaults: walls, trim and fascia, roof type and colour, doors, door trim, garage doors, window trim;
  - per-face choices for the selected wall or opening;
  - Generate from materials and Reset.
- Faces are re-prepared and re-applied through `ExteriorFinishes` and `ExteriorRendered` with the projected finish
  defaults, as in the editor.
- `GET`/`PUT /v1/firstmeasure/projects/:id/exterior-design` saves `exterior-design.json` on the report. It uses the
  same organization check and completed full-house scope as `exterior-model`, and only presentation is stored. The
  endpoint answers 401 without a session.
- Generate from materials reads `/v1/materials/organizations/:org/projects/:project/material-lists`:
  - the roof covering line's type, plus its selected colour option's hex or a matching preset;
  - siding, trim, door and garage door lines by name and colour.
- Tests: the full-house viewer file passes 4/4, including the design flow and the sanitizer; the roof viewer passes 2/2.
