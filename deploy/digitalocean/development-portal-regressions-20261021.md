# Customer portal regressions after the October 20 release — development, October 21, 2026

Source `41b65307`, committed on the session branch `claude/optimistic-tharp-76908f` and based on `31141b11`
(`fixes-base-20261021`, the production release plus the October 21 hotfixes). The commit is not on the canonical branch yet;
the coordinating session merges it.

**1M8-205: the highlighted report tab is the open report.** Hydration called `setActiveMeasurementTab('model')` once a report
was ready. With the 3D tab gated off, the fallback picked the first tab (Summary) and pushed `reportView=summary` into the
route, so every re-hydrate snapped back to Summary. Now `selectInitialMeasurementTab` (measurements/project.js) takes, in
order: the route's `reportView`, the tab the user clicked for this project, the model tab only when
`reportModelViewerEnabled()`, the caller's fallback, then Standard. It does not write the route. An unavailable tab falls
back to Standard, not the first tab. A route with no `reportView` uses the same choice.

**1M8-210: cancelled orders.** The opening header counted a cancelled order with a measurement id as ordered, but the hydrated
header used `hasReportOrdered()`, which is false for cancelled orders, so the layout flipped to the full tab set. Both now
use `projectReportOrderExists` / `reportOrderExists()` (project-request/app.js); a reorder still shows the ordering layout.
The report summary's document rows say Cancelled (cancelled) or Not available (rejected, release hold) instead of
Processing.

**1M8-208: stale Processing on old reports.** Ids that the batched `projects/list` summary omits (visibility filters, Full
House ids) kept their order-time status. They now read their own `?view=portal-card` summary.

**1M8-202: contact placeholder.** The tile badge patch wrote `N/A`; it now uses the full render's
`fm_contact_unavailable` ("Not provided"). The list-row patch uses the full render's `resident.name || '—'`.

**1M8-206: drafts.** Work plans are created automatically when a project starts a scope, so `work_plan_ids` and
`work_projection.plans` no longer count as activity (viewer.js and core.js). A project whose `workflow_state` is `draft`
stays a draft until it has an order, a proposal or an appointment. Shared records (`project._shared`) still bypass the
draft filter: they carry no activity fields of their own and would otherwise all be hidden.

**1M8-211: Settings missing while impersonating.** The banner's `.sidebar{top:44px;height:calc(100vh - 44px)}` shifted
the desktop sidebar (position:relative, below body's 44px padding) a second time and clipped its last 44px, the
Settings row. The override now applies only under `@media (max-width: 820px)`, where the sidebar is the fixed drawer.

**Platform sync without expanded access.** `savePlatformProjectFromFirstMeasure` is skipped unless
`platform.expanded_access` is on (before capabilities load, the session's `platformExpandedAssets` decides), and
`list_projects` then uses the FirstMeasure-only branch so new orders always reach the board. In production (platform
off) this removes the 403/400 project writes.

**Bundles.** `projects/viewer.js`, `project-request/app.js` and `measurements/project.js` use
`versionedBundle(..., '20261021-portal-regressions-v1')`; `core.js` and `index.php` are versioned by the portal itself.

**Tests.** `public/v1/tests/portal-regressions-20261021.test.mjs` (15 tests, two in Chrome: header highlight against
the open pane through repeated hydrates, and the desktop Settings row with the banner) passes.
`report-header-browser.test.mjs` now loads `projectReportOrderExists` with `openingProjectTabs`. The related suites pass
(report-header, portal-summary-hotfix, board controls, roof viewer, Full House summary, reorder host, localization
display, project primary, unassigned views, header isolation, work departments). `project-feature-gates` has one failure
that is also present at the base commit (typed-address geocode regex). `npm run check` passes; `php -l` passes.

**Rollout.** Frontend and portal files only (`output/portal-regressions-20261021/`, copied from
`resoffit-box-snap-20261021`): the six files were three-way merged onto each role's live copy (hosts were on
`338f53ad`; legacy keeps its older `core.js` with this change merged in). The one-line apps manifest conflicted with
other bumps, so the three bundle keys were replayed onto the live manifest. Legacy, web and pool were staged,
activated and verified. The worker and production were not changed.

## Follow-up: expedite wait bar (1M8-197) - `d706f831`

The order form's "Estimated wait time right now" bar labelled its ends with fixed "4 hrs" / "7 hrs" while the marker was
placed against a hard-coded 3-6 hour window (the October 14 build had the reverse: "3 hrs" / "6 hrs" labels against a 4-7
hour window). Both now come from the standard option's configured turnaround window (`base_start_minutes` /
`base_end_minutes` from the server, 4-7 hrs by default): a 5-hour estimate in a 3-6 hour window sits at 67% and the
ends read 3 and 6 hrs. The end labels use a new `wait_range_hours` message ("{hours} hrs"); until the catalogs are
regenerated it shows the English fallback in every language. Tests: 5 new cases in
`portal-regressions-20261021.test.mjs` (20 pass with report-header), `npm run check` passes. `project-request/app.js` and the
manifest key (`20261021-expedite-wait-bar-v1`, replayed onto the live manifest) were merged onto web, legacy and pool
(hosts were on `a8154fde`) with `output/expedite-wait-bar-20261021/`; all roles verified and dev serves the new code.

1M8-195 ("Update XML file property names") has no description in Linear; it waits on the required names.
