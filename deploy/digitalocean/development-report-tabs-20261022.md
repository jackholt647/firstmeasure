# Report tabs follow the open report; XML in the flat header — development, October 22, 2026

Source `d12a4c71` on `claude/report-tabs-hotfix-20261022`, cut from `codex/release-20261022b` (`f7fd3fc8`) so it can follow
that release as a small hotfix. It is not on the canonical branch.

**1M8-205 (reopened: "stuck on Standard").** Livia's screenshot is a project window with Map | Reports and the strip
Summary · Standard · Customer · XML · Support; Standard is marked while the Customer PDF (Summary.pdf) shows. Cause: the
project modal mounts the report app with its outer panel (`.r-preview-panel`), the apps runtime mounts it with the
panel's main region (`.r-tab-main`). A render with the outer root moved the tab strip out of the main region, so a
render with the main region could not find it and returned early: the panes switched, the strip kept its last highlight
and click handlers. That highlight was the hydrate's default, Summary before `41b65307` and Standard after. Fix
(measurements/project.js): both mount targets resolve to the element holding the report body, the strip is found
anywhere in the panel, a strip-only header repaint re-syncs the panes, the person's tab survives a runtime remount, and
a second copy of the bundle (index.php and the runtime use different `?v=` keys) defers to the first. The opening
stand-in strip (project-request/app.js) follows the app's tab and is not redrawn once the app's own strip exists.

**1M8-232 (XML download).** The flat report header (Map, Summary, Standard, Customer, Photos) had no XML tab, so the
Download XML Model button was unreachable; the XML tab is now in the header (project_viewer.js `reportHeaderTabs`, the
compact tab filter, and the opening tabs when the project has an XML file).

**Tests.** `public/v1/tests/report-tabs-real-clicks-browser.test.mjs` drives real clicks in Chrome on all four tabs with
the real measurements app (loaded twice), navigation, tab renderer and opening-tab code, through header repaints, runtime
remounts, re-hydrates and project switches, with and without `reportView` in the address, for the flat and Support
layouts, and downloads the XML. 7 pass; on `f7fd3fc8` 6 fail; on dev's previous live files (`8181a0f8`) 6 fail.
`report-header-browser` updated (XML in the flat tabs) and passes; related suites pass; `npm run check` passes.
`project-opening-browser` (3) and `project-feature-gates` (1) fail identically on `f7fd3fc8`.

**Rollout.** `output/report-tabs-20261022/` (copied from the newest rollout scripts), legacy, web and pool, merged onto
dev's live files (`8181a0f8`). Dev's measurements/project.js also carries canonical's `cb0f8ddc` (Model in the compact
header, `syncReportNavigation`) and `652a0c4a`/`8181a0f8` (apply the routed view only when the route moved). The three
conflicts kept both sides: compact tabs Model and XML; mount() applies a moved route, else restores the person's tab;
reset() clears `appliedRouteView` but keeps the person's tab. The merged payload passed the test before activation.
Two earlier attempts were refused at activation because other rollouts activated meanwhile; nothing was changed then.
All roles verified; dev serves the new code under bundle key `20261022-report-tabs-v1`. Production was not changed.
