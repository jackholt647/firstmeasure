# Production full-detail storage protection — October 12, 2026

The user authorized immediate production protection for ongoing loading failures,
including old browser tabs. Development must not be promoted. This follow-up is
built on the earlier production portal-summary hotfix, in its isolated worktree.

## Before measurement

At 18:14:47–18:15:30 UTC (43 complete seconds), the same six web nodes issued
33,705 measured Spaces attempts: mean 783.8/sec, p95 1,939/sec, peak 2,353/sec;
16 seconds exceeded 800/sec. These are application attempts including retries,
not the provider's accepted-operation counter. Numeric-only TLS probes detached.

The aligned 18:10:35–18:15:35 UTC five-minute log window contained 1,907
SlowDown events and 1,419 full-detail HTTP 5xx responses among 19,926 matched
full-detail responses (7.12%). Aggregate full-detail median was 593.5 ms and
p95 11,685.3 ms. Request starts/completions are paired by process ID plus request
ID, avoiding collisions between the eight HTTP workers. Summaries were fast with no sampled summary 5xx. Twelve public
readiness checks all passed, demonstrating why healthy probes alone did not
establish resolution of user-visible failures.

## Patch and validation

Release `f3db901b59141ed620276e0144d1da4ef33b4f2c` on
`codex/production-portal-storage-hotfix-20261012` changes only the two storage
source modules plus compiled counterparts and focused tests. Previous web
release: `68fe2cab3ab90edfca9aa1be6ba610359db0aef9`.

Full-detail reads now obtain the fresh file inventory first, skip missing optional
JSON files, and reuse JSON bodies only when the fresh listing's ETag matches the
cached GET response's ETag. The manifest is read fresh on every call. A GET racing
with a write is cached under the GET's actual ETag. Files, status, access checks,
release holds, and the full response shape are preserved. Errors are not cached;
the pre-existing optional-JSON null-on-error behavior remains. The listing itself
is never cached and its failures propagate. Ordinary artifact downloads bypass
this cache. No browser reload is needed for the server-side change.

The per-process LRU is capped at 128 MiB of raw JSON and 12,000 entries (at most
1 GiB of retained raw JSON per eight-process node, plus map overhead). JSON above
32 MiB is returned but not retained. Concurrent same-key/version reads share one
GET. Every caller receives separately parsed JSON, preventing mutable references
from leaking between requests. Cold reads still fetch existing files; benefits
increase as each process warms. LIST traffic and other artifact traffic remain.
This is immediate mitigation, not the later batched/incremental-sync architecture.

Actual source hashes matched the prior release on all six web servers. The
canary's complete public/deploy source baseline was audited before staging.
Existing production dependencies and unrelated compiled output were preserved,
with a complete runtime comparison against an explicit changed-file allowlist.
Linux typecheck, build and 23 focused tests passed. Read-only staged execution on
three real completed projects returned identical full responses to the previous
release: each cold read used one LIST plus three GETs, and each repeated read used
one LIST and zero GETs. No customer data or orders were created for validation.

Artifact SHA-256: `54b455190b717dcd4c0b22462fda088f96dbc329a1bdadf4fef30baffbcdc66c`.
Archive size: 249,784,050 bytes. The existing signed-channel publisher read back
the new target successfully. One streaming publication failed before the retry
succeeded; the expected-previous guard was retained. Prior signed manifest and
archive are retained on the controller at
`/var/tmp/firstmeasure-protection-20261012/rollback`.

## Rollout and rollback

Use the signed channel and the existing guarded activation scripts, withdraw one
node from readiness routing for 45 seconds, verify load-balancer failed probes,
activate, restore the original NGINX configuration, verify summaries/full details
and public reentry, then proceed. Do not activate development or promote its code.
Compatibility and worker roles are not part of this web mitigation.

Rollback: republish the retained previous signed release against the new artifact
SHA, then drain and activate the retained `68fe2cab` release one web node at a time.
Do not bypass the signed-channel guard. No database migration or data rollback is
needed. Production evidence and helper scripts are in the ignored local directory
`output/production-protection-20261012`.

## Completed rollout

