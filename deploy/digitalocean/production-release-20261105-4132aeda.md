# Production release 4132aeda: Resources tab videos seek and buffer, November 5, 2026

Released from Jack's PC through fm-agents-1 on Jack's go ("Fix that and push it too", relayed by the session that
started this one), after dev verification. It is production-live `7b1fb765` (release `3e102a37`) plus four commits on
`claude/hotfix-video-seek-20261104`:

- `42ca4583`, `9640be42`: project artifacts answer byte ranges and carry video types (canonical `25d16ece`,
  `6748b3aa`; on dev as `platform-20261104232336-bf4025a7` and `platform-20261104232730-d3398430`).
- `05195414`, `4132aeda`: the Resources player downloads the whole video (measure-internal lane, on dev as
  `measure-internal-20261104233820-aca5083c` and `measure-internal-20261105000016-a7984804`). Production's
  `project_resources.js` equalled the lane's before, so no dev-only lane work comes along.

## Cause

Jack: the Resources tab video only loaded a few seconds at a time, a drag snapped back until it had all loaded, and
a seek while paused jumped to 0:00. Customer walkthroughs are served by
`GET /v1/firstmeasure/projects/:id/artifacts/:name`, which sent every file whole with `200`, no `Accept-Ranges`, as
`application/octet-stream`. Chrome cannot seek such a response past what it has buffered. Browser-recorded
walkthroughs (fragmented MP4/WebM) were worse: without ranges Chrome cannot read their fragment index, so it reported
a 2.3 s duration and `seekable` `[0,0]` for an 85 s production walkthrough. Tech uploads through
`project_resources.php` already honoured `Range`. Separately, Chrome buffers a paused video only a few seconds ahead,
so nothing loaded until Play.

## Change

- **Ranges** (`firstmeasure/api.ts`, `firstmeasure/storage.ts`, `src/storage/project_artifacts.ts`): a single
  `Range` gets `206` with only those bytes (a ranged Spaces `GetObject`, or a positioned read on disk), `416`
  outside the file, and `If-Range` that no longer matches gets the whole body. Every artifact response carries
  `Accept-Ranges: bytes`. Same route and access declaration as before.
- **Video types**: `.mp4`, `.webm`, `.mov` are served as `video/*` and inline (request-security's safe list; video
  cannot run script).
- **Whole download** (`editor_scripts/project_resources.js`): when a video opens, the editor fetches the whole file
  (skipping the HTTP cache, whose lock otherwise held it behind the player's range requests) and switches the
  player to that copy where it stands, keeping time, play state and speed. Until then it streams and seeks by
  ranges; over 1 GB, or if the download fails, it keeps streaming.
- No PHP, database, migration, dependency, environment or config change. No production data changed.

## Checks before release

- Type check clean; `tests/exteriors-order.test.ts` (new range, suffix, 416, If-Range and type checks) passes on
  `4132aeda`'s server code. `tests/route-access.test.ts` fails one assertion (project list filtering, line 132)
  identically without this change.
- Build on the dev worker in 290 s: archive sha256 `a539ddc636b07a661224ea43e4a330a3a01288c821fa529cec8640cd6c5dfcf3`.
- Dev, real Chrome driving the editor's Resources tab on the pilot house (writes and localStorage writes blocked),
  network throttled to 2–4 MB/s, with a 52 MB faststart MP4 and a 47 MB browser-recorded fragmented MP4: drags
  forward and back while playing and while paused land on target before the file is loaded; the whole video is
  buffered while paused before Play; the switch to the downloaded copy mid-playback keeps position and playback.

## Rollout

- Tracker router `tracker-router@bugs` was already stopped (by the 3e102a37 release, 23:13:57 UTC).
- Rollback target before activation: `3e102a375dfc6fafe60b5bd9c2af1b90d2cbd62b`, every host's `current`.
- Compatibility at 00:43:26 UTC: active, no 500s and no worker exits in the first 20 s.
- Worker at 00:44:25 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility (from the release directory) against `67b90cde…` (3e102a37's
  archive). All six web nodes downloaded `4132aeda` / `a539ddc6` from it.
- Six web nodes one at a time behind the load balancer, 00:45:28–00:59:17 UTC (94–102 s each), each asset-checked as
  in 3e102a37's run plus the built `sendArtifactRange`/`getProjectArtifactRange` and the editor's
  `downloadWholeMedia` with `cache:'no-store'`.

## After activation

- Public readiness answered `4132aeda` on 12 of 12 requests; all eight hosts point `current` at it.
- In Jack's Chrome on app.1m8.ai, read-only, on two production walkthroughs: `Range: bytes=1000-2000` returns `206`,
  1,001 bytes, `video/mp4` / `video/webm`, `Accept-Ranges: bytes` (before: `200`, the whole 50 MB / 79 MB,
  `application/octet-stream`). A streaming `<video>` on the 85 s MP4 now reports duration 85.2 s and `seekable`
  `[0,85.2]` (before: 2.3 s, `[0,0]`, seeks back to 0); paused seeks to 59.6 s and 25.6 s land exactly, and seeks
  while playing land and keep playing. The whole customer file was not downloaded.
- Production's `project_resources.js` is byte-identical to the dev lane's. Served from app.1m8.ai into the dev
  editor on the pilot house, it passes every check above (whole video buffered while paused in 3 s once fetched;
  switch while playing 46.96 s → 50.16 s, still playing; all scrubs).
- Errors since 00:59:17: web nodes 0–0.07 % 5xx, only `top_view_reroll_proxy.php` (failing before this release);
  every video artifact request answered `206`. Compatibility: 2 5xx in 25,021 responses since activation.
- Jobs since worker activation: 160 completed; 369 `report.release` queued, none due.
- Not done: the Resources tab opened on a production project (no production staff login was used, and editing
  a customer project was avoided). The confirmation is Jack opening a walkthrough in Resources.

## Rollback

Every role keeps `3e102a37`. To roll back, republish its archive (`67b90cde…`) to the channel from
`/opt/firstmeasure/releases/3e102a37…/deploy/digitalocean/`, then run `activate-release.sh 3e102a37… <service>` on
each role. Code only: this release writes no data.
