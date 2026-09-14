# 1M8-185 API no-height-map rejection release

## Candidate and scope

Authorized by Jack on September 14, 2026. Candidate:
`8a5e84f9348e3f8a4f44eda5b40076acd252cc83`, branch `codex/185-production`.
Linux x64 artifact: 249489798 bytes, SHA256
`0474ac7ebad751ea649874f67b73001a7df87b63e4b105677ec36b438988febe`.
Previous production/replacement target: `b976d07a3830c26e3e4fe7e7f75057c9f14f1ad3`,
artifact SHA256 `44f1c08045f92f69926c8560e241098beaf4189bf4d70eab0740c6528275ddf5`.

Only 185 application changes are included. The people-first Tracking redesign
commit 725dba3 is deliberately excluded. Existing Tracking remains enabled.
No schema, configuration, image, capacity, credentials, DNS or historical-data
changes. The two existing failed orders are explicitly deferred: do not requeue,
reject, refund, alter their pins, or send them messages as a release test.

API imagery processing tries standard then expanded Solar coverage at unchanged
coordinates. Confirmed no-coverage uses the shared staff rejection/refund/email
workflow, with rejection-refund deduplication inside the credit mutation lock.
Public report status/reason/message expose rejection. Transient errors, invalid
DSM responses and failed signed downloads are not classified as missing coverage.
Non-API orders retain the coverage-review behavior. There is no claim of an
outbound rejection webhook. This applies to future processing attempts, including
an old order if someone explicitly retries it; no old orders are automatically swept.

## Verification before activation

- Fresh Linux worktree on the isolated development worker, not the dirty checkout.
- npm ci, TypeScript check and build passed; 12 focused regressions and the
  embedded PostgreSQL concurrency test passed. Existing dependency audit reported
  two moderate/two high production dependency findings; dependencies unchanged.
- Provider UI confirmed the same six replacement web nodes, worker and compatibility
  host. All eight current trees matched 1,592 packaged non-dependency files from
  b976d07 exactly. Database sample: 68 connections of max100.
- All runtime role/configuration checks passed except a pre-release historical
  Tracking warning assertion on web2 and web5: one auth-stage unclassified Error
  each since their prior activation. Other six roles had no Tracking warnings.
  These are recorded as existing observations, not repaired by 185. Post-activation
  verification must still check for new warnings.
- Known editor/reroll/apple PHP500 and acquisition-event503 baseline remains;
  exact route/status exceptions retain the previous reviewed reentry policy.
  Other 5xx must not be silently exempted. 1M8-187 and deferred174 are separate.

## Rollout and rollback

Deploy the identical checksum-verified artifact to isolated development first.
Publish its signed replacement channel on the compatibility controller with a
compare-and-swap against the previous artifact SHA. Stage all roles, then roll web
nodes one at a time with the existing signed-target guard and drain interval;
require readiness and successful load-balancer reentry before the next node.
Restart the worker only after the no-running-jobs guard. Compatibility/PHP last.
Preserve all provider, readiness, Tracking, pool and single-heartbeat configuration.

Retain b976d07 and its artifact. Rollback must first republish that signed artifact
against the new SHA before rolling nodes back; never bypass the release guard.
No database migration is involved. Code rollback does not undo real rejections,
refunds or email already produced. Retain refund idempotency ledger entries.

## Development and publication

All three development roles activated the same artifact. Compiled-runtime probes
on each verified standard-to-expanded fallback, confirmed no-coverage, provider
rate-limit distinction, and valid TIFF acceptance using mocked transports (zero
external requests/customer writes). Runtime readiness and outbound isolation passed.
The single development web restart briefly returned LB503; after healthy probes
accumulated, public readiness returned 200 for 8a5e84f with all safety checks passing.
DigitalOcean also displayed development and production load balancers Healthy.

Both existing blocked orders have no queued/running jobs referencing their IDs;
their manifest hashes were recorded privately for post-release comparison.
The signed production channel was published with the previous-SHA guard and
readback. All eight roles installed the identical checksum-verified artifact.

Rolling activation completed; post-release results below.

Read-only provider verification using the staged compiled helper and the actual
production worker credentials passed: both existing pin-centered locations
returned `solar_imagery_no_coverage` after standard and expanded requests; Google's
documented control location returned a valid 1,967,073-byte TIFF. These requests
did not invoke project processing or mutate orders/artifacts/billing/email.
Canary web1 activated at 22:28:47 UTC, passed three LB readiness probes and eight
successful routed requests with zero routed5xx, then passed runtime checks.

During rolling withdrawal one public readiness sample returned503; immediate
IPv4 and IPv6 rechecks both returned200 from healthy members. This is not a
claim of globally error-free service. Authenticated replacement-overlay readback
passed with Tracking configuration preserved and no bridge secret shared to webs.
Mid-rollout database sample: 73/max100; both deferred manifest hashes unchanged.

| Web | Activation UTC | Successful routed requests at gate | Unexplained 5xx |
| --- | --- | --- | --- |
| 599442759 | 22:28:47 | 8 | 0 |
| 599442763 | 22:30:10 | 5 | 0 |
| 599442764 | 22:31:20 | 14 | 0 |
| 599442766 | 22:32:31 | 17 | 0 |
| 599442768 | 22:33:41 | 27 | 0 |
| 599442769 | 22:34:50 | 26 | 0 |

Web6 observed one known editor.php500 in its reentry window (the unchanged
compatibility memory-error baseline). No other routed5xx occurred in any gate.
All six web roles passed runtime checks with eight children, pool1, correct drain
and readiness settings, and no new Tracking warnings at their gates.
The first worker activation attempt stopped before changes because a job was
running. A later idle sample and the activation guard both passed; worker
activation and runtime checks then succeeded without interrupting an active job.

## Final result

Worker activated at 22:35:58 UTC and compatibility at 22:36:06 UTC, including
PHP-FPM restart. Both show zero systemd automatic restarts. All eight roles passed
the final source/artifact comparison (1,601 non-dependency files, zero differences)
and runtime verification on 8a5e84f. Tracking remains enabled, no new Tracking
warnings were present in these windows, role/pool/readiness/provider configuration
is preserved, and compatibility remains the sole heartbeat owner.

Public IPv4 and IPv6 readiness both returned200. DigitalOcean reports Healthy
with all six web members Active. Signed target and replacement overlay readback
passed. Invoke release-channel.mjs through its concrete release path, not the
`current` symlink: its CLI entrypoint compares the argv path with import.meta.url.
The two existing orders' complete manifest hashes match the pre-release values;
they remain needs_structure_pins/failed. No rejection/refund/retry/email was issued
for them by this rollout. Final database sample: 70 connections of max100.

Acceptance limits: refund/email orchestration and credit concurrency were exercised
with controlled fixtures/isolated PostgreSQL, not by rejecting a real customer
order. Live Google checks verified the new coverage/download helper independently.
The reporting team still owns final acceptance. 1M8-185 moves to Testing in Prod.
The other pending Tracking redesign and known memory/referral bugs remain separate.