All six web nodes completed the rolling deployment and public reentry by
18:42:44 UTC (13:42:44 Central). Each passed eight live summaries, two completed
full-detail/report comparisons, rejected-project summaries and private-namespace
denial checks. Original NGINX configuration was restored on every node. Existing
pool-four/eight-web-worker/no-heartbeat settings were preserved. Final audits
verified all six release identities and nine Node processes per node; service
memory was 2.7–7.0 GB on 16-GB droplets. Twelve final public readiness probes all
passed. Compatibility and worker were not activated; development was not deployed.

| Web node | New process started UTC |
| --- | --- |
| 64.23.240.81 | 18:26:59 |
| 137.184.88.252 | 18:29:35 |
| 137.184.187.218 | 18:32:48 |
| 146.190.150.235 | 18:35:25 |
| 143.198.137.97 | 18:38:07 |
| 143.198.104.224 | 18:42:02 |

The second node's first report-verification run failed and halted progression.
Its fresh repeat passed before reentry verification and continuation; the original
helper did not retain the underlying assertion, so do not assign a confirmed
cause. The last node's signed-target check failed before activation; the prior
release remained running and NGINX was restored. Subsequent read-only checks
passed, followed by the original guarded activation and all live checks. No
signature/target check was bypassed. Some artifact transfers required retries.

## First complete-fleet sample

18:42:51–18:43:35 UTC, 44 complete seconds: 25,655 measured storage attempts,
mean 583.1/sec, p95 2,135/sec, peak 2,349/sec; eight seconds above 800. Mean was
25.6% lower than the earlier 43-second sample, but peak pressure remained.

The approximately two-minute post-rollout application sample contained 33
SlowDown events (16.5/minute, versus 381.4/minute before), and 10 full-detail 5xx
among 7,631 matched responses (0.13%, versus 7.12%). Full-detail median was
347.2 ms; p95 remained 11,038.6 ms. No summary 5xx appeared among 2,745 summaries;
summary p95 was 8.0 ms. This demonstrates substantial reduction in observed
failures, not elimination of storage overload or long-tail latency. User traffic
was not controlled and sample durations differ; do not attribute every difference
solely to the patch. A longer sample covering refresh cycles follows below.



## Longer window and remaining thumbnail amplification

The longer 18:44:16–18:46:15 UTC sample covers 119 full seconds: mean 623.1
storage attempts/sec, peak 2,718/sec, 26 seconds above 800. The aligned-to-current
three-minute application samples had 146 SlowDown events (48.7/minute), 110
full-detail 5xx among 10,620 matched full responses (1.04%), median 697.7 ms,
p95 11,583.9 ms. The first post-change window was overly optimistic relative to
this longer window; use this longer result when describing the residual issue.
The first cache/listing patch reduced failures substantially but did not resolve
slow loading or bursts, so investigation and mitigation continued.

A 59-second categorized sample at 18:47:06–18:48:05 UTC counted 32,273 attempts:
17,082 other object GETs, 3,959 bucket-root/list-shaped GETs, 3,630 app-metadata
GETs, 3,430 PDF-state GETs, 3,524 branding-default GETs, 631 PUTs and 17 DELETEs.
These categories are bounded TLS observations, not provider billing counters.

On the canary, a subsequent two-minute route sample had 465 completed thumbnail
requests: 451 HTTP400 missing-image results, 14 HTTP200 results. The existing
thumbnail handler tries ten standard image names (plus a distinct requested
name if supplied), each via a separate GET, even when none exists. Its median
was 206.8 ms and p95 21,834.8 ms. A read-only execution of the actual old/new
compiled handlers on one real image-less project verified the same missing-image
result while changing ten GetObject commands into one ListObjectsV2 command.
Command counts exclude internal SDK retries; actual quota savings can be larger.

## Thumbnail follow-up release

Release `15ed3851f5226476fce6371aeb2eca432ea22de4` adds five source lines in the
thumbnail handler on top of the previous protection. After the first cached-file
miss, it lists the project once and skips source names absent from that inventory.
Existing cached requested thumbnails retain the zero-storage fast path. Source
preference and the existing image rendering/fallback behavior remain. Absence is
not cached: newly created images are discovered on the next request. A listing
failure propagates rather than triggering ten more failed GETs. No image files,
project limits, permissions, orders or customer records are changed.

