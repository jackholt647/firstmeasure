# Production release 825b5601: map imagery downloads log why they failed (FM-339), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. It is production-live `740737db` (release
`afc66701`, FM-338) plus one commit on `claude/fm-339-missing-static-maps-prod`: `825b5601`, the canonical fix
`78571fa0` cherry-picked unchanged (the `+`/`-` lines of both patches are identical).

Verified on dev in `platform-20261105201439-b78c25d0`: on the dev worker, the deployed `fetchBinary` called with dev's
real key logged Google's 403 "This API is not activated on your API project" with no key in the line.

## Why

Since 2026-08-17 Google has refused every Maps Static request made with the shared server key (403 "This API is not
activated on your API project"), so the server has saved no `google.png` for any order since then (about 80 % of
orders have none; the rest got one from the editor's Google layer button). `fetchBinary` dropped the refusal without a
log line, so nobody saw it. This release makes the refusal visible; it does not bring `google.png` back. That needs the
Maps Static API enabled on the key's Google Cloud project (Jack, Cloud console), with no deploy.

## Change

- `public/v1/firstmeasure/processing.ts`: `fetchBinary` takes a label and, for a non-2xx answer, logs
  `FirstMeasure imagery: <file> for <order id> failed <status> <provider message>` (message cut to 300 characters,
  `key=` values masked, URL never logged). Callers label rgb.tif, mask.tif, google.png (Maps Static), azure.png (Azure
  Maps) and the structure supplemental tifs. Which files are saved or skipped, FM-338's transient retry and job
  outcomes are unchanged.
- Test: `tests/imagery-transient-retry.test.ts` covers a 403 refusal.
- Node only, used by the worker. No schema, environment, configuration, provider key, PHP/editor asset, dependency or
  data change.

## Checks before release

- On the release commit (plan run): `tsc --noEmit` clean; `imagery-transient-retry` + `structure-pins-imagery` 7/7.
- Build on the dev worker (`npm run check` included), 254 s. Archive sha256
  `a9496bbc842efbf7c2a560a1ff92f69ff9df9053fbd3fcc369a5607897ef0e86`, verified on fm-agents, compatibility, the worker
  and each web node; `dist/firstmeasure/processing.js` has `providerRefusalReason` and `FirstMeasure imagery: `.

## Rollout (scripts: fm-agents /srv/agents/work/fm-339-prodrun-scripts)

- Rollback target before activation: `afc6670153bd13eb9a550930804f20b2863090df`, every host's `current` at 20:19 UTC;
  recorded on FM-339.
- Worker at 20:26:44 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `6673871a…` (afc66701's archive); all six web nodes downloaded
  `825b5601` / `a9496bbc` from it.
- Six web nodes one at a time behind the load balancer, 20:27:51–20:41:46 UTC (about 2.3 min each), each asset-checked
  as in afc66701's run plus the FM-339 strings in `dist`.
- Compatibility last, at 21:03:25 UTC, with `legacy-action` at 404/min and load 5.9 (waited from 20:42 for a minute
  under ~420/min; it ran 400–545/min with load 3–14 meanwhile). No Node 500s and no worker exits in the first 20 s.
  The restart gave 30–38 5xx per web node during 21:03 (FM-338's restart: about 150).

## After activation

- All eight hosts point `current` at `825b5601` with the expected service active. Public readiness answered
  `825b5601`, `ready`, on 32 of 32 requests across all six instances.
- Worker, 20:26:44–21:05: 443 jobs completed, among them **74 `imagery.process`**, 282 `pdf.sync`, 57
  `report.delivery`, 31 `report.release`; 0 failed jobs, 0 `firstmeasure_order_imagery_failed`, 0
  `imagery_provider_busy`, no level-50 errors. 234 `report.release` queued, none due (scheduled holds).
- The new log line: 74 lines, one per order, all `google.png (Maps Static) … failed 403 The Google Maps Platform server
  rejected your request. This API is not activated on your API project…`. No line has an unmasked `key=` and no
  `AIza` appears anywhere in the worker log since activation. No other imagery file was refused.
- Web nodes from 20:42: 1–3 5xx a minute outside the compatibility restart minute, the same as the 30 minutes before
  (0.04–0.08 %); mostly `top_view_reroll_proxy.php` (failing before this release), `legacy-action` and `/v1/internal/me`.
- Compatibility, 21:03:25–21:29 (26 min): cluster watchdog **1 kill** (21:13:29, slot 1, under the usual
  `legacy-action` / `tutorial-exteriors` / `internal/users` load), against one at 20:28 on afc66701 and one every
  10–20 min earlier this afternoon; no chain. 0 Node 500s after the restart; load fell from 10–14 to 1.4–6.7;
  `legacy-action` 360–540/min. This release's code does not run there (no jobs, 0 imagery lines).
- Second pass at 21:29: readiness `825b5601` on 32 of 32; worker since 20:26:44 completed 734 jobs (122
  `imagery.process`, 476 `pdf.sync`, 86 `report.delivery`, 51 `report.release`), 0 failed; 122 Maps Static 403 lines
  (one per order), 0 unmasked keys, 0 `firstmeasure_order_imagery_failed`, 0 level-50.

## Not in this release

- Enabling the Maps Static API on the key's Google Cloud project (Jack's change; it restores `google.png` for new
  orders on dev and production and the FM-292 project cover image, with no deploy).
- Backfilling `google.png` for orders since 2026-08-17 (a production data job; needs a person's OK and its own run).

## Rollback

`afc6670153bd13eb9a550930804f20b2863090df` is still installed on every host: activate it on the web nodes one at a
time, the worker and compatibility with `activate-release.sh` (`fm-339-prodrun-scripts/rollback/`), and republish the
channel with afc66701's archive against `a9496bbc…`. Code only; this release writes no data.
