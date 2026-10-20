# Production portal storage hotfix — October 12, 2026

Jack explicitly authorized a live production-only hotfix: remove artifact reads
from customer project-card refreshes and extend periodic refresh from one to two
minutes. Development was not promoted or activated.

## Source and release

Application commit: `68fe2cab3ab90edfca9aa1be6ba610359db0aef9`, branch
`codex/production-portal-storage-hotfix-20261012`, pushed to GitHub. This isolated
hotfix branch starts at production commit `3fa1f34b865983953ab0024c92bfca45be2747e3`.
The canonical development checkout is dirty and was preserved. Production source
was read directly: the three affected files match across six web nodes and the
compatibility host. A full tracked public/deploy source comparison on the build
canary found no drift from the production commit, excluding deliberately omitted
`.env` examples. No older development checkout supplied deployment files.

Runtime SHA-256: `e04fb1eebf009385797fff43fd04516c39854e08115cc36d5109673a305451d5`.
Archive length: 249,773,952 bytes. Existing Linux production dependencies and
compiled files are preserved; only `dist/firstmeasure/api.js` is replaced after
building the exact patched source with its lockfile in a separate directory.
The complete runtime comparison found only the three intended source files,
compiled API, regression test, and release identity changed.

## Behavior

- `GET /v1/firstmeasure/projects/:id?view=portal-card` reads the existing database
  manifest and its persisted artifact flags. It does not read app metadata,
  PDF state, branding JSON or list Spaces files. Existing access hooks and the
  same `readManifest` path are preserved. The ordinary full-detail response is
  unchanged, including its existing weather-generation behavior.
- Portal project-page hydration requests this summary variant. It uses the
  persisted report/summary/XML flags while preserving project identity, contacts,
  custom cover, report-release holds and rejection details.
- Summary hydration is separate from full-detail hydration. Cards do not trigger
  the display/thumbnail fallback full-detail fetch, but opening a project still
  loads full details when needed.
- The regular board timer changes 60,000 to 120,000 ms. Initial, manual and
  post-submit refreshes, including the existing burst timers, remain intact.
- Old browsers continue using the original endpoint. New browsers can also
  tolerate an old server's full-detail response during the rolling deployment.
  Open tabs adopt the frontend fix on reload; no forced reload interrupts edits.

This is a manifest-only summary hotfix, not the later batched/incremental-sync
architecture. It still makes a lightweight detail-summary HTTP/database request
per project. Incremental changes, batching and remaining object reads are future
work. Do not claim this implements a change cursor or infinite scalability.

## Validation and rollout

Linux `npm ci`, TypeScript check and build passed in isolated staging on the
compatibility host; its running service and development environment were not
modified. Eight focused behavior tests pass, covering summary requests, report
links/holds, identity/cover preservation, old-server compatibility, opening full
details, periodic versus post-submit timing, and propagation of access errors.

The existing controller published and read-back-verified the signed web channel
before activation, guarded against the previous artifact SHA. Other web nodes
used the existing pinned bootstrap downloader to verify/install the same signed
archive. A transient download failure succeeded on retry. Publishing updates
future replacement-node code; no autoscale template/image or droplet count was
changed, and no additional droplet was created.

Canary 64.23.240.81 activated at approximately 17:23 UTC. Its existing graceful
shutdown exceeded the preexisting 55-second systemd stop timeout and remaining
old processes were killed. The new service became ready. For subsequent nodes,
a temporary exact NGINX readiness location returned 503 for 45 seconds before
activation, and at least three failed probes from the observed load-balancer
address were required before restart. Normal traffic still reached other nodes.
The original NGINX file was restored byte-for-byte afterward. FPM was reloaded
and source-versus-served asset hashes verified. No persistent NGINX change is
part of this patch. Each node must pass readiness, live summary checks and public
load-balancer reentry before the next node is activated.

The first two nodes passed eight read-only live project-summary checks each,
including artifact flags and private-namespace denial. No paid order, email,
report delivery or customer data mutation was created for testing.

Rollout completed at approximately 17:38:55 UTC (12:38:55 Central). All six
web nodes verified release `68fe2cab`, nine Node processes (eight HTTP workers
plus primary), pool four, disabled web heartbeat, matching served asset hashes,
restored NGINX configuration, eight live summary checks and public load-balancer
reentry. Compatibility and background-worker services were not activated; their
existing production versions remain in place. The compatibility host served only
as the isolated build host and existing release controller.