Linux typecheck/build and all 30 focused tests passed. Actual API source hashes
matched on all six web nodes; the staged runtime differs only in API source,
compiled API, its focused test and release identity. Prior runtime dependencies,
the full-detail ETag protection and the earlier summary/two-minute hotfix remain.

Artifact SHA-256: `3f128a0d4384d5314444065c87e90dcebb33a904eb0d16f5ec979053ac5573cf`.
Size: 249,785,327 bytes. Previous signed release/manifest retained on the controller
at `/var/tmp/firstmeasure-thumbnail-20261012/rollback`. Rollback targets `f3db901b`
and preserves the full-detail protection. Evidence/helpers live locally under
`output/production-thumbnail-20261012`; preceding diagnostics remain in
`output/production-protection-20261012`.


The thumbnail release was published with the expected-previous guard and signed
readback verification after one failed publication attempt. All five remaining
web nodes downloaded/verified/installed the new artifact successfully. Canary
activation completed at 18:57:08 UTC, then passed eight live summaries, a real
missing-image HTTP400 in 113 ms, an existing image HTTP200, conditional cached
HTTP304, and public load-balancer reentry. The remaining rolling activation and
final whole-fleet measurements follow below.


The thumbnail rollout completed at 19:08:05 UTC (14:08:05 Central). All six nodes
passed summaries, missing-image HTTP400, existing-image HTTP200, conditional
HTTP304 and public reentry. Missing-image live checks ranged 98–134 ms. There
were no activation/check failures during this second rolling activation. All
six final audits passed with release `15ed3851`, restored NGINX, nine Node
processes, pool four, eight HTTP workers, disabled heartbeat and matching served
assets. Service memory was 2.1–5.3 GB per 16-GB node. Twelve public readiness
probes passed. No additional droplets or database connections were added.

| Web node | Thumbnail release started UTC |
| --- | --- |
| 64.23.240.81 | 18:57:08 |
| 137.184.88.252 | 18:59:27 |
| 137.184.187.218 | 19:01:29 |
| 146.190.150.235 | 19:03:33 |
| 143.198.137.97 | 19:05:29 |
| 143.198.104.224 | 19:07:30 |

Final combined post-change measurement follows below. Neither production fix
requires browser adoption; old tabs use the protected server paths immediately.
The production application release is `15ed3851`; later documentation-only
commits do not change that deployed identity.


## Final combined result

The final six-web-node TLS sample covers 19:08:13–19:11:12 UTC (179 complete
seconds, after all nodes rejoined). It recorded 71,703 attempted storage
operations: mean 400.6/sec, p95 584/sec, peak 739/sec, zero sampled seconds above
800. GET/LIST attempts: 70,472; PUT attempts: 1,231. This is the same numeric-only
web subset as the earlier rate comparisons, including retries, not a provider
accepted-operations counter or a census of other clients. All probes detached.

The approximately three-minute per-host application windows contained:

- Zero logged Spaces SlowDown events (baseline 1,907 in five minutes).
- Zero full-detail HTTP5xx among 11,060 matched completed requests (baseline
  1,419/19,926 = 7.12%). Full-detail median 140.7 ms and p95 257.8 ms, versus
  baseline 593.5 ms / 11,685.3 ms.
- Zero summary HTTP5xx among 3,441 summary responses; summary p95 5.6 ms.
- Zero readiness HTTP5xx among 108 completed health responses.
- Fifteen HTTP5xx on other routes: 12 POST acquisition requests returned 503;
  three GET organization requests returned 500 with RangeError log events.
  These remain separate follow-up findings. This is not a claim of zero errors
  across the entire application. No new storage throttles accompanied them.

The missing-thumbnail fix was necessary: the full-detail cache alone still had
approximately 1% failed full-detail requests and an 11.6-second p95 in the longer
intermediate sample. The final combined sample demonstrates substantial relief
in both failures and latency, rather than only lower error counts. Workload was
not controlled and durations differ; this is incident evidence at observed load,
not a guarantee for future traffic or a replacement for the planned incremental
project synchronization work and provider-capacity follow-up.

Final application release remains `15ed3851f5226476fce6371aeb2eca432ea22de4`.
No forced customer reload, session invalidation, development promotion, database
migration, pool-size change or recurring monitor was introduced. Previously
rejected projects were not resubmitted by these read-path protections.
