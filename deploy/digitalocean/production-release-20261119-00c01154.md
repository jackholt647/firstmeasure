# Production release 00c01154: the 3D roof model takes holes off face areas (FM-520 follow-up), November 19, 2026

Released from fm-agents-1 at Jack's request in the conversation ("go ahead and push this so that all future reports are
fixed in both places and ... backdated reports have 3D models that match the PDF").

The release is `00c01154` on `claude/fm-hole-area-viewer-prod`, a child of `8dd524f7` (the FM-593 batch, production at
the start of the run). Its dev form is `ebc682d8`, live on dev in `platform-20261118214212-19cf3741`.

## Why

Roof report PDFs counted every face's whole outline, holes included, until FM-520 (`1bdcbc1c`, production 2026-11-16
22:00–23:48 UTC) made them subtract dormer, chimney and skylight holes. The 3D roof model had been changed on
2026-11-03 (`197bba00`) to add the holes back so it matched those PDFs. After FM-520 it overstated every holed face
against new PDFs.

A read-only check of 40 completed production reports with holes (2026-11-18) found the split is the PDF's render
time: all 20 rendered before 2026-11-16 22:00 UTC print the whole outline, and all 18 readable ones rendered after
22:15 UTC print the area less its holes. `manifest.pdf_sync.completed_at` matched each `Report.pdf`'s timestamp to
the second.

## Change

- `public/libraries/apps/measurements/roof-viewer.js`: a face shows `model_data.xml`'s `size=` (its area less its
  holes). The viewer reads the order record (`GET /v1/firstmeasure/projects/:id?view=portal-card`, which the portal
  already calls for every report card) and, only when the order's latest PDF was rendered before
  `2026-11-16T22:00:44Z` (`pdf_sync.completed_at` when the sync completed, else `timestamps.completed_at`), adds the
  holes back so the model matches that PDF. Unknown counts as rendered since. Full-house faces with no matching
  report face follow the same rule. Nothing on screen says which rule a report uses.
- `public/libraries/apps/measurements/project.js` and `public/libraries/platform-widgets/project-widgets.js`: pass
  `reportStateUrl` to the viewer.
- `public/libraries/apps/firstmate-apps-manifest.js`: roof viewer, project widgets and measurements project bundles →
  `20261118-hole-area`.
- Tests: `measurements-roof-viewer-report-rounding` (pdf.js asserted on `getPdfFaceNetAreaPx`; both rules and the
  cutoff) and `measurements-roof-viewer-browser` (4.84 squares by default, 5.21 for an old PDF, no text about holes).
- No server code, data, environment, flag, nginx, dependency or config-library change. No PDF is regenerated.

## Checks before release

- Roof viewer suites on the release tree: 26/26 (report-rounding 7, browser 2, metric-browser 2, layers 5,
  line-types 2, wall-default 3, wall-outward 5).
- Dev: on a real dev report with holes (`9b942ddf…`, PDF rendered 2026-11-16 19:16 UTC), the served viewer showed
  17.37 squares (9/12 11.56, 10/12 5.81) with the old-PDF rule, exactly what that `Report.pdf` prints, and 16.58
  with the new rule or no order record.
- Built on the dev worker (`build.sh`, 340 s). Archive sha256
  `64178057ba7748af9b74905cdb9661f021d2fef293f5eb132e9de8a3dfbccd07`.
- `fastpath.sh decide` against `8dd524f7`: **full procedure** (server, dependencies same; the release tooling counts
  `public/libraries` as Node's side). 6 changed files.
- `web_activate.py` = FM-593's, repinned for the four changed files (manifest, measurements `project.js`,
  `roof-viewer.js`, `project-widgets.js` digests and `?v=` needles) plus this release's asserts. 121 file asserts pass
  on the archive and fail on `8dd524f7`'s tree (control). Rollback asserts (FM-593's, base `00c01154`) pass 118/118 on
  `8dd524f7`'s tree.

## Rollout (scripts: fm-agents /srv/agents/work/fm-hole-area-prodrun-scripts)

- Waited for the FM-593 run to finish (its compatibility gate opened 01:17 UTC; record `501dae2f` at 01:35).
- Installed on compatibility and the worker; channel published against `8dd524f7`'s archive.
- Web nodes one at a time, 01:38:11–01:50:53 UTC. Each passed every assert and came back behind the load balancer.
- Worker activated 01:52:09 UTC with no running jobs.
- Compatibility: through `compat_gate.sh` (legacy-action under 420/min); see Verification for when it opened.

## Verification

- Through the load balancer, 12/12 requests each: `roof-viewer.js` `1fdb27febe05…`, `project-widgets.js`
  `2e1fb1ce0975…`, `measurements/project.js` `ee36f6f1f10f…`, apps manifest `c3f64532f54a…`, all equal to the release.
- Readiness 10/10 reports `00c01154`.
- Web 5xx 01:38–01:53 UTC against the 30 minutes before: 0.03–0.08 % (3–9 per node) against 0.04–0.07 %; every one is
  the long-standing `/measure/internal/top_view_reroll_proxy.php`.

## Rollback

`rollback/`: FM-593's `web_activate.py` with base `00c01154` and `web_rollout.sh`; republish the channel with
`8dd524f7`'s archive (`old-8dd524f7.tar.gz`, sha256 `3a56c065…`) before rolling the web nodes; worker and
compatibility back with `activate-release.sh 8dd524f7…`. Rolling back brings back the November 3 viewer, which adds
holes back to every holed face.

## Open

- Canonical (`codex/consolidated-firstmeasure-20260923`) has this viewer change (`ebc682d8`, through the dev router)
  but not FM-520's `pdf.js`; the measure-internal lane is 201 commits ahead of it. A production release built from canonical would bring the PDF bug
  back. Merge the lane into canonical before any such release.
