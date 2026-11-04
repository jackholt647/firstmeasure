# Production release 6802e716: flag introductions shown once to each person (FM-327), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-327 ("Per-user feature announcements", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `6519e88c` (release `d3de6f35`) plus two commits on `claude/fm-327-release`:

- `ab020aef`: cherry-pick of canonical `54cf3bf9`, unchanged, on dev as `platform-20261104162619-e9b5e8ea`.
- `6802e716`: cherry-pick of the editor lane's `53f925fe` (`public/measure/internal/portal_scripts/flag_console.js`), unchanged, on dev as `measure-internal-20261104162741-edfbc163`.

The plan's branch `claude/fm-327-fix-prod` was cut from `7b3bd536`, before FM-326 landed; the same two commits were cherry-picked onto the newer production-live, and the diff is byte-identical to the plan's.

## Change

- **A flag's introduction is shown once to each person, not once per organization** (FM-327). The config library entry `guided_experience/exteriors.introduction` is `scope: "person"` (snapshot revision 2, exported from dev), so its progress is kept per person: everyone in an organization where Exteriors was introduced who may order reports sees the announcement once, the first time they load the app. Before, its progress was one organization-wide row, and the first person to close it closed it for everyone.
- `guided-experiences/contracts.ts`: an experience that `introduces` a flag must have scope `person`.
- `guided-experiences/store.ts` `countFinishedPeople` (read only) and `platform/flag-console.ts`: the per-organization flag view reports `introduced_people`.
- Editor flag console copy (`flag_console.js`): "Each person there sees its announcement once, the first time they load the app".
- Docs (`feature-flags.md` "Introducing a flag", `guided-experiences.md`) and `tests/flag-introductions.test.ts`.
- No database schema change, migration, dependency or environment change. No production data changed.

## Checks before release

- Diff against production-live: the plan's 8 files only, identical to the plan branch's diff.
- Build on the dev worker in 249 s (npm ci, type check, build, prune): archive sha256 `ec9c4329ca4aa022fa5a06db0d53e14d8e138d22eeb873d6bd1f2b2e31c451c0`, verified there, on compatibility and on the worker. The stage's snapshot entry has `"scope": "person"`, `dist/guided-experiences/contracts.js` has the person-scope rule, `flag_console.js` has the new copy, and FM-326's `Math.ceil(rawPoints)` is still there.

## Rollout

- Rollback target recorded on FM-327 before activation: `d3de6f355e7d25d3e7320468590576645740a3c3` (all eight hosts' `current`, public readiness 3 of 3, ~16:46 UTC).
- Compatibility at 16:53:38 UTC from `d3de6f35`: active on `6802e716`, no 500s and no worker exits in the first 20 s. Its ~10 s restart answered 503/502 to four editor/login requests (16:53:38–47), as FM-326's did; none since. `https://app.1m8.ai/measure/internal/portal_scripts/flag_console.js` serves the new copy.
- Worker at 16:54:32 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `01bf3e13…` (d3de6f35's archive); all six web nodes downloaded `6802e716` / `ec9c4329` from it.
- Six web nodes one at a time behind the load balancer, 16:55:36–17:08:57 UTC, each withdrawn, activated (94–96 s), asset-checked (`core.js`, color picker, `roof-viewer.js` served = `current`; the snapshot entry is `person`, built `contracts.js` has the person-scope rule, FM-326's `full_house_points.js` fix still there) and back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `6802e716` (`ok`, `ready`) on 12 of 12 requests; all eight hosts point `current` at `6802e716`, and on each the active snapshot's `exteriors.introduction` has `scope: "person"` and the built `contracts.js` has the person-scope rule.
- `https://app.1m8.ai/measure/internal/portal_scripts/flag_console.js` contains "Each person there sees its announcement once".
- Errors: NGINX 5xx on each web node since its activation 0.04–0.10 % (30 min before: 0.13–0.21 %), all `top_view_reroll_proxy.php`; compatibility 0.82 % since 16:53:50 vs 0.75 % before, all but one the same proxy route (it was failing at hundreds per hour all day, before this release) and one editor.php 503 at 16:55:55, as before at a few per hour. Web error-level log lines since activation are the same kinds as before (stream "premature close", client aborts), plus ECONNREFUSED to compatibility only during its restart (16:53:39–49). Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation (16:54:32): 257 completed (imagery, PDF sync, report delivery and release), none failed, 1 running; queued jobs are 251 scheduled `report.release`, none due.
- Not done: seeing the announcement as two people in one production organization. That was verified on dev (FM-327's comment); the confirmation here is the next person in an introduced organization seeing it after a teammate closed it.

## Production data note (no repair made)

One organization had already closed the Exteriors announcement as an organization-wide row before this release. The per-person progress ignores that row: if its introduction is still requested, each person there who may order reports sees the announcement once, including the one person who closed it before. That is the intended fix; nothing was written by hand.

## Rollback

Every role keeps `d3de6f35`. Republish its archive (`01bf3e13…`) to the channel from `/opt/firstmeasure/releases/d3de6f35…/deploy/digitalocean/`, then `activate-release.sh d3de6f35… <service>` on each role. Code only: this release writes no data. Per-person progress rows written on it stay in `guided_progress` and are ignored by the old organization-scoped entry after a rollback.
