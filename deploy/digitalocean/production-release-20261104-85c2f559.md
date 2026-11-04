# Production release 85c2f559: staff dashboard shows every technician in progress (FM-333), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-333 ("Internal dashboard view not accurate", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `18f1a663` (release `f7819345`) plus one commit on `claude/fm-333-prod-release`:

- `85c2f559`: clean cherry-pick of canonical `b537101e`, on dev as `platform-20261104200909-d69c4292`. Its diff is line for line the plan's `0a6d3c57` (which was based on the older production-live `ae0b01cc`; FM-332 landed between plan and run).

## Change

- **Compat queue overview** (`public/v1/firstmeasure/api.ts`): `buildQueueOverviewCompat`'s `in_progress` bucket reads the queue's own `in_progress` group through `queryIndexedQueueBucket`, not the statuses `processing`/`in_progress`; `readQueueCompatRows` takes an optional `queueGroup`. The staff dashboard (shifts.js) builds each technician's active project from that bucket. A project a technician has claimed stays status `ready` until it is opened, so before this most technicians showed "No active project".
- New test `public/v1/tests/firstmeasure-queue-overview-in-progress.test.ts`.
- Node only: no PHP, editor, browser, database, migration, dependency, environment or config library change. No production data changed. The PHP callers of this endpoint ask for qa/pending_rejection/completed_today only.

## Checks before release

- Type check and the new test pass on `85c2f559`.
- Build on the dev worker in 301 s (npm ci, type check, build, prune): archive sha256 `f82eb721d9bcde3691d29d8249662ea06b39b7365a747bef272311282e6c8817`, verified there, on compatibility and on the worker; built `dist/firstmeasure/api.js` has `queueGroup: "in_progress"`.
- Baseline, read-only on the production database at 20:41 UTC: the queue's In Progress group held 46 projects across 46 technicians (42 `ready`, 4 `in_progress`); the old overview filter (status `processing`/`in_progress`) matched 4.

## Rollout

- Rollback target recorded on FM-333 before activation: `f781934544558a3ca6dbdf3c136f051bc8fb1499`. At 20:32 UTC it was every host's `current` (eight hosts) and what public readiness reported.
- Compatibility at 20:42:48 UTC from `f7819345`: active on `85c2f559`, with no 500s and no worker exits in the first 20 s.
- Worker at 20:43:40 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `bf9fd64c…` (f7819345's archive). All six web nodes downloaded `85c2f559` / `f82eb721` from it.
- Six web nodes one at a time behind the load balancer, 20:44:41–20:57:45 UTC. Each was withdrawn, activated (94–96 s) and checked: served browser assets match `current` and carry the earlier releases' markers, and the build has FM-333's `queueGroup: "in_progress"`. Each node was back behind the load balancer on the new release before the next started.

## After activation

- Public readiness answered `85c2f559` (`ok`) on 12 of 12 requests; all eight hosts point `current` at `85c2f559` and their built `api.js` carries the fix.
- The fix's read, run in-process on the worker against the new build (`queryIndexedQueueBucket({ group: "in_progress" })`, read-only): 43 rows across 43 technicians, equal to the queue's In Progress count of 43 at that moment. Before the release the dashboard's bucket would have held 4.
- Not done: the plan's signed call to `POST /v1/firstmeasure/queue/admin/overview/compat` as PHP's `system` caller. That route is staff-only (`route-access.ts`: `{ staff: "any" }`) and answers 401 to the system signature, and the run does not sign as a staff member. Also not done: opening Staff dashboard › Technician as a signed-in person (there is no production login on fm-agents-1). The confirmation is a person doing it.
- Errors: NGINX 5xx on each web node since it returned is 0.03–0.08 % (30 min before: 0.07–0.15 %), almost all `top_view_reroll_proxy.php` (failing before this release). Compatibility since 20:43: 0.71 % vs 0.77 % before, the same proxy route. Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation (20:43:40): 268 completed (imagery, PDF sync, report delivery and release), none failed, 1 running. Queued jobs are 358 scheduled `report.release`, none due.

## Rollback

Every role keeps `f7819345`. To roll back, republish its archive (`bf9fd64c…`) to the channel from `/opt/firstmeasure/releases/f7819345…/deploy/digitalocean/`, then run `activate-release.sh f7819345… <service>` on each role. Code only: this release writes no data.
