# Production release 321285e2: elevations print the edge of a face seen edge-on (FM-323), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-323 ("Show edge lines", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `06c06a85` (release `3e5a887e`) plus one commit, `321285e2` on `claude/fm-323-show-edge-lines-prod`: a clean cherry-pick of canonical `d13b9123` (lane commit `4443dfa2`, on dev as `measure-internal-20261104002108-288cdf45`). The released `exterior_pdf.js` is byte-identical to the file dev.1m8.ai serves (sha256 `a3f3127f…`).

## Change

- **Edge lines in elevations** (FM-323). The PDF elevation rasterizer (`exterior_pdf.js` `rasterScene`) skipped triangles with no projected area, so a face seen exactly edge-on (a roof overhang or soffit at 90° to the view, a flat roof, a roof plane seen from its gable end) drew no pixels, and where no wall stood behind it the roof line vanished. A triangle within `EDGE_ON` (~1°) of edge-on now also draws its sides as depth-tested one-pixel lines, under the same depth rules (including the roof-over-wall bias), so the edge pass prints them as normal outlines; hidden ones stay hidden. Line pixels are not counted as visible area, so which elevation lists a wall and where labels go are unchanged.
- Only `public/measure/internal/editor_scripts/exterior_pdf.js` and its test `dev/exterior-pdf-layout.test.cjs`. No Node, PHP, database, config-library or data change, no migration; `PDF_RENDER_RECIPE_VERSION` unchanged.

## Checks before release

- On `321285e2`: `node --check exterior_pdf.js`; `node --test dev/exterior-pdf-layout.test.cjs dev/sticker-divisions.test.cjs` 35/35 (includes "a face seen exactly edge-on still prints its edge line (FM-323)", which fails without the fix).
- Dev: mapped regression gate passed on the lane release; served scripts rendered a gable-end elevation in signed-in headless Chromium with the overhangs printed as dark edges.
- Build on the dev worker in 265 s: archive sha256 `2ac3bbec44d3b70d3d39282b04eb180148d24e5bd03267f562219dd8c97d7249`, verified there and on compatibility and the worker.

## Rollout

- Rollback target recorded on FM-323 before activation: `3e5a887e45a6486b5b4162d2da36917eb8064b66` (all eight hosts' `current` and public readiness, checked 00:25 UTC).
- Compatibility 00:38:05–00:38:27 UTC from `3e5a887e`: ready on `321285e2`, no 500s in the first 20 s.
- Worker at 00:38:54 UTC after no running jobs: 8 slots, production, heartbeat off.
- Signed channel published against `bcbdc677…` (3e5a887e's archive); a web node downloads `321285e2` / `2ac3bbec`.
- Six web nodes one at a time behind the load balancer, 00:39:55–00:56:45 UTC, each back behind the load balancer on the new release before the next. The first rollout run was stopped after node 2 began (its activation finished on the node and NGINX was restored, checked byte for byte), then the same script ran again; it skipped the two active nodes and did the other four.

## After activation

- Public readiness answered `321285e2` (`ok`) on 12 of 12 requests, from all six web instances; all eight hosts point `current` at `321285e2`.
- `https://app.1m8.ai/measure/internal/editor_scripts/exterior_pdf.js` served the fixed file 6 of 6 times (sha256 `a3f3127f…`, contains `EDGE_ON`), the same as dev and as `current` on the web nodes.
- Errors: NGINX 5xx on each web node since its activation 0.00–0.06 % (30 min before: 0.24–0.37 %), all `top_view_reroll_proxy.php`; compatibility 0.64 % since 00:38:27 vs 0.72 % before, the same proxy route as before. Node logs show only the existing "Reply was already sent" warning and one client "Premature close"; no new 500s. Worker: no error-level log lines since activation.
- Jobs since worker activation: 142 completed (PDF sync, report delivery and release, imagery), none failed, none stuck running; queued `report.release` jobs are scheduled ones, none due (375 were queued before activation).
- Not tried in the signed-in production editor (no staff login here): the confirmation is Ben opening the reported project's Full Exterior elevations and seeing the overhang edge line.

## Rollback

Every role keeps `3e5a887e`. Republish its archive (`bcbdc677…`) to the channel from `/opt/firstmeasure/releases/3e5a887e…/deploy/digitalocean/`, then `activate-release.sh 3e5a887e… <service>` on each role. Code only: this release writes no data.
