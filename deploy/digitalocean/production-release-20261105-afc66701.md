# Production release afc66701: order imagery retries transient failures (FM-338), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. It is production-live `d529fee7` (release
`2318a4cf`, FM-337) plus one commit on `claude/fm-338-map-processing-delays-prod`: `afc66701`, the canonical fix
`65c61184` cherry-picked unchanged (`git show` patches identical).

Verified on dev in `platform-20261105190832-a4af23bd`: a real Google run (`ready` with `rgb.tif`, `azure.png`, …) and a
run with every map download forced to 503 (retried, then the retryable `imagery_provider_busy`, never `ready` with
no map).

## Change

- `public/v1/firstmeasure/transient_failure.ts`: `isTransientProviderFailure` also treats pg-pool/connection failures
  (`timeout exceeded when trying to connect`, `Connection terminated…`), PostgreSQL connection-class codes, fetch
  transport errors (through `cause`) and AWS throttling/timeouts as transient, so the durable imagery job retries
  them (5 attempts, 15 s to 2 min backoff) instead of finishing `needs_attention` without a map.
- `public/v1/firstmeasure/processing.ts`: map downloads (RGB/mask GeoTIFF, Static Maps, Azure), geocode and building
  insights go through `fetchSolarWithRetry` (30 s timeout, 3 tries); building insights 5xx/429 is retryable; if every
  renderable download was only busy the job throws the retryable `imagery_provider_busy`.
- `public/v1/firstmeasure/api.ts`: `firstmeasure_order_imagery_failed` logs a key-redacted `message`.
- Tests: `tests/imagery-transient-retry.test.ts` (new), one fixture line in `tests/structure-pins-imagery.test.ts`.
- Node only, used by the worker. No schema, environment, configuration document, PHP/editor asset or data change;
  the config library snapshot is the one `2318a4cf` shipped.

## Checks before release

- On the release commit (plan run): `tsc --noEmit` clean; `imagery-transient-retry`, `transient-imagery`,
  `structure-pins-imagery` 9/9; `imagery-job.test.mjs` 2/2. Dev regression gates passed for `65c61184`.
- Build on the dev worker (`npm run check` included). Archive sha256
  `6673871a652635cabad928c05e7d08aeed18acc05a7131fca3f1e5f241232b6d`, verified on fm-agents, compatibility, the
  worker and each web node.

## Rollout (scripts: fm-agents /srv/agents/work/fm-338-prodrun-scripts)

- Rollback target before activation: `2318a4cfd71a8138c6f076d985cdbd7a3b3ed227`, every host's `current` at 19:25;
  recorded on FM-338.
- Order changed from the plan's compat-first: compatibility was CPU-saturated (2 vCPU, load 16, 0 % idle; watchdog
  kills about every 10–20 min all afternoon, before this release) and runs no jobs (`FIRSTMEASURE_JOB_WORKERS=0`), so
  the fix does not run there. Worker first, web nodes, compatibility last at a calmer minute.
- Worker at 19:32:01 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on. `dist` has
  `timeout exceeded when trying to connect` ×2 in `transient_failure.js`, `imagery_provider_busy` ×1 in
  `processing.js`.
- Signed channel published from compatibility against `e6cd04bb…` (2318a4cf's archive); all six web nodes
  downloaded `afc66701` / `6673871a` from it.
- Six web nodes one at a time behind the load balancer, 19:33:04–19:45:52 UTC (about 94 s each), each asset-checked
  as in 2318a4cf's run plus the FM-338 strings in `dist`.
- Compatibility at 19:46:08 UTC with `legacy-action` at about 240–380/min: active, no Node 500s and no worker exits in
  the first 20 s. The restart gave the usual burst of 500/502/503 on routes proxied to compatibility during 19:46
  (about 150 per web node, like a single watchdog kill earlier, 19:24: 115).

## After activation

- Public readiness answered `afc66701` on 32 of 32 requests (twice: 19:47 and 20:08); all eight hosts point `current`
  at it, with the expected service active on each.
- Worker, 19:32–20:08: 478 jobs completed, among them **69 `imagery.process`**, 278 `pdf.sync`, 62 `report.delivery`
  and 69 `report.release`; **0 `firstmeasure_order_imagery_failed`** lines and no level-50 errors. No imagery job
  needed a retry in that window (no pool or transport failure happened), so the retry path itself has only the dev
  proof. One `report.delivery` failed after 5 attempts: Postmark answered 422 / ErrorCode 406 "recipient marked
  inactive" (a hard-bounced customer address) every time. That is the address, not this release (delivery doesn't use
  the changed classifier, and Postmark authenticated). 207 `report.release` are queued, none due (scheduled holds).
- Web nodes from 19:47 to 20:07: 29–31 5xx of about 25,000–27,000 requests each (0.11 %; 0.9–1.0 % in the 30 minutes
  before, which include a compatibility watchdog kill at 19:24 and the compatibility restart), mostly
  `top_view_reroll_proxy.php` (failing before this release) and a few `legacy-action`.
- Compatibility from 19:46:08 to 20:07: cluster watchdog (`missed its`) **0 kills** (4 in the 30 minutes before);
  about 2–8 nginx 500s a minute, the same as before; load 16 at 19:36, 4.5 at 20:07; `legacy-action` about 600/min.
- Not checked: an order that hits a pool or transport failure on production and then gets retried. Watch for
  `firstmeasure_order_imagery_failed` lines with `"transient":true` followed by an `"attempt":2` start for the same
  job. Orders that already lack map assets are not reprocessed (that would be a data change and needs a person).
- Separate, not fixed here: compatibility is 2 vCPU / 4 GB with 8 Node HTTP workers and was CPU-saturated this
  afternoon; that is the likely cause of the slow internal portal reported on FM-338.

## Rollback

`2318a4cfd71a8138c6f076d985cdbd7a3b3ed227` is still installed on every host: activate it on the web nodes one at a
time, the worker and compatibility with `activate-release.sh` (`fm-338-prodrun-scripts/rollback/`), and republish the
channel with 2318a4cf's archive against `6673871a…`. Code only; this release writes no data.
