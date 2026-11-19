# Production release 8dd524f7: batch FM-593, FM-581, FM-576, FM-574, November 18, 2026

Released from fm-agents-1 by one Router batch run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. One release for four issues, each with its
own production plan in the tracker.

The release is production-live `df49f323` (record of release `633e5c23`, FM-457, production at the start of the run)
with each plan's production branch merged in, in this order (no conflicts):

| Merge | Plan branch (tip) | Issue | Verified on dev in |
| --- | --- | --- | --- |
| `e645ce98` | `claude/fm-593-international-exterior-pricing-prod` (`862c0941`) | FM-593 international Full Exterior prices | platform `9dc3383b`, measure-internal `3fb24463` |
| `10666d8f` | `claude/fm-581-unexpected-behavior-prod` (`486b987b`) | FM-581 invisible wall slivers in the exterior report | measure-internal `2793fb27` |
| `3fda8089` | `claude/fm-576-company-phone-formatting-prod` (`b324d13a`) | FM-576 Company phone typed as at signup | platform `7c2d68cc`, `21d7f4a5` |
| `8dd524f7` | `claude/fm-574-fix-prod` (`61ba3924`) | FM-574 metric reports in m / m² | platform `8aea6e58`, `e2fdf719` |

Each plan's diff (from its base) is identical, hunk for hunk, to the release's diff from production-live over that
plan's files; only blob ids in the `index` lines differ, where FM-457 had changed `api.ts` and the apps manifest. No
two plans share a file. Nothing outside the plans is in the release.

## Change

- **FM-593** (Node + staff Prices page): `commerce/profile.ts` gives the international price list Full Exterior
  entries `exteriors_base` 60, `exteriors_same_day_fee` 10, `exteriors_priority_fee` 25 (defaulted, so a saved policy
  without them still loads) and `reportExteriorPrices`; `firstmeasure/exteriors.ts` `exteriorQuote` uses them when the
  market is international (by the property address, as for roof reports), and the quote revision names the market.
  Full Exterior outside the US/Canada goes from €50 / €60 / €70 to €60 / €70 / €85; US/Canada is unchanged
  ($25 / $30 / $35). `measure/internal/portal_scripts/prices.js` edits the three entries. Tests: europe-pricing,
  property-market-pricing, regional-commerce.
- **FM-581** (editor): `editor_scripts/exterior_report_model.js` no longer turns wall pieces narrower than 0.5 mm on
  average into report walls or unassigned faces, unless an opening sits on one. sha256 `12c2efef…` → `67afd23a…`.
  Test: `dev/exterior-report.test.cjs`. No data repair: saved walls are unchanged; the next report build drops them.
