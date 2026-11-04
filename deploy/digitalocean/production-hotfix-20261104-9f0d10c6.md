# Production release 9f0d10c6: typing in Company settings is no longer wiped by autosave (FM-324), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-324 ("Saving bug", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `b54ffd3b` (release `321285e2`) plus one commit, `9f0d10c6` on `claude/fm-324-prodrun`: a clean cherry-pick of the plan's `b7005905` (`claude/fm-324-saving-bug-prod`, itself canonical `11e5801e`, on dev as `platform-20261104002231-bde212b8`). The plan was built on `06c06a85`; FM-323 (`321285e2`) landed in between, so the commit was moved onto current production-live. Both released library files are byte-identical to dev's release `bde212b8` and to what dev.1m8.ai serves (`company.js` sha256 `08de6e07…`).

## Change

- **Company settings autosave** (FM-324). Settings autosave clicks the company Save about 350 ms after each pause in typing; when that multi-request save finished, the Save handler wrote the saved (trimmed, already out of date) values back into the fields, deleting anything typed meanwhile. `public/libraries/apps/settings/company.js`: Save no longer writes saved values back, saves run one at a time (a click during a save runs once more afterwards), and `renderCompany` never overwrites the focused text field.
- `public/libraries/settings-pages/firstmate-settings-pages.js`: an edit typed within the 250 ms guard after an autosave click is saved when the guard ends instead of dropped.
- New regression test `public/v1/tests/company-settings-autosave-typing-browser.test.mjs`.
- Browser files only. No Node, PHP, database, config-library or data change, no migration. `portal/index.php` versions these files by content, so no `?v=` bump.

## Checks before release

- Plan (on `b7005905`): the new test, `company-settings-organization-name` and `settings-autosave-optout` 5/5; both files parse. Dev: Settings › Company with the organization PATCH slowed by 1.2 s kept every character typed in bursts, and the server kept the full name.
- Build on the dev worker in 276 s: archive sha256 `b7a7625c14f6e48bcad73128814d015ba0bd671b87bc69d6e9f9158034640309`, verified there and on compatibility and the worker.

## Rollout

- Rollback target recorded on FM-324 before activation: `321285e27d3761233ceacd6f802e1d45b25d79b7` (all eight hosts' `current` and public readiness 10/10, checked ~01:02 UTC).
- Compatibility at 01:06:34 UTC from `321285e2`: active on `9f0d10c6`, no 500s and no worker exits in the first 20 s.
- Worker at 01:07:12 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `2ac3bbec…` (321285e2's archive); a web node downloads `9f0d10c6` / `b7a7625c`.
- Six web nodes one at a time behind the load balancer, 01:08:09–01:20:50 UTC, each withdrawn, activated (~94 s), asset-checked (`core.js`, color picker, `company.js`, `firstmate-settings-pages.js` served = `current`) and back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `9f0d10c6` (`ok`) on 12 of 12 requests, from all six web instances; all eight hosts point `current` at `9f0d10c6`.
- `https://app.1m8.ai/libraries/apps/settings/company.js` contains `FM-324` 3 times and `firstmate-settings-pages.js` once, 6 of 6 requests.
- Errors: NGINX 5xx on each web node since its activation 0.03–0.08 % (30 min before: 0.15–0.46 %), all `top_view_reroll_proxy.php`; compatibility 0.65 % since 01:06:40 vs 0.77 % before, the same proxy route. Worker: no error-level log lines since activation.
- Jobs since worker activation: 178 completed (PDF sync, report delivery and release, imagery), none failed, none stuck running; queued `report.release` jobs are scheduled ones, none due (360 were queued before activation).
- Not done: the plan's signed-in typing test in production Settings › Company. There is no production login here, and renaming a customer organization (even back) is a production data change. The confirmation is the reporter typing a company name in bursts and seeing nothing deleted.

## Rollback

Every role keeps `321285e2`. Republish its archive (`2ac3bbec…`) to the channel from `/opt/firstmeasure/releases/321285e2…/deploy/digitalocean/`, then `activate-release.sh 321285e2… <service>` on each role. Code only: this release writes no data.