| Web node | New process start (UTC) |
| --- | --- |
| 64.23.240.81 | 17:22:56 |
| 137.184.88.252 | 17:26:13 |
| 137.184.187.218 | 17:29:27 |
| 146.190.150.235 | 17:31:42 |
| 143.198.137.97 | 17:35:10 |
| 143.198.104.224 | 17:37:49 |

The fifth node's first signed-channel check failed before activation. Its old
release remained active and NGINX was restored. A fresh require-target check
passed and the same guarded rollout succeeded on retry. No guard was bypassed.
The second node's first post-restore NGINX probe briefly saw the outgoing 503
configuration during graceful reload; a fresh probe passed, byte-for-byte config
restoration and public reentry were confirmed, and subsequent rollout probes
waited for reload completion.

Additional live checks covered two completed and two rejected projects. For the
two completed projects, report/summary availability flags matched the full
endpoint's real file listing. Release-hold metadata remained in the returned
manifest. No customer data was modified for those checks.

## Baseline and measurement limits

Immediately before activation, 17:20:06–17:21:34 UTC inclusive, six web nodes
sent 60,310 measured bucket requests across 89 full seconds: mean 677.6/sec,
p95 2,062/sec, peak 2,328/sec, 24 seconds above 800. GET/LIST: 59,411; PUT: 899.
The numeric-only TLS probe includes retries and has the coverage limitations
recorded in `incident-20261012-storage-latency.md`.

Early canary traffic included 31 summary responses at median 3.2 ms and p95
9.4 ms, with no summary 5xx in that sample. Existing tabs continued making slow
full-detail calls. This early sample is not evidence of fleet-wide resolution.

## Rollback

Previous web release: `3fa1f34b865983953ab0024c92bfca45be2747e3`.
Previous artifact SHA: `02d0fea7f0ac8234e9a2fb403c7e02cacaaf9f6f157940740b11475c50349ebc`.
The controller retained the signature-verified previous `release.json` and
`release.tar.gz` at `/var/tmp/firstmeasure-hotfix-20261012/rollback` before
publication. Republish that pair with `publish-web-release.sh` against the new
artifact SHA, then drain and activate the retained previous release one web
node at a time, verifying readiness and reentry. Do not bypass the signed-channel
guard. No database migration or data rollback is required.

Diagnostic scripts and sanitized measurements are retained locally under
`output/production-hotfix-20261012`. Local source worktree:
`C:/Users/jackh/Code/2026/FirstMeasure-hotfix-20261012`.


## Immediate post-rollout comparison

Both numeric-only TLS samples cover the same six web nodes and 89 complete
seconds. Before: 17:20:06-17:21:34 UTC; after: 17:39:05-17:40:33 UTC.

| Metric | Before | After |
| --- | ---: | ---: |
| Measured storage requests | 60,310 | 67,307 |
| Mean requests/sec | 677.6 | 756.3 |
| Peak requests/sec | 2,328 | 2,516 |
| Seconds above 800 | 24 | 28 |
| Spaces SlowDown application log events | 87 | 75 |
| Completed full-detail responses with matched starts | 7,527 | 6,428 |
| Completed summary responses with matched starts | 0 | 744 |
| Summary median / p95 response time | -- | 3.1 / 9.6 ms |
| Summary HTTP 5xx | -- | 0 |

The new summary variant accounts for approximately 10.4% of matched project
summary/full-detail responses. Many existing tabs have not reloaded, and full
details remain legitimate for opened projects. This is not an exact browser
version census. The observation demonstrates that the new path is in use and
fast, but **does not demonstrate an overall storage-rate reduction or resolution
of the production overload**. Traffic mix and user activity were not controlled;
do not attribute the before/after rate change solely to the patch.

Post-rollout public readiness sampling reached all six nodes, with 17 successes
and one failure. A follow-up 12-request sample had 11 successes and one HTTP503;
its body specifically showed `artifact_storage: false`, while database, accepting
traffic and other dependency checks were true. Existing Spaces pressure therefore
still intermittently affects readiness. This is not a zero-error availability
claim. Do not keep increasing connection pools to address these storage errors.

All temporary TLS counters detached after their bounded samples. No recurring
monitor or automatic browser reload was installed. Existing tabs pick up the
frontend changes on their next reload. The later development work should address
batched summaries, dependable incremental synchronization, and the remaining
object reads; it has not been implemented or deployed by this production hotfix.