- **FM-576** (browser + Node read): `libraries/apps/settings/company.js` uses the shared phone input for Company phone
  (calling code from the organization's country, its national format); `libraries/phone-input/phone-input.js` gains
  `setValue()`; `GET /v1/platform/organizations/:id/portal-state` also returns `country` (read only). Tests:
  company-phone-browser, platform-organization-boundary.
- **FM-574** (browser + Node): `measurements/project.js` and `roof-viewer.js` show metric reports in m / m²;
  `platform-widgets/project-widgets.js` passes the measurement system (`roof-viewer.js?v=20261118-fm574-metric`); the
  apps manifest's `?v=` keys; the `report` widget source in `platform/widgets/catalog.ts` adds `measurementSystem` and
  `pitchNotation`; one new measurements language key (15 packs, catalog `measurements.7c9ed5f27c785c31.json`, catalog
  `manifest.json` measurements line only). Tests: measurements-roof-viewer-metric-browser, widget-report-units,
  report-summary-measurements-browser.
- No database, data, environment, dependency, flag, nginx or config-library change. The config library snapshot is
  production-live's, unchanged.

## Checks before release

- At 21:00 UTC `current` was `633e5c23` on all 8 hosts, readiness `633e5c23` 10/10, web root disks 31 % used, no
  watch or gate processes left over. Rollback target `633e5c23046558faf34c20b5f903f590633f3d9d` was commented on all
  four issues before anything was built or activated, and the agent channel lock was posted.
- Built `8dd524f7` on the dev worker (299 s, `npm run check` clean). Archive sha256
  `3a56c06541f7a7d31427d65db12eb794e7768b3477cba3820ab20347c55411a8`. The extracted tree differs from `633e5c23`'s
  only in the plans' files, their compiled `dist/` files, `release.env` and FM-457's record.
- `release-node-fingerprint.py compare` exit 3: full procedure (server code, 45 Node-side files).
- `web_activate.py` = FM-457's with one sed pass. Repinned by digest map: the apps manifest, `measurements/project.js`
  (×2), `roof-viewer.js`, `settings/company.js`, catalog `manifest.json`, `project-widgets.js`,
  `exterior_report_model.js`; needles: the manifest's roof-viewer / measurements project / project-widgets keys
  (`20261113-fm455-line-totals`, `20261118-fm532-summary-reason` → `20261118-fm574-metric`, ×3), the project-widgets
  roof-viewer `?v=`, and the FM-410 catalog manifest name check (the old measurements catalog file stays and keeps its
  pin). Added this release's block: FM-593 `reportExteriorPrices`/`reportMarketRevision` in dist and the Prices page
  fields; FM-581 `exterior_report_model.js` sha and sliver rule; FM-576 served `phone-input.js` (`setValue`) and
  `company.js` (`attachCompanyPhone`, `?v=20261118-fm-576`), portal-state `country` in dist; FM-574 served
  `roof-viewer.js` (`viewerUnits`), `project-widgets.js` version, measurements catalog name + sha, report widget units
  in dist. 118/118 file asserts pass on the archive and fail on `633e5c23`'s (control). Rollback asserts 107/107 on
  `633e5c23`'s archive.
- Plan tests: FM-581 `dev/exterior-report.test.cjs` 10/10 on the release tree. FM-593/576/574 compiled tests from the
  archive (`dist/tests`): 22/23, the one failure reading a browser file by a source-tree path the dist run lacks;
  `633e5c23`'s archive fails the FM-593 operator-prices test (control).
- FM-593 quote probe (read-only, in process on the worker, no route, no order): `633e5c23` FR `[50,60,70]`, US
  `[25,30,35]`; installed-inactive `8dd524f7` FR `[60,70,85]`, US `[25,30,35]`.
- FM-581 harness on production's served editor scripts before the release: `12c2efef…`, 67 walls, "6 of 67 wall faces
  have no material assigned" (control).

## Rollout (scripts: fm-agents /srv/agents/work/prod-batch-fm593-prodrun-scripts)

- Compatibility and the worker installed at 21:12 UTC.
- Worker activated at 21:13:40 UTC, with no running jobs. Channel published against `633e5c23`'s archive
  (`342e8b2d…`).
- Web nodes one at a time, 21:14:59-21:28:45 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through the gate. It waited 3 h 48 min (472-1369 legacy-action/min, 21:29-01:17 UTC Wednesday into
  Thursday; the first 180-minute gate timed out at 00:35 and was restarted) and opened at 01:17:08 (349/min). Rolling
  replace at 01:17:09, with 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `8dd524f7` on all 8 hosts, and readiness reports `8dd524f7` 10/10 (HTTP 200). Compat's HTTP workers run
  `RELEASE_ID=8dd524f7…`.
- Served through the load balancer, 12/12 requests each: `phone-input.js` with `setValue`, `settings/company.js` with
  `attachCompanyPhone`, `roof-viewer.js` with `viewerUnits`, `project-widgets.js` with
  `roof-viewer.js?v=20261118-fm574-metric`; the catalog manifest names `measurements.7c9ed5f27c785c31.json`, served with
  the release's sha. After compat: `measure/internal/portal_scripts/prices.js` has `intl_exteriors_base`.
- FM-593: the live quote probe gives FR `[60,70,85]`, US `[25,30,35]`. No `exchange_rate_unavailable` or
  `pricing_changed` line on any web node since 21:15 (0 in the 20 min before as well).
- FM-581: the plan's harness on production's served editor scripts gives `67afd23a…`, 61 walls, no warning (before:
  67 walls, "6 of 67 wall faces have no material assigned"). The harness's copies of customer geometry were deleted.
- FM-576: production's `/portal/login.php` signup, headless, still shows the calling-code picker (`US +1`, 21 codes,
  placeholder `(201) 555-0123`) with no page errors. The signed-in portal-state `country` was not called (no production
  session); its code is asserted in `dist/platform/api.js` on every host.
- FM-574: the served files above. The reporter's metric report was not opened (no production session); a person
  confirms it.
- 5xx (excluding health probes):
  - web nodes after their own activation (from 21:15): 0.04-0.10 % against 0.03-0.07 % in the 30 minutes before; after
    compat (from 01:18:30): 0.06-0.09 % (7-11 of ~12.5k each) against 0.02-0.05 %. Nearly all are the pre-existing
    `top_view_reroll_proxy.php` 500s, plus single acquisition-track and legacy-action requests;
  - compatibility after activation: 0.81 % (50 of 6,145), all `top_view_reroll_proxy.php`, against 0.65 % before.
- Compatibility, 01:18-01:35 (2-minute polls): 0 watchdog kills, 0 OOM kills, 0 Node 500s, 0 pool timeouts, one
  MainPID, 2.2-2.6 GB available, 347-425 legacy-action/min.
- Worker, 21:13:40-01:35: 2,566 jobs completed, 1 failed: a `report.delivery` at 22:59, "The customer report email
  failed to send", which also happened on 11/16 at 11:00 and 22:00 on older releases (no plan touches email; 384
  deliveries succeeded). No "Worker stopping", browser-closed or pool-timeout errors. The queued jobs are scheduled
  `report.release` jobs, none due.
- No request was placed as a test, and no production data was changed. A person confirms each fix on production.

## Rollback

`/srv/agents/work/prod-batch-fm593-prodrun-scripts/rollback/`:
- `release.sh worker`;
- `publish`, which republishes `633e5c23`'s archive (PREVSHA `3a56c065…` = this release's archive);
- `web_rollout.sh`, with FM-457's asserts and base `8dd524f7` (107/107 pass on `633e5c23`'s archive);
- `release.sh compat`, through the gate.

Nothing is migrated, so rolling back only switches the files. (Expected from the code, not tested: a Full Exterior
quote this release made for a property outside the US/Canada carries a market part in its revision, so after a
rollback an order on it would be refused as "prices changed" and re-quoted. US/Canada quotes are unaffected.)
