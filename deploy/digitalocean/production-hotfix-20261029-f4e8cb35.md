# Production hotfix f4e8cb35: summary card labels never run into their values (FM-305 / 1M8-256), and roof pitch in degrees (FM-304 / 1M8-255), October 29, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-305 set to Testing in prod, verified on dev). FM-305's production plan releases FM-304's commits in the same release, so `ef3f183f` is not released on its own. Run from fm-agents-1, right after FM-311's `bbf23641`.

It is production-live `1c867244` (code `bbf23641`, which contains FM-302 `784b7bd0` and FM-300 `9af332be`) plus four commits:
- `bf0e8339` Roof pitch in degrees for roofers outside the US; summary card labels never overlap (1M8-255, 1M8-256). Cherry-pick of `c9cd1c4e`.
- `ab90dc2c` Manifest `?v=` keys for the scripts the pitch notation changed (1M8-255). Cherry-pick of `ef3f183f`'s key bump.
- `c8acd3c4` FM-305: summary card labels wrap between words and are never cut off (`pdf.js` `drawPdfStatRow` only).
- `f4e8cb35` FM-305: regression test `dev/summary-card-labels.test.cjs` (a test only; nothing served).

Branch `claude/fm-305-project-summary-page-text-overlapping-prod-release` (the plan's `claude/fm-305-project-summary-page-text-overlapping-prod`, `474a26a5` on `3e902d1d`, rebased onto the newer production-live so this release keeps FM-302, FM-300 and FM-311). The diff from `1c867244` is the plan's diff line for line except the one conflict the plan named: FM-300 and FM-304 both bumped the `settings/company.js` key, resolved as `20261029-company-name-pitch-degrees`. `exterior_pdf.js` is untouched.

## Cause

FM-305: the PDF summary page's totals card is 40 mm wide, with each value right-aligned and the label given no width limit, so "Headwall Flashing" and "Sidewall Flashing" ran into "32.66 m" and "35.22 m". The first fix (in `c9cd1c4e`) shrank and wrapped labels, but it broke words in the middle and could drop the third line of a long translated label (nl "Trapsgewijze aansluiting schoorsteen").

FM-304: roofers outside the US show pitch in degrees, not rise over 12.

## Fix

- `pdf.js` `drawPdfStatRow`: a label shrinks to 6 pt, trying one line and then two lines broken between words. It breaks inside a word only when that word alone is wider than the label at 6 pt, and goes below 6 pt only while it would otherwise need a third line. Nothing is cut off. The card's line-type names are translated. English labels are unchanged from `c9cd1c4e`.
- FM-304: Settings › Company › Roof pitch is rise over 12 or degrees; metric companies default to degrees (Jack approved existing metric orders switching too). The order's preference covers the report PDF pitch spots, the portal summary and CSV (a degrees row), XML (`pitch_degrees`), and the 3D and instant-estimate viewers. Localization packs, `platform/localization/settings.ts`, `report-units.js`, the measurements and projects viewers, and manifest keys.
- `pdf.js` is used by the editor (its `?v=` is the file's sha256, so it updates by itself) and by the server PDF runtime.

## Checks

- **Dev:** FM-305 live and verified in `measure-internal-20261029202113-458b456f`; FM-304's editor half is on the measure-internal lane. FM-304's platform half is not on dev canonical (see FM-304); it was built and tested on the dev worker as `ef3f183f`.
- **Release commit (`f4e8cb35`), on fm-agents-1:** `pitch-notation` + `report-localization` 6 of 6, `report-summary-measurements-browser` 4 of 4, `dev/summary-card-labels` 2 of 2.
- **Pre-existing:** `dev/report-localization`'s "Company saves preferences only with customization enabled…" fails on production-live `1c867244` too (FM-300 added the module variable `organizationNameOnServer`, which the test's sandbox for `saveOrg` lacks). On `1c867244` that file fails 4 tests; with this release it fails only that one.

**Build:** on the dev worker (`build.sh`: npm ci, check, build, prune), archive `6e606ae2…`, verified, its sha256 rechecked on compatibility and the worker after copying; its `pdf.js` and manifest match the commit.

## Not changed

No migration, configuration, environment or data change. PDFs already generated keep their layout until they are regenerated.

## Rollout

- Compatibility at 21:49:04Z, from `bbf23641`, with 0 Node 500s and 0 crashes in the next 20 s.
- Worker at 21:49:54Z after no running jobs; 8 slots, production, email on, heartbeat off.
- Signed channel, published against `bb0e16b9…`. New nodes boot from it.
- Six web nodes, 21:51 to 22:01 UTC, one at a time, each drained from the load balancer, ready, with matching assets.

Public readiness returned `f4e8cb35` 20 out of 20 times. Production serves `pdf.js` (editor and `/v1/firstmeasure/pdf-runtime/assets/pdf`), `xml_generator.js`, `settings/company.js`, the manifest (`settings/company.js` key `20261029-company-name-pitch-degrees`) and the other changed browser files byte-identical to the commit.

After activation: every host's 5xx rate is at or below its rate in the half hour before (compatibility 0.85 % vs 0.82 %, web nodes 0.00 to 0.17 % vs 0.12 to 0.16 %), almost all the existing `top_view_reroll_proxy.php` 500s; no HTTP worker exits. The worker completed 274 jobs with 0 failed in its first ~13 minutes. A summary PDF for a real production project was not generated: this run has no production session and touched no production data.

## Rollback

Every role keeps `bbf23641`. Republish it (`bb0e16b9…`) to the channel before rolling back a web node. Code only; no data repair needed.
